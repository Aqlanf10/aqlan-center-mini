import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectTreatmentFinancialReferences } from "../lib/treatment-financial-context";
import { historicalSnapshot } from "./treatment-financial-historical-fixture";

const state = vi.hoisted(() => ({ owner: null as unknown, data: null as unknown }));
vi.mock("react", async (importOriginal) => ({ ...await importOriginal<typeof import("react")>(),
  useMemo: (factory: () => unknown) => { state.owner = factory(); return state.owner; },
  useState: (initial: unknown) => [initial === 0 ? 0 : { owner: state.owner, data: state.data, error: null }, () => undefined],
}));
import TreatmentFinancialContext from "../components/TreatmentFinancialContext";

beforeEach(() => { state.data = projectTreatmentFinancialReferences(historicalSnapshot()); });
const render = (props: Partial<Parameters<typeof TreatmentFinancialContext>[0]> = {}) => renderToStaticMarkup(createElement(TreatmentFinancialContext,
  { patientId: 10, canView: true, authorityKey: "synthetic:revision-1", ...props }));

describe("historical totals are document-scoped in treatment financial UI", () => {
  it("renders one current document total for several cases and never formats missing line cash as zero", () => {
    const html = render();
    expect(html.match(/مستند تاريخي #30/g)).toHaveLength(1);
    expect(html.match(/إجمالي المتفق بعد الخصم:/g)).toHaveLength(1);
    expect(html.match(/المدفوع قبل النظام:/g)).toHaveLength(1);
    expect(html.match(/المتبقي بحسب النسخة:/g)).toHaveLength(1);
    expect(html).toContain("النسخة الحالية 2");
    expect(html).toContain("540,000");
    expect(html).toContain("90,000");
    expect(html).not.toContain("المتبقي عند التسجيل:");
    expect(html).toContain("المدفوع والمتبقي غير موزعين على هذا البند");
    expect(html).toContain("ليست رصيدًا مخصصًا لكل بند أو حالة");
    expect(html).toContain("حالة #5");
    expect(html).toContain("حالة #6");
  });
  it("keeps the same once-per-document totals after exact-case filtering without broadening the selected case", () => {
    const html = render({ planItemId: 2, clinicalCaseId: 5, orthoCaseId: 12 });
    expect(html.match(/إجمالي المتفق بعد الخصم:/g)).toHaveLength(1);
    expect(html).toContain("بند اتفاق تاريخي #20");
    expect(html).not.toContain("بند اتفاق تاريخي #21");
    expect(html).toContain("بنود المستند المثبتة لهذا المريض");
    const mismatch = render({ planItemId: 2, clinicalCaseId: 6 });
    expect(mismatch).not.toContain("إجمالي المتفق بعد الخصم:");
  });
  it("never renders money after the parent role gate is revoked", () => {
    expect(render({ canView: false })).toBe("");
  });
});
