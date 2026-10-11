import { describe, expect, it } from "vitest";
import { HTTP_PERMISSIONS, apiRouteVerdict, rolesAlwaysDenied } from "../lib/http-permissions";
import { ROLES } from "../lib/roles";
import { INITIAL_PLAN_ITEM_DRAFT, planItemDraftChanged } from "../lib/plan-item-draft-navigation";

describe("clinical context registry and exact plan draft guard", () => {
  it("registers only clinical read roles and exposes no writer", () => {
    const path = "/api/patients/11/clinical-context";
    expect(HTTP_PERMISSIONS["/api/patients/[id]/clinical-context"]).toEqual({ GET: ["admin", "reception", "doctor"] });
    expect(apiRouteVerdict(path, "GET")).toMatchObject({ kind: "registered", access: ["admin", "reception", "doctor"] });
    expect(apiRouteVerdict(path, "POST").kind).toBe("method-not-allowed");
    expect(rolesAlwaysDenied(HTTP_PERMISSIONS["/api/patients/[id]/clinical-context"].GET!, ROLES)).toEqual(ROLES.filter((role) => !["admin", "reception", "doctor"].includes(role)));
  });
  it("service-only and billing-only changes remain dirty until returned to the captured baseline", () => {
    const baseline = { ...INITIAL_PLAN_ITEM_DRAFT, serviceId: 10 };
    expect(planItemDraftChanged(baseline, baseline)).toBe(false);
    expect(planItemDraftChanged({ ...baseline, serviceId: 11 }, baseline)).toBe(true);
    expect(planItemDraftChanged({ ...baseline, billingRule: "included" }, baseline)).toBe(true);
    expect(planItemDraftChanged({ ...baseline, serviceId: 10 }, baseline)).toBe(false);
    const saved = { ...baseline, serviceId: 11, billingRule: "included" };
    expect(planItemDraftChanged(saved, saved)).toBe(false);
    expect(planItemDraftChanged({ ...saved, serviceId: 10 }, saved)).toBe(true);
  });
});
