import { NextResponse } from "next/server";
import { createLaboratory, listLaboratories, recordAudit } from "@/lib/db";
import { isCurrency, type Currency } from "@/lib/money";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { toWhatsAppNumber } from "@/lib/reminders";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

export async function GET() {
  const session = await requireSession();
  if (!session) return denied();
  try {
    const laboratories = await listLaboratories();
    return NextResponse.json({ laboratories });
  } catch (error) {
    console.error("Failed to list laboratories:", error);
    return NextResponse.json({ message: "تعذّر تحميل بيانات المختبرات." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "إدارة المختبرات للمدير وحده." }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  const name = typeof source.name === "string" ? source.name.trim() : "";
  if (!name || name.length > 120) {
    return NextResponse.json({ message: "يرجى كتابة اسم المختبر (أقل من 120 حرف)." }, { status: 400 });
  }

  const phone = typeof source.phone === "string" && source.phone.trim()
    ? source.phone.trim().slice(0, 40)
    : null;

  let whatsapp: string | null = null;
  if (typeof source.whatsapp === "string" && source.whatsapp.trim()) {
    whatsapp = toWhatsAppNumber(source.whatsapp) ?? source.whatsapp.trim().slice(0, 40);
  }

  const address = typeof source.address === "string" && source.address.trim()
    ? source.address.trim().slice(0, 200)
    : null;

  const contactPerson = typeof source.contactPerson === "string" && source.contactPerson.trim()
    ? source.contactPerson.trim().slice(0, 100)
    : null;

  const currencyRaw = typeof source.currency === "string" ? source.currency.trim().toUpperCase() : "YER";
  const currency: Currency = isCurrency(currencyRaw) ? currencyRaw : "YER";

  const deliveryDaysRaw = Number(source.deliveryDays ?? 7);
  const deliveryDays = Number.isInteger(deliveryDaysRaw) && deliveryDaysRaw > 0 && deliveryDaysRaw <= 365
    ? deliveryDaysRaw
    : 7;

  const note = typeof source.note === "string" && source.note.trim()
    ? source.note.trim().slice(0, 300)
    : null;

  const isActive = source.isActive !== false;

  const expenseAccountCode = typeof source.expenseAccountCode === "string" && source.expenseAccountCode.trim()
    ? source.expenseAccountCode.trim().slice(0, 20)
    : "5101";

  const payableAccountCode = typeof source.payableAccountCode === "string" && source.payableAccountCode.trim()
    ? source.payableAccountCode.trim().slice(0, 20)
    : "2101";

  const autoPostJournal = source.autoPostJournal !== false;

  const customAccountName = typeof source.customAccountName === "string" && source.customAccountName.trim()
    ? source.customAccountName.trim().slice(0, 120)
    : null;

  try {
    const lab = await createLaboratory({
      name,
      phone,
      whatsapp,
      address,
      contactPerson,
      currency,
      deliveryDays,
      note,
      isActive,
      expenseAccountCode,
      payableAccountCode,
      autoPostJournal,
      customAccountName,
    });

    await recordAudit({
      action: "settings.update",
      actor: session.username,
      details: {
        entity: "laboratory",
        name,
        currency,
        deliveryDays,
        message: `إضافة مختبر جديد: ${name} (العملة: ${currency}، مدة التسليم: ${deliveryDays} أيام)`,
      },
    });

    return NextResponse.json(lab, { status: 201 });
  } catch (error) {
    console.error("Failed to create laboratory:", error);
    return NextResponse.json({ message: "تعذّر حفظ بيانات المختبر." }, { status: 500 });
  }
}
