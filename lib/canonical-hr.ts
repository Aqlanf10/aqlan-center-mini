import "server-only";
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { canonicalPatientReadFailure, NO_STORE } from "./canonical-patient-http";
import { runCanonicalReadSnapshot } from "./canonical-read-snapshot";
import { CLINIC_ZONE_FALLBACK, resolveClinicZone } from "./clinicZone";
import { getPool, type DbClient } from "./db";
import {
  cleanDate,
  cleanJobTitle,
  cleanOptionalText,
  createStaffInTx,
  getStaffDetailWith,
  isHrContractKind,
  isHrDepartment,
  isHrWorkStatus,
  listStaffDirectoryWith,
  listStaffWith,
  setStaffUserLinkInTx,
  updateStaffInTx,
  validatePayTermsInput,
  type CreateStaffInput,
  type UpdateStaffPatch,
} from "./hr";
import {
  adjustLeaveBalanceInTx,
  approveContractInTx,
  createContractAddendumInTx,
  createContractInTx,
  createLeaveRequestInTx,
  createWorkScheduleInTx,
  decideAttendanceCorrectionInTx,
  decideLeaveRequestInTx,
  getContractByIdWith,
  getWorkScheduleByIdWith,
  HrContractMutationError,
  HrWorkforceMutationError,
  leaveStaffOptionsWith,
  listAttendanceCorrectionsWith,
  listAttendanceRecordsWith,
  listContractAddendaWith,
  listContractsWith,
  listLeaveBalancesWith,
  listLeaveRequestsWith,
  listLeaveTypesWith,
  listWorkSchedulesWith,
  recordAttendancePunchInTx,
  requestAttendanceCorrectionInTx,
  transitionContractStatusInTx,
  updateContractInTx,
  updateWorkScheduleInTx,
  type AttendancePunchInput,
  type CreateAddendumInput,
  type CreateContractInput,
  type CreateLeaveRequestInput,
  type CreateScheduleInput,
  type RequestCorrectionInput,
  type UpdateContractInput,
  type UpdateScheduleInput,
} from "./hr-contracts-attendance";
import type {
  HrAttendanceStatus,
  HrContractStatus,
  HrContractTemplateKind,
  HrLeaveRequestStatus,
} from "./hr-contracts-attendance-shared";
import {
  buildIdentityPreview,
  IdentityPreviewError,
  parseIdentityPreviewRequest,
} from "./hr-identity-preview";
import { readHrIdentitySources } from "./hr-identity-sources";
import {
  approvePayrollRunInTx,
  calculatePayrollRunInTx,
  closePayrollPeriodInTx,
  disburseEntireRunInTx,
  disbursePayrollItemInTx,
  findDisbursementByRequestId,
  getHrReportSummaryWith,
  getHrSettings,
  getOrCreatePayrollPeriodInTx,
  getPayrollRunByIdWith,
  HrPayrollError,
  listPayrollItemsWith,
  listPayrollPeriodsWith,
  listPayrollRunsWith,
  reversePayrollDisbursementInTx,
  updateHrSettingsInTx,
  type DisburseInput,
} from "./hr-payroll";
import type { HrCurrency, HrSettings } from "./hr-payroll-shared";
import { readHrPayrollHistoryInSnapshot } from "./hr-payroll-temporal-read";
import { getMyHrSummaryWith } from "./hr-self-service";
import { HrTemporalError } from "./hr-temporal";
import { canonicalHrTemporalAuthority } from "./hr-temporal-authority";
import { readHrPolicyHistories, readHrRecordedHistoryInSnapshot } from "./hr-temporal-read";
import {
  HrHistoryError,
  HrHistoryWriteRefusal,
  parseHrHistoryCommand,
  type HrHistoryKind,
} from "./hr-temporal-request";
import { recordHrHistoryInTransaction } from "./hr-temporal-write";
import { bodyErrorResponse, readJsonBody } from "./http-body";
import { IDEMPOTENCY_KEY_PATTERN } from "./idempotency-key";
import { clinicDateString } from "./schedule";
import { JSON_BODY_LIMIT_BYTES } from "./security-limits";
import { staffAdmissionRefusal } from "./staff-capability-editor";
import type { StaffCapability } from "./staff-capability-catalogue";
import type { VerifiedDurableSession } from "./staff-durable-session";
import {
  staffOperationCapabilities,
  staffOperationIdentity,
  staffOperationOtherAccountHoldsCapability,
  staffOperationOwnerOperations,
  withStaffOperation,
  type StaffOperationHandle,
  type StaffRuntimeAction,
} from "./staff-operation-runtime";
import { withCanonicalSelfSession } from "./staff-session-admission";

/**
 * Canonical HR Routes (M2 Slice 38 — 23 route files / 43 HTTP methods).
 *
 * Architectural invariants:
 * - Zero legacy role checks (`role === "admin"`, `canManageStaff`, `canAssignTasks`).
 * - Every read executes inside `runCanonicalReadSnapshot` (`REPEATABLE READ READ ONLY`
 *   under the shared lifecycle fence) or `withCanonicalSelfSession` for `/api/hr/me`.
 * - Every mutation executes inside `withStaffOperation` (`READ COMMITTED` under the
 *   shared lifecycle fence + live authority proof before and after domain work).
 * - Owner-only contract/payroll approvals use `staffOperationOwnerOperations`; dual-control
 *   vs sole-owner separation-of-duties uses `staffOperationOtherAccountHoldsCapability`.
 * - `hrIdentityPreviewPostCanonicalResponse` (`POST /api/hr/identity-preview`) is `AUDIT_EXEMPT`
 *   and never statically or dynamically reaches any audit writer.
 */

const HR_SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;
const currentClinicYear = () =>
  Number(clinicDateString(new Date(), resolveClinicZone(process.env.CLINIC_TIME_ZONE)).slice(0, 4));

class CanonicalHrRefusal extends Error {
  readonly code: string;
  readonly explicitCode: boolean;
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 500 | 503,
    message: string,
    code?: string,
  ) {
    super(message);
    this.name = "CanonicalHrRefusal";
    this.explicitCode = typeof code === "string" && code.length > 0;
    this.code =
      code && /^[a-z][a-z_]*$/.test(code)
        ? code
        : status === 404
          ? "not_found"
          : status === 409
            ? "conflict"
            : status === 403
              ? "forbidden"
              : status === 503
                ? "unavailable"
                : "invalid_input";
  }
}

function hrCanonCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(hrCanonCanonicalJson).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${hrCanonCanonicalJson((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(",")}}`;
}

type HrTxIdempotentOutcome = {
  status: number;
  body: unknown;
  replay?: boolean;
};

async function withHrCanonicalIdempotencyInTx(
  client: DbClient,
  request: Request,
  scope: string,
  actor: string,
  rawPayload: unknown,
  execute: () => Promise<HrTxIdempotentOutcome>,
): Promise<HrTxIdempotentOutcome> {
  const rawHeader = request.headers.get("idempotency-key");
  const key = rawHeader?.trim() ?? "";
  if (!key) {
    return execute();
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    return {
      status: 400,
      body: {
        reason: "invalid_idempotency_key",
        message: "صيغة مفتاح منع التكرار (Idempotency-Key) غير صالحة.",
      },
    };
  }

  const requestHash = createHash("sha256").update(hrCanonCanonicalJson(rawPayload)).digest("hex");
  const existing = await client.query<{
    request_hash: string;
    state: string;
    status_code: number | null;
    response_body: unknown;
    age_ms: number;
  }>(
    `SELECT request_hash, state, status_code, response_body,
            EXTRACT(EPOCH FROM (NOW() - created_at)) * 1000 AS age_ms
       FROM http_idempotency_keys
      WHERE scope = $1 AND actor = $2 AND idempotency_key = $3
      FOR UPDATE`,
    [scope, actor, key],
  );
  const row = existing.rows[0];
  if (row) {
    if (row.request_hash !== requestHash) {
      return {
        status: 409,
        body: { reason: "idempotency_conflict", message: "مفتاح الإعادة مستعمل بعملية مختلفة." },
      };
    }
    if (row.state === "completed") {
      return {
        status: row.status_code ?? 200,
        body: row.response_body,
        replay: true,
      };
    }
    if (Number(row.age_ms ?? 0) < 60_000) {
      return {
        status: 409,
        body: { reason: "idempotency_in_progress", message: "الطلب الأول لا يزال قيد المعالجة." },
      };
    }
  }

  await client.query("SAVEPOINT canonical_hr_http_idempotency_tx");
  try {
    const result = await execute();
    if (result.status >= 200 && result.status < 300) {
      await client.query(
        `INSERT INTO http_idempotency_keys
           (scope, actor, idempotency_key, request_hash, state, status_code, response_body, completed_at)
         VALUES ($1, $2, $3, $4, 'completed', $5, $6::jsonb, NOW())
         ON CONFLICT (scope, actor, idempotency_key) DO UPDATE
            SET state = 'completed',
                status_code = EXCLUDED.status_code,
                response_body = EXCLUDED.response_body,
                completed_at = NOW()`,
        [scope, actor, key, requestHash, result.status, JSON.stringify(result.body ?? null)],
      );
      await client.query("RELEASE SAVEPOINT canonical_hr_http_idempotency_tx");
      return result;
    }
    await client.query("ROLLBACK TO SAVEPOINT canonical_hr_http_idempotency_tx");
    await client.query("RELEASE SAVEPOINT canonical_hr_http_idempotency_tx");
    if (row && row.state === "in_progress") {
      await client.query(
        `DELETE FROM http_idempotency_keys
          WHERE scope = $1 AND actor = $2 AND idempotency_key = $3 AND state = 'in_progress'`,
        [scope, actor, key],
      );
    }
    return result;
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT canonical_hr_http_idempotency_tx").catch(() => {});
    await client.query("RELEASE SAVEPOINT canonical_hr_http_idempotency_tx").catch(() => {});
    throw error;
  }
}

/** Audit-free error mapper safe for both read routes and `AUDIT_EXEMPT` routes. */
function hrCanonReadErrorResponse(error: unknown, fallbackMessage: string): NextResponse {
  const bounded = bodyErrorResponse(error);
  if (bounded) return bounded;
  if (error instanceof CanonicalHrRefusal) {
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

function hrCanonTemporalErrorResponse(error: unknown): NextResponse {
  const refusal = staffAdmissionRefusal(error);
  if (refusal) {
    return NextResponse.json(
      { code: refusal.code, message: refusal.message },
      { status: refusal.status, headers: NO_STORE },
    );
  }
  if (error instanceof HrHistoryError) {
    return NextResponse.json(
      {
        code: error.code,
        message: error.message,
        ...(error instanceof HrHistoryWriteRefusal ? { refusal: error.refusal } : {}),
      },
      { status: error.status, headers: NO_STORE },
    );
  }
  if (error instanceof HrTemporalError) {
    return NextResponse.json(
      {
        code: error.code,
        message:
          error.code === "stale_revision"
            ? "تغيّرت المراجعة؛ أعد التحميل وراجع التصحيح دون الكتابة فوقها."
            : `الفترة أو الجدول يحتاج تصحيحًا (${error.code}).`,
      },
      { status: error.code === "stale_revision" ? 409 : 400, headers: NO_STORE },
    );
  }
  const bounded = bodyErrorResponse(error);
  if (bounded) return bounded;
  if (error instanceof Error && /^STAFF_READ_/.test(error.message)) {
    return canonicalPatientReadFailure(error, "تعذّر تأكيد قراءة السجل.");
  }
  return NextResponse.json(
    {
      code: "outcome_unconfirmed",
      message: "تعذّر تأكيد النتيجة. احتفظ بمفتاح الطلب ومحتواه وأعد الطلب نفسه للتحقق.",
    },
    { status: 500, headers: NO_STORE },
  );
}

function hrCanonDomainWriteErrorResponse(
  error: unknown,
  fallbackMessage: string,
  defaultDomainStatus: 400 | 500 = 400,
): NextResponse {
  const bounded = bodyErrorResponse(error);
  if (bounded) return bounded;
  const refusal = staffAdmissionRefusal(error);
  if (refusal) {
    return NextResponse.json(
      { code: refusal.code, message: refusal.message },
      { status: refusal.status, headers: NO_STORE },
    );
  }
  if (error instanceof CanonicalHrRefusal) {
    return NextResponse.json(
      error.explicitCode ? { code: error.code, message: error.message } : { message: error.message },
      { status: error.status, headers: NO_STORE },
    );
  }
  if (error instanceof HrPayrollError) {
    return NextResponse.json(
      { message: error.message, code: error.code },
      { status: error.status, headers: NO_STORE },
    );
  }
  if (
    error instanceof HrContractMutationError ||
    error instanceof HrWorkforceMutationError ||
    error instanceof IdentityPreviewError
  ) {
    return NextResponse.json(
      { message: error.message },
      { status: error.status, headers: NO_STORE },
    );
  }
  if (defaultDomainStatus === 400 && error instanceof Error && error.message) {
    if (/^لا يجوز اعتماد .*ذاتيًا\.$/.test(error.message)) {
      return NextResponse.json({ message: error.message }, { status: 403, headers: NO_STORE });
    }
    return NextResponse.json({ message: error.message }, { status: 400, headers: NO_STORE });
  }
  return NextResponse.json({ message: fallbackMessage }, { status: 500, headers: NO_STORE });
}

async function resolveCanonSoleOwnerForCapability(
  client: DbClient,
  handle: StaffOperationHandle,
  action: StaffRuntimeAction,
  capability: StaffCapability,
): Promise<boolean> {
  const ownerOps = await staffOperationOwnerOperations(client, handle, action, [
    "settings.security.change",
  ]);
  if (!ownerOps.has("settings.security.change")) return false;
  const otherHasCapability = await staffOperationOtherAccountHoldsCapability(
    client,
    handle,
    action,
    capability,
  );
  return !otherHasCapability;
}

/* ============================================================================
 * 1. /api/hr/me (GET — self)
 * ============================================================================ */

export async function hrMeGetCanonicalResponse(
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  try {
    const result = await withCanonicalSelfSession(session, (client, view) =>
      getMyHrSummaryWith(client, view.userId),
    );
    if (!result.ok) {
      return NextResponse.json(
        { message: "انتهت الجلسة. سجّل الدخول من جديد." },
        { status: 401, headers: NO_STORE },
      );
    }
    return NextResponse.json(result.value, { headers: NO_STORE });
  } catch {
    return NextResponse.json(
      { message: "تعذّر تحميل بيانات البوابة الذاتية." },
      { status: 500, headers: NO_STORE },
    );
  }
}

/* ============================================================================
 * 2. /api/hr/directory (GET — hr.directory.view)
 * ============================================================================ */

export async function hrDirectoryGetCanonicalResponse(
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  try {
    const staff = await runCanonicalReadSnapshot(
      session,
      "hr.directory.view",
      (query) => listStaffDirectoryWith(query),
      { errorPrefix: "STAFF_READ", maxBytes: HR_SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(staff, { headers: NO_STORE });
  } catch (error) {
    return hrCanonReadErrorResponse(error, "تعذّر تحميل دليل الموظفين.");
  }
}

/* ============================================================================
 * 3. /api/hr/identity-preview (GET & POST — hr.staff.manage, POST is AUDIT_EXEMPT)
 * ============================================================================ */

export async function hrIdentityPreviewGetCanonicalResponse(
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  try {
    const outcome = await runCanonicalReadSnapshot(
      session,
      "hr.staff.manage",
      async (query) => {
        try {
          const sources = await readHrIdentitySources(query);
          return { ok: true as const, preview: buildIdentityPreview(sources) };
        } catch (err) {
          if (err instanceof IdentityPreviewError) {
            return { ok: false as const, status: err.status, message: err.message };
          }
          throw err;
        }
      },
      { errorPrefix: "STAFF_READ", maxBytes: HR_SNAPSHOT_MAX_BYTES },
    );
    if (!outcome.ok) {
      return NextResponse.json(
        { message: outcome.message },
        { status: outcome.status, headers: NO_STORE },
      );
    }
    return NextResponse.json(outcome.preview, { headers: NO_STORE });
  } catch (error) {
    return hrCanonReadErrorResponse(
      error,
      "تعذّر إنشاء معاينة الهوية؛ لم يُكتب أي تعديل على قاعدة البيانات.",
    );
  }
}

export async function hrIdentityPreviewPostCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    return (
      bodyErrorResponse(error) ??
      NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE })
    );
  }

  try {
    const outcome = await runCanonicalReadSnapshot(
      session,
      "hr.staff.manage",
      async (query) => {
        try {
          const sources = await readHrIdentitySources(query);
          const initial = buildIdentityPreview(sources);
          const parsed = parseIdentityPreviewRequest(body);
          if (parsed.sourceDigest !== initial.sourceDigest) {
            return {
              ok: false as const,
              status: 409,
              message: "تغيّرت المصادر؛ حدّث المعاينة وراجع المعرفات مجددًا.",
            };
          }
          return { ok: true as const, preview: buildIdentityPreview(sources, parsed.decisions) };
        } catch (err) {
          if (err instanceof IdentityPreviewError) {
            return { ok: false as const, status: err.status, message: err.message };
          }
          throw err;
        }
      },
      { errorPrefix: "STAFF_READ", maxBytes: HR_SNAPSHOT_MAX_BYTES },
    );
    if (!outcome.ok) {
      return NextResponse.json(
        { message: outcome.message },
        { status: outcome.status, headers: NO_STORE },
      );
    }
    return NextResponse.json(outcome.preview, { headers: NO_STORE });
  } catch (error) {
    return hrCanonReadErrorResponse(
      error,
      "تعذّر إنشاء معاينة الهوية؛ لم يُكتب أي تعديل على قاعدة البيانات.",
    );
  }
}

/* ============================================================================
 * 4. /api/hr/staff (GET & POST — hr.staff.manage)
 * ============================================================================ */

export async function hrStaffGetCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const url = new URL(request.url);
  const department = url.searchParams.get("department");
  const status = url.searchParams.get("status");
  const search = url.searchParams.get("q");

  try {
    const staff = await runCanonicalReadSnapshot(
      session,
      "hr.staff.manage",
      (query) =>
        listStaffWith(query, {
          department: department && isHrDepartment(department) ? department : null,
          status:
            status && ["active", "suspended", "ended"].includes(status)
              ? (status as "active" | "suspended" | "ended")
              : null,
          search: search ? search.slice(0, 120) : null,
          includePayTerms: true,
        }),
      { errorPrefix: "STAFF_READ", maxBytes: HR_SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(staff, { headers: NO_STORE });
  } catch (error) {
    return hrCanonReadErrorResponse(error, "تعذّر تحميل الطاقم.");
  }
}

export async function hrStaffPostCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    return (
      bodyErrorResponse(error) ??
      NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE })
    );
  }

  const source = (body ?? {}) as Record<string, unknown>;
  const fullName = typeof source.fullName === "string" ? source.fullName.trim() : "";
  if (fullName.length < 2 || fullName.length > 120) {
    return NextResponse.json(
      { message: "اكتب اسم الموظف الكامل (من حرفين إلى 120)." },
      { status: 400, headers: NO_STORE },
    );
  }
  const jobTitle = cleanOptionalText(source.jobTitle, 80);
  if (jobTitle === undefined) {
    return NextResponse.json(
      { message: "المسمى الوظيفي نصٌّ حتى 80 حرفًا." },
      { status: 400, headers: NO_STORE },
    );
  }
  if (!isHrDepartment(source.department)) {
    return NextResponse.json(
      { message: "اختر قسم الموظف." },
      { status: 400, headers: NO_STORE },
    );
  }
  const hireDate = cleanDate(source.hireDate);
  if (hireDate === undefined) {
    return NextResponse.json(
      { message: "تاريخ الالتحاق بصيغة YYYY-MM-DD." },
      { status: 400, headers: NO_STORE },
    );
  }
  const workStatus = isHrWorkStatus(source.workStatus) ? source.workStatus : "active";
  const endDate = cleanDate(source.endDate);
  if (endDate === undefined) {
    return NextResponse.json(
      { message: "تاريخ انتهاء الخدمة بصيغة YYYY-MM-DD." },
      { status: 400, headers: NO_STORE },
    );
  }
  if (endDate !== null && endDate < (hireDate ?? "")) {
    return NextResponse.json(
      { message: "تاريخ انتهاء الخدمة لا يسبق تاريخ الالتحاق." },
      { status: 400, headers: NO_STORE },
    );
  }
  if (!isHrContractKind(source.contractKind)) {
    return NextResponse.json(
      { message: "اختر نوع التعاقد: نسبة أو راتب أو راتب ونسبة." },
      { status: 400, headers: NO_STORE },
    );
  }
  const contractKind = source.contractKind;
  let payTerms = null;
  const payValidation = validatePayTermsInput(source);
  if (typeof payValidation === "string") {
    return NextResponse.json({ message: payValidation }, { status: 400, headers: NO_STORE });
  }
  if (payValidation !== null) {
    if (contractKind === "commission") {
      return NextResponse.json(
        { message: "تعاقد «نسبة» بلا راتب: احذف مبلغ الراتب أو اختر راتبًا/راتبًا ونسبة." },
        { status: 400, headers: NO_STORE },
      );
    }
    payTerms = payValidation;
  } else if (contractKind !== "commission") {
    return NextResponse.json(
      { message: "لراتبٍ أو راتبٍ ونسبة: اكتب المبلغ وعملته ودوريته وتاريخ سريانه." },
      { status: 400, headers: NO_STORE },
    );
  }
  const phone = cleanOptionalText(source.phone, 40);
  if (phone === undefined) {
    return NextResponse.json(
      { message: "الهاتف نصٌّ حتى 40 حرفًا." },
      { status: 400, headers: NO_STORE },
    );
  }
  const note = cleanOptionalText(source.note, 2000);
  if (note === undefined) {
    return NextResponse.json(
      { message: "الملاحظة نصٌّ حتى 2000 حرف." },
      { status: 400, headers: NO_STORE },
    );
  }

  const input: CreateStaffInput = {
    fullName,
    jobTitle: jobTitle ?? "",
    department: source.department,
    hireDate: hireDate ?? null,
    workStatus,
    endDate,
    contractKind,
    payTerms,
    phone: phone ?? null,
    note: note ?? null,
  };

  try {
    const staff = await withStaffOperation(getPool(), session, "hr.staff.manage", async (client, handle) => {
      const identity = await staffOperationIdentity(client, handle, "hr.staff.manage");
      return createStaffInTx(client, input, { username: identity.username, role: identity.role });
    });
    return NextResponse.json(staff, { status: 201, headers: NO_STORE });
  } catch (error) {
    return hrCanonDomainWriteErrorResponse(error, "تعذّر إنشاء ملف الموظف.", 500);
  }
}

/* ============================================================================
 * 5. /api/hr/staff/[id] (GET & PATCH — hr.staff.manage + staff.profile.edit on link/unlink)
 * ============================================================================ */

export async function hrStaffDetailGetCanonicalResponse(
  context: { params: Promise<{ id: string }> },
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم الملف غير صالح." }, { status: 400, headers: NO_STORE });
  }

  try {
    const detail = await runCanonicalReadSnapshot(
      session,
      "hr.staff.manage",
      (query) => getStaffDetailWith(query, id),
      { errorPrefix: "STAFF_READ", maxBytes: HR_SNAPSHOT_MAX_BYTES },
    );
    if (!detail) {
      return NextResponse.json(
        { message: "ملف الموظف غير موجود." },
        { status: 404, headers: NO_STORE },
      );
    }
    return NextResponse.json(detail, { headers: NO_STORE });
  } catch (error) {
    return hrCanonReadErrorResponse(error, "تعذّر تحميل الملف.");
  }
}

export async function hrStaffDetailPatchCanonicalResponse(
  request: Request,
  context: { params: Promise<{ id: string }> },
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم الملف غير صالح." }, { status: 400, headers: NO_STORE });
  }

  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    return (
      bodyErrorResponse(error) ??
      NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE })
    );
  }
  const source = (body ?? {}) as Record<string, unknown>;

  if (source.action === "link_user" || source.action === "unlink_user") {
    const reason = typeof source.reason === "string" ? source.reason.trim().slice(0, 300) : "";
    if (!reason) {
      return NextResponse.json(
        { message: "اكتب سبب الربط أو الفكّ — يُسجَّل في سجل الملف." },
        { status: 400, headers: NO_STORE },
      );
    }
    const targetUserId =
      source.action === "unlink_user"
        ? null
        : (() => {
            const parsed = Number(source.userId);
            return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
          })();
    if (targetUserId === undefined) {
      return NextResponse.json(
        { message: "اختر حساب الدخول الموجود المطلوب ربطه." },
        { status: 400, headers: NO_STORE },
      );
    }

    try {
      const result = await withStaffOperation(getPool(), session, "hr.staff.manage", async (client, handle) => {
        const identity = await staffOperationIdentity(client, handle, "hr.staff.manage");
        const caps = await staffOperationCapabilities(client, handle, "hr.staff.manage", [
          "staff.profile.edit",
        ]);
        if (!caps.has("staff.profile.edit")) {
          throw new CanonicalHrRefusal(
            403,
            "ربط ملف الموظف بحساب دخول يتطلب صلاحية تعديل بيانات حسابات الطاقم (staff.profile.edit).",
            "capability_denied",
          );
        }
        return setStaffUserLinkInTx(client, id, targetUserId, reason, {
          username: identity.username,
          role: identity.role,
        });
      });
      if (!result.ok) {
        return NextResponse.json(
          { message: result.error },
          { status: result.status, headers: NO_STORE },
        );
      }
      return NextResponse.json(result.staff, { headers: NO_STORE });
    } catch (error) {
      return hrCanonDomainWriteErrorResponse(error, "تعذّر تحديث ربط حساب الدخول.", 500);
    }
  }

  const patch: UpdateStaffPatch = {};
  if (source.fullName !== undefined) {
    const fullName = typeof source.fullName === "string" ? source.fullName.trim() : "";
    if (fullName.length < 2 || fullName.length > 120) {
      return NextResponse.json(
        { message: "الاسم من حرفين إلى 120." },
        { status: 400, headers: NO_STORE },
      );
    }
    patch.fullName = fullName;
  }
  if (source.jobTitle !== undefined) {
    const jobTitle = cleanJobTitle(source.jobTitle);
    if (jobTitle === null) {
      return NextResponse.json(
        { message: "المسمى الوظيفي نصٌّ حتى 80 حرفًا." },
        { status: 400, headers: NO_STORE },
      );
    }
    patch.jobTitle = jobTitle;
  }
  if (source.department !== undefined) {
    if (!isHrDepartment(source.department)) {
      return NextResponse.json(
        { message: "اختر قسم الموظف." },
        { status: 400, headers: NO_STORE },
      );
    }
    patch.department = source.department;
  }
  if (source.workStatus !== undefined) {
    if (!isHrWorkStatus(source.workStatus)) {
      return NextResponse.json(
        { message: "حالة العمل: على رأس العمل أو موقوف أو منتهٍ." },
        { status: 400, headers: NO_STORE },
      );
    }
    patch.workStatus = source.workStatus;
  }
  if (source.hireDate !== undefined) {
    const hireDate = cleanDate(source.hireDate);
    if (hireDate === undefined) {
      return NextResponse.json(
        { message: "تاريخ الالتحاق بصيغة YYYY-MM-DD." },
        { status: 400, headers: NO_STORE },
      );
    }
    patch.hireDate = hireDate;
  }
  if (source.endDate !== undefined) {
    const endDate = cleanDate(source.endDate);
    if (endDate === undefined) {
      return NextResponse.json(
        { message: "تاريخ الانتهاء بصيغة YYYY-MM-DD." },
        { status: 400, headers: NO_STORE },
      );
    }
    patch.endDate = endDate;
  }
  if (source.contractKind !== undefined) {
    if (!isHrContractKind(source.contractKind)) {
      return NextResponse.json(
        { message: "نوع التعاقد: نسبة أو راتب أو راتب ونسبة." },
        { status: 400, headers: NO_STORE },
      );
    }
    patch.contractKind = source.contractKind;
  }
  const payValidation = validatePayTermsInput(source);
  if (typeof payValidation === "string") {
    return NextResponse.json({ message: payValidation }, { status: 400, headers: NO_STORE });
  }
  if (payValidation !== null) {
    patch.payTerms = payValidation;
  }
  if (source.phone !== undefined) {
    const phone = cleanOptionalText(source.phone, 40);
    if (phone === undefined) {
      return NextResponse.json(
        { message: "الهاتف نصٌّ حتى 40 حرفًا." },
        { status: 400, headers: NO_STORE },
      );
    }
    patch.phone = phone;
  }
  if (source.note !== undefined) {
    const note = cleanOptionalText(source.note, 2000);
    if (note === undefined) {
      return NextResponse.json(
        { message: "الملاحظة نصٌّ حتى 2000 حرف." },
        { status: 400, headers: NO_STORE },
      );
    }
    patch.note = note;
  }
  if (typeof source.reason === "string" && source.reason.trim()) {
    patch.reason = source.reason.trim().slice(0, 300);
  }
  if (typeof source.expectedUpdatedAt === "string" && source.expectedUpdatedAt) {
    patch.expectedUpdatedAt = source.expectedUpdatedAt;
  }

  try {
    const result = await withStaffOperation(getPool(), session, "hr.staff.manage", async (client, handle) => {
      const identity = await staffOperationIdentity(client, handle, "hr.staff.manage");
      return updateStaffInTx(client, id, patch, {
        username: identity.username,
        role: identity.role,
      });
    });
    if (!result.ok) {
      return NextResponse.json(
        { message: result.error },
        { status: result.status, headers: NO_STORE },
      );
    }
    return NextResponse.json(result.staff, { headers: NO_STORE });
  } catch (error) {
    return hrCanonDomainWriteErrorResponse(
      error,
      "تعذّر تعديل الملف — راجع القيم (مثل تعاقد نسبةٍ مع مبلغ راتب).",
      500,
    );
  }
}

/* ============================================================================
 * 6 & 7. /api/hr/staff/[id]/history & /api/hr/staff/[id]/schedule-history
 * ============================================================================ */

export async function hrStaffHistoryGetCanonicalResponse(
  request: Request,
  context: { params: Promise<{ id: string }> },
  kind: HrHistoryKind,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const action: StaffRuntimeAction =
    kind === "schedule" ? "hr.schedules.manage" : "hr.staff.manage";
  try {
    if (request.signal?.aborted) {
      throw new HrHistoryError(
        "request_cancelled",
        "أُلغي الطلب؛ لا توجد نتيجة حفظ مؤكدة. تحقق من السجل قبل تغيير الطلب.",
        409,
      );
    }
    const { id } = await context.params;
    const url = new URL(request.url);
    if (
      !/^[1-9]\d*$/.test(id) ||
      [...url.searchParams.keys()].some((key) => !["revision", "day"].includes(key))
    ) {
      throw new HrHistoryError("invalid_request", "معلمات قراءة السجل غير صالحة.", 400);
    }
    const revision = url.searchParams.get("revision");
    if (revision !== null && !/^(0|[1-9]\d*)$/.test(revision)) {
      throw new HrHistoryError("invalid_revision", "رقم المراجعة غير صالح.", 400);
    }
    const staffId = Number(id);
    const revOption = revision === null ? undefined : Number(revision);
    const dayOption = url.searchParams.get("day") ?? undefined;

    const history = await runCanonicalReadSnapshot(
      session,
      action,
      async (query) => {
        if (request.signal?.aborted) {
          throw new HrHistoryError(
            "request_cancelled",
            "أُلغي الطلب؛ لا توجد نتيجة حفظ مؤكدة. تحقق من السجل قبل تغيير الطلب.",
            409,
          );
        }
        return readHrRecordedHistoryInSnapshot(query, staffId, kind, {
          revision: revOption,
          day: dayOption,
        });
      },
      { errorPrefix: "STAFF_READ", maxBytes: HR_SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(history, { headers: NO_STORE });
  } catch (error) {
    return hrCanonTemporalErrorResponse(error);
  }
}

export async function hrStaffHistoryPostCanonicalResponse(
  request: Request,
  context: { params: Promise<{ id: string }> },
  kind: HrHistoryKind,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const action: StaffRuntimeAction =
    kind === "schedule" ? "hr.schedules.manage" : "hr.staff.manage";
  try {
    const { id } = await context.params;
    if (!/^[1-9]\d*$/.test(id)) {
      throw new HrHistoryError("invalid_subject", "رقم الموظف غير صالح.", 400);
    }
    const command = parseHrHistoryCommand(
      await readJsonBody(request, JSON_BODY_LIMIT_BYTES),
      kind,
      Number(id),
    );
    const result = await withStaffOperation(getPool(), session, action, async (client, handle) => {
      const authority = canonicalHrTemporalAuthority(handle, action, request.signal);
      return recordHrHistoryInTransaction(client, authority, command);
    });
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    return hrCanonTemporalErrorResponse(error);
  }
}

/* ============================================================================
 * 8 & 9. /api/hr/contracts & /api/hr/contracts/[id] (hr.staff.manage)
 * ============================================================================ */

export async function hrContractsGetCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const url = new URL(request.url);
  const staffIdStr = url.searchParams.get("staffId");
  const staffId = staffIdStr ? parseInt(staffIdStr, 10) : undefined;
  const status = (url.searchParams.get("status") as HrContractStatus) || undefined;
  const templateKind =
    ((url.searchParams.get("contractKind") ||
      url.searchParams.get("templateKind")) as HrContractTemplateKind | null) || undefined;

  try {
    const contracts = await runCanonicalReadSnapshot(
      session,
      "hr.staff.manage",
      (query) => listContractsWith(query, { staffId, status, templateKind }),
      { errorPrefix: "STAFF_READ", maxBytes: HR_SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(contracts, { headers: NO_STORE });
  } catch (error) {
    return hrCanonReadErrorResponse(error, "تعذّر تحميل العقود.");
  }
}

export async function hrContractsPostCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    return (
      bodyErrorResponse(error) ??
      NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE })
    );
  }

  const payload = (body ?? {}) as Record<string, any>;
  if (!payload.staffId || !payload.title || !payload.startDate) {
    return NextResponse.json(
      { message: "يرجى تعبئة الحقول الإلزامية: الموظف، المسمى، وتاريخ البدء." },
      { status: 400, headers: NO_STORE },
    );
  }

  const input: CreateContractInput = {
    staffId: Number(payload.staffId),
    templateKind: payload.templateKind || payload.contractKind || "support_staff",
    title: String(payload.title),
    startDate: String(payload.startDate),
    endDate: payload.endDate || null,
    probationEndDate: payload.probationEndDate || null,
    noticePeriodDays: payload.noticePeriodDays ? Number(payload.noticePeriodDays) : 30,
    termsPayload: payload.termsPayload || {},
    compensationKind: payload.compensationKind || "salary",
    baseSalaryMinor:
      payload.baseSalaryMinor != null && payload.baseSalaryMinor !== ""
        ? Number(payload.baseSalaryMinor)
        : null,
    salaryCurrency: payload.salaryCurrency || payload.currency || null,
    salaryPeriod: payload.salaryPeriod || null,
    commissionRatePercent:
      payload.commissionRatePercent != null && payload.commissionRatePercent !== ""
        ? Number(payload.commissionRatePercent)
        : null,
    doctorPartyId: payload.doctorPartyId ? Number(payload.doctorPartyId) : null,
    notes: payload.notes || null,
  };

  try {
    const contract = await withStaffOperation(getPool(), session, "hr.staff.manage", async (client, handle) => {
      const identity = await staffOperationIdentity(client, handle, "hr.staff.manage");
      return createContractInTx(client, input, {
        username: identity.username,
        role: identity.role,
      });
    });
    return NextResponse.json(contract, { status: 201, headers: NO_STORE });
  } catch (error) {
    return hrCanonDomainWriteErrorResponse(error, "تعذّر إنشاء العقد.", 400);
  }
}

export async function hrContractDetailGetCanonicalResponse(
  context: { params: Promise<{ id: string }> },
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const { id } = await context.params;
  try {
    const detail = await runCanonicalReadSnapshot(
      session,
      "hr.staff.manage",
      async (query) => {
        const contract = await getContractByIdWith(query, id);
        if (!contract) return null;
        const addenda = await listContractAddendaWith(query, id);
        return { contract, addenda };
      },
      { errorPrefix: "STAFF_READ", maxBytes: HR_SNAPSHOT_MAX_BYTES },
    );
    if (!detail) {
      return NextResponse.json({ message: "العقد غير موجود." }, { status: 404, headers: NO_STORE });
    }
    return NextResponse.json(detail, { headers: NO_STORE });
  } catch (error) {
    return hrCanonReadErrorResponse(error, "تعذّر جلب العقد.");
  }
}

export async function hrContractDetailPatchCanonicalResponse(
  request: Request,
  context: { params: Promise<{ id: string }> },
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const { id } = await context.params;
  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    return (
      bodyErrorResponse(error) ??
      NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE })
    );
  }

  const payload = (body ?? {}) as Record<string, any>;
  if (payload.action === "transition" && !payload.status) {
    return NextResponse.json(
      { message: "يرجى تحديد الحالة الجديدة." },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    const updated = await withStaffOperation(getPool(), session, "hr.staff.manage", async (client, handle) => {
      const identity = await staffOperationIdentity(client, handle, "hr.staff.manage");
      if (payload.action === "transition") {
        const status = payload.status as HrContractStatus;
        const ownerOps = await staffOperationOwnerOperations(client, handle, "hr.staff.manage", [
          "settings.security.change",
        ]);
        const isOwner = ownerOps.has("settings.security.change");
        const actor = {
          userId: identity.userId,
          username: identity.username,
          role: identity.role,
          isOwner,
        };
        if (status === "approved") {
          return approveContractInTx(client, id, actor);
        }
        return transitionContractStatusInTx(
          client,
          id,
          status,
          payload.reason || "تحديث حالة العقد",
          actor,
        );
      }
      return updateContractInTx(client, id, payload as UpdateContractInput, {
        username: identity.username,
        role: identity.role,
      });
    });
    return NextResponse.json(updated, { headers: NO_STORE });
  } catch (error) {
    return hrCanonDomainWriteErrorResponse(error, "تعذّر تحديث العقد.", 400);
  }
}

export async function hrContractDetailPostCanonicalResponse(
  request: Request,
  context: { params: Promise<{ id: string }> },
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const { id } = await context.params;
  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    return (
      bodyErrorResponse(error) ??
      NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE })
    );
  }

  const payload = (body ?? {}) as Record<string, any>;
  if (!payload.title || !payload.startDate || (!payload.addendumReason && !payload.reason)) {
    return NextResponse.json(
      { message: "يرجى تعبئة عنوان الملحق وتاريخ السريان وسبب التعديل." },
      { status: 400, headers: NO_STORE },
    );
  }

  const input: CreateAddendumInput = {
    title: String(payload.title),
    startDate: String(payload.startDate || payload.effectiveDate),
    endDate: payload.endDate || null,
    addendumReason: String(payload.addendumReason || payload.reason || "تعديل بنود العقد"),
    termsPayload: payload.termsPayload || {},
    baseSalaryMinor:
      payload.baseSalaryMinor !== undefined ? Number(payload.baseSalaryMinor) : undefined,
    salaryCurrency: payload.salaryCurrency || undefined,
    salaryPeriod: payload.salaryPeriod || undefined,
    commissionRatePercent:
      payload.commissionRatePercent !== undefined
        ? Number(payload.commissionRatePercent)
        : undefined,
    notes: payload.notes || null,
  };

  try {
    const addendum = await withStaffOperation(getPool(), session, "hr.staff.manage", async (client, handle) => {
      const identity = await staffOperationIdentity(client, handle, "hr.staff.manage");
      return createContractAddendumInTx(client, id, input, {
        username: identity.username,
        role: identity.role,
      });
    });
    return NextResponse.json(addendum, { status: 201, headers: NO_STORE });
  } catch (error) {
    return hrCanonDomainWriteErrorResponse(error, "تعذّر إضافة الملحق.", 400);
  }
}

/* ============================================================================
 * 10 & 11. /api/hr/schedules & /api/hr/schedules/[id]
 * ============================================================================ */

export async function hrSchedulesGetCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const url = new URL(request.url);
  const staffId = url.searchParams.get("staffId") || undefined;
  const isDefaultParam = url.searchParams.get("isDefault");
  const isDefault = isDefaultParam !== null ? isDefaultParam === "true" : undefined;

  try {
    const schedules = await runCanonicalReadSnapshot(
      session,
      "hr.directory.view",
      (query) => listWorkSchedulesWith(query, { staffId, isDefault }),
      { errorPrefix: "STAFF_READ", maxBytes: HR_SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(schedules, { headers: NO_STORE });
  } catch (error) {
    return hrCanonReadErrorResponse(error, "تعذّر تحميل جداول العمل.");
  }
}

export async function hrSchedulesPostCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    return (
      bodyErrorResponse(error) ??
      NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE })
    );
  }

  const raw = (body ?? {}) as {
    staffId?: string | number | null;
    department?: string | null;
    name?: string;
    scheduleType?: string;
    shiftPattern?: string;
    effectiveFrom?: string;
    effectiveTo?: string | null;
    workingDays?: number[];
    workDays?: number[];
    shiftStartTime?: string;
    shiftEndTime?: string;
    secondShiftStart?: string | null;
    secondShiftEnd?: string | null;
    gracePeriodMins?: number;
    expectedDailyHours?: number;
    crossesMidnight?: boolean;
  };

  if (!raw.name) {
    return NextResponse.json(
      { message: "يرجى تحديد مسمى الجدول." },
      { status: 400, headers: NO_STORE },
    );
  }

  const scheduleInput: CreateScheduleInput = {
    staffId: raw.staffId ? Number(raw.staffId) : null,
    department: raw.department || null,
    name: String(raw.name).trim(),
    scheduleType: (raw.scheduleType || raw.shiftPattern || "morning") as any,
    effectiveFrom: raw.effectiveFrom || clinicDateString(new Date(), CLINIC_ZONE_FALLBACK),
    effectiveTo: raw.effectiveTo || null,
    workingDays: Array.isArray(raw.workingDays)
      ? raw.workingDays
      : Array.isArray(raw.workDays)
        ? raw.workDays
        : [0, 1, 2, 3, 4, 6],
    shiftStartTime: raw.shiftStartTime || "09:00",
    shiftEndTime: raw.shiftEndTime || "17:00",
    secondShiftStart: raw.secondShiftStart || null,
    secondShiftEnd: raw.secondShiftEnd || null,
    gracePeriodMins: raw.gracePeriodMins !== undefined ? Number(raw.gracePeriodMins) : undefined,
    expectedDailyHours:
      raw.expectedDailyHours !== undefined ? Number(raw.expectedDailyHours) : 8,
    crossesMidnight: Boolean(raw.crossesMidnight),
  };

  try {
    const schedule = await withStaffOperation(
      getPool(),
      session,
      "hr.schedules.manage",
      async (client, handle) => {
        const identity = await staffOperationIdentity(client, handle, "hr.schedules.manage");
        return createWorkScheduleInTx(client, scheduleInput, {
          username: identity.username,
          role: identity.role,
        });
      },
    );
    return NextResponse.json(schedule, { status: 201, headers: NO_STORE });
  } catch (error) {
    return hrCanonDomainWriteErrorResponse(error, "تعذّر إنشاء جدول العمل.", 400);
  }
}

export async function hrScheduleDetailGetCanonicalResponse(
  context: { params: Promise<{ id: string }> },
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const { id } = await context.params;
  try {
    const schedule = await runCanonicalReadSnapshot(
      session,
      "hr.directory.view",
      (query) => getWorkScheduleByIdWith(query, id),
      { errorPrefix: "STAFF_READ", maxBytes: HR_SNAPSHOT_MAX_BYTES },
    );
    if (!schedule) {
      return NextResponse.json(
        { message: "الجدول غير موجود." },
        { status: 404, headers: NO_STORE },
      );
    }
    return NextResponse.json(schedule, { headers: NO_STORE });
  } catch (error) {
    return hrCanonReadErrorResponse(error, "تعذّر جلب جدول العمل.");
  }
}

export async function hrScheduleDetailPatchCanonicalResponse(
  request: Request,
  context: { params: Promise<{ id: string }> },
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const { id } = await context.params;
  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    return (
      bodyErrorResponse(error) ??
      NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE })
    );
  }
  const payload = (body ?? {}) as UpdateScheduleInput;

  try {
    const updated = await withStaffOperation(
      getPool(),
      session,
      "hr.schedules.manage",
      async (client, handle) => {
        const identity = await staffOperationIdentity(client, handle, "hr.schedules.manage");
        return updateWorkScheduleInTx(client, id, payload, {
          username: identity.username,
          role: identity.role,
        });
      },
    );
    return NextResponse.json(updated, { headers: NO_STORE });
  } catch (error) {
    return hrCanonDomainWriteErrorResponse(error, "تعذّر تعديل جدول العمل.", 400);
  }
}

/* ============================================================================
 * 12 & 13. /api/hr/attendance & /api/hr/attendance/corrections
 * ============================================================================ */

export async function hrAttendanceGetCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const url = new URL(request.url);
  const staffIdStr = url.searchParams.get("staffId");
  const staffId = staffIdStr ? parseInt(staffIdStr, 10) : undefined;
  const startDate = url.searchParams.get("startDate") || undefined;
  const endDate = url.searchParams.get("endDate") || undefined;
  const status = (url.searchParams.get("status") as HrAttendanceStatus) || undefined;

  try {
    const records = await runCanonicalReadSnapshot(
      session,
      "hr.attendance.record",
      (query) => listAttendanceRecordsWith(query, { staffId, startDate, endDate, status }),
      { errorPrefix: "STAFF_READ", maxBytes: HR_SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(records, { headers: NO_STORE });
  } catch (error) {
    return hrCanonReadErrorResponse(error, "تعذّر تحميل سجلات الحضور.");
  }
}

export async function hrAttendancePostCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    return (
      bodyErrorResponse(error) ??
      NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE })
    );
  }

  const payload = (body ?? {}) as Partial<AttendancePunchInput>;
  if (!payload.staffId || !payload.punchType) {
    return NextResponse.json(
      { message: "يرجى تحديد الموظف ونوع البصمة (دخول أو خروج)." },
      { status: 400, headers: NO_STORE },
    );
  }
  const punchInput: AttendancePunchInput = {
    staffId: payload.staffId,
    punchType: payload.punchType,
    punchTime: payload.punchTime || new Date().toISOString(),
    source: payload.source || "manual",
    note: payload.note || null,
    ipAddress: payload.ipAddress || null,
  };

  try {
    const record = await withStaffOperation(
      getPool(),
      session,
      "hr.attendance.record",
      async (client, handle) => {
        const identity = await staffOperationIdentity(client, handle, "hr.attendance.record");
        return recordAttendancePunchInTx(client, punchInput, {
          username: identity.username,
          role: identity.role,
        });
      },
    );
    return NextResponse.json(record, { status: 201, headers: NO_STORE });
  } catch (error) {
    return hrCanonDomainWriteErrorResponse(error, "تعذّر تسجيل البصمة.", 400);
  }
}

export async function hrAttendanceCorrectionsGetCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const url = new URL(request.url);
  const staffId = url.searchParams.get("staffId") || undefined;
  const status = (url.searchParams.get("status") as "pending" | "approved" | "rejected") || undefined;

  try {
    const corrections = await runCanonicalReadSnapshot(
      session,
      "hr.attendance.correct",
      (query) => listAttendanceCorrectionsWith(query, { staffId, status }),
      { errorPrefix: "STAFF_READ", maxBytes: HR_SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(corrections, { headers: NO_STORE });
  } catch (error) {
    return hrCanonReadErrorResponse(error, "تعذّر تحميل طلبات التصحيح.");
  }
}

export async function hrAttendanceCorrectionsPostCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    return (
      bodyErrorResponse(error) ??
      NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE })
    );
  }

  const payload = (body ?? {}) as Record<string, any>;
  if (payload.action === "decide") {
    const { id, decision, reason } = payload as {
      id?: string | number;
      decision?: "approved" | "rejected";
      reason?: string;
    };
    if (!id || !decision) {
      return NextResponse.json(
        { message: "يرجى تحديد الطلب والقرار." },
        { status: 400, headers: NO_STORE },
      );
    }

    try {
      const updated = await withStaffOperation(
        getPool(),
        session,
        "hr.attendance.correct",
        async (client, handle) => {
          const identity = await staffOperationIdentity(client, handle, "hr.attendance.correct");
          const soleOwner =
            decision === "approved"
              ? await resolveCanonSoleOwnerForCapability(
                  client,
                  handle,
                  "hr.attendance.correct",
                  "hr.attendance.correct",
                )
              : false;
          return decideAttendanceCorrectionInTx(client, id, decision, reason ?? null, {
            userId: identity.userId,
            username: identity.username,
            role: identity.role,
            soleOwner,
          });
        },
      );
      return NextResponse.json(updated, { headers: NO_STORE });
    } catch (error) {
      return hrCanonDomainWriteErrorResponse(error, "تعذّر معالجة تصحيح الحضور.", 400);
    }
  }

  const input = payload as RequestCorrectionInput;
  if (!input.attendanceRecordId || !input.reason) {
    return NextResponse.json(
      { message: "يرجى تحديد سجل الحضور وسبب التصحيح." },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    const created = await withStaffOperation(
      getPool(),
      session,
      "hr.attendance.correct",
      async (client, handle) => {
        const identity = await staffOperationIdentity(client, handle, "hr.attendance.correct");
        return requestAttendanceCorrectionInTx(client, input, {
          userId: identity.userId,
          username: identity.username,
          role: identity.role,
        });
      },
    );
    return NextResponse.json(created, { status: 201, headers: NO_STORE });
  } catch (error) {
    return hrCanonDomainWriteErrorResponse(error, "تعذّر معالجة تصحيح الحضور.", 400);
  }
}

/* ============================================================================
 * 14, 15 & 16. /api/hr/leaves, /api/hr/leaves/[id], /api/hr/leaves/balances
 * ============================================================================ */

export async function hrLeavesGetCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const url = new URL(request.url);
  const includeTypes = url.searchParams.get("types") === "true";
  const staffIdStr = url.searchParams.get("staffId");
  const staffId = staffIdStr ? parseInt(staffIdStr, 10) : undefined;
  const status = (url.searchParams.get("status") as HrLeaveRequestStatus) || undefined;
  const startDate = url.searchParams.get("startDate") || undefined;
  const endDate = url.searchParams.get("endDate") || undefined;

  try {
    const result = await runCanonicalReadSnapshot(
      session,
      "hr.leaves.request",
      async (query, scope) => {
        const canViewAll =
          scope.granted("hr.leaves.approve") || scope.granted("hr.staff.manage");
        const requests = await listLeaveRequestsWith(query, {
          staffId,
          status,
          startDate,
          endDate,
          restrictToUserId: canViewAll ? null : scope.userId,
        });
        if (!includeTypes) return requests;
        const types = await listLeaveTypesWith(query);
        const staff = await leaveStaffOptionsWith(query, {
          canViewAll,
          userId: scope.userId,
        });
        return { requests, types, staff };
      },
      { errorPrefix: "STAFF_READ", maxBytes: HR_SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    return hrCanonReadErrorResponse(error, "تعذّر تحميل الإجازات.");
  }
}

export async function hrLeavesPostCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    return (
      bodyErrorResponse(error) ??
      NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE })
    );
  }

  const payload = (body ?? {}) as Record<string, any>;
  const leaveTypeCode = payload.leaveTypeCode || payload.leaveTypeId;
  if (!payload.staffId || !leaveTypeCode || !payload.startDate || !payload.endDate) {
    return NextResponse.json(
      { message: "يرجى تحديد الموظف ونوع الإجازة وتاريخ البدء والانتهاء." },
      { status: 400, headers: NO_STORE },
    );
  }

  const start = new Date(payload.startDate);
  const end = new Date(payload.endDate);
  const diffDays = Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1;
  const daysCount = payload.daysCount ? Number(payload.daysCount) : diffDays;

  const input: CreateLeaveRequestInput = {
    staffId: Number(payload.staffId),
    leaveTypeCode,
    startDate: String(payload.startDate),
    endDate: String(payload.endDate),
    daysCount,
    reason: String(payload.reason || "طلب إجازة"),
    isPartialDay: Boolean(payload.isPartialDay),
    partialHours: payload.partialHours ? Number(payload.partialHours) : null,
    attachmentRefs: payload.attachmentRefs || [],
  };

  try {
    const leave = await withStaffOperation(
      getPool(),
      session,
      "hr.leaves.request",
      async (client, handle) => {
        const identity = await staffOperationIdentity(client, handle, "hr.leaves.request");
        const caps = await staffOperationCapabilities(client, handle, "hr.leaves.request", [
          "hr.leaves.approve",
          "hr.staff.manage",
        ]);
        const canManageAllLeaves =
          caps.has("hr.leaves.approve") || caps.has("hr.staff.manage");
        return createLeaveRequestInTx(client, input, {
          userId: identity.userId,
          username: identity.username,
          role: identity.role,
          canManageAllLeaves,
        });
      },
    );
    return NextResponse.json(leave, { status: 201, headers: NO_STORE });
  } catch (error) {
    return hrCanonDomainWriteErrorResponse(error, "تعذّر رفع طلب الإجازة.", 400);
  }
}

export async function hrLeaveDetailGetCanonicalResponse(
  context: { params: Promise<{ id: string }> },
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const { id } = await context.params;
  const targetId = Number(id);

  try {
    const found = await runCanonicalReadSnapshot(
      session,
      "hr.leaves.request",
      async (query, scope) => {
        const canViewAll =
          scope.granted("hr.leaves.approve") || scope.granted("hr.staff.manage");
        const list = await listLeaveRequestsWith(query, {
          restrictToUserId: canViewAll ? null : scope.userId,
        });
        return list.find((item) => item.id === targetId) ?? null;
      },
      { errorPrefix: "STAFF_READ", maxBytes: HR_SNAPSHOT_MAX_BYTES },
    );
    if (!found) {
      return NextResponse.json(
        { message: "طلب الإجازة غير موجود." },
        { status: 404, headers: NO_STORE },
      );
    }
    return NextResponse.json(found, { headers: NO_STORE });
  } catch (error) {
    return hrCanonReadErrorResponse(error, "تعذّر جلب طلب الإجازة.");
  }
}

export async function hrLeaveDetailPatchCanonicalResponse(
  request: Request,
  context: { params: Promise<{ id: string }> },
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const { id } = await context.params;
  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    return (
      bodyErrorResponse(error) ??
      NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE })
    );
  }

  const payload = (body ?? {}) as {
    status?: "approved" | "rejected" | "cancelled";
    decisionNotes?: string;
  };
  if (!payload.status) {
    return NextResponse.json(
      { message: "يرجى تحديد القرار (قبول أو رفض أو إلغاء)." },
      { status: 400, headers: NO_STORE },
    );
  }
  const decision = payload.status;

  try {
    const updated = await withStaffOperation(
      getPool(),
      session,
      "hr.leaves.approve",
      async (client, handle) => {
        const identity = await staffOperationIdentity(client, handle, "hr.leaves.approve");
        const soleOwner =
          decision === "approved"
            ? await resolveCanonSoleOwnerForCapability(
                client,
                handle,
                "hr.leaves.approve",
                "hr.leaves.approve",
              )
            : false;
        return decideLeaveRequestInTx(
          client,
          Number(id),
          decision,
          payload.decisionNotes || "تحديث حالة الإجازة",
          {
            userId: identity.userId,
            username: identity.username,
            role: identity.role,
            soleOwner,
          },
        );
      },
    );
    return NextResponse.json(updated, { headers: NO_STORE });
  } catch (error) {
    return hrCanonDomainWriteErrorResponse(error, "تعذّر اتخاذ قرار بشأن الإجازة.", 400);
  }
}

export async function hrLeaveBalancesGetCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const url = new URL(request.url);
  const staffId = url.searchParams.get("staffId");
  const yearStr = url.searchParams.get("year");
  const year = yearStr ? parseInt(yearStr, 10) : currentClinicYear();

  if (!staffId) {
    return NextResponse.json(
      { message: "يرجى تحديد الموظف لجلب أرصدة إجازاته." },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    const balances = await runCanonicalReadSnapshot(
      session,
      "hr.leaves.request",
      (query, scope) => {
        const canViewAll =
          scope.granted("hr.leaves.approve") || scope.granted("hr.staff.manage");
        return listLeaveBalancesWith(query, {
          staffId,
          year,
          restrictToUserId: canViewAll ? null : scope.userId,
        });
      },
      { errorPrefix: "STAFF_READ", maxBytes: HR_SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(balances, { headers: NO_STORE });
  } catch (error) {
    return hrCanonReadErrorResponse(error, "تعذّر جلب أرصدة الإجازات.");
  }
}

export async function hrLeaveBalancesPostCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    return (
      bodyErrorResponse(error) ??
      NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE })
    );
  }

  const payload = (body ?? {}) as {
    staffId?: string | number;
    leaveTypeId?: string;
    leaveTypeCode?: string;
    year?: number;
    allocatedDays?: number;
    reason?: string;
  };
  const leaveTypeCode = payload.leaveTypeId || payload.leaveTypeCode;
  if (!payload.staffId || !leaveTypeCode || payload.allocatedDays === undefined) {
    return NextResponse.json(
      { message: "يرجى تحديد الموظف ونوع الإجازة وعدد الأيام المخصصة." },
      { status: 400, headers: NO_STORE },
    );
  }

  const year = payload.year || currentClinicYear();

  try {
    const updated = await withStaffOperation(
      getPool(),
      session,
      "hr.leaves.approve",
      async (client, handle) => {
        const identity = await staffOperationIdentity(client, handle, "hr.leaves.approve");
        return adjustLeaveBalanceInTx(
          client,
          {
            staffId: payload.staffId!,
            leaveTypeCode,
            year,
            allocatedDays: Number(payload.allocatedDays),
            reason: payload.reason || "تعديل رصيد",
          },
          { username: identity.username, role: identity.role },
        );
      },
    );
    return NextResponse.json(updated, { status: 201, headers: NO_STORE });
  } catch (error) {
    return hrCanonDomainWriteErrorResponse(error, "تعذّر تعديل الرصيد.", 400);
  }
}

/* ============================================================================
 * 17, 18, 19 & 20. /api/hr/payroll/* (hr.payroll.manage)
 * ============================================================================ */

export async function hrPayrollPeriodsGetCanonicalResponse(
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  try {
    const periods = await runCanonicalReadSnapshot(
      session,
      "hr.payroll.manage",
      (query) => listPayrollPeriodsWith(query),
      { errorPrefix: "STAFF_READ", maxBytes: HR_SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(periods, { headers: NO_STORE });
  } catch (error) {
    return hrCanonReadErrorResponse(error, "تعذّر تحميل فترات المسير.");
  }
}

export async function hrPayrollPeriodsPostCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    return (
      bodyErrorResponse(error) ??
      NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE })
    );
  }

  const payload = (body ?? {}) as {
    periodMonth?: string;
    action?: "open" | "close";
  };
  if (!payload.periodMonth || !/^\d{4}-\d{2}$/.test(payload.periodMonth)) {
    return NextResponse.json(
      { message: "صيغة الشهر يجب أن تكون YYYY-MM (مثلاً 2026-10)." },
      { status: 400, headers: NO_STORE },
    );
  }
  const periodMonth = payload.periodMonth;

  try {
    const { period, status } = await withStaffOperation(
      getPool(),
      session,
      "hr.payroll.manage",
      async (client, handle) => {
        const identity = await staffOperationIdentity(client, handle, "hr.payroll.manage");
        const actor = { username: identity.username, role: identity.role };
        if (payload.action === "close") {
          return {
            period: await closePayrollPeriodInTx(client, periodMonth, actor),
            status: 200 as const,
          };
        }
        return {
          period: await getOrCreatePayrollPeriodInTx(client, periodMonth, actor),
          status: 201 as const,
        };
      },
    );
    return NextResponse.json(period, { status, headers: NO_STORE });
  } catch (error) {
    return hrCanonDomainWriteErrorResponse(error, "تعذّر معالجة فترة المسير.", 500);
  }
}

export async function hrPayrollRunsGetCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const periodId = url.searchParams.get("periodId");

  if (!id && !periodId) {
    return NextResponse.json(
      { message: "يرجى تحديد فترة المسير." },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    const result = await runCanonicalReadSnapshot(
      session,
      "hr.payroll.manage",
      async (query) => {
        if (id) {
          const run = await getPayrollRunByIdWith(query, id);
          if (!run) return { kind: "missing" as const };
          const items = await listPayrollItemsWith(query, run.id);
          return { kind: "single" as const, data: { ...run, items } };
        }
        return { kind: "list" as const, data: await listPayrollRunsWith(query, periodId!) };
      },
      { errorPrefix: "STAFF_READ", maxBytes: HR_SNAPSHOT_MAX_BYTES },
    );
    if (result.kind === "missing") {
      return NextResponse.json(
        { message: "المسير غير موجود." },
        { status: 404, headers: NO_STORE },
      );
    }
    return NextResponse.json(result.data, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof HrPayrollError) {
      return NextResponse.json(
        { message: error.message, code: error.code },
        { status: error.status, headers: NO_STORE },
      );
    }
    return hrCanonReadErrorResponse(error, "تعذّر تحميل مسيرات الرواتب.");
  }
}

export async function hrPayrollRunsPostCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    return (
      bodyErrorResponse(error) ??
      NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE })
    );
  }

  const payload = (body ?? {}) as {
    action?: "calculate" | "approve";
    periodId?: string | number;
    currency?: HrCurrency;
    runId?: string | number;
  };

  if (payload.action === "approve") {
    if (!payload.runId) {
      return NextResponse.json(
        { message: "يرجى تحديد مسير الرواتب للاعتماد." },
        { status: 400, headers: NO_STORE },
      );
    }
    try {
      const approved = await withStaffOperation(
        getPool(),
        session,
        "hr.payroll.manage",
        async (client, handle) => {
          const identity = await staffOperationIdentity(client, handle, "hr.payroll.manage");
          const ownerOps = await staffOperationOwnerOperations(
            client,
            handle,
            "hr.payroll.manage",
            ["settings.security.change"],
          );
          const isOwner = ownerOps.has("settings.security.change");
          return approvePayrollRunInTx(client, payload.runId!, {
            userId: identity.userId,
            username: identity.username,
            role: identity.role,
            isOwner,
          });
        },
      );
      return NextResponse.json(approved, { headers: NO_STORE });
    } catch (error) {
      return hrCanonDomainWriteErrorResponse(error, "تعذّر معالجة مسير الرواتب.", 500);
    }
  }

  if (payload.action === "calculate") {
    if (!payload.periodId || !payload.currency) {
      return NextResponse.json(
        { message: "يرجى تحديد الفترة والعملة لحساب المسير." },
        { status: 400, headers: NO_STORE },
      );
    }
    try {
      const calculated = await withStaffOperation(
        getPool(),
        session,
        "hr.payroll.manage",
        async (client, handle) => {
          const identity = await staffOperationIdentity(client, handle, "hr.payroll.manage");
          return calculatePayrollRunInTx(client, payload.periodId!, payload.currency!, {
            username: identity.username,
            role: identity.role,
          });
        },
      );
      return NextResponse.json(calculated, { status: 201, headers: NO_STORE });
    } catch (error) {
      return hrCanonDomainWriteErrorResponse(error, "تعذّر معالجة مسير الرواتب.", 500);
    }
  }

  return NextResponse.json(
    { message: "العملية غير صالحة." },
    { status: 400, headers: NO_STORE },
  );
}

export async function hrPayrollDisburseGetCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const key = new URL(request.url).searchParams.get("clientRequestId");
  if (!key || key.length < 8 || key.length > 100) {
    return NextResponse.json(
      { message: "مفتاح الطلب غير صالح." },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    const disbursement = await runCanonicalReadSnapshot(
      session,
      "hr.payroll.manage",
      (query) => findDisbursementByRequestId(key, query),
      { errorPrefix: "STAFF_READ", maxBytes: HR_SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json({ disbursement }, { headers: NO_STORE });
  } catch (error) {
    const refusal = staffAdmissionRefusal(error);
    if (refusal) {
      return NextResponse.json(
        { code: refusal.code, message: refusal.message },
        { status: refusal.status, headers: NO_STORE },
      );
    }
    return NextResponse.json(
      { message: "تعذّر التحقق من نتيجة الصرف؛ أعد المحاولة بالمفتاح نفسه." },
      { status: 503, headers: NO_STORE },
    );
  }
}

export async function hrPayrollDisbursePostCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    return (
      bodyErrorResponse(error) ??
      NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE })
    );
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE });
  }
  const p = body as Record<string, unknown>;

  try {
    if (p.action === "reverse") {
      if (
        typeof p.reason !== "string" ||
        !(typeof p.disbursementId === "string" || typeof p.disbursementId === "number")
      ) {
        throw new HrPayrollError("invalid_reversal", 400, "حدّد حركة الصرف وسبب العكس.");
      }
      const outcome = await withStaffOperation(
        getPool(),
        session,
        "hr.payroll.manage",
        async (client, handle) => {
          const identity = await staffOperationIdentity(client, handle, "hr.payroll.manage");
          return withHrCanonicalIdempotencyInTx(
            client,
            request,
            "hr.payroll.reverse",
            identity.username,
            { disbursementId: String(p.disbursementId), reason: p.reason },
            async () => ({
              status: 200,
              body: {
                success: true,
                disbursement: await reversePayrollDisbursementInTx(
                  client,
                  p.disbursementId as string | number,
                  { reason: p.reason as string },
                  {
                    userId: identity.userId,
                    username: identity.username,
                    role: identity.role,
                  },
                ),
              },
            }),
          );
        },
      );
      return NextResponse.json(outcome.body, {
        status: outcome.status,
        headers: outcome.replay ? { ...NO_STORE, "X-Idempotent-Replay": "true" } : NO_STORE,
      });
    }

    if (p.action && p.action !== "disburse") {
      throw new HrPayrollError("invalid_action", 400, "العملية غير صالحة.");
    }
    if (typeof p.clientRequestId !== "string" || !p.clientRequestId.trim()) {
      throw new HrPayrollError("request_key_required", 400, "مفتاح الطلب الثابت مطلوب للصرف.");
    }
    for (const name of ["paymentMethod", "referenceNumber", "notes", "safeOrBankId"]) {
      if (p[name] != null && typeof p[name] !== "string") {
        throw new HrPayrollError("invalid_input", 400, "بيانات الصرف غير صالحة.");
      }
    }
    if (p.amountMinor !== undefined && typeof p.amountMinor !== "number") {
      throw new HrPayrollError("invalid_amount", 400, "المبلغ غير صالح.");
    }
    if (p.components != null && (typeof p.components !== "object" || Array.isArray(p.components))) {
      throw new HrPayrollError("invalid_components", 400, "توزيع الصرف غير صالح.");
    }

    const input: DisburseInput = {
      amountMinor: p.amountMinor as number | undefined,
      clientRequestId: p.clientRequestId,
      components: p.components as DisburseInput["components"],
      paymentMethod: p.paymentMethod as string | undefined,
      referenceNumber: p.referenceNumber as string | null,
      notes: p.notes as string | null,
      safeOrBankId: p.safeOrBankId as string | null,
    };

    if (p.disburseAll === true) {
      if (!(typeof p.runId === "number" || typeof p.runId === "string")) {
        throw new HrPayrollError("invalid_id", 400, "حدّد مسير الرواتب.");
      }
      const disbursements = await withStaffOperation(
        getPool(),
        session,
        "hr.payroll.manage",
        async (client, handle) => {
          const identity = await staffOperationIdentity(client, handle, "hr.payroll.manage");
          return disburseEntireRunInTx(client, p.runId as number | string, input, {
            userId: identity.userId,
            username: identity.username,
            role: identity.role,
          });
        },
      );
      return NextResponse.json({ success: true, disbursements }, { status: 201, headers: NO_STORE });
    }

    if (!(typeof p.itemId === "number" || typeof p.itemId === "string")) {
      throw new HrPayrollError("invalid_id", 400, "حدّد بند المستحق.");
    }
    let disbursement;
    try {
      disbursement = await withStaffOperation(
        getPool(),
        session,
        "hr.payroll.manage",
        async (client, handle) => {
          const identity = await staffOperationIdentity(client, handle, "hr.payroll.manage");
          return disbursePayrollItemInTx(client, p.itemId as number | string, input, {
            userId: identity.userId,
            username: identity.username,
            role: identity.role,
          });
        },
      );
    } catch (err) {
      if (!(err instanceof HrPayrollError) && !staffAdmissionRefusal(err) && input.clientRequestId) {
        const replayed = await runCanonicalReadSnapshot(
          session,
          "hr.payroll.manage",
          (query) => findDisbursementByRequestId(input.clientRequestId!.trim(), query),
          { errorPrefix: "STAFF_READ", maxBytes: HR_SNAPSHOT_MAX_BYTES },
        ).catch(() => null);
        if (replayed) {
          replayed.replayed = true;
          return NextResponse.json(
            { success: true, disbursement: replayed },
            { status: 200, headers: NO_STORE },
          );
        }
      }
      throw err;
    }
    return NextResponse.json(
      { success: true, disbursement },
      { status: disbursement.replayed ? 200 : 201, headers: NO_STORE },
    );
  } catch (error) {
    const refusal = staffAdmissionRefusal(error);
    if (refusal) {
      return NextResponse.json(
        { code: refusal.code, message: refusal.message },
        { status: refusal.status, headers: NO_STORE },
      );
    }
    if (error instanceof HrPayrollError) {
      return NextResponse.json(
        { message: error.message, code: error.code },
        { status: error.status, headers: NO_STORE },
      );
    }
    return NextResponse.json(
      {
        message: "لم تتأكد نتيجة الصرف؛ تحقق أو أعد الطلب نفسه بالمفتاح نفسه.",
        code: "outcome_uncertain",
      },
      { status: 503, headers: NO_STORE },
    );
  }
}

export async function hrPayrollHistoryPreviewGetCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  try {
    if (request.signal?.aborted) {
      throw new HrHistoryError(
        "request_cancelled",
        "أُلغي الطلب؛ لا توجد نتيجة حفظ مؤكدة. تحقق من السجل قبل تغيير الطلب.",
        409,
      );
    }
    const params = new URL(request.url).searchParams;
    if (
      [...params.keys()].some((key) => !["staffId", "from", "to"].includes(key)) ||
      !/^[1-9]\d*$/.test(params.get("staffId") ?? "")
    ) {
      throw new HrHistoryError(
        "invalid_request",
        "اختر الموظف وحدود الفترة فقط؛ لا يقبل الطلب صلاحيات أو قرار تناسب من العميل.",
        400,
      );
    }
    const staffId = Number(params.get("staffId"));
    const from = params.get("from") ?? "";
    const to = params.get("to") ?? "";

    const preview = await runCanonicalReadSnapshot(
      session,
      "hr.payroll.manage",
      async (query) => {
        if (request.signal?.aborted) {
          throw new HrHistoryError(
            "request_cancelled",
            "أُلغي الطلب؛ لا توجد نتيجة حفظ مؤكدة. تحقق من السجل قبل تغيير الطلب.",
            409,
          );
        }
        return readHrPayrollHistoryInSnapshot(query, staffId, from, to);
      },
      { errorPrefix: "STAFF_READ", maxBytes: HR_SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(preview, { headers: NO_STORE });
  } catch (error) {
    return hrCanonTemporalErrorResponse(error);
  }
}

/* ============================================================================
 * 21. /api/hr/reports (GET — hr.reports.view)
 * ============================================================================ */

export async function hrReportsGetCanonicalResponse(
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  try {
    const report = await runCanonicalReadSnapshot(
      session,
      "hr.reports.view",
      (query) => getHrReportSummaryWith(query),
      { errorPrefix: "STAFF_READ", maxBytes: HR_SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(report, { headers: NO_STORE });
  } catch (error) {
    return hrCanonReadErrorResponse(error, "تعذّر استخراج تقارير الموارد البشرية.");
  }
}

/* ============================================================================
 * 22 & 23. /api/hr/settings & /api/hr/settings/history (hr.settings.edit)
 * ============================================================================ */

export async function hrSettingsGetCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  try {
    if (request.signal?.aborted) {
      throw new HrHistoryError(
        "request_cancelled",
        "أُلغي الطلب؛ لا توجد نتيجة حفظ مؤكدة. تحقق من السجل قبل تغيير الطلب.",
        409,
      );
    }
    const settings = await runCanonicalReadSnapshot(
      session,
      "hr.settings.edit",
      async (query) => {
        if (request.signal?.aborted) {
          throw new HrHistoryError(
            "request_cancelled",
            "أُلغي الطلب؛ لا توجد نتيجة حفظ مؤكدة. تحقق من السجل قبل تغيير الطلب.",
            409,
          );
        }
        return getHrSettings(query);
      },
      { errorPrefix: "STAFF_READ", maxBytes: HR_SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(settings, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof HrHistoryError) return hrCanonTemporalErrorResponse(error);
    return hrCanonReadErrorResponse(error, "تعذّر جلب إعدادات الموارد البشرية.");
  }
}

export async function hrSettingsPatchCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    return (
      bodyErrorResponse(error) ??
      NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE })
    );
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE });
  }
  const patch = body as Partial<HrSettings>;

  try {
    const updated = await withStaffOperation(
      getPool(),
      session,
      "hr.settings.edit",
      async (client, handle) => {
        const identity = await staffOperationIdentity(client, handle, "hr.settings.edit");
        return updateHrSettingsInTx(client, patch, {
          username: identity.username,
          role: identity.role,
        });
      },
    );
    return NextResponse.json(updated, { headers: NO_STORE });
  } catch (error) {
    return hrCanonDomainWriteErrorResponse(error, "تعذّر حفظ إعدادات الموارد البشرية.", 500);
  }
}

export async function hrSettingsHistoryGetCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  try {
    if (request.signal?.aborted) {
      throw new HrHistoryError(
        "request_cancelled",
        "أُلغي الطلب؛ لا توجد نتيجة حفظ مؤكدة. تحقق من السجل قبل تغيير الطلب.",
        409,
      );
    }
    const payload = await runCanonicalReadSnapshot(
      session,
      "hr.settings.edit",
      async (query) => {
        if (request.signal?.aborted) {
          throw new HrHistoryError(
            "request_cancelled",
            "أُلغي الطلب؛ لا توجد نتيجة حفظ مؤكدة. تحقق من السجل قبل تغيير الطلب.",
            409,
          );
        }
        return {
          activation: "documented_only" as const,
          policies: await readHrPolicyHistories(query),
          warning: "شروط موثقة وليست معادلات مالية؛ غياب السياسة أو اعتمادها يبقى غير محسوم.",
        };
      },
      { errorPrefix: "STAFF_READ", maxBytes: HR_SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(payload, { headers: NO_STORE });
  } catch (error) {
    return hrCanonTemporalErrorResponse(error);
  }
}
