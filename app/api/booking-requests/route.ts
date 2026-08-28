import { NextResponse } from "next/server";
import { listBookingRequests } from "@/lib/db";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!(await requireSession())) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
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
