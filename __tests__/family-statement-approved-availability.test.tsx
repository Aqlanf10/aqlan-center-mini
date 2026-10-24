import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const mock = vi.hoisted(() => ({ plans: vi.fn() }));
vi.mock("@/lib/db", () => ({ CLINIC_TIME_ZONE: "Asia/Aden", listPatientPlans: mock.plans, getSettingsSafe: async () => ({}) }));
vi.mock("@/lib/session", () => ({ requireSession: async () => ({ role: "admin" }) }));
vi.mock("@/lib/family-view", () => ({ buildFamilyView: async () => ({ ok: true, view: { name: "Synthetic family", canSeeMoney: true, guarantor: { kind: "none" }, members: [{ id: 1, fullName: "Synthetic member", balances: [] }], totals: [] } }) }));
vi.mock("@/components/PrintHeader", () => ({ PrintHeader: () => null, PrintFooter: () => null }));
vi.mock("@/components/PrintButton", () => ({ PrintButton: () => null }));
import Page from "../app/print/family-statement/[id]/page";
it.each([false, true])("only prints verified current agreement remaining when available=%s", async available => {
  mock.plans.mockResolvedValue([{ id: 6, title: "SYNTHETIC-AMENDED", status: "active", totalFromItems: false, baseCurrency: "YER", totalMinor: 500000,
    progress: { totalMinor: 800000, paidMinor: 180000, remainingMinor: 620000 }, approvedAgreement: { available } }]);
  const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ id: "1" }) }));
  if (available) { expect(html).toContain("620,000");expect(html).toContain("SYNTHETIC-AMENDED"); }
  else { expect(html).not.toContain("620,000");expect(html).not.toContain("SYNTHETIC-AMENDED"); }
  expect(html).not.toContain("320,000");
});
it("keeps a valid member agreement alongside an explicit unavailable warning without fabricating a family agreement total", async () => {
  mock.plans.mockResolvedValue([
    { id: 6, title: "UNKNOWN-AGREEMENT", status: "active", totalFromItems: false, baseCurrency: "YER", totalMinor: 500000, progress: { remainingMinor: 620000 }, approvedAgreement: { available: false } },
    { id: 7, title: "VERIFIED-AGREEMENT", status: "active", totalFromItems: false, baseCurrency: "SAR", totalMinor: 30000, progress: { remainingMinor: 14000 }, approvedAgreement: { available: true } },
  ]);
  const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ id: "1" }) }));
  expect(html).toContain("غير متاحة وتحتاج مراجعة مصدرها");expect(html).toContain("لا يعني ذلك أنها مسددة");
  expect(html).toContain("VERIFIED-AGREEMENT");expect(html).not.toContain("UNKNOWN-AGREEMENT");
  expect(html).not.toContain("620,000");expect(html).toContain("140.00");
});
