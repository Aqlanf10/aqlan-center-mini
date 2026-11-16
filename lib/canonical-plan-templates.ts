import "server-only";
import { runCanonicalReadSnapshot, type CanonicalSnapshotQuery, type CanonicalSnapshotScope } from "./canonical-read-snapshot";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { effectiveTemplates, parseSpecialtyTemplates } from "./specialty-templates";
import { PLAN_TEMPLATE_SERVICE_LIMIT, isCanonicalPlanTemplateCatalog, type CanonicalPlanTemplateCatalog } from "./canonical-plan-template-projection";

const MAX_BYTES = 2 * 1024 * 1024;
export class CanonicalPlanTemplateRefusal extends Error {
  constructor(readonly code: "plan_template_limit" | "plan_template_invalid" | "plan_template_price_invalid") {
    super("تعذّر التحقق من قوالب الخطط ودليل الخدمات ضمن حدود القراءة الدقيقة."); this.name = "CanonicalPlanTemplateRefusal";
  }
}
export async function readPlanTemplatesWith(q: CanonicalSnapshotQuery, scope: CanonicalSnapshotScope): Promise<CanonicalPlanTemplateCatalog> {
  const pricesVisible = scope.granted("finance.service-prices.view");
  // Hidden prices are not selected, parsed, budgeted or serialized. A malformed
  // amount without price authority must not break the independent clinical read.
  const columns = `id,name,category,sort_order${pricesVisible ? ",price_minor::text,price_configured,price_provisional" : ""}`;
  const serviceSQL = `SELECT ${columns} FROM services WHERE is_active ORDER BY sort_order,name,id`;
  const budget = (await q.query<{ services: number; setting_bytes: number; service_bytes: string }>(`SELECT
    (SELECT count(*)::int FROM services WHERE is_active) AS services,
    COALESCE((SELECT octet_length(value) FROM settings WHERE key=$1),0) AS setting_bytes,
    COALESCE((SELECT sum(octet_length(row_to_json(s)::text)) FROM (${serviceSQL}) s),0)::text AS service_bytes`, ["plans.specialty_templates"])).rows[0];
  if (!budget || budget.services > PLAN_TEMPLATE_SERVICE_LIMIT || !Number.isSafeInteger(Number(budget.service_bytes))
    || budget.setting_bytes + Number(budget.service_bytes) > MAX_BYTES) throw new CanonicalPlanTemplateRefusal("plan_template_limit");
  const raw = (await q.query<{ value: string }>("SELECT value FROM settings WHERE key=$1", ["plans.specialty_templates"])).rows[0]?.value ?? "";
  // The existing clinical contract intentionally uses ready templates when the
  // saved setting is malformed. Preserve it, but disclose that source explicitly.
  const parsed = parseSpecialtyTemplates(raw), effective = effectiveTemplates(raw);
  const templates = effective.templates.map(t => ({ id: t.id, specialty: t.specialty, name: t.name, description: t.description,
    steps: t.steps.map(s => ({ key: s.key, title: s.title, category: s.category, preferredService: s.preferredService,
      perTooth: s.perTooth, optional: s.optional, billingRule: s.billingRule, labWork: s.labWork,
      sessions: s.sessions.map(session => ({ title: session.title, minutes: session.minutes, afterDays: session.afterDays })) })) }));
  const rows = (await q.query<{ id: number; name: string; category: string | null; sort_order: number;
    price_minor?: string; price_configured?: boolean | null; price_provisional?: boolean | null }>(serviceSQL)).rows;
  const result: CanonicalPlanTemplateCatalog = { projection: "plan-template-catalog", source: !raw.trim() ? "default" : parsed.ok ? "saved" : "default-invalid-setting", pricesVisible,
    templates, services: rows.map(row => {
      if (pricesVisible && (typeof row.price_minor !== "string" || !/^-?\d+$/.test(row.price_minor) || !Number.isSafeInteger(Number(row.price_minor)))) {
        throw new CanonicalPlanTemplateRefusal("plan_template_price_invalid");
      }
      return { id: Number(row.id), name: row.name, category: row.category, sortOrder: row.sort_order,
        ...(pricesVisible ? { price: { currency: "YER" as const, minor: Number(row.price_minor), configured: Boolean(row.price_configured), provisional: Boolean(row.price_provisional) } } : {}) };
    }) };
  if (!isCanonicalPlanTemplateCatalog(result)) throw new CanonicalPlanTemplateRefusal("plan_template_invalid");
  return result;
}
export function readCanonicalPlanTemplates(session: VerifiedDurableSession) {
  return runCanonicalReadSnapshot(session, "clinical.plans.view", readPlanTemplatesWith, { errorPrefix: "STAFF_READ", maxBytes: MAX_BYTES });
}
