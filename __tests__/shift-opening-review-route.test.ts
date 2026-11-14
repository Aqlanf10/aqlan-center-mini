import { beforeEach, describe, expect, it, vi } from "vitest";

// docs/finance/SHIFT_OPENING_REVIEWS_0129.md §2.2 and §4: the review route is canonical only, a canonical
// session never falls through to a legacy role, and every refusal carries its code and an Arabic message.
const state = vi.hoisted(() => ({
  selection: { kind: "none" } as { kind: string; handle?: unknown },
  legacySession: null as unknown,
  legacyCalls: 0,
  command: vi.fn(),
  read: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/staff-session-admission", () => ({ selectRequestStaffEnvelope: async () => state.selection }));
vi.mock("@/lib/session", () => ({ requireSession: async () => { state.legacyCalls++; return state.legacySession; } }));
vi.mock("@/lib/canonical-shift-opening-reviews", async () => {
  class CanonicalOpeningReviewRefusal extends Error {
    constructor(readonly code: string, readonly status: number, message: string) { super(message); }
  }
  return { CanonicalOpeningReviewRefusal, commandCanonicalOpeningReview: state.command, readCanonicalOpeningReviews: state.read };
});
vi.mock("@/lib/db", () => ({}));
const { GET, POST } = await import("../app/api/shifts/opening-reviews/route");
const { CanonicalOpeningReviewRefusal } = await import("@/lib/canonical-shift-opening-reviews");
const { openingDifferenceMessage, reviewText } = await import("../lib/shift-opening-reviews");
const post = (body: unknown) => POST(new Request("https://synthetic.invalid/api/shifts/opening-reviews", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
const get = (query = "") => GET(new Request(`https://synthetic.invalid/api/shifts/opening-reviews${query}`));

beforeEach(() => {
  state.legacyCalls = 0; state.legacySession = null; state.command.mockReset(); state.read.mockReset();
  state.selection = { kind: "canonical", handle: { synthetic: true } };
});

describe("the opening review route", () => {
  it("runs the canonical command with the body as sent and never the legacy session", async () => {
    state.command.mockResolvedValue({ id: 3, reviewedBy: "SYN-REVIEWER" });
    const response = await post({ id: 3, reason: "سبب", settlement: "تسوية", reviewedBy: "forged" });
    expect(response.status).toBe(200);
    expect(state.command).toHaveBeenCalledWith({ synthetic: true }, { id: 3, reason: "سبب", settlement: "تسوية", reviewedBy: "forged" });
    expect(state.legacyCalls).toBe(0);
    expect(response.headers.get("Cache-Control")).toMatch(/no-store/);
  });
  it("maps each refusal to its status, code and Arabic message", async () => {
    for (const [code, status] of [["opening_review_already_done", 409], ["opening_review_own_shift", 403], ["opening_review_not_found", 404], ["invalid_opening_review", 400]] as const) {
      state.command.mockRejectedValueOnce(new CanonicalOpeningReviewRefusal(code, status, "رسالة عربية"));
      const response = await post({ id: 1 });
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ code, message: "رسالة عربية" });
    }
  });
  it("refuses a non-object body without calling the command", async () => {
    const response = await post([1]);
    expect(response.status).toBe(400);
    expect(state.command).not.toHaveBeenCalled();
  });
  it("lists with the requested status", async () => {
    state.read.mockResolvedValue({ reviews: [], text: false, canReview: false });
    expect((await get("?status=all")).status).toBe(200);
    expect(state.read).toHaveBeenCalledWith({ synthetic: true }, { status: "all" });
  });
  it("a denied or missing session is 401; a live legacy session is 403 with the reason; nothing runs", async () => {
    state.selection = { kind: "denied" };
    expect((await post({ id: 1 })).status).toBe(401);
    state.selection = { kind: "none" };
    expect((await get()).status).toBe(401);
    state.selection = { kind: "legacy" };
    expect((await post({ id: 1 })).status).toBe(401);
    state.legacySession = { username: "SYN-LEGACY-ADMIN", role: "admin" };
    const refused = await post({ id: 1 });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "opening_review_requires_staff_runtime", message: expect.stringMatching(/معلّقًا وظاهرًا/) });
    expect(state.command).not.toHaveBeenCalled();
    expect(state.read).not.toHaveBeenCalled();
  });
});

describe("opening difference text", () => {
  it("validates review text: trimmed 3–300, blank is absent", () => {
    expect(reviewText(undefined)).toBeNull();
    expect(reviewText("   ")).toBeNull();
    expect(reviewText("ab")).toBe("invalid");
    expect(reviewText(5)).toBe("invalid");
    expect(reviewText("x".repeat(301))).toBe("invalid");
    expect(reviewText("  سبب واضح  ")).toBe("سبب واضح");
  });
  it("names each currency's signed difference without the previous count", () => {
    const message = openingDifferenceMessage([
      { currency: "YER", previousShiftId: 1, previousCountedMinor: 1000, openingMinor: 950, differenceMinor: -50 },
      { currency: "SAR", previousShiftId: 1, previousCountedMinor: null, openingMinor: 500, differenceMinor: null },
    ]);
    expect(message).toMatch(/نقص/);
    expect(message).toMatch(/SAR: عدّ الإقفال السابق غير معروف/);
    expect(message).toMatch(/لا تُنشأ أي حركة نقدية/);
    expect(message).not.toMatch(/1000|1,000/);
  });
});
