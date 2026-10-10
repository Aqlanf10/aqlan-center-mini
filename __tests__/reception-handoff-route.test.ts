import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ session: { username: "reception", role: "reception" } as { username: string; role: string } | null,
  list: vi.fn(), today: vi.fn() }));
vi.mock("../lib/session", () => ({ requireSession: async () => state.session }));
vi.mock("../lib/reception-handoff-db", () => ({ listReceptionHandoffs: state.list }));
vi.mock("../lib/db", () => ({ listTodayVisits: state.today, ActiveVisitExists: class extends Error {}, addVisit: vi.fn(), recordAudit: vi.fn(), startVisitFromPlannedVisit: vi.fn() }));
const { GET } = await import("../app/api/visits/route");
const get = (search = "?view=reception-handoff") => GET(new Request(`http://localhost/api/visits${search}`));
beforeEach(() => {
  state.session = { username: "reception", role: "reception" };
  state.list.mockReset().mockResolvedValue({ fromDate: "2026-10-08", toDate: "2026-10-09", clinicTimeZone: "Asia/Aden", items: [] });
  state.today.mockReset().mockResolvedValue([{ id: 1 }]);
});
describe("reception projection on the existing visits route", () => {
  it("keeps shared visits unchanged and signed metadata separately authorized", async () => {
    expect(await (await get("")).json()).toEqual([{ id: 1 }]);
    expect(state.list).not.toHaveBeenCalled();
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect((await response.json()).owner).toEqual(state.session);
  });
  it.each(["doctor", "assistant", "cashier", "accountant"])("denies %s before reading any handoff", async role => {
    state.session = { username: role, role };
    expect((await get()).status).toBe(403);
    expect(state.list).not.toHaveBeenCalled();
  });
  it("fails closed for expired session and invalid/duplicate parameters", async () => {
    state.session = null;
    expect((await get()).status).toBe(401);
    state.session = { username: "admin", role: "admin" };
    for (const search of ["?view=nope", "?view=reception-handoff&view=reception-handoff", "?view=reception-handoff&date=2026-02-30", "?view=reception-handoff&date=2026-10-09&date=2026-10-10"]) {
      expect((await get(search)).status).toBe(400);
    }
    expect(state.list).not.toHaveBeenCalled();
  });
  it("reads an explicit older signing window and reports database failure rather than empty success", async () => {
    expect((await get("?view=reception-handoff&date=2026-09-01")).status).toBe(200);
    expect(state.list).toHaveBeenCalledWith("2026-09-01");
    state.list.mockRejectedValue(new Error("private database details"));
    const response = await get();
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private database details");
  });
});
