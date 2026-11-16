import { NextResponse } from "next/server";
import { getPortalPublicBootstrap } from "@/lib/portal-data";

export const dynamic = "force-dynamic";

/**
 * بيانات التمهيد العامة الآمنة لشاشة بوابة المريض قبل تسجيل الدخول:
 * - الهوية البصرية الرسمية للمركز (الاسم، الهاتف، العنوان، أوقات الدوام، الشعار).
 * - وضع التشغيل الحالي وإتاحة الحجز والإعلانات العامة المنشورة ضمن نافذتها الزمنية.
 * - لا يعيد أي بيانات مرضى أو معرّفات داخلية إطلاقًا.
 */
export async function GET() {
  try {
    const bootstrap = await getPortalPublicBootstrap();
    return NextResponse.json(bootstrap, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch {
    return NextResponse.json(
      { message: "تعذّر تحميل بيانات البوابة العامة الآن." },
      { status: 500 },
    );
  }
}
