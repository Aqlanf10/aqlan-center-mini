import { beforeEach, expect, it, vi } from "vitest";
const deps = vi.hoisted(() => ({ session: vi.fn(), read: vi.fn(), pool: {} }));
vi.mock("../lib/session", () => ({ requireSession: deps.session }));
vi.mock("../lib/db", () => ({ CLINIC_TIME_ZONE: "Asia/Aden", getPool: () => deps.pool }));
vi.mock("../lib/leadership-pulse-db", () => ({ readLeadershipPulse: deps.read }));
import { GET } from "../app/api/executive/pulse/route";
const get = (query = "view=care&page=0") => GET(new Request(`http://localhost/api/executive/pulse?${query}`));
const admin = { userId: 4, username: "synthetic-admin", role: "admin" };
beforeEach(() => { vi.clearAllMocks(); deps.session.mockResolvedValue(admin); deps.read.mockResolvedValue({ view: "care", scope: "active_plan_work_now" }); });
it("routes current care through existing admin authorization with no-store and a post-read principal check", async () => {
  const response = await get();
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(deps.read).toHaveBeenCalledWith(deps.pool, { view: "care", day: expect.any(String), page: 0 }, "Asia/Aden", admin);
  expect(deps.session).toHaveBeenCalledTimes(2);
});
it.each([null, "doctor", "reception", "accountant", "manager"])("does not widen care visibility to %s", async role => {
  deps.session.mockResolvedValue(role ? { ...admin, role } : null);
  expect((await get()).status).toBe(role ? 403 : 401); expect(deps.read).not.toHaveBeenCalled();
});
it("rejects historical day filters before reading current all-date work", async () => {
  expect((await get("view=care&day=2020-01-01")).status).toBe(400); expect(deps.read).not.toHaveBeenCalled();
});
it("clears care data when a slow read finishes after account revocation", async () => {
  deps.session.mockResolvedValueOnce(admin).mockResolvedValueOnce(null);
  const response = await get(); expect(response.status).toBe(401); expect(await response.json()).not.toHaveProperty("scope");
});
