/**
 * تفويض موارد أدوات الذكاء الاصطناعي: تثبيت هوية المريض وحلّ الموارد (P0.2/P0.3)
 *
 * الطبيب لا يرى ولا يعدّل مريضًا لطبيبٍ آخر إلا بصلاحيةٍ خادمية فعلية
 * (canViewAllPatients). و«معرّف المريض» الذي يصل من العميل أو من نصٍّ طبيعيّ
 * ليس هويةً موثوقة: يُحلّ **من النتائج المسموح بها فقط** ثم يُثبَّت رقمًا
 * دقيقًا في المعاملات المُنقّاة — وبعد التثبيت لا بحثَ عامًّا بالاسم داخل
 * الأداة.
 *
 * والمعرّفات غير المباشرة (موعد، وصفة، فاتورة، زيارة، أمر معمل، تحليل
 * سيفالو، مستند، خطة علاج) تُحلّ كلها إلى مريضها ثم يُطبَّق عليها
 * canAccessPatient والصلاحية الخاصة بالموارد — لا يكفي امتلاك المعرّف.
 */

import {
  getAppointment,
  getCephAnalysisForCompare,
  getClinicalVisit,
  getDocumentForDownload,
  getInvoice,
  getLabOrderById,
  getPatient,
  getPlan,
  getPrescription,
  searchPatients,
} from "../db";
import { canAccessPatient } from "../patient-access";
import type { SessionPayload } from "../auth";
import type { AiResourceKind, AiToolPolicy } from "./policy";
import type { AiToolContext, ToolExecutionResult } from "./types";

/** يبني حمولة جلسة من سياق الأداة — الهوية من الخادم لا من العميل. */
export function toSessionPayload(context: AiToolContext): SessionPayload {
  return {
    userId: context.userId ?? 1,
    username: context.username || context.userName || "anonymous",
    role: (context.role || context.userRole || "doctor") as string,
    expiresAt: Date.now() + 3600_000,
    partyId: context.doctorPartyId ?? undefined,
  };
}

export type PatientResolution =
  | { kind: "pinned"; patientId: number; patientName: string }
  | { kind: "disambiguation"; message: string }
  | { kind: "notFound"; message: string }
  | { kind: "denied" };

function scopeIdFor(context: AiToolContext): number | null {
  if (context.role !== "doctor" && context.userRole !== "doctor") return null;
  if (context.canViewAllPatients || context.permissions?.canViewAllPatients) return null;
  return context.doctorPartyId ?? null;
}

/**
 * تثبيت هوية المريض من معاملات غير موثوقة.
 *
 * - `patientId` معطى: يُتحقق من الوصول (canAccessPatient) — الرفض لا يكشف
 *   شيئًا عما إذا كان المريض موجودًا أصلًا.
 * - `patientName` معطى: البحث **بمجال الطبيب** — فالنتائج نفسها مسموحة،
 *   والتشابه المتعدد يطلب توضيحًا لا يعرض إلا مسموحًا به.
 * - بعد التثبيت يُعاد `patientId` دقيقًا ليحلّ محلّ الاسم في المعاملات.
 */
export async function resolvePatientForTool(
  params: Record<string, any>,
  context: AiToolContext,
): Promise<PatientResolution> {
  const session = toSessionPayload(context);

  const rawId = Number(params.patientId);
  if (Number.isInteger(rawId) && rawId > 0) {
    const allowed = await canAccessPatient(session, rawId).catch(() => false);
    if (!allowed) return { kind: "denied" };
    const patient = await getPatient(rawId).catch(() => null);
    return { kind: "pinned", patientId: rawId, patientName: patient?.fullName ?? `#${rawId}` };
  }

  const name = typeof params.patientName === "string" ? params.patientName.trim() : "";
  if (!name) return { kind: "notFound", message: "يرجى تحديد المريض بالاسم أو رقم الملف." };

  const scopeId = scopeIdFor(context);
  const matches = await searchPatients(name, 5, scopeId).catch(() => []);
  if (matches.length === 0) {
    return {
      kind: "notFound",
      message: `لم أجد مريضًا يطابق «${name}»${scopeId ? " ضمن الحالات المسندة إليك" : ""}.`,
    };
  }
  if (matches.length > 1) {
    const list = matches
      .map((m) => `• **${m.fullName}** (ملف: \`${m.patientNumber}\`)`)
      .join("\n");
    return {
      kind: "disambiguation",
      message: `يوجد أكثر من مريض يطابق «${name}»:\n${list}\n\nيرجى تحديد رقم الملف أو الاسم الكامل.`,
    };
  }
  return { kind: "pinned", patientId: matches[0].id, patientName: matches[0].fullName };
}

/** يحلّ معرف موردٍ غير مباشر إلى مريضه — أو null إن لم يوجد. */
export async function resolveResourcePatientId(
  kind: AiResourceKind,
  id: number,
): Promise<number | null> {
  try {
    switch (kind) {
      case "appointment": {
        const record = await getAppointment(id);
        return record?.patientId ?? null;
      }
      case "prescription": {
        const record = await getPrescription(id);
        return record?.patientId ?? null;
      }
      case "invoice": {
        const record = await getInvoice(id);
        return record?.patientId ?? null;
      }
      case "visit": {
        const record = await getClinicalVisit(id);
        return record?.patientId ?? null;
      }
      case "labOrder": {
        const record = await getLabOrderById(id);
        return record?.patientId ?? null;
      }
      case "cephAnalysis": {
        const record = await getCephAnalysisForCompare(id);
        return record?.patientId ?? null;
      }
      case "document": {
        const record = await getDocumentForDownload(id);
        return record?.document?.patientId ?? null;
      }
      case "treatmentPlan": {
        const record = await getPlan(id, new Date().toISOString().slice(0, 10));
        return record?.patientId ?? null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** المعرفات المباشرة التي تقبلها الأداة حسب نوع مواردها. */
const RESOURCE_PARAM_OF: Partial<Record<AiResourceKind, string>> = {
  appointment: "appointmentId",
  prescription: "prescriptionId",
  invoice: "invoiceId",
  visit: "visitId",
  labOrder: "labOrderId",
  cephAnalysis: "cephAnalysisId",
  document: "documentId",
  treatmentPlan: "treatmentPlanId",
};

export interface ScopingOutcome {
  /** المعاملات بعد التثبيت والتنقية — هذه وحدها تصل إلى الأداة. */
  sanitizedParams: Record<string, any>;
  /** رقم المريض المثبَّت إن حُلّ. */
  patientId?: number;
  patientName?: string;
  /** نتيجة تُعرض فورًا بدل التنفيذ (رفض عزل / توضيح / عدم وجود). */
  refusal?: ToolExecutionResult;
}

/**
 * بوابة العزل والتثبيت الموحدة قبل تنفيذ أي أداة — تُطبَّق في التنفيذ الأول
 * وفي التنفيذ بعد التأكيد معًا، فالإعادة تُعيد فحص الملكية من جديد.
 */
export async function applyPatientScoping(
  policy: AiToolPolicy,
  params: Record<string, any>,
  context: AiToolContext,
): Promise<ScopingOutcome> {
  const sanitized: Record<string, any> = { ...params };
  if (!policy.patientScoped && !policy.resourceKinds?.length) {
    return { sanitizedParams: sanitized };
  }

  /* ١) الموارد غير المباشرة: معرّف المورد يُحلّ إلى مريضه ثم يُفحص الوصول. */
  if (policy.resourceKinds?.length) {
    const session = toSessionPayload(context);
    for (const kind of policy.resourceKinds) {
      const paramName = RESOURCE_PARAM_OF[kind];
      if (!paramName) continue;
      const rawResourceId = Number(sanitized[paramName]);
      if (!Number.isInteger(rawResourceId) || rawResourceId <= 0) continue;
      const patientId = await resolveResourcePatientId(kind, rawResourceId);
      if (patientId == null) {
        return {
          sanitizedParams: sanitized,
          refusal: {
            success: false,
            textSummary: `لم أجد ${RESOURCE_LABEL[kind]} رقم #${rawResourceId}.`,
          },
        };
      }
      const allowed = await canAccessPatient(session, patientId).catch(() => false);
      if (!allowed) {
        return {
          sanitizedParams: sanitized,
          refusal: {
            success: false,
            textSummary: DENIED_TEXT,
            warnings: [`محاولة وصول عبر ${RESOURCE_LABEL[kind]} #${rawResourceId} لمريض غير مسند`],
          },
        };
      }
      sanitized.patientId = patientId;
      if (!sanitized.patientName) {
        const patient = await getPatient(patientId).catch(() => null);
        if (patient) sanitized.patientName = patient.fullName;
      }
    }
  }

  /* ٢) هوية المريض: تثبيتها من المسموح به فقط. */
  if (policy.patientScoped) {
    const resolution = await resolvePatientForTool(sanitized, context);
    if (resolution.kind === "denied") {
      return {
        sanitizedParams: sanitized,
        refusal: { success: false, textSummary: DENIED_TEXT, warnings: ["عزل الأطباء: مريض غير مسند"] },
      };
    }
    if (resolution.kind === "notFound") {
      return {
        sanitizedParams: sanitized,
        refusal: { success: false, textSummary: resolution.message },
      };
    }
    if (resolution.kind === "disambiguation") {
      return {
        sanitizedParams: sanitized,
        refusal: { success: false, textSummary: resolution.message },
      };
    }
    /* المريض مثبَّت: المعاملات تحمل رقمه الدقيق، وبعد التثبيت لا بحث بالاسم. */
    sanitized.patientId = resolution.patientId;
    sanitized.patientName = resolution.patientName;
    return {
      sanitizedParams: sanitized,
      patientId: resolution.patientId,
      patientName: resolution.patientName,
    };
  }

  return { sanitizedParams: sanitized };
}

const DENIED_TEXT =
  "🔒 **تنبيه أمني:** ليس لديك صلاحية للوصول إلى هذا المريض (عزل الكادر السريري).";

const RESOURCE_LABEL: Record<AiResourceKind, string> = {
  appointment: "الموعد",
  prescription: "الوصفة",
  invoice: "الفاتورة",
  visit: "الزيارة",
  labOrder: "أمر المعمل",
  cephAnalysis: "تحليل السيفالو",
  document: "المستند",
  treatmentPlan: "خطة العلاج",
};
