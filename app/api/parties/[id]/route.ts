import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { getParty, recordAudit, updateParty } from "@/lib/db";
import { PARTY_AUDIT_FIELDS, auditChanges } from "@/lib/audit-diff";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "إدارة الجهات للمدير وحده." }, { status: 403 });
  }

  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم الجهة غير صالح." }, { status: 400 });
  }

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  const patch: {
    name?: string; phone?: string | null; commissionPercent?: number;
    note?: string | null; isActive?: boolean;
  } = {};

  if (typeof source.name === "string") {
    const name = source.name.trim();
    if (!name || name.length > 120) {
      return NextResponse.json({ message: "اكتب اسم الجهة." }, { status: 400 });
    }
    patch.name = name;
  }
  if (typeof source.phone === "string") patch.phone = source.phone.trim().slice(0, 40) || null;
  if (typeof source.note === "string") patch.note = source.note.trim().slice(0, 300) || null;
  if (typeof source.isActive === "boolean") patch.isActive = source.isActive;
  if (source.commissionPercent !== undefined) {
    const percent = Number(String(source.commissionPercent).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)));
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      return NextResponse.json({ message: "النسبة بين 0 و100." }, { status: 400 });
    }
    patch.commissionPercent = percent;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ message: "لا يوجد ما يُحدَّث." }, { status: 400 });
  }

  try {
    /* (P0-1) تغيير النسبة مستقبليٌّ ومدقَّق (قبل/بعد/السريان) داخل updateParty،
       والسبب إن أُرسل يُحمل معه. */
    const reason = typeof source.reason === "string" && source.reason.trim()
      ? source.reason.trim().slice(0, 300) : null;
    const before = await getParty(id);
    const updated = await updateParty(id, patch, {
      actor: session.username, actorRole: session.role, reason,
    });
    if (!updated) return NextResponse.json({ message: "الجهة غير موجودة." }, { status: 404 });
    // (P1-4) الاسم والهاتف والتفعيل والملاحظة كانت تتغيّر بلا أثر؛ النسبة لها سجلّها الزمني أيضًا.
    const changes = auditChanges(
      before as unknown as Record<string, unknown>,
      updated as unknown as Record<string, unknown>,
      PARTY_AUDIT_FIELDS,
    );
    if (Object.keys(changes).length > 0) {
      await recordAudit({
        action: "party.update",
        entity: "party", entityId: id, entityLabel: updated.name,
        details: { ...changes, ...(reason ? { السبب: reason } : {}) },
        actor: session.username, actorRole: session.role,
      });
    }
    return NextResponse.json(updated);
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ التعديل." }, { status: 500 });
  }
}
