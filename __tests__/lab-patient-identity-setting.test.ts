import { beforeEach, describe, expect, it, vi } from "vitest";
import { labPatientIdentityMode, publicSubset, validateSetting, withDefaults } from "../lib/settings";
import { settingDefinition } from "../lib/settings-definitions";
import { validateTypedSetting } from "../lib/settings-validate";
import { optionLabel, settingControlKind } from "../lib/settings-ui";

const mocks = vi.hoisted(() => ({ session: vi.fn(), save: vi.fn(), read: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/db", () => ({ saveSettingsAudited: mocks.save, readStoredSettings: mocks.read, getSettings: mocks.get }));
import { PATCH, POST } from "../app/api/settings/route";

const key = "lab.patient_identity_mode";
const request = (body: unknown) => new Request("http://localhost/api/settings", {
  method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const change = () => ({ [key]: "name", __versions: { [key]: null }, __reason: "اعتماد اسم المريض للمعمل" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ username: "synthetic-admin", role: "admin" });
  mocks.get.mockResolvedValue(withDefaults({}));
  mocks.read.mockResolvedValue(new Map([[key, { value: "name", updatedAt: "v1" }]]));
  mocks.save.mockResolvedValue({ ok: true, changed: [key] });
});

describe("lab dispatch patient identity policy", () => {
  it("defaults to code and fails closed for absent, empty or corrupt settings", () => {
    expect(withDefaults({})[key]).toBe("code");
    for (const value of [undefined, "", "true", "NAME", " name ", "patient-name"]) {
      expect(labPatientIdentityMode({ [key]: value })).toBe("code");
    }
    expect(labPatientIdentityMode({ [key]: "name" })).toBe("name");
    expect(labPatientIdentityMode({ [key]: "code" })).toBe("code");
  });
  it("exposes only the display policy, not unknown patient data", () => {
    const subset = publicSubset(withDefaults({ [key]: "name", patientName: "Synthetic Patient" }));
    expect(subset[key]).toBe("name");
    expect(subset).not.toHaveProperty("patientName");
  });
  it("offers Arabic choices with explicit external visibility warning and reason", () => {
    const definition = settingDefinition(key)!;
    expect(settingControlKind(definition)).toBe("select");
    expect(definition.options).toEqual(["code", "name"]);
    expect(definition.requiresReason).toBe(true);
    expect(definition.help).toContain("المشاركة الخارجية");
    expect(optionLabel("name")).toContain("ظاهر للمعمل");
    expect(optionLabel("code")).toContain("خصوصية");
  });
  it.each(["code", "name"])("allows %s through both validators", (value) => {
    expect(validateSetting(key, value)).toBeNull();
    expect(validateTypedSetting(key, value)).toBeNull();
  });
  it.each(["", "true", "full", "NAME", "patient.phone"])("rejects invalid mode %s", (value) => {
    expect(validateSetting(key, value)).not.toBeNull();
    expect(validateTypedSetting(key, value)).not.toBeNull();
  });
});

describe("existing settings route governs lab identity", () => {
  it("rejects unauthenticated writes", async () => {
    mocks.session.mockResolvedValue(null);
    expect((await PATCH(request(change()))).status).toBe(401);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it.each(["reception", "doctor", "cashier", "accountant", "assistant"])("denies %s", async (role) => {
    mocks.session.mockResolvedValue({ username: "synthetic-staff", role });
    expect((await PATCH(request(change()))).status).toBe(403);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("requires a reason and a version before saving", async () => {
    expect((await PATCH(request({ [key]: "name", __versions: { [key]: null } }))).status).toBe(400);
    expect((await PATCH(request({ [key]: "name", __reason: "test" }))).status).toBe(409);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("rejects invalid mode without invoking persistence", async () => {
    expect((await PATCH(request({ ...change(), [key]: "full" }))).status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("passes actor, reason and version to the audited writer and returns new version", async () => {
    const response = await PATCH(request(change()));
    expect(response.status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith({ values: { [key]: "name" }, expected: { [key]: null },
      reason: change().__reason, actor: "synthetic-admin", actorRole: "admin" });
    expect(await response.json()).toMatchObject({ [key]: "name", __versions: { [key]: "v1" } });
  });
  it("returns a stale-write conflict from the versioned writer", async () => {
    mocks.save.mockResolvedValue({ ok: false, conflict: { key, currentUpdatedAt: "v2" } });
    const response = await PATCH(request(change()));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ key, currentUpdatedAt: "v2" });
  });
  it("resets to private code via the same reasoned, versioned audit path", async () => {
    const response = await POST(request({ action: "reset", keys: [key], __versions: { [key]: "v1" }, reason: "استعادة الخصوصية" }));
    expect(response.status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ values: { [key]: "code" }, expected: { [key]: "v1" }, mode: "reset", reason: "استعادة الخصوصية" }));
  });
});
