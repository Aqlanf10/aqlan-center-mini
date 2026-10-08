import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Invoice } from "../lib/db";
import { formatMoney } from "../lib/money";
import { friendlyDateLong } from "../lib/reminders";
import { SETTING_DEFAULTS } from "../lib/settings";

// Render the actual page, branding, signature row and reprint component. Only
// session/data reads are replaced; no database, browser or print logging runs.
const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(), getInvoice: vi.fn(), getPatient: vi.fn(),
  getSettingsSafe: vi.fn(), printCount: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/lib/db", () => ({
  getInvoice: mocks.getInvoice, getPatient: mocks.getPatient,
  getSettingsSafe: mocks.getSettingsSafe, printCount: mocks.printCount,
}));
import InvoicePage from "../app/print/invoice/[id]/page";

const settings = {
  ...SETTING_DEFAULTS,
  "clinic.name": "SYNTHETIC-CLINIC",
  "clinic.lead_doctor": "SYNTHETIC-DOCTOR",
  "clinic.lead_doctor_title": "SYNTHETIC-SPECIALTY",
  "clinic.lead_doctor_credentials": "SYNTHETIC-CREDENTIALS",
  "clinic.phone": "000-000000",
  "clinic.address": "SYNTHETIC-ADDRESS",
};
const invoice: Invoice = {
  id: 61, invoiceNumber: "SYNTHETIC-INV-61", patientId: 17,
  patientName: "SYNTHETIC-PATIENT", status: "open", totalMinor: 12500,
  discountMinor: 1500, baseCurrency: "YER", note: "SYNTHETIC-INVOICE-NOTE",
  createdAt: "2000-02-02T10:00:00.000Z",
  items: [{ id: 71, serviceId: null, doctorId: null, description: "SYNTHETIC-SERVICE",
    quantity: 1, unitPriceMinor: 12500, totalMinor: 12500 }],
};
const unsupportedClaims = [
  "فاتورة علاجية وضريبية معتمدة", "سجل طبي معتمد", "السجل / الرقم الضريبي",
  "E-INVOICE", "VERIFIED", "✓",
];
const render = async () => renderToStaticMarkup(await InvoicePage({ params: Promise.resolve({ id: "61" }) }));

function expectNeutralReference(html: string) {
  expect(html).toContain('class="invoice-document-reference"');
  expect(html).toContain("بيانات الفاتورة");
  expect(html).toContain("مرجع الفاتورة:");
  expect(html).toContain('<bdi dir="ltr">SYNTHETIC-INV-61-61</bdi>');
  for (const claim of unsupportedClaims) expect(html).not.toContain(claim);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireSession.mockResolvedValue({ role: "admin", username: "synthetic", userId: 1 });
  mocks.getInvoice.mockResolvedValue(structuredClone(invoice));
  mocks.getPatient.mockResolvedValue({ id: 17, phone: null });
  mocks.getSettingsSafe.mockResolvedValue({ ...settings });
  mocks.printCount.mockResolvedValue(0);
});

describe("invoice print document truthfulness", () => {
  it.each([
    { status: "open", printed: 0 }, { status: "paid", printed: 0 }, { status: "cancelled", printed: 0 },
    { status: "open", printed: 1 }, { status: "paid", printed: 1 }, { status: "cancelled", printed: 1 },
  ] as const)("preserves $status invoice content and print count $printed without certification", async ({ status, printed }) => {
    const record = { ...structuredClone(invoice), status };
    const before = structuredClone(record);
    mocks.getInvoice.mockResolvedValue(record);
    mocks.printCount.mockResolvedValue(printed);
    const html = await render();
    expectNeutralReference(html);
    for (const text of [invoice.invoiceNumber, invoice.patientName, "SYNTHETIC-SERVICE", invoice.note!,
      formatMoney(12500, "YER"), formatMoney(1500, "YER"), formatMoney(11000, "YER"),
      "الإجمالي قبل الخصم", "الخصم", "الصافي المستحق", friendlyDateLong("2000-02-02"),
      "المحاسب: ................", "المريض: ................",
      settings["clinic.name"], settings["clinic.lead_doctor"], settings["clinic.lead_doctor_title"],
      settings["clinic.lead_doctor_credentials"], settings["clinic.phone"], settings["clinic.address"]]) {
      expect(html).toContain(text);
    }
    expect(html).toContain('class="sheet sheet-a4"');
    expect(html).toContain('class="object-contain print-logo"');
    expect(html).toContain('src="/logo.png"');
    expect(html).toContain('class="sign-row"');
    expect(html.includes("ملغاة")).toBe(status === "cancelled");
    expect(html.includes('class="reprint-mark reprint-mark-on"')).toBe(printed > 0);
    expect(html).toContain("نسخة معاد طباعتها");
    expect(mocks.getInvoice).toHaveBeenCalledWith(61);
    expect(mocks.printCount).toHaveBeenCalledWith("invoice", 61);
    expect(record).toEqual(before);
  });

  // These are deliberately unrecognized input keys, not a new configuration
  // contract. Extra values must not invent an identifier or confer verification.
  it.each([
    { "clinic.tax_number": "", "clinic.cr_number": "" },
    { "clinic.tax_number": "   ", "clinic.cr_number": "\t" },
    { "clinic.tax_number": "SYNTHETIC-TAX-ID" },
    { "clinic.cr_number": "SYNTHETIC-REGISTRATION-ID" },
    { "clinic.tax_number": "SYNTHETIC-TAX-ID", "clinic.cr_number": "SYNTHETIC-REGISTRATION-ID" },
  ])("does not treat extra identifier-shaped settings as certification: %j", async (extra) => {
    mocks.getSettingsSafe.mockResolvedValue({ ...settings, ...extra });
    const html = await render();
    expectNeutralReference(html);
    expect(html).not.toContain("SYNTHETIC-TAX-ID");
    expect(html).not.toContain("SYNTHETIC-REGISTRATION-ID");
  });

  it.each([null, "doctor", "assistant"])("keeps the existing %s access gate before document reads", async (role) => {
    mocks.requireSession.mockResolvedValue(role ? { role, username: "synthetic", userId: 2 } : null);
    await expect(render()).rejects.toThrow();
    expect(mocks.getInvoice).not.toHaveBeenCalled();
    expect(mocks.getPatient).not.toHaveBeenCalled();
    expect(mocks.getSettingsSafe).not.toHaveBeenCalled();
    expect(mocks.printCount).not.toHaveBeenCalled();
  });
});
