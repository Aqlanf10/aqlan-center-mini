import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), shift: vi.fn(), settings: vi.fn(), drawer: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden",
  getShift: mocks.shift, getSettingsSafe: mocks.settings,
  shiftDrawerBreakdown: mocks.drawer,
}));
vi.mock("@/components/PrintHeader", () => ({ PrintHeader: () => null, PrintFooter: () => null }));
vi.mock("@/components/PrintButton", () => ({ PrintButton: () => null }));
vi.mock("@/components/PrintDocument", () => ({ PrintMetadata: () => null, PrintTableFrame: ({ children }: { children: React.ReactNode }) => children }));
import ShiftCloseReportPage from "../app/print/shift/[id]/page";

const params = { params: Promise.resolve({ id: "17" }) };
const amounts = { YER: 0, SAR: 0, USD: 0 };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.settings.mockResolvedValue({});
  mocks.shift.mockResolvedValue({
    id: 17, status: "closed", openedAt: "2026-11-25T08:00:00Z",
    closedAt: "2026-11-25T09:00:00Z", opening: amounts, expected: amounts,
    counted: amounts, difference: amounts, expectedSource: "stored",
  });
  mocks.drawer.mockResolvedValue({
    cashIn: amounts, cashRefunds: amounts, spent: amounts,
    nonCashIn: amounts, nonCashRefunds: amounts,
  });
});

describe("P0-C: direct shift Z-report print boundary", () => {
  it.each(["reception", "doctor", "assistant", null])("denies %s before any financial read", async role => {
    mocks.session.mockResolvedValue(role === null ? null : { role, username: "synthetic-user" });
    await expect(ShiftCloseReportPage(params)).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(mocks.shift).not.toHaveBeenCalled();
    expect(mocks.settings).not.toHaveBeenCalled();
    expect(mocks.drawer).not.toHaveBeenCalled();
  });

  it.each(["admin", "cashier", "accountant"])("preserves existing %s print access", async role => {
    mocks.session.mockResolvedValue({ role, username: "synthetic-user" });
    const html = renderToStaticMarkup(await ShiftCloseReportPage(params));
    expect(html).toContain("المتوقَّع في الدرج");
    expect(mocks.settings).toHaveBeenCalledOnce();
    expect(mocks.shift).toHaveBeenCalledWith(17);
    expect(mocks.drawer).toHaveBeenCalledTimes(1);
  });
});
