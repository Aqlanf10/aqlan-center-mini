import { NextResponse } from "next/server";
import { countUsers, createFirstAdmin } from "@/lib/db";
import { hashPassword } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * إنشاء أول مدير — مرة واحدة فقط.
 *
 * الحماية طبقتان: رمز `SETUP_TOKEN` من متغيرات النشر، وشرط أن يكون جدول المستخدمين
 * فارغًا. الرمز وحده لا يكفي لأنه قد يتسرب، والفراغ وحده لا يكفي لأن هناك دقائق بين
 * النشر وأول دخول يستطيع فيها غريبٌ سبقك إلى الرابط أن يصير المدير.
 *
 * لا كلمة مرور افتراضية في الكود ولا في متغيرات البيئة: كلمة مرور افتراضية منشورة في
 * مستودع هي أسوأ من غياب تسجيل الدخول، لأنها توهم بالحماية.
 */
export async function POST(request: Request) {
  const expected = process.env.SETUP_TOKEN;
  if (!expected || expected.length < 16) {
    return NextResponse.json(
      { message: "الإعداد الأولي غير مفعّل. أضف SETUP_TOKEN في إعدادات النشر." },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  const source = (body ?? {}) as Record<string, unknown>;
  const token = typeof source.token === "string" ? source.token : "";
  if (token !== expected) {
    return NextResponse.json({ message: "رمز الإعداد غير صحيح." }, { status: 403 });
  }

  const username = typeof source.username === "string" ? source.username.trim() : "";
  const displayName = typeof source.displayName === "string" ? source.displayName.trim() : "";
  const password = typeof source.password === "string" ? source.password : "";

  if (!username || !displayName) {
    return NextResponse.json({ message: "اسم المستخدم والاسم الظاهر مطلوبان." }, { status: 400 });
  }
  // ثمانية أحرف حدٌّ أدنى صريح: بلا حدّ، أول كلمة مرور ستكون رقم الهاتف.
  if (password.length < 8) {
    return NextResponse.json({ message: "كلمة المرور يجب ألا تقل عن 8 أحرف." }, { status: 400 });
  }

  try {
    if ((await countUsers()) > 0) {
      return NextResponse.json(
        { message: "تم الإعداد مسبقًا. سجّل الدخول بحسابك." },
        { status: 409 },
      );
    }
    const admin = await createFirstAdmin({
      username,
      displayName,
      passwordHash: await hashPassword(password),
    });
    if (!admin) {
      return NextResponse.json({ message: "تم الإعداد مسبقًا. سجّل الدخول بحسابك." }, { status: 409 });
    }
    return NextResponse.json({ username: admin.username, displayName: admin.displayName }, { status: 201 });
  } catch (error) {
    // «أعد المحاولة» كانت نصيحة خاطئة حين تكون قاعدة البيانات غير مضبوطة: التكرار لن
    // يصنع قاعدة. ظهر هذا لمالك العيادة فعلًا وهو ينشئ حسابه الأول، فوقف بلا سبب معروف.
    const message = error instanceof Error && error.message.includes("قاعدة البيانات")
      ? "قاعدة البيانات غير مضبوطة بعد. افتح /api/health لمعرفة الناقص."
      : "تعذّر إنشاء الحساب. أعد المحاولة.";
    return NextResponse.json({ message }, { status: 503 });
  }
}
