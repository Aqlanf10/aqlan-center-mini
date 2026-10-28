import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import QRCode from "qrcode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SETTING_DEFAULTS } from "../lib/settings";
import { DISPATCH_PRIVATE_CANARIES, dispatchOrder } from "./fixtures/lab-dispatch";

const mocks = vi.hoisted(() => ({ requireSession: vi.fn(), getLabOrderById: vi.fn(), getSettingsSafe: vi.fn(), canAccessPatient: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSession: mocks.requireSession }));
// Intentionally no getPatient export: the external page must not read demographics.
vi.mock("@/lib/db", () => ({ getLabOrderById: mocks.getLabOrderById, getSettingsSafe: mocks.getSettingsSafe }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: mocks.canAccessPatient }));
vi.mock("../components/SettingsProvider", () => ({ useSetting: (key: string) => `SYNTHETIC_SETTING_${key}` }));
import LabOrderPrintPage from "../app/print/lab/[id]/page";
import { LabPrescriptionModal } from "../components/LabPrescriptionModal";

const settings = { ...SETTING_DEFAULTS, "clinic.name": "SYNTHETIC_CLINIC", "clinic.phone": "000-333-444", "clinic.lead_doctor": "SYNTHETIC_CLINIC_DOCTOR" };
const renderPage = async (id = "381") => renderToStaticMarkup(await LabOrderPrintPage({ params: Promise.resolve({ id }) }));
const assertPrivateAbsent = (html: string) => {
  for (const text of [...DISPATCH_PRIVATE_CANARIES, "910007", "910008", "910009", "910010", "875431", "اسم المريض", "هاتف المريض", "رقم الملف"]) expect(html).not.toContain(text);
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  mocks.requireSession.mockResolvedValue({ role: "admin", username: "synthetic", userId: 1 });
  mocks.getLabOrderById.mockResolvedValue(dispatchOrder());
  mocks.getSettingsSafe.mockResolvedValue(settings);
  mocks.canAccessPatient.mockResolvedValue(true);
});

describe("actual lab document render privacy", () => {
  it("renders the actual authorized page and real QR encoder with only the order reference", async () => {
    // The encoder runs normally; this spy observes its input and output.
    // Pixel decoding and PDF/browser acceptance remain separate CI checks.
    const qr = vi.spyOn(QRCode, "toDataURL");
    const source = dispatchOrder();
    const before = structuredClone(source);
    mocks.getLabOrderById.mockResolvedValue(source);
    const html = await renderPage();
    assertPrivateAbsent(html);
    expect(html).toContain('data-dental-arch="18,17,16,15,14,13,12,11,21,22,23,24,25,26,27,28" dir="ltr"');
    expect(html).toContain('data-dental-arch="48,47,46,45,44,43,42,41,31,32,33,34,35,36,37,38" dir="ltr"');
    for (const expected of ["RX-381", "SYNTHETIC_CATALOGUE_CROWN", "SYNTHETIC_LAB", "SYNTHETIC_DOCTOR", "SYNTHETIC_CLINIC", "A2", "ND2", "دعامة جسر", "دمية جسر", "مراجعة فنية مطلوبة", "الملاحظات الداخلية", "2000-02-05"]) expect(html).toContain(expected);
    expect(qr).toHaveBeenCalledTimes(1);
    expect(qr.mock.calls[0][0]).toBe('{"rx":"RX-381"}');
    const encoded = await qr.mock.results[0].value;
    expect(encoded).toMatch(/^data:image\/png;base64,/);
    expect(html).toContain(encoded);
    expect(mocks.canAccessPatient).toHaveBeenCalledWith(expect.objectContaining({ role: "admin" }), 910007);
    expect(source).toEqual(before);
  });

  it.each([
    ["51(Crown), 65(Pontic), 71(Abutment), 85(Crown)", [51, 65, 71, 85]],
    ["14(Abutment), 51(Crown), 75(Pontic)", [51, 75]],
  ])("draws selected primary teeth in both labeled arches: %s", async (toothNumbers, selected) => {
    const source = dispatchOrder({ toothNumbers });
    const before = structuredClone(source);
    mocks.getLabOrderById.mockResolvedValue(source);
    const html = await renderPage();
    assertPrivateAbsent(html);
    expect(html).toContain('aria-label="الأسنان اللبنية — الفك العلوي"');
    expect(html).toContain('aria-label="الأسنان اللبنية — الفك السفلي"');
    const cells = [...html.matchAll(/data-primary-tooth="(\d+)" data-selected="(true|false)"/g)];
    expect(cells.map((cell) => Number(cell[1]))).toEqual([55, 54, 53, 52, 51, 61, 62, 63, 64, 65, 85, 84, 83, 82, 81, 71, 72, 73, 74, 75]);
    expect(cells.filter((cell) => cell[2] === "true").map((cell) => Number(cell[1])).sort((a, b) => a - b)).toEqual(selected);
    for (const code of selected) expect(html).toContain(`<strong>#${code}</strong>`);
    expect(html).toContain("تاج");
    expect(html).toContain("دمية جسر");
    expect(source).toEqual(before);
  });

  it("keeps the permanent-only diagram unchanged without extra primary rows", async () => {
    const html = await renderPage();
    expect(html).not.toContain("data-primary-tooth");
    for (const code of [14, 15, 16]) expect(html).toContain(`<strong>#${code}</strong>`);
    expect(html).toContain("دعامة جسر");
    expect(html).toContain("دمية جسر");
    assertPrivateAbsent(html);
  });

  it("renders modal preview without private fields and offers only the dedicated print page", () => {
    const html = renderToStaticMarkup(<LabPrescriptionModal order={dispatchOrder()} onClose={() => {}} />);
    assertPrivateAbsent(html);
    expect(html).toContain('href="/print/lab/381"');
    expect(html).toContain("صفحة طباعة الإرسالية");
    expect(html).toContain("مراجعة فنية مطلوبة");
    expect(html).toContain("body { display: none !important; }");
    expect(html).not.toContain("امسح للاستعلام");
  });

  it("shows unknown clinical facts as unknown in both actual renderers", async () => {
    const source = dispatchOrder({ labServiceId: null, serviceName: null, workType: "SYNTHETIC_PRIVATE_WORK", toothNumbers: null, toothCode: 36, shade: null, stumpShade: null, doctorName: null });
    mocks.getLabOrderById.mockResolvedValue(source);
    for (const html of [await renderPage(), renderToStaticMarkup(<LabPrescriptionModal order={source} onClose={() => {}} />)]) {
      assertPrivateAbsent(html);
      expect(html).not.toContain("SYNTHETIC_PRIVATE_WORK");
      expect(html).toContain("غير محدد في دليل المعمل");
      expect(html).toContain("دور غير محدد");
      expect(html).toContain("لون السن غير محدد");
      expect(html).not.toContain("حسب تقدير الفني");
    }
  });

  it("retains the human-readable reference if local QR generation fails", async () => {
    vi.spyOn(QRCode, "toDataURL").mockImplementation(() => { throw new Error("synthetic QR failure"); });
    const html = await renderPage();
    assertPrivateAbsent(html);
    expect(html).toContain("RX-381");
    expect(html).not.toContain("synthetic QR failure");
  });

  it("does not read an order without a staff session", async () => {
    mocks.requireSession.mockResolvedValue(null);
    await expect(renderPage()).rejects.toThrow();
    expect(mocks.getLabOrderById).not.toHaveBeenCalled();
    expect(mocks.getSettingsSafe).not.toHaveBeenCalled();
  });

  it.each(["0", "-1", "invalid", "1.5"])("does not read malformed order ID %s", async (id) => {
    await expect(renderPage(id)).rejects.toThrow();
    expect(mocks.getLabOrderById).not.toHaveBeenCalled();
    expect(mocks.getSettingsSafe).not.toHaveBeenCalled();
  });

  it.each([false, "throws"])("retains the independent patient ownership denial: %s", async (denial) => {
    if (denial === "throws") mocks.canAccessPatient.mockRejectedValue(new Error("synthetic ownership failure"));
    else mocks.canAccessPatient.mockResolvedValue(false);
    await expect(renderPage()).rejects.toThrow();
    expect(mocks.getSettingsSafe).not.toHaveBeenCalled();
  });
});
