import { beforeEach, describe, expect, it, vi } from "vitest";

// No production patient records: every identity and record below is synthetic.
// A patient-scope grant for reception/assistant is not clinical-print authority.
const mocks = vi.hoisted(() => ({
  session: vi.fn(), access: vi.fn(), patient: vi.fn(), chart: vi.fn(),
  ledger: vi.fn(), planCurrencies: vi.fn(), settings: vi.fn(), endo: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: mocks.access }));
vi.mock("@/lib/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/db")>(),
  getPatientFile: mocks.patient,
  patientChart: mocks.chart,
  patientLedger: mocks.ledger,
  patientPlanCurrencies: mocks.planCurrencies,
  getSettingsSafe: mocks.settings,
}));
vi.mock("@/lib/endodontics-db", () => ({ listPatientEndo: mocks.endo }));

import DossierPage from "../app/print/dossier/[id]/page";

const page = () => DossierPage({ params: Promise.resolve({ id: "77" }) });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.access.mockResolvedValue(true);
  mocks.patient.mockResolvedValue({
    patient: {
      id: 77, fullName: "SYNTHETIC PATIENT", patientNumber: "P-07000",
      gender: "unknown", birthYear: null, createdAt: "2026-11-23T09:00:00Z",
      medicalAlert: null, phone: null, address: null,
    },
    visits: [], appointments: [],
  });
  mocks.chart.mockResolvedValue({ records: [], summary: { charted: 0, caries: 0, planned: 0, completed: 0, absent: 0 } });
  mocks.settings.mockResolvedValue({});
  mocks.ledger.mockResolvedValue(null);
  mocks.planCurrencies.mockResolvedValue(null);
  mocks.endo.mockResolvedValue([]);
});

describe("P0-B clinical A4 dossier print role boundary", () => {
  it.each(["reception", "assistant", "cashier", "accountant"])(
    "blocks %s before any patient or clinical reader even if generic patient-scope would allow it",
    async role => {
      mocks.session.mockResolvedValue({ userId: 10, username: "synthetic-frontdesk", role });
      await expect(page()).rejects.toThrow();
      expect(mocks.access).not.toHaveBeenCalled();
      for (const reader of [mocks.patient, mocks.chart, mocks.ledger, mocks.planCurrencies, mocks.settings, mocks.endo]) {
        expect(reader).not.toHaveBeenCalled();
      }
    },
  );

  it("rejects out-of-scope doctor before dossier, chart, endodontics or financial queries", async () => {
    mocks.session.mockResolvedValue({ userId: 12, username: "synthetic-doctor", role: "doctor" });
    mocks.access.mockResolvedValue(false);
    await expect(page()).rejects.toThrow();
    expect(mocks.access).toHaveBeenCalledWith(expect.objectContaining({ role: "doctor" }), 77);
    for (const reader of [mocks.patient, mocks.chart, mocks.ledger, mocks.planCurrencies, mocks.settings, mocks.endo]) {
      expect(reader).not.toHaveBeenCalled();
    }
  });

  it("retains scoped doctor clinical print while not querying financial data without permission", async () => {
    mocks.session.mockResolvedValue({ userId: 12, username: "synthetic-doctor", role: "doctor" });
    mocks.access.mockImplementation(async (_session, _id, permission) => permission === undefined);
    const result = await page();
    expect(result).toBeDefined();
    expect(mocks.patient).toHaveBeenCalledWith(77);
    expect(mocks.chart).toHaveBeenCalledWith(77);
    expect(mocks.ledger).not.toHaveBeenCalled();
    expect(mocks.planCurrencies).not.toHaveBeenCalled();
  });
});
