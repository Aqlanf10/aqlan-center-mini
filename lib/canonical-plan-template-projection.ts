import { MAX_TEMPLATES, templateProblems, type SpecialtyTemplate } from "./specialty-templates";
export const PLAN_TEMPLATE_SERVICE_LIMIT = 2000;
export interface CanonicalTemplateService {
  id: number; name: string; category: string | null; sortOrder: number;
  price?: { currency: "YER"; minor: number; configured: boolean; provisional: boolean };
}
export interface CanonicalPlanTemplateCatalog {
  projection: "plan-template-catalog"; source: "saved" | "default" | "default-invalid-setting";
  pricesVisible: boolean; templates: SpecialtyTemplate[]; services: CanonicalTemplateService[];
}
export function isCanonicalPlanTemplateCatalog(value: unknown): value is CanonicalPlanTemplateCatalog {
  if (!value || typeof value !== "object") return false;
  const body = value as CanonicalPlanTemplateCatalog;
  if (body.projection !== "plan-template-catalog" || !["saved", "default", "default-invalid-setting"].includes(body.source)
    || typeof body.pricesVisible !== "boolean" || !Array.isArray(body.templates) || !body.templates.length || body.templates.length > MAX_TEMPLATES
    || !Array.isArray(body.services) || body.services.length > PLAN_TEMPLATE_SERVICE_LIMIT) return false;
  try {
    const templateIds = new Set<string>(), services = new Set<number>();
    if (!body.templates.every(t => {
      if (!t || typeof t.id !== "string" || templateIds.has(t.id) || typeof t.name !== "string" || typeof t.description !== "string" || typeof t.specialty !== "string"
        || !Array.isArray(t.steps) || t.steps.length > 20 || templateProblems(t).length
        || t.steps.some(s => typeof s.key !== "string" || typeof s.title !== "string" || typeof s.category !== "string"
          || s.preferredService !== null && typeof s.preferredService !== "string"
          || typeof s.perTooth !== "boolean" || typeof s.optional !== "boolean" || typeof s.labWork !== "boolean"
          || !["on_start", "on_completion", "per_session"].includes(s.billingRule))) return false;
      templateIds.add(t.id); return true;
    })) return false;
    return body.services.every(s => {
      if (!s || !Number.isSafeInteger(s.id) || s.id < 1 || services.has(s.id) || typeof s.name !== "string" || s.category !== null && typeof s.category !== "string" || !Number.isSafeInteger(s.sortOrder)) return false;
      services.add(s.id);
      if (!body.pricesVisible) return !Object.hasOwn(s, "price");
      return !!s.price && s.price.currency === "YER" && Number.isSafeInteger(s.price.minor) && typeof s.price.configured === "boolean" && typeof s.price.provisional === "boolean";
    });
  } catch { return false; }
}
