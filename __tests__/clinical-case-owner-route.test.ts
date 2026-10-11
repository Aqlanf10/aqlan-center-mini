import { beforeEach, describe, expect, it, vi } from "vitest";

/** Route-wiring contract only. Real canonical merge/store races are separately
 * covered in postgres/clinical-case-identity.test.ts. The doctor is authorized
 * for owner11; the simulated merge transfers identity to unauthorized owner22
 * after guard success and before the storage call. */
const { state } = vi.hoisted(() => ({ state: { owner: 11, allowed: true } }));
vi.mock("../lib/db", () => ({
  getPlanItemPatient: vi.fn(async () => state.owner),
  getClinicalCase: vi.fn(async () => ({ id: 303, patientId: state.owner })),
  setPlanItemCase: vi.fn(async (input: { expectedPatientId?: number }) =>
    input.expectedPatientId !== undefined && input.expectedPatientId !== state.owner
      ? { ok: false, reason: "owner_changed" } : { ok: true }),
  changeClinicalCaseStatus: vi.fn(async (input: { expectedPatientId?: number }) =>
    input.expectedPatientId !== undefined && input.expectedPatientId !== state.owner
      ? { ok: false, reason: "owner_changed" } : { ok: true, case: { id: 303 } }),
}));
vi.mock("../lib/case-route", () => ({
  idOf: (value: string) => Number(value),
  readBody: async (request: Request) => ({ ok: true, body: await request.json() }),
  json: (message: string, status: number) => Response.json({ message }, { status }),
  guardPatient: vi.fn(async (patientId: number) => {
    if (!state.allowed || patientId !== 11) return { ok: false, response: Response.json({ message: "غير مسموح" }, { status: 403 }) };
    state.owner = 22;
    return { ok: true, session: { userId: 7, username: "SYNTHETIC source-only doctor", role: "doctor", expiresAt: 4_102_444_800_000 } };
  }),
}));
import { getPlanItemPatient, getClinicalCase, setPlanItemCase, changeClinicalCaseStatus } from "../lib/db";
import { guardPatient } from "../lib/case-route";
import { CLINICAL_CASE_LINKAGE_MESSAGE } from "../lib/clinical-case-linkage";
import { PUT } from "../app/api/plan-items/[id]/case/route";
import { PATCH } from "../app/api/cases/[id]/route";

beforeEach(() => { vi.clearAllMocks(); state.owner = 11; state.allowed = true; });
const params = { params: Promise.resolve({ id: "303" }) };
const request = (operation: "link" | "close") => new Request("https://synthetic.invalid/api/case", {
  method: operation === "link" ? "PUT" : "PATCH", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(operation === "link" ? { caseId: 404, priority: 9 } : { status: "completed", outcome: "SYNTHETIC" }),
});

describe("clinical routes bind the doctor-authorized patient to storage", () => {
  it.each(["link", "close"] as const)("%s forwards original guarded owner and maps post-guard transfer to reload409", async operation => {
    const response = operation === "link" ? await PUT(request(operation), params) : await PATCH(request(operation), params);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ message: CLINICAL_CASE_LINKAGE_MESSAGE.owner_changed });
    expect(guardPatient).toHaveBeenCalledTimes(1);
    expect(guardPatient).toHaveBeenCalledWith(...(operation === "link" ? [11, true, "edit"] : [11, true]));
    const write = operation === "link" ? setPlanItemCase : changeClinicalCaseStatus;
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ expectedPatientId: 11, actorRole: "doctor" }));
    expect(operation === "link" ? getPlanItemPatient : getClinicalCase).toHaveBeenCalledTimes(1);
    expect(state.owner).toBe(22);
  });
  it.each(["link", "close"] as const)("%s preserves the original doctor denial without calling a writer", async operation => {
    state.allowed = false;
    const response = operation === "link" ? await PUT(request(operation), params) : await PATCH(request(operation), params);
    expect(response.status).toBe(403);
    expect(setPlanItemCase).not.toHaveBeenCalled();
    expect(changeClinicalCaseStatus).not.toHaveBeenCalled();
  });
});
