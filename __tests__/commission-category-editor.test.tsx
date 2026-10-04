import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { CommissionCategoryEditor } from "../components/settings/CommissionCategoryEditor";
import { parseDoctorCommissionConfig } from "../lib/doctor-permissions";
import { resolveDoctorEffectivePolicy } from "../lib/commission";

type Element = ReactElement<Record<string, unknown>>;
function nodes(tree: ReactNode): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== "object" || !("props" in tree)) return [];
  const node = tree as Element;
  return [node, ...nodes(node.props.children as ReactNode)];
}
const keys = ["consultation", "xray", "cleaning", "filling", "rct", "post", "crown", "bridge", "veneer", "implant", "surgery", "extraction", "sealant", "whitening", "ortho"];

describe("actual commission category editor and unchanged raw-key billing contract", () => {
  const fixture = (defaultPercent = 17) => parseDoctorCommissionConfig({
    calculationMode: "by_category", defaultPercent,
    categoryRates: { endo: 72, custom_saved: 41, rct: 0 },
    customServiceRates: [{ id: "special", serviceId: 7, serviceName: "عصب خاص", percent: 83 }],
  });
  function view(config = fixture(), onCategoryChange = vi.fn(), onDefaultPercentChange = vi.fn()) {
    const tree = CommissionCategoryEditor({ config, services: [{ category: "catalog_only" }, { category: "custom_saved" }, { category: null }], onCategoryChange, onDefaultPercentChange });
    const input = (label: string) => {
      const element = nodes(tree).find((node) => node.type === "input" && node.props["aria-label"] === label);
      if (!element) throw new Error(`Missing actual input ${label}`);
      return element;
    };
    return { tree, input, onCategoryChange, onDefaultPercentChange };
  }
  it("renders every canonical key plus all saved and live raw custom keys without creating overrides", () => {
    const config = fixture(); const before = JSON.stringify(config); const v = view(config);
    for (const key of keys) expect(v.input(`نسبة فئة ${key}`)).toBeTruthy();
    expect(v.input("نسبة فئة endo").props.value).toBe(72);
    expect(v.input("نسبة فئة custom_saved").props.value).toBe(41);
    expect(v.input("نسبة فئة catalog_only").props.value).toBe(17);
    expect(v.input("نسبة فئة filling").props.value).toBe(17);
    expect(v.input("نسبة فئة rct").props.value).toBe(0);
    expect(v.onCategoryChange).not.toHaveBeenCalled(); expect(v.onDefaultPercentChange).not.toHaveBeenCalled();
    expect(JSON.stringify(config)).toBe(before);
    expect(config.categoryRates).not.toHaveProperty("filling");
  });
  it("keeps a zero inherited general rate distinct from an explicit zero override", () => {
    const v = view(fixture(0));
    expect(v.input("نسبة فئة filling").props.value).toBe(0);
    expect(v.input("نسبة فئة rct").props.value).toBe(0);
    const row = (key: string) => nodes(v.tree).find((node) => node.type === "label" && nodes(node.props.children as ReactNode).some((child) => child.props["aria-label"] === `نسبة فئة ${key}`));
    expect(JSON.stringify(row("filling")?.props.children)).toContain("موروثة من النسبة العامة");
    expect(JSON.stringify(row("rct")?.props.children)).toContain("نسبة محددة للفئة");
  });
  it("shows prototype-named raw catalog categories as inherited without inventing own overrides", () => {
    const config = fixture(); const onCategoryChange = vi.fn();
    const tree = CommissionCategoryEditor({ config, services: [{ category: "constructor" }, { category: "toString" }], onCategoryChange, onDefaultPercentChange: vi.fn() });
    for (const key of ["constructor", "toString"]) {
      const input = nodes(tree).find((node) => node.props["aria-label"] === `نسبة فئة ${key}`);
      expect(input?.props.value).toBe(17);
      expect(Object.hasOwn(config.categoryRates, key)).toBe(false);
    }
    expect(onCategoryChange).not.toHaveBeenCalled();
  });
  it("reports only the explicitly edited raw key, preserving a legacy key and special service priority", () => {
    const config = fixture(); const v = view(config);
    (v.input("نسبة فئة rct").props.onChange as (event: unknown) => void)({ target: { value: "55" } });
    expect(v.onCategoryChange).toHaveBeenCalledExactlyOnceWith("rct", 55);
    const saved = { ...config, categoryRates: { ...config.categoryRates, rct: 55 } };
    expect(resolveDoctorEffectivePolicy(saved, "2026-10-04", "rct").percent).toBe(55);
    expect(resolveDoctorEffectivePolicy(saved, "2026-10-04", "endo").percent).toBe(72);
    expect(resolveDoctorEffectivePolicy(saved, "2026-10-04", "rct", { serviceId: 7, serviceName: "عصب خاص" })).toMatchObject({ percent: 83, matchedRule: "custom_service" });
    expect(saved.customServiceRates).toEqual(config.customServiceRates);
    expect(saved.serviceRates).toEqual(config.serviceRates);
  });
  it("does not alias old endo into missing rct; changing the general rate keeps missing keys inherited", () => {
    const config = fixture(); delete config.categoryRates.rct;
    expect(resolveDoctorEffectivePolicy(config, "2026-10-04", "rct")).toMatchObject({ percent: 17, matchedRule: "default" });
    const v = view(config);
    (v.input("النسبة العامة للفئات").props.onChange as (event: unknown) => void)({ target: { value: "0" } });
    expect(v.onDefaultPercentChange).toHaveBeenCalledExactlyOnceWith(0);
    const updated = { ...config, defaultPercent: 0 };
    expect(view(updated).input("نسبة فئة rct").props.value).toBe(0);
    expect(updated.categoryRates).not.toHaveProperty("rct");
    expect(updated.categoryRates.endo).toBe(72);
  });
});
