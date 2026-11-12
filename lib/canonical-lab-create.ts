import "server-only";
import { createHash } from "node:crypto";
import { CLINIC_TIME_ZONE, createLabOrderOn, getLabOrderWith, getPool, insertAuditRow, patientInDoctorScopeWith, type DbClient } from "./db";
import { DEFAULT_LAB_DAYS, PENDING_LAB_NAME, labToothInputProblem, parseLabTeeth } from "./lab";
import { parseLabShadeSpecification, type LabShadeSpecification } from "./lab-shades";
import { LabOrderPricingConflict } from "./lab-order-pricing";
import { CLINIC_BASE_CURRENCY } from "./money";
import { toWhatsAppNumber } from "./reminders";
import { addDays, clinicDateString } from "./schedule";
import { clinicalLabOrder } from "./canonical-lab-reads";
import type { VerifiedDurableSession } from "./staff-durable-session";
import {
  staffOperationCapabilities, staffOperationClinician, staffOperationIdentity, staffOperationPatientScope, withStaffOperation,
} from "./staff-operation-runtime";

/**
 * Canonical lab-order creation (M2 slice 68): POST /api/lab.
 *
 * - One admitted `clinical.lab.order` transaction (READ COMMITTED). The patient must be
 *   inside the actor's patient scope (`own` = DOCTOR_PATIENT_CONDITION; outside or
 *   missing answer alike; `none` refused). The legacy route checked no patient access.
 * - Duplicate prevention: a `requestKey` is required (one per form submission). Under a
 *   transaction advisory lock on (actor, key), the receipt — the `lab_order.create` audit
 *   row of the same transaction, carrying the key and a fingerprint of the normalised
 *   request — is looked up first (bounded to RECEIPT_WINDOW):
 *     same key + same request  → the existing order is returned (`replayed: true`);
 *     same key + another request → 409 `lab_request_key_reused`, nothing written.
 *   A double press, a concurrent retry or a retry after a lost response therefore never
 *   creates a second order; a failed attempt commits nothing, so its retry creates once.
 *   No schema change: the receipt is the atomic audit row.
 * - The visit/tooth unique index still answers a second order for the same tooth in the
 *   same visit (409 `lab_order_exists`).
 * - Money and posting: explicit cost, currency, expense category, accounts and posting
 *   flags are REFUSED (409 `lab_money_not_canonical`) until a reviewed finance slice; the
 *   only money effect is the legacy automatic price from the lab's pricing rules in force
 *   (no user-entered amount), with the legacy default accounts and posting.
 * - The lab must be an existing active lab party (the legacy route created a new party
 *   from free text — a directory write that belongs to clinical.laboratories.manage).
 * - A clinician-linked actor orders in its own name (the legacy doctor binding); others
 *   name an active doctor. A visit must belong to the patient.
 * - The response is the clinical projection unless finance.cost-prices.view.
 */
export class CanonicalLabCreateRefusal extends Error {
  constructor(
    readonly code: "invalid_lab_order" | "lab_patient_not_found" | "lab_money_not_canonical" | "lab_request_key_reused"
      | "lab_request_key_used" | "lab_order_exists" | "lab_party_unavailable" | "lab_doctor_unavailable" | "lab_service_unavailable"
      | "lab_doctor_forbidden" | "lab_pricing_conflict",
    readonly status: 400 | 403 | 404 | 409,
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "CanonicalLabCreateRefusal";
  }
}

/** How long a request key's receipt answers a retry. Clients use one key per submission. */
export const RECEIPT_WINDOW = "1 day";
const MONEY_FIELDS = ["cost", "costCurrency", "expenseCategoryId", "expenseAccountCode", "payableAccountCode", "isPosted"] as const;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const KEY_PATTERN = /^[A-Za-z0-9_-]{16,80}$/;
const invalid = (message: string, field?: string) => new CanonicalLabCreateRefusal("invalid_lab_order", 400, message, field);

function realDate(raw: unknown, field: string): string {
  if (typeof raw !== "string" || !DATE_PATTERN.test(raw)) throw invalid("تاريخ غير صالح.", field);
  const date = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw) throw invalid("تاريخ غير صالح.", field);
  return raw;
}
const text = (raw: unknown, max: number) => typeof raw === "string" && raw.trim() ? raw.trim().slice(0, max) : null;
function positiveId(raw: unknown, field: string, message: string): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const value = typeof raw === "number" ? raw : typeof raw === "string" && /^[1-9][0-9]{0,9}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647) throw invalid(message, field);
  return value;
}

/** JSON with object keys sorted at every depth (a replacer array would drop nested keys). */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export interface CanonicalLabCreateRequest {
  readonly requestKey: string;
  readonly fingerprint: string;
  readonly patientId: number;
  readonly quickNeeded: boolean;
  readonly visitId: number | null;
  readonly toothCode: number | null;
  readonly workType: string;
  readonly partyId: number | null;
  readonly labPhone: string | null;
  readonly sentDate: string | null;
  readonly dueDate: string | null;
  readonly details: string | null;
  readonly note: string | null;
  readonly labServiceId: number | null;
  readonly doctorId: number | null;
  readonly toothNumbers: string | null;
  readonly shadeSpecification: LabShadeSpecification | null;
  readonly shade: string | null;
  readonly stumpShade: string | null;
  readonly priority: "normal" | "urgent" | "rush";
  readonly impressionType: "physical" | "digital_scan" | "alginate" | "silicone" | "other";
  readonly technicianName: string | null;
  readonly source: "auto" | "manual";
}

/** Validate and normalise the body (no database). The fingerprint covers every field
 * that shapes the order, so a reused key with a different request is detected. */
export function parseCanonicalLabCreate(body: Record<string, unknown>): CanonicalLabCreateRequest {
  for (const field of MONEY_FIELDS) {
    const value = body[field];
    if (value !== undefined && value !== null && value !== "") {
      throw new CanonicalLabCreateRefusal("lab_money_not_canonical", 409,
        "التكلفة والربط المحاسبي والترحيل عند الإنشاء لم تُنقل بعد إلى الهوية الموحّدة؛ أنشئ الطلب دونها، وتُحسب التكلفة من قواعد تسعير المختبر إن وُجدت.", field);
    }
  }
  const requestKey = typeof body.requestKey === "string" ? body.requestKey : "";
  if (!KEY_PATTERN.test(requestKey)) throw invalid("مفتاح الطلب مفقود أو غير صالح؛ أعد فتح النموذج.", "requestKey");
  const patientId = positiveId(body.patientId, "patientId", "اختر المريض أولًا.");
  if (patientId === null) throw invalid("اختر المريض أولًا.", "patientId");
  const visitId = positiveId(body.visitId, "visitId", "رقم الزيارة غير صالح.");
  const toothCode = positiveId(body.toothCode, "toothCode", "رقم السن غير صالح.");
  const quickNeeded = body.status === "needed" && visitId !== null;
  const workType = typeof body.workType === "string" ? body.workType.trim() : "";
  if (!workType || workType.length > 80) throw invalid("اختر نوع العمل.", "workType");
  const partyId = positiveId(body.partyId, "partyId", "اختر المختبر من الدليل.");
  let sentDate: string | null = null, dueDate: string | null = null;
  if (!quickNeeded) {
    if (partyId === null) throw invalid("اختر المختبر من الدليل.", "partyId");
    sentDate = realDate(body.sentDate, "sentDate");
    dueDate = realDate(body.dueDate, "dueDate");
    // A due date before dispatch makes the work late the moment it is created.
    if (dueDate < sentDate) throw invalid("موعد التسليم قبل تاريخ الإرسال.", "dueDate");
  }
  const rawPhone = text(body.labPhone, 30);
  const labPhone = rawPhone ? toWhatsAppNumber(rawPhone) ?? rawPhone : null;
  const toothNumbers = typeof body.toothNumbers === "string" && body.toothNumbers.trim() ? body.toothNumbers.trim() : null;
  const toothProblem = labToothInputProblem(toothNumbers, workType);
  if (toothProblem) throw invalid(toothProblem, "toothNumbers");
  const shade = parseLabShadeSpecification(body.shadeSpecification ?? null, Object.keys(parseLabTeeth(toothNumbers)).map(Number));
  if (!shade.ok) throw invalid(shade.error, "shadeSpecification");
  if (typeof body.shade === "string" && body.shade.length > 30) throw invalid("رمز اللون العام أطول من الحد المسموح.", "shade");
  const doctorId = positiveId(body.doctorId, "doctorId", "اختر طبيبًا صحيحًا للإرسالية.");
  const labServiceId = positiveId(body.labServiceId, "labServiceId", "خدمة المختبر غير صالحة.");
  const priority = body.priority === "urgent" || body.priority === "rush" ? body.priority : "normal";
  const impressionType = body.impressionType === "digital_scan" || body.impressionType === "alginate" || body.impressionType === "silicone" || body.impressionType === "other"
    ? body.impressionType : "physical";
  const request = {
    patientId, quickNeeded, visitId, toothCode, workType, partyId, labPhone, sentDate, dueDate,
    details: text(body.details, 300), note: text(body.note, 300), labServiceId, doctorId, toothNumbers,
    shadeSpecification: shade.value, shade: typeof body.shade === "string" && body.shade ? body.shade.slice(0, 30) : null,
    stumpShade: typeof body.stumpShade === "string" && body.stumpShade ? body.stumpShade.slice(0, 30) : null,
    priority, impressionType, technicianName: text(body.technicianName, 80),
    source: body.source === "auto" ? "auto" : "manual",
  } as const;
  const fingerprint = createHash("sha256").update(stableJson(request)).digest("hex");
  return { requestKey, fingerprint, ...request };
}

async function projected(client: DbClient, handle: Parameters<typeof staffOperationCapabilities>[1], id: number) {
  const order = await getLabOrderWith(client, id);
  if (!order) return null;
  const costs = (await staffOperationCapabilities(client, handle, "clinical.lab.order", ["finance.cost-prices.view"] as const)).has("finance.cost-prices.view");
  return { order: costs ? order : clinicalLabOrder(order), projection: { costs } };
}

export async function commandCanonicalLabCreate(session: VerifiedDurableSession, body: Record<string, unknown>, pool = getPool()) {
  const request = parseCanonicalLabCreate(body);
  return withStaffOperation(pool, session, "clinical.lab.order", async (client, handle) => {
    const scope = await staffOperationPatientScope(client, handle, "clinical.lab.order");
    if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    const identity = await staffOperationIdentity(client, handle, "clinical.lab.order");
    // One request key at a time per actor: a concurrent duplicate waits here, then reads
    // the first one's committed receipt (READ COMMITTED: each statement sees new commits).
    await client.query("SELECT pg_advisory_xact_lock(hashtext('lab-order-create:' || $1::text || ':' || $2::text))", [identity.userId, request.requestKey]);
    const { rows: [receipt] } = await client.query<{ entity_id: string; fingerprint: string | null }>(
      `SELECT entity_id, details->>'requestFingerprint' AS fingerprint FROM audit_log
        WHERE action = 'lab_order.create' AND created_at > NOW() - $3::interval
          AND details->>'requestKey' = $1 AND details->>'requestActorId' = $2::text
        ORDER BY id DESC LIMIT 1`,
      [request.requestKey, identity.userId, RECEIPT_WINDOW]);
    if (receipt) {
      if (receipt.fingerprint !== request.fingerprint) {
        throw new CanonicalLabCreateRefusal("lab_request_key_reused", 409, "مفتاح الطلب استُعمل لطلب مختلف؛ أعد فتح النموذج وأرسل من جديد.");
      }
      const existing = await projected(client, handle, Number(receipt.entity_id));
      if (!existing) throw new CanonicalLabCreateRefusal("lab_request_key_used", 409, "الطلب السابق بهذا المفتاح لم يعد موجودًا؛ راجع القائمة قبل إنشاء طلب جديد.");
      // A replay still respects the actor's CURRENT patient scope (the patient may have moved).
      if (scope.kind === "own" && !await patientInDoctorScopeWith(client, scope.clinicianPartyId, existing.order.patientId)) {
        throw new CanonicalLabCreateRefusal("lab_patient_not_found", 404, "المريض غير موجود أو خارج نطاقك.");
      }
      return { ...existing, replayed: true as const };
    }

    // The patient: inside the scope (missing and outside answer alike), kept for the write.
    const { rows: [patient] } = await client.query<{ id: number }>("SELECT id FROM patients WHERE id = $1 FOR SHARE", [request.patientId]);
    const inside = patient && (scope.kind === "all" || await patientInDoctorScopeWith(client, scope.clinicianPartyId, request.patientId));
    if (!inside) throw new CanonicalLabCreateRefusal("lab_patient_not_found", 404, "المريض غير موجود أو خارج نطاقك.");

    if (request.visitId !== null) {
      const { rows: [visit] } = await client.query<{ patient_id: number }>("SELECT patient_id FROM visits WHERE id = $1 FOR SHARE", [request.visitId]);
      if (!visit || visit.patient_id !== request.patientId) throw invalid("الزيارة لا تخص هذا المريض.", "visitId");
    }

    // A clinician-linked actor orders in its own name (the legacy doctor binding).
    const clinician = await staffOperationClinician(client, handle, "clinical.lab.order");
    if (clinician !== null && request.doctorId !== null && request.doctorId !== clinician) {
      throw new CanonicalLabCreateRefusal("lab_doctor_forbidden", 403, "لا يمكن إرسال العمل باسم طبيب آخر من هذا الحساب.", "doctorId");
    }
    const doctorId = clinician ?? request.doctorId;
    if (!request.quickNeeded && doctorId === null) throw invalid("حدّد الطبيب المعالج قبل إرسال العمل إلى المختبر.", "doctorId");
    if (doctorId !== null) {
      const { rows: [doctor] } = await client.query<{ ok: boolean }>("SELECT (kind = 'doctor' AND is_active) AS ok FROM parties WHERE id = $1 FOR SHARE", [doctorId]);
      if (!doctor?.ok) throw new CanonicalLabCreateRefusal("lab_doctor_unavailable", 409, "الطبيب غير متاح أو غير نشط؛ حدّد طبيبًا نشطًا.", "doctorId");
    }

    let labName = PENDING_LAB_NAME, labPhone = request.labPhone;
    if (request.partyId !== null) {
      const { rows: [party] } = await client.query<{ name: string; phone: string | null; ok: boolean }>(
        "SELECT name, phone, (kind = 'lab' AND is_active) AS ok FROM parties WHERE id = $1 FOR SHARE", [request.partyId]);
      if (!party?.ok) throw new CanonicalLabCreateRefusal("lab_party_unavailable", 409, "المختبر غير موجود في الدليل أو غير نشط؛ اختر مختبرًا نشطًا.", "partyId");
      labName = party.name;
      labPhone = labPhone ?? party.phone;
    }
    if (request.labServiceId !== null) {
      const { rows: [service] } = await client.query<{ name: string; code: string | null; is_active: boolean }>(
        "SELECT name, code, is_active FROM lab_services WHERE id = $1 FOR SHARE", [request.labServiceId]);
      if (!service?.is_active) throw new CanonicalLabCreateRefusal("lab_service_unavailable", 409, "خدمة المختبر غير متاحة؛ أعد اختيار الخدمة.", "labServiceId");
      const problem = labToothInputProblem(request.toothNumbers, service.name, service.code);
      if (problem) throw invalid(problem, "toothNumbers");
    }

    const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
    let orderId: number | null;
    try {
      orderId = await createLabOrderOn(client, {
        patientId: request.patientId, labName, labPhone, workType: request.workType, details: request.details,
        sentDate: request.sentDate ?? today, dueDate: request.dueDate ?? addDays(today, DEFAULT_LAB_DAYS), note: request.note,
        partyId: request.partyId, costMinor: null, costCurrency: null, baseCurrency: CLINIC_BASE_CURRENCY, exchangeRate: 1,
        createdBy: identity.username, actorRole: identity.role,
        visitId: request.visitId, toothCode: request.toothCode, source: request.source,
        status: request.quickNeeded ? "needed" : "sent",
        labServiceId: request.labServiceId, doctorId, toothNumbers: request.toothNumbers,
        shadeSpecification: request.shadeSpecification, shade: request.shade, stumpShade: request.stumpShade,
        priority: request.priority, impressionType: request.impressionType, technicianName: request.technicianName,
      });
    } catch (error) {
      if (error instanceof LabOrderPricingConflict) throw new CanonicalLabCreateRefusal("lab_pricing_conflict", 409, error.message);
      throw error;
    }
    if (orderId === null) {
      throw new CanonicalLabCreateRefusal("lab_order_exists", 409, "طلب مختبر مسجَّل سلفًا لهذا السن في هذه الزيارة.");
    }
    const order = await getLabOrderWith(client, orderId);
    if (!order) throw new Error("LAB_ORDER_CREATE_LOST");
    // The receipt: the audit row of this transaction carries the key and fingerprint.
    await insertAuditRow(client, {
      action: "lab_order.create", entity: "lab_order", entityId: String(orderId),
      entityLabel: `أمر معمل: ${order.patientName} (${order.labName})`,
      details: {
        العمل: order.workType, الموعد: order.dueDate, المصدر: request.source,
        ...(order.costMinor != null ? { التكلفة: order.costMinor, العملة: order.costCurrency ?? null } : {}),
        requestKey: request.requestKey, requestFingerprint: request.fingerprint, requestActorId: String(identity.userId),
      },
      actor: identity.username, actorRole: identity.role,
    });
    const result = await projected(client, handle, orderId);
    return { ...result!, replayed: false as const };
  });
}
