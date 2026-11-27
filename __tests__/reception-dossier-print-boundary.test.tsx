import { beforeEach, describe, expect, it, vi } from "vitest";

// No patient data, storage or shared database is accessed: synthetic spies only.
const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  access: vi.fn(),
  patient: vi.fn(),
  chart: vi.fn(),
  ledger: vi.fn(),
  planCurrencies: vi.fn(),
  settings: vi.fn(),
  endo: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: mocks.access }));
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/db")>()),
  getPatientFile: mocks.patient,
  patientChart: mocks.chart,
  patientLedger: mocks.ledger,
  patientPlanCurrencies: mocks.planCurrencies,
  getSettingsSafe: mocks.settings,
}));
vi.mock("@/lib/endodontics-db", () => ({ listPatientEndo: mocks.endo }));
vi.mock("@/components/PrintHeader", () => ({ PrintHeader: () => null }));
vi.mock("@/components/PrintButton", () => ({ PrintButton: () => null }));
import DossierPage from "../app/print/dossier/[id]/page";

const params = { params: Promise.resolve({ id: "17" }) };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.access.mockResolvedValue(true); // legacy broad access must NOT bypass the new guard
  mocks.session.mockResolvedValue({ role: "reception", username: "synthetic-reception" });
  mocks.patient.mockResolvedValue({
    patient: {
      id: 17,
      fullName: "Synthetic only",
      patientNumber: "SYN-17",
      gender: "male",
      birthYear: 1990,
      phone: null,
      address: null,
      medicalAlert: "synthetic-private-alert",
      createdAt: "2026-01-01T00:00:00Z",
    },
    visits: [
      {
        id: 4,
        arrivedAt: "2026-11-22T09:00:00.000Z",
        chair: 1,
        status: "done",
        note: "synthetic-private-visit",
      },
    ],
    appointments: [],
  });
  mocks.chart.mockResolvedValue(null);
  mocks.ledger.mockResolvedValue(null);
  mocks.planCurrencies.mockResolvedValue(null);
  mocks.settings.mockResolvedValue({});
  mocks.endo.mockResolvedValue([]);
});

describe("P0: reception cannot print the unrestricted clinical dossier", () => {
  it.each(["reception", "assistant", "cashier", "accountant"])(
    "rejects %s before every sensitive reader",
    async (role) => {
      mocks.session.mockResolvedValue({ role, username: "synthetic-nonclinical" });
      await expect(DossierPage(params)).rejects.toThrow();
      expect(mocks.access).not.toHaveBeenCalled();
      expect(mocks.patient).not.toHaveBeenCalled();
      expect(mocks.chart).not.toHaveBeenCalled();
      expect(mocks.ledger).not.toHaveBeenCalled();
      expect(mocks.planCurrencies).not.toHaveBeenCalled();
      expect(mocks.settings).not.toHaveBeenCalled();
      expect(mocks.endo).not.toHaveBeenCalled();
    },
  );

  it("does not admit anonymous requests even with a valid synthetic patient ID", async () => {
    mocks.session.mockResolvedValue(null);
    await expect(DossierPage(params)).rejects.toThrow();
    expect(mocks.patient).not.toHaveBeenCalled();
    expect(mocks.endo).not.toHaveBeenCalled();
  });

  it("denies a doctor outside the authorized patient scope", async () => {
    mocks.session.mockResolvedValue({ role: "doctor", username: "synthetic-unassigned" });
    mocks.access.mockResolvedValue(false);
    await expect(DossierPage(params)).rejects.toThrow();
    expect(mocks.patient).not.toHaveBeenCalled();
    expect(mocks.endo).not.toHaveBeenCalled();
  });

  it.each(["admin", "doctor"])(
    "preserves clinical print for the authorized %s role",
    async (role) => {
      mocks.session.mockResolvedValue({ role, username: "synthetic-authorized" });
      await expect(DossierPage(params)).resolves.toBeTruthy();
      expect(mocks.access).toHaveBeenCalledWith(expect.anything(), 17);
      expect(mocks.patient).toHaveBeenCalledWith(17);
      expect(mocks.endo).toHaveBeenCalledWith(17);
    },
  );
});
