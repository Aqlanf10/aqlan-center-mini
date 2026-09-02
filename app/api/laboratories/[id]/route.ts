import { NextResponse } from "next/server";
import { deleteLaboratory, getLaboratory, recordAudit, updateLaboratory } from "@/lib/db";
import { isCurrency, type Currency } from "@/lib/money";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { toWhatsAppNumber } from "@/lib/reminders";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

export async function GET(
  _request: Request,
  props: { params: Promise<{ id: string }> }
) {
  const session = await requireSession();
  if (!session) return denied();
  const params = await props.params;
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "معرّف غير صالح." }, { status: 400 });
  }

  try {
    const lab = await getLaboratory(id);
    if (!lab) {
      return NextResponse.json({ message: "المختبر غير موجود." }, { status: 404 });
    }
    return NextResponse.json(lab);
  } catch (error) {
    console.error("Failed to get laboratory:", error);
    return NextResponse.json({ message: "تعذّر جلب بيانات المختبر." }, { status: 500 });
  }
}

export async function PATCH(
  request: Request,
  props: { params: Promise<{ id: string }> }
) {
  const session = await requireSession();
  if (!session) return denied();
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "إدارة المختبرات للمدير وحده." }, { status: 403 });
  }

  const params = await props.params;
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "معرّف غير صالح." }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  const input: Parameters<typeof updateLaboratory>[1] = {};

  if (typeof source.name === "string") {
    const trimmed = source.name.trim();
    if (!trimmed || trimmed.length > 120) {
      return NextResponse.json({ message: "اسم المختبر غير صالح." }, { status: 400 });
    }
    input.name = trimmed;
  }

  if (source.phone !== undefined) {
    input.phone = typeof source.phone === "string" && source.phone.trim()
      ? source.phone.trim().slice(0, 40)
      : null;
  }

  if (source.whatsapp !== undefined) {
    input.whatsapp = typeof source.whatsapp === "string" && source.whatsapp.trim()
      ? toWhatsAppNumber(source.whatsapp) ?? source.whatsapp.trim().slice(0, 40)
      : null;
  }

  if (source.address !== undefined) {
    input.address = typeof source.address === "string" && source.address.trim()
      ? source.address.trim().slice(0, 200)
      : null;
  }

  if (source.contactPerson !== undefined) {
    input.contactPerson = typeof source.contactPerson === "string" && source.contactPerson.trim()
      ? source.contactPerson.trim().slice(0, 100)
      : null;
  }

  if (source.currency !== undefined) {
    const cur = typeof source.currency === "string" ? source.currency.trim().toUpperCase() : "";
    if (isCurrency(cur)) {
      input.currency = cur as Currency;
    }
  }

  if (source.deliveryDays !== undefined) {
    const days = Number(source.deliveryDays);
    if (Number.isInteger(days) && days > 0 && days <= 365) {
      input.deliveryDays = days;
    }
  }

  if (source.note !== undefined) {
    input.note = typeof source.note === "string" && source.note.trim()
      ? source.note.trim().slice(0, 300)
      : null;
  }

  if (typeof source.isActive === "boolean") {
    input.isActive = source.isActive;
  }

  if (source.expenseAccountCode !== undefined) {
    input.expenseAccountCode = typeof source.expenseAccountCode === "string" && source.expenseAccountCode.trim()
      ? source.expenseAccountCode.trim().slice(0, 20)
      : "5101";
  }

  if (source.payableAccountCode !== undefined) {
    input.payableAccountCode = typeof source.payableAccountCode === "string" && source.payableAccountCode.trim()
      ? source.payableAccountCode.trim().slice(0, 20)
      : "2101";
  }

  if (typeof source.autoPostJournal === "boolean") {
    input.autoPostJournal = source.autoPostJournal;
  }

  if (source.customAccountName !== undefined) {
    input.customAccountName = typeof source.customAccountName === "string" && source.customAccountName.trim()
      ? source.customAccountName.trim().slice(0, 120)
      : null;
  }

  try {
    const updated = await updateLaboratory(id, input);
    if (!updated) {
      return NextResponse.json({ message: "المختبر غير موجود." }, { status: 404 });
    }

    await recordAudit({
      action: "settings.update",
      actor: session.username,
      details: {
        entity: "laboratory",
        id,
        name: updated.name,
        message: `تعديل بيانات مختبر: ${updated.name} (معرّف ${id})`,
      },
    });

    return NextResponse.json(updated);
  } catch (error) {
    console.error("Failed to update laboratory:", error);
    return NextResponse.json({ message: "تعذّر حفظ التعديلات." }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  props: { params: Promise<{ id: string }> }
) {
  const session = await requireSession();
  if (!session) return denied();
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "إدارة المختبرات للمدير وحده." }, { status: 403 });
  }

  const params = await props.params;
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "معرّف غير صالح." }, { status: 400 });
  }

  try {
    const existing = await getLaboratory(id);
    if (!existing) {
      return NextResponse.json({ message: "المختبر غير موجود." }, { status: 404 });
    }

    const res = await deleteLaboratory(id);
    await recordAudit({
      action: "settings.update",
      actor: session.username,
      details: {
        entity: "laboratory",
        id,
        action: res.reason === "deactivated" ? "deactivate" : "delete",
        name: existing.name,
        message: res.reason === "deactivated"
          ? `تعطيل مختبر لوجود سجلات سابقة: ${existing.name} (معرّف ${id})`
          : `حذف مختبر نهائيًا: ${existing.name} (معرّف ${id})`,
      },
    });

    return NextResponse.json({
      ok: true,
      reason: res.reason,
      message: res.reason === "deactivated"
        ? "تم إلغاء تفعيل المختبر لاحتوائه على طلبات سابقة."
        : "تم حذف المختبر بنجاح.",
    });
  } catch (error) {
    console.error("Failed to delete laboratory:", error);
    return NextResponse.json({ message: "تعذّر حذف المختبر." }, { status: 500 });
  }
}
