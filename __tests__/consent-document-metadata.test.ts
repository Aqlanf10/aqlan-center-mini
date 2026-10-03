import { afterEach, describe, expect, it, vi } from "vitest";
import { CONSENT_TEMPLATES } from "../lib/consent-templates";
import * as templates from "../lib/consent-templates";
import { CONSENT_ACKNOWLEDGEMENT, CONSENT_NOTE_MAX_BYTES, createConsentDocumentMetadata,
  isConsentDate, parseStoredConsentDocumentMetadata, validateConsentUploadNote } from "../lib/consent-document";

const context = { patientId: 91, visitId: null, orthoCaseId: null, adjustmentId: null, takenOn: "2026-10-03" };
const input = { ...context, patientName: "Synthetic patient at signing", templateId: "root_canal", signatoryName: "Synthetic adult", signatoryRelation: "self" as const, guardianRelation: null };
function build(extra: Partial<Parameters<typeof createConsentDocumentMetadata>[0]> = {}) {
  const result = createConsentDocumentMetadata({ ...input, ...extra });
  if (!result.ok) throw new Error(result.message);
  return result;
}
afterEach(() => vi.restoreAllMocks());

describe("bounded consent metadata in the existing note", () => {
  it.each(CONSENT_TEMPLATES.map((template) => template.id))("roundtrips all displayed %s text beyond the former 300-character limit", (templateId) => {
    const result = build({ templateId, signatoryName: "س".repeat(200), signatoryRelation: "guardian", guardianRelation: "ق".repeat(120) });
    expect(result.note.length).toBeGreaterThan(300);
    expect(new TextEncoder().encode(result.note).byteLength).toBeLessThanOrEqual(CONSENT_NOTE_MAX_BYTES);
    expect(parseStoredConsentDocumentMetadata(result.note, context)).toEqual(result);
    expect(validateConsentUploadNote(result.note, context)).toEqual({ ok: true, note: result.note, generated: true });
    expect(result.metadata.content.acknowledgement).toBe(CONSENT_ACKNOWLEDGEMENT);
    expect(result.metadata.content).not.toHaveProperty("postOpInstructions");
    expect(result.metadata.content.terms).toEqual(templates.getConsentTemplate(templateId)!.terms);
  });
  it.each([
    { templateId: "unknown" }, { signatoryName: "" }, { signatoryName: "x".repeat(201) },
    { signatoryRelation: "guardian" as const }, { guardianRelation: "parent" },
    { signatoryRelation: "guardian" as const, guardianRelation: "x".repeat(121) },
    { patientId: 0 }, { visitId: -1 }, { adjustmentId: 2147483648 }, { takenOn: "2026-02-30" },
  ])("rejects invalid new metadata %j", (extra) => {
    expect(createConsentDocumentMetadata({ ...input, ...extra }).ok).toBe(false);
  });
  it.each(["patientId", "visitId", "orthoCaseId", "adjustmentId", "takenOn"] as const)("binds exact saved %s without inferred associations", (key) => {
    const { note } = build();
    const wrong = { ...context, [key]: key === "takenOn" ? "2026-10-04" : 92 };
    expect(parseStoredConsentDocumentMetadata(note, wrong).ok).toBe(false);
    expect(validateConsentUploadNote(note, wrong)).toMatchObject({ ok: false, status: 400 });
  });
  it("preserves stored content after server template changes and rejects stale new submissions", () => {
    const original = build();
    const current = templates.getConsentTemplate(input.templateId)!;
    vi.spyOn(templates, "getConsentTemplate").mockReturnValue({ ...current, terms: ["New clinical terms"] });
    expect(parseStoredConsentDocumentMetadata(original.note, context)).toEqual(original);
    expect(validateConsentUploadNote(original.note, context)).toMatchObject({ ok: false, status: 409 });
  });
  it("preserves a valid snapshot after template retirement but rejects a new upload", () => {
    const original = build();
    vi.spyOn(templates, "getConsentTemplate").mockReturnValue(null);
    expect(parseStoredConsentDocumentMetadata(original.note, context)).toEqual(original);
    expect(validateConsentUploadNote(original.note, context)).toMatchObject({ ok: false, status: 400 });
  });
  it("does not regenerate a snapshot for historical JSON or externally scanned originals", () => {
    for (const note of ["", "Scanned original consent", JSON.stringify({ templateId: "root_canal", signatoryName: "Historical adult", signatoryRelation: "self" })]) {
      expect(validateConsentUploadNote(note, context)).toEqual({ ok: true, note: note || null, generated: false });
      expect(parseStoredConsentDocumentMetadata(note, context).ok).toBe(false);
    }
  });
  it("rejects broken or unsupported generated claims rather than relabeling them as legacy", () => {
    const good = build();
    const candidates = [good.note.slice(0, 300), JSON.stringify({ ...good.metadata, schemaVersion: 2 }),
      JSON.stringify({ ...good.metadata, content: undefined }), JSON.stringify({ ...good.metadata, extra: "hidden" }),
      JSON.stringify({ ...good.metadata, content: { ...good.metadata.content, terms: [] } }),
      JSON.stringify({ ...good.metadata, signatoryName: { unexpected: "object" } })];
    for (const note of candidates) expect(validateConsentUploadNote(note, context)).toMatchObject({ ok: false, status: 400 });
  });
  it("bounds UTF-8 bytes without silently truncating a consent note", () => {
    expect(validateConsentUploadNote("س".repeat(CONSENT_NOTE_MAX_BYTES / 2), context).ok).toBe(true);
    expect(validateConsentUploadNote("س".repeat(CONSENT_NOTE_MAX_BYTES / 2 + 1), context)).toMatchObject({ ok: false, status: 400 });
  });
  it.each(["patientName", "signatoryName", "guardianRelation"] as const)("requires visible identity content in %s without rewriting Arabic", (key) => {
    const valid = build({ signatoryRelation: "guardian", guardianRelation: "وصي" });
    for (const value of ["\u200b", "\u200c\u200d", "\u2060", "\u061c", "\u3164", "\u0301\u064e", "...", "اسم\u0000", "اسم\nآخر", "اسم\u202eآخر"]) {
      const note = JSON.stringify({ ...valid.metadata, [key]: value });
      expect(parseStoredConsentDocumentMetadata(note, context).ok, `${key}: ${JSON.stringify(value)}`).toBe(false);
      expect(validateConsentUploadNote(note, context)).toMatchObject({ ok: false, status: 400 });
    }
    const arabic = "مُحَمَّد عبد\u200cالله";
    const preserved = build({ signatoryRelation: "guardian", guardianRelation: "وصي", [key]: arabic });
    expect(preserved.metadata[key]).toBe(arabic);
    expect(parseStoredConsentDocumentMetadata(preserved.note, context)).toEqual(preserved);
  });
  it("rejects prototype-shaped fields and extra keys without coercion or prototype pollution", () => {
    const valid = build();
    const candidates = [
      { ...valid.metadata, patientName: { toString: "Synthetic patient" } },
      { ...valid.metadata, signatoryName: { constructor: { prototype: { name: "Synthetic adult" } } } },
      { ...valid.metadata, signatoryRelation: "guardian", guardianRelation: { value: "parent" } },
      { ...valid.metadata, content: { ...valid.metadata.content, constructor: "unexpected" } },
    ];
    const notes = candidates.map((value) => JSON.stringify(value));
    notes.push(valid.note.replace('"schemaVersion":1', '"schemaVersion":1,"__proto__":{"polluted":true}'));
    for (const note of notes) {
      expect(parseStoredConsentDocumentMetadata(note, context).ok).toBe(false);
      expect(validateConsentUploadNote(note, context)).toMatchObject({ ok: false, status: 400 });
    }
    expect(Object.prototype).not.toHaveProperty("polluted");
  });
  it("validates actual dates including leap days", () => {
    expect(isConsentDate("2024-02-29")).toBe(true);
    for (const date of ["2026-02-29", "0000-01-01", "2026-13-01", "2026-1-01", ["2026-10-03"]]) expect(isConsentDate(date)).toBe(false);
  });
});
