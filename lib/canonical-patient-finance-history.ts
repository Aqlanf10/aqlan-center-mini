import "server-only";
import { NextResponse } from "next/server";
import type { SessionPayload } from "./auth";
import { canonicalPatientReadFailure, NO_STORE } from "./canonical-patient-http";
import {
  runCanonicalReadSnapshot,
  type CanonicalSnapshotQuery,
  type CanonicalSnapshotScope,
} from "./canonical-read-snapshot";
import { readVisitCheckoutInSnapshot } from "./checkout-db";
import { isRetiredCollectionKey, retiredCollectionRefusal } from "./collection-attempts";
import {
  assertOpeningCorrectionAllowedInTx,
  adjustPartyOpeningPayableInTx,
  clearPatientOpeningBalanceInTx,
  CLINIC_TIME_ZONE,
  ClinicalPlanConflict,
  createPartyOpeningAdvanceInTx,
  createPartyOpeningPayableInTx,
  createPatientFamilyInTx,
  doctorOwnedPatientIdsWith,
  familyIdOfPatientWith,
  familyMemberBalancesInSnapshot,
  findFamiliesByPhoneWith,
  getPatientFamilyRecordWith,
  getPatientOpeningBalanceWith,
  getPatientWith,
  getPaymentWith,
  getPool,
  getSettingsInTransaction,
  insertAuditRow,
  linkPatientToFamilyInTx,
  listOpeningBalanceHistoryWith,
  listOpeningBalancesWith,
  listPartiesWith,
  listPartyOpeningsWith,
  listPatientPlansWith,
  OpeningBalanceChanged,
  OpeningBalanceExists,
  openingCorrectionPreviewInSnapshot,
  OpeningCorrectionRefused,
  openingMinorsOf,
  patientInDoctorScopeWith,
  patientLedgerInSnapshot,
  patientLegacyHistoryWith,
  patientReceiptRemaindersWith,
  patientReversedInstallmentRecoveriesInSnapshot,
  previewVisitBillingWith,
  searchPatientFamiliesWith,
  setFamilyGuarantorInTx,
  setPatientOpeningBalanceInTx,
  unlinkPatientFromFamilyInTx,
  updateFamilyDetailsInTx,
  visitPatientOfWith,
  voidPartyOpeningAdvanceInTx,
  type DbClient,
  type FamilyWriteFailure,
  type PatientFamilyRecord,
} from "./db";
import { collectCanonicalDebtInstallmentInTx } from "./debt-installment-collection";
import {
  DebtRepaymentError,
  debtRepaymentWorkspaceInSnapshot,
  saveCanonicalDebtRepaymentInTx,
} from "./debt-installments-db";
import type { FamilyView, FamilyViewMember } from "./family-view";
import { historicalDocumentError } from "./historical-document-http";
import { bodyErrorResponse, readJsonBody } from "./http-body";
import { InvoiceSettlementError } from "./invoice-settlement-position";
import { isLegacyArrangementCadence } from "./legacy-balance-arrangements";
import {
  cancelLegacyBalanceArrangementInTx,
  createLegacyBalanceArrangementInTx,
  listLegacyBalanceArrangements,
  listLegacyOpeningPositionsWith,
} from "./legacy-balance-arrangements-db";
import { patientLegacyOnboardingInSnapshot } from "./legacy-onboarding-db";
import {
  LEGACY_TREATMENT_MESSAGE,
  LEGACY_TREATMENT_STATUS,
  parseLegacyTreatmentRequest,
  type LegacyVoidRefusal,
} from "./legacy-treatment";
import {
  getCanonicalLegacyVoidPreviewInSnapshot,
  listLegacyTreatmentsWith,
  previewLegacyTreatmentInSnapshot,
  voidCanonicalLegacyTreatmentInTx,
  writeCanonicalLegacyTreatmentInTx,
} from "./legacy-treatment-db";
import {
  correctCanonicalHistoricalDocumentInTx,
  createCanonicalHistoricalDocumentInTx,
  listHistoricalDocumentsInSnapshot,
  previewCanonicalHistoricalDocumentInSnapshot,
  type CanonicalHistoricalDocumentActor,
} from "./legacy-treatment-document-db";
import { isLegacyVoidMode, parseLegacyVoidRequest } from "./legacy-treatment-void";
import {
  CLINIC_BASE_CURRENCY,
  isCurrency,
  parseAmount,
  patientBalancesByCurrency,
  toCurrencyPaymentLikes,
} from "./money";
import {
  familyRoleLabel,
  familyTotals,
  parseFamilyName,
  parseFamilyNote,
  parseFamilyRole,
  parseGuarantor,
  validateFamilyDraft,
} from "./patient-families";
import {
  readCanonicalResponsibilityInSnapshot,
  ResponsibilityError,
  updateCanonicalResponsibilityInTx,
  type ResponsibilityTarget,
} from "./patient-responsibility-settings";
import { loadPatientStatementDocumentInSnapshot } from "./patient-statement-build";
import { parsePatientStatementOptions, StatementInputError } from "./patient-statement-options";
import { planLedgerSummary } from "./plans";
import { readReceiptProvenanceInSnapshot } from "./receipt-provenance-db";
import { readReceptionHandoffWith } from "./reception-handoff-db";
import { clinicDateString } from "./schedule";
import { JSON_BODY_LIMIT_BYTES } from "./security-limits";
import { rateFromSettings } from "./settings";
import {
  parseSimilarCollectionReviewHeader,
  SIMILAR_COLLECTION_REVIEW_HEADER,
  similarCollectionRefusal,
  SimilarCollectionReviewRequired,
} from "./similar-collection";
import { effectiveTemplates } from "./specialty-templates";
import type { StaffRecordConstraint } from "./staff-capabilities";
import { staffAdmissionRefusal } from "./staff-capability-editor";
import type { VerifiedDurableSession } from "./staff-durable-session";
import {
  staffOperationCapabilities,
  staffOperationIdentity,
  staffOperationPatientScope,
  withStaffOperation,
  type StaffOperationHandle,
  type StaffRuntimeAction,
} from "./staff-operation-runtime";
import { listTreatmentFinancialReferencesInSnapshot } from "./treatment-financial-context-db";
import { redactVisitFinancialContext } from "./visit-financial-context";
import { readVisitFinancialContext } from "./visit-financial-context-db";

/**
 * Canonical Patient Finance, Responsibility, Families, Debt Repayments, Historical
 * Documents, Legacy Treatments & Clinic Opening Balances (M2 Slice 36).
 *
 * Every read runs inside one owning REPEATABLE READ READ ONLY snapshot (`runCanonicalReadSnapshot`);
 * every write runs inside `withStaffOperation` (READ COMMITTED, shared identity lifecycle fence,
 * FOR SHARE authority proof, atomic `insertAuditRow`).
 */

const SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

class CanonicalPatientFinanceRefusal extends Error {
  readonly code: string;
  readonly explicitCode: boolean;
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 500 | 503,
    message: string,
    code?: string,
  ) {
    super(message);
    this.name = "CanonicalPatientFinanceRefusal";
    this.explicitCode = typeof code === "string" && code.length > 0;
    this.code =
      code && /^[a-z][a-z_]*$/.test(code)
        ? code
        : status === 404
          ? "not_found"
          : status === 403
            ? "forbidden"
            : status === 409
              ? "conflict"
              : "invalid_request";
  }
}

function parsePositiveId(raw: string): number | null {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 && n <= 2_147_483_647 ? n : null;
}

function handleFinanceError(error: unknown, fallbackMessage: string): NextResponse {
  if (error instanceof CanonicalPatientFinanceRefusal) {
    return NextResponse.json(
      error.explicitCode ? { code: error.code, message: error.message } : { message: error.message },
      { status: error.status, headers: NO_STORE },
    );
  }
  const refusal = staffAdmissionRefusal(error);
  if (refusal) {
    return NextResponse.json(
      { code: refusal.code, message: refusal.message },
      { status: refusal.status, headers: NO_STORE },
    );
  }
  return canonicalPatientReadFailure(error, fallbackMessage);
}

async function patientVisibleInSnapshot(
  query: CanonicalSnapshotQuery,
  scope: CanonicalSnapshotScope,
  patientId: number,
): Promise<boolean> {
  if (scope.patientScope.kind === "none") return false;
  const patient = await getPatientWith(query, patientId);
  if (!patient) return false;
  if (scope.patientScope.kind === "all") return true;
  return patientInDoctorScopeWith(query, scope.patientScope.clinicianPartyId, patientId);
}

async function patientVisibleInOperation(
  client: DbClient,
  handle: StaffOperationHandle,
  action: StaffRuntimeAction,
  patientId: number,
): Promise<boolean> {
  const scope = await staffOperationPatientScope(client, handle, action);
  if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
  const { rows } = await client.query<{ id: number }>("SELECT id FROM patients WHERE id = $1", [patientId]);
  if (!rows.length) return false;
  if (scope.kind === "all") return true;
  return patientInDoctorScopeWith(client, scope.clinicianPartyId, patientId);
}

async function visitVisibleInSnapshot(
  query: CanonicalSnapshotQuery,
  scope: CanonicalSnapshotScope,
  visitId: number,
): Promise<{ patientId: number | null; doctorId: number | null } | null> {
  if (scope.patientScope.kind === "none") return null;
  const visit = await visitPatientOfWith(query, visitId);
  if (!visit) return null;
  if (scope.patientScope.kind === "all") return visit;
  if (visit.patientId !== null) {
    const inside = await patientInDoctorScopeWith(query, scope.patientScope.clinicianPartyId, visit.patientId);
    return inside ? visit : null;
  }
  return visit.doctorId === scope.patientScope.clinicianPartyId ? visit : null;
}

/* ---------------------------------------------------------------------------
 * 1. Patient Financial Reads & Responsibility
 * ------------------------------------------------------------------------- */

export async function ledgerCanonicalResponse(
  session: VerifiedDurableSession,
  rawId: string,
): Promise<NextResponse> {
  const id = parsePositiveId(rawId);
  if (!id) {
    return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400, headers: NO_STORE });
  }
  try {
    const payload = await runCanonicalReadSnapshot(
      session,
      "read:patients.ledger",
      async (query, scope) => {
        if (!(await patientVisibleInSnapshot(query, scope, id))) {
          throw new CanonicalPatientFinanceRefusal(404, "المريض غير موجود.");
        }
        const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
        const { invoices, payments, openings } = await patientLedgerInSnapshot(id, query as DbClient);
        const plans = await listPatientPlansWith(query, id, today);
        const canReverseReceipts =
          scope.granted("finance.payments.void") || scope.granted("finance.payments.refund");
        const receiptRemaining = canReverseReceipts
          ? await patientReceiptRemaindersWith(query, id)
          : undefined;
        const legacyBalanceArrangements = await listLegacyBalanceArrangements(id, today, false, query);
        const legacyOpeningPositions = await listLegacyOpeningPositionsWith(query, id);
        const installmentRecovery = await patientReversedInstallmentRecoveriesInSnapshot(query, id);
        const receiptProvenance = await readReceiptProvenanceInSnapshot(
          query,
          payments.map((payment) => payment.id),
        );
        const balances = patientBalancesByCurrency(
          invoices.map((invoice) => ({
            totalMinor: invoice.totalMinor,
            discountMinor: invoice.discountMinor,
            status: invoice.status,
            baseCurrency: invoice.baseCurrency,
          })),
          toCurrencyPaymentLikes(
            id,
            payments.map((payment) => ({
              settlementAllocation: payment.settlementAllocation,
              amountMinor: payment.amountMinor,
              currency: payment.currency,
              exchangeRate: payment.exchangeRate,
              baseAmountMinor: payment.baseAmountMinor,
              kind: payment.kind,
              invoiceId: payment.invoiceId,
              planId: payment.planId,
              openingCurrency: payment.openingCurrency,
            })),
            new Map(invoices.map((invoice) => [invoice.id, { patientId: id, currency: invoice.baseCurrency }])),
            new Map(plans.map((plan) => [plan.id, { patientId: id, currency: plan.baseCurrency }])),
          ),
          openingMinorsOf(openings),
        );
        const balance = balances[CLINIC_BASE_CURRENCY];
        const canManageOpening = scope.granted("finance.opening-balances.manage");
        return {
          clinicTimeZone: CLINIC_TIME_ZONE,
          invoices,
          payments,
          opening: openings.find((row) => row.currency === CLINIC_BASE_CURRENCY) ?? null,
          openings,
          balance,
          balances,
          baseCurrency: CLINIC_BASE_CURRENCY,
          plans: plans.map(planLedgerSummary),
          ...(receiptRemaining ? { receiptRemaining } : {}),
          receiptProvenance,
          openingAccess: { add: canManageOpening, edit: canManageOpening },
          legacyBalanceArrangements,
          legacyOpeningPositions,
          installmentRecovery,
          legacyArrangementAccess: { manage: scope.granted("finance.legacy.record") },
        };
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(payload, { headers: NO_STORE });
  } catch (error) {
    return handleFinanceError(error, "تعذّر تحميل حساب المريض.");
  }
}

export async function statementCanonicalResponse(
  session: VerifiedDurableSession,
  request: Request,
  rawId: string,
): Promise<NextResponse> {
  const headers = {
    "Cache-Control": "private, no-store",
    Vary: "Cookie",
    "X-Content-Type-Options": "nosniff",
  };
  const id = parsePositiveId(rawId);
  if (!id) {
    return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400, headers });
  }
  let options: ReturnType<typeof parsePatientStatementOptions>;
  try {
    options = parsePatientStatementOptions(new URL(request.url).searchParams, id);
  } catch (error) {
    return NextResponse.json(
      {
        message:
          error instanceof StatementInputError
            ? error.message
            : "تعذّر تحميل كشف الحساب. أعد المحاولة قبل الطباعة أو المشاركة.",
      },
      { status: error instanceof StatementInputError ? 400 : 500, headers },
    );
  }
  try {
    const document = await runCanonicalReadSnapshot(
      session,
      "read:patients.ledger",
      async (query, scope) => {
        if (!(await patientVisibleInSnapshot(query, scope, id))) return null;
        return loadPatientStatementDocumentInSnapshot(query, id, options);
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    if (!document) {
      return NextResponse.json({ message: "المريض غير موجود." }, { status: 404, headers });
    }
    return NextResponse.json(document, { headers });
  } catch (error) {
    if (error instanceof StatementInputError) {
      return NextResponse.json({ message: error.message }, { status: 400, headers });
    }
    return handleFinanceError(error, "تعذّر تحميل كشف الحساب. أعد المحاولة قبل الطباعة أو المشاركة.");
  }
}

export async function treatmentFinancialContextCanonicalResponse(
  session: VerifiedDurableSession,
  rawId: string,
): Promise<NextResponse> {
  const patientId = parsePositiveId(rawId);
  if (!patientId) {
    return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400, headers: NO_STORE });
  }
  try {
    const result = await runCanonicalReadSnapshot(
      session,
      "read:patients.ledger",
      async (query, scope) => {
        if (!(await patientVisibleInSnapshot(query, scope, patientId))) return null;
        return listTreatmentFinancialReferencesInSnapshot(query, patientId);
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    if (!result) {
      return NextResponse.json({ message: "المريض غير موجود." }, { status: 404, headers: NO_STORE });
    }
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    return handleFinanceError(error, "تعذّر التحقق من المراجع المالية؛ راجع السجل المالي قبل التحصيل.");
  }
}

export async function responsibilityCanonicalResponse(
  session: VerifiedDurableSession,
  request: Request,
  rawId: string,
  write: boolean,
): Promise<NextResponse> {
  if (!/^[1-9]\d*$/.test(rawId) || Number(rawId) > 2_147_483_647) {
    return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400, headers: NO_STORE });
  }
  const patientId = Number(rawId);
  let input: Record<string, unknown> | null;
  try {
    input = write
      ? await readJsonBody<Record<string, unknown>>(request, JSON_BODY_LIMIT_BYTES)
      : Object.fromEntries(new URL(request.url).searchParams);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE });
  }
  if (!input || !["clinical", "ortho"].includes(String(input.kind))) {
    return NextResponse.json({ message: "مرجع الحالة غير صالح." }, { status: 400, headers: NO_STORE });
  }
  const target: ResponsibilityTarget = {
    patientId,
    kind: input.kind as "clinical" | "ortho",
    sourceId: Number(input.sourceId),
  };
  try {
    if (!write) {
      const result = await runCanonicalReadSnapshot(
        session,
        "read:patients.responsibility",
        async (query, scope) => {
          if (!(await patientVisibleInSnapshot(query, scope, patientId))) {
            throw new ResponsibilityError(404, "المريض غير موجود.");
          }
          return readCanonicalResponsibilityInSnapshot(
            query,
            target,
            scope.granted("finance.patient-ledger.manage"),
          );
        },
        { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
      );
      return NextResponse.json(result, { headers: NO_STORE });
    }
    const command = {
      expectedSourceFingerprint:
        typeof input.expectedSourceFingerprint === "string" ? input.expectedSourceFingerprint : "",
      doctorId: Number(input.doctorId),
      reason: typeof input.reason === "string" ? input.reason : "",
    };
    const result = await withStaffOperation(
      getPool(),
      session,
      "finance.patient-ledger.manage",
      async (client, handle) => {
        if (!(await patientVisibleInOperation(client, handle, "finance.patient-ledger.manage", patientId))) {
          throw new ResponsibilityError(404, "المريض غير موجود.");
        }
        const identity = await staffOperationIdentity(client, handle, "finance.patient-ledger.manage");
        return updateCanonicalResponsibilityInTx(client, target, command, {
          userId: identity.userId,
          username: identity.username,
          role: identity.role,
        });
      },
    );
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ResponsibilityError) {
      return NextResponse.json({ message: error.message }, { status: error.status, headers: NO_STORE });
    }
    return handleFinanceError(error, "تعذّر تحديث المسؤولية. أعد المحاولة.");
  }
}

/* ---------------------------------------------------------------------------
 * 2. Visit Financial Reads (`walkout`, `billing-preview`, `financial-context`)
 * ------------------------------------------------------------------------- */

export async function visitWalkoutCanonicalResponse(
  session: VerifiedDurableSession,
  rawId: string,
): Promise<NextResponse> {
  const id = parsePositiveId(rawId);
  if (!id) {
    return NextResponse.json({ message: "رقم الزيارة غير صالح." }, { status: 400, headers: NO_STORE });
  }
  try {
    const payload = await runCanonicalReadSnapshot(
      session,
      "read:visits.invoices",
      async (query, scope) => {
        const visit = await visitVisibleInSnapshot(query, scope, id);
        if (!visit) return null;
        const checkout = await readVisitCheckoutInSnapshot(query, id);
        if (!checkout) return null;
        const { walkout, summary, dueRecommendation, today } = checkout;
        if (walkout.patientId !== visit.patientId) {
          throw new CanonicalPatientFinanceRefusal(409, "تغيّر ارتباط الزيارة؛ أعد تحميل الملف.");
        }
        const signedToday =
          walkout.signedAt !== null &&
          clinicDateString(new Date(walkout.signedAt), CLINIC_TIME_ZONE) === today;
        const canSeeHandoff =
          scope.granted("visits.manage") || scope.granted("finance.payments.collect");
        const handoff =
          canSeeHandoff && walkout.signedAt
            ? await readReceptionHandoffWith(query, id, walkout)
            : null;
        return {
          ...walkout,
          summary,
          dueRecommendation,
          signedToday,
          ...(handoff
            ? { receptionHandoff: { status: handoff.status, handledReason: handoff.handledReason } }
            : {}),
        };
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    if (!payload) {
      return NextResponse.json({ message: "الزيارة غير موجودة." }, { status: 404, headers: NO_STORE });
    }
    return NextResponse.json(payload, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof InvoiceSettlementError) {
      return NextResponse.json({ message: error.message }, { status: 409, headers: NO_STORE });
    }
    return handleFinanceError(error, "تعذّر تحميل ملخّص المغادرة.");
  }
}

export async function visitBillingPreviewCanonicalResponse(
  session: VerifiedDurableSession,
  rawId: string,
): Promise<NextResponse> {
  const visitId = parsePositiveId(rawId);
  if (!visitId) {
    return NextResponse.json({ message: "رقم الزيارة غير صالح." }, { status: 400, headers: NO_STORE });
  }
  try {
    const preview = await runCanonicalReadSnapshot(
      session,
      "read:visits.invoices",
      async (query, scope) => {
        const visit = await visitVisibleInSnapshot(query, scope, visitId);
        if (!visit) return null;
        return previewVisitBillingWith(query, visitId);
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    if (!preview) {
      return NextResponse.json({ message: "الزيارة غير موجودة." }, { status: 404, headers: NO_STORE });
    }
    return NextResponse.json(preview, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ClinicalPlanConflict) {
      return NextResponse.json(
        { message: "بند الخطة المرتبط تغيّر — أعد تحميل الزيارة." },
        { status: 409, headers: NO_STORE },
      );
    }
    return handleFinanceError(error, "تعذّر حساب معاينة الاستحقاق.");
  }
}

export async function visitFinancialContextCanonicalResponse(
  session: VerifiedDurableSession,
  rawId: string,
): Promise<NextResponse> {
  const id = parsePositiveId(rawId);
  if (!id) {
    return NextResponse.json({ message: "رقم الزيارة غير صالح." }, { status: 400, headers: NO_STORE });
  }
  try {
    const projected = await runCanonicalReadSnapshot(
      session,
      "read:visits.invoices",
      async (query, scope) => {
        const visit = await visitVisibleInSnapshot(query, scope, id);
        if (!visit) return null;
        const result = await readVisitFinancialContext(query as DbClient, id, visit.patientId);
        if (!result) return null;
        return redactVisitFinancialContext(result, scope.granted("finance.invoices.view"));
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    if (!projected) {
      return NextResponse.json({ message: "الزيارة غير موجودة." }, { status: 404, headers: NO_STORE });
    }
    return NextResponse.json(projected, { headers: NO_STORE });
  } catch (error) {
    return handleFinanceError(error, "تعذّر التحقق من مصادر العمل.");
  }
}

/* ---------------------------------------------------------------------------
 * 3. Patient Families (`families/**` & `patients/[id]/family`)
 * ------------------------------------------------------------------------- */

const FAMILY_FAILURES: Record<FamilyWriteFailure, [string, 404 | 409]> = {
  family_not_found: ["لا توجد عائلة بهذا الرقم.", 404],
  patient_not_found: ["لا يوجد مريض بهذا الرقم.", 404],
  guarantor_not_found: ["المريض الضامن غير موجود.", 404],
  already_in_family: ["هذا المريض مربوطٌ بعائلةٍ أخرى — افكك ربطه منها أولًا.", 409],
  not_member: ["هذا المريض ليس من أفراد هذه العائلة.", 404],
};

function canonicalFamilyFailureResponse(reason: FamilyWriteFailure): NextResponse {
  const [message, status] = FAMILY_FAILURES[reason];
  return NextResponse.json({ message }, { status, headers: NO_STORE });
}

async function projectCanonicalFamilyRecord(
  query: Pick<DbClient, "query">,
  record: PatientFamilyRecord,
  options: {
    patientScope: StaffRecordConstraint;
    canSeeMoney: boolean;
    canEdit: boolean;
    allowEmptyOwnScope?: boolean;
  },
): Promise<FamilyView | null> {
  if (options.patientScope.kind === "none") return null;
  const shownMembers: PatientFamilyRecord["members"] = [];
  for (const member of record.members) {
    const visible =
      options.patientScope.kind === "all" ||
      (await patientInDoctorScopeWith(query, options.patientScope.clinicianPartyId, member.id));
    if (visible) shownMembers.push(member);
  }
  if (options.patientScope.kind === "own" && shownMembers.length === 0 && !options.allowEmptyOwnScope) {
    return null;
  }
  const canSeeMoney = options.canSeeMoney;
  const balances =
    canSeeMoney && shownMembers.length > 0
      ? await familyMemberBalancesInSnapshot(
          query,
          shownMembers.map((member) => member.id),
        )
      : new Map();
  const members: FamilyViewMember[] = shownMembers.map((member) => ({
    id: member.id,
    patientNumber: member.patientNumber,
    fullName: member.fullName,
    phone: member.phone,
    role: member.role,
    roleLabel: familyRoleLabel(member.role),
    ...(canSeeMoney ? { balances: balances.get(member.id) ?? [] } : {}),
  }));
  const guarantor = record.guarantor;
  let guarantorHidden = false;
  if (guarantor.kind === "patient" && guarantor.patientId !== null && options.patientScope.kind === "own") {
    guarantorHidden = !(await patientInDoctorScopeWith(
      query,
      options.patientScope.clinicianPartyId,
      guarantor.patientId,
    ));
  }
  return {
    id: record.id,
    name: record.name,
    note: record.note,
    guarantor: {
      kind: guarantor.kind,
      patientId: guarantorHidden ? null : guarantor.patientId,
      patientNumber: guarantorHidden ? null : guarantor.patientNumber,
      name: guarantorHidden ? null : guarantor.name,
      phone: guarantorHidden || !canSeeMoney ? null : guarantor.phone,
      hidden: guarantorHidden,
    },
    members,
    canSeeMoney,
    ...(canSeeMoney
      ? { totals: familyTotals(members.map((member) => ({ balances: member.balances ?? [] }))) }
      : {}),
    canEdit: options.canEdit,
  };
}

async function familyAccessibleInOwnScope(
  client: DbClient,
  clinicianPartyId: number,
  familyId: number,
): Promise<boolean> {
  const existing = await getPatientFamilyRecordWith(client, familyId);
  if (!existing) return false;
  for (const member of existing.members) {
    if (await patientInDoctorScopeWith(client, clinicianPartyId, member.id)) return true;
  }
  return false;
}

export async function familiesSearchCanonicalResponse(
  session: VerifiedDurableSession,
  request: Request,
): Promise<NextResponse> {
  const url = new URL(request.url);
  const phone = (url.searchParams.get("phone") ?? "").trim().slice(0, 40);
  const term = (url.searchParams.get("q") ?? "").trim().slice(0, 80);
  try {
    const payload = await runCanonicalReadSnapshot(
      session,
      "read:patients.record",
      async (query, scope) => {
        if (scope.patientScope.kind === "none") {
          throw new CanonicalPatientFinanceRefusal(403, "نطاق وصولك للمرضى مغلق.");
        }
        const clinicianPartyId =
          scope.patientScope.kind === "own" ? scope.patientScope.clinicianPartyId : null;
        if (phone) {
          return { suggestions: await findFamiliesByPhoneWith(query, phone, clinicianPartyId) };
        }
        if (term) {
          return { families: await searchPatientFamiliesWith(query, term, clinicianPartyId) };
        }
        return { families: [] };
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(payload, { headers: NO_STORE });
  } catch (error) {
    return handleFinanceError(error, "تعذّر البحث عن العائلات.");
  }
}

export async function createFamilyCanonicalResponse(
  session: VerifiedDurableSession,
  request: Request,
): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    const parsed = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE });
    }
    body = parsed as Record<string, unknown>;
  } catch (error) {
    return (
      bodyErrorResponse(error) ??
      NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE })
    );
  }
  const draft = validateFamilyDraft(body);
  if (!draft.ok) {
    return NextResponse.json({ message: draft.message }, { status: 400, headers: NO_STORE });
  }
  try {
    const outcome = await withStaffOperation(
      getPool(),
      session,
      "patients.edit",
      async (client, handle) => {
        const patientScope = await staffOperationPatientScope(client, handle, "patients.edit");
        if (patientScope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
        if (patientScope.kind === "own") {
          for (const member of draft.value.members) {
            if (!(await patientInDoctorScopeWith(client, patientScope.clinicianPartyId, member.patientId))) {
              return { ok: false as const, reason: "patient_not_found" as FamilyWriteFailure };
            }
          }
          if (
            draft.value.guarantor.kind === "patient" &&
            !(await patientInDoctorScopeWith(
              client,
              patientScope.clinicianPartyId,
              draft.value.guarantor.patientId,
            ))
          ) {
            return { ok: false as const, reason: "guarantor_not_found" as FamilyWriteFailure };
          }
        }
        const identity = await staffOperationIdentity(client, handle, "patients.edit");
        const caps = await staffOperationCapabilities(client, handle, "patients.edit", [
          "finance.patient-ledger.view",
        ]);
        const created = await createPatientFamilyInTx(client, draft.value, {
          actor: identity.username,
          actorRole: identity.role,
        });
        if (!created.ok) return { ok: false as const, reason: created.reason };
        const view = await projectCanonicalFamilyRecord(client, created.family, {
          patientScope,
          canSeeMoney: caps.has("finance.patient-ledger.view"),
          canEdit: true,
          allowEmptyOwnScope: true,
        });
        return { ok: true as const, view };
      },
    );
    if (!outcome.ok) return canonicalFamilyFailureResponse(outcome.reason);
    if (!outcome.view) {
      return NextResponse.json({ message: "تعذّر عرض العائلة." }, { status: 500, headers: NO_STORE });
    }
    return NextResponse.json(outcome.view, { status: 201, headers: NO_STORE });
  } catch (error) {
    return handleFinanceError(error, "تعذّر إنشاء العائلة. أعد المحاولة.");
  }
}

export async function getFamilyCanonicalResponse(
  session: VerifiedDurableSession,
  rawId: string,
): Promise<NextResponse> {
  const familyId = parsePositiveId(rawId);
  if (!familyId) {
    return NextResponse.json({ message: "رقم العائلة غير صالح." }, { status: 400, headers: NO_STORE });
  }
  try {
    const view = await runCanonicalReadSnapshot(
      session,
      "read:patients.record",
      async (query, scope) => {
        const record = await getPatientFamilyRecordWith(query, familyId);
        if (!record) return null;
        return projectCanonicalFamilyRecord(query, record, {
          patientScope: scope.patientScope,
          canSeeMoney: scope.granted("finance.patient-ledger.view"),
          canEdit: scope.granted("patients.edit"),
        });
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    if (!view) {
      return NextResponse.json({ message: "لا توجد عائلة بهذا الرقم." }, { status: 404, headers: NO_STORE });
    }
    return NextResponse.json(view, { headers: NO_STORE });
  } catch (error) {
    return handleFinanceError(error, "تعذّر تحميل العائلة.");
  }
}

export async function updateFamilyCanonicalResponse(
  session: VerifiedDurableSession,
  request: Request,
  rawId: string,
): Promise<NextResponse> {
  const familyId = parsePositiveId(rawId);
  if (!familyId) {
    return NextResponse.json({ message: "رقم العائلة غير صالح." }, { status: 400, headers: NO_STORE });
  }
  let body: Record<string, unknown>;
  try {
    const parsed = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE });
    }
    body = parsed as Record<string, unknown>;
  } catch (error) {
    return (
      bodyErrorResponse(error) ??
      NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE })
    );
  }
  const update: { name?: string; note?: string | null } = {};
  if (body.name !== undefined) {
    const name = parseFamilyName(body.name);
    if (!name.ok) return NextResponse.json({ message: name.message }, { status: 400, headers: NO_STORE });
    update.name = name.value;
  }
  if (body.note !== undefined) {
    const note = parseFamilyNote(body.note);
    if (!note.ok) return NextResponse.json({ message: note.message }, { status: 400, headers: NO_STORE });
    update.note = note.value;
  }
  if (update.name === undefined && update.note === undefined) {
    return NextResponse.json({ message: "لا تعديل في الطلب." }, { status: 400, headers: NO_STORE });
  }
  try {
    const outcome = await withStaffOperation(
      getPool(),
      session,
      "patients.edit",
      async (client, handle) => {
        const patientScope = await staffOperationPatientScope(client, handle, "patients.edit");
        if (patientScope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
        if (
          patientScope.kind === "own" &&
          !(await familyAccessibleInOwnScope(client, patientScope.clinicianPartyId, familyId))
        ) {
          return { ok: false as const, reason: "family_not_found" as FamilyWriteFailure };
        }
        const identity = await staffOperationIdentity(client, handle, "patients.edit");
        const caps = await staffOperationCapabilities(client, handle, "patients.edit", [
          "finance.patient-ledger.view",
        ]);
        const updated = await updateFamilyDetailsInTx(
          client,
          { familyId, ...update },
          { actor: identity.username, actorRole: identity.role },
        );
        if (!updated.ok) return { ok: false as const, reason: updated.reason };
        const view = await projectCanonicalFamilyRecord(client, updated.family, {
          patientScope,
          canSeeMoney: caps.has("finance.patient-ledger.view"),
          canEdit: true,
          allowEmptyOwnScope: true,
        });
        return { ok: true as const, view };
      },
    );
    if (!outcome.ok) return canonicalFamilyFailureResponse(outcome.reason);
    if (!outcome.view) {
      return NextResponse.json({ message: "تعذّر عرض العائلة." }, { status: 500, headers: NO_STORE });
    }
    return NextResponse.json(outcome.view, { headers: NO_STORE });
  } catch (error) {
    return handleFinanceError(error, "تعذّر حفظ العائلة. أعد المحاولة.");
  }
}

export async function setFamilyGuarantorCanonicalResponse(
  session: VerifiedDurableSession,
  request: Request,
  rawId: string,
): Promise<NextResponse> {
  const familyId = parsePositiveId(rawId);
  if (!familyId) {
    return NextResponse.json({ message: "رقم العائلة غير صالح." }, { status: 400, headers: NO_STORE });
  }
  let body: Record<string, unknown>;
  try {
    const parsed = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE });
    }
    body = parsed as Record<string, unknown>;
  } catch (error) {
    return (
      bodyErrorResponse(error) ??
      NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE })
    );
  }
  const guarantor = parseGuarantor(body.guarantor ?? body);
  if (!guarantor.ok) {
    return NextResponse.json({ message: guarantor.message }, { status: 400, headers: NO_STORE });
  }
  try {
    const outcome = await withStaffOperation(
      getPool(),
      session,
      "patients.edit",
      async (client, handle) => {
        const patientScope = await staffOperationPatientScope(client, handle, "patients.edit");
        if (patientScope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
        if (patientScope.kind === "own") {
          if (!(await familyAccessibleInOwnScope(client, patientScope.clinicianPartyId, familyId))) {
            return { ok: false as const, reason: "family_not_found" as FamilyWriteFailure };
          }
          if (
            guarantor.value.kind === "patient" &&
            !(await patientInDoctorScopeWith(
              client,
              patientScope.clinicianPartyId,
              guarantor.value.patientId,
            ))
          ) {
            return { ok: false as const, reason: "guarantor_not_found" as FamilyWriteFailure };
          }
        }
        const identity = await staffOperationIdentity(client, handle, "patients.edit");
        const caps = await staffOperationCapabilities(client, handle, "patients.edit", [
          "finance.patient-ledger.view",
        ]);
        const updated = await setFamilyGuarantorInTx(
          client,
          { familyId, guarantor: guarantor.value },
          { actor: identity.username, actorRole: identity.role },
        );
        if (!updated.ok) return { ok: false as const, reason: updated.reason };
        const view = await projectCanonicalFamilyRecord(client, updated.family, {
          patientScope,
          canSeeMoney: caps.has("finance.patient-ledger.view"),
          canEdit: true,
          allowEmptyOwnScope: true,
        });
        return { ok: true as const, view };
      },
    );
    if (!outcome.ok) return canonicalFamilyFailureResponse(outcome.reason);
    if (!outcome.view) {
      return NextResponse.json({ message: "تعذّر عرض العائلة." }, { status: 500, headers: NO_STORE });
    }
    return NextResponse.json(outcome.view, { headers: NO_STORE });
  } catch (error) {
    return handleFinanceError(error, "تعذّر حفظ الضامن. أعد المحاولة.");
  }
}

export async function linkFamilyMemberCanonicalResponse(
  session: VerifiedDurableSession,
  request: Request,
  rawId: string,
): Promise<NextResponse> {
  const familyId = parsePositiveId(rawId);
  if (!familyId) {
    return NextResponse.json({ message: "رقم العائلة غير صالح." }, { status: 400, headers: NO_STORE });
  }
  let body: Record<string, unknown>;
  try {
    const parsed = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE });
    }
    body = parsed as Record<string, unknown>;
  } catch (error) {
    return (
      bodyErrorResponse(error) ??
      NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE })
    );
  }
  const patientId = parsePositiveId(String(body.patientId ?? ""));
  if (!patientId) {
    return NextResponse.json(
      { message: "اختر المريض الذي يُربط بالعائلة." },
      { status: 400, headers: NO_STORE },
    );
  }
  const role = parseFamilyRole(body.role);
  if (!role.ok) {
    return NextResponse.json({ message: role.message }, { status: 400, headers: NO_STORE });
  }
  try {
    const outcome = await withStaffOperation(
      getPool(),
      session,
      "patients.edit",
      async (client, handle) => {
        const patientScope = await staffOperationPatientScope(client, handle, "patients.edit");
        if (patientScope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
        if (patientScope.kind === "own") {
          if (!(await patientInDoctorScopeWith(client, patientScope.clinicianPartyId, patientId))) {
            return { ok: false as const, reason: "patient_not_found" as FamilyWriteFailure };
          }
          if (!(await familyAccessibleInOwnScope(client, patientScope.clinicianPartyId, familyId))) {
            return { ok: false as const, reason: "family_not_found" as FamilyWriteFailure };
          }
        }
        const identity = await staffOperationIdentity(client, handle, "patients.edit");
        const caps = await staffOperationCapabilities(client, handle, "patients.edit", [
          "finance.patient-ledger.view",
        ]);
        const linked = await linkPatientToFamilyInTx(
          client,
          { familyId, patientId, role: role.value },
          { actor: identity.username, actorRole: identity.role },
        );
        if (!linked.ok) return { ok: false as const, reason: linked.reason };
        const view = await projectCanonicalFamilyRecord(client, linked.family, {
          patientScope,
          canSeeMoney: caps.has("finance.patient-ledger.view"),
          canEdit: true,
          allowEmptyOwnScope: true,
        });
        return { ok: true as const, view };
      },
    );
    if (!outcome.ok) return canonicalFamilyFailureResponse(outcome.reason);
    if (!outcome.view) {
      return NextResponse.json({ message: "تعذّر عرض العائلة." }, { status: 500, headers: NO_STORE });
    }
    return NextResponse.json(outcome.view, { headers: NO_STORE });
  } catch (error) {
    return handleFinanceError(error, "تعذّر ربط المريض بالعائلة. أعد المحاولة.");
  }
}

export async function unlinkFamilyMemberCanonicalResponse(
  session: VerifiedDurableSession,
  rawFamilyId: string,
  rawPatientId: string,
): Promise<NextResponse> {
  const familyId = parsePositiveId(rawFamilyId);
  const patientId = parsePositiveId(rawPatientId);
  if (!familyId || !patientId) {
    return NextResponse.json(
      { message: "رقم العائلة أو المريض غير صالح." },
      { status: 400, headers: NO_STORE },
    );
  }
  try {
    const outcome = await withStaffOperation(
      getPool(),
      session,
      "patients.edit",
      async (client, handle) => {
        const patientScope = await staffOperationPatientScope(client, handle, "patients.edit");
        if (patientScope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
        if (patientScope.kind === "own") {
          if (!(await patientInDoctorScopeWith(client, patientScope.clinicianPartyId, patientId))) {
            return { ok: false as const, reason: "patient_not_found" as FamilyWriteFailure };
          }
          if (!(await familyAccessibleInOwnScope(client, patientScope.clinicianPartyId, familyId))) {
            return { ok: false as const, reason: "family_not_found" as FamilyWriteFailure };
          }
        }
        const identity = await staffOperationIdentity(client, handle, "patients.edit");
        const caps = await staffOperationCapabilities(client, handle, "patients.edit", [
          "finance.patient-ledger.view",
        ]);
        const unlinked = await unlinkPatientFromFamilyInTx(
          client,
          { familyId, patientId },
          { actor: identity.username, actorRole: identity.role },
        );
        if (!unlinked.ok) return { ok: false as const, reason: unlinked.reason };
        const view = await projectCanonicalFamilyRecord(client, unlinked.family, {
          patientScope,
          canSeeMoney: caps.has("finance.patient-ledger.view"),
          canEdit: true,
          allowEmptyOwnScope: true,
        });
        return { ok: true as const, view };
      },
    );
    if (!outcome.ok) return canonicalFamilyFailureResponse(outcome.reason);
    if (!outcome.view) {
      return NextResponse.json({ message: "تعذّر عرض العائلة." }, { status: 500, headers: NO_STORE });
    }
    return NextResponse.json(outcome.view, { headers: NO_STORE });
  } catch (error) {
    return handleFinanceError(error, "تعذّر فكّ الربط. أعد المحاولة.");
  }
}

export async function patientFamilyCanonicalResponse(
  session: VerifiedDurableSession,
  rawPatientId: string,
): Promise<NextResponse> {
  const patientId = parsePositiveId(rawPatientId);
  if (!patientId) {
    return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400, headers: NO_STORE });
  }
  try {
    const payload = await runCanonicalReadSnapshot(
      session,
      "read:patients.record",
      async (query, scope) => {
        if (!(await patientVisibleInSnapshot(query, scope, patientId))) return null;
        const familyId = await familyIdOfPatientWith(query, patientId);
        if (familyId === undefined) return null;
        const canEdit = scope.granted("patients.edit");
        if (familyId === null) return { family: null, canEdit };
        const record = await getPatientFamilyRecordWith(query, familyId);
        if (!record) return { family: null, canEdit };
        const view = await projectCanonicalFamilyRecord(query, record, {
          patientScope: scope.patientScope,
          canSeeMoney: scope.granted("finance.patient-ledger.view"),
          canEdit,
        });
        return { family: view, canEdit };
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    if (!payload) {
      return NextResponse.json({ message: "لا يوجد مريض بهذا الرقم." }, { status: 404, headers: NO_STORE });
    }
    return NextResponse.json(payload, { headers: NO_STORE });
  } catch (error) {
    return handleFinanceError(error, "تعذّر تحميل عائلة المريض.");
  }
}

/* ---------------------------------------------------------------------------
 * 4. Debt Repayments & Installment Collection
 * ------------------------------------------------------------------------- */

function debtRepaymentErrorStatus(code: DebtRepaymentError["code"]): number {
  if (code === "unauthorized") return 403;
  if (code === "invalid") return 400;
  if (code === "missing") return 404;
  return 409;
}

export async function getDebtRepaymentsCanonicalResponse(
  session: VerifiedDurableSession,
  rawPatientId: string,
): Promise<NextResponse> {
  const patientId = parsePositiveId(rawPatientId);
  if (!patientId) {
    return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400, headers: NO_STORE });
  }
  try {
    const workspace = await runCanonicalReadSnapshot(
      session,
      "read:patients.ledger",
      async (query, scope) => {
        if (!(await patientVisibleInSnapshot(query, scope, patientId))) return null;
        return debtRepaymentWorkspaceInSnapshot(
          query,
          patientId,
          clinicDateString(new Date(), CLINIC_TIME_ZONE),
        );
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    if (!workspace) {
      return NextResponse.json({ message: "المريض غير موجود." }, { status: 404, headers: NO_STORE });
    }
    return NextResponse.json(workspace, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof DebtRepaymentError) {
      return NextResponse.json(
        { code: error.code, message: error.message },
        { status: debtRepaymentErrorStatus(error.code), headers: NO_STORE },
      );
    }
    return handleFinanceError(error, "تعذّر قراءة ترتيب السداد؛ حدّث الحساب.");
  }
}

export async function saveDebtRepaymentCanonicalResponse(
  session: VerifiedDurableSession,
  request: Request,
  rawPatientId: string,
): Promise<NextResponse> {
  const patientId = parsePositiveId(rawPatientId);
  if (!patientId) {
    return NextResponse.json(
      { code: "invalid", message: "رقم المريض غير صالح." },
      { status: 400, headers: NO_STORE },
    );
  }
  try {
    const body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new DebtRepaymentError("invalid", "طلب غير صالح.");
    }
    const source = body as Record<string, unknown>;
    if (
      Object.keys(source).some(
        (key) =>
          ![
            "invoiceId",
            "openingCurrency",
            "currency",
            "terms",
            "expectedVersion",
            "expectedRemainingMinor",
            "expectedSourceHash",
            "reason",
            "idempotencyKey",
            "cancel",
          ].includes(key),
      ) ||
      !isCurrency(source.currency) ||
      typeof source.expectedVersion !== "number" ||
      typeof source.expectedRemainingMinor !== "number" ||
      typeof source.expectedSourceHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(source.expectedSourceHash) ||
      typeof source.reason !== "string" ||
      typeof source.idempotencyKey !== "string" ||
      (source.cancel !== undefined && typeof source.cancel !== "boolean") ||
      (source.invoiceId !== null &&
        !(typeof source.invoiceId === "number" && Number.isSafeInteger(source.invoiceId) && source.invoiceId > 0)) ||
      (source.openingCurrency !== null && !isCurrency(source.openingCurrency))
    ) {
      throw new DebtRepaymentError("invalid", "راجع بيانات ترتيب السداد والنسخة الحالية.");
    }
    const currency = source.currency;
    const invoiceId = source.invoiceId as number | null;
    const openingCurrency = source.openingCurrency;
    const expectedVersion = source.expectedVersion;
    const expectedRemainingMinor = source.expectedRemainingMinor;
    const expectedSourceHash = source.expectedSourceHash;
    const reason = source.reason;
    const idempotencyKey = source.idempotencyKey;
    const cancel = source.cancel as boolean | undefined;

    const result = await withStaffOperation(
      getPool(),
      session,
      "finance.payments.collect",
      async (client, handle) => {
        if (!(await patientVisibleInOperation(client, handle, "finance.payments.collect", patientId))) {
          throw new DebtRepaymentError("missing", "المريض غير موجود.");
        }
        const identity = await staffOperationIdentity(client, handle, "finance.payments.collect");
        const syntheticSession = {
          userId: identity.userId,
          username: identity.username,
          role: identity.role as SessionPayload["role"],
        } as SessionPayload;
        return saveCanonicalDebtRepaymentInTx(client, {
          target: { patientId, currency, invoiceId, openingCurrency },
          terms: source.terms,
          expectedVersion,
          expectedRemainingMinor,
          expectedSourceHash,
          reason,
          idempotencyKey,
          cancel,
          session: syntheticSession,
        });
      },
    );
    return NextResponse.json(result, { status: result.replayed ? 200 : 201, headers: NO_STORE });
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    if (error instanceof DebtRepaymentError) {
      return NextResponse.json(
        { code: error.code, message: error.message },
        { status: debtRepaymentErrorStatus(error.code), headers: NO_STORE },
      );
    }
    return handleFinanceError(error, "تعذّر حفظ الترتيب؛ أعد الطلب نفسه بالمفتاح نفسه.");
  }
}

export async function collectDebtInstallmentCanonicalResponse(
  session: VerifiedDurableSession,
  request: Request,
  rawPatientId: string,
  rawArrangementId: string,
): Promise<NextResponse> {
  const patientId = parsePositiveId(rawPatientId);
  const arrangementId = parsePositiveId(rawArrangementId);
  if (!patientId || !arrangementId) {
    return NextResponse.json(
      { code: "invalid", message: "بيانات التحصيل غير صالحة." },
      { status: 400, headers: NO_STORE },
    );
  }
  try {
    const body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new DebtRepaymentError("invalid", "طلب غير صالح.");
    }
    const source = body as Record<string, unknown>;
    if (
      Object.keys(source).some(
        (key) => !["amount", "currency", "method", "note", "expectedVersion"].includes(key),
      ) ||
      !isCurrency(source.currency) ||
      typeof source.amount !== "string" ||
      typeof source.expectedVersion !== "number" ||
      (source.method !== "cash" && source.method !== "transfer") ||
      (source.note !== null && typeof source.note !== "string")
    ) {
      throw new DebtRepaymentError("invalid", "راجع مبلغ التحصيل وعملته وطريقته.");
    }
    const currency = source.currency;
    const method = source.method;
    const expectedVersion = source.expectedVersion;
    const amountMinor = parseAmount(source.amount, currency);
    if (amountMinor === null || amountMinor <= 0) {
      throw new DebtRepaymentError("invalid", "اكتب مبلغًا موجبًا صحيحًا.");
    }
    const similarityReview = parseSimilarCollectionReviewHeader(
      request.headers.get(SIMILAR_COLLECTION_REVIEW_HEADER),
    );
    if (!similarityReview) {
      throw new DebtRepaymentError(
        "invalid",
        "مراجعة السندات المشابهة المرسلة غير صالحة. أعد فتح نافذة التحصيل.",
      );
    }
    const note = typeof source.note === "string" ? source.note.trim().slice(0, 300) || null : null;
    const idempotencyKey = request.headers.get("idempotency-key") ?? "";

    const result = await withStaffOperation(
      getPool(),
      session,
      "finance.payments.collect",
      async (client, handle) => {
        if (!(await patientVisibleInOperation(client, handle, "finance.payments.collect", patientId))) {
          throw new DebtRepaymentError("missing", "المريض غير موجود.");
        }
        const identity = await staffOperationIdentity(client, handle, "finance.payments.collect");
        const syntheticSession = {
          userId: identity.userId,
          username: identity.username,
          role: identity.role as SessionPayload["role"],
        } as SessionPayload;
        const collected = await collectCanonicalDebtInstallmentInTx(
          client,
          {
            patientId,
            arrangementId,
            expectedVersion,
            amountMinor,
            currency,
            method,
            note,
            idempotencyKey,
            session: syntheticSession,
          },
          { similarityReview },
        );
        const payment = await getPaymentWith(client, collected.paymentId);
        return { payment, replayed: collected.replayed };
      },
    );
    return NextResponse.json(result, { status: result.replayed ? 200 : 201, headers: NO_STORE });
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    if (error instanceof SimilarCollectionReviewRequired) {
      return NextResponse.json(similarCollectionRefusal(error), { status: 409, headers: NO_STORE });
    }
    if (isRetiredCollectionKey(error)) {
      return NextResponse.json(retiredCollectionRefusal(), { status: 409, headers: NO_STORE });
    }
    if (error instanceof DebtRepaymentError) {
      return NextResponse.json(
        { code: error.code, message: error.message },
        { status: debtRepaymentErrorStatus(error.code), headers: NO_STORE },
      );
    }
    return handleFinanceError(error, "نتيجة التحصيل غير مؤكدة؛ أعد نفس الطلب بالمفتاح نفسه.");
  }
}

/* ---------------------------------------------------------------------------
 * 5. Historical Documents (`historical-documents/**`)
 * ------------------------------------------------------------------------- */

export async function listHistoricalDocumentsCanonicalResponse(
  session: VerifiedDurableSession,
  rawPatientId: string,
): Promise<NextResponse> {
  const patientId = parsePositiveId(rawPatientId);
  if (!patientId) {
    return historicalDocumentError(new DebtRepaymentError("invalid", "رقم المريض غير صالح."));
  }
  try {
    const documents = await runCanonicalReadSnapshot(
      session,
      "read:patients.record",
      async (query, scope) => {
        if (!(await patientVisibleInSnapshot(query, scope, patientId))) {
          throw new DebtRepaymentError("missing", "المريض غير موجود.");
        }
        const canViewMoney =
          scope.granted("finance.patient-ledger.view") || scope.granted("patients.history.record");
        if (!canViewMoney) return [];
        return listHistoricalDocumentsInSnapshot(
          query,
          patientId,
          scope.granted("patients.history.correct"),
        );
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json({ documents }, { headers: NO_STORE });
  } catch (error) {
    const refusal = staffAdmissionRefusal(error);
    if (refusal) {
      return NextResponse.json(
        { code: refusal.code, message: refusal.message },
        { status: refusal.status, headers: NO_STORE },
      );
    }
    if (error instanceof DebtRepaymentError) return historicalDocumentError(error);
    return handleFinanceError(error, "تعذّر تنفيذ عملية الاتفاق التاريخي.");
  }
}

export async function previewHistoricalDocumentCanonicalResponse(
  session: VerifiedDurableSession,
  request: Request,
  rawPatientId: string,
): Promise<NextResponse> {
  const patientId = parsePositiveId(rawPatientId);
  if (!patientId) {
    return historicalDocumentError(new DebtRepaymentError("invalid", "رقم المريض غير صالح."));
  }
  try {
    const source = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      throw new DebtRepaymentError("invalid", "طلب غير صالح.");
    }
    if ((source as Record<string, unknown>).patientId !== patientId) {
      throw new DebtRepaymentError("invalid", "هوية المريض لا تطابق الطلب.");
    }
    const preview = await runCanonicalReadSnapshot(
      session,
      "read:patients.history-preview",
      async (query, scope) => {
        if (!(await patientVisibleInSnapshot(query, scope, patientId))) {
          throw new DebtRepaymentError("missing", "المريض غير موجود.");
        }
        const actorCtx: CanonicalHistoricalDocumentActor = {
          userId: scope.userId,
          username: scope.username,
          role: scope.role,
          canEditOpening: scope.granted("finance.opening-balances.manage"),
          capabilities: {
            canIncreasePrice: scope.granted("finance.price-increases.apply"),
            canApplyDiscount: scope.granted("finance.discounts.apply"),
            canOverrideDiscount: scope.granted("finance.discounts.override"),
          },
        };
        return previewCanonicalHistoricalDocumentInSnapshot(
          query,
          patientId,
          source as Record<string, unknown>,
          actorCtx,
        );
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(preview, { headers: NO_STORE });
  } catch (error) {
    const refusal = staffAdmissionRefusal(error);
    if (refusal) {
      return NextResponse.json(
        { code: refusal.code, message: refusal.message },
        { status: refusal.status, headers: NO_STORE },
      );
    }
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    if (error instanceof DebtRepaymentError) return historicalDocumentError(error);
    return handleFinanceError(error, "تعذّر تنفيذ عملية الاتفاق التاريخي.");
  }
}

export async function createHistoricalDocumentCanonicalResponse(
  session: VerifiedDurableSession,
  request: Request,
  rawPatientId: string,
): Promise<NextResponse> {
  const patientId = parsePositiveId(rawPatientId);
  if (!patientId) {
    return historicalDocumentError(new DebtRepaymentError("invalid", "رقم المريض غير صالح."));
  }
  try {
    const source = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      throw new DebtRepaymentError("invalid", "طلب غير صالح.");
    }
    const result = await withStaffOperation(
      getPool(),
      session,
      "patients.history.record",
      async (client, handle) => {
        if (!(await patientVisibleInOperation(client, handle, "patients.history.record", patientId))) {
          throw new DebtRepaymentError("missing", "المريض غير موجود.");
        }
        const identity = await staffOperationIdentity(client, handle, "patients.history.record");
        const caps = await staffOperationCapabilities(client, handle, "patients.history.record", [
          "finance.opening-balances.manage",
          "finance.price-increases.apply",
          "finance.discounts.apply",
          "finance.discounts.override",
        ]);
        return createCanonicalHistoricalDocumentInTx(
          client,
          patientId,
          source as Record<string, unknown>,
          {
            userId: identity.userId,
            username: identity.username,
            role: identity.role,
            canEditOpening: caps.has("finance.opening-balances.manage"),
            capabilities: {
              canIncreasePrice: caps.has("finance.price-increases.apply"),
              canApplyDiscount: caps.has("finance.discounts.apply"),
              canOverrideDiscount: caps.has("finance.discounts.override"),
            },
          },
        );
      },
    );
    return NextResponse.json(result, { status: result.replayed ? 200 : 201, headers: NO_STORE });
  } catch (error) {
    const refusal = staffAdmissionRefusal(error);
    if (refusal) {
      return NextResponse.json(
        { code: refusal.code, message: refusal.message },
        { status: refusal.status, headers: NO_STORE },
      );
    }
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    if (error instanceof DebtRepaymentError) return historicalDocumentError(error);
    return handleFinanceError(error, "تعذّر تنفيذ عملية الاتفاق التاريخي.");
  }
}

export async function correctHistoricalDocumentCanonicalResponse(
  session: VerifiedDurableSession,
  request: Request,
  rawPatientId: string,
  rawDocumentId: string,
): Promise<NextResponse> {
  const patientId = parsePositiveId(rawPatientId);
  const documentId = parsePositiveId(rawDocumentId);
  if (!patientId || !documentId) {
    return historicalDocumentError(new DebtRepaymentError("invalid", "هوية الاتفاق غير صالحة."));
  }
  try {
    const source = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      throw new DebtRepaymentError("invalid", "طلب غير صالح.");
    }
    const result = await withStaffOperation(
      getPool(),
      session,
      "patients.history.correct",
      async (client, handle) => {
        if (!(await patientVisibleInOperation(client, handle, "patients.history.correct", patientId))) {
          throw new DebtRepaymentError("missing", "المريض غير موجود.");
        }
        const identity = await staffOperationIdentity(client, handle, "patients.history.correct");
        return correctCanonicalHistoricalDocumentInTx(
          client,
          patientId,
          documentId,
          source as Record<string, unknown>,
          {
            userId: identity.userId,
            username: identity.username,
            role: identity.role,
          },
        );
      },
    );
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    const refusal = staffAdmissionRefusal(error);
    if (refusal) {
      return NextResponse.json(
        { code: refusal.code, message: refusal.message },
        { status: refusal.status, headers: NO_STORE },
      );
    }
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    if (error instanceof DebtRepaymentError) return historicalDocumentError(error);
    return handleFinanceError(error, "تعذّر تنفيذ عملية الاتفاق التاريخي.");
  }
}

/* ---------------------------------------------------------------------------
 * 6. Legacy Archive, Onboarding, Balance Arrangements & Treatments
 * ------------------------------------------------------------------------- */

export async function patientLegacyArchiveCanonicalResponse(
  session: VerifiedDurableSession,
  rawPatientId: string,
): Promise<NextResponse> {
  const id = parsePositiveId(rawPatientId);
  if (!id) {
    return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400, headers: NO_STORE });
  }
  try {
    const archive = await runCanonicalReadSnapshot(
      session,
      "read:patients.record",
      async (query, scope) => {
        if (!(await patientVisibleInSnapshot(query, scope, id))) {
          throw new CanonicalPatientFinanceRefusal(404, "الملف غير موجود.");
        }
        if (!scope.granted("finance.patient-ledger.view")) {
          throw new CanonicalPatientFinanceRefusal(
            403,
            "غير مصرّح لك بالاطلاع على السجل المالي السابق لهذا المريض.",
          );
        }
        return patientLegacyHistoryWith(query, id);
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(archive, { headers: NO_STORE });
  } catch (error) {
    return handleFinanceError(error, "تعذّر تحميل سجل النظام القديم.");
  }
}

export async function patientLegacyOnboardingCanonicalResponse(
  session: VerifiedDurableSession,
  request: Request,
  rawPatientId: string,
): Promise<NextResponse> {
  const patientId = parsePositiveId(rawPatientId);
  const requestedCase = new URL(request.url).searchParams.get("caseId");
  const caseId = requestedCase === null ? undefined : parsePositiveId(requestedCase);
  if (!patientId || (requestedCase !== null && !caseId)) {
    return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400, headers: NO_STORE });
  }
  try {
    const onboarding = await runCanonicalReadSnapshot(
      session,
      "read:patients.record",
      async (query, scope) => {
        if (!(await patientVisibleInSnapshot(query, scope, patientId))) {
          throw new CanonicalPatientFinanceRefusal(404, "الملف غير موجود.");
        }
        const loaded = await patientLegacyOnboardingInSnapshot(query, patientId, caseId ?? undefined);
        const canReadSources =
          scope.granted("clinical.plans.view") || scope.granted("finance.patient-ledger.view");
        if (loaded && !canReadSources) {
          loaded.financialReference = {
            state: "restricted",
            sources: [],
            clinicalCaseIds: [],
            hasRecordedSchedule: false,
          };
          loaded.steps = loaded.steps.filter((step) => step.key === "baseline");
          loaded.complete = false;
          loaded.warning =
            "تفاصيل المرجع المالي غير متاحة بصلاحيتك؛ لا يمكن تأكيد اكتمال التهيئة من هذه الشاشة.";
        }
        return loaded;
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json({ onboarding }, { headers: NO_STORE });
  } catch (error) {
    return handleFinanceError(error, "تعذّر تحميل تهيئة الحالة السابقة.");
  }
}

export async function listLegacyBalanceArrangementCanonicalResponse(
  session: VerifiedDurableSession,
  rawPatientId: string,
): Promise<NextResponse> {
  const patientId = parsePositiveId(rawPatientId);
  if (!patientId) {
    return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400, headers: NO_STORE });
  }
  try {
    const payload = await runCanonicalReadSnapshot(
      session,
      "read:patients.ledger",
      async (query, scope) => {
        if (!(await patientVisibleInSnapshot(query, scope, patientId))) return null;
        const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
        return {
          arrangements: await listLegacyBalanceArrangements(patientId, today, false, query),
          canManage: scope.granted("finance.legacy.record"),
        };
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    if (!payload) {
      return NextResponse.json({ message: "المريض غير موجود." }, { status: 404, headers: NO_STORE });
    }
    return NextResponse.json(payload, { headers: NO_STORE });
  } catch (error) {
    return handleFinanceError(error, "تعذّر تحميل ترتيب الرصيد السابق.");
  }
}

export async function createLegacyBalanceArrangementCanonicalResponse(
  session: VerifiedDurableSession,
  request: Request,
  rawPatientId: string,
): Promise<NextResponse> {
  const patientId = parsePositiveId(rawPatientId);
  if (!patientId) {
    return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400, headers: NO_STORE });
  }
  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE });
  }
  const source = (body ?? {}) as Record<string, unknown>;
  if (!isCurrency(source.currency)) {
    return NextResponse.json({ message: "اختر عملة الرصيد السابق." }, { status: 400, headers: NO_STORE });
  }
  if (!isLegacyArrangementCadence(source.cadence)) {
    return NextResponse.json(
      { message: "اختر طريقة القسط: مع كل زيارة أو شهري." },
      { status: 400, headers: NO_STORE },
    );
  }
  const installmentMinor = parseAmount(String(source.installmentAmount ?? ""), source.currency);
  if (installmentMinor === null || installmentMinor <= 0) {
    return NextResponse.json({ message: "اكتب قيمة القسط المقترح." }, { status: 400, headers: NO_STORE });
  }
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  let firstDueDate: string | null = null;
  if (source.cadence === "monthly") {
    firstDueDate =
      typeof source.firstDueDate === "string" && DATE_PATTERN.test(source.firstDueDate)
        ? source.firstDueDate
        : today;
    if (firstDueDate < today) {
      return NextResponse.json(
        { message: "بداية الترتيب الشهري لا تكون قبل اليوم؛ هذا ترتيب تحصيل جديد لا إعادة كتابة للتاريخ." },
        { status: 400, headers: NO_STORE },
      );
    }
  }
  const note =
    typeof source.note === "string" && source.note.trim() ? source.note.trim().slice(0, 300) : null;
  const currency = source.currency;
  const cadence = source.cadence;

  try {
    const result = await withStaffOperation(
      getPool(),
      session,
      "finance.legacy.record",
      async (client, handle) => {
        if (!(await patientVisibleInOperation(client, handle, "finance.legacy.record", patientId))) {
          return { ok: false as const, reason: "patient_not_found" as const };
        }
        const identity = await staffOperationIdentity(client, handle, "finance.legacy.record");
        const created = await createLegacyBalanceArrangementInTx(client, {
          patientId,
          currency,
          cadence,
          installmentMinor,
          firstDueDate,
          note,
          createdBy: identity.username,
          today,
        });
        if (!created.ok) return created;
        await insertAuditRow(client, {
          action: "legacy_balance_arrangement.create",
          entity: "patient",
          entityId: patientId,
          details: {
            العملة: created.arrangement.currency,
            الرصيد_عند_الترتيب: created.arrangement.startingDueMinor,
            القسط: created.arrangement.installmentMinor,
            النمط: created.arrangement.cadence,
            أول_استحقاق: created.arrangement.firstDueDate,
            ملاحظة: created.arrangement.note,
          },
          actor: identity.username,
          actorRole: identity.role,
        });
        return created;
      },
    );
    if (!result.ok) {
      const messages = {
        patient_not_found: "المريض غير موجود.",
        no_opening_balance: "لا يوجد رصيد سابق بهذه العملة.",
        opening_settled: "الرصيد السابق بهذه العملة مسدّد بالفعل.",
        already_active: "يوجد ترتيب تحصيل نشط لهذه العملة. ألغِه أولًا إذا أردت تغييره.",
        installment_exceeds_remaining: "قيمة القسط أكبر من المتبقي من الرصيد السابق.",
      } as const;
      const status =
        result.reason === "patient_not_found" || result.reason === "no_opening_balance" ? 404 : 409;
      return NextResponse.json({ message: messages[result.reason] }, { status, headers: NO_STORE });
    }
    return NextResponse.json(result.arrangement, { status: 201, headers: NO_STORE });
  } catch (error) {
    return handleFinanceError(error, "تعذّر إنشاء ترتيب تحصيل الرصيد السابق.");
  }
}

export async function cancelLegacyBalanceArrangementCanonicalResponse(
  session: VerifiedDurableSession,
  request: Request,
  rawPatientId: string,
): Promise<NextResponse> {
  const patientId = parsePositiveId(rawPatientId);
  if (!patientId) {
    return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400, headers: NO_STORE });
  }
  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE });
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const arrangementId = parsePositiveId(String(source.arrangementId ?? ""));
  if (!arrangementId) {
    return NextResponse.json({ message: "ترتيب الرصيد غير صالح." }, { status: 400, headers: NO_STORE });
  }
  const reason = typeof source.reason === "string" ? source.reason.trim().slice(0, 300) : "";
  if (reason.length < 3) {
    return NextResponse.json(
      { message: "اكتب سبب إلغاء أو تغيير ترتيب القسط." },
      { status: 400, headers: NO_STORE },
    );
  }
  try {
    const result = await withStaffOperation(
      getPool(),
      session,
      "finance.legacy.record",
      async (client, handle) => {
        if (!(await patientVisibleInOperation(client, handle, "finance.legacy.record", patientId))) {
          return { ok: false as const, reason: "not_found" as const };
        }
        const identity = await staffOperationIdentity(client, handle, "finance.legacy.record");
        const cancelled = await cancelLegacyBalanceArrangementInTx(client, {
          patientId,
          arrangementId,
          actor: identity.username,
          reason,
        });
        if (!cancelled.ok) return cancelled;
        await insertAuditRow(client, {
          action: "legacy_balance_arrangement.cancel",
          entity: "patient",
          entityId: patientId,
          details: {
            الترتيب: arrangementId,
            العملة: cancelled.arrangement.currency,
            القسط: cancelled.arrangement.installmentMinor,
            السبب: reason,
          },
          actor: identity.username,
          actorRole: identity.role,
        });
        return cancelled;
      },
    );
    if (!result.ok) {
      return NextResponse.json(
        {
          message:
            result.reason === "already_cancelled"
              ? "هذا الترتيب ملغى مسبقًا."
              : "ترتيب الرصيد غير موجود.",
        },
        { status: 404, headers: NO_STORE },
      );
    }
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    return handleFinanceError(error, "تعذّر إلغاء ترتيب الرصيد السابق.");
  }
}

export async function listLegacyTreatmentsCanonicalResponse(
  session: VerifiedDurableSession,
  rawPatientId: string,
): Promise<NextResponse> {
  const patientId = parsePositiveId(rawPatientId);
  if (!patientId) {
    return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400, headers: NO_STORE });
  }
  try {
    const payload = await runCanonicalReadSnapshot(
      session,
      "read:patients.record",
      async (query, scope) => {
        if (!(await patientVisibleInSnapshot(query, scope, patientId))) return null;
        const canViewAgreements =
          scope.granted("finance.patient-ledger.view") || scope.granted("finance.legacy.record");
        const agreements = canViewAgreements
          ? (await listLegacyTreatmentsWith(query, patientId)).filter(
              (agreement) => agreement.documentId === null,
            )
          : [];
        return {
          agreements,
          access: {
            add: scope.granted("finance.legacy.record"),
            edit: scope.granted("finance.opening-balances.manage"),
            void: scope.granted("finance.legacy.void"),
          },
        };
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    if (!payload) {
      return NextResponse.json({ message: "المريض غير موجود." }, { status: 404, headers: NO_STORE });
    }
    return NextResponse.json(payload, { headers: NO_STORE });
  } catch (error) {
    return handleFinanceError(error, "تعذّر تحميل العلاجات السابقة للنظام.");
  }
}

export async function previewLegacyTreatmentCanonicalResponse(
  session: VerifiedDurableSession,
  request: Request,
  rawPatientId: string,
): Promise<NextResponse> {
  const patientId = parsePositiveId(rawPatientId);
  if (!patientId) {
    return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400, headers: NO_STORE });
  }
  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE });
  }
  const parsed = parseLegacyTreatmentRequest(
    body as Record<string, unknown>,
    clinicDateString(new Date(), CLINIC_TIME_ZONE),
  );
  if (!parsed.ok) {
    return NextResponse.json({ message: parsed.message }, { status: 400, headers: NO_STORE });
  }
  try {
    const result = await runCanonicalReadSnapshot(
      session,
      "read:patients.legacy-preview",
      async (query, scope) => {
        if (!(await patientVisibleInSnapshot(query, scope, patientId))) {
          return { ok: false as const, reason: "no_patient" as const };
        }
        return previewLegacyTreatmentInSnapshot(query, {
          patientId,
          request: parsed.value,
          canEditOpening: scope.granted("finance.opening-balances.manage"),
        });
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    if (!result.ok) {
      if (result.reason === "no_patient") {
        return NextResponse.json(
          { message: LEGACY_TREATMENT_MESSAGE.no_patient },
          { status: 404, headers: NO_STORE },
        );
      }
      return NextResponse.json(
        { refusal: result.reason, refusalMessage: LEGACY_TREATMENT_MESSAGE[result.reason], preview: null },
        { headers: NO_STORE },
      );
    }
    return NextResponse.json(
      { refusal: null, refusalMessage: null, replayed: result.replayed, preview: result.preview },
      { headers: NO_STORE },
    );
  } catch (error) {
    return handleFinanceError(error, "تعذّرت معاينة تسجيل العلاج السابق. أعد المحاولة.");
  }
}

export async function createLegacyTreatmentCanonicalResponse(
  session: VerifiedDurableSession,
  request: Request,
  rawPatientId: string,
): Promise<NextResponse> {
  const patientId = parsePositiveId(rawPatientId);
  if (!patientId) {
    return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400, headers: NO_STORE });
  }
  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE });
  }
  const parsed = parseLegacyTreatmentRequest(
    body as Record<string, unknown>,
    clinicDateString(new Date(), CLINIC_TIME_ZONE),
  );
  if (!parsed.ok) {
    return NextResponse.json({ message: parsed.message }, { status: 400, headers: NO_STORE });
  }
  try {
    const result = await withStaffOperation(
      getPool(),
      session,
      "finance.legacy.record",
      async (client, handle) => {
        if (!(await patientVisibleInOperation(client, handle, "finance.legacy.record", patientId))) {
          return { ok: false as const, reason: "no_patient" as const };
        }
        const identity = await staffOperationIdentity(client, handle, "finance.legacy.record");
        const caps = await staffOperationCapabilities(client, handle, "finance.legacy.record", [
          "finance.opening-balances.manage",
        ]);
        const settings = await getSettingsInTransaction(client);
        return writeCanonicalLegacyTreatmentInTx(client, {
          patientId,
          request: parsed.value,
          actor: identity.username,
          actorRole: identity.role,
          actorUserId: identity.userId,
          canEditOpening: caps.has("finance.opening-balances.manage"),
          templates: effectiveTemplates(settings["plans.specialty_templates"]).templates,
        });
      },
    );
    if (!result.ok) {
      return NextResponse.json(
        { message: LEGACY_TREATMENT_MESSAGE[result.reason] },
        { status: LEGACY_TREATMENT_STATUS[result.reason], headers: NO_STORE },
      );
    }
    return NextResponse.json(
      { agreement: result.agreement, replayed: result.replayed, caseCreated: result.caseCreated },
      { status: result.replayed ? 200 : 201, headers: NO_STORE },
    );
  } catch (error) {
    if (error instanceof DebtRepaymentError) {
      return NextResponse.json(
        { code: error.code, message: error.message },
        { status: debtRepaymentErrorStatus(error.code), headers: NO_STORE },
      );
    }
    return handleFinanceError(error, "تعذّر تسجيل العلاج السابق للنظام. أعد المحاولة.");
  }
}

function legacyVoidRefusalResponse(reason: LegacyVoidRefusal): NextResponse {
  return NextResponse.json(
    { reason, message: LEGACY_TREATMENT_MESSAGE[reason] },
    { status: LEGACY_TREATMENT_STATUS[reason], headers: NO_STORE },
  );
}

export async function previewLegacyVoidCanonicalResponse(
  session: VerifiedDurableSession,
  request: Request,
  rawPatientId: string,
  rawAgreementId: string,
): Promise<NextResponse> {
  if (!/^\d+$/.test(rawPatientId) || !/^\d+$/.test(rawAgreementId)) {
    return legacyVoidRefusalResponse("bad_void_request");
  }
  const patientId = parsePositiveId(rawPatientId);
  const agreementId = parsePositiveId(rawAgreementId);
  if (!patientId || !agreementId) return legacyVoidRefusalResponse("bad_void_request");
  const modes = new URL(request.url).searchParams.getAll("mode");
  const mode = modes[0] ?? "ordinary";
  if (modes.length > 1 || !isLegacyVoidMode(mode)) return legacyVoidRefusalResponse("bad_void_request");
  try {
    const result = await runCanonicalReadSnapshot(
      session,
      "read:patients.legacy-void",
      async (query, scope) => {
        if (!(await patientVisibleInSnapshot(query, scope, patientId))) {
          return { ok: false as const, reason: "not_found" as LegacyVoidRefusal };
        }
        return getCanonicalLegacyVoidPreviewInSnapshot(query, {
          patientId,
          agreementId,
          mode,
          actor: scope.username,
          actorRole: scope.role,
        });
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    if (!result.ok) return legacyVoidRefusalResponse(result.reason);
    return NextResponse.json({ preview: result.preview }, { headers: NO_STORE });
  } catch (error) {
    return handleFinanceError(error, "تعذّر عرض أثر إبطال الاتفاق. أعد المحاولة.");
  }
}

export async function voidLegacyTreatmentCanonicalResponse(
  session: VerifiedDurableSession,
  request: Request,
  rawPatientId: string,
  rawAgreementId: string,
): Promise<NextResponse> {
  if (!/^\d+$/.test(rawPatientId) || !/^\d+$/.test(rawAgreementId)) {
    return legacyVoidRefusalResponse("bad_void_request");
  }
  const patientId = parsePositiveId(rawPatientId);
  const agreementId = parsePositiveId(rawAgreementId);
  if (!patientId || !agreementId) return legacyVoidRefusalResponse("bad_void_request");
  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return legacyVoidRefusalResponse("bad_void_request");
  }
  const parsed = parseLegacyVoidRequest(body);
  if (!parsed.ok) return legacyVoidRefusalResponse(parsed.reason);
  try {
    const result = await withStaffOperation(
      getPool(),
      session,
      "finance.legacy.void",
      async (client, handle) => {
        if (!(await patientVisibleInOperation(client, handle, "finance.legacy.void", patientId))) {
          return { ok: false as const, reason: "not_found" as LegacyVoidRefusal };
        }
        const identity = await staffOperationIdentity(client, handle, "finance.legacy.void");
        return voidCanonicalLegacyTreatmentInTx(client, {
          patientId,
          agreementId,
          ...parsed.value,
          actor: identity.username,
          actorRole: identity.role,
        });
      },
    );
    if (!result.ok) return legacyVoidRefusalResponse(result.reason);
    return NextResponse.json({ agreement: result.agreement }, { headers: NO_STORE });
  } catch (error) {
    return handleFinanceError(error, "تعذّر إبطال الاتفاق التاريخي. أعد المحاولة.");
  }
}

/* ---------------------------------------------------------------------------
 * 7. Clinic-Wide Opening Balances & Party Openings
 * ------------------------------------------------------------------------- */

export async function listOpeningBalancesCanonicalResponse(
  session: VerifiedDurableSession,
  request: Request,
): Promise<NextResponse> {
  const search = new URL(request.url).searchParams;
  if (search.get("preview") === "1") {
    const patientId = parsePositiveId(search.get("patientId") ?? "");
    const currency = search.get("currency") || CLINIC_BASE_CURRENCY;
    const clear = search.get("clear") === "1";
    const amountMinor = clear
      ? null
      : parseAmount(
          search.get("amount") ?? "",
          isCurrency(currency) ? currency : CLINIC_BASE_CURRENCY,
        );
    if (!patientId) {
      return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400, headers: NO_STORE });
    }
    if (!isCurrency(currency)) {
      return NextResponse.json({ message: "عملة الرصيد غير صالحة." }, { status: 400, headers: NO_STORE });
    }
    if (!clear && (amountMinor === null || amountMinor <= 0)) {
      return NextResponse.json(
        { message: "اكتب المبلغ المصحّح لمعاينة أثره." },
        { status: 400, headers: NO_STORE },
      );
    }
    try {
      const preview = await runCanonicalReadSnapshot(
        session,
        "finance.reconciliation.view",
        async (query, scope) => {
          if (scope.patientScope.kind === "none") {
            throw new CanonicalPatientFinanceRefusal(403, "نطاق وصولك للمرضى مغلق.");
          }
          if (!(await patientVisibleInSnapshot(query, scope, patientId))) {
            throw new CanonicalPatientFinanceRefusal(403, "غير مصرح بالوصول إلى المريض.");
          }
          return openingCorrectionPreviewInSnapshot(query, patientId, currency, clear ? null : amountMinor);
        },
        { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
      );
      return NextResponse.json({ preview }, { headers: NO_STORE });
    } catch (error) {
      return handleFinanceError(error, "تعذّرت معاينة تصحيح الرصيد الافتتاحي.");
    }
  }

  const historyFor = parsePositiveId(search.get("history") ?? "");
  if (historyFor) {
    try {
      const history = await runCanonicalReadSnapshot(
        session,
        "finance.reconciliation.view",
        async (query, scope) => {
          if (scope.patientScope.kind === "none") {
            throw new CanonicalPatientFinanceRefusal(403, "نطاق وصولك للمرضى مغلق.");
          }
          if (!(await patientVisibleInSnapshot(query, scope, historyFor))) {
            throw new CanonicalPatientFinanceRefusal(403, "غير مصرح بالوصول إلى المريض.");
          }
          return listOpeningBalanceHistoryWith(query, historyFor);
        },
        { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
      );
      return NextResponse.json({ history }, { headers: NO_STORE });
    } catch (error) {
      return handleFinanceError(error, "تعذّر تحميل سجل الرصيد الافتتاحي.");
    }
  }

  try {
    const payload = await runCanonicalReadSnapshot(
      session,
      "finance.reconciliation.view",
      async (query, scope) => {
        if (scope.patientScope.kind === "none") {
          throw new CanonicalPatientFinanceRefusal(403, "نطاق وصولك للمرضى مغلق.");
        }
        const rawBalances = await listOpeningBalancesWith(query);
        let balances = rawBalances;
        if (scope.patientScope.kind === "own") {
          const owned = await doctorOwnedPatientIdsWith(
            query,
            scope.patientScope.clinicianPartyId,
            rawBalances.map((r) => r.patientId),
          );
          balances = rawBalances.filter((r) => owned.has(r.patientId));
        }
        const totalsByCurrency: Record<string, number> = {};
        for (const row of balances) {
          totalsByCurrency[row.currency] = (totalsByCurrency[row.currency] ?? 0) + row.amountMinor;
        }
        return {
          balances,
          baseCurrency: CLINIC_BASE_CURRENCY,
          totalMinor: totalsByCurrency[CLINIC_BASE_CURRENCY] ?? 0,
          totalsByCurrency,
        };
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(payload, { headers: NO_STORE });
  } catch (error) {
    return handleFinanceError(error, "تعذّر تحميل الأرصدة الافتتاحية.");
  }
}

export async function setOpeningBalanceCanonicalResponse(
  session: VerifiedDurableSession,
  request: Request,
): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE });
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const patientId = parsePositiveId(String(source.patientId ?? ""));
  if (!patientId) {
    return NextResponse.json({ message: "اختر المريض أولًا." }, { status: 400, headers: NO_STORE });
  }
  const currency =
    source.currency === undefined || source.currency === null || source.currency === ""
      ? CLINIC_BASE_CURRENCY
      : source.currency;
  if (!isCurrency(currency)) {
    return NextResponse.json({ message: "عملة الرصيد غير صالحة." }, { status: 400, headers: NO_STORE });
  }
  const amountMinor = parseAmount(String(source.amount ?? ""), currency);
  if (amountMinor === null || amountMinor <= 0) {
    return NextResponse.json(
      { message: "اكتب المبلغ الذي كان على المريض قبل بدء النظام." },
      { status: 400, headers: NO_STORE },
    );
  }
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const asOfDate =
    typeof source.asOfDate === "string" && DATE_PATTERN.test(source.asOfDate) ? source.asOfDate : today;
  if (asOfDate > today) {
    return NextResponse.json(
      { message: "تاريخ الرصيد الافتتاحي لا يكون في المستقبل." },
      { status: 400, headers: NO_STORE },
    );
  }
  const note =
    typeof source.note === "string" && source.note.trim() ? source.note.trim().slice(0, 300) : null;
  const reason =
    typeof source.reason === "string" && source.reason.trim()
      ? source.reason.trim().slice(0, 300)
      : null;

  try {
    const balance = await withStaffOperation(
      getPool(),
      session,
      "finance.opening-balances.manage",
      async (client, handle) => {
        const patientScope = await staffOperationPatientScope(
          client,
          handle,
          "finance.opening-balances.manage",
        );
        if (patientScope.kind === "none") {
          throw new CanonicalPatientFinanceRefusal(403, "نطاق وصولك للمرضى مغلق.");
        }
        if (
          patientScope.kind === "own" &&
          !(await patientInDoctorScopeWith(client, patientScope.clinicianPartyId, patientId))
        ) {
          throw new CanonicalPatientFinanceRefusal(403, "غير مصرح بالوصول إلى المريض.");
        }
        const identity = await staffOperationIdentity(
          client,
          handle,
          "finance.opening-balances.manage",
        );
        const settings = await getSettingsInTransaction(client);
        const lockedBefore = (settings["finance.locked_before"] ?? "").trim();
        if (lockedBefore && asOfDate < lockedBefore) {
          throw new CanonicalPatientFinanceRefusal(
            409,
            "الفترة مقفلة. اختر تاريخًا بعد تاريخ الإقفال.",
          );
        }
        const before = await getPatientOpeningBalanceWith(client, patientId, currency);
        if (before && !reason) {
          throw new CanonicalPatientFinanceRefusal(
            400,
            "للمريض رصيدٌ افتتاحي مسجّل. اكتب سبب تعديله.",
          );
        }
        if (before && lockedBefore && before.asOfDate < lockedBefore) {
          throw new CanonicalPatientFinanceRefusal(
            409,
            "الرصيد الحالي في فترة مقفلة. لا يُعدَّل.",
          );
        }
        await assertOpeningCorrectionAllowedInTx(client, patientId, currency, amountMinor);
        const saved = await setPatientOpeningBalanceInTx(client, {
          patientId,
          currency,
          amountMinor,
          asOfDate,
          note,
          createdBy: identity.username,
          reason,
          addOnly: false,
          expectedBefore: before ? { amountMinor: before.amountMinor, asOfDate: before.asOfDate } : null,
        });
        if (!saved) {
          throw new CanonicalPatientFinanceRefusal(404, "المريض غير موجود.");
        }
        const current = await getPatientOpeningBalanceWith(client, saved.patientId, currency);
        if (!current) {
          throw new CanonicalPatientFinanceRefusal(404, "المريض غير موجود.");
        }
        await insertAuditRow(client, {
          action: "opening_balance.set",
          entity: "patient",
          entityId: patientId,
          entityLabel: current.patientName,
          details: {
            المبلغ: amountMinor,
            العملة: currency,
            التاريخ: asOfDate,
            ملاحظة: note,
            ...(before
              ? {
                  المبلغ_السابق: before.amountMinor,
                  التاريخ_السابق: before.asOfDate,
                  السبب: reason,
                }
              : {}),
          },
          actor: identity.username,
          actorRole: identity.role,
        });
        return current;
      },
    );
    return NextResponse.json(balance, { status: 201, headers: NO_STORE });
  } catch (error) {
    if (error instanceof OpeningBalanceExists) {
      return NextResponse.json({ message: error.message }, { status: 403, headers: NO_STORE });
    }
    if (error instanceof OpeningBalanceChanged) {
      return NextResponse.json({ message: error.message }, { status: 409, headers: NO_STORE });
    }
    if (error instanceof OpeningCorrectionRefused) {
      return NextResponse.json(
        { message: error.message, code: error.code },
        { status: 409, headers: NO_STORE },
      );
    }
    return handleFinanceError(error, "تعذّر حفظ الرصيد الافتتاحي.");
  }
}

export async function clearOpeningBalanceCanonicalResponse(
  session: VerifiedDurableSession,
  request: Request,
): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;
  const patientId = parsePositiveId(params.get("patientId") ?? "");
  if (!patientId) {
    return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400, headers: NO_STORE });
  }
  const reason = (params.get("reason") ?? "").trim().slice(0, 300);
  const currencyParam = params.get("currency") || CLINIC_BASE_CURRENCY;
  if (!isCurrency(currencyParam)) {
    return NextResponse.json({ message: "عملة الرصيد غير صالحة." }, { status: 400, headers: NO_STORE });
  }
  if (reason.length < 3) {
    return NextResponse.json(
      { message: "اكتب سبب حذف الرصيد الافتتاحي." },
      { status: 400, headers: NO_STORE },
    );
  }
  try {
    await withStaffOperation(
      getPool(),
      session,
      "finance.opening-balances.manage",
      async (client, handle) => {
        const patientScope = await staffOperationPatientScope(
          client,
          handle,
          "finance.opening-balances.manage",
        );
        if (patientScope.kind === "none") {
          throw new CanonicalPatientFinanceRefusal(403, "نطاق وصولك للمرضى مغلق.");
        }
        if (
          patientScope.kind === "own" &&
          !(await patientInDoctorScopeWith(client, patientScope.clinicianPartyId, patientId))
        ) {
          throw new CanonicalPatientFinanceRefusal(403, "غير مصرح بالوصول إلى المريض.");
        }
        const identity = await staffOperationIdentity(
          client,
          handle,
          "finance.opening-balances.manage",
        );
        const settings = await getSettingsInTransaction(client);
        const lockedBefore = (settings["finance.locked_before"] ?? "").trim();
        const existing = await getPatientOpeningBalanceWith(client, patientId, currencyParam);
        if (!existing) {
          throw new CanonicalPatientFinanceRefusal(404, "لا رصيد افتتاحي لهذا المريض.");
        }
        if (lockedBefore && existing.asOfDate < lockedBefore) {
          throw new CanonicalPatientFinanceRefusal(
            409,
            "الفترة مقفلة. لا يُحذف رصيد افتتاحي داخلها.",
          );
        }
        await assertOpeningCorrectionAllowedInTx(client, patientId, currencyParam, null);
        const cleared = await clearPatientOpeningBalanceInTx(
          client,
          patientId,
          identity.username,
          reason,
          currencyParam,
          { amountMinor: existing.amountMinor, asOfDate: existing.asOfDate },
        );
        if (!cleared) {
          throw new CanonicalPatientFinanceRefusal(404, "لا رصيد افتتاحي لهذا المريض.");
        }
        await insertAuditRow(client, {
          action: "opening_balance.clear",
          entity: "patient",
          entityId: patientId,
          entityLabel: existing.patientName,
          details: {
            المبلغ_المحذوف: existing.amountMinor,
            العملة: currencyParam,
            التاريخ: existing.asOfDate,
            السبب: reason,
          },
          actor: identity.username,
          actorRole: identity.role,
        });
      },
    );
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof OpeningBalanceChanged) {
      return NextResponse.json({ message: error.message }, { status: 409, headers: NO_STORE });
    }
    if (error instanceof OpeningCorrectionRefused) {
      return NextResponse.json(
        { message: error.message, code: error.code },
        { status: 409, headers: NO_STORE },
      );
    }
    return handleFinanceError(error, "تعذّر حذف الرصيد الافتتاحي.");
  }
}

const trimText = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

export async function listPartyOpeningsCanonicalResponse(
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  try {
    const payload = await runCanonicalReadSnapshot(
      session,
      "finance.opening-balances.manage",
      async (query, scope) => {
        const openings = await listPartyOpeningsWith(query);
        const labs = await listPartiesWith(query, "lab");
        const suppliers = await listPartiesWith(query, "supplier");
        const parties = [...labs, ...suppliers].map((party) => ({
          id: party.id,
          name: party.name,
          kind: party.kind,
        }));
        return {
          ...openings,
          parties,
          canEdit: scope.granted("finance.opening-balances.manage"),
        };
      },
      { errorPrefix: "STAFF_READ", maxBytes: SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(payload, { headers: NO_STORE });
  } catch (error) {
    return handleFinanceError(error, "تعذّر تحميل الأرصدة السابقة للجهات.");
  }
}

export async function createPartyOpeningCanonicalResponse(
  session: VerifiedDurableSession,
  request: Request,
): Promise<NextResponse> {
  let source: Record<string, unknown>;
  try {
    source = ((await readJsonBody(request, JSON_BODY_LIMIT_BYTES)) ?? {}) as Record<string, unknown>;
  } catch (error) {
    return (
      bodyErrorResponse(error) ??
      NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE })
    );
  }
  const kind = source.kind === "advance" ? "advance" : source.kind === "payable" ? "payable" : null;
  if (!kind) {
    return NextResponse.json(
      { message: "حدّد النوع: دَينٌ علينا أم رصيدٌ مقدَّم لنا." },
      { status: 400, headers: NO_STORE },
    );
  }
  const partyId = parsePositiveId(String(source.partyId ?? ""));
  if (!partyId) {
    return NextResponse.json({ message: "اختر المختبر أو المورّد." }, { status: 400, headers: NO_STORE });
  }
  const currency =
    source.currency === undefined || source.currency === "" ? CLINIC_BASE_CURRENCY : source.currency;
  if (!isCurrency(currency)) {
    return NextResponse.json(
      { message: "العملة يجب أن تكون YER أو SAR أو USD." },
      { status: 400, headers: NO_STORE },
    );
  }
  const amountMinor = parseAmount(String(source.amount ?? ""), currency);
  if (amountMinor === null || amountMinor <= 0) {
    return NextResponse.json(
      { message: "اكتب المبلغ السابق بعملته — أكبر من صفر." },
      { status: 400, headers: NO_STORE },
    );
  }
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const asOfDate =
    typeof source.asOfDate === "string" && DATE_PATTERN.test(source.asOfDate) ? source.asOfDate : null;
  if (!asOfDate) {
    return NextResponse.json(
      { message: "اكتب تاريخ الرصيد (حتى تاريخ)." },
      { status: 400, headers: NO_STORE },
    );
  }
  if (asOfDate > today) {
    return NextResponse.json(
      { message: "تاريخ الرصيد السابق لا يكون في المستقبل." },
      { status: 400, headers: NO_STORE },
    );
  }
  const dueDate =
    typeof source.dueDate === "string" && DATE_PATTERN.test(source.dueDate) ? source.dueDate : null;
  const reason = trimText(source.reason, 300);
  if (!reason || reason.length < 3) {
    return NextResponse.json(
      { message: "اكتب سبب الإدخال — مثل: كشف حساب ورقي قبل بدء النظام." },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    const result = await withStaffOperation(
      getPool(),
      session,
      "finance.opening-balances.manage",
      async (client, handle) => {
        const identity = await staffOperationIdentity(
          client,
          handle,
          "finance.opening-balances.manage",
        );
        const settings = await getSettingsInTransaction(client);
        const lockedBefore = (settings["finance.locked_before"] ?? "").trim();
        if (lockedBefore && asOfDate < lockedBefore) {
          return {
            ok: false as const,
            status: 409 as const,
            message: "الفترة مقفلة. اختر تاريخًا بعد تاريخ الإقفال.",
          };
        }
        const exchangeRate = rateFromSettings(settings, currency, CLINIC_BASE_CURRENCY);
        if (exchangeRate === null) {
          return {
            ok: false as const,
            status: 409 as const,
            message: "سعر الصرف غير مضبوط. اضبطه في الإعدادات أولًا.",
          };
        }
        const common = {
          partyId,
          currency,
          amountMinor,
          exchangeRate,
          asOfDate,
          reference: trimText(source.reference, 120),
          note: trimText(source.note, 300),
          reason,
          actor: identity.username,
          actorRole: identity.role,
        };
        return kind === "payable"
          ? createPartyOpeningPayableInTx(client, { ...common, dueDate })
          : createPartyOpeningAdvanceInTx(client, common);
      },
    );
    if (!result.ok) {
      return NextResponse.json({ message: result.message }, { status: result.status, headers: NO_STORE });
    }
    return NextResponse.json(result.value, { status: 201, headers: NO_STORE });
  } catch (error) {
    return handleFinanceError(error, "تعذّر حفظ الرصيد السابق.");
  }
}

export async function updatePartyOpeningCanonicalResponse(
  session: VerifiedDurableSession,
  request: Request,
): Promise<NextResponse> {
  let source: Record<string, unknown>;
  try {
    source = ((await readJsonBody(request, JSON_BODY_LIMIT_BYTES)) ?? {}) as Record<string, unknown>;
  } catch (error) {
    return (
      bodyErrorResponse(error) ??
      NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE })
    );
  }
  const reason = trimText(source.reason, 300);
  if (!reason || reason.length < 3) {
    return NextResponse.json(
      { message: "اكتب سبب التصحيح — يبقى في السجل مع القيمتين." },
      { status: 400, headers: NO_STORE },
    );
  }
  if (source.action === "adjust") {
    const payableId = parsePositiveId(String(source.payableId ?? ""));
    if (!payableId) {
      return NextResponse.json(
        { message: "الرصيد الافتتاحي غير محدد." },
        { status: 400, headers: NO_STORE },
      );
    }
    if (source.currency !== undefined && !isCurrency(source.currency)) {
      return NextResponse.json(
        { message: "العملة يجب أن تكون YER أو SAR أو USD." },
        { status: 400, headers: NO_STORE },
      );
    }
    const expectedCurrency = source.currency;
    try {
      const result = await withStaffOperation(
        getPool(),
        session,
        "finance.opening-balances.manage",
        async (client, handle) => {
          const identity = await staffOperationIdentity(
            client,
            handle,
            "finance.opening-balances.manage",
          );
          return adjustPartyOpeningPayableInTx(client, {
            payableId,
            amount: String(source.amount ?? ""),
            expectedCurrency,
            reason,
            actor: identity.username,
            actorRole: identity.role,
          });
        },
      );
      if (!result.ok) {
        return NextResponse.json({ message: result.message }, { status: result.status, headers: NO_STORE });
      }
      return NextResponse.json(result.value, { headers: NO_STORE });
    } catch (error) {
      return handleFinanceError(error, "تعذّر حفظ التصحيح.");
    }
  }
  if (source.action === "void_advance") {
    const id = parsePositiveId(String(source.id ?? ""));
    if (!id) {
      return NextResponse.json(
        { message: "الرصيد المقدَّم غير محدد." },
        { status: 400, headers: NO_STORE },
      );
    }
    try {
      const result = await withStaffOperation(
        getPool(),
        session,
        "finance.opening-balances.manage",
        async (client, handle) => {
          const identity = await staffOperationIdentity(
            client,
            handle,
            "finance.opening-balances.manage",
          );
          return voidPartyOpeningAdvanceInTx(client, {
            id,
            reason,
            actor: identity.username,
            actorRole: identity.role,
          });
        },
      );
      if (!result.ok) {
        return NextResponse.json({ message: result.message }, { status: result.status, headers: NO_STORE });
      }
      return NextResponse.json(result.value, { headers: NO_STORE });
    } catch (error) {
      return handleFinanceError(error, "تعذّر حفظ التصحيح.");
    }
  }
  return NextResponse.json({ message: "إجراءٌ غير معروف." }, { status: 400, headers: NO_STORE });
}
