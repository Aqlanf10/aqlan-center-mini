import "server-only";
import { NextResponse } from "next/server";
import { CLINIC_ZONE_FALLBACK } from "./clinicZone";
import { canonicalPatientReadFailure, NO_STORE } from "./canonical-patient-http";
import { runCanonicalReadSnapshot } from "./canonical-read-snapshot";
import {
  CLINIC_TIME_ZONE,
  createLabOrderInTransaction,
  createLabOrderRemakeInTransaction,
  createLaboratoryWith,
  createLabPricingRuleWith,
  createLabServiceWith,
  deleteLabOrderInTransaction,
  deleteLaboratoryWith,
  deleteLabPricingRuleWith,
  deleteLabServiceWith,
  getLaboratoryWith,
  getLabOrderByIdWith,
  getLabServiceWith,
  getPool,
  getSettingsWith,
  insertAuditRow,
  labCountsWith,
  labOrderEventsWith,
  listLabNamesWith,
  listLaboratoriesWith,
  listLabOrdersWith,
  listLabPricingRulesWith,
  listLabServicesWith,
  listPartiesWith,
  patientInDoctorScopeWith,
  resolveLabOrderPriceWith,
  seedLabServicesCatalogWith,
  setLabOrderDueDateInTransaction,
  setLabOrderStatusInTransaction,
  updateLabOrderAccountingInTransaction,
  updateLabOrderClinicalInTransaction,
  updateLabOrderShadesInTransaction,
  updateLaboratoryWith,
  updateLabPricingRuleWith,
  updateLabServiceWith,
  type DbClient,
  type DbPool,
} from "./db";
import {
  DEFAULT_LAB_DAYS,
  PENDING_LAB_NAME,
  labToothInputProblem,
  parseLabTeeth,
  type LabImpressionType,
  type LabOrder,
  type LabOrderPriority,
  type LabOrderStatus,
  type LabServiceCategory,
  type LabToothScope,
} from "./lab";
import { isLabAccountingRate } from "./lab-accounting-edit";
import {
  decodeLabBacklog,
  LAB_BACKLOG_PAGE_SIZE,
  parseLabBacklogQuery,
  type LabBacklogSnapshot,
} from "./lab-backlog";
import { LAB_BACKLOG_SQL } from "./lab-backlog-db";
import { labClinicalEditProblem, parseLabClinicalSnapshot } from "./lab-clinical-edit";
import { LabFinancialBoundaryError } from "./lab-financial-boundary";
import { LabOrderPricingConflict } from "./lab-order-pricing";
import {
  assertAutoLabSource,
  assertExplicitLabSource,
  labPrescriptionVersion,
  validateLabPrescription,
} from "./lab-prescription-input";
import { LabPrescriptionError } from "./lab-prescription-write";
import { LAB_READINESS_STATUSES } from "./lab-readiness";
import { parseLabShadeSpecification } from "./lab-shades";
import { labWorkIntentSupported } from "./lab-work-intent-db";
import { CLINIC_BASE_CURRENCY, isCurrency, parseAmount, type Currency } from "./money";
import { toWhatsAppNumber } from "./reminders";
import { addDays, clinicDateString } from "./schedule";
import { rateFromSettings } from "./settings";
import { staffAdmissionRefusal } from "./staff-capability-editor";
import type { VerifiedDurableSession } from "./staff-durable-session";
import {
  staffOperationCapabilities,
  staffOperationClinician,
  staffOperationIdentity,
  staffOperationPatientScope,
  withStaffOperation,
  type StaffOperationHandle,
  type StaffRuntimeAction,
} from "./staff-operation-runtime";

/**
 * Canonical Laboratory & Laboratories Directory (M2 slice 33).
 *
 * Reads run inside one owning REPEATABLE READ READ ONLY snapshot (`runCanonicalReadSnapshot`):
 *  - `GET /api/lab?summary=1`: exact capability `clinical.lab.view`.
 *  - `GET /api/lab`: registered record read `read:lab.orders` (`clinical.lab.view` + patient scope);
 *    cost fields (`costMinor`, `costCurrency`, `baseAmountMinor`, `exchangeRate`, `payableId`) are
 *    projected only when `finance.cost-prices.view` (or `finance.payables.record`) is held.
 *  - `GET /api/lab/backlog`: registered record read `read:lab.backlog` + whole-clinic patient scope
 *    (`scope.patientScope.kind === "all"`), passing `scope.userId` for task privacy.
 *  - `GET /api/lab/pricing`, `GET /api/lab/services`, `GET /api/lab/services/[id]`,
 *    `GET /api/laboratories`, `GET /api/laboratories/[id]`: exact capability `clinical.lab.view`.
 *  - `GET /api/lab/work-intents/capability`: exact capability `clinical.lab.order`, returning
 *    `{ supported: boolean }` with structured `{ supported: false, message }` refusals.
 *
 * Writes run inside `withStaffOperation` (READ COMMITTED, shared identity lifecycle fence,
 * FOR SHARE authority proof, atomic `insertAuditRow`):
 *  - `POST /api/lab`: `clinical.lab.order` + patient scope + own-clinician binding.
 *  - `PATCH /api/lab/[id]`: branch-specific capabilities (`complete_prescription`:
 *    `clinical.visits.document` + `clinical.lab.order`; `events`: `read:lab.orders`;
 *    `post` / `unpost` / `update_accounting`: `finance.payables.record`; `remake` /
 *    `update_clinical` / `update_shade` / `dueDate` / `status`: `clinical.lab.order`, with
 *    `clinical.lab.cancel` required to cancel an already-dispatched order).
 *  - `DELETE /api/lab/[id]`: `clinical.lab.cancel` + patient scope + mandatory audit reason.
 *  - `POST / PUT / DELETE /api/lab/pricing*`, `POST / PATCH / DELETE /api/lab/services*`:
 *    `finance.lab-prices.edit`.
 *  - `POST / PATCH / DELETE /api/laboratories*`: `clinical.laboratories.manage`.
 */

const LAB_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES: readonly LabOrderStatus[] = Object.freeze([
  "needed",
  "sent",
  "in_progress",
  "received",
  "delivered",
  "remake",
  "cancelled",
]);

export class CanonicalLabRefusal extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 500 | 503,
    message: string,
    readonly includeCode = true,
  ) {
    super(message);
    this.name = "CanonicalLabRefusal";
  }
}

function projectLabOrderCosts<
  T extends {
    costMinor?: number | null;
    costCurrency?: Currency | null;
    baseAmountMinor?: number | null;
    exchangeRate?: number | null;
    payableId?: number | null;
  },
>(order: T, canViewCosts: boolean): T {
  if (canViewCosts) return order;
  return {
    ...order,
    costMinor: null,
    costCurrency: null,
    baseAmountMinor: null,
    exchangeRate: null,
    payableId: null,
  };
}

export function canonicalLabFailure(error: unknown, fallback: string): NextResponse {
  if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "55P03") {
    return NextResponse.json(
      { code: "lab_status_busy", message: "يوجد تحديث جارٍ؛ حدّث الإرسالية وأعد المحاولة." },
      { status: 409, headers: NO_STORE },
    );
  }
  if (error instanceof LabFinancialBoundaryError) {
    const status = error.code.endsWith("_forbidden") ? 403 : error.status;
    const boundaryMessages: Record<string, string> = {
      lab_settled_money_review:
        "للإرسالية أثر سداد؛ لا يمكن تغيير بياناتها المالية. راجع التسوية المحاسبية دون تعديل المدفوعات السابقة.",
      lab_accounting_money_review:
        "لا يمكن تصفير أو مسح التزام قائم أو تبديل عملته دون مبلغ كامل معتمد؛ راجع التصحيح المالي. لم يتغير شيء.",
      lab_payable_link_review:
        "ربط الالتزام المالي للإرسالية غير متسق؛ راجعه قبل التعديل.",
    };
    const message =
      error.message.startsWith("lab_order_") && boundaryMessages[error.code]
        ? boundaryMessages[error.code]
        : error.message;
    return NextResponse.json({ code: error.code, message }, { status, headers: NO_STORE });
  }
  if (error instanceof LabPrescriptionError) {
    return NextResponse.json({ message: error.message }, { status: error.status, headers: NO_STORE });
  }
  if (error instanceof LabOrderPricingConflict) {
    return NextResponse.json({ code: error.code, message: error.message }, { status: 409, headers: NO_STORE });
  }
  if (error instanceof CanonicalLabRefusal) {
    return NextResponse.json(
      { ...(error.includeCode ? { code: error.code } : {}), message: error.message },
      { status: error.status, headers: NO_STORE },
    );
  }
  const code = error instanceof Error ? error.message : "";
  if (code === "lab_order_accounting_price_invalid") {
    return NextResponse.json(
      {
        code,
        message: "التكلفة المعدّلة يجب أن تكون مبلغًا موجبًا؛ لا يمكن مسح الالتزام المالي من هذا الإجراء.",
      },
      { status: 400, headers: NO_STORE },
    );
  }
  if (code === "lab_order_exchange_rate_invalid") {
    return NextResponse.json(
      { code: "lab_accounting_rate_invalid", message: "سعر صرف عملة التكلفة غير صالح؛ راجع الإعدادات قبل الحفظ." },
      { status: 409, headers: NO_STORE },
    );
  }
  const accountingConflicts: Record<string, string> = {
    lab_order_accounting_settled:
      "للإرسالية أثر سداد؛ لا يمكن تغيير بياناتها المالية. راجع التسوية المحاسبية دون تعديل المدفوعات السابقة.",
    lab_order_accounting_period_locked:
      "الفترة المالية للإرسالية مقفلة؛ لا يمكن تعديل بياناتها المالية.",
    lab_order_accounting_busy:
      "تُحدّث بيانات الإرسالية أو سدادها الآن؛ أعد تحميلها ثم حاول مجددًا.",
    lab_order_accounting_link_invalid:
      "ربط الالتزام المالي للإرسالية غير متسق؛ راجعه قبل التعديل.",
  };
  if (accountingConflicts[code]) {
    return NextResponse.json({ code, message: accountingConflicts[code] }, { status: 409, headers: NO_STORE });
  }
  return canonicalPatientReadFailure(error, fallback);
}

async function assertPatientInLabScope(
  client: DbClient,
  handle: StaffOperationHandle,
  action: StaffRuntimeAction,
  patientId: number,
  forbiddenMessage: string,
  notFoundMessage = "المريض غير موجود.",
) {
  const patientScope = await staffOperationPatientScope(client, handle, action);
  if (patientScope.kind === "none") {
    throw new CanonicalLabRefusal("lab_patient_forbidden", 403, forbiddenMessage);
  }
  const {
    rows: [patientRow],
  } = await client.query<{ id: number }>("SELECT id FROM patients WHERE id = $1 FOR KEY SHARE", [patientId]);
  if (!patientRow) {
    if (patientScope.kind === "own") {
      throw new CanonicalLabRefusal("lab_patient_forbidden", 403, forbiddenMessage);
    }
    throw new CanonicalLabRefusal("patient_not_found", 404, notFoundMessage);
  }
  if (
    patientScope.kind === "own"
    && !(await patientInDoctorScopeWith(client, patientScope.clinicianPartyId, patientId))
  ) {
    throw new CanonicalLabRefusal("lab_patient_forbidden", 403, forbiddenMessage);
  }
  return patientScope;
}

// ─── GET / POST /api/lab ─────────────────────────────────────────────────────

export async function readCanonicalLabResponse(
  session: VerifiedDurableSession,
  request: Request,
): Promise<NextResponse> {
  const url = new URL(request.url);
  const summaryOnly = url.searchParams.get("summary") === "1";
  const patientIdRaw = url.searchParams.get("patientId");
  const patientId = patientIdRaw ? Number(patientIdRaw) : null;
  const patientFilter = patientId && Number.isInteger(patientId) ? patientId : null;
  const patientOutOfRange =
    patientFilter !== null && (patientFilter < -2_147_483_648 || patientFilter > 2_147_483_647);
  const withServices = url.searchParams.get("services") === "1";

  try {
    if (summaryOnly) {
      const counts = await runCanonicalReadSnapshot(
        session,
        "clinical.lab.view",
        async (query, scope) => {
          if (scope.patientScope.kind === "none") {
            throw new CanonicalLabRefusal("patient_scope_denied", 403, "نطاق وصولك للمرضى مغلق.");
          }
          return labCountsWith(
            query,
            scope.patientScope.kind === "own"
              ? { scopedDoctorPartyId: scope.patientScope.clinicianPartyId }
              : undefined,
          );
        },
        { errorPrefix: "STAFF_READ", maxBytes: LAB_SNAPSHOT_MAX_BYTES },
      );
      return NextResponse.json(counts, { headers: NO_STORE });
    }

    const payload = await runCanonicalReadSnapshot(
      session,
      "read:lab.orders",
      async (query, scope) => {
        if (scope.patientScope.kind === "none") {
          throw new CanonicalLabRefusal("patient_scope_denied", 403, "نطاق وصولك للمرضى مغلق.");
        }
        if (
          scope.patientScope.kind === "own"
          && patientFilter !== null
          && !patientOutOfRange
          && patientFilter > 0
        ) {
          if (!(await patientInDoctorScopeWith(query, scope.patientScope.clinicianPartyId, patientFilter))) {
            throw new CanonicalLabRefusal(
              "patient_outside_scope",
              403,
              "غير مصرّح لك بالاطلاع على أعمال المعمل لهذا المريض.",
            );
          }
        }
        const [rawOrders, labs, labServices] = await Promise.all([
          patientOutOfRange
            ? Promise.resolve<LabOrder[]>([])
            : listLabOrdersWith(
                query,
                patientFilter !== null
                  ? { patientId: patientFilter }
                  : scope.patientScope.kind === "own"
                    ? { scopedDoctorPartyId: scope.patientScope.clinicianPartyId }
                    : undefined,
              ),
          listLabNamesWith(query),
          withServices ? listLabServicesWith(query) : Promise.resolve([]),
        ]);
        const canViewCosts =
          scope.granted("finance.cost-prices.view") || scope.granted("finance.payables.record");
        const orders = rawOrders.map((o) => projectLabOrderCosts(o, canViewCosts));
        return { orders, labs, ...(withServices ? { labServices } : {}) };
      },
      { errorPrefix: "STAFF_READ", maxBytes: LAB_SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(payload, { headers: NO_STORE });
  } catch (error) {
    return canonicalLabFailure(error, "تعذّر تحميل أعمال المختبر.");
  }
}

export async function commandCanonicalCreateLabOrderResponse(
  session: VerifiedDurableSession,
  rawBody: unknown,
  pool: DbPool = getPool(),
): Promise<NextResponse> {
  const source = (rawBody ?? {}) as Record<string, unknown>;
  try {
    const created = await withStaffOperation(pool, session, "clinical.lab.order", async (client, handle) => {
      const patientId = Number(source.patientId);
      if (!Number.isInteger(patientId) || patientId <= 0) {
        throw new CanonicalLabRefusal("invalid_lab_input", 400, "اختر المريض أولًا.");
      }
      const patientScope = await assertPatientInLabScope(
        client,
        handle,
        "clinical.lab.order",
        patientId,
        "غير مصرّح لك بإضافة طلب معمل لهذا المريض.",
      );
      const linkedClinicianId = await staffOperationClinician(client, handle, "clinical.lab.order");
      const caps = await staffOperationCapabilities(client, handle, "clinical.lab.order", [
        "finance.cost-prices.view",
        "finance.payables.record",
      ]);
      const identity = await staffOperationIdentity(client, handle, "clinical.lab.order");

      const visitIdRaw = Number(source.visitId);
      const visitId = Number.isInteger(visitIdRaw) && visitIdRaw > 0 ? visitIdRaw : null;
      const toothCodeRaw = Number(source.toothCode);
      const toothCode = Number.isInteger(toothCodeRaw) && toothCodeRaw > 0 ? toothCodeRaw : null;
      const quickNeeded = source.status === "needed" && visitId !== null;

      const workType = typeof source.workType === "string" ? source.workType.trim() : "";
      if (!workType || workType.length > 80) {
        throw new CanonicalLabRefusal("invalid_lab_input", 400, "اختر نوع العمل.");
      }

      const todayISO = clinicDateString(new Date(), CLINIC_ZONE_FALLBACK);
      let labName: string;
      let sentDate: string;
      let dueDate: string;
      if (quickNeeded) {
        labName = PENDING_LAB_NAME;
        sentDate = todayISO;
        dueDate = addDays(todayISO, DEFAULT_LAB_DAYS);
      } else {
        labName = typeof source.labName === "string" ? source.labName.trim() : "";
        if (!labName || labName.length > 80) {
          throw new CanonicalLabRefusal("invalid_lab_input", 400, "اكتب اسم المختبر.");
        }
        sentDate = typeof source.sentDate === "string" ? source.sentDate : "";
        dueDate = typeof source.dueDate === "string" ? source.dueDate : "";
        if (!DATE_PATTERN.test(sentDate) || !DATE_PATTERN.test(dueDate)) {
          throw new CanonicalLabRefusal("invalid_lab_input", 400, "تاريخ غير صالح.");
        }
        if (dueDate < sentDate) {
          throw new CanonicalLabRefusal("invalid_lab_input", 400, "موعد التسليم قبل تاريخ الإرسال.");
        }
      }

      let labPhone: string | null = null;
      if (typeof source.labPhone === "string" && source.labPhone.trim()) {
        labPhone = toWhatsAppNumber(source.labPhone) ?? source.labPhone.trim().slice(0, 30);
      }
      const details =
        typeof source.details === "string" && source.details.trim()
          ? source.details.trim().slice(0, 300)
          : null;
      const note =
        typeof source.note === "string" && source.note.trim() ? source.note.trim().slice(0, 300) : null;

      const settings = await getSettingsWith(client);
      const base = CLINIC_BASE_CURRENCY;
      const partyIdRaw = Number(source.partyId);
      const labParties = new Set((await listPartiesWith(client, "lab")).map((party) => party.id));
      const partyId = Number.isInteger(partyIdRaw) && labParties.has(partyIdRaw) ? partyIdRaw : null;

      let costMinor: number | null = null;
      let costCurrency: Currency | null = null;
      let exchangeRate = 1;
      if (source.cost !== undefined && String(source.cost).trim() !== "") {
        costCurrency = isCurrency(source.costCurrency) ? source.costCurrency : base;
        costMinor = parseAmount(String(source.cost), costCurrency);
        if (costMinor === null || costMinor <= 0) {
          throw new CanonicalLabRefusal("invalid_lab_input", 400, "اكتب تكلفة صحيحة أو اتركها فارغة.");
        }
        if (!partyId) {
          throw new CanonicalLabRefusal(
            "invalid_lab_input",
            400,
            "اختر المختبر من قائمة الجهات لتُسجَّل التكلفة عليه.",
          );
        }
        const rate = rateFromSettings(settings, costCurrency, base);
        if (rate === null) {
          throw new CanonicalLabRefusal("lab_exchange_rate_missing", 409, "سعر الصرف غير مضبوط في الإعدادات.");
        }
        exchangeRate = rate;
      }

      const expenseCategoryIdRaw = Number(source.expenseCategoryId);
      const expenseCategoryId =
        Number.isInteger(expenseCategoryIdRaw) && expenseCategoryIdRaw > 0 ? expenseCategoryIdRaw : null;
      const expenseAccountCode =
        typeof source.expenseAccountCode === "string" && source.expenseAccountCode.trim()
          ? source.expenseAccountCode.trim().slice(0, 10)
          : null;
      const payableAccountCode =
        typeof source.payableAccountCode === "string" && source.payableAccountCode.trim()
          ? source.payableAccountCode.trim().slice(0, 10)
          : null;
      const isPosted = source.isPosted !== undefined ? Boolean(source.isPosted) : true;

      const toothNumbers = typeof source.toothNumbers === "string" ? source.toothNumbers.trim() : null;
      const toothProblem = labToothInputProblem(toothNumbers, workType);
      if (toothProblem) {
        throw new CanonicalLabRefusal("invalid_lab_input", 400, toothProblem);
      }
      const shadeResult = parseLabShadeSpecification(
        source.shadeSpecification ?? null,
        Object.keys(parseLabTeeth(toothNumbers)).map(Number),
      );
      if (!shadeResult.ok) {
        throw new CanonicalLabRefusal("invalid_lab_input", 400, shadeResult.error);
      }
      if (typeof source.shade === "string" && source.shade.length > 30) {
        throw new CanonicalLabRefusal("invalid_lab_input", 400, "رمز اللون العام أطول من الحد المسموح.");
      }

      const submittedDoctorId =
        source.doctorId == null || source.doctorId === "" ? null : Number(source.doctorId);
      if (submittedDoctorId !== null && (!Number.isSafeInteger(submittedDoctorId) || submittedDoctorId <= 0)) {
        throw new CanonicalLabRefusal("invalid_lab_input", 400, "اختر طبيبًا صحيحًا للإرسالية.");
      }
      if (
        patientScope.kind === "own"
        && submittedDoctorId !== null
        && submittedDoctorId !== patientScope.clinicianPartyId
      ) {
        throw new CanonicalLabRefusal(
          "doctor_binding_forbidden",
          403,
          "لا يمكن إرسال العمل باسم طبيب آخر من هذا الحساب.",
        );
      }
      const doctorId =
        patientScope.kind === "own"
          ? (submittedDoctorId ?? patientScope.clinicianPartyId)
          : (submittedDoctorId ?? linkedClinicianId);
      if (!quickNeeded && doctorId === null) {
        throw new CanonicalLabRefusal("invalid_lab_input", 400, "حدّد الطبيب المعالج قبل إرسال العمل إلى المختبر.");
      }

      if (doctorId !== null) {
        const doctors = await listPartiesWith(client, "doctor");
        if (!doctors.some((doctor) => doctor.id === doctorId && doctor.kind === "doctor" && doctor.isActive)) {
          throw new CanonicalLabRefusal("doctor_inactive", 409, "الطبيب غير متاح أو غير نشط؛ حدّد طبيبًا نشطًا.");
        }
      }

      const selectedLabServiceId = Number(source.labServiceId);
      if (Number.isSafeInteger(selectedLabServiceId) && selectedLabServiceId > 0) {
        const selectedService = (await listLabServicesWith(client)).find(
          (service) => service.id === selectedLabServiceId && service.isActive,
        );
        if (!selectedService) {
          throw new CanonicalLabRefusal("lab_service_inactive", 409, "خدمة المختبر غير متاحة؛ أعد اختيار الخدمة.");
        }
        const serviceProblem = labToothInputProblem(toothNumbers, selectedService.name, selectedService.code);
        if (serviceProblem) {
          throw new CanonicalLabRefusal("invalid_lab_input", 400, serviceProblem);
        }
      }

      const order = await createLabOrderInTransaction(client, {
        patientId,
        labName,
        labPhone,
        workType,
        details,
        sentDate,
        dueDate,
        note,
        partyId,
        costMinor,
        costCurrency,
        baseCurrency: base,
        exchangeRate,
        createdBy: identity.username,
        visitId,
        toothCode,
        source: source.source === "auto" ? "auto" : "manual",
        status: quickNeeded ? "needed" : "sent",
        labServiceId:
          Number.isInteger(Number(source.labServiceId)) && Number(source.labServiceId) > 0
            ? Number(source.labServiceId)
            : null,
        doctorId,
        toothNumbers,
        shadeSpecification: shadeResult.value,
        shade: typeof source.shade === "string" ? source.shade.slice(0, 30) : null,
        stumpShade: typeof source.stumpShade === "string" ? source.stumpShade.slice(0, 30) : null,
        priority: source.priority === "urgent" || source.priority === "rush" ? source.priority : "normal",
        impressionType:
          source.impressionType === "digital_scan"
          || source.impressionType === "alginate"
          || source.impressionType === "silicone"
          || source.impressionType === "other"
            ? source.impressionType
            : "physical",
        technicianName:
          typeof source.technicianName === "string" && source.technicianName.trim()
            ? source.technicianName.trim().slice(0, 80)
            : null,
        actorRole: identity.role,
        expenseCategoryId,
        expenseAccountCode,
        payableAccountCode,
        isPosted,
      });

      if (!order) {
        if (visitId && toothCode) {
          throw new CanonicalLabRefusal(
            "duplicate_visit_tooth_order",
            409,
            "طلب مختبر مسجَّل سلفًا لهذا السن في هذه الزيارة.",
          );
        }
        throw new CanonicalLabRefusal("lab_create_failed", 500, "تعذّر حفظ العمل.");
      }

      await insertAuditRow(client, {
        action: "lab_order.create",
        entity: "lab_order",
        entityId: String(order.id),
        entityLabel: `أمر معمل: ${order.patientName} (${order.labName})`,
        details: {
          العمل: order.workType,
          الموعد: order.dueDate,
          المصدر: source.source === "auto" ? "auto" : "manual",
          ...(order.costMinor != null ? { التكلفة: order.costMinor, العملة: order.costCurrency ?? null } : {}),
        },
        actor: identity.username,
        actorRole: identity.role,
      });

      const canViewCosts = caps.has("finance.cost-prices.view") || caps.has("finance.payables.record");
      return projectLabOrderCosts(order, canViewCosts);
    });
    return NextResponse.json(created, { status: 201, headers: NO_STORE });
  } catch (error) {
    return canonicalLabFailure(error, "تعذّر حفظ العمل. تأكد من المريض وأعد المحاولة.");
  }
}

// ─── PATCH / DELETE /api/lab/[id] ────────────────────────────────────────────

export async function patchCanonicalLabOrderResponse(
  session: VerifiedDurableSession,
  id: number,
  source: Record<string, unknown>,
  pool: DbPool = getPool(),
): Promise<NextResponse> {
  try {
    // 1. complete_prescription: clinical.visits.document + clinical.lab.order + patient scope
    if (source.action === "complete_prescription") {
      const result = await withStaffOperation(
        pool,
        session,
        "clinical.visits.document",
        async (client, handle) => {
          const caps = await staffOperationCapabilities(client, handle, "clinical.visits.document", [
            "clinical.lab.order",
          ]);
          if (!caps.has("clinical.lab.order")) {
            throw new Error("STAFF_AUTHORITY_CAPABILITY_MISSING");
          }
          const patientScope = await staffOperationPatientScope(client, handle, "clinical.visits.document");
          if (patientScope.kind === "none") {
            throw new LabPrescriptionError("لا تملك صلاحية تعديل هذا الملف.", 403);
          }
          if (typeof source.expected !== "string" || typeof source.dispatch !== "boolean") {
            throw new CanonicalLabRefusal("invalid_prescription", 400, "بيانات مراجعة الطلب غير صالحة.");
          }
          let input;
          try {
            input = validateLabPrescription(source.prescription, source.dispatch);
          } catch (error) {
            throw new CanonicalLabRefusal(
              "invalid_prescription",
              400,
              error instanceof Error ? error.message : "بيانات غير صالحة.",
            );
          }
          const expected = source.expected;
          const dispatch = source.dispatch;
          try {
            await client.query("LOCK TABLE lab_orders IN ROW EXCLUSIVE MODE NOWAIT");
          } catch (error) {
            if ((error as { code?: string }).code === "55P03") {
              throw new LabPrescriptionError("يوجد تحديث سريري جارٍ؛ أعد المحاولة بعد تحديث البيانات.", 409);
            }
            throw error;
          }
          const identity = await staffOperationIdentity(client, handle, "clinical.visits.document");
          const { rows } = await client.query<{
            patient_id: number;
            status: string;
            party_id: number | null;
            shade: string | null;
            stump_shade: string | null;
            tooth_numbers: string | null;
            due_date: string;
            impression_type: LabImpressionType | null;
            priority: LabOrderPriority | null;
            payable_id: number | null;
            cost_minor: string | null;
            source: "auto" | "manual" | null;
            tooth_code: number | null;
            work_type: string;
            visit_id: number | null;
          }>(
            `SELECT patient_id, status, party_id, shade, stump_shade, tooth_numbers, due_date::text,
                    impression_type, priority, payable_id, cost_minor, source, tooth_code, work_type, visit_id
               FROM lab_orders WHERE id = $1 FOR UPDATE`,
            [id],
          );
          const row = rows[0];
          if (!row) throw new LabPrescriptionError("الطلب غير موجود.", 404);
          const patientLock = await client.query("SELECT id FROM patients WHERE id = $1 FOR KEY SHARE NOWAIT", [
            row.patient_id,
          ]);
          if (
            !patientLock.rows[0]
            || (patientScope.kind === "own"
              && !(await patientInDoctorScopeWith(client, patientScope.clinicianPartyId, row.patient_id)))
          ) {
            throw new LabPrescriptionError("لا تملك صلاحية تعديل هذا الملف.", 403);
          }
          if (row.status !== "needed") {
            throw new LabPrescriptionError(
              "تغيّرت حالة الطلب؛ حدّث القائمة. تعديل الإرسالية متاح قبل الإرسال فقط.",
              409,
            );
          }
          const version = labPrescriptionVersion({
            status: row.status,
            partyId: row.party_id,
            shade: row.shade,
            stumpShade: row.stump_shade,
            toothNumbers: row.tooth_numbers,
            dueDate: row.due_date,
            impressionType: row.impression_type ?? "physical",
            priority: row.priority ?? "normal",
            workType: row.work_type,
            source: row.source,
            toothCode: row.tooth_code,
            visitId: row.visit_id,
          });
          if (expected !== version) {
            throw new LabPrescriptionError("تغيّرت بيانات الطلب؛ أغلق النموذج وحدّث القائمة قبل المحاولة.", 409);
          }
          try {
            assertAutoLabSource(input, row);
          } catch (error) {
            throw new LabPrescriptionError(
              error instanceof Error ? error.message : "نطاق الإرسالية لا يطابق المصدر.",
              409,
            );
          }
          let storedToothNumbers = input.toothNumbers;
          if (await labWorkIntentSupported(client)) {
            const explicit = await client.query<{
              tooth_code: number;
              prescription: { toothNumbers?: string };
            }>(
              `SELECT m.tooth_code, i.prescription
                 FROM lab_work_intents i
                 JOIN lab_work_members m ON m.intent_id = i.id AND m.retired_revision IS NULL
                WHERE i.initial_order_id = $1`,
              [id],
            );
            if (explicit.rows.length) {
              const sourceCodes = explicit.rows.flatMap((member) => [
                member.tooth_code,
                ...(member.prescription.toothNumbers ?? "")
                  .split(",")
                  .filter(Boolean)
                  .map((part) => Number(part.trim().slice(0, 2))),
              ]);
              try {
                storedToothNumbers = assertExplicitLabSource(input, sourceCodes, row.work_type);
              } catch (error) {
                throw new LabPrescriptionError(
                  error instanceof Error ? error.message : "نطاق المصدر غير صالح.",
                  409,
                );
              }
            }
          }
          if (row.party_id !== input.partyId && (row.payable_id || row.cost_minor !== null)) {
            throw new LabPrescriptionError(
              "هذا الطلب مرتبط بتكلفة؛ راجع الربط المحاسبي قبل تغيير المختبر.",
              409,
            );
          }
          const { rows: labs } =
            input.partyId === null
              ? { rows: [{ name: PENDING_LAB_NAME, phone: null as string | null }] }
              : await client.query<{ name: string; phone: string | null }>(
                  `SELECT name, phone FROM parties WHERE id = $1 AND kind = 'lab' AND is_active = TRUE FOR SHARE`,
                  [input.partyId],
                );
          if (!labs[0]) {
            throw new LabPrescriptionError("اختر مختبرًا مسجلًا ونشطًا.", 409);
          }
          await client.query(
            `UPDATE lab_orders
                SET party_id = $2, lab_name = $3, lab_phone = $4, shade = $5, stump_shade = $6,
                    tooth_numbers = $7, due_date = $8::date, impression_type = $9, priority = $10,
                    status = CASE WHEN $11 THEN 'sent' ELSE status END,
                    sent_date = CASE WHEN $11 THEN CURRENT_DATE ELSE sent_date END
              WHERE id = $1`,
            [
              id,
              input.partyId,
              labs[0].name,
              labs[0].phone,
              input.shade || null,
              input.stumpShade || null,
              storedToothNumbers || null,
              input.dueDate,
              input.impressionType,
              input.priority,
              dispatch,
            ],
          );
          await client.query(
            `INSERT INTO lab_order_tracking (lab_order_id, action, from_status, to_status, notes, actor, actor_role)
             VALUES ($1, $6, 'needed', $2, $3, $4, $5)`,
            [
              id,
              dispatch ? "sent" : "needed",
              dispatch
                ? "استُكملت المواصفات وسُجّل الإرسال — لا إرسال آلي"
                : "حُفظت مسوّدة المواصفات قبل الإرسال",
              identity.username,
              identity.role,
              dispatch ? "prescription_completed" : "prescription_draft_saved",
            ],
          );
          await insertAuditRow(client, {
            action: "lab_order.prescription_updated",
            entity: "lab_order",
            entityId: id,
            details: {
              before: JSON.parse(version),
              after: { ...input, toothNumbers: storedToothNumbers },
              sourceTooth: row.tooth_code,
              sourceWorkType: row.work_type,
              dispatch,
            },
            actor: identity.username,
            actorRole: identity.role,
          });
          return { id, status: dispatch ? ("sent" as const) : ("needed" as const) };
        },
      );
      return NextResponse.json(result, { headers: NO_STORE });
    }

    // 2. update_clinical: clinical.lab.order + patient scope + own-clinician restriction
    if (source.action === "update_clinical") {
      const outcome = await withStaffOperation(pool, session, "clinical.lab.order", async (client, handle) => {
        const patientScope = await staffOperationPatientScope(client, handle, "clinical.lab.order");
        if (patientScope.kind === "none") return "forbidden" as const;
        const clinical = parseLabClinicalSnapshot(source.clinical);
        const expectedClinical = parseLabClinicalSnapshot(source.expectedClinical);
        if (!clinical || !expectedClinical) {
          throw new CanonicalLabRefusal(
            "invalid_clinical_snapshot",
            400,
            "بيانات الإرسالية أو نسختها السابقة غير صالحة.",
          );
        }
        const problem = labClinicalEditProblem(clinical, expectedClinical);
        if (problem) {
          throw new CanonicalLabRefusal("invalid_clinical_snapshot", 400, problem);
        }
        const identity = await staffOperationIdentity(client, handle, "clinical.lab.order");
        return updateLabOrderClinicalInTransaction(client, id, {
          clinical,
          expectedClinical,
          actor: identity.username,
          actorRole: identity.role,
          restrictOwnDoctorPartyId:
            patientScope.kind === "own" ? patientScope.clinicianPartyId : undefined,
          checkAccess: async (patientId) => {
            const locked = await client.query("SELECT id FROM patients WHERE id = $1 FOR KEY SHARE NOWAIT", [
              patientId,
            ]);
            if (!locked.rows[0]) return false;
            return patientScope.kind === "all"
              ? true
              : patientInDoctorScopeWith(client, patientScope.clinicianPartyId, patientId);
          },
        });
      });
      if (outcome === "forbidden") {
        return NextResponse.json({ message: "غير مصرح لهذا المريض أو الطبيب." }, { status: 403, headers: NO_STORE });
      }
      if (outcome === "not_found") {
        return NextResponse.json({ message: "الإرسالية غير موجودة." }, { status: 404, headers: NO_STORE });
      }
      if (outcome === "invalid") {
        return NextResponse.json(
          { message: "بيانات الطبيب أو المعمل أو الأسنان غير صالحة؛ أعد مراجعتها." },
          { status: 400, headers: NO_STORE },
        );
      }
      if (outcome === "financial_doctor_locked") {
        return NextResponse.json(
          {
            message:
              "تغيير الطبيب قد يعيد توزيع العمولة التاريخية؛ لهذه الإرسالية أثر مالي أو فاتورة مرتبطة ويحتاج تصحيح الطبيب مراجعة مالية مستقلة.",
          },
          { status: 409, headers: NO_STORE },
        );
      }
      if (outcome === "financial_lab_locked") {
        return NextResponse.json(
          {
            message:
              "للإرسالية تكلفة أو التزام مالي؛ تغيير المعمل يحتاج مراجعة الربط المالي أولًا ولا يُنفّذ من التصحيح السريري.",
          },
          { status: 409, headers: NO_STORE },
        );
      }
      if (outcome === "conflict") {
        return NextResponse.json(
          { message: "تغيّرت الإرسالية منذ فتحها؛ أغلق النافذة وأعد تحميلها قبل التصحيح." },
          { status: 409, headers: NO_STORE },
        );
      }
      return NextResponse.json({ ok: true }, { headers: NO_STORE });
    }

    // 3. update_shade: clinical.lab.order + patient scope
    if (source.action === "update_shade") {
      const outcome = await withStaffOperation(pool, session, "clinical.lab.order", async (client, handle) => {
        const patientScope = await staffOperationPatientScope(client, handle, "clinical.lab.order");
        if (patientScope.kind === "none") return { status: "forbidden" as const, value: null };
        const next = parseLabShadeSpecification(source.shadeSpecification);
        const expected = parseLabShadeSpecification(source.expectedShadeSpecification);
        if (!next.ok || !expected.ok) {
          throw new CanonicalLabRefusal(
            "invalid_shade_specification",
            400,
            "مواصفات الألوان أو نسختها السابقة غير صالحة.",
          );
        }
        const identity = await staffOperationIdentity(client, handle, "clinical.lab.order");
        const status = await updateLabOrderShadesInTransaction(client, id, {
          shadeSpecification: next.value,
          expectedShadeSpecification: expected.value,
          actor: identity.username,
          actorRole: identity.role,
          checkAccess: async (patientId) => {
            const locked = await client.query("SELECT id FROM patients WHERE id = $1 FOR KEY SHARE NOWAIT", [
              patientId,
            ]);
            if (!locked.rows[0]) return false;
            return patientScope.kind === "all"
              ? true
              : patientInDoctorScopeWith(client, patientScope.clinicianPartyId, patientId);
          },
        });
        return { status, value: next.value };
      });
      if (outcome.status === "forbidden") {
        return NextResponse.json({ message: "غير مصرح لهذا المريض." }, { status: 403, headers: NO_STORE });
      }
      if (outcome.status === "not_found") {
        return NextResponse.json({ message: "الإرسالية غير موجودة." }, { status: 404, headers: NO_STORE });
      }
      if (outcome.status === "invalid") {
        return NextResponse.json(
          { message: "الألوان تخص أسنانًا غير موجودة في الإرسالية؛ راجع الاختيار." },
          { status: 400, headers: NO_STORE },
        );
      }
      if (outcome.status === "conflict") {
        return NextResponse.json(
          { message: "تغيّرت الألوان منذ فتح الإرسالية؛ أعد تحميلها قبل التعديل." },
          { status: 409, headers: NO_STORE },
        );
      }
      return NextResponse.json({ ok: true, shadeSpecification: outcome.value }, { headers: NO_STORE });
    }

    // 4. events: read:lab.orders (clinical.lab.view + patient scope)
    if (source.action === "events") {
      const payload = await runCanonicalReadSnapshot(
        session,
        "read:lab.orders",
        async (query, scope) => {
          if (scope.patientScope.kind === "none") {
            throw new CanonicalLabRefusal("patient_scope_denied", 403, "نطاق وصولك للمرضى مغلق.");
          }
          if (scope.patientScope.kind === "own") {
            const existing = await getLabOrderByIdWith(query, id);
            if (!existing) {
              throw new CanonicalLabRefusal("lab_not_found", 404, "أمر المختبر غير موجود.");
            }
            if (!(await patientInDoctorScopeWith(query, scope.patientScope.clinicianPartyId, existing.patientId))) {
              throw new CanonicalLabRefusal("lab_patient_forbidden", 403, "غير مصرح لهذا المريض.");
            }
          }
          const events = await labOrderEventsWith(query, id);
          return { events };
        },
        { errorPrefix: "STAFF_READ", maxBytes: LAB_SNAPSHOT_MAX_BYTES },
      );
      return NextResponse.json(payload, { headers: NO_STORE });
    }

    // 5. remake: clinical.lab.order + patient scope
    if (source.action === "remake") {
      const remakeOrder = await withStaffOperation(
        pool,
        session,
        "clinical.lab.order",
        async (client, handle) => {
          const patientScope = await staffOperationPatientScope(client, handle, "clinical.lab.order");
          if (patientScope.kind === "none") {
            throw new CanonicalLabRefusal("lab_patient_forbidden", 403, "غير مصرح لهذا المريض.");
          }
          const remakeReason =
            typeof source.remakeReason === "string" ? source.remakeReason.trim().slice(0, 300) : "";
          const newDueDate = typeof source.newDueDate === "string" ? source.newDueDate.trim() : "";
          if (remakeReason.length < 2) {
            throw new CanonicalLabRefusal("invalid_remake_input", 400, "اكتب سبب إعادة التصنيع بوضوح.");
          }
          if (!DATE_PATTERN.test(newDueDate)) {
            throw new CanonicalLabRefusal("invalid_remake_input", 400, "حدد موعد تسليم صحيح للإعادة.");
          }
          const existing = await getLabOrderByIdWith(client, id);
          if (!existing) {
            throw new CanonicalLabRefusal("lab_not_found", 404, "أمر المختبر غير موجود.");
          }
          if (
            patientScope.kind === "own"
            && !(await patientInDoctorScopeWith(client, patientScope.clinicianPartyId, existing.patientId))
          ) {
            throw new CanonicalLabRefusal("lab_patient_forbidden", 403, "غير مصرح لهذا المريض.");
          }
          if (existing.status !== "received" && existing.status !== "delivered") {
            throw new CanonicalLabRefusal(
              "remake_invalid_status",
              409,
              "إعادة التصنيع متاحة للأعمال المستلمة أو المسلمة فقط.",
            );
          }
          const caps = await staffOperationCapabilities(client, handle, "clinical.lab.order", [
            "finance.cost-prices.view",
            "finance.payables.record",
          ]);
          const identity = await staffOperationIdentity(client, handle, "clinical.lab.order");
          const remake = await createLabOrderRemakeInTransaction(
            client,
            id,
            {
              remakeReason,
              newDueDate,
              details:
                typeof source.details === "string" && source.details.trim()
                  ? source.details.trim().slice(0, 300)
                  : null,
              shade:
                typeof source.shade === "string" && source.shade.trim()
                  ? source.shade.trim().slice(0, 30)
                  : null,
              stumpShade:
                typeof source.stumpShade === "string" && source.stumpShade.trim()
                  ? source.stumpShade.trim().slice(0, 30)
                  : null,
              actor: identity.username,
              actorRole: identity.role,
              checkPatientAccess: async (patientId) =>
                patientScope.kind === "all"
                  ? true
                  : patientInDoctorScopeWith(client, patientScope.clinicianPartyId, patientId),
            },
            existing,
          );
          if (!remake) {
            throw new CanonicalLabRefusal("lab_not_found", 404, "أمر المختبر غير موجود.");
          }
          await insertAuditRow(client, {
            action: "lab_order.create",
            entity: "lab_order",
            entityId: String(remake.id),
            entityLabel: `إعادة تصنيع معمل: ${remake.patientName} (${remake.labName})`,
            details: { الأصل: id, السبب: remakeReason, التسليم: newDueDate },
            actor: identity.username,
            actorRole: identity.role,
          });
          const canViewCosts = caps.has("finance.cost-prices.view") || caps.has("finance.payables.record");
          return projectLabOrderCosts(remake, canViewCosts);
        },
      );
      return NextResponse.json(remakeOrder, { headers: NO_STORE });
    }

    // 6. post | unpost | update_accounting: finance.payables.record + patient scope
    if (
      source.action === "update_accounting"
      || source.action === "post"
      || source.action === "unpost"
    ) {
      const updated = await withStaffOperation(
        pool,
        session,
        "finance.payables.record",
        async (client, handle) => {
          const patientScope = await staffOperationPatientScope(client, handle, "finance.payables.record");
          if (patientScope.kind === "none") {
            throw new LabFinancialBoundaryError(
              "lab_accounting_patient_forbidden",
              "لا تملك صلاحية مالية لهذا الملف.",
            );
          }
          const isPosted =
            source.action === "post"
              ? true
              : source.action === "unpost"
                ? false
                : source.isPosted !== undefined
                  ? Boolean(source.isPosted)
                  : undefined;

          const expenseCategoryIdRaw = Number(source.expenseCategoryId);
          const expenseCategoryId =
            Number.isInteger(expenseCategoryIdRaw) && expenseCategoryIdRaw > 0
              ? expenseCategoryIdRaw
              : source.expenseCategoryId === null
                ? null
                : undefined;

          const expenseAccountCode =
            typeof source.expenseAccountCode === "string" && source.expenseAccountCode.trim()
              ? source.expenseAccountCode.trim().slice(0, 10)
              : undefined;

          const payableAccountCode =
            typeof source.payableAccountCode === "string" && source.payableAccountCode.trim()
              ? source.payableAccountCode.trim().slice(0, 10)
              : undefined;

          let costMinor: number | null | undefined = undefined;
          let costCurrency: Currency | undefined = undefined;
          let exchangeRate: number | undefined = undefined;
          if (source.cost !== undefined && String(source.cost).trim() !== "") {
            if (!isCurrency(source.costCurrency)) {
              throw new CanonicalLabRefusal(
                "lab_accounting_currency_required",
                400,
                "اختر عملة التكلفة الفعلية؛ لا تُفترض عملة تلقائيًا.",
              );
            }
            costCurrency = source.costCurrency;
            costMinor = parseAmount(String(source.cost), costCurrency);
            if (costMinor === null || costMinor < 0) {
              throw new CanonicalLabRefusal(
                "invalid_accounting_cost",
                400,
                "اكتب تكلفة صحيحة أو اتركها فارغة.",
                false,
              );
            }
            const settings = await getSettingsWith(client);
            const baseCurrency: Currency = CLINIC_BASE_CURRENCY;
            const rate =
              costCurrency === baseCurrency ? 1 : rateFromSettings(settings, costCurrency, baseCurrency);
            exchangeRate = rate != null && rate > 0 ? rate : undefined;
            if (source.expectedExchangeRate !== undefined) {
              if (!isLabAccountingRate(source.expectedExchangeRate)) {
                throw new CanonicalLabRefusal(
                  "lab_accounting_rate_invalid",
                  400,
                  "سعر معاينة غير صالح. أعد تحميل المعاينة.",
                );
              }
              if (!isLabAccountingRate(exchangeRate) || source.expectedExchangeRate !== exchangeRate) {
                throw new CanonicalLabRefusal(
                  "lab_accounting_rate_changed",
                  409,
                  "تغيّر سعر الصرف أو تعذّر التحقق منه. حدّث المعاينة وراجعها قبل الحفظ.",
                );
              }
            }
            if (!isLabAccountingRate(exchangeRate)) {
              throw new CanonicalLabRefusal(
                "lab_accounting_rate_invalid",
                409,
                "سعر صرف عملة التكلفة غير صالح؛ راجع الإعدادات قبل الحفظ.",
              );
            }
          } else if (source.cost === null || source.cost === "") {
            costMinor = null;
          }

          const identity = await staffOperationIdentity(client, handle, "finance.payables.record");
          const result = await updateLabOrderAccountingInTransaction(client, id, {
            expenseCategoryId,
            expenseAccountCode,
            payableAccountCode,
            isPosted,
            costMinor,
            costCurrency,
            exchangeRate,
            actor: identity.username,
            actorRole: identity.role,
            checkPatientMoneyAccess: async (patientId) =>
              patientScope.kind === "all"
                ? true
                : patientInDoctorScopeWith(client, patientScope.clinicianPartyId, patientId),
            assertStillValid: async () => {
              await staffOperationIdentity(client, handle, "finance.payables.record");
            },
          });
          if (!result) {
            throw new CanonicalLabRefusal("lab_not_found", 404, "أمر المختبر غير موجود.");
          }
          return result;
        },
      );
      return NextResponse.json(updated, { headers: NO_STORE });
    }

    // 7. dueDate or status: clinical.lab.order + patient scope (+ clinical.lab.cancel for dispatched cancel)
    const updatedOrder = await withStaffOperation(
      pool,
      session,
      "clinical.lab.order",
      async (client, handle) => {
        const patientScope = await staffOperationPatientScope(client, handle, "clinical.lab.order");
        if (patientScope.kind === "none") {
          throw new CanonicalLabRefusal("lab_patient_forbidden", 403, "غير مصرح لهذا المريض.");
        }
        const caps = await staffOperationCapabilities(client, handle, "clinical.lab.order", [
          "clinical.lab.cancel",
          "finance.cost-prices.view",
          "finance.payables.record",
        ]);
        const identity = await staffOperationIdentity(client, handle, "clinical.lab.order");
        const canViewCosts = caps.has("finance.cost-prices.view") || caps.has("finance.payables.record");

        if (typeof source.dueDate === "string") {
          if (!DATE_PATTERN.test(source.dueDate)) {
            throw new CanonicalLabRefusal("invalid_due_date", 400, "تاريخ غير صالح.");
          }
          const existing = await getLabOrderByIdWith(client, id);
          if (!existing) {
            throw new CanonicalLabRefusal("lab_not_found", 404, "أمر المختبر غير موجود.");
          }
          if (
            patientScope.kind === "own"
            && !(await patientInDoctorScopeWith(client, patientScope.clinicianPartyId, existing.patientId))
          ) {
            throw new CanonicalLabRefusal("lab_patient_forbidden", 403, "غير مصرح لهذا المريض.");
          }
          const updated = await setLabOrderDueDateInTransaction(
            client,
            id,
            source.dueDate,
            identity.username,
            identity.role,
          );
          if (!updated) {
            throw new CanonicalLabRefusal("due_date_conflict", 409, "لا يمكن تأجيل عمل وصل أو أُلغي.");
          }
          return projectLabOrderCosts(updated, canViewCosts);
        }

        const status = typeof source.status === "string" ? source.status : "";
        if (!STATUSES.includes(status as LabOrderStatus)) {
          throw new CanonicalLabRefusal("invalid_status", 400, "حالة غير معروفة.");
        }

        const updated = await setLabOrderStatusInTransaction(client, id, status as LabOrderStatus, {
          actor: identity.username,
          actorRole: identity.role,
          notes:
            typeof source.note === "string" && source.note.trim() ? source.note.trim().slice(0, 300) : null,
          canCancelDispatched: caps.has("clinical.lab.cancel"),
          checkPatientAccess: async (patientId) =>
            patientScope.kind === "all"
              ? true
              : patientInDoctorScopeWith(client, patientScope.clinicianPartyId, patientId),
          assertStillValid: async () => {
            await staffOperationIdentity(client, handle, "clinical.lab.order");
          },
        });
        if (!updated) {
          throw new CanonicalLabRefusal(
            "status_conflict",
            409,
            "حالة العمل تغيّرت من جهاز آخر. حدّثت القائمة — راجعها.",
          );
        }
        if (status === "cancelled") {
          await insertAuditRow(client, {
            action: "lab_order.cancel",
            entity: "lab_order",
            entityId: id,
            entityLabel: `${updated.patientName} — ${updated.workType}`,
            details: {
              labName: updated.labName,
              teeth: updated.toothNumbers ?? null,
              costMinor: updated.costMinor ?? null,
              costCurrency: updated.costCurrency ?? null,
              note: typeof source.note === "string" ? source.note.slice(0, 300) : null,
            },
            actor: identity.username,
            actorRole: identity.role,
          });
        }
        return projectLabOrderCosts(updated, canViewCosts);
      },
    );
    return NextResponse.json(updatedOrder, { headers: NO_STORE });
  } catch (error) {
    return canonicalLabFailure(error, "تعذّر تنفيذ الإجراء. أعد المحاولة.");
  }
}

export async function deleteCanonicalLabOrderResponse(
  session: VerifiedDurableSession,
  id: number,
  reason: string | null,
  pool: DbPool = getPool(),
): Promise<NextResponse> {
  try {
    const outcome = await withStaffOperation(pool, session, "clinical.lab.cancel", async (client, handle) => {
      const patientScope = await staffOperationPatientScope(client, handle, "clinical.lab.cancel");
      if (patientScope.kind === "none") {
        throw new CanonicalLabRefusal("lab_patient_forbidden", 403, "لا تملك صلاحية الوصول لملفات المرضى.");
      }
      if (!reason || reason.length < 3) {
        throw new CanonicalLabRefusal(
          "reason_required",
          400,
          "اكتب سبب الحذف النهائي — يُسجَّل في التدقيق. (للإلغاء الطبيعي استعمل «إلغاء» لا الحذف.)",
        );
      }
      const identity = await staffOperationIdentity(client, handle, "clinical.lab.cancel");
      return deleteLabOrderInTransaction(client, id, {
        actor: identity.username,
        actorRole: identity.role,
        reason,
        auditInTransaction: true,
        checkPatientAccess: async (patientId) =>
          patientScope.kind === "all"
            ? true
            : patientInDoctorScopeWith(client, patientScope.clinicianPartyId, patientId),
      });
    });

    if (!outcome.ok) {
      if (outcome.reason === "forbidden") {
        return NextResponse.json({ message: "غير مصرح لهذا المريض." }, { status: 403, headers: NO_STORE });
      }
      if (outcome.reason === "reason_required") {
        return NextResponse.json(
          { message: "اكتب سبب الحذف النهائي — يُسجَّل في التدقيق." },
          { status: 400, headers: NO_STORE },
        );
      }
      if (outcome.reason === "source_linked") {
        return NextResponse.json(
          {
            code: "lab_source_linked",
            message:
              "الإرسالية مرتبطة بمصدر علاجي أو فاتورة؛ لا يمكن حذف هويتها. استخدم الإلغاء المسموح مع حفظ الأثر.",
          },
          { status: 409, headers: NO_STORE },
        );
      }
      if (outcome.reason === "settled") {
        return NextResponse.json(
          { message: "التزام هذا العمل مسدَّد بسند صرف — ألغِه سريريًا بدل حذفه ليبقى الأثر المالي." },
          { status: 409, headers: NO_STORE },
        );
      }
      return NextResponse.json({ message: "أمر المختبر غير موجود." }, { status: 404, headers: NO_STORE });
    }
    return NextResponse.json({ message: "حُذف أمر المختبر وسُجِّل في التدقيق." }, { headers: NO_STORE });
  } catch (error) {
    return canonicalLabFailure(error, "تعذّر حذف أمر المختبر. أعد المحاولة.");
  }
}

// ─── GET /api/lab/backlog ────────────────────────────────────────────────────

export async function readCanonicalLabBacklogResponse(
  session: VerifiedDurableSession,
  request: Request,
): Promise<NextResponse> {
  const searchParams = new URL(request.url).searchParams;
  try {
    const snapshot = await runCanonicalReadSnapshot(
      session,
      "read:lab.backlog",
      async (query, scope) => {
        if (scope.patientScope.kind !== "all") {
          throw new CanonicalLabRefusal(
            "lab_backlog_whole_scope_required",
            403,
            "قائمة متابعة المعمل الشاملة للإدارة فقط.",
          );
        }
        const input = parseLabBacklogQuery(searchParams);
        if (!input) {
          throw new CanonicalLabRefusal("invalid_backlog_query", 400, "مرشح أو صفحة غير صالحين.");
        }
        const {
          rows: [row],
        } = await query.query<{
          as_of: Date;
          today: string;
          total: number;
          page: number;
          counts: LabBacklogSnapshot["counts"];
          items: LabBacklogSnapshot["items"];
        }>(LAB_BACKLOG_SQL, [
          CLINIC_TIME_ZONE,
          [...LAB_READINESS_STATUSES],
          input.filter,
          input.page,
          LAB_BACKLOG_PAGE_SIZE,
          scope.userId,
        ]);
        const value =
          row
          && decodeLabBacklog(
            {
              scope: "all_open_now",
              asOf: row.as_of.toISOString(),
              today: row.today,
              timeZone: CLINIC_TIME_ZONE,
              filter: input.filter,
              counts: row.counts,
              total: row.total,
              page: row.page,
              hasMore: (row.page + 1) * LAB_BACKLOG_PAGE_SIZE < row.total,
              items: row.items,
            },
            input.filter,
          );
        if (!value) {
          throw new Error("lab_backlog_invalid_result");
        }
        return value;
      },
      { errorPrefix: "STAFF_READ", maxBytes: LAB_SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(snapshot, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof CanonicalLabRefusal) {
      return NextResponse.json(
        { code: error.code, message: error.message },
        { status: error.status, headers: NO_STORE },
      );
    }
    const refusal = staffAdmissionRefusal(error);
    if (refusal) {
      return NextResponse.json({ code: refusal.code, message: refusal.message }, { status: refusal.status, headers: NO_STORE });
    }
    return NextResponse.json(
      { message: "تعذّر التحقق من التراكيب المفتوحة. الأعداد غير معروفة؛ أعد المحاولة." },
      { status: 503, headers: NO_STORE },
    );
  }
}

// ─── GET / POST / PUT / DELETE /api/lab/pricing* ─────────────────────────────

export async function readCanonicalLabPricingResponse(
  session: VerifiedDurableSession,
  request: Request,
): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const partyIdRaw = searchParams.get("partyId");
  const labServiceIdRaw = searchParams.get("labServiceId");
  const resolve = searchParams.get("resolve") === "1" || searchParams.get("resolve") === "true";
  const dateStr = searchParams.get("date");
  const partyId = partyIdRaw ? Number(partyIdRaw) : undefined;
  const labServiceId = labServiceIdRaw ? Number(labServiceIdRaw) : undefined;

  try {
    const payload = await runCanonicalReadSnapshot(
      session,
      "clinical.lab.view",
      async (query) => {
        if (resolve && partyId && labServiceId) {
          const targetDate =
            dateStr && DATE_PATTERN.test(dateStr) ? dateStr : clinicDateString(new Date(), CLINIC_TIME_ZONE);
          const resolved = await resolveLabOrderPriceWith(query, partyId, labServiceId, targetDate);
          return { resolved };
        }
        const rules = await listLabPricingRulesWith(query, partyId, labServiceId);
        return { rules };
      },
      { errorPrefix: "STAFF_READ", maxBytes: LAB_SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(payload, { headers: NO_STORE });
  } catch (error) {
    return canonicalLabFailure(error, "تعذّر تحميل جدول تسعير خدمات المختبرات.");
  }
}

export async function commandCanonicalCreateLabPricingRuleResponse(
  session: VerifiedDurableSession,
  rawBody: unknown,
  pool: DbPool = getPool(),
): Promise<NextResponse> {
  const source = (rawBody ?? {}) as Record<string, unknown>;
  try {
    const created = await withStaffOperation(
      pool,
      session,
      "finance.lab-prices.edit",
      async (client, handle) => {
        const partyId = Number(source.partyId);
        if (!Number.isInteger(partyId) || partyId <= 0) {
          throw new CanonicalLabRefusal("invalid_pricing_input", 400, "يرجى اختيار المختبر أولًا.");
        }
        const labServiceId = Number(source.labServiceId);
        if (!Number.isInteger(labServiceId) || labServiceId <= 0) {
          throw new CanonicalLabRefusal("invalid_pricing_input", 400, "يرجى اختيار خدمة المختبر من الدليل.");
        }
        const costCurrency: Currency = isCurrency(source.costCurrency) ? source.costCurrency : "YER";
        const costMinor =
          source.costMinor !== undefined
            ? Number(source.costMinor)
            : parseAmount(String(source.cost ?? ""), costCurrency);
        if (costMinor === null || Number.isNaN(costMinor) || costMinor < 0) {
          throw new CanonicalLabRefusal("invalid_pricing_input", 400, "يرجى إدخال مبلغ وسعر صالح للخدمة.");
        }
        const effectiveFrom =
          typeof source.effectiveFrom === "string" && DATE_PATTERN.test(source.effectiveFrom)
            ? source.effectiveFrom
            : clinicDateString(new Date(), CLINIC_TIME_ZONE);
        let effectiveTo: string | null = null;
        if (typeof source.effectiveTo === "string" && source.effectiveTo.trim()) {
          if (!DATE_PATTERN.test(source.effectiveTo.trim())) {
            throw new CanonicalLabRefusal(
              "invalid_pricing_input",
              400,
              "تاريخ انتهاء السريان غير صالح (الصيغة: YYYY-MM-DD).",
            );
          }
          if (source.effectiveTo.trim() < effectiveFrom) {
            throw new CanonicalLabRefusal(
              "invalid_pricing_input",
              400,
              "تاريخ انتهاء السريان يجب ألا يسبق تاريخ التفعيل.",
            );
          }
          effectiveTo = source.effectiveTo.trim();
        }
        const note =
          typeof source.note === "string" && source.note.trim() ? source.note.trim().slice(0, 300) : null;

        const [lab, service] = await Promise.all([
          getLaboratoryWith(client, partyId),
          getLabServiceWith(client, labServiceId),
        ]);
        if (!lab) {
          throw new CanonicalLabRefusal("lab_not_found", 404, "المختبر المحدد غير موجود.");
        }
        if (!service) {
          throw new CanonicalLabRefusal(
            "lab_service_not_found",
            404,
            "خدمة المختبر المحددة غير موجودة في الدليل.",
          );
        }
        if (source.closePreviousRule === true) {
          await client.query(
            `UPDATE lab_pricing_rules
                SET effective_to = ($3::date - INTERVAL '1 day')
              WHERE party_id = $1
                AND lab_service_id = $2
                AND effective_from < $3::date
                AND (effective_to IS NULL OR effective_to >= $3::date)`,
            [partyId, labServiceId, effectiveFrom],
          );
        }
        const identity = await staffOperationIdentity(client, handle, "finance.lab-prices.edit");
        const rule = await createLabPricingRuleWith(client, {
          partyId,
          labServiceId,
          costMinor,
          costCurrency,
          effectiveFrom,
          effectiveTo,
          note,
          createdBy: identity.username,
        });
        await insertAuditRow(client, {
          actor: identity.username,
          actorRole: identity.role,
          action: "lab_pricing.create",
          entity: "lab_pricing_rule",
          entityId: String(rule.id),
          entityLabel: `${lab.name} — ${service.name} (${costMinor} ${costCurrency})`,
          details: {
            id: rule.id,
            partyId,
            labName: lab.name,
            labServiceId,
            serviceName: service.name,
            costMinor,
            costCurrency,
            effectiveFrom,
            effectiveTo,
            note,
          },
        });
        return rule;
      },
    );
    return NextResponse.json({ rule: created }, { status: 201, headers: NO_STORE });
  } catch (error) {
    return canonicalLabFailure(error, "تعذّر حفظ قاعدة التسعير للمختبر.");
  }
}

export async function commandCanonicalUpdateLabPricingRuleResponse(
  session: VerifiedDurableSession,
  id: number,
  rawBody: unknown,
  pool: DbPool = getPool(),
): Promise<NextResponse> {
  const source = (rawBody ?? {}) as Record<string, unknown>;
  try {
    const updated = await withStaffOperation(
      pool,
      session,
      "finance.lab-prices.edit",
      async (client, handle) => {
        const patch: Parameters<typeof updateLabPricingRuleWith>[2] = {};
        if (source.costCurrency !== undefined && isCurrency(source.costCurrency)) {
          patch.costCurrency = source.costCurrency;
        }
        if (source.cost !== undefined || source.costMinor !== undefined) {
          const currency = patch.costCurrency || "YER";
          const costMinor =
            source.costMinor !== undefined
              ? Number(source.costMinor)
              : parseAmount(String(source.cost ?? ""), currency);
          if (costMinor === null || Number.isNaN(costMinor) || costMinor < 0) {
            throw new CanonicalLabRefusal("invalid_pricing_input", 400, "مبلغ وسعر الخدمة غير صالح.");
          }
          patch.costMinor = costMinor;
        }
        if (typeof source.effectiveFrom === "string") {
          if (!DATE_PATTERN.test(source.effectiveFrom.trim())) {
            throw new CanonicalLabRefusal(
              "invalid_pricing_input",
              400,
              "تاريخ بدء السريان غير صالح (الصيغة: YYYY-MM-DD).",
            );
          }
          patch.effectiveFrom = source.effectiveFrom.trim();
        }
        if (source.effectiveTo !== undefined) {
          if (source.effectiveTo === null || source.effectiveTo === "") {
            patch.effectiveTo = null;
          } else if (typeof source.effectiveTo === "string" && DATE_PATTERN.test(source.effectiveTo.trim())) {
            patch.effectiveTo = source.effectiveTo.trim();
          } else {
            throw new CanonicalLabRefusal("invalid_pricing_input", 400, "تاريخ انتهاء السريان غير صالح.");
          }
        }
        if (source.note !== undefined) {
          patch.note =
            typeof source.note === "string" && source.note.trim() ? source.note.trim().slice(0, 300) : null;
        }

        const identity = await staffOperationIdentity(client, handle, "finance.lab-prices.edit");
        const rule = await updateLabPricingRuleWith(client, id, patch);
        if (!rule) {
          throw new CanonicalLabRefusal("pricing_rule_not_found", 404, "قاعدة التسعير غير موجودة.");
        }
        await insertAuditRow(client, {
          actor: identity.username,
          actorRole: identity.role,
          action: "lab_pricing.update",
          entity: "lab_pricing_rule",
          entityId: String(id),
          entityLabel: `${rule.partyName} — ${rule.serviceName}`,
          details: {
            id,
            costMinor: rule.costMinor,
            costCurrency: rule.costCurrency,
            effectiveFrom: rule.effectiveFrom,
            effectiveTo: rule.effectiveTo,
            note: rule.note,
          },
        });
        return rule;
      },
    );
    return NextResponse.json({ rule: updated }, { headers: NO_STORE });
  } catch (error) {
    return canonicalLabFailure(error, "تعذّر تعديل قاعدة التسعير.");
  }
}

export async function commandCanonicalDeleteLabPricingRuleResponse(
  session: VerifiedDurableSession,
  id: number,
  pool: DbPool = getPool(),
): Promise<NextResponse> {
  try {
    await withStaffOperation(pool, session, "finance.lab-prices.edit", async (client, handle) => {
      const { rows } = await client.query<{
        party_name: string;
        service_name: string;
        cost_minor: string;
        cost_currency: string;
      }>(
        `SELECT p.name AS party_name, ls.name AS service_name, r.cost_minor, r.cost_currency
           FROM lab_pricing_rules r
           JOIN parties p ON p.id = r.party_id
           JOIN lab_services ls ON ls.id = r.lab_service_id
          WHERE r.id = $1`,
        [id],
      );
      const existing = rows[0];
      const deleted = await deleteLabPricingRuleWith(client, id);
      if (!deleted) {
        throw new CanonicalLabRefusal("pricing_rule_not_found", 404, "قاعدة التسعير غير موجودة.");
      }
      if (existing) {
        const identity = await staffOperationIdentity(client, handle, "finance.lab-prices.edit");
        await insertAuditRow(client, {
          actor: identity.username,
          actorRole: identity.role,
          action: "lab_pricing.delete",
          entity: "lab_pricing_rule",
          entityId: String(id),
          entityLabel: `${existing.party_name} — ${existing.service_name} (${existing.cost_minor} ${existing.cost_currency})`,
          details: { id },
        });
      }
    });
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    return canonicalLabFailure(error, "تعذّر حذف قاعدة التسعير.");
  }
}

// ─── GET / POST / PATCH / DELETE /api/lab/services* ──────────────────────────

export async function readCanonicalLabServicesResponse(
  session: VerifiedDurableSession,
  request: Request,
): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const includeInactive =
    searchParams.get("all") === "1" || searchParams.get("includeInactive") === "true";
  try {
    const payload = await runCanonicalReadSnapshot(
      session,
      "clinical.lab.view",
      async (query) => ({ services: await listLabServicesWith(query, includeInactive) }),
      { errorPrefix: "STAFF_READ", maxBytes: LAB_SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(payload, { headers: NO_STORE });
  } catch (error) {
    return canonicalLabFailure(error, "تعذّر تحميل دليل خدمات المختبر.");
  }
}

export async function readCanonicalLabServiceResponse(
  session: VerifiedDurableSession,
  id: number,
): Promise<NextResponse> {
  try {
    const payload = await runCanonicalReadSnapshot(
      session,
      "clinical.lab.view",
      async (query) => {
        const service = await getLabServiceWith(query, id);
        if (!service) {
          throw new CanonicalLabRefusal("lab_service_not_found", 404, "خدمة المختبر غير موجودة.");
        }
        return { service };
      },
      { errorPrefix: "STAFF_READ", maxBytes: LAB_SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(payload, { headers: NO_STORE });
  } catch (error) {
    return canonicalLabFailure(error, "تعذّر جلب بيانات الخدمة.");
  }
}

export async function commandCanonicalCreateOrSeedLabServiceResponse(
  session: VerifiedDurableSession,
  rawBody: unknown,
  pool: DbPool = getPool(),
): Promise<NextResponse> {
  const source = (rawBody ?? {}) as Record<string, unknown>;
  try {
    const outcome = await withStaffOperation(
      pool,
      session,
      "finance.lab-prices.edit",
      async (client, handle) => {
        const identity = await staffOperationIdentity(client, handle, "finance.lab-prices.edit");
        if (source.action === "seed_defaults") {
          const result = await seedLabServicesCatalogWith(client);
          await insertAuditRow(client, {
            actor: identity.username,
            actorRole: identity.role,
            action: "lab_services.seed",
            entityLabel: `تحديث وبذر دليل خدمات المختبر القياسي (${result.count} خدمة)`,
            details: { count: result.count },
          });
          const services = await listLabServicesWith(client, true);
          return {
            seeded: true as const,
            body: {
              message: `تم تحديث وبذر دليل خدمات المختبر بنجاح (${result.count} خدمة).`,
              services,
            },
          };
        }

        const name = typeof source.name === "string" ? source.name.trim() : "";
        if (!name || name.length > 150) {
          throw new CanonicalLabRefusal(
            "invalid_service_input",
            400,
            "يرجى كتابة اسم خدمة المختبر (أقل من 150 حرف).",
          );
        }
        const code =
          typeof source.code === "string" && source.code.trim()
            ? source.code.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 30)
            : null;
        const validCategories: LabServiceCategory[] = [
          "prostho",
          "ortho",
          "implant",
          "restorative",
          "appliance",
          "other",
        ];
        const category =
          typeof source.category === "string"
          && validCategories.includes(source.category as LabServiceCategory)
            ? (source.category as LabServiceCategory)
            : "prostho";
        const validScopes: LabToothScope[] = [
          "single_tooth",
          "multi_teeth_bridge",
          "full_arch",
          "general",
        ];
        const toothScope =
          typeof source.toothScope === "string" && validScopes.includes(source.toothScope as LabToothScope)
            ? (source.toothScope as LabToothScope)
            : "single_tooth";
        const requiresShade = source.requiresShade !== false;
        const rawDays = Number(source.defaultDays);
        const defaultDays = Number.isInteger(rawDays) && rawDays >= 1 && rawDays <= 60 ? rawDays : 7;
        const description =
          typeof source.description === "string" && source.description.trim()
            ? source.description.trim().slice(0, 500)
            : null;
        const rawSort = Number(source.sortOrder);
        const sortOrder = Number.isInteger(rawSort) ? rawSort : 100;
        const isActive = source.isActive !== false;

        try {
          const created = await createLabServiceWith(client, {
            name,
            code,
            category,
            toothScope,
            requiresShade,
            defaultDays,
            description,
            sortOrder,
            isActive,
          });
          await insertAuditRow(client, {
            actor: identity.username,
            actorRole: identity.role,
            action: "lab_service.create",
            entity: "lab_service",
            entityId: String(created.id),
            entityLabel: created.name,
            details: {
              id: created.id,
              name: created.name,
              code: created.code,
              category: created.category,
              toothScope: created.toothScope,
            },
          });
          return { seeded: false as const, body: { service: created } };
        } catch (error: unknown) {
          const pgErr = error as { code?: string; message?: string };
          if (pgErr?.code === "23505" || pgErr?.message?.includes("unique")) {
            throw new CanonicalLabRefusal(
              "duplicate_service_code",
              409,
              `رمز الخدمة (الكود: ${code}) مستخدم مسبقًا، يرجى اختيار رمز فريد.`,
            );
          }
          throw error;
        }
      },
    );
    return NextResponse.json(outcome.body, { status: outcome.seeded ? 200 : 201, headers: NO_STORE });
  } catch (error) {
    return canonicalLabFailure(
      error,
      source.action === "seed_defaults" ? "تعذّر بذر خدمات المختبر." : "تعذّر حفظ خدمة المختبر.",
    );
  }
}

export async function commandCanonicalUpdateLabServiceResponse(
  session: VerifiedDurableSession,
  id: number,
  rawBody: unknown,
  pool: DbPool = getPool(),
): Promise<NextResponse> {
  const source = (rawBody ?? {}) as Record<string, unknown>;
  try {
    const updated = await withStaffOperation(
      pool,
      session,
      "finance.lab-prices.edit",
      async (client, handle) => {
        const input: Parameters<typeof updateLabServiceWith>[2] = {};
        if (typeof source.name === "string") {
          const trimmed = source.name.trim();
          if (!trimmed || trimmed.length > 150) {
            throw new CanonicalLabRefusal("invalid_service_input", 400, "يرجى كتابة اسم صحيح للخدمة.");
          }
          input.name = trimmed;
        }
        if (source.code !== undefined) {
          if (source.code === null || source.code === "") {
            input.code = null;
          } else if (typeof source.code === "string") {
            input.code = source.code.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 30);
          }
        }
        if (typeof source.category === "string") {
          const validCategories: LabServiceCategory[] = [
            "prostho",
            "ortho",
            "implant",
            "restorative",
            "appliance",
            "other",
          ];
          if (validCategories.includes(source.category as LabServiceCategory)) {
            input.category = source.category as LabServiceCategory;
          }
        }
        if (typeof source.toothScope === "string") {
          const validScopes: LabToothScope[] = [
            "single_tooth",
            "multi_teeth_bridge",
            "full_arch",
            "general",
          ];
          if (validScopes.includes(source.toothScope as LabToothScope)) {
            input.toothScope = source.toothScope as LabToothScope;
          }
        }
        if (source.requiresShade !== undefined) {
          input.requiresShade = Boolean(source.requiresShade);
        }
        if (source.defaultDays !== undefined) {
          const days = Number(source.defaultDays);
          if (Number.isInteger(days) && days >= 1 && days <= 60) {
            input.defaultDays = days;
          }
        }
        if (source.description !== undefined) {
          input.description =
            typeof source.description === "string" && source.description.trim()
              ? source.description.trim().slice(0, 500)
              : null;
        }
        if (source.sortOrder !== undefined) {
          const sort = Number(source.sortOrder);
          if (Number.isInteger(sort)) {
            input.sortOrder = sort;
          }
        }
        if (source.isActive !== undefined) {
          input.isActive = Boolean(source.isActive);
        }

        const identity = await staffOperationIdentity(client, handle, "finance.lab-prices.edit");
        try {
          const service = await updateLabServiceWith(client, id, input);
          if (!service) {
            throw new CanonicalLabRefusal("lab_service_not_found", 404, "خدمة المختبر غير موجودة.");
          }
          await insertAuditRow(client, {
            actor: identity.username,
            actorRole: identity.role,
            action: "lab_service.update",
            entity: "lab_service",
            entityId: String(id),
            entityLabel: service.name,
            details: {
              id,
              name: service.name,
              isActive: service.isActive,
              category: service.category,
              toothScope: service.toothScope,
            },
          });
          return service;
        } catch (error: unknown) {
          if (error instanceof CanonicalLabRefusal) throw error;
          const pgErr = error as { code?: string; message?: string };
          if (pgErr?.code === "23505" || pgErr?.message?.includes("unique")) {
            throw new CanonicalLabRefusal(
              "duplicate_service_code",
              409,
              "رمز الخدمة مستخدم مسبقًا لخدمة أخرى.",
            );
          }
          throw error;
        }
      },
    );
    return NextResponse.json({ service: updated }, { headers: NO_STORE });
  } catch (error) {
    return canonicalLabFailure(error, "تعذّر حفظ تعديلات الخدمة.");
  }
}

export async function commandCanonicalDeleteLabServiceResponse(
  session: VerifiedDurableSession,
  id: number,
  pool: DbPool = getPool(),
): Promise<NextResponse> {
  try {
    const result = await withStaffOperation(
      pool,
      session,
      "finance.lab-prices.edit",
      async (client, handle) => {
        const service = await getLabServiceWith(client, id);
        if (!service) {
          throw new CanonicalLabRefusal("lab_service_not_found", 404, "خدمة المختبر غير موجودة.");
        }
        const identity = await staffOperationIdentity(client, handle, "finance.lab-prices.edit");
        const outcome = await deleteLabServiceWith(client, id);
        await insertAuditRow(client, {
          actor: identity.username,
          actorRole: identity.role,
          action: outcome.deactivated ? "lab_service.deactivate" : "lab_service.delete",
          entity: "lab_service",
          entityId: String(id),
          entityLabel: service.name,
          details: {
            id,
            name: service.name,
            deactivated: outcome.deactivated,
          },
        });
        return outcome;
      },
    );
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    return canonicalLabFailure(error, "تعذّر حذف خدمة المختبر.");
  }
}

// ─── GET /api/lab/work-intents/capability ────────────────────────────────────

export async function readCanonicalLabWorkCapabilityResponse(
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  try {
    const payload = await runCanonicalReadSnapshot(
      session,
      "clinical.lab.order",
      async (query) => ({ supported: await labWorkIntentSupported(query) }),
      { errorPrefix: "STAFF_READ", maxBytes: 64 * 1024 },
    );
    return NextResponse.json(payload, { headers: NO_STORE });
  } catch (error) {
    const refusal = staffAdmissionRefusal(error);
    if (refusal) {
      return NextResponse.json(
        {
          supported: false,
          message: refusal.status === 403 ? "هذه العملية للطبيب أو المدير." : refusal.message,
        },
        { status: refusal.status, headers: NO_STORE },
      );
    }
    return NextResponse.json(
      { supported: false, message: "تعذّر التحقق من إتاحة أعمال المختبر. أعد المحاولة." },
      { status: 503, headers: NO_STORE },
    );
  }
}

// ─── GET / POST / PATCH / DELETE /api/laboratories* ──────────────────────────

export async function readCanonicalLaboratoriesResponse(
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  try {
    const payload = await runCanonicalReadSnapshot(
      session,
      "clinical.lab.view",
      async (query) => ({ laboratories: await listLaboratoriesWith(query) }),
      { errorPrefix: "STAFF_READ", maxBytes: LAB_SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(payload, { headers: NO_STORE });
  } catch (error) {
    return canonicalLabFailure(error, "تعذّر تحميل بيانات المختبرات.");
  }
}

export async function readCanonicalLaboratoryResponse(
  session: VerifiedDurableSession,
  id: number,
): Promise<NextResponse> {
  try {
    const lab = await runCanonicalReadSnapshot(
      session,
      "clinical.lab.view",
      async (query) => {
        const found = await getLaboratoryWith(query, id);
        if (!found) {
          throw new CanonicalLabRefusal("laboratory_not_found", 404, "المختبر غير موجود.");
        }
        return found;
      },
      { errorPrefix: "STAFF_READ", maxBytes: LAB_SNAPSHOT_MAX_BYTES },
    );
    return NextResponse.json(lab, { headers: NO_STORE });
  } catch (error) {
    return canonicalLabFailure(error, "تعذّر جلب بيانات المختبر.");
  }
}

export async function commandCanonicalCreateLaboratoryResponse(
  session: VerifiedDurableSession,
  rawBody: unknown,
  pool: DbPool = getPool(),
): Promise<NextResponse> {
  const source = (rawBody ?? {}) as Record<string, unknown>;
  try {
    const lab = await withStaffOperation(
      pool,
      session,
      "clinical.laboratories.manage",
      async (client, handle) => {
        const name = typeof source.name === "string" ? source.name.trim() : "";
        if (!name || name.length > 120) {
          throw new CanonicalLabRefusal(
            "invalid_laboratory_input",
            400,
            "يرجى كتابة اسم المختبر (أقل من 120 حرف).",
          );
        }
        const phone =
          typeof source.phone === "string" && source.phone.trim() ? source.phone.trim().slice(0, 40) : null;
        let whatsapp: string | null = null;
        if (typeof source.whatsapp === "string" && source.whatsapp.trim()) {
          whatsapp = toWhatsAppNumber(source.whatsapp) ?? source.whatsapp.trim().slice(0, 40);
        }
        const address =
          typeof source.address === "string" && source.address.trim()
            ? source.address.trim().slice(0, 200)
            : null;
        const contactPerson =
          typeof source.contactPerson === "string" && source.contactPerson.trim()
            ? source.contactPerson.trim().slice(0, 100)
            : null;
        const currencyRaw =
          typeof source.currency === "string" ? source.currency.trim().toUpperCase() : "YER";
        const currency: Currency = isCurrency(currencyRaw) ? currencyRaw : "YER";
        const deliveryDaysRaw = Number(source.deliveryDays ?? 7);
        const deliveryDays =
          Number.isInteger(deliveryDaysRaw) && deliveryDaysRaw > 0 && deliveryDaysRaw <= 365
            ? deliveryDaysRaw
            : 7;
        const note =
          typeof source.note === "string" && source.note.trim() ? source.note.trim().slice(0, 300) : null;
        const isActive = source.isActive !== false;
        const expenseAccountCode =
          typeof source.expenseAccountCode === "string" && source.expenseAccountCode.trim()
            ? source.expenseAccountCode.trim().slice(0, 20)
            : "5101";
        const payableAccountCode =
          typeof source.payableAccountCode === "string" && source.payableAccountCode.trim()
            ? source.payableAccountCode.trim().slice(0, 20)
            : "2101";
        const autoPostJournal = source.autoPostJournal !== false;
        const customAccountName =
          typeof source.customAccountName === "string" && source.customAccountName.trim()
            ? source.customAccountName.trim().slice(0, 120)
            : null;

        const identity = await staffOperationIdentity(client, handle, "clinical.laboratories.manage");
        const created = await createLaboratoryWith(client, {
          name,
          phone,
          whatsapp,
          address,
          contactPerson,
          currency,
          deliveryDays,
          note,
          isActive,
          expenseAccountCode,
          payableAccountCode,
          autoPostJournal,
          customAccountName,
        });
        await insertAuditRow(client, {
          action: "settings.update",
          actor: identity.username,
          actorRole: identity.role,
          entity: "laboratory",
          entityId: String(created.id),
          entityLabel: created.name,
          details: {
            entity: "laboratory",
            name,
            currency,
            deliveryDays,
            message: `إضافة مختبر جديد: ${name} (العملة: ${currency}، مدة التسليم: ${deliveryDays} أيام)`,
          },
        });
        return created;
      },
    );
    return NextResponse.json(lab, { status: 201, headers: NO_STORE });
  } catch (error) {
    return canonicalLabFailure(error, "تعذّر حفظ بيانات المختبر.");
  }
}

export async function commandCanonicalUpdateLaboratoryResponse(
  session: VerifiedDurableSession,
  id: number,
  rawBody: unknown,
  pool: DbPool = getPool(),
): Promise<NextResponse> {
  const source = (rawBody ?? {}) as Record<string, unknown>;
  try {
    const updated = await withStaffOperation(
      pool,
      session,
      "clinical.laboratories.manage",
      async (client, handle) => {
        const input: Parameters<typeof updateLaboratoryWith>[2] = {};
        if (typeof source.name === "string") {
          const trimmed = source.name.trim();
          if (!trimmed || trimmed.length > 120) {
            throw new CanonicalLabRefusal("invalid_laboratory_input", 400, "اسم المختبر غير صالح.");
          }
          input.name = trimmed;
        }
        if (source.phone !== undefined) {
          input.phone =
            typeof source.phone === "string" && source.phone.trim() ? source.phone.trim().slice(0, 40) : null;
        }
        if (source.whatsapp !== undefined) {
          input.whatsapp =
            typeof source.whatsapp === "string" && source.whatsapp.trim()
              ? toWhatsAppNumber(source.whatsapp) ?? source.whatsapp.trim().slice(0, 40)
              : null;
        }
        if (source.address !== undefined) {
          input.address =
            typeof source.address === "string" && source.address.trim()
              ? source.address.trim().slice(0, 200)
              : null;
        }
        if (source.contactPerson !== undefined) {
          input.contactPerson =
            typeof source.contactPerson === "string" && source.contactPerson.trim()
              ? source.contactPerson.trim().slice(0, 100)
              : null;
        }
        if (source.currency !== undefined) {
          const cur = typeof source.currency === "string" ? source.currency.trim().toUpperCase() : "";
          if (isCurrency(cur)) {
            input.currency = cur as Currency;
          }
        }
        if (source.deliveryDays !== undefined) {
          const days = Number(source.deliveryDays);
          if (Number.isInteger(days) && days > 0 && days <= 365) {
            input.deliveryDays = days;
          }
        }
        if (source.note !== undefined) {
          input.note =
            typeof source.note === "string" && source.note.trim() ? source.note.trim().slice(0, 300) : null;
        }
        if (typeof source.isActive === "boolean") {
          input.isActive = source.isActive;
        }
        if (source.expenseAccountCode !== undefined) {
          input.expenseAccountCode =
            typeof source.expenseAccountCode === "string" && source.expenseAccountCode.trim()
              ? source.expenseAccountCode.trim().slice(0, 20)
              : "5101";
        }
        if (source.payableAccountCode !== undefined) {
          input.payableAccountCode =
            typeof source.payableAccountCode === "string" && source.payableAccountCode.trim()
              ? source.payableAccountCode.trim().slice(0, 20)
              : "2101";
        }
        if (typeof source.autoPostJournal === "boolean") {
          input.autoPostJournal = source.autoPostJournal;
        }
        if (source.customAccountName !== undefined) {
          input.customAccountName =
            typeof source.customAccountName === "string" && source.customAccountName.trim()
              ? source.customAccountName.trim().slice(0, 120)
              : null;
        }

        const identity = await staffOperationIdentity(client, handle, "clinical.laboratories.manage");
        const lab = await updateLaboratoryWith(client, id, input);
        if (!lab) {
          throw new CanonicalLabRefusal("laboratory_not_found", 404, "المختبر غير موجود.");
        }
        await insertAuditRow(client, {
          action: "settings.update",
          actor: identity.username,
          actorRole: identity.role,
          entity: "laboratory",
          entityId: String(id),
          entityLabel: lab.name,
          details: {
            entity: "laboratory",
            id,
            name: lab.name,
            message: `تعديل بيانات مختبر: ${lab.name} (معرّف ${id})`,
          },
        });
        return lab;
      },
    );
    return NextResponse.json(updated, { headers: NO_STORE });
  } catch (error) {
    return canonicalLabFailure(error, "تعذّر حفظ التعديلات.");
  }
}

export async function commandCanonicalDeleteLaboratoryResponse(
  session: VerifiedDurableSession,
  id: number,
  pool: DbPool = getPool(),
): Promise<NextResponse> {
  try {
    const payload = await withStaffOperation(
      pool,
      session,
      "clinical.laboratories.manage",
      async (client, handle) => {
        const existing = await getLaboratoryWith(client, id);
        if (!existing) {
          throw new CanonicalLabRefusal("laboratory_not_found", 404, "المختبر غير موجود.");
        }
        const identity = await staffOperationIdentity(client, handle, "clinical.laboratories.manage");
        const res = await deleteLaboratoryWith(client, id);
        await insertAuditRow(client, {
          action: "settings.update",
          actor: identity.username,
          actorRole: identity.role,
          entity: "laboratory",
          entityId: String(id),
          entityLabel: existing.name,
          details: {
            entity: "laboratory",
            id,
            action: res.reason === "deactivated" ? "deactivate" : "delete",
            name: existing.name,
            message:
              res.reason === "deactivated"
                ? `تعطيل مختبر لوجود سجلات سابقة: ${existing.name} (معرّف ${id})`
                : `حذف مختبر نهائيًا: ${existing.name} (معرّف ${id})`,
          },
        });
        return {
          ok: true,
          reason: res.reason,
          message:
            res.reason === "deactivated"
              ? "تم إلغاء تفعيل المختبر لاحتوائه على طلبات سابقة."
              : "تم حذف المختبر بنجاح.",
        };
      },
    );
    return NextResponse.json(payload, { headers: NO_STORE });
  } catch (error) {
    return canonicalLabFailure(error, "تعذّر حذف المختبر.");
  }
}
