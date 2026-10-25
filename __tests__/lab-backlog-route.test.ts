import { beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { backlogSnapshot } from "./fixtures/lab-backlog";
const deps = vi.hoisted(() => ({ session: vi.fn(), read: vi.fn(), pool: vi.fn() }));
vi.mock("../lib/session", () => ({ requireSession: deps.session }));
vi.mock("../lib/db", () => ({ CLINIC_TIME_ZONE: "Asia/Aden", getPool: deps.pool }));
vi.mock("../lib/lab-backlog-db", () => ({ readLabBacklog: deps.read }));
import { GET } from "../app/api/lab/backlog/route";
import { apiRouteVerdict } from "../lib/http-permissions";
const actor = { userId: 7, username: "synthetic-admin", role: "admin" };
const get = (query = "") => GET(new Request(`http://localhost/api/lab/backlog?${query}`));
beforeEach(() => { vi.clearAllMocks(); deps.session.mockResolvedValue(actor); deps.pool.mockReturnValue({}); deps.read.mockResolvedValue(backlogSnapshot()); });
it.each([null, "doctor", "reception", "cashier", "accountant", "assistant", "manager"])("rejects %s before any database access", async role => {
  deps.session.mockResolvedValue(role ? { ...actor, role } : null);
  expect((await get()).status).toBe(role ? 403 : 401); expect(deps.pool).not.toHaveBeenCalled(); expect(deps.read).not.toHaveBeenCalled();
});
it("registers admin read-only at the exact route", () => {
  expect(apiRouteVerdict("/api/lab/backlog", "GET")).toMatchObject({ access: ["admin"], pattern: "/api/lab/backlog" });
  expect(apiRouteVerdict("/api/lab/backlog", "POST")).not.toMatchObject({ access: ["admin"] });
});
it("returns a private no-store snapshot and checks the current principal again", async () => {
  const result = await get(); expect(result.status).toBe(200); expect(result.headers.get("Cache-Control")).toBe("private, no-store");
  expect(deps.read).toHaveBeenCalledWith({}, { filter: "all", page: 0 }, "Asia/Aden", actor); expect(deps.session).toHaveBeenCalledTimes(2);
});
it.each([null, { ...actor, userId: 8 }, { ...actor, role: "doctor" }, { ...actor, username: "changed" }])("withholds the result after principal change", async current => {
  deps.session.mockResolvedValueOnce(actor).mockResolvedValueOnce(current); const result = await get();
  expect(result.status).toBe(401); expect(await result.json()).not.toHaveProperty("items");
});
it("fails unknown on source failure and does not disclose database details", async () => {
  deps.read.mockRejectedValue(new Error("private db error")); const result = await get();
  expect(result.status).toBe(503); expect(await result.text()).not.toContain("private db error");
});
it("rejects unsupported query parameters before reading", async () => {
  expect((await get("day=2026-01-01")).status).toBe(400); expect(deps.read).not.toHaveBeenCalled();
});
it("never queries money, writes, inferred appointment links, or schema bootstrap", () => {
  const source = readFileSync("lib/lab-backlog-db.ts", "utf8");
  expect(source).not.toMatch(/\b(?:invoices|invoice_items|payments|expenses|payables|commission|INSERT|UPDATE|DELETE|ALTER|appointments|ensureSchema)\b/);
  expect(source).toContain("NOT ht.is_private OR ht.owner_user_id = $6::int");
  expect(source.indexOf("counts AS")).toBeLessThan(source.indexOf("LIMIT $5"));
  expect(readFileSync("app/executive/page.tsx", "utf8")).toContain("<LabBacklogOverview />");
});
