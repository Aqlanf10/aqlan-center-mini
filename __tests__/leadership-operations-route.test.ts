import { beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
const deps = vi.hoisted(() => ({ session: vi.fn(), read: vi.fn(), pool: {} }));
vi.mock("../lib/session", () => ({ requireSession: deps.session }));
vi.mock("../lib/db", () => ({ CLINIC_TIME_ZONE: "Asia/Aden", getPool: () => deps.pool }));
vi.mock("../lib/leadership-operations-db", () => ({ readOperationalOverview: deps.read }));
import { GET } from "../app/api/executive/operations/route";
import { canReadOperationalOverview, isOperationalDay, operationalPatientHref, parseOperationalQuery } from "../lib/leadership-operations";
import { apiRouteVerdict } from "../lib/http-permissions";
const get = (query = "") => GET(new Request(`http://localhost/api/executive/operations${query ? `?${query}` : ""}`));
beforeEach(() => {
  vi.clearAllMocks(); deps.session.mockResolvedValue({ userId: 7, username: "synthetic-admin", role: "admin" });
  deps.read.mockResolvedValue({ day: "2026-10-22", timeZone: "Asia/Aden", lane: "all", sections: [] });
});
it("requires a current session and denies before querying", async () => {
  deps.session.mockResolvedValue(null); expect((await get()).status).toBe(401); expect(deps.read).not.toHaveBeenCalled();
});
it.each(["reception", "doctor", "cashier", "accountant", "assistant", "manager", "unknown"])("does not expand existing access to %s", async role => {
  expect(canReadOperationalOverview(role)).toBe(false); deps.session.mockResolvedValue({ role });
  expect((await get()).status).toBe(403); expect(deps.read).not.toHaveBeenCalled();
});
it("registers only admin GET without changing legacy executive access", () => {
  expect(apiRouteVerdict("/api/executive/operations", "GET")).toEqual({ kind: "registered", pattern: "/api/executive/operations", access: ["admin"] });
  expect(apiRouteVerdict("/api/executive", "GET")).toMatchObject({ access: ["admin", "doctor"] });
});
it.each(["day=2026-02-30", "day=0000-01-01", "day=2026-13-01", "lane=admin", "appointmentPage=-1", "appointmentPage=1e2", "appointmentPage=9999999", "day=2026-10-22&day=2026-10-23", "patientId=7", "amount=0"])("rejects invalid scope %s", async query => {
  expect((await get(query)).status).toBe(400); expect(deps.read).not.toHaveBeenCalled();
});
it("passes validated day/lane/pages and returns a private non-cached snapshot", async () => {
  const response = await get("day=2026-10-21&lane=doctor&referralPage=2");
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(deps.read).toHaveBeenCalledWith(deps.pool, { day: "2026-10-21", lane: "doctor", appointmentPage: 0, referralPage: 2 }, "Asia/Aden");
  expect(deps.session).toHaveBeenCalledTimes(2);
});
it.each([null, { userId: 7, role: "doctor" }, { userId: 8, role: "admin" }])("does not publish a read after session revocation or account change", async current => {
  deps.session.mockResolvedValueOnce({ userId: 7, role: "admin" }).mockResolvedValueOnce(current);
  const response = await get(); expect(response.status).toBe(401); expect(await response.json()).not.toHaveProperty("sections");
});
it("uses the configured clinic day rather than server UTC, including DST zones", () => {
  const now = new Date("2026-10-22T21:30:00Z");
  expect(parseOperationalQuery(new URLSearchParams(), now, "Asia/Aden")?.day).toBe("2026-10-23");
  expect(parseOperationalQuery(new URLSearchParams(), now, "America/Los_Angeles")?.day).toBe("2026-10-22");
  expect(isOperationalDay("2028-02-29")).toBe(true); expect(isOperationalDay("2026-02-29")).toBe(false);
});
it("uses canonical patient tabs, not broad/unrelated visit links", () => {
  expect(operationalPatientHref({ patientId: 23 }, "appointments")).toBe("/patients/23?tab=summary");
  expect(operationalPatientHref({ patientId: 23 }, "referrals")).toBe("/patients/23?tab=treatment&sub=referrals");
});
it("keeps the operational projection independent of financial authorities and all writes", () => {
  const source = readFileSync("lib/leadership-operations-db.ts", "utf8");
  expect(source).not.toMatch(/\b(?:invoices|invoice_items|payments|expenses|payables|journal_manual|visit_procedures|commission|INSERT|UPDATE|DELETE|ALTER)\b/);
  expect(source).not.toContain("ensureSchema");
  expect(readFileSync("app/executive/page.tsx", "utf8")).toContain("<LeadershipOperationalOverview />");
});
