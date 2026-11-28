import { NextResponse } from "next/server";
import { ensureSchema, getPool, insertAuditRow, serviceMaterialRateStorageAvailable, type DbClient } from "@/lib/db";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { isAdmin } from "@/lib/roles";
import { SETTINGS_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { parseServiceMaterialRateChange } from "@/lib/service-material-rates";
import { requireSession } from "@/lib/session";
import { staffAdmissionRefusal } from "@/lib/staff-capability-editor";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { staffOperationCapabilities, staffOperationIdentity, withStaffOperation } from "@/lib/staff-operation-runtime";
import { withTransaction } from "@/lib/transactions";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
const json = (body: unknown, status = 200) => NextResponse.json(body, { headers, status });

type Actor = { username: string; role: string };
type Result = { body: unknown; status?: number };

async function authorized(work: (db: DbClient, actor: Actor) => Promise<Result>) {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return json({ message: "سجّل الدخول من جديد." }, 401);
  try {
    if (selected.kind === "canonical") {
      const action = "settings.view";
      const result = await withStaffOperation(getPool(), selected.handle, action, async (db, handle) => {
        const capabilities = await staffOperationCapabilities(db, handle, action, ["settings.finance.edit"]);
        if (!capabilities.has("settings.finance.edit")) return { body: { message: "لا تملك صلاحية إعدادات المالية." }, status: 403 };
        return work(db, await staffOperationIdentity(db, handle, action));
      });
      return json(result.body, result.status);
    }
    const session = await requireSession();
    if (!session) return json({ message: "سجّل الدخول من جديد." }, 401);
    if (!isAdmin(session.role)) return json({ message: "لا تملك صلاحية إعدادات المالية." }, 403);
    await ensureSchema();
    const result = await withTransaction(getPool(), db => work(db, session));
    return json(result.body, result.status);
  } catch (error) {
    const refusal = staffAdmissionRefusal(error);
    if (refusal) return json({ code: refusal.code, message: refusal.message }, refusal.status);
    return json({ message: "تعذّر التحقق من نسب إهلاك الخدمات." }, 500);
  }
}

export async function GET() {
  return authorized(async db => {
    if (!await serviceMaterialRateStorageAvailable(db)) return { body: { enabled: false, rates: [] } };
    const { rows } = await db.query<{
      serviceId: number; name: string; category: string | null; rateBp: number | null; revision: string | null;
    }>(`SELECT s.id AS "serviceId", s.name, s.category, h.rate_bp AS "rateBp", h.id::text AS revision
         FROM public.services s
         LEFT JOIN LATERAL (
           SELECT rate_bp, id FROM public.service_material_rate_history
            WHERE service_id=s.id ORDER BY effective_from DESC,id DESC LIMIT 1
         ) h ON true WHERE s.is_active ORDER BY s.name,s.id`);
    return { body: { enabled: true, rates: rows } };
  });
}

export async function POST(request: Request) {
  return authorized(async (db, actor) => {
    let body: unknown;
    try { body = await readJsonBody(request, SETTINGS_BODY_LIMIT_BYTES); }
    catch (error) {
      const bounded = bodyErrorResponse(error);
      return { body: { message: "طلب غير صالح أو أكبر من الحد." }, status: bounded?.status ?? 400 };
    }
    const change = parseServiceMaterialRateChange(body);
    if (!change) return { body: { message: "حدّد الخدمة والنسبة أو الوراثة، وسبب التغيير ونسخة الإعداد." }, status: 400 };
    if (!await serviceMaterialRateStorageAvailable(db)) return { body: { message: "إعداد النسبة لكل خدمة غير مفعّل." }, status: 409 };
    const { rows: [service] } = await db.query<{ name: string }>(
      "SELECT name FROM public.services WHERE id=$1 AND is_active FOR UPDATE", [change.serviceId],
    );
    if (!service) return { body: { message: "الخدمة غير موجودة أو مؤرشفة." }, status: 404 };
    const { rows: [previous] } = await db.query<{ revision: string; rate_bp: number | null }>(
      `SELECT id::text AS revision, rate_bp FROM public.service_material_rate_history
       WHERE service_id=$1 ORDER BY effective_from DESC,id DESC LIMIT 1`, [change.serviceId],
    );
    if ((previous?.revision ?? null) !== change.revision) return { body: { message: "غُيّرت النسبة من جهاز آخر. حدّث الصفحة ثم راجعها." }, status: 409 };
    if ((previous?.rate_bp ?? null) === change.rateBp) return { body: { ok: true, revision: previous?.revision ?? null } };
    const { rows: [saved] } = await db.query<{ revision: string }>(
      `INSERT INTO public.service_material_rate_history(service_id,rate_bp,recorded_by,change_reason)
       VALUES ($1,$2,$3,$4) RETURNING id::text AS revision`,
      [change.serviceId, change.rateBp, actor.username, change.reason],
    );
    await insertAuditRow(db, {
      action: change.rateBp === null ? "material_rate.clear" : "material_rate.set",
      entity: "service_material_rate_history", entityId: change.serviceId, entityLabel: service.name,
      actor: actor.username, actorRole: actor.role,
      details: { "النقاط قبل": previous?.rate_bp ?? null, "النقاط بعد": change.rateBp, "السبب": change.reason },
    });
    return { body: { ok: true, revision: saved.revision } };
  });
}
