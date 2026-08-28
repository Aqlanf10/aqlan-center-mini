import { NextResponse } from "next/server";
import { createParty, listParties } from "@/lib/db";
import { isPartyKind } from "@/lib/expenses";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

export async function GET(request: Request) {
  if (!(await requireSession())) return denied();
  const kind = new URL(request.url).searchParams.get("kind");
  try {
    return NextResponse.json(await listParties(isPartyKind(kind) ? kind : undefined));
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل الجهات." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  // نسبة العمولة تحكم ما يُصرف للأطباء شهريًا، فإنشاء الجهات وتعديلها للمدير وحده.
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "إدارة الجهات للمدير وحده." }, { status: 403 });
  }

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  const name = typeof source.name === "string" ? source.name.trim() : "";
  if (!name || name.length > 120) {
    return NextResponse.json({ message: "اكتب اسم الجهة." }, { status: 400 });
  }
  if (!isPartyKind(source.kind)) {
    return NextResponse.json({ message: "اختر نوع الجهة." }, { status: 400 });
  }

  const percentRaw = Number(String(source.commissionPercent ?? 0).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)));
  // نسبة فوق المئة أو سالبة تعني عمولة تفوق قيمة العمل نفسه — خطأ إدخال لا سياسة.
  if (!Number.isFinite(percentRaw) || percentRaw < 0 || percentRaw > 100) {
    return NextResponse.json({ message: "النسبة بين 0 و100." }, { status: 400 });
  }

  const phone = typeof source.phone === "string" && source.phone.trim()
    ? source.phone.trim().slice(0, 40) : null;
  const note = typeof source.note === "string" && source.note.trim()
    ? source.note.trim().slice(0, 300) : null;

  try {
    return NextResponse.json(
      await createParty({ name, kind: source.kind, phone, commissionPercent: percentRaw, note }),
      { status: 201 },
    );
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ الجهة." }, { status: 500 });
  }
}
