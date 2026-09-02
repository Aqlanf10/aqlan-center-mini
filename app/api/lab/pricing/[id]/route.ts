import { NextResponse } from "next/server";
import {
  deleteLabPricingRule,
  getPool,
  recordAudit,
  updateLabPricingRule,
} from "@/lib/db";
import { isCurrency, parseAmount, type Currency } from "@/lib/money";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if (!session) return denied();
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "تعديل أسعار المختبرات للمدير وحده." }, { status: 403 });
  }

  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "معرّف قاعدة التسعير غير صالح." }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  const patch: Parameters<typeof updateLabPricingRule>[1] = {};

  if (source.costCurrency !== undefined && isCurrency(source.costCurrency)) {
    patch.costCurrency = source.costCurrency;
  }

  if (source.cost !== undefined || source.costMinor !== undefined) {
    const currency = patch.costCurrency || "YER";
    const costMinor = source.costMinor !== undefined
      ? Number(source.costMinor)
      : parseAmount(String(source.cost ?? ""), currency);

    if (costMinor === null || isNaN(costMinor) || costMinor < 0) {
      return NextResponse.json({ message: "مبلغ وسعر الخدمة غير صالح." }, { status: 400 });
    }
    patch.costMinor = costMinor;
  }

  if (typeof source.effectiveFrom === "string") {
    if (!DATE_REGEX.test(source.effectiveFrom.trim())) {
      return NextResponse.json({ message: "تاريخ بدء السريان غير صالح (الصيغة: YYYY-MM-DD)." }, { status: 400 });
    }
    patch.effectiveFrom = source.effectiveFrom.trim();
  }

  if (source.effectiveTo !== undefined) {
    if (source.effectiveTo === null || source.effectiveTo === "") {
      patch.effectiveTo = null;
    } else if (typeof source.effectiveTo === "string" && DATE_REGEX.test(source.effectiveTo.trim())) {
      patch.effectiveTo = source.effectiveTo.trim();
    } else {
      return NextResponse.json({ message: "تاريخ انتهاء السريان غير صالح." }, { status: 400 });
    }
  }

  if (source.note !== undefined) {
    patch.note = typeof source.note === "string" && source.note.trim()
      ? source.note.trim().slice(0, 300)
      : null;
  }

  try {
    const updated = await updateLabPricingRule(id, patch);
    if (!updated) {
      return NextResponse.json({ message: "قاعدة التسعير غير موجودة." }, { status: 404 });
    }

    await recordAudit({
      actor: session.username,
      actorRole: session.role,
      action: "lab_pricing.update",
      entity: "lab_pricing_rule",
      entityId: String(id),
      entityLabel: `${updated.partyName} — ${updated.serviceName}`,
      details: {
        id,
        costMinor: updated.costMinor,
        costCurrency: updated.costCurrency,
        effectiveFrom: updated.effectiveFrom,
        effectiveTo: updated.effectiveTo,
        note: updated.note,
      },
    });

    return NextResponse.json({ rule: updated });
  } catch (error) {
    console.error("Failed to update lab pricing rule:", error);
    return NextResponse.json({ message: "تعذّر تعديل قاعدة التسعير." }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if (!session) return denied();
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "حذف أسعار المختبرات للمدير وحده." }, { status: 403 });
  }

  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "معرّف قاعدة التسعير غير صالح." }, { status: 400 });
  }

  try {
    const { rows } = await getPool().query<{
      party_name: string;
      service_name: string;
      cost_minor: string;
      cost_currency: string;
    }>(
      `SELECT p.name AS party_name, ls.name AS service_name, r.cost_minor, r.cost_currency
         FROM lab_pricing_rules r
         JOIN parties p ON p.id = r.party_id
         JOIN lab_services ls ON ls.id = r.lab_service_id
        WHERE r.id = $1`,
      [id],
    );
    const existing = rows[0];

    const deleted = await deleteLabPricingRule(id);
    if (!deleted) {
      return NextResponse.json({ message: "قاعدة التسعير غير موجودة." }, { status: 404 });
    }

    if (existing) {
      await recordAudit({
        actor: session.username,
        actorRole: session.role,
        action: "lab_pricing.delete",
        entity: "lab_pricing_rule",
        entityId: String(id),
        entityLabel: `${existing.party_name} — ${existing.service_name} (${existing.cost_minor} ${existing.cost_currency})`,
        details: { id },
      });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Failed to delete lab pricing rule:", error);
    return NextResponse.json({ message: "تعذّر حذف قاعدة التسعير." }, { status: 500 });
  }
}
