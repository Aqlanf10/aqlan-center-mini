import { expect, it } from "vitest";
import { isCanonicalPlanTemplateCatalog, type CanonicalPlanTemplateCatalog } from "../lib/canonical-plan-template-projection";
import { DEFAULT_SPECIALTY_TEMPLATES } from "../lib/specialty-templates";
const valid = (): CanonicalPlanTemplateCatalog => ({ projection: "plan-template-catalog", source: "default", pricesVisible: false,
  templates: structuredClone(DEFAULT_SPECIALTY_TEMPLATES), services: [{ id: 1, name: "خدمة اصطناعية", category: null, sortOrder: 0 }] });
it("accepts the existing ready templates with a clinical-only service projection", () => expect(isCanonicalPlanTemplateCatalog(valid())).toBe(true));
it("prices cannot be present when the projection declares them hidden", () => {
  const body = valid(); body.services[0].price = { currency: "YER", minor: 123, configured: true, provisional: false };
  expect(isCanonicalPlanTemplateCatalog(body)).toBe(false); body.pricesVisible = true; expect(isCanonicalPlanTemplateCatalog(body)).toBe(true);
});
it.each([NaN, Infinity, 1.2, Number.MAX_SAFE_INTEGER + 1])("rejects unsafe visible minor amount %s", minor => {
  const body = valid(); body.pricesVisible = true; body.services[0].price = { currency: "YER", minor, configured: true, provisional: false }; expect(isCanonicalPlanTemplateCatalog(body)).toBe(false);
});
it("requires a price for every service when price visibility is asserted", () => { const body = valid(); body.pricesVisible = true; expect(isCanonicalPlanTemplateCatalog(body)).toBe(false); });
it("rejects rich legacy bodies and unknown source claims", () => {
  expect(isCanonicalPlanTemplateCatalog({ templates: [], services: [], showPrices: true })).toBe(false);
  expect(isCanonicalPlanTemplateCatalog({ ...valid(), source: "saved-historical-patient" })).toBe(false);
});
it("rejects duplicate catalogue identifiers and excessive service counts", () => {
  const body = valid(); body.services.push({ ...body.services[0] }); expect(isCanonicalPlanTemplateCatalog(body)).toBe(false);
  const other = valid(); other.services = Array.from({ length: 2001 }, (_, i) => ({ id: i + 1, name: "SYN", category: null, sortOrder: i })); expect(isCanonicalPlanTemplateCatalog(other)).toBe(false);
});
it("rejects malformed template clinical structure instead of rendering partial steps", () => {
  const body = valid(); body.templates[0].steps[0].sessions[0].minutes = 0; expect(isCanonicalPlanTemplateCatalog(body)).toBe(false);
  const bad = valid(); (bad.templates[0].steps[0] as unknown as { optional: string }).optional = "false"; expect(isCanonicalPlanTemplateCatalog(bad)).toBe(false);
});
it("preserves a zero unconfigured price without inferring a patient charge", () => {
  const body = valid(); body.pricesVisible = true; body.services[0].price = { currency: "YER", minor: 0, configured: false, provisional: false }; expect(isCanonicalPlanTemplateCatalog(body)).toBe(true);
});
