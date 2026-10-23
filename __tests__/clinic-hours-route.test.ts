// Real route validation; persistence/session are mocked boundaries, not PG proof.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withDefaults } from "../lib/settings";
const boundary = vi.hoisted(() => ({ requireSession: vi.fn(), getSettings: vi.fn(), readStoredSettings: vi.fn(), saveSettingsAudited: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSession: boundary.requireSession }));
vi.mock("@/lib/db", () => boundary);
import { PATCH, POST } from "../app/api/settings/route";
const values = { "clinic.day_start": "09:00", "clinic.day_end": "13:00", "clinic.shift2_start": "16:00", "clinic.shift2_end": "21:00" };
const versions = Object.fromEntries(Object.keys(values).map((key) => [key, null]));
const request = (body: unknown) => new Request("http://test.invalid/api/settings", { method: "PATCH", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
beforeEach(() => {
  vi.resetAllMocks(); boundary.requireSession.mockResolvedValue({ username: "test-admin", role: "admin" });
  boundary.getSettings.mockResolvedValue(withDefaults(values)); boundary.readStoredSettings.mockResolvedValue(new Map());
  boundary.saveSettingsAudited.mockResolvedValue({ ok: true, changed: Object.keys(values) });
});
describe("clinic hours API whole-batch contract", () => {
  it("refuses partial valid updates and resets before invoking the writer", async () => {
    expect((await PATCH(request({ "clinic.day_start": "10:00", __versions: versions }))).status).toBe(400);
    expect((await POST(request({ action: "reset", keys: ["clinic.shift2_start"], __versions: versions }))).status).toBe(400);
    expect(boundary.saveSettingsAudited).not.toHaveBeenCalled();
  });
  it.each([values, { ...values, "clinic.shift2_start": "", "clinic.shift2_end": "" }])("passes one authorized audited batch for %j", async (next) => {
    expect((await PATCH(request({ ...next, __versions: versions }))).status).toBe(200);
    expect(boundary.saveSettingsAudited).toHaveBeenCalledExactlyOnceWith({ values: next, expected: versions, reason: null, actor: "test-admin", actorRole: "admin" });
  });
  it("allows an explicit whole-tuple reset through the existing audited route", async () => {
    expect((await POST(request({ action: "reset", keys: Object.keys(values), __versions: versions }))).status).toBe(200);
    expect(boundary.saveSettingsAudited).toHaveBeenCalledExactlyOnceWith({
      values: { "clinic.day_start": "09:00", "clinic.day_end": "21:00", "clinic.shift2_start": "", "clinic.shift2_end": "" },
      expected: versions, mode: "reset", reason: null, actor: "test-admin", actorRole: "admin",
    });
  });
  it("rejects missing version on any of the four keys before writing", async () => {
    const { "clinic.shift2_end": _unused, ...partial } = versions;
    expect((await PATCH(request({ ...values, __versions: partial }))).status).toBe(409);
    expect(boundary.saveSettingsAudited).not.toHaveBeenCalled();
  });
  it("preserves writer conflict handling rather than retrying with newer versions", async () => {
    boundary.saveSettingsAudited.mockResolvedValue({ ok: false, conflict: { key: "clinic.shift2_end", currentUpdatedAt: "2026-10-21T12:00:00Z" } });
    expect((await PATCH(request({ ...values, __versions: versions }))).status).toBe(409);
    expect(boundary.saveSettingsAudited).toHaveBeenCalledTimes(1);
    expect(boundary.readStoredSettings).not.toHaveBeenCalled();
  });
  it("keeps role authorization in the existing API", async () => {
    boundary.requireSession.mockResolvedValue({ username: "test-doctor", role: "doctor" });
    expect((await PATCH(request({ ...values, __versions: versions }))).status).toBe(403);
    expect(boundary.saveSettingsAudited).not.toHaveBeenCalled();
  });
});
