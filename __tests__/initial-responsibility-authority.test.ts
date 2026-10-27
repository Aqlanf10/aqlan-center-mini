import { beforeEach, expect, it, vi } from "vitest";
const deps = vi.hoisted(() => ({ current: vi.fn(), access: vi.fn(), query: vi.fn() }));
vi.mock("../lib/session", () => ({ revalidateSessionInTransaction: deps.current }));
vi.mock("../lib/patient-access", () => ({ canAccessPatient: deps.access }));
import { authorizeInitialResponsibility } from "../lib/initial-responsibility-authority";
const session = { userId: 1, username: "synthetic", role: "doctor", partyId: 7, expiresAt: Date.now() + 60000 };
const client = { query: deps.query } as unknown as Parameters<typeof authorizeInitialResponsibility>[0];
beforeEach(() => { vi.clearAllMocks(); deps.current.mockResolvedValue(session); deps.access.mockResolvedValue(true); deps.query.mockResolvedValue({ rows: [{ id: 7 }] }); });
it("does not trust an actor string or missing admitted session", async () => { expect(await authorizeInitialResponsibility(client, undefined, 19, 7)).toBeNull(); expect(deps.query).not.toHaveBeenCalled(); });
it("doctor may initialize own active responsibility only with prior patient access", async () => {
 expect(await authorizeInitialResponsibility(client, session, 19, 7)).toEqual(session);
 expect(deps.access).toHaveBeenCalledWith(session, 19, undefined, client, "nowait");
 expect(deps.query.mock.calls[0][0]).toContain("FOR SHARE NOWAIT");
});
it("doctor cannot grant a colleague access by creating a case", async () => { expect(await authorizeInitialResponsibility(client, session, 19, 9)).toBeNull(); expect(deps.access).not.toHaveBeenCalled(); });
it("doctor cannot bootstrap ownership through the proposed case", async () => { deps.access.mockResolvedValue(false); expect(await authorizeInitialResponsibility(client, session, 19, 7)).toBeNull(); expect(deps.query).not.toHaveBeenCalled(); });
it.each([null, { ...session, role: "reception" }, { ...session, partyId: 8 }])("requires current session authority %#", async current => { deps.current.mockResolvedValue(current); expect(await authorizeInitialResponsibility(client, session, 19, 7)).toBeNull(); });
it("inactive incoming clinician is rejected even for current admin", async () => { deps.current.mockResolvedValue({ ...session, role: "admin" }); deps.query.mockResolvedValue({ rows: [] }); expect(await authorizeInitialResponsibility(client, session, 19, 7)).toBeNull(); });
