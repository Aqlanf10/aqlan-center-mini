import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ session: { username: "synthetic", role: "reception" } as { username: string; role: string } | null,
  authorize: vi.fn(), see: vi.fn(), owner: vi.fn(), reader: vi.fn(), handoff: vi.fn() }));
vi.mock("../lib/session", () => ({ requireSession: async () => state.session }));
vi.mock("../lib/operational-access", () => ({ authorizeVisit: state.authorize }));
vi.mock("../lib/walkout-access", () => ({ canSeeWalkout: state.see }));
vi.mock("../lib/db", () => ({ CLINIC_TIME_ZONE: "Asia/Aden", getVisitOwner: state.owner }));
vi.mock("../lib/checkout-db", () => ({ readVisitCheckout: state.reader }));
vi.mock("../lib/reception-handoff-db", () => ({ readReceptionHandoff: state.handoff }));
import { GET } from "../app/api/visits/[id]/walkout/route";
const walkout = { visitId: 10, patientId: 7, signedAt: "2026-10-20T09:00:00Z" };
const dueRecommendation = { patientId: 7, visitInvoiceId: 20, currencies: [{ currency: "SAR", currentBalanceMinor: 750, dueNowMinor: 150 }] };
const get = () => GET(new Request("http://localhost/api/visits/10/walkout"), { params: Promise.resolve({ id: "10" }) });
beforeEach(() => { vi.clearAllMocks(); state.session = { username: "synthetic", role: "reception" };
  state.authorize.mockResolvedValue({ ok: true, patientId: 7 }); state.see.mockResolvedValue(true); state.owner.mockResolvedValue({ found: true, patientId: 7 });
  state.reader.mockReset().mockResolvedValue({ walkout, summary: [], dueRecommendation, today: "2026-10-20" }); state.handoff.mockResolvedValue(null); });
describe("authorized checkout recommendation transport", () => {
  it("returns the composed snapshot unchanged with private no-store and server clinic date", async () => {
    const response = await get(); expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ ...walkout, summary: [], dueRecommendation, signedToday: true });
    expect(state.authorize).toHaveBeenCalledWith(state.session, 10); expect(state.see).toHaveBeenCalledWith(state.session, 7); expect(state.reader).toHaveBeenCalledWith(10);
  });
  it.each(["session", "visit", "finance"] as const)("never reads financial sources after a %s denial", async fault => {
    if (fault === "session") state.session = null;
    if (fault === "visit") state.authorize.mockResolvedValue({ ok: false, status: 404, message: "missing" });
    if (fault === "finance") state.see.mockResolvedValue(false);
    const response = await get(); expect(response.status).toBe(fault === "session" ? 401 : fault === "visit" ? 404 : 403);
    expect(state.reader).not.toHaveBeenCalled(); expect(await response.text()).not.toContain("dueRecommendation");
  });
  it("refuses a patient changed after authorization instead of leaking the new patient's money", async () => {
    state.reader.mockResolvedValue({ walkout: { ...walkout, patientId: 8 }, summary: [], dueRecommendation: { ...dueRecommendation, patientId: 8 }, today: "2026-10-20" });
    const response = await get(); expect(response.status).toBe(409); expect(await response.text()).not.toContain("dueRecommendation"); expect(state.handoff).not.toHaveBeenCalled();
  });
  it("does not replace an unavailable source read with an empty verified recommendation", async () => {
    state.reader.mockRejectedValue(new Error("private synthetic details")); const response = await get();
    expect(response.status).toBe(500); const body = await response.text(); expect(body).not.toContain("dueRecommendation"); expect(body).not.toContain("private synthetic details");
  });
});
