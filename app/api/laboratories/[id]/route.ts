import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { deleteLaboratory, getLaboratory, recordAudit, updateLaboratory } from "@/lib/db";
import { isCurrency, type Currency } from "@/lib/money";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { toWhatsAppNumber } from "@/lib/reminders";

import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { NO_STORE, canonicalPatientReadFailure } from "@/lib/canonical-patient-http";
import { CanonicalLabDirectoryRefusal, commandCanonicalLaboratoryDelete, commandCanonicalLaboratoryUpdate, readCanonicalLaboratories } from "@/lib/canonical-lab-directory";
export const dynamic = "force-dynamic";

const SESSION_ENDED = "انتهت الجلسة. سجّل الدخول من جديد.";
/** M2 slice 70a: the canonical branch of a lab-directory request — never the legacy session. */
async function canonicalDirectory(run: (handle: import("@/lib/staff-durable-session").VerifiedDurableSession) => Promise<unknown>, fallback: string, status = 200): Promise<NextResponse | null> {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: SESSION_ENDED }, { status: 401, headers: NO_STORE });
  if (selected.kind !== "canonical") return null;
  try {
    return NextResponse.json(await run(selected.handle), { status, headers: NO_STORE });
  } catch (error) {
    if (error instanceof CanonicalLabDirectoryRefusal) return NextResponse.json({ code: error.code, message: error.message, ...(error.field ? { field: error.field } : {}) }, { status: error.status, headers: NO_STORE });
    return canonicalPatientReadFailure(error, fallback);
  }
}
async function canonicalBody(request: Request): Promise<Record<string, unknown> | NextResponse> {
  try {
    const body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
    return (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  } catch (error) {
    return bodyErrorResponse(error) ?? NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE });
  }
}

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

export async function GET(
  _request: Request,
  props: { params: Promise<{ id: string }> }
) {
  {
    const rawId = (await props.params).id;
    const canonical = await canonicalDirectory(handle => readCanonicalLaboratories(handle, rawId), "تعذّر جلب بيانات المختبر.");
    if (canonical) return canonical;
  }
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
  if ((await selectRequestStaffEnvelope()).kind === "canonical") {
    const rawId = (await props.params).id;
    const body = await canonicalBody(request);
    if (body instanceof NextResponse) return body;
    return (await canonicalDirectory(handle => commandCanonicalLaboratoryUpdate(handle, rawId, body), "تعذّر حفظ التعديلات."))!;
  }
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
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
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
  {
    const rawId = (await props.params).id;
    const canonical = await canonicalDirectory(async handle => {
      const result = await commandCanonicalLaboratoryDelete(handle, rawId);
      return { ok: true, reason: result.deactivated ? "deactivated" : undefined,
        message: result.deactivated ? "تم إلغاء تفعيل المختبر لاحتوائه على طلبات سابقة." : "تم حذف المختبر بنجاح." };
    }, "تعذّر حذف المختبر.");
    if (canonical) return canonical;
  }
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
