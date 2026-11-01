import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
// Admission contract only: actual route, mocked storage. NOT a lock/auth race test.
vi.mock("@/lib/session", () => ({ requireSession: vi.fn() }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: vi.fn() }));
vi.mock("@/lib/schedule", () => ({ clinicDateString: () => "2026-11-01" }));
vi.mock("@/lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden", getOrthoCase: vi.fn(), findUserByUsername: vi.fn(),
  setOrthoPhase: vi.fn(), setRetainer: vi.fn(), recordAdjustment: vi.fn(),
  closeOrthoCase: vi.fn(), linkOrthoCasePlan: vi.fn(),
}));
import { PATCH } from "@/app/api/ortho/[id]/route";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";
import { getOrthoCase, linkOrthoCasePlan } from "@/lib/db";
const version = "a".repeat(64);
const actor = { userId: 7, username: "synthetic-link-admin", role: "admin" as const, credentialVersion: "synthetic-server-credential", expiresAt: 4_102_444_800_000 };
async function patch(body: unknown) {
 return PATCH(new Request("https://synthetic.invalid/api/ortho/41", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: "41" }) });
}
beforeEach(() => {
 vi.resetAllMocks();
 vi.mocked(requireSession).mockResolvedValue(actor);
 vi.mocked(canAccessPatient).mockResolvedValue(true);
 vi.mocked(getOrthoCase).mockResolvedValue({ id: 41, patientId: 101, status: "active", planId: null } as Awaited<ReturnType<typeof getOrthoCase>>);
 vi.mocked(linkOrthoCasePlan).mockResolvedValue({ ok: true, changed: true, funded: true });
});
describe("Stage plan-link admission: required observed version", () => {
 it.each([undefined, null, "", "old", "a".repeat(63), "A".repeat(64), 123])("rejects invalid or missing expectedVersion=%j before any write", async expectedVersion => {
  const response = await patch({ planId: 51, expectedVersion });
  expect(response.status).toBe(400);
  expect(linkOrthoCasePlan).not.toHaveBeenCalled();
 });
 it("also requires the observed version for unlink", async () => {
  expect((await patch({ planId: null })).status).toBe(400);
  expect(linkOrthoCasePlan).not.toHaveBeenCalled();
 });
 it.each(["51", true, 1.5])("does not coerce planId=%j into a different intent", async planId => {
  expect((await patch({ planId, expectedVersion: version })).status).toBe(400);
  expect(linkOrthoCasePlan).not.toHaveBeenCalled();
 });
 it("rejects actor/authority fields supplied by the client", async () => {
  expect((await patch({ planId: 51, expectedVersion: version, actor: "other-user" })).status).toBe(400);
  expect(linkOrthoCasePlan).not.toHaveBeenCalled();
 });
 it("control: no admitted session cannot write", async () => {
  vi.mocked(requireSession).mockResolvedValue(null);
  expect((await patch({ planId: 51, expectedVersion: version })).status).toBe(401);
  expect(linkOrthoCasePlan).not.toHaveBeenCalled();
 });
 it("control: denied patient scope cannot write", async () => {
  vi.mocked(canAccessPatient).mockResolvedValue(false);
  expect((await patch({ planId: 51, expectedVersion: version })).status).toBe(403);
  expect(linkOrthoCasePlan).not.toHaveBeenCalled();
 });
});
