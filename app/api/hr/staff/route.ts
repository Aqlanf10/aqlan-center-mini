import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { createStaff, isHrContractKind, isHrDepartment, isHrWorkStatus, listStaff, validatePayTermsInput, type CreateStaffInput } from "@/lib/hr";
import { canManageStaff } from "@/lib/hr";
import { cleanDate, cleanOptionalText } from "@/lib/hr";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
const forbidden = () =>
  NextResponse.json({ message: "إدارة ملفات الطاقم وشروط الأجر للمدير وحده." }, { status: 403 });

/** قائمة الطاقم — للمدير وحده: بها شروط الأجر فلا تخرج عنه. */
export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canManageStaff(session.role)) return forbidden();
  const url = new URL(request.url);
  const department = url.searchParams.get("department");
  const status = url.searchParams.get("status");
  const search = url.searchParams.get("q");
  try {
    const staff = await listStaff({
      department: department && isHrDepartment(department) ? department : null,
      status: status && ["active", "suspended", "ended"].includes(status) ? (status as "active" | "suspended" | "ended") : null,
      search: search ? search.slice(0, 120) : null,
      includePayTerms: true,
    });
    return NextResponse.json(staff);
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل الطاقم." }, { status: 500 });
  }
}

/** إنشاء ملف موظف — بلا حساب دخولٍ تلقائي ولا جهة طبيب: الربط اختياري لاحقًا. */
export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canManageStaff(session.role)) return forbidden();

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  const fullName = typeof source.fullName === "string" ? source.fullName.trim() : "";
  if (fullName.length < 2 || fullName.length > 120) {
    return NextResponse.json({ message: "اكتب اسم الموظف الكامل (من حرفين إلى 120)." }, { status: 400 });
  }
  const jobTitle = cleanOptionalText(source.jobTitle, 80);
  if (jobTitle === undefined) {
    return NextResponse.json({ message: "المسمى الوظيفي نصٌّ حتى 80 حرفًا." }, { status: 400 });
  }
  if (!isHrDepartment(source.department)) {
    return NextResponse.json({ message: "اختر قسم الموظف." }, { status: 400 });
  }
  const hireDate = cleanDate(source.hireDate);
  if (hireDate === undefined) {
    return NextResponse.json({ message: "تاريخ الالتحاق بصيغة YYYY-MM-DD." }, { status: 400 });
  }
  // الحالة التي اختارها المستخدم تُحفظ كما هي — لا «نشط» مفروض من الخادم.
  const workStatus = isHrWorkStatus(source.workStatus) ? source.workStatus : "active";
  const endDate = cleanDate(source.endDate);
  if (endDate === undefined) {
    return NextResponse.json({ message: "تاريخ انتهاء الخدمة بصيغة YYYY-MM-DD." }, { status: 400 });
  }
  if (endDate !== null && endDate < (hireDate ?? "")) {
    return NextResponse.json({ message: "تاريخ انتهاء الخدمة لا يسبق تاريخ الالتحاق." }, { status: 400 });
  }
  if (!isHrContractKind(source.contractKind)) {
    return NextResponse.json({ message: "اختر نوع التعاقد: نسبة أو راتب أو راتب ونسبة." }, { status: 400 });
  }
  const contractKind = source.contractKind;
  let payTerms = null;
  const payValidation = validatePayTermsInput(source);
  if (typeof payValidation === "string") {
    return NextResponse.json({ message: payValidation }, { status: 400 });
  }
  if (payValidation !== null) {
    if (contractKind === "commission") {
      return NextResponse.json(
        { message: "تعاقد «نسبة» بلا راتب: احذف مبلغ الراتب أو اختر راتبًا/راتبًا ونسبة." },
        { status: 400 },
      );
    }
    payTerms = payValidation;
  } else if (contractKind !== "commission") {
    return NextResponse.json(
      { message: "لراتبٍ أو راتبٍ ونسبة: اكتب المبلغ وعملته ودوريته وتاريخ سريانه." },
      { status: 400 },
    );
  }
  const phone = cleanOptionalText(source.phone, 40);
  if (phone === undefined) {
    return NextResponse.json({ message: "الهاتف نصٌّ حتى 40 حرفًا." }, { status: 400 });
  }
  const note = cleanOptionalText(source.note, 2000);
  if (note === undefined) {
    return NextResponse.json({ message: "الملاحظة نصٌّ حتى 2000 حرف." }, { status: 400 });
  }

  const input: CreateStaffInput = {
    fullName, jobTitle: jobTitle ?? "", department: source.department, hireDate: hireDate ?? null,
    workStatus, endDate, contractKind, payTerms, phone: phone ?? null, note: note ?? null,
  };
  try {
    const staff = await createStaff(input, session);
    return NextResponse.json(staff, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر إنشاء ملف الموظف." }, { status: 500 });
  }
}
