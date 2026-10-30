import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PayrollPrintPage from "../app/print/hr/payroll/[id]/page";

const boundary = vi.hoisted(() => ({ session: vi.fn(), run: vi.fn(), items: vi.fn(), settings: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSession: boundary.session }));
vi.mock("@/lib/hr", () => ({ canManageStaff: (role: string) => role === "admin" }));
vi.mock("@/lib/hr-payroll", () => ({ getPayrollRunById: boundary.run, listPayrollItems: boundary.items }));
vi.mock("@/lib/db", () => ({ getSettingsSafe: boundary.settings }));
vi.mock("@/components/PrintButton", () => ({ PrintButton: () => null }));
vi.mock("@/components/PrintHeader", () => ({ PrintHeader: () => null, PrintFooter: () => null }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_HTTP_ERROR_FALLBACK;404"); } }));
const page = (id: string) => PayrollPrintPage({ params: Promise.resolve({ id }) });
beforeEach(() => {
  vi.resetAllMocks();
  boundary.session.mockResolvedValue({ role: "admin" });
  boundary.run.mockResolvedValue({ id: 7, status: "approved", currency: "SAR", periodName: "Synthetic period", approvedAt: "2031-01-01", totalBaseSalaryMinor: 150055, totalAllowancesMinor: 0, totalCommissionsMinor: 0, totalDeductionsMinor: 0, totalNetDueMinor: 150055, totalPaidMinor: 0 });
  boundary.items.mockResolvedValue([]);
  boundary.settings.mockResolvedValue({});
});
describe("payroll print route rejects malformed ids before database reads", () => {
  it.each(["0", "-1", "invalid", "", "1.5", "Infinity", "9007199254740992"])("renders not-found for %j", async id => {
    await expect(page(id)).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(boundary.session).toHaveBeenCalledOnce();
    expect(boundary.run).not.toHaveBeenCalled();
    expect(boundary.items).not.toHaveBeenCalled();
    expect(boundary.settings).not.toHaveBeenCalled();
  });
  it.each([null, { role: "doctor" }])("retains authorization before identifier handling for %j", async session => {
    boundary.session.mockResolvedValue(session);
    expect(renderToStaticMarkup(await page("0"))).toContain("كشف مسير الرواتب للمدير وحده.");
    expect(boundary.run).not.toHaveBeenCalled();
  });
  it("retains valid run reads, currency and approved document", async () => {
    const html = renderToStaticMarkup(await page("7"));
    expect(boundary.run).toHaveBeenCalledWith("7");
    expect(boundary.items).toHaveBeenCalledWith("7");
    expect(html).toContain("SAR");
    expect(html).toContain("Synthetic period");
    expect(html).toContain("1,500.55");
  });
  it("retains missing valid-id not-found without reading items", async () => {
    boundary.run.mockResolvedValue(null);
    await expect(page("7")).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(boundary.items).not.toHaveBeenCalled();
  });
  it("does not mask genuine reader failures with a broad catch", async () => {
    boundary.run.mockRejectedValue(new Error("Synthetic reader failure"));
    await expect(page("7")).rejects.toThrow("Synthetic reader failure");
  });
});
