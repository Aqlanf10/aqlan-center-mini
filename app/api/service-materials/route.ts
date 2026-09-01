import { NextResponse } from "next/server";
import { getPool, ensureSchema, listServices } from "@/lib/db";
import { canManageInventory } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

/**
 * ربط الخدمات بالمستهلكات (§٢٠) — تعريف «ماذا يستهلك كل إجراء».
 *
 * الربط يُعرَّف مرة، ثم يخصم النظام تلقائيًا عند توقيع كل زيارة. وهذه الشاشة
 * لمن يدير المخزون (المدير والاستقبال) — الطبيب يرى أثر الخصم في سجل المريض
 * لا يعدّل تعريفه.
 */

export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  const serviceIdRaw = Number(new URL(request.url).searchParams.get("serviceId"));
  const serviceId = Number.isInteger(serviceIdRaw) && serviceIdRaw > 0 ? serviceIdRaw : null;

  try {
    await ensureSchema();
    const { rows } = await getPool().query<{
      id: number; service_id: number; service_name: string; item_id: number;
      item_name: string; unit: string; qty_per_unit: string; note: string | null;
      created_by: string;
    }>(
      `SELECT m.id, m.service_id, s.name AS service_name, m.item_id,
              i.name AS item_name, i.unit, m.qty_per_unit, m.note, m.created_by
         FROM service_materials m
         JOIN services s ON s.id = m.service_id
         JOIN inventory_items i ON i.id = m.item_id
        ${serviceId ? "WHERE m.service_id = $1" : ""}
        ORDER BY s.name, i.name`,
      serviceId ? [serviceId] : [],
    );
    return NextResponse.json(rows.map((row) => ({
      id: row.id,
      serviceId: row.service_id,
      serviceName: row.service_name,
      itemId: row.item_id,
      itemName: row.item_name,
      unit: row.unit,
      qtyPerUnit: Number(row.qty_per_unit),
      note: row.note,
      createdBy: row.created_by,
    })));
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل ربط الخدمات بالمواد." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canManageInventory(session.role)) {
    return NextResponse.json({ message: "ربط الخدمات بالمواد لمن يدير المخزون." }, { status: 403 });
  }

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  const serviceId = Number(source.serviceId);
  const itemId = Number(source.itemId);
  const qty = Number(source.qtyPerUnit);
  const note = typeof source.note === "string" && source.note.trim()
    ? source.note.trim().slice(0, 200) : null;

  if (!Number.isInteger(serviceId) || serviceId <= 0) {
    return NextResponse.json({ message: "اختر الخدمة من الدليل." }, { status: 400 });
  }
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return NextResponse.json({ message: "اختر المادة من المخزون." }, { status: 400 });
  }
  if (!Number.isFinite(qty) || qty <= 0) {
    return NextResponse.json({ message: "الكمية لكل وحدة يجب أن تكون أكبر من صفر." }, { status: 400 });
  }

  try {
    await ensureSchema();
    // الخدمة والمادة يجب أن تكونا فاعلتين: ربطٌ بخدمة موقوفة يخصم مواد لأعمال لا تحدث.
    const services = await listServices();
    if (!services.some((service) => service.id === serviceId && service.isActive)) {
      return NextResponse.json({ message: "الخدمة غير موجودة أو موقوفة." }, { status: 400 });
    }
    const { rows: itemRows } = await getPool().query<{ id: number }>(
      `SELECT id FROM inventory_items WHERE id = $1 AND is_active`, [itemId],
    );
    if (!itemRows[0]) {
      return NextResponse.json({ message: "المادة غير موجودة أو موقوفة." }, { status: 400 });
    }

    const { rows } = await getPool().query<{ id: number }>(
      `INSERT INTO service_materials (service_id, item_id, qty_per_unit, note, created_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (service_id, item_id) DO UPDATE
         SET qty_per_unit = EXCLUDED.qty_per_unit, note = EXCLUDED.note
       RETURNING id`,
      [serviceId, itemId, qty, note, session.username],
    );
    return NextResponse.json({ id: rows[0].id }, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ الربط." }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canManageInventory(session.role)) {
    return NextResponse.json({ message: "ربط الخدمات بالمواد لمن يدير المخزون." }, { status: 403 });
  }

  const id = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم الربط غير صالح." }, { status: 400 });
  }

  try {
    await ensureSchema();
    const { rowCount } = await getPool().query(
      `DELETE FROM service_materials WHERE id = $1`, [id],
    );
    if (!rowCount) {
      return NextResponse.json({ message: "الربط غير موجود." }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ message: "تعذّر حذف الربط." }, { status: 500 });
  }
}
