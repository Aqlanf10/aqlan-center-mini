import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETTING_DEFAULTS } from "../lib/settings";
import { formatAmount, formatMoney, type Currency } from "../lib/money";
import { friendlyDateLong, friendlyTime } from "../lib/reminders";
import { POST_OP_TEMPLATES } from "../lib/post-op-care";
import { CONSENT_TEMPLATES } from "../lib/consent-templates";

const readers = vi.hoisted(() => ({ patient: vi.fn(), settings: vi.fn(), prescription: vi.fn(), referral: vi.fn(), appointment: vi.fn(), appointments: vi.fn(), expense: vi.fn(), document: vi.fn(), file: vi.fn(), contract: vi.fn(), addenda: vi.fn(), session: vi.fn(), access: vi.fn(), printCount: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSession: readers.session }));
vi.mock("@/lib/db", () => ({ CLINIC_TIME_ZONE: "Asia/Aden", getPatient: readers.patient, getSettingsSafe: readers.settings,
  getPrescription: readers.prescription, getReferral: readers.referral, getAppointment: readers.appointment,
  patientAppointmentsFrom: readers.appointments, getExpense: readers.expense, getDocumentForDownload: readers.document, printCount: readers.printCount }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: readers.access }));
vi.mock("@/lib/files", () => ({ readFileByKey: readers.file }));
vi.mock("@/lib/hr", () => ({ canManageStaff: (role: string) => role === "admin" }));
vi.mock("@/lib/hr-contracts-attendance", () => ({ getContractById: readers.contract, listContractAddenda: readers.addenda }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("synthetic-not-found"); } }));

import PrintLayout from "../app/print/layout";
import { PrintDocumentWatermark } from "../components/PrintDocument";
import PrescriptionPage from "../app/print/prescription/[id]/page";
import ReferralPage from "../app/print/referral/[id]/page";
import PostOpPage from "../app/print/post-op/[id]/page";
import ConsentPage from "../app/print/consent/[id]/page";
import ContractPage from "../app/print/hr/contracts/[id]/page";
import AppointmentCardPage from "../app/print/card/[id]/page";
import PatientCardPage from "../app/print/patient-card/[id]/page";
import VoucherPage from "../app/print/voucher/[id]/page";

const settings = { ...SETTING_DEFAULTS, "clinic.name": "مركز عقلان — نموذج صناعي فقط", "clinic.lead_doctor": "طبيب اختبار صناعي",
  "clinic.lead_doctor_title": "اختبار العرض", "clinic.lead_doctor_credentials": "", "clinic.phone": "000-000000", "clinic.address": "عنوان صناعي لفحص الطباعة" };
const patient = { id: 99001, fullName: "مريض صناعي طويل الاسم لفحص الطباعة فقط", patientNumber: "SYNTHETIC-NONTABLE-99001", phone: "000-111222",
  birthYear: 1990, birthDate: "1990-01-01", gender: "male", createdAt: "2030-12-04T10:00:00Z", medicalAlert: "SYNTHETIC-MEDICAL-ALERT-PRIVATE", balanceMinor: 987654321 };
const prescription = { id: 99002, patientId: patient.id, visitId: 99003, diagnosis: "تشخيص صناعي للاختبار فقط", notes: "ملاحظة وصفة صناعية محفوظة", instructionsLang: "both", status: "active", voidReason: null,
  createdBy: "طبيب الوصفة المحفوظ صناعي", createdAt: "2031-01-04T10:00:00Z", items: [
    { name: "SYNTHETIC-DRUG-A (NOT FOR USE)", dose: "TEST-DOSE", form: "Synthetic tablets", frequency: "SYNTHETIC FREQUENCY — NOT MEDICAL ADVICE", duration: "SYNTHETIC DURATION", instructions: "تعليمات عربية صناعية لا تستخدم للعلاج", instructionsEn: "Synthetic instructions, not for treatment" },
  ] };
const appointment = { id: 99004, patientId: patient.id, patientName: patient.fullName, scheduledDate: "2031-02-08", scheduledTime: "09:30", durationMinutes: 45,
  appointmentType: "consultation", status: "confirmed", note: "ملاحظة موعد صناعية" };
const referral = { id: 99005, patientId: patient.id, toName: "أخصائي صناعي", toSpecialty: "oral_surgery", urgency: "urgent", reason: "سبب إحالة صناعي محفوظ لفحص التفاف النص والطباعة", teeth: "16, 26", createdAt: "2031-01-04T10:00:00Z", doctorName: "طبيب الإحالة المحفوظ" };
const expense = { id: 99006, voucherNumber: "SYNTHETIC-VOUCHER-99006", category: "materials", partyName: "مورد صناعي فقط", payeeText: null,
  amountMinor: 123456, currency: "SAR", exchangeRate: 140, baseAmountMinor: 172838, baseCurrency: "YER", note: "ملاحظة سند صناعية", createdBy: "محاسب صناعي", createdAt: "2031-01-04T10:00:00Z" };
const contract = { id: 99007, staffId: 99008, staffName: "موظف صناعي للاختبار", contractNumber: "SYNTHETIC-CONTRACT-99007", title: "عقد صناعي", templateKind: "support_staff", status: "active",
  startDate: "2031-01-01", endDate: "2031-12-31", probationEndDate: "2031-03-01", compensationKind: "salary", salaryCurrency: "SAR", salaryPeriod: "monthly", baseSalaryMinor: 123456,
  commissionRatePercent: null, doctorPartyId: null, termsPayload: { jobDescription: "وظيفة صناعية", clauses: ["بند عقد صناعي محفوظ أول", "بند عقد صناعي محفوظ ثانٍ"], workingHoursSummary: "ساعات عمل صناعية" }, notes: null, signedByStaff: false, signedByCenter: false };
const consentRecord = { templateId: "SYNTHETIC-HISTORICAL-TEMPLATE", title: "عنوان إقرار صناعي محفوظ", procedureName: "إجراء صناعي محفوظ", signatoryName: "موقّع صناعي لا يمثل شخصًا حقيقيًا", signatoryRelation: "guardian", guardianRelation: "صفة صناعية",
  terms: ["SYNTHETIC-SAVED-TERM-ONE", "شرط صناعي محفوظ لا يستبدل بقالب اليوم"], risks: ["SYNTHETIC-SAVED-RISK"], postOpInstructions: ["SYNTHETIC-SAVED-CARE"] };
const signedDocument = { storageKey: "synthetic-signature-only.svg", document: { id: 99011, patientId: patient.id, kind: "consent", removedAt: null, isImage: true,
  note: JSON.stringify(consentRecord), takenOn: "2030-12-20", uploadedBy: "مسجل صناعي", uploadedAt: "2031-01-04T10:00:00Z" } };
const params = (id = patient.id) => Promise.resolve({ id: String(id) });
const render = (node: ReactNode) => {
  const html = renderToStaticMarkup(<><PrintDocumentWatermark /><PrintLayout>{node}</PrintLayout></>);
  expect(html.match(/class="print-document-watermark"/g)).toHaveLength(1);
  return html;
};
const reset = `*,::before,::after{box-sizing:border-box;border-width:0;border-style:solid}html{line-height:1.5}body,p,h1,h2,h3,ol,ul{margin:0}ol,ul{padding:0;list-style:none}h1,h2,h3{font-size:inherit;font-weight:inherit}img{display:block;max-width:100%;height:auto}.object-contain{object-fit:contain}.h-9{height:2.25rem}.w-9{width:2.25rem}.print\\:hidden{display:none}`;
/** Synthetic artifacts are render inputs only. They do not claim browser proof,
 * access real files, or rewrite the archived consent/signature endpoint. */
function artifact(name: string, markup: string, paper: "A4" | "A5" | "A6") {
  if (!process.env.PRINT_RENDER_OUTPUT) return;
  const output = resolve(process.env.PRINT_RENDER_OUTPUT); mkdirSync(output, { recursive: true });
  const tailwind = process.env.PRINT_RENDER_TAILWIND_CSS ? readFileSync(resolve(process.env.PRINT_RENDER_TAILWIND_CSS), "utf8") : reset;
  const css = tailwind + readFileSync(resolve("components/print-document.css"), "utf8") + readFileSync(resolve("app/print/print.css"), "utf8") + `@page { size: ${paper}; }`;
  const logo = `data:image/png;base64,${readFileSync(resolve("public/logo.png")).toString("base64")}`;
  const syntheticSignature = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="520" height="70"><rect width="520" height="70" fill="white"/><text x="10" y="42" font-size="20" fill="#334155">SYNTHETIC SIGNATURE PLACEHOLDER — NOT REAL</text></svg>').toString("base64")}`;
  const body = markup.replaceAll('src="/logo.png"', `src="${logo}"`).replaceAll('href="/logo.png"', `href="${logo}"`).replaceAll('src="/api/documents/99011"', `src="${syntheticSignature}"`);
  writeFileSync(resolve(output, `${name}.html`), `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>Synthetic non-table print evidence</title><style>${css}</style></head><body>${body}</body></html>`);
}

beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date("2031-01-05T10:00:00Z"));
  readers.session.mockResolvedValue({ role: "admin", username: "synthetic-session", userId: 99099 }); readers.access.mockResolvedValue(true);
  readers.settings.mockResolvedValue(settings); readers.patient.mockResolvedValue(patient); readers.prescription.mockResolvedValue(prescription);
  readers.referral.mockResolvedValue(referral); readers.appointment.mockResolvedValue(appointment); readers.appointments.mockResolvedValue([appointment]);
  readers.expense.mockResolvedValue(expense); readers.printCount.mockResolvedValue(1); readers.contract.mockResolvedValue(contract);
  readers.addenda.mockResolvedValue([{ id: 99009, title: "ملحق صناعي محفوظ", contractNumber: "SYNTHETIC-ADDENDUM", startDate: "2031-02-01", addendumReason: "سبب ملحق صناعي محفوظ" }]);
  readers.document.mockResolvedValue(signedDocument); readers.file.mockResolvedValue(Buffer.from("synthetic signature file exists"));
});
afterEach(() => { vi.useRealTimers(); });

describe("actual non-table print routes retain source semantics (synthetic SSR)", () => {
  it.each(["active", "void"])("saved %s prescription preserves source items, medical alert, language and clinician", async status => {
    const source = { ...prescription, status, voidReason: status === "void" ? "سبب إبطال صناعي محفوظ" : null };
    readers.prescription.mockResolvedValue(source); const before = structuredClone(source);
    const html = render(await PrescriptionPage({ params: params(), searchParams: Promise.resolve({ rx: "99002", diagnosis: "UNTRUSTED-OVERRIDE", notes: "UNTRUSTED-NOTES", lang: "ar" }) }));
    for (const text of [patient.medicalAlert, source.diagnosis, source.notes, source.createdBy, ...Object.values(source.items[0])]) expect(html).toContain(text);
    expect(html).not.toContain("UNTRUSTED-OVERRIDE"); expect(html).not.toContain("UNTRUSTED-NOTES"); expect(html).toContain("Signature &amp; Stamp");
    if (status === "void") expect(html).toContain("VOIDED"); else expect(html).not.toContain("UNAPPROVED DRAFT");
    expect(source).toEqual(before); artifact(`prescription-${status}`, html, "A5");
  });
  it("long saved prescription retains all 20 instructions across natural page breaks", async () => {
    const source = { ...prescription, items: Array.from({ length: 20 }, (_, index) => ({ ...prescription.items[0], name: `SYNTHETIC-DRUG-${String(index + 1).padStart(2, "0")} (NOT FOR USE)`, instructions: `تعليمات عربية صناعية طويلة لفحص التفاف النص وترقيم الصفحات فقط، لا تستخدم للعلاج — بند ${index + 1}` })) };
    readers.prescription.mockResolvedValue(source); const before = structuredClone(source);
    const html = render(await PrescriptionPage({ params: params(), searchParams: Promise.resolve({ rx: "99002" }) }));
    for (const item of source.items) { expect(html).toContain(item.name); expect(html).toContain(item.instructions); }
    expect(source).toEqual(before); artifact("prescription-long-20", html, "A5");
  });
  it("draft prescription remains explicitly unapproved, with no stored clinician invented", async () => {
    readers.prescription.mockResolvedValue(null);
    const html = render(await PrescriptionPage({ params: params(), searchParams: Promise.resolve({ draft: "1", items: JSON.stringify(prescription.items), diagnosis: "تشخيص مسودة صناعي", date: "2031-01-04", lang: "en" }) }));
    expect(html).toContain("UNAPPROVED DRAFT"); expect(html).toContain(prescription.items[0].instructionsEn); expect(html).not.toContain(prescription.items[0].instructions);
    expect(html).toContain("synthetic-session"); expect(html).not.toContain(prescription.createdBy); artifact("prescription-draft", html, "A5");
  });
  it("referral preserves reason, FDI, alert, urgency and recorded physician signature block", async () => {
    const before = structuredClone(referral); const html = render(await ReferralPage({ params: params(referral.id) }));
    for (const value of [referral.reason, referral.teeth, referral.doctorName, referral.toName, patient.medicalAlert, "التوقيع والختم", "الاستعجال"]) expect(html).toContain(value);
    expect(referral).toEqual(before); artifact("referral", html, "A5");
  });
  it("post-op handout retains existing printed sections, warnings and free note", async () => {
    const template = POST_OP_TEMPLATES[0], before = structuredClone(template);
    const html = render(await PostOpPage({ params: params(), searchParams: Promise.resolve({ templateId: template.id, notes: "ملاحظة عناية صناعية محفوظة للعرض", date: "2031-01-04" }) }));
    for (const text of [template.title, ...template.first24Hours, ...template.diet.allowed, ...template.diet.avoid, ...template.hygiene, ...template.medications, ...template.emergencyWarnings, "ملاحظة عناية صناعية محفوظة للعرض"]) expect(html).toContain(text);
    expect(template).toEqual(before); artifact("post-op", html, "A5");
  });
  it("blank consent keeps unsigned warning and empty signature fields, never query-supplied signatory", async () => {
    const template = CONSENT_TEMPLATES[0], before = structuredClone(template);
    const html = render(await ConsentPage({ params: params(), searchParams: Promise.resolve({ templateId: template.id, signatoryName: "UNTRUSTED-SIGNATORY", doctorName: "UNTRUSTED-DOCTOR" }) }));
    expect(html).toContain('data-consent-mode="blank"'); expect(html).toContain("نموذج غير موقّع"); expect(html).not.toContain("data-signature-img");
    expect(html).not.toContain("UNTRUSTED-SIGNATORY"); expect(html).not.toContain("UNTRUSTED-DOCTOR");
    for (const text of [...template.terms, ...template.risks, ...template.postOpInstructions]) expect(html).toContain(text);
    expect(readers.document).not.toHaveBeenCalled(); expect(readers.file).not.toHaveBeenCalled(); expect(template).toEqual(before); artifact("consent-blank", html, "A4");
  });
  it("signed consent preserves snapshot, protected signature endpoint and actual signing date immutably", async () => {
    const before = structuredClone(signedDocument); const html = render(await ConsentPage({ params: params(), searchParams: Promise.resolve({ docId: "99011" }) }));
    expect(html).toContain('data-consent-mode="signed"'); expect(html).toContain('data-signature-img="true" src="/api/documents/99011"');
    for (const text of [consentRecord.title, consentRecord.templateId, consentRecord.signatoryName, ...consentRecord.terms, ...consentRecord.risks, ...consentRecord.postOpInstructions, friendlyDateLong("2030-12-20")]) expect(html).toContain(text);
    expect(html).toContain("لا تحمل توقيعًا جديدًا ولا تغيّر الأصل"); expect(readers.access).toHaveBeenCalledWith(expect.anything(), patient.id, "canViewXrays");
    expect(readers.file).toHaveBeenCalledWith("synthetic-signature-only.svg"); expect(signedDocument).toEqual(before); artifact("consent-signed", html, "A4");
  });
  it("long stored consent keeps every archived term and the single protected signature reference", async () => {
    const record = { ...consentRecord, terms: Array.from({ length: 24 }, (_, index) => `SYNTHETIC-CONSENT-TERM-${String(index + 1).padStart(2, "0")} — شرط صناعي محفوظ طويل للتحقق من الطباعة على عدة صفحات دون اختصار أو استبدال النص الأصلي.`) };
    const source = { ...signedDocument, document: { ...signedDocument.document, note: JSON.stringify(record) } };
    readers.document.mockResolvedValue(source); const before = structuredClone(source);
    const html = render(await ConsentPage({ params: params(), searchParams: Promise.resolve({ docId: "99011" }) }));
    for (const term of record.terms) expect(html).toContain(term);
    expect(html.match(/data-signature-img="true"/g)).toHaveLength(1); expect(source).toEqual(before); artifact("consent-signed-long-24", html, "A4");
  });
  it("signed consent with a query override is refused instead of reusing a stored signature", async () => {
    const html = render(await ConsentPage({ params: params(), searchParams: Promise.resolve({ docId: "99011", signatoryName: "UNTRUSTED-SIGNATORY" }) }));
    expect(html).toContain('data-consent-mode="refused"'); expect(html).not.toContain("data-signature-img"); expect(readers.document).not.toHaveBeenCalled(); expect(readers.file).not.toHaveBeenCalled(); artifact("consent-refused", html, "A4");
  });
  it.each<Currency>(["YER", "SAR", "USD"])("HR salary preserves %s amounts, clauses and addenda without inventing signatures", async salaryCurrency => {
    const source = { ...contract, salaryCurrency }; const before = structuredClone(source); readers.contract.mockResolvedValue(source);
    const html = render(await ContractPage({ params: params(contract.id) }));
    for (const value of [source.staffName, source.contractNumber, ...source.termsPayload.clauses, formatAmount(source.baseSalaryMinor, salaryCurrency), "SYNTHETIC-ADDENDUM", "سبب ملحق صناعي محفوظ", "توقيع وختم الطرف الأول", "توقيع الطرف الثاني"]) expect(html).toContain(value);
    expect(html).not.toContain("data-signature-img"); expect(source).toEqual(before); artifact(`hr-contract-${salaryCurrency}`, html, "A4");
  });
  it("HR draft remains a draft and role denial never reads private contracts", async () => {
    readers.contract.mockResolvedValue({ ...contract, status: "draft" });
    const html = render(await ContractPage({ params: params(contract.id) })); expect(html).toContain("مسودة عقد عمل غير معتمدة"); artifact("hr-contract-draft", html, "A4");
    readers.contract.mockClear(); readers.session.mockResolvedValue({ role: "doctor" });
    expect(render(await ContractPage({ params: params(contract.id) }))).toContain("طباعة العقود للمدير وحده"); expect(readers.contract).not.toHaveBeenCalled();
  });
  it("appointment card keeps exact date/time, duration, notes and stamp field", async () => {
    const before = structuredClone(appointment); const html = render(await AppointmentCardPage({ params: params(appointment.id) }));
    for (const text of [patient.patientNumber, appointment.patientName, friendlyDateLong(appointment.scheduledDate), friendlyTime(appointment.scheduledTime), appointment.note, "45", "الختم:"]) expect(html).toContain(text);
    expect(appointment).toEqual(before); artifact("appointment-card", html, "A6");
  });
  it("patient card keeps upcoming visits but excludes diagnosis, balance and private medical alerts", async () => {
    readers.appointments.mockResolvedValue([appointment, { ...appointment, id: 99901, status: "cancelled", scheduledDate: "2031-03-09" }, { ...appointment, id: 99902, status: "no_show", scheduledDate: "2031-04-10" }]);
    const before = structuredClone(patient); const html = render(await PatientCardPage({ params: params() }));
    for (const text of [patient.patientNumber, patient.phone, patient.fullName, friendlyDateLong(appointment.scheduledDate), "طُبعت في"]) expect(html).toContain(text);
    for (const text of [patient.medicalAlert, String(patient.balanceMinor), prescription.diagnosis, friendlyDateLong("2031-03-09"), friendlyDateLong("2031-04-10"), 'href="/portal', "reprint-mark"]) expect(html).not.toContain(text);
    expect(patient).toEqual(before); artifact("patient-card", html, "A6");
  });
  it("voucher keeps source currency, original exchange/equivalent, reprint warning and recipient signature", async () => {
    const before = structuredClone(expense); const html = render(await VoucherPage({ params: params(expense.id) }));
    for (const text of [expense.voucherNumber, expense.partyName, expense.note, formatMoney(expense.amountMinor, "SAR"), formatMoney(expense.baseAmountMinor, "YER"), "140", "المستلم:", "reprint-mark-on", "مرفقات السند"]) expect(html).toContain(text);
    expect(html).toContain('class="sheet sheet-a6"'); expect(expense).toEqual(before); artifact("voucher", html, "A6");
  });
  it("clinical and financial access still fail before exposing source content", async () => {
    readers.access.mockResolvedValue(false);
    await expect(ReferralPage({ params: params(referral.id) })).rejects.toThrow("synthetic-not-found");
    await expect(PatientCardPage({ params: params() })).rejects.toThrow("synthetic-not-found");
    readers.session.mockResolvedValue({ role: "doctor" }); readers.expense.mockClear();
    await expect(VoucherPage({ params: params(expense.id) })).rejects.toThrow("synthetic-not-found"); expect(readers.expense).not.toHaveBeenCalled();
  });
});
