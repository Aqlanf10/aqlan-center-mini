import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../app/api/patients/[id]/vitals/route";

const state = vi.hoisted(() => ({ allowed: true, fail: false, supplied: undefined as string | null | undefined }));
vi.mock("../lib/session", () => ({ requireSession: async () => ({ username: "synthetic", role: "doctor" }) }));
vi.mock("../lib/patient-access", () => ({ canAccessPatient: async () => state.allowed }));
vi.mock("../lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden", recordAudit: async () => {},
  recordVitals: async (_patientId: number, _readings: unknown, _actor: string, options: { medicalAlert?: string | null }) => {
    if (state.fail) throw new Error("synthetic write failure");
    state.supplied = options.medicalAlert;
    return { id: 42, patientId: 91, visitId: null, recordedAt: "2026-10-04T06:00:00Z" };
  },
}));
const save = (body: unknown) => POST(new Request("http://clinic.test/api/patients/91/vitals", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}), { params: Promise.resolve({ id: "91" }) });
beforeEach(() => { state.allowed = true; state.fail = false; state.supplied = undefined; });

describe("vitals success confirms the exact committed editable alert", () => {
  it.each(["  تنبيه مؤكد مع مسافات  ", "", null])("returns the unchanged committed source %j", async medicalAlert => {
    const response = await save({ pulse: 72, medicalAlert });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ id: 42, patientId: 91, medicalAlert });
    expect(state.supplied).toBe(medicalAlert);
  });
  it("does not invent a removal when the alert field was omitted", async () => {
    const response = await save({ pulse: 72 });
    expect(response.status).toBe(201); expect(await response.json()).not.toHaveProperty("medicalAlert");
    expect(state.supplied).toBeUndefined();
  });
  it.each(["denied", "failed", "invalid"])("never confirms a %s write", async kind => {
    state.allowed = kind !== "denied"; state.fail = kind === "failed";
    const response = await save({ pulse: 72, medicalAlert: kind === "invalid" ? {} : "تنبيه غير مؤكد" });
    expect(response.status).toBe(kind === "denied" ? 403 : kind === "failed" ? 500 : 400);
    expect(await response.json()).not.toHaveProperty("medicalAlert"); expect(state.supplied).toBeUndefined();
  });
});
