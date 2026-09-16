/**
 * حراسةُ الموارد التشغيلية — الموعد والزيارة.
 *
 * العطب الذي تُغلقه: مسارات `PATCH /api/appointments/[id]` و`PATCH /api/visits/[id]`
 * كانت تسأل «هل معك جلسة؟» ولا تسأل «هل هذا المريض لك؟». وطبيبٌ موثَّق يستطيع —
 * بمناداة المسار مباشرةً لا بالضغط على زرّ — أن يُسجّل وصولَ مريض زميله، أو يُلغي
 * موعده، أو يُنهي زيارته، أو يربط زيارةً بملفٍّ لا يملكه. **وإخفاءُ الزرّ في
 * الشاشة ليس تفويضًا.**
 *
 * والمريضُ يُحسم **من المورد في الخادم** لا ممّا يرسله الطلب: رقمُ مريضٍ في جسد
 * الطلب يكتبه المُنادي، فحراسةٌ تصدّقه تحرس نفسها لا الملفّ.
 *
 * وتُعاد «غير موجود» لمن لا يملك كما تُعاد لمن طلب رقمًا معدومًا — فلا يُستدلّ من
 * اختلاف الردّين على أنّ لهذا الرقم موعدًا أو زيارة.
 */
import { canAccessPatient } from "./patient-access";
import { getAppointment, getVisitOwner } from "./db";
import type { SessionPayload } from "./auth";

export type ResourceVerdict =
  | { ok: true; patientId: number | null }
  | { ok: false; status: 404; message: string };

const MISSING_APPOINTMENT = "الموعد غير موجود.";
const MISSING_VISIT = "الزيارة غير موجودة.";

/** فعلٌ على موعد: يُحسم مريضُه من الجدول ثمّ يُسأل حارسُ الملفّ. */
export async function authorizeAppointment(
  session: SessionPayload, appointmentId: number,
): Promise<ResourceVerdict> {
  const appointment = await getAppointment(appointmentId).catch(() => null);
  if (!appointment) return { ok: false, status: 404, message: MISSING_APPOINTMENT };
  if (!(await canAccessPatient(session, appointment.patientId))) {
    return { ok: false, status: 404, message: MISSING_APPOINTMENT };
  }
  return { ok: true, patientId: appointment.patientId };
}

/**
 * فعلٌ على زيارة.
 *
 * وزيارةٌ بلا ملفّ لا تُقصي أحدًا من الطاقم: طابورُ الصالة مشترك، ومريضٌ مشى إلى
 * المركز ليس ملكًا لطبيبٍ بعد. أمّا المربوطة بملفّ فيحرسها حارسُ الملفّ نفسه.
 */
export async function authorizeVisit(
  session: SessionPayload, visitId: number,
): Promise<ResourceVerdict> {
  const owner = await getVisitOwner(visitId).catch(() => ({ found: false, patientId: null }));
  if (!owner.found) return { ok: false, status: 404, message: MISSING_VISIT };
  if (owner.patientId === null) return { ok: true, patientId: null };
  if (!(await canAccessPatient(session, owner.patientId))) {
    return { ok: false, status: 404, message: MISSING_VISIT };
  }
  return { ok: true, patientId: owner.patientId };
}

/**
 * ربطُ زيارةٍ بملفّ — يُحرس **من الطرفين**.
 *
 * الزيارةُ قد تكون غير مربوطة فتمرّ من `authorizeVisit`، لكنّ الملفَّ الذي تُربط
 * به هدفٌ مستقلّ: من لا يملكه لا يُلحق به زيارة. وبلا هذا الفحص يصير الربطُ بابًا
 * لكتابة اسم زيارةٍ في ملفٍّ لا يملكه الفاعل.
 */
export async function authorizeVisitLink(
  session: SessionPayload, visitId: number, targetPatientId: number,
): Promise<ResourceVerdict> {
  const visit = await authorizeVisit(session, visitId);
  if (!visit.ok) return visit;
  if (!(await canAccessPatient(session, targetPatientId))) {
    return { ok: false, status: 404, message: "الملفّ غير موجود." };
  }
  return { ok: true, patientId: targetPatientId };
}
