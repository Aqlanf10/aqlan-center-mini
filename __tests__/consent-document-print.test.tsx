import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as templates from "../lib/consent-templates";
import { CONSENT_ACKNOWLEDGEMENT, CONSENT_NOTE_MAX_BYTES, createConsentDocumentMetadata, parseStoredConsentDocumentMetadata } from "../lib/consent-document";
import { longConsentPrintFixture } from "./fixtures/consent-print-long";
const mocks = vi.hoisted(() => ({ session: vi.fn(), access: vi.fn(), patient: vi.fn(), settings: vi.fn(), document: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: mocks.access }));
vi.mock("@/lib/db", () => ({ getPatient: mocks.patient, getSettingsSafe: mocks.settings, getDocumentForDownload: mocks.document }));
vi.mock("@/components/PrintHeader", () => ({ PrintHeader: ({ title }: { title: string }) => createElement("h1", null, title), PrintFooter: () => null }));
vi.mock("@/components/PrintButton", () => ({ PrintButton: () => null }));
import ConsentPrintPage from "../app/print/consent/[id]/page";

const context = { patientId: 91, visitId: null, orthoCaseId: null, adjustmentId: null, takenOn: "2026-10-03" };
function metadata() {
  const result = createConsentDocumentMetadata({ ...context, patientName: "Recorded patient name", templateId: "root_canal", signatoryName: "Recorded guardian",
    signatoryRelation: "guardian", guardianRelation: "Recorded guardian relation" });
  if (!result.ok) throw new Error(result.message);
  return result;
}
function document(extra: Record<string, unknown> = {}) {
  return { ...context, id: 801, kind: "consent", mimeType: "image/png", removedAt: null, note: metadata().note, ...extra };
}
function run(query: Record<string, string | string[] | undefined> = { docId: "801" }, id = "91") {
  return ConsentPrintPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(query) });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ role: "doctor", username: "Current viewer is not treating doctor" });
  mocks.access.mockResolvedValue(true); mocks.settings.mockResolvedValue({});
  mocks.patient.mockResolvedValue({ id: 91, fullName: "Current patient name", patientNumber: "SYN-91", birthYear: 1985, gender: "male", medicalAlert: "Current allergy differs from historical record" });
  mocks.document.mockResolvedValue({ document: document(), storageKey: "not-rendered" });
});
afterEach(() => vi.restoreAllMocks());

describe("saved consent print integrity", () => {
  it("keeps near-limit historical content with a native repeating identity header and an unsplit signer block", async () => {
    const fixture = longConsentPrintFixture();
    const size = new TextEncoder().encode(fixture.note).byteLength;
    expect(size).toBeGreaterThan(CONSENT_NOTE_MAX_BYTES - 250);
    expect(size).toBeLessThan(CONSENT_NOTE_MAX_BYTES);
    expect(parseStoredConsentDocumentMetadata(fixture.note, context).ok).toBe(true);
    mocks.document.mockResolvedValue({ document: document({ note: fixture.note }) });
    const html = renderToStaticMarkup(await run());
    expect(html).toContain('class="consent-pagination"');
    expect(html).toContain("display: table-header-group");
    expect(html).toContain(".consent-signatures { break-inside: avoid; page-break-inside: avoid; }");
    expect(html).toContain("counter(page)"); expect(html).toContain("counter(pages)");
    const header = html.match(/<thead>([\s\S]*?)<\/thead>/)?.[1] ?? "";
    expect(header).toContain("معرّف المريض الداخلي: #91");
    expect(header).not.toContain("ملف #91");
    for (const value of ["SYNTHETIC-CONSENT-PATIENT", "#91", "#801", "SYNTHETIC-PROCEDURE-801", "2026-10-03"]) expect(header).toContain(value);
    for (const marker of fixture.markers) expect(html.split(marker)).toHaveLength(2);
    expect(html.indexOf('class="consent-signatures"')).toBeLessThan(html.indexOf("SYNTHETIC-SIGNATORY-801"));
    expect(html.indexOf("SYNTHETIC-SIGNATORY-801")).toBeLessThan(html.indexOf('src="/api/documents/801"'));
    expect(html).toContain(fixture.metadata.content.acknowledgement);
    // SSR proves the structure and full text, not actual paper pagination.
  });
  it("uses only the stored identity, text and date, ignoring all signed-content query overrides", async () => {
    const html = renderToStaticMarkup(await run({ docId: "801", templateId: "surgical_extraction", signatoryName: "Wrong signatory",
      signatoryRelation: "self", guardianRelation: "Wrong relationship", doctorName: "Wrong doctor", date: "1999-01-01" }));
    const snapshot = metadata().metadata;
    expect(html).toContain("Recorded patient name"); expect(html).toContain("Recorded guardian"); expect(html).toContain("Recorded guardian relation");
    expect(html).toContain(snapshot.content.title); expect(html).toContain(snapshot.content.summary); expect(html).toContain(CONSENT_ACKNOWLEDGEMENT);
    for (const term of [...snapshot.content.terms, ...snapshot.content.risks]) expect(html).toContain(term);
    expect(html).toContain('src="/api/documents/801"'); expect(html).toContain("نسخة من نص الإقرار المحفوظ");
    for (const wrong of ["Wrong signatory", "Wrong relationship", "Wrong doctor", "1999", "surgical_extraction", "Current viewer is not treating doctor", "Current allergy differs"]) expect(html).not.toContain(wrong);
    expect(html).not.toContain(templates.getConsentTemplate("root_canal")!.postOpInstructions[0]);
    expect(html).toContain("بيانات الملف الحالية"); expect(html).not.toContain("not-rendered");
  });
  it("keeps the actual saved snapshot after current template text changes", async () => {
    const original = metadata().metadata;
    vi.spyOn(templates, "getConsentTemplate").mockReturnValue({ ...templates.CONSENT_TEMPLATES[0], summary: "Changed server template content" });
    const html = renderToStaticMarkup(await run());
    expect(html).toContain(original.content.summary); expect(html).not.toContain("Changed server template content");
    expect(html).toContain('src="/api/documents/801"');
  });
  it("keeps the actual saved snapshot after template retirement", async () => {
    const original = metadata().metadata;
    vi.spyOn(templates, "getConsentTemplate").mockReturnValue(null);
    const html = renderToStaticMarkup(await run());
    expect(html).toContain(original.content.title); expect(html).toContain('src="/api/documents/801"');
  });
  it.each([null, "Ordinary scanned original", '{"templateId":"root_canal",', JSON.stringify({ templateId: "root_canal", signatoryName: "Old signatory", signatoryRelation: "self" })])(
    "discloses incomplete/unversioned original without defaulting to surgery or showing a signature (%s)", async (note) => {
      mocks.document.mockResolvedValue({ document: document({ note }) });
      const html = renderToStaticMarkup(await run({ docId: "801", templateId: "surgical_extraction", signatoryName: "Injected signer" }));
      expect(html).toContain("بيانات الإقرار غير مكتملة أو غير قابلة للتحقق"); expect(html).toContain('href="/api/documents/801"');
      expect(html).not.toContain("<img"); expect(html).not.toContain("surgical_extraction"); expect(html).not.toContain("Injected signer");
      expect(html).not.toContain(CONSENT_ACKNOWLEDGEMENT);
    });
  it.each(["patientId", "visitId", "orthoCaseId", "adjustmentId", "takenOn"])("never replays metadata with mismatched %s", async (key) => {
    const value = metadata().metadata;
    mocks.document.mockResolvedValue({ document: document({ note: JSON.stringify({ ...value, [key]: key === "takenOn" ? "2026-10-04" : 92 }) }) });
    const html = renderToStaticMarkup(await run());
    expect(html).toContain("غير قابلة للتحقق"); expect(html).not.toContain("<img");
  });
  it.each([{ patientId: 92 }, { kind: "xray" }, { removedAt: "2026-10-03T09:00:00Z" }, { id: 802 }])("rejects a wrong/removed document %j instead of falling back", async (extra) => {
    mocks.document.mockResolvedValue({ document: document(extra) });
    await expect(run()).rejects.toThrow();
  });
  it.each(["", "bad", "1.5", "-1", "801e0", "2147483648", ["801", "802"]])("rejects malformed document ID %j", async (docId) => {
    await expect(run({ docId })).rejects.toThrow(); expect(mocks.document).not.toHaveBeenCalled();
  });
  it("rejects missing or unavailable records without producing an unsigned fallback", async () => {
    mocks.document.mockResolvedValue(null); await expect(run()).rejects.toThrow();
    mocks.document.mockRejectedValue(new Error("Unavailable")); await expect(run()).rejects.toThrow();
  });
  it("checks saved-document read permission before patient/document reads even when patient access is allowed", async () => {
    mocks.access.mockImplementation(async (_session, _id, permission) => permission !== "canViewXrays");
    await expect(run()).rejects.toThrow();
    expect(mocks.access).toHaveBeenCalledWith(expect.any(Object), 91, "canViewXrays");
    expect(mocks.document).not.toHaveBeenCalled(); expect(mocks.patient).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(await run({ templateId: "root_canal" }))).toContain("مسودة غير موقّعة");
  });
  it("does not read records without an authenticated session", async () => {
    mocks.session.mockResolvedValue(null); await expect(run()).rejects.toThrow();
    expect(mocks.access).not.toHaveBeenCalled(); expect(mocks.document).not.toHaveBeenCalled();
  });
  it("renders unsigned previews with clear draft semantics and no saved signature", async () => {
    const html = renderToStaticMarkup(await run({ templateId: "root_canal", signatoryName: "Draft adult", date: "2026-10-03" }));
    expect(html).toContain("مسودة غير موقّعة"); expect(html).toContain("Draft adult"); expect(html).not.toContain("<img");
    expect(mocks.document).not.toHaveBeenCalled();
    await expect(run({ templateId: "unknown" })).rejects.toThrow();
  });
});
