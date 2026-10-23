import { beforeEach, describe, expect, it, vi } from "vitest";
import { appointment } from "./fixtures/patient-appointments";
import { emptyPatientAppointmentsFixtureRead, isPatientFileFixtureRead } from "./helpers/patient-file-fixture-route";
import { readPatientAppointmentsPage } from "../lib/patient-appointments-contract";

const deps = vi.hoisted(() => ({ session: vi.fn(), access: vi.fn(), read: vi.fn(), full: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSession: deps.session }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: deps.access }));
vi.mock("@/lib/patient-appointments-reader", () => ({ readPatientAppointments: deps.read }));
vi.mock("@/lib/db", () => ({ CLINIC_TIME_ZONE: "Asia/Aden", getPatientFile: deps.full }));
import { GET } from "../app/api/patients/[id]/route";

const patientId = 31;
const warning = "Synthetic navigation fixture warning";
const urlFor = (query = "") => new URL(`http://localhost/api/patients/${patientId}${query}`);
const get = (url: URL) => GET(new Request(url), { params: Promise.resolve({ id: String(patientId) }) });

beforeEach(() => {
  vi.clearAllMocks();
  deps.session.mockResolvedValue({ username: "synthetic", role: "admin" });
  deps.access.mockResolvedValue(true);
  deps.read.mockResolvedValue({ today: "2026-10-22", appointments: [appointment()], nextCursor: null });
  deps.full.mockResolvedValue({ patient: { id: patientId, medicalAlert: null }, visits: [], appointments: [] });
});

describe("mock-only clinical owner appointment projection", () => {
  const syntheticOwner = 98301;
  const now = new Date("2026-10-21T22:30:00Z");
  const ownerUrl = (query: string) => new URL(`http://localhost/api/patients/${syntheticOwner}${query}`);

  it.each(["upcoming", "history"] as const)("provides a valid empty %s page instead of a full file or unexpected API refusal", view => {
    const url = ownerUrl(`?projection=appointments&view=${view}`);
    expect(isPatientFileFixtureRead(url, syntheticOwner)).toBe(false);
    const page = emptyPatientAppointmentsFixtureRead(url, syntheticOwner, now);
    expect(page).toMatchObject({ patientId: syntheticOwner, view, requestCursor: null, today: "2026-10-22",
      timeZone: "Asia/Aden", generatedAt: now.toISOString(), appointments: [], nextCursor: null });
    expect(page).not.toHaveProperty("patient");
    expect(readPatientAppointmentsPage(page, syntheticOwner, view, null)).toEqual(page);
    expect(readPatientAppointmentsPage(page, syntheticOwner + 1, view, null)).toBeNull();
    // The previous path-only mock was not a valid projection, even with an empty appointments array.
    expect(readPatientAppointmentsPage({ patient: { id: syntheticOwner }, visits: [], appointments: [] },
      syntheticOwner, view, null)).toBeNull();
  });

  it.each(["", "?projection=unknown", "?projection=appointments&projection=appointments",
    "?projection=appointments&view=unknown", "?projection=appointments&cursor=unexpected"])(
    "does not turn an unrelated or invalid request into a successful projection: %s", query => {
      expect(emptyPatientAppointmentsFixtureRead(ownerUrl(query), syntheticOwner, now)).toBeNull();
    },
  );

  it("does not allow another synthetic owner through the projection branch", () => {
    expect(emptyPatientAppointmentsFixtureRead(ownerUrl("?projection=appointments"), syntheticOwner + 1, now)).toBeNull();
  });
});

describe("patient navigation full-file fixture isolation", () => {
  it.each(["", "?navigationProbe=1"])("still overlays the actual full-file response for %s", async query => {
    const url = urlFor(query);
    expect(isPatientFileFixtureRead(url, patientId)).toBe(true);
    const response = await get(url);
    expect(response.status).toBe(200);
    const payload = await response.json();
    // Keep the browser fixture's strict canonical identity assertion intact.
    expect(payload.patient.id).toBe(patientId);
    payload.patient.medicalAlert = warning;
    expect(payload.patient.medicalAlert).toBe(warning);
    expect(deps.full).toHaveBeenCalledWith(patientId);
    expect(deps.read).not.toHaveBeenCalled();
  });

  it("passes the actual appointment projection through without treating it as a full patient file", async () => {
    const url = urlFor("?projection=appointments&view=upcoming");
    const response = await get(url);
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({ patientId, view: "upcoming", appointments: [appointment()] });
    expect(payload).not.toHaveProperty("patient");
    expect(() => {
      if (isPatientFileFixtureRead(url, patientId)) {
        expect(payload.patient.id).toBe(patientId);
        payload.patient.medicalAlert = warning;
      }
    }).not.toThrow();
    expect(isPatientFileFixtureRead(url, patientId)).toBe(false);
    expect(deps.full).not.toHaveBeenCalled();
  });

  it.each(["?projection=", "?projection=unknown", "?projection=appointments&projection=appointments"])(
    "preserves the actual API refusal for %s instead of running a full-file overlay", async query => {
      const url = urlFor(query);
      expect(isPatientFileFixtureRead(url, patientId)).toBe(false);
      const response = await get(url);
      expect(response.status).toBe(400);
      expect(await response.json()).not.toHaveProperty("patient");
      expect(deps.full).not.toHaveBeenCalled();
      expect(deps.read).not.toHaveBeenCalled();
    },
  );

  it("does not classify another patient or a nested endpoint as this patient file", () => {
    expect(isPatientFileFixtureRead(new URL("http://localhost/api/patients/32"), patientId)).toBe(false);
    expect(isPatientFileFixtureRead(new URL("http://localhost/api/patients/31/workflow"), patientId)).toBe(false);
  });
});
