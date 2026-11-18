import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** OP-3 print page. Synthetic data only; no patient images. */
const mocks = vi.hoisted(() => ({
  session: vi.fn(), access: vi.fn(), orthoCase: vi.fn(), patient: vi.fn(), documents: vi.fn(),
}));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
vi.mock("@/lib/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: mocks.access }));
vi.mock("@/lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden",
  getOrthoCase: mocks.orthoCase,
  getPatient: mocks.patient,
  listPatientDocuments: mocks.documents,
  getSettingsSafe: async () => ({
    "clinic.name": "SYN مركز اصطناعي", "clinic.lead_doctor": "SYN-DOCTOR", "clinic.lead_doctor_title": "SYN-TITLE",
    "clinic.lead_doctor_credentials": "SYN-CRED", "clinic.address": "SYN-ADDRESS", "clinic.phone": "000-000",
    "ortho.photo_stage_requirements": "", "ortho.photo_print_layout": "",
  }),
}));
vi.mock("@/components/PrintButton", () => ({ PrintButton: () => null }));
import Page from "../app/print/ortho-photos/[caseId]/page";

const photo = (id: number, photoView: string, extra: Record<string, unknown> = {}) => ({
  id, patientId: 5, orthoCaseId: 7, adjustmentId: 9, isImage: true, removedAt: null, photoStage: "initial",
  photoView, takenOn: "2026-01-04", title: "SYN", uploadedAt: "2026-01-04T08:00:00.000Z", ...extra,
});
const render = async (query: Record<string, string> = { stage: "initial", date: "2026-01-04", adjustment: "9" }, caseId = "7") =>
  renderToStaticMarkup(await Page({ params: Promise.resolve({ caseId }), searchParams: Promise.resolve(query) }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ username: "syn", role: "doctor" });
  mocks.access.mockResolvedValue(true);
  mocks.orthoCase.mockResolvedValue({ id: 7, patientId: 5 });
  mocks.patient.mockResolvedValue({ id: 5, fullName: "SYN Patient", patientNumber: "SYN-001" });
  mocks.documents.mockResolvedValue([
    photo(11, "smile"), photo(12, "intraoral_right"), photo(13, "intraoral_left"),
    photo(14, "smile", { takenOn: "2026-02-01" }), photo(15, "profile", { adjustmentId: 10 }), photo(16, "panoramic"),
  ]);
});

describe("/print/ortho-photos/[caseId] (OP-3)", () => {
  it("prints one capture set with the clinic identity from Settings, patient sides and empty frames", async () => {
    const html = await render();
    for (const text of ["SYN مركز اصطناعي", "SYN-DOCTOR", "SYN-CRED", "SYN-ADDRESS", "SYN Patient", "SYN-001", "صور البداية"]) expect(html).toContain(text);
    expect(html).toContain('<bdi dir="ltr">2026-01-04</bdi>');
    expect(html).toContain("داخل الفم — جانب المريض الأيمن");
    expect(html).toContain("داخل الفم — جانب المريض الأيسر");
    for (const id of [11, 12, 13]) expect(html).toContain(`<img class="print-watermark-protected" src="/api/documents/${id}"`);
    for (const id of [14, 15, 16]) expect(html).not.toContain(`/api/documents/${id}"`);
    expect(html).toContain("غير مصوّرة");
    expect(html).toContain("object-fit:contain");
    expect(html).not.toMatch(/transform|rotate|scaleX|filter:/);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("no session: Arabic message, nothing loaded", async () => {
    mocks.session.mockResolvedValue(null);
    expect(await render()).toContain("انتهت الجلسة. سجّل الدخول من جديد.");
    expect(mocks.orthoCase).not.toHaveBeenCalled();
    expect(mocks.documents).not.toHaveBeenCalled();
  });

  it("a missing case or a patient outside access is the same not-found, without loading documents", async () => {
    mocks.orthoCase.mockResolvedValue(null);
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
    mocks.orthoCase.mockResolvedValue({ id: 7, patientId: 5 });
    mocks.access.mockResolvedValue(false);
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.documents).not.toHaveBeenCalled();
  });

  it("without photo permission: Arabic message, documents never loaded", async () => {
    mocks.access.mockImplementation(async (_s: unknown, _p: number, capability?: string) => capability !== "canViewXrays");
    const html = await render();
    expect(html).toContain("لا صلاحية لعرض صور المريض.");
    expect(mocks.documents).not.toHaveBeenCalled();
    expect(html).not.toContain("/api/documents/");
  });

  it.each([
    [{ stage: "archived", date: "2026-01-04", adjustment: "9" }],
    [{ stage: "initial", date: "2026-02-30", adjustment: "9" }],
    [{ stage: "initial", date: "2026-01-04", adjustment: "x" }],
    [{ stage: "initial", date: "2026-01-04" }],
  ])("rejects an invalid capture-set selection in Arabic (%o)", async (query) => {
    const html = await render(query as Record<string, string>);
    expect(html).toContain("رابط مجموعة التصوير غير صالح.");
    expect(mocks.documents).not.toHaveBeenCalled();
  });

  it("an unlinked set prints with adjustment=none; an empty selection says so", async () => {
    mocks.documents.mockResolvedValue([photo(21, "smile", { adjustmentId: null })]);
    expect(await render({ stage: "initial", date: "2026-01-04", adjustment: "none" })).toContain('src="/api/documents/21"');
    expect(await render()).toContain("لا توجد صور في مجموعة التصوير هذه.");
  });

  it("rejects a non-canonical case id", async () => {
    await expect(render(undefined, "07")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.orthoCase).not.toHaveBeenCalled();
  });
});
