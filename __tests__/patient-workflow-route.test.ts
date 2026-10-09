// PR285 ONLY: install this source with the legacy workflow route, not PR278.
import { beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  requireSession: vi.fn(), canAccessPatient: vi.fn(), patientWorkflow: vi.fn(), getSettings: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: boundary.requireSession }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: boundary.canAccessPatient }));
vi.mock("@/lib/db", () => ({
  CLINIC_TIME_ZONE: "UTC", patientWorkflow: boundary.patientWorkflow, getSettings: boundary.getSettings,
}));

// Exercise the actual route, including its real HTTP_PERMISSIONS/roles policy.
// This file targets the legacy release, whose workflow response contains both arrays.
import { GET } from "../app/api/patients/[id]/workflow/route";

const assessment = { id: 12, patientId: 7, kind: "specialty", orthoCaseId: null,
  specialty: "endodontics", title: "Synthetic assessment", needsAssessment: true };
const legacy = { id: null, patientId: 7, kind: "ortho", orthoCaseId: 91,
  specialty: "orthodontics", title: "Synthetic historical case", site: null, status: "active", legacy: true };
const summary = {
  patient: { id: 7, fullName: "Synthetic patient" },
  openVisit: { id: 42, status: "waiting", arrivedAt: "2026-10-07T08:00:00Z",
    chair: null, plannedTitle: null },
  nextAppointment: { id: 51 }, activePlans: [{ id: 61 }], plannedVisits: [{ id: 71 }],
  assessmentCases: [assessment], legacyCases: [legacy],
  financial: { balanceMinor: 900 }, alerts: [],
  counts: { visits: 1, openLabOrders: 0, documents: 0, orthoCase: false },
};
const request = () => new Request("http://test.invalid/api/patients/7/workflow");
const context = (id = "7") => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.resetAllMocks();
  boundary.requireSession.mockResolvedValue({ username: "synthetic-admin", role: "admin" });
  boundary.canAccessPatient.mockResolvedValue(true);
  boundary.patientWorkflow.mockResolvedValue(summary);
  boundary.getSettings.mockResolvedValue({ "workflow.doctor_financial_view": "false" });
});

describe("workflow GET case projection authorization", () => {
  it.each(["admin", "reception", "doctor"])("allows owned case projections for %s", async (role) => {
    const session = { username: `synthetic-${role}`, role };
    boundary.requireSession.mockResolvedValue(session);
    const response = await GET(request(), context());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.assessmentCases).toEqual([assessment]);
    expect(body.legacyCases).toEqual([legacy]);
    expect(boundary.canAccessPatient).toHaveBeenCalledExactlyOnceWith(session, 7);
    expect(boundary.patientWorkflow).toHaveBeenCalledExactlyOnceWith(7, expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
    expect(body.canSeeFinancial).toBe(role !== "doctor");
    expect(body.financial).toEqual(role === "doctor" ? null : summary.financial);
  });

  it("keeps both clinical case arrays empty for an assistant while retaining permitted context", async () => {
    boundary.requireSession.mockResolvedValue({ username: "synthetic-assistant", role: "assistant" });
    const response = await GET(request(), context());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.assessmentCases).toEqual([]);
    expect(body.legacyCases).toEqual([]);
    expect(body.patient).toEqual(summary.patient);
    expect(body.openVisit).toEqual(summary.openVisit);
    expect(body.activePlans).toEqual([]);
    expect(body.plannedVisits).toEqual([]);
    expect(body.nextAppointment).toBeNull();
    expect(body.financial).toBeNull();
    expect(body.canSeeFinancial).toBe(false);
    expect(JSON.stringify(body)).not.toContain(assessment.title);
    expect(JSON.stringify(body)).not.toContain(legacy.title);
    // Projection masking must not mutate a database result reused by another caller.
    expect(summary.assessmentCases).toEqual([assessment]);
    expect(summary.legacyCases).toEqual([legacy]);
  });

  it("returns 403 before querying workflow or settings for a foreign patient", async () => {
    const session = { username: "synthetic-doctor", role: "doctor" };
    boundary.requireSession.mockResolvedValue(session);
    boundary.canAccessPatient.mockResolvedValue(false);
    const response = await GET(request(), context());
    expect(response.status).toBe(403);
    expect(boundary.canAccessPatient).toHaveBeenCalledExactlyOnceWith(session, 7);
    expect(boundary.patientWorkflow).not.toHaveBeenCalled();
    expect(boundary.getSettings).not.toHaveBeenCalled();
    const body = await response.json();
    expect(body).not.toHaveProperty("assessmentCases");
    expect(body).not.toHaveProperty("legacyCases");
  });

  it("returns 401 without reading a patient for an expired session", async () => {
    boundary.requireSession.mockResolvedValue(null);
    expect((await GET(request(), context())).status).toBe(401);
    expect(boundary.canAccessPatient).not.toHaveBeenCalled();
    expect(boundary.patientWorkflow).not.toHaveBeenCalled();
  });

  it("returns 404 without exposing projections when the patient is missing", async () => {
    boundary.patientWorkflow.mockResolvedValue({ ...summary, patient: null });
    const response = await GET(request(), context());
    expect(response.status).toBe(404);
    expect(await response.json()).not.toHaveProperty("assessmentCases");
    expect(boundary.getSettings).not.toHaveBeenCalled();
  });

  it("returns 500 without projections when the workflow query fails", async () => {
    boundary.patientWorkflow.mockRejectedValue(new Error("Synthetic workflow read failure"));
    const response = await GET(request(), context());
    expect(response.status).toBe(500);
    expect(await response.json()).not.toHaveProperty("legacyCases");
  });
});
