import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProtectedPurchaseHistoryError, RESET_CONFIRM_PHRASE } from "../lib/clinic-reset";

const state = vi.hoisted(() => ({
  session: { username: "synthetic-owner", role: "admin" } as { username: string; role: string } | null,
  passwordValid: true,
  reset: vi.fn(), backup: vi.fn(), remove: vi.fn(), preview: vi.fn(async () => ({ patients: 2 })),
}));
vi.mock("@/lib/session", () => ({ requireSession: async () => state.session }));
vi.mock("@/lib/db", () => ({
  clinicResetPreview: state.preview,
  findUserByUsername: async () => ({ passwordHash: "synthetic-hash" }),
  resetClinicData: (...args: unknown[]) => state.reset(...args),
}));
vi.mock("@/lib/auth", () => ({ verifyPassword: async () => state.passwordValid }));
vi.mock("@/lib/manual-backup", () => ({ runVerifiedManualBackup: state.backup }));
vi.mock("@/lib/files", () => ({ removeFileByKey: state.remove }));
const { GET, POST } = await import("../app/api/settings/reset/route");
const request = (body: unknown = { phrase: RESET_CONFIRM_PHRASE, password: "synthetic-password" }) => new Request("http://test.invalid/api/settings/reset", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
beforeEach(() => {
  vi.clearAllMocks(); state.session = { username: "synthetic-owner", role: "admin" }; state.passwordValid = true;
  state.reset.mockRejectedValue(new ProtectedPurchaseHistoryError());
});

describe("purchase history reset refusal preserves existing reset admission", () => {
  it("returns a typed 409 without calling backup or removing files", async () => {
    const response = await POST(request());
    if (!response) throw new Error("Reset POST did not return a response");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "protected-purchase-history" });
    expect(state.reset).toHaveBeenCalledTimes(1);
    expect(state.backup).not.toHaveBeenCalled(); expect(state.remove).not.toHaveBeenCalled();
  });
  it("keeps the existing preview response and confirmation phrase unchanged", async () => {
    const response = await GET();
    if (!response) throw new Error("Reset GET did not return a response");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ phrase: RESET_CONFIRM_PHRASE, groups: expect.arrayContaining([{ label: "المرضى", count: 2 }]) });
    expect(state.reset).not.toHaveBeenCalled(); expect(state.backup).not.toHaveBeenCalled();
  });
  it.each(["unsigned", "non-admin", "phrase", "password"])("still rejects invalid %s admission before reset", async kind => {
    if (kind === "unsigned") state.session = null;
    if (kind === "non-admin") state.session = { username: "synthetic-reception", role: "reception" };
    if (kind === "password") state.passwordValid = false;
    const response = await POST(request(kind === "phrase" ? { phrase: "wrong", password: "synthetic-password" } : undefined));
    if (!response) throw new Error("Reset POST did not return a response");
    expect(response.status).toBe(kind === "unsigned" ? 401 : kind === "non-admin" ? 403 : 400);
    expect(state.reset).not.toHaveBeenCalled(); expect(state.backup).not.toHaveBeenCalled(); expect(state.remove).not.toHaveBeenCalled();
  });
});
