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
const { projectOpeningReview, reviewText, sealShiftForViewer } = await import("../lib/shift-opening-reviews");
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
  it("an unauthorized viewer learns only which currency waits for review (blind count, §8.2)", () => {
    const review = { id: 7, shiftId: 3, currency: "YER" as const, previousShiftId: 2, previousCountedMinor: 1000, openingMinor: 950,
      differenceMinor: -50, state: "pending" as const, detectedBy: "SYN", detectedAt: "2026-11-15T00:00:00.000Z",
      reviewReason: null, reviewSettlement: null, reviewedBy: null, reviewedAt: null };
    expect(projectOpeningReview(review, false)).toEqual({ id: 7, shiftId: 3, currency: "YER", state: "pending" });
    expect(projectOpeningReview(review, true)).toBe(review);
  });
  it("seals only the latest close, and only for an unauthorized viewer (§8.3)", () => {
    const shift = { id: 9, counted: { YER: 990, SAR: 0, USD: 0 }, expected: { YER: 1000, SAR: 0, USD: 0 },
      difference: { YER: -10, SAR: 0, USD: 0 }, note: "SYN", differenceReason: "SYN", openedBy: "SYN" };
    expect(sealShiftForViewer(shift, 9, false)).toEqual({ id: 9, openedBy: "SYN", counted: null, expected: null, difference: null,
      note: null, differenceReason: null, sealed: true });
    expect(sealShiftForViewer(shift, 9, true)).toBe(shift);
    expect(sealShiftForViewer(shift, 8, false)).toBe(shift);
    expect(sealShiftForViewer(shift, null, false)).toBe(shift);
  });
});
