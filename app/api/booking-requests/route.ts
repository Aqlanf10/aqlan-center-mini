import { NextResponse } from "next/server";
import { listBookingRequests } from "@/lib/db";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  if (session.role !== "admin" && session.role !== "reception") {
    return NextResponse.json({ message: "عرض طلبات الحجز للاستقبال والإدارة." }, { status: 403 });
  }
  const status = new URL(request.url).searchParams.get("status") ?? "new";
  if (status !== "new" && status !== "confirmed" && status !== "rejected") {
    return NextResponse.json({ message: "حالة غير معروفة." }, { status: 400 });
  }
  try {
    return NextResponse.json(await listBookingRequests(status));
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل الطلبات." }, { status: 500 });
  }
}
