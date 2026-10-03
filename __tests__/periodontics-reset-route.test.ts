// Reconstructed route proof: protected clinical schema must stop before backup/disk work.
import { beforeEach, describe, expect, it, vi } from "vitest";
const boundary = vi.hoisted(() => ({
  clinicResetPreview: vi.fn(), findUserByUsername: vi.fn(), resetClinicData: vi.fn(),
  verifyPassword: vi.fn(), removeFileByKey: vi.fn(), runVerifiedManualBackup: vi.fn(), requireSession: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ clinicResetPreview: boundary.clinicResetPreview, findUserByUsername: boundary.findUserByUsername, resetClinicData: boundary.resetClinicData }));
vi.mock("@/lib/auth", () => ({ verifyPassword: boundary.verifyPassword }));
vi.mock("@/lib/files", () => ({ removeFileByKey: boundary.removeFileByKey }));
vi.mock("@/lib/manual-backup", () => ({ runVerifiedManualBackup: boundary.runVerifiedManualBackup }));
vi.mock("@/lib/session", () => ({ requireSession: boundary.requireSession }));
import { GET, POST } from "../app/api/settings/reset/route";
import { RESET_CONFIRM_PHRASE, UnsupportedProtectedClinicalSchemaError } from "../lib/clinic-reset";
beforeEach(() => {
  vi.resetAllMocks();
  boundary.requireSession.mockResolvedValue({ username: "synthetic-admin", role: "admin" });
  boundary.findUserByUsername.mockResolvedValue({ passwordHash: "synthetic-hash" });
  boundary.verifyPassword.mockResolvedValue(true);
  boundary.clinicResetPreview.mockRejectedValue(new UnsupportedProtectedClinicalSchemaError());
  boundary.resetClinicData.mockRejectedValue(new UnsupportedProtectedClinicalSchemaError());
});
describe("protected periodontal reset route", () => {
  it("preview honestly refuses with409 instead of promising a successful reset", async () => {
    const response = await GET();
    expect(response).toBeDefined();
    if (!response) throw new Error("Expected protected reset refusal response");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "unsupported-protected-clinical-schema" });
    expect(boundary.runVerifiedManualBackup).not.toHaveBeenCalled();
    expect(boundary.removeFileByKey).not.toHaveBeenCalled();
  });
  it("execution maps protected refusal without backup or disk deletion", async () => {
    const response = await POST(new Request("http://localhost/api/settings/reset", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phrase: RESET_CONFIRM_PHRASE, password: "synthetic-only" }) }));
    expect(response).toBeDefined();
    if (!response) throw new Error("Expected protected reset refusal response");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "unsupported-protected-clinical-schema" });
    expect(boundary.resetClinicData).toHaveBeenCalledTimes(1);
    expect(boundary.runVerifiedManualBackup).not.toHaveBeenCalled();
    expect(boundary.removeFileByKey).not.toHaveBeenCalled();
  });
});
