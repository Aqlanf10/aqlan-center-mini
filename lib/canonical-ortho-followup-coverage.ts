import "server-only";
import { getPool, insertAuditRow, patientInDoctorScopeWith, type DbPool } from "./db";
import { parseFollowupCoverageCommand, type FollowupCoverageRead } from "./ortho-followup-coverage";
import {
  followupCoverageAvailable,
  FollowupCoverageError,
  orthoFollowupCoverageInternal,
  type FollowupCoverageRejection,
  type OrthoFollowupStoredRejection,
  type OrthoFollowupStoredRow,
} from "./ortho-followup-coverage-db";
import { runCanonicalReadSnapshot } from "./canonical-read-snapshot";
import { staffAdmissionRefusal } from "./staff-capability-editor";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { staffOperationIdentity, staffOperationPatientScope, withStaffOperation } from "./staff-operation-runtime";

const fail: (status: number, code: string, message: string) => never = orthoFollowupCoverageInternal.fail;
const {
  positive,
  sourceRows,
  currentHead,
  project,
  projectRejection,
  sourceOf,
  matches,
  choice,
  hash,
  owner,
  lockSource,
  terminalReceipt,
  columns,
} = orthoFollowupCoverageInternal;

function rethrowCanonicalCoverageError(error: unknown): never {
  if (error instanceof FollowupCoverageError) throw error;
  const refusal = staffAdmissionRefusal(error);
  if (refusal) {
    const message = /RECORD_SCOPE_DENIED$/.test(refusal.code) ? "لا تملك صلاحية عرض ملفات المرضى." : refusal.message;
    throw new FollowupCoverageError(refusal.status, refusal.code, message);
  }
  throw error;
}

export async function readCanonicalFollowupCoverage(
  session: VerifiedDurableSession,
  patientId: number,
  orthoCaseId: number,
): Promise<FollowupCoverageRead> {
  if (!positive(patientId) || !positive(orthoCaseId)) fail(400, "invalid_scope", "معرف الحالة غير صالح.");
  try {
    return await runCanonicalReadSnapshot(session, "read:ortho.followup-coverage", async (db, snapshotScope) => {
      if (snapshotScope.patientScope.kind === "own" && !(await patientInDoctorScopeWith(db, snapshotScope.patientScope.clinicianPartyId, patientId))) {
        fail(404, "case_missing", "الحالة غير موجودة.");
      }
      const found = (await db.query<{ id: number; status: string }>("SELECT id,status FROM ortho_cases WHERE id=$1 AND patient_id=$2", [orthoCaseId, patientId])).rows;
      if (!found.length) fail(404, "case_missing", "الحالة غير موجودة.");
      const enabled = await followupCoverageAvailable(db);
      const head = enabled ? await currentHead(db, orthoCaseId) : null;
      const sources = await sourceRows(db, patientId, orthoCaseId);
      return {
        patientId,
        orthoCaseId,
        enabled,
        canEdit: enabled && snapshotScope.granted("finance.agreements.manage") && ["active", "retention"].includes(found[0].status),
        current: head ? project(head) : null,
        applicable: !!head && sources.some(r => r.valid && matches(r, sourceOf(head)) && hash(r.snapshot) === head.source_fingerprint),
        sources: sources.filter(r => r.valid).map(choice),
      };
    }, { errorPrefix: "STAFF_READ", maxBytes: 1024 * 1024 });
  } catch (error) {
    rethrowCanonicalCoverageError(error);
  }
}

export async function readCanonicalFollowupCoverageCommandStatus(
  session: VerifiedDurableSession,
  patientId: number,
  orthoCaseId: number,
  rawCommand: unknown,
  pool: DbPool = getPool(),
) {
  if (!positive(patientId) || !positive(orthoCaseId)) fail(400, "invalid_scope", "معرف الحالة غير صالح.");
  try {
    return await withStaffOperation(pool, session, "finance.agreements.manage", async (client, handle) => {
      const command = parseFollowupCoverageCommand(rawCommand);
      if (!command || command.source.patientId !== patientId || command.source.orthoCaseId !== orthoCaseId) {
        fail(400, "invalid_command", "طلب نطاق التغطية غير صالح.");
      }
      const current = (await client.query<{ patient_id: number }>("SELECT patient_id FROM ortho_cases WHERE id=$1", [orthoCaseId])).rows[0];
      const patientScope = await staffOperationPatientScope(client, handle, "finance.agreements.manage");
      if (patientScope.kind === "none") fail(403, "coverage_forbidden", "لا تملك صلاحية ملف المالك الحالي للحالة.");
      if (!current) fail(404, "case_missing", "حالة التقويم غير موجودة.");
      if (patientScope.kind === "own" && !(await patientInDoctorScopeWith(client, patientScope.clinicianPartyId, current.patient_id))) {
        fail(404, "case_missing", "حالة التقويم غير موجودة.");
      }
      if (!(await followupCoverageAvailable(client))) fail(503, "coverage_not_ready", "سجل نطاق المتابعات غير جاهز للتحقق.");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["ortho-followup-command:" + command.commandId]);
      await owner(client, current.patient_id, orthoCaseId, false);
      const identity = await staffOperationIdentity(client, handle, "finance.agreements.manage");
      const fingerprint = hash({ patientId, orthoCaseId, actorUserId: identity.userId, command });
      return terminalReceipt(client, command, fingerprint);
    });
  } catch (error) {
    rethrowCanonicalCoverageError(error);
  }
}

export async function appendCanonicalFollowupCoverage(
  session: VerifiedDurableSession,
  patientId: number,
  orthoCaseId: number,
  rawCommand: unknown,
  pool: DbPool = getPool(),
) {
  if (!positive(patientId) || !positive(orthoCaseId)) fail(400, "invalid_scope", "معرف الحالة غير صالح.");
  try {
    const outcome = await withStaffOperation(pool, session, "finance.agreements.manage", async (client, handle) => {
      const command = parseFollowupCoverageCommand(rawCommand);
      if (!command || command.source.patientId !== patientId || command.source.orthoCaseId !== orthoCaseId) {
        fail(400, "invalid_command", "طلب نطاق التغطية غير صالح.");
      }
      const current = (await client.query<{ patient_id: number }>("SELECT patient_id FROM ortho_cases WHERE id=$1", [orthoCaseId])).rows[0];
      const preScope = await staffOperationPatientScope(client, handle, "finance.agreements.manage");
      if (preScope.kind === "none") fail(403, "coverage_forbidden", "لا تملك صلاحية ملف المالك الحالي للحالة.");
      if (!current) fail(404, "case_missing", "حالة التقويم غير موجودة.");
      if (preScope.kind === "own" && !(await patientInDoctorScopeWith(client, preScope.clinicianPartyId, current.patient_id))) {
        fail(404, "case_missing", "حالة التقويم غير موجودة.");
      }
      if (!(await followupCoverageAvailable(client))) fail(503, "coverage_not_ready", "تسجيل نطاق المتابعات لم يُفعّل بعد؛ لا تغيّر الاتفاق أو تنشئ فاتورة بديلة.");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["ortho-followup-command:" + command.commandId]);
      const caseStatus = await owner(client, current.patient_id, orthoCaseId, true);
      const identity = await staffOperationIdentity(client, handle, "finance.agreements.manage");
      const postScope = await staffOperationPatientScope(client, handle, "finance.agreements.manage");
      if (postScope.kind === "none") fail(403, "coverage_forbidden", "لا تملك صلاحية ملف المالك الحالي للحالة.");
      if (postScope.kind === "own" && !(await patientInDoctorScopeWith(client, postScope.clinicianPartyId, current.patient_id))) {
        fail(404, "case_missing", "حالة التقويم غير موجودة.");
      }
      const requestFingerprint = hash({ patientId, orthoCaseId, actorUserId: identity.userId, command });
      const replay = await terminalReceipt(client, command, requestFingerprint);
      if (replay.state === "rejected") {
        return { committed: false as const, code: replay.rejection.code, message: replay.rejection.message, rejection: replay.rejection };
      }
      if (replay.state === "committed") {
        return { committed: true as const, replayed: true, revision: replay.revision };
      }
      const reject = async (code: FollowupCoverageRejection["code"], message: string) => {
        const row = (await client.query<OrthoFollowupStoredRejection>(
          `INSERT INTO ortho_followup_coverage_rejections
           (command_id,request_fingerprint,patient_id,ortho_case_id,actor_user_id,command,code,message,actor)
           VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) RETURNING *`,
          [command.commandId, requestFingerprint, patientId, orthoCaseId, identity.userId, JSON.stringify(command), code, message, identity.username],
        )).rows[0];
        await insertAuditRow(client, {
          action: "ortho.followup_coverage.append",
          entity: "ortho_case",
          entityId: orthoCaseId,
          actor: identity.username,
          actorRole: identity.role,
          details: { outcome: "rejected", commandId: command.commandId, patientId, code, requestFingerprint },
        });
        return { committed: false as const, code, message, rejection: projectRejection(row) };
      };
      if (current.patient_id !== patientId) return reject("source_changed", "تغيّر مالك الحالة؛ راجع الربط قبل اعتماد قرار جديد.");
      if (!["active", "retention"].includes(caseStatus)) return reject("case_closed", "الحالة مغلقة؛ لا يتغير نطاق المتابعات الجديدة لها.");
      const head = await currentHead(client, orthoCaseId);
      if ((head ? String(head.id) : null) !== command.expectedRevisionId) {
        return reject("stale_coverage", "تغيّر نطاق المتابعات منذ فتح الشاشة؛ أعد التحميل وراجع القرار.");
      }
      await lockSource(client, command.source);
      const source = (await sourceRows(client, patientId, orthoCaseId)).find(r => matches(r, command.source));
      if (!source?.valid || hash(source.snapshot) !== command.expectedSourceFingerprint) {
        return reject("source_changed", "تغيّر مصدر الاتفاق أو لم تعد هويته مثبتة؛ راجع الفاتورة والربط قبل الاعتماد.");
      }
      const { rows: [saved] } = await client.query<OrthoFollowupStoredRow>(
        `INSERT INTO ortho_followup_coverage_revisions
         (patient_id,ortho_case_id,clinical_case_id,plan_id,plan_item_id,invoice_id,version,supersedes_revision_id,scope,decision,source_fingerprint,source_snapshot,reason,actor_user_id,created_by,command_id,request_fingerprint)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,'routine_adjustments',$9,$10,$11::jsonb,$12,$13,$14,$15,$16) RETURNING ${columns}`,
        [
          patientId, orthoCaseId, source.clinicalCaseId, source.planId, source.planItemId, source.invoiceId,
          (head?.version ?? 0) + 1, head?.id ?? null, command.decision, command.expectedSourceFingerprint,
          JSON.stringify(source.snapshot), command.reason, identity.userId, identity.username, command.commandId, requestFingerprint,
        ],
      );
      await insertAuditRow(client, {
        action: "ortho.followup_coverage.append",
        entity: "ortho_case",
        entityId: orthoCaseId,
        actor: identity.username,
        actorRole: identity.role,
        details: { before: head ? project(head) : null, after: project(saved), scope: "routine_adjustments", reason: command.reason },
      });
      return { committed: true as const, replayed: false, revision: project(saved) };
    });
    if (!outcome.committed) throw new FollowupCoverageError(409, outcome.code, outcome.message, outcome.rejection);
    return { ok: true as const, replayed: outcome.replayed, revision: outcome.revision };
  } catch (error) {
    rethrowCanonicalCoverageError(error);
  }
}
