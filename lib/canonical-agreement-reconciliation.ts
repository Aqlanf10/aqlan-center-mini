import "server-only";
import { runCanonicalReadSnapshot } from "./canonical-read-snapshot";
import { getPool, insertAuditRow, patientInDoctorScopeWith, type DbClient, type DbPool } from "./db";
import { lockDebtAccountForSchedule } from "./debt-account-position";
import { PURCHASE_RESET_FENCE } from "./clinic-reset";
import { documentNumberSql } from "./document-numbers";
import {
  agreementReconciliationIntentText,
  type AgreementReconciliationAttemptStatus,
  type AgreementReconciliationCommand,
  type AgreementReconciliationReceipt,
  type AgreementReconciliationResult,
  type AgreementReconciliationView,
} from "./agreement-reconciliation";
import { agreementReconciliationInternal } from "./agreement-reconciliation-db";
import type { VerifiedDurableSession } from "./staff-durable-session";
import {
  staffOperationIdentity,
  staffOperationPatientScope,
  withStaffOperation,
} from "./staff-operation-runtime";

const fail: (code: string, message: string, status?: number) => never = agreementReconciliationInternal.fail;
const {
  safe,
  digest,
  validate,
  installed,
  snapshot,
  lockAttemptByUser,
  attemptByUser,
} = agreementReconciliationInternal;

export async function readCanonicalAgreementReconciliation(planId: number, session: VerifiedDurableSession): Promise<AgreementReconciliationView> {
  if (!Number.isSafeInteger(planId) || planId <= 0) fail("invalid", "رقم الخطة غير صالح.", 400);
  return runCanonicalReadSnapshot(
    session,
    "read:plans.reconcile",
    async (query, scope) => {
      await installed(query as unknown as DbClient);
      const owner = (await query.query<{ patient_id: number }>("SELECT patient_id FROM treatment_plans WHERE id=$1", [planId])).rows[0];
      if (!owner) fail("missing", "الخطة غير موجودة.", 404);
      if (
        scope.patientScope.kind === "own"
        && !(await patientInDoctorScopeWith(query, scope.patientScope.clinicianPartyId, owner.patient_id))
      ) {
        fail("missing", "الخطة غير موجودة.", 404);
      }
      const { view } = await snapshot(query as unknown as DbClient, planId);
      return view;
    },
    { errorPrefix: "STAFF_READ", maxBytes: 1024 * 1024 },
  );
}

export async function readCanonicalAgreementReconciliationAttemptStatus(
  planId: number,
  command: AgreementReconciliationCommand,
  session: VerifiedDurableSession,
  pool: DbPool = getPool(),
): Promise<AgreementReconciliationAttemptStatus> {
  validate(planId, command);
  return withStaffOperation(pool, session, "finance.agreements.manage", async (client, handle) => {
    await installed(client);
    const identity = await staffOperationIdentity(client, handle, "finance.agreements.manage");
    const patientScope = await staffOperationPatientScope(client, handle, "finance.agreements.manage");
    if (patientScope.kind === "none") fail("unauthorized", "لا تملك صلاحية الوصول لملفات المرضى.", 403);
    const owner = (await client.query<{ patient_id: number }>("SELECT patient_id FROM treatment_plans WHERE id=$1", [planId])).rows[0];
    if (!owner) fail("missing", "الخطة غير موجودة.", 404);
    if (patientScope.kind === "own" && !(await patientInDoctorScopeWith(client, patientScope.clinicianPartyId, owner.patient_id))) {
      fail("missing", "الخطة غير موجودة.", 404);
    }
    await lockAttemptByUser(client, identity.userId, command);
    return attemptByUser(client, planId, command, identity.userId);
  });
}

export async function saveCanonicalAgreementReconciliation(
  planId: number,
  command: AgreementReconciliationCommand,
  session: VerifiedDurableSession,
  pool: DbPool = getPool(),
): Promise<AgreementReconciliationResult> {
  validate(planId, command);
  const result = await withStaffOperation(pool, session, "finance.agreements.manage", async (client, handle) => {
    await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [PURCHASE_RESET_FENCE]);
    await installed(client);
    const identity = await staffOperationIdentity(client, handle, "finance.agreements.manage");
    const patientScope = await staffOperationPatientScope(client, handle, "finance.agreements.manage");
    if (patientScope.kind === "none") fail("unauthorized", "لا تملك صلاحية الوصول لملفات المرضى.", 403);

    const owner = (await client.query<{ patient_id: number }>("SELECT patient_id FROM treatment_plans WHERE id=$1", [planId])).rows[0];
    if (!owner) fail("missing", "الخطة غير موجودة.", 404);
    await client.query("SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE", [owner.patient_id]);
    if (patientScope.kind === "own" && !(await patientInDoctorScopeWith(client, patientScope.clinicianPartyId, owner.patient_id))) {
      fail("missing", "الخطة غير موجودة.", 404);
    }

    await lockAttemptByUser(client, identity.userId, command);
    const prior = await attemptByUser(client, planId, command, identity.userId);
    if (prior.state === "committed") return { status: "reconciled" as const, replayed: true, reconciliation: prior.receipt, view: null };
    if (prior.state === "rejected") return null;

    await lockDebtAccountForSchedule(client, owner.patient_id, true);
    await client.query("SELECT id FROM treatment_plans WHERE id=$1 FOR UPDATE", [planId]);
    await client.query("SELECT id FROM parties WHERE id=(SELECT primary_doctor_id FROM treatment_plans WHERE id=$1) FOR SHARE", [planId]);
    await client.query("LOCK TABLE doctor_commission_history, commission_case_overrides, settings IN SHARE MODE");
    const before = await snapshot(client, planId);
    if (before.view.sourceHash !== command.expectedSourceHash || before.view.reconciliation !== null || !before.view.canConfirm) {
      await client.query(
        `INSERT INTO agreement_reconciliation_rejections(actor_id,operation_key,plan_id,patient_id,request_hash,expected_source_hash,observed_source_hash)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [identity.userId, command.operationKey, planId, owner.patient_id, digest(agreementReconciliationIntentText(planId, command)), command.expectedSourceHash, before.view.sourceHash],
      );
      await insertAuditRow(client, {
        action: "plan.agreement_reconciliation_refused",
        entity: "treatment_plans",
        entityId: planId,
        actor: identity.username,
        actorRole: identity.role,
        details: { operationKey: command.operationKey, expectedSourceHash: command.expectedSourceHash, observedSourceHash: before.view.sourceHash, reason: "source_changed_or_review_required", cashMovementMinor: 0 },
      });
      return null;
    }
    const view = before.view;
    const U = view.amounts.unbilledPrincipalMinor!;
    let deltaInvoiceId: number | null = null;
    if (U > 0) {
      if (!view.commission) fail("agreement_review_required", "أثر العمولة غير مثبت.");
      const [created] = (await client.query<{ id: number }>(
        `INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency,plan_id,note,created_by)
         VALUES(${documentNumberSql("invoice")},$1,$2,0,$3,$4,$5,$6) RETURNING id`,
        [view.patientId, U, view.currency, planId, `تسوية الاتفاق — ${command.reason}`, identity.username],
      )).rows;
      deltaInvoiceId = created.id;
      await client.query(
        "INSERT INTO invoice_items(invoice_id,doctor_id,description,quantity,unit_price_minor,total_minor) VALUES($1,$2,'أصل الاتفاق غير المفوتر — تسوية الاتفاق',1,$3,$3)",
        [deltaInvoiceId, view.commission.doctorId, U],
      );
    }
    const id = safe((await client.query<{ id: string }>("SELECT nextval(pg_get_serial_sequence('agreement_reconciliations','id'))::text AS id")).rows[0].id);
    const receipt: AgreementReconciliationReceipt = {
      id, planId, patientId: view.patientId, operationKey: command.operationKey,
      expectedSourceHash: command.expectedSourceHash, deltaInvoiceId, amounts: view.amounts, cashMovementMinor: 0,
    };
    await client.query(
      `INSERT INTO agreement_reconciliations(id,plan_id,patient_id,actor_id,operation_key,request_hash,expected_source_hash,currency,agreed_minor,billed_principal_minor,unbilled_principal_minor,delta_invoice_id,doctor_id,source_snapshot,receipt,reason)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16)`,
      [
        id, planId, view.patientId, identity.userId, command.operationKey, digest(agreementReconciliationIntentText(planId, command)),
        command.expectedSourceHash, view.currency, view.amounts.agreedMinor, view.amounts.billedPrincipalMinor, U,
        deltaInvoiceId, view.commission?.doctorId ?? null, JSON.stringify(before.proof), JSON.stringify(receipt), command.reason,
      ],
    );
    for (const source of view.sourceInvoices) {
      await client.query("INSERT INTO agreement_reconciliation_sources(reconciliation_id,invoice_id,principal_minor) VALUES($1,$2,$3)", [id, source.invoiceId, source.principalMinor]);
    }
    if (deltaInvoiceId !== null) {
      await client.query("INSERT INTO agreement_reconciliation_sources(reconciliation_id,invoice_id,principal_minor) VALUES($1,$2,$3)", [id, deltaInvoiceId, U]);
    }
    await insertAuditRow(client, {
      action: "plan.agreement_reconciliation",
      entity: "treatment_plans",
      entityId: planId,
      actor: identity.username,
      actorRole: identity.role,
      details: { ...receipt, commission: view.commission, reason: command.reason, originalInvoicesPreserved: true, originalReceiptsPreserved: true },
    });
    return { status: "reconciled" as const, replayed: false, reconciliation: receipt, view: null };
  });
  if (result === null) fail("agreement_source_changed", "تغيّر المصدر أو يحتاج مراجعة؛ افحص حالة نفس المحاولة قبل تحديث المعاينة.");
  return result;
}
