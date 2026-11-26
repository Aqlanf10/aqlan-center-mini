import { beforeEach, describe, expect, it, vi } from "vitest";
import { appointment } from "./fixtures/patient-appointments";

const deps = vi.hoisted(() => ({
  session: vi.fn(), file: vi.fn(), access: vi.fn(), read: vi.fn(),
  query: vi.fn(), debt: vi.fn(),
  user: vi.fn(), owns: vi.fn(), visit: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: deps.session }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: deps.access }));
vi.mock("@/lib/patient-appointments-reader", () => ({ readPatientAppointments: deps.read }));
vi.mock("@/lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden",
  getPool: () => ({ query: deps.query }), computeDebtRows: deps.debt,
  getPatientFile: deps.file, findUserByUsername: deps.user,
  doctorOwnsPatient: deps.owns, patientHasVisitToday: deps.visit,
}));
import { GET } from "../app/api/patients/[id]/route";

const syntheticId = 31;
const get = (query = "") => GET(
  new Request(`http://localhost/api/patients/${syntheticId}${query}`),
  { params: Promise.resolve({ id: String(syntheticId) }) },
);
const syntheticFile = {
  patient: { id: syntheticId, fullName: "Synthetic Patient", medicalAlert: "synthetic-clinical-secret" },
  visits: [{ note: "synthetic-clinical-secret" }],
  documents: [{ originalName: "synthetic-xray.png", url: "/synthetic/secret" }],
  invoices: [{ total: 99999 }],
};
beforeEach(() => {
  vi.clearAllMocks();
  deps.session.mockResolvedValue({ role: "reception", username: "synthetic-reception" });
  deps.file.mockResolvedValue(syntheticFile);
  deps.access.mockResolvedValue(true);
  deps.read.mockResolvedValue({
    today: "2026-11-22", appointments: [{ ...appointment(), scheduledDate: "2026-11-23" }], nextCursor: null,
  });
  deps.user.mockResolvedValue({ isActive: true, partyId: 9, permissions: {} });
  deps.owns.mockResolvedValue(true);
  deps.visit.mockResolvedValue(true);
});

describe("P0 reception full patient GET boundary (synthetic data only)", () => {
  it.each(["", "?navigationProbe=1"])("rejects unrestricted full file %s before ANY sensitive DB read", async query => {
    const result = await get(query);
    expect(result.status).toBe(403);
    expect(result.headers.get("Cache-Control")).toBe("private, no-store");
    const body = JSON.stringify(await result.json());
    expect(body).not.toContain("synthetic-clinical-secret");
    expect(body).not.toContain("synthetic-xray.png");
    expect(body).not.toContain("99999");
    expect(deps.file).not.toHaveBeenCalled();
    expect(deps.read).not.toHaveBeenCalled();
  });

  it("preserves reception's explicitly bounded appointments projection without reading the full file", async () => {
    const result = await get("?projection=appointments&view=upcoming");
    expect(result.status).toBe(200);
    expect((await result.json()).appointments).toHaveLength(1);
    expect(deps.file).not.toHaveBeenCalled();
    expect(deps.read).toHaveBeenCalled();
  });

  it("does not turn an invalid projection into a full-file fallback", async () => {
    const result = await get("?projection=not-allowed");
    expect(result.status).toBe(400);
    expect(deps.file).not.toHaveBeenCalled();
  });

  it.each(["admin", "doctor"])("preserves authorized full-file GET for %s", async role => {
    deps.session.mockResolvedValue({ role, username: "synthetic-authorized" });
    const result = await get();
    expect(result.status).toBe(200);
    expect(result.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await result.json()).toEqual(syntheticFile);
    expect(deps.file).toHaveBeenCalledWith(syntheticId);
  });

  it.each(["assistant", "cashier", "accountant"])(
    "rejects nonclinical %s full-file access without querying even visit metadata",
    async role => {
      deps.session.mockResolvedValue({ role, username: `synthetic-${role}` });
      const response = await get();
      expect(response.status).toBe(403);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      const serialized = JSON.stringify(await response.json());
      expect(serialized).not.toContain("synthetic-clinical-secret");
      expect(serialized).not.toContain("synthetic-xray.png");
      expect(serialized).not.toContain("99999");
      expect(deps.visit).not.toHaveBeenCalled();
      expect(deps.file).not.toHaveBeenCalled();
      expect(deps.read).not.toHaveBeenCalled();
    },
  );

  it("rejects unauthenticated requests without querying patient data", async () => {
    deps.session.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
    expect(deps.file).not.toHaveBeenCalled();
  });
});


describe("reception patient workspace projection", () => {
  it("selects the registration card for exactly the requested patient", async () => {
    const card = { id: syntheticId, fullName: "Synthetic Patient", patientNumber: "TEST-31", phone: null };
    deps.query.mockResolvedValue({ rows: [{ ...card, medicalAlert: "private", photoDocumentId: 812 }] });
    const response = await get("?projection=reception");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual(card);
    expect(deps.query).toHaveBeenCalledWith(expect.stringContaining("WHERE id = $1"), [syntheticId]);
    expect(deps.file).not.toHaveBeenCalled();
    expect(deps.debt).not.toHaveBeenCalled();
  });
  it("returns the same missing response for absent and out-of-scope records", async () => {
    deps.query.mockResolvedValue({ rows: [] });
    const missing = await get("?projection=reception");
    deps.query.mockClear();
    deps.access.mockResolvedValue(false);
    const forbidden = await get("?projection=reception");
    expect([missing.status, forbidden.status]).toEqual([404, 404]);
    expect(await forbidden.json()).toEqual(await missing.json());
    expect(deps.query).not.toHaveBeenCalled();
  });
});
