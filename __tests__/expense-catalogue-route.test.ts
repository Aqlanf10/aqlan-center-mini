import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDoctorPermissions } from "@/lib/doctor-permissions";
import { financeAccessFor } from "@/lib/finance-permissions";
import { expenseCategoriesFixture as input } from "@/__tests__/fixtures/expense-categories";
import { SESSION_COOKIE } from "@/lib/sessionCookie";
import type { Role } from "@/lib/roles";

vi.mock("@/lib/session", () => ({ requireSession: vi.fn() }));
vi.mock("@/lib/db", () => ({ listExpenseCategories: vi.fn(), findUserByUsername: vi.fn() }));
import { GET } from "../app/api/finance/expense-categories/route";
import { proxy } from "@/proxy";
import { requireSession } from "@/lib/session";
import { listExpenseCategories, findUserByUsername } from "@/lib/db";

const session = vi.mocked(requireSession);
const query = vi.mocked(listExpenseCategories);
const findUser = vi.mocked(findUserByUsername);
const secret = "synthetic-catalogue-projection-test-not-a-live-credential";
function request(role?: Role, raw: unknown = {}, rawFinance?: unknown) {
  const financeAccess = role === "accountant" || role === "cashier" ? financeAccessFor(role, rawFinance) : undefined;
  const payload = { username: "synthetic", userId: 9001, role: role!, financeAccess, expiresAt: Date.now() + 60_000 };
  session.mockResolvedValue(role ? payload : null);
  findUser.mockResolvedValue({ permissions: parseDoctorPermissions(raw, role) } as NonNullable<Awaited<ReturnType<typeof findUserByUsername>>>);
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const token = `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
  return new NextRequest("https://synthetic.invalid/api/finance/expense-categories?month=2026-07&includeInactive=true&visibility=full", {
    headers: role ? { cookie: `${SESSION_COOKIE}=${token}` } : {},
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("SESSION_SECRET", secret);
  query.mockResolvedValue({ categories: input.categories, summary: input.summary });
});
afterEach(() => vi.unstubAllEnvs());
function catalogueOnly(body: Record<string, unknown>) {
  expect(body.visibility).toBe("catalogue");
  expect(body).not.toHaveProperty("summary");
  expect(body).not.toHaveProperty("standardExpenseAccounts");
  expect((body.categories as object[])[0]).toEqual({ id: 901, key: "lab", name: "Synthetic lab category",
    categoryGroup: "Synthetic group", accountCode: "5101", accountName: "Synthetic account", isActive: true });
}

describe("expense catalogue GET authorization and serialization", () => {
  it("rejects an expired session before catalogue/database reads", async () => {
    const req = request();
    expect((await proxy(req)).status).toBe(401);
    expect((await GET(req)).status).toBe(401);
    expect(query).not.toHaveBeenCalled(); expect(findUser).not.toHaveBeenCalled();
  });

  it("keeps the assistant proxy boundary and fails closed if called directly", async () => {
    const req = request("assistant");
    expect((await proxy(req)).status).toBe(403);
    expect((await GET(req)).status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it.each([{}, { canViewClinicRevenue: true }, { canViewClinicFinance: true }, { canViewCostPrices: true },
    { canViewClinicProfits: true }, { canViewAdminReports: true }])("returns only the useful catalogue for expense-hidden doctor %j", async (raw) => {
    const req = request("doctor", raw);
    expect((await proxy(req)).headers.get("x-middleware-next")).toBe("1");
    const response = await GET(req); expect(response.status).toBe(200);
    catalogueOnly(await response.json());
    expect(findUser).toHaveBeenCalledWith("synthetic");
    expect(query).toHaveBeenCalledWith({ month: "2026-07", includeInactive: true });
  });

  it("preserves full expense access without requiring clinic revenue and honors fresh revocation", async () => {
    const permitted = await (await GET(request("doctor", { canViewExpenses: true }))).json();
    expect(permitted.visibility).toBe("full");
    expect(permitted.categories).toEqual(input.categories); expect(permitted.summary).toEqual(input.summary);
    catalogueOnly(await (await GET(request("doctor", { canViewExpenses: false }))).json());
    expect(findUser).toHaveBeenCalledTimes(2);
  });

  it.each(["missing", "error"])("fails closed to the catalogue if doctor permission lookup is %s", async (failure) => {
    const req = request("doctor", { canViewExpenses: true });
    if (failure === "missing") findUser.mockResolvedValue(null);
    else findUser.mockRejectedValue(new Error("Synthetic lookup failure"));
    catalogueOnly(await (await GET(req)).json());
  });

  it("honors accountant report denial without blocking the operational catalogue", async () => {
    const req = request("accountant", {}, { viewReports: false });
    expect((await proxy(req)).headers.get("x-middleware-next")).toBe("1");
    catalogueOnly(await (await GET(req)).json());
    expect(findUser).not.toHaveBeenCalled();
  });

  it.each(["admin", "reception", "cashier", "accountant"] as const)("preserves the existing authorized %s read contract", async (role) => {
    const req = request(role, {}, { createExpenses: false });
    expect((await proxy(req)).headers.get("x-middleware-next")).toBe("1");
    const body = await (await GET(req)).json();
    expect(body.visibility).toBe("full");
    expect(body.categories).toEqual(input.categories); expect(body.summary).toEqual(input.summary);
    expect(body.standardExpenseAccounts.length).toBeGreaterThan(0);
    expect(findUser).not.toHaveBeenCalled();
  });

  it("does not serialize diagnostics on catalogue failure", async () => {
    const req = request("doctor"); query.mockRejectedValue(new Error("Synthetic private diagnostic"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await GET(req); expect(response.status).toBe(500);
      expect(await response.text()).not.toContain("Synthetic private diagnostic");
    } finally { log.mockRestore(); }
  });
});
