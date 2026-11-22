import { beforeEach, describe, expect, it, vi } from "vitest";

// Entirely synthetic: no patient data, image bytes, or shared database access.
const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  access: vi.fn(),
  study: vi.fn(),
  comparison: vi.fn(),
  patient: vi.fn(),
  settings: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: mocks.access }));
vi.mock("@/lib/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/db")>(),
  getCephStudy: mocks.study,
  getCephAnalysisForCompare: mocks.comparison,
  getPatient: mocks.patient,
  getSettingsSafe: mocks.settings,
}));
vi.mock("@/components/PrintHeader", () => ({
  PrintHeader: () => null,
  PrintFooter: () => null,
}));
vi.mock("@/components/PrintButton", () => ({ PrintButton: () => null }));

import CephPrintReportPage from "../app/print/ceph/[id]/page";
import CephComparePrintPage from "../app/print/ceph-compare/page";

const single = { params: Promise.resolve({ id: "17" }) };
const compare = { searchParams: Promise.resolve({ first: "21", second: "22" }) };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ role: "reception", username: "synthetic-reception" });
  mocks.access.mockResolvedValue(true); // Legacy broad access must not override P0.
  mocks.study.mockResolvedValue(null);
  mocks.comparison.mockResolvedValue(null);
  mocks.patient.mockResolvedValue(null);
  mocks.settings.mockResolvedValue({});
});

function noClinicalReads() {
  expect(mocks.access).not.toHaveBeenCalled();
  expect(mocks.study).not.toHaveBeenCalled();
  expect(mocks.comparison).not.toHaveBeenCalled();
  expect(mocks.patient).not.toHaveBeenCalled();
  expect(mocks.settings).not.toHaveBeenCalled();
}

describe("P0: reception cannot print clinical cephalometric data", () => {
  it("blocks reception before the single-study print fetch", async () => {
    await expect(CephPrintReportPage(single)).rejects.toThrow();
    noClinicalReads();
  });

  it("blocks reception before either comparison analysis fetch", async () => {
    await expect(CephComparePrintPage(compare)).rejects.toThrow();
    noClinicalReads();
  });

  it("rejects anonymous access to both print pages without clinical reads", async () => {
    mocks.session.mockResolvedValue(null);
    await expect(CephPrintReportPage(single)).rejects.toThrow();
    await expect(CephComparePrintPage(compare)).rejects.toThrow();
    noClinicalReads();
  });

  it.each(["admin", "doctor"])("retains the authorized %s route to study lookup", async role => {
    mocks.session.mockResolvedValue({ role, username: "synthetic-clinician" });
    // Synthetic nonexistent records should stop at notFound AFTER the legitimate query.
    await expect(CephPrintReportPage(single)).rejects.toThrow();
    expect(mocks.study).toHaveBeenCalledWith(17);
    await expect(CephComparePrintPage(compare)).rejects.toThrow();
    expect(mocks.comparison).toHaveBeenNthCalledWith(1, 21);
    expect(mocks.comparison).toHaveBeenNthCalledWith(2, 22);
  });
});
