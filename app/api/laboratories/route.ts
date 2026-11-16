import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { createLaboratory, listLaboratories, recordAudit } from "@/lib/db";
import { isCurrency, type Currency } from "@/lib/money";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { toWhatsAppNumber } from "@/lib/reminders";

import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { NO_STORE, canonicalPatientReadFailure } from "@/lib/canonical-patient-http";
import { CanonicalLabDirectoryRefusal, commandCanonicalLaboratoryCreate, readCanonicalLaboratories } from "@/lib/canonical-lab-directory";
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

export async function GET() {
  const canonical = await canonicalDirectory(handle => readCanonicalLaboratories(handle), "تعذّر تحميل بيانات المختبرات.");
  if (canonical) return canonical;
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
  if ((await selectRequestStaffEnvelope()).kind === "canonical") {
    const body = await canonicalBody(request);
    if (body instanceof NextResponse) return body;
    return (await canonicalDirectory(handle => commandCanonicalLaboratoryCreate(handle, body), "تعذّر حفظ بيانات المختبر.", 201))!;
  }
  const session = await requireSession();
  if (!session) return denied();
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "إدارة المختبرات للمدير وحده." }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
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
