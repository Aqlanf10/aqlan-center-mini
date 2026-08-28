import { NextResponse } from "next/server";
import { createInvoice, getSettings, listParties, listPatientInvoices, listServices, recordAudit } from "@/lib/db";
import { isCurrency, parseAmount } from "@/lib/money";
import { canHandleMoney } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canHandleMoney(session.role)) {
    return NextResponse.json({ message: "الصندوق والفواتير للإدارة والاستقبال." }, { status: 403 });
  }
  const patientId = Number(new URL(request.url).searchParams.get("patientId"));
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400 });
  }
  try {
    return NextResponse.json(await listPatientInvoices(patientId));
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل الفواتير." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canHandleMoney(session.role)) {
    return NextResponse.json({ message: "الصندوق والفواتير للإدارة والاستقبال." }, { status: 403 });
  }

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  const patientId = Number(source.patientId);
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return NextResponse.json({ message: "اختر المريض أولًا." }, { status: 400 });
  }

  const settings = await getSettings();
  const base = settings["finance.base_currency"];
  if (!isCurrency(base)) {
    return NextResponse.json({ message: "العملة الأساسية في الإعدادات غير صالحة." }, { status: 500 });
  }

  const rawItems = Array.isArray(source.items) ? source.items : [];
  if (rawItems.length === 0 || rawItems.length > 40) {
    return NextResponse.json({ message: "أضف بندًا واحدًا على الأقل." }, { status: 400 });
  }

  // الأسعار تُقرأ من قائمة الأسعار حين يُختار منها بند، ومن الطلب حين يُكتب مبلغ
  // يدويًا. والوصف يُؤخذ من الخدمة نفسها لا من الواجهة، فلا تُطبع فاتورة باسم خدمة
  // وسعرِ أخرى.
  const services = new Map((await listServices(true)).map((service) => [service.id, service]));

  // الأطباء المسجّلون: بندٌ يشير إلى جهةٍ ليست طبيبًا يُرفض، وإلا نُسبت عمولة إلى
  // مختبر أو مورّد.
  const doctors = new Set((await listParties("doctor")).map((party) => party.id));

  const items: {
    serviceId: number | null; doctorId: number | null;
    description: string; quantity: number; unitPriceMinor: number;
  }[] = [];
  for (const raw of rawItems as Record<string, unknown>[]) {
    const quantity = Math.max(1, Math.round(Number(raw.quantity ?? 1)));
    if (!Number.isFinite(quantity) || quantity > 999) {
      return NextResponse.json({ message: "الكمية غير منطقية." }, { status: 400 });
    }

    const serviceId = Number(raw.serviceId);
    const service = Number.isInteger(serviceId) ? services.get(serviceId) : undefined;

    const description = service
      ? service.name
      : typeof raw.description === "string" ? raw.description.trim().slice(0, 160) : "";
    if (!description) {
      return NextResponse.json({ message: "اكتب وصف البند." }, { status: 400 });
    }

    const priceRaw = raw.price;
    let unitPriceMinor: number | null;
    if (priceRaw === undefined || String(priceRaw).trim() === "") {
      unitPriceMinor = service ? service.priceMinor : null;
    } else {
      unitPriceMinor = parseAmount(String(priceRaw), base);
    }
    if (unitPriceMinor === null) {
      return NextResponse.json({ message: `اكتب سعرًا صحيحًا لبند «${description}».` }, { status: 400 });
    }

    const doctorIdRaw = Number(raw.doctorId);
    const doctorId = Number.isInteger(doctorIdRaw) && doctors.has(doctorIdRaw) ? doctorIdRaw : null;
    if (raw.doctorId !== undefined && String(raw.doctorId).trim() !== "" && doctorId === null) {
      return NextResponse.json({ message: "الطبيب المختار غير مسجّل." }, { status: 400 });
    }

    items.push({ serviceId: service ? service.id : null, doctorId, description, quantity, unitPriceMinor });
  }

  const discountMinor = source.discount === undefined || String(source.discount).trim() === ""
    ? 0 : parseAmount(String(source.discount), base);
  if (discountMinor === null) {
    return NextResponse.json({ message: "اكتب خصمًا صحيحًا." }, { status: 400 });
  }

  const note = typeof source.note === "string" && source.note.trim()
    ? source.note.trim().slice(0, 300) : null;

  try {
    const invoice = await createInvoice({
      patientId, baseCurrency: base, discountMinor, note,
      createdBy: session.username, items,
    });
    if (!invoice) return NextResponse.json({ message: "تعذّر إنشاء الفاتورة." }, { status: 500 });
    await recordAudit({
      action: "invoice.create",
      entity: "invoice", entityId: invoice.id, entityLabel: invoice.invoiceNumber,
      details: {
        المريض: patientId, الإجمالي: invoice.totalMinor, الخصم: invoice.discountMinor,
        عدد_البنود: invoice.items.length,
      },
      actor: session.username, actorRole: session.role,
    });
    return NextResponse.json(invoice, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر إنشاء الفاتورة. تأكد من المريض." }, { status: 500 });
  }
}
