import { NextResponse } from "next/server";
import {
  CLINIC_TIME_ZONE,
  deletePatientCascade,
  doctorOwnsPatient,
  findUserByUsername,
  getPatientFile,
  updatePatient,
} from "@/lib/db";
import { validatePatient } from "@/lib/patient";
import { isAdmin } from "@/lib/roles";
import { clinicDateString } from "@/lib/schedule";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

function readId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** عزل الطبيب (§٣٩): طبيبٌ مربوطٌ لا يفتح ملفًا ليس من مرضاه — والفحص في الخادم.
 * صلاحيات الوكيل المساعد: منحه المدير «عرض جميع المرضى» يرفع الحجب عنه. */
async function doctorBlocked(patientId: number, skipAllGrant = false): Promise<string | null> {
  const session = await requireSession();
  if (!session) return "انتهت الجلسة. سجّل الدخول من جديد.";
  if (session.role === "doctor" && typeof session.partyId === "number" && session.partyId) {
    const user = await findUserByUsername(session.username).catch(() => null);
    if (!skipAllGrant && user?.permissions?.canViewAllPatients) return null;
    const owns = await doctorOwnsPatient(session.partyId, patientId).catch(() => false);
    if (!owns) return "هذا الملف ليس من مرضاك.";
  }
  return null;
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  const { id: rawId } = await context.params;
  const id = readId(rawId);
  if (id === null) return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400 });

  const blocked = await doctorBlocked(id);
  if (blocked) {
    return NextResponse.json({ message: blocked }, { status: blocked.includes("جلسة") ? 401 : 403 });
  }

  try {
    const file = await getPatientFile(id);
    if (!file) return NextResponse.json({ message: "لا يوجد مريض بهذا الرقم." }, { status: 404 });
    return NextResponse.json(file);
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل ملف المريض." }, { status: 500 });
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  const { id: rawId } = await context.params;
  const id = readId(rawId);
  if (id === null) return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400 });

  /* صلاحيات الوكيل المساعد: تعديل بيانات المريض بابٌ يغلقه المدير على من يشاء،
     والعزل يبقى قائمًا حتى على من أُذن له بالعرض — الرؤية شيء والكتابة شيء. */
  if (session.role === "doctor") {
    const user = await findUserByUsername(session.username).catch(() => null);
    if (user?.permissions && user.permissions.canEditPatient === false) {
      return NextResponse.json(
        { message: "تعديل بيانات المرضى مخفي عنك بحسب صلاحياتك." },
        { status: 403 },
      );
    }
  }

  const blocked = await doctorBlocked(id, true);
  if (blocked) {
    return NextResponse.json({ message: blocked }, { status: blocked.includes("جلسة") ? 401 : 403 });
  }

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  // التعديل يمرّ من نفس تحقّق الإنشاء: قاعدتان مختلفتان للاسم أو سنة الميلاد تعنيان
  // أن ما يُرفض عند الإنشاء يدخل من باب التعديل.
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const current = await getPatientFile(id).catch(() => null);
  if (!current) return NextResponse.json({ message: "لا يوجد مريض بهذا الرقم." }, { status: 404 });

  const merged = {
    fullName: source.fullName ?? current.patient.fullName,
    phone: source.phone ?? current.patient.phone ?? "",
    altPhone: source.altPhone ?? current.patient.altPhone ?? "",
    gender: source.gender ?? current.patient.gender,
    birthYear: source.birthYear ?? current.patient.birthYear ?? "",
    address: source.address ?? current.patient.address ?? "",
    medicalAlert: source.medicalAlert ?? current.patient.medicalAlert ?? "",
    note: source.note ?? current.patient.note ?? "",
  };

  const validation = validatePatient(merged, today);
  if (!validation.ok) {
    return NextResponse.json({ message: validation.message, field: validation.field }, { status: 400 });
  }

  try {
    const updated = await updatePatient(id, validation.value);
    if (!updated) return NextResponse.json({ message: "لا يوجد مريض بهذا الرقم." }, { status: 404 });
    return NextResponse.json(updated);
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ التعديل. أعد المحاولة." }, { status: 500 });
  }
}

/* حذف ملف المريض نهائيًا بكل سجلاته — المدير وحده: يمحو الزيارات والمواعيد
 * والفواتير والدفعات والخطط والأشعة وأعمال المعمل في معاملة واحدة، ويترك
 * صورةً كاملة في سجل التدقيق. التأكيد بالإجابة برقم الملف نفسه من الواجهة. */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  if (!isAdmin(session.role)) {
    return NextResponse.json(
      { message: "حذف ملفات المرضى للمدير وحده." },
      { status: 403 },
    );
  }
  const { id: rawId } = await context.params;
  const id = readId(rawId);
  if (id === null) return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400 });

  /* عزلة الطبيب تسري حتى على العرض، فتسري على الحذف من باب أولى — لكن الحذف
   * مديريّ أصلًا، والفحص صمّام إضافي. */
  const blocked = await doctorBlocked(id, true);
  if (blocked) {
    return NextResponse.json({ message: blocked }, { status: blocked.includes("جلسة") ? 401 : 403 });
  }

  let reason: string | null = null;
  let confirmNumber: string | null = null;
  try {
    const body = await request.json();
    const source = (body ?? {}) as Record<string, unknown>;
    if (typeof source.reason === "string" && source.reason.trim()) {
      reason = source.reason.trim().slice(0, 300);
    }
    if (typeof source.confirmPatientNumber === "string") {
      confirmNumber = source.confirmPatientNumber.trim();
    }
  } catch {
    /* الجسم فارغ — يُرفض التحذير أدناه */
  }

  /* تأكيد صارم: رقم الملف نفسه — حذف سجلٍ كامل بضغطة عابرة كارثةٌ لا تُدار. */
  const file = await getPatientFile(id).catch(() => null);
  if (!file) return NextResponse.json({ message: "لا يوجد مريض بهذا الرقم." }, { status: 404 });
  if (confirmNumber !== file.patient.patientNumber) {
    return NextResponse.json(
      { message: "تأكيد الحذف يتطلب كتابة رقم ملف المريض نفسه." },
      { status: 400 },
    );
  }

  try {
    const result = await deletePatientCascade(id, {
      actor: session.username,
      actorRole: session.role,
      reason,
    });
    if (!result.ok) {
      return NextResponse.json({ message: "لا يوجد مريض بهذا الرقم." }, { status: 404 });
    }
    return NextResponse.json({
      message: `حُذف ملف «${file.patient.fullName}» بكل سجلاته وسُجّل الحذف في التدقيق.`,
      counts: result.counts ?? {},
    });
  } catch {
    return NextResponse.json(
      { message: "تعذّر حذف الملف — أعد المحاولة أو راجع سجل التدقيق." },
      { status: 500 },
    );
  }
}
