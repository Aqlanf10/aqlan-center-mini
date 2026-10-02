import { beforeEach, describe, expect, it, vi } from "vitest";
import { financeAccessFor } from "../lib/finance-permissions";
import { parseDoctorPermissions } from "../lib/doctor-permissions";
import { financeSummaryFixture as summary } from "./fixtures/finance-summary";

vi.mock("@/lib/session", () => ({ requireSession: vi.fn() }));
vi.mock("@/lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden", financeSummary: vi.fn(), findUserByUsername: vi.fn(),
}));
import { GET } from "../app/api/finance/report/route";
import { requireSession } from "../lib/session";
import { financeSummary, findUserByUsername } from "../lib/db";

const session = vi.mocked(requireSession);
const query = vi.mocked(financeSummary);
const findUser = vi.mocked(findUserByUsername);
const request = () => new Request("https://synthetic.invalid/api/finance/report?from=2026-09-30&to=2026-09-01");
function role(value: "admin" | "accountant" | "doctor" | "cashier" | "reception" | "assistant", raw: unknown = {}) {
  session.mockResolvedValue({ username: "synthetic", userId: 1, role: value, expiresAt: Date.now() + 60_000 });
  findUser.mockResolvedValue({ permissions: parseDoctorPermissions(raw, value) } as NonNullable<Awaited<ReturnType<typeof findUserByUsername>>>);
}
beforeEach(() => { vi.resetAllMocks(); query.mockResolvedValue(summary); });

describe("actual finance report GET handler", () => {
  it("returns 401 without a financial read when the session has expired", async () => {
    session.mockResolvedValue(null);
    expect((await GET(request())).status).toBe(401);
    expect(findUser).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it.each(["cashier", "reception", "assistant", "doctor"] as const)("returns 403 without financial reads for denied %s", async (value) => {
    role(value);
    expect((await GET(request())).status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it.each(["canViewClinicRevenue", "canViewClinicFinance"])("does not serialize expenses/opening/net for revenue-only %s", async (flag) => {
    role("doctor", { [flag]: true, canViewClinicProfits: true });
    const response = await GET(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.income).toEqual(summary.income);
    for (const key of ["expenses", "openingSettlements", "netMinor"]) expect(body).not.toHaveProperty(key);
    expect(query).toHaveBeenCalledWith("2026-09-01", "2026-09-30");
    expect(findUser).toHaveBeenCalledWith("synthetic");
  });

  it("does not serialize net without the profit flag", async () => {
    role("doctor", { canViewClinicRevenue: true, canViewExpenses: true });
    const body = await (await GET(request())).json();
    expect(body.expenses).toEqual(summary.expenses);
    expect(body.openingSettlements).toEqual(summary.openingSettlements);
    expect(body).not.toHaveProperty("netMinor");
  });

  it.each(["admin", "accountant", "doctor"] as const)("preserves the full authorized contract for %s", async (value) => {
    role(value, { canViewClinicRevenue: true, canViewExpenses: true, canViewClinicProfits: true });
    expect(await (await GET(request())).json()).toEqual(summary);
  });

  it("uses current doctor rights on each request and fails closed after revocation", async () => {
    role("doctor", { canViewClinicRevenue: true, canViewExpenses: true, canViewClinicProfits: true });
    expect(await (await GET(request())).json()).toEqual(summary);
    role("doctor", { canViewClinicRevenue: true });
    expect(await (await GET(request())).json()).not.toHaveProperty("expenses");
    role("doctor");
    expect((await GET(request())).status).toBe(403);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("honors the current accountant report restriction", async () => {
    role("accountant");
    session.mockResolvedValue({ ...(await session())!, financeAccess: financeAccessFor("accountant", { viewReports: false }) });
    expect((await GET(request())).status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it.each(["missing", "error"])("fails closed when doctor permissions are %s", async (failure) => {
    role("doctor", { canViewClinicRevenue: true });
    if (failure === "missing") findUser.mockResolvedValue(null);
    else findUser.mockRejectedValue(new Error("Synthetic lookup failure"));
    expect((await GET(request())).status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it("does not leak financial data or database diagnostics on query failure", async () => {
    role("admin");
    query.mockRejectedValue(new Error("Synthetic sensitive diagnostic"));
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("Synthetic sensitive diagnostic");
  });
});
