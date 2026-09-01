import { NextResponse } from "next/server";
import { CLINIC_TIME_ZONE, createPatient, duplicateCandidates, findUserByUsername, listPatients, searchPatients } from "@/lib/db";
import { validatePatient } from "@/lib/patient";
import { clinicDateString } from "@/lib/schedule";
import { requireSession } from "@/lib/session";
import { duplicateWarning, findDuplicates } from "@/lib/duplicates";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

const PAGE_SIZE = 25;

export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  const params = new URL(request.url).searchParams;
  const term = params.get("q") ?? "";

  // عزل الطبيب (§٣٩): طبيبٌ مربوطٌ بجهته يرى مرضاه فقط — والفلترة في الاستعلام
  // نفسه لا بعد جلب النتائج، فما ليس له لا يصل إلى الشبكة أصلًا.
  // صلاحيات الوكيل المساعد: من منحه المدير «عرض جميع المرضى» صراحةً يُرفع عنه
  // العزل — المنح الاستثنائي يوثّقه عمود الصلاحيات لا خيارٌ في الشاشة.
  let doctorPartyId =
    session.role === "doctor" && typeof session.partyId === "number" && session.partyId > 0
      ? session.partyId
      : null;
  if (session.role === "doctor") {
    const user = await findUserByUsername(session.username).catch(() => null);
    if (user?.permissions?.canViewAllPatients) doctorPartyId = null;
  }

  try {
    if (term.trim()) return NextResponse.json(await searchPatients(term, 20, doctorPartyId));

    // بلا كلمة بحث: صفحة من كل المرضى. الحدّ مغلق هنا لا مأخوذ من الطلب — رقم ضخم
    // في `offset` أو `limit` يجرّ الجدول كله إلى هاتف الاستقبال.
    const page = Math.max(0, Math.floor(Number(params.get("page") ?? 0)) || 0);
    const { rows, total } = await listPatients(page * PAGE_SIZE, PAGE_SIZE, doctorPartyId);
    return NextResponse.json({ rows, total, page, pageSize: PAGE_SIZE });
  } catch {
    return NextResponse.json({ message: "تعذّر البحث. أعد المحاولة." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  /* صلاحيات الوكيل المساعد: الطبيب الذي أغلق المدير عليه «إضافة مريض» لا ينشئ
     ملفات — الاستقبال والإدارة يبقى لهم الحق دائمًا. */
  if (session.role === "doctor") {
    const user = await findUserByUsername(session.username).catch(() => null);
    if (user?.permissions && user.permissions.canAddPatient === false) {
      return NextResponse.json(
        { message: "إضافة المرضى مخفية عنك بحسب صلاحياتك." },
        { status: 403 },
      );
    }
  }
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const validation = validatePatient((body ?? {}) as Record<string, unknown>, today);
  if (!validation.ok) {
    return NextResponse.json({ message: validation.message, field: validation.field }, { status: 400 });
  }

  try {
    /*
     * كشف التكرار — **تحذير لا منع**.
     *
     * سجلٌّ ثانٍ لمريض موجود لا يظهر ثمنه يوم الإنشاء بل بعد شهور: تاريخٌ نصفه في
     * ملف ونصفه في آخر، ورصيدٌ منقسم فيبدو المريض غير مدين وهو مدين. ودمج ملفين
     * يحمل كلٌّ منهما فواتير ودفعات عملٌ محاسبي لا زرّ.
     *
     * ولا يُمنع الإنشاء: التوائم موجودة، والأب وابنه قد يتشاركان رقمًا. ونظامٌ يمنع
     * يعلّم الاستقبال أن تحتال عليه بنقطة في الاسم — فيصير التكرار أخفى لا أقلّ.
     * ولذلك يُرسل `confirmDuplicate` من الواجهة بعد أن يراها الموظف بعينه.
     */
    const confirmed = (body as Record<string, unknown>)?.confirmDuplicate === true;
    if (!confirmed) {
      const candidates = await duplicateCandidates(validation.value);
      const matches = findDuplicates(validation.value, candidates);
      if (matches.length > 0) {
        return NextResponse.json(
          { message: duplicateWarning(matches), duplicates: matches },
          { status: 409 },
        );
      }
    }
    return NextResponse.json(await createPatient(validation.value), { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ المريض. أعد المحاولة." }, { status: 500 });
  }
}
