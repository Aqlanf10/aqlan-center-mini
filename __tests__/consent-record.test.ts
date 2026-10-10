import { describe, expect, it } from "vitest";
import { CONSENT_TEMPLATES, getConsentTemplate } from "../lib/consent-templates";
import { DOCUMENT_NOTE_LIMIT, buildConsentNotePayload, parseStoredConsent } from "../lib/consent-record";

/**
 * سجل الإقرار المحفوظ: قراءة صارمة، ونصٌّ ناقص يبقى ناقصًا — وحمولة شاشة التوقيع الفعلية أمام حدّ ملاحظة المستند.
 * بيانات اصطناعية فقط.
 */
const identity = { templateId: "root_canal", signatoryName: "موقّع اصطناعي", signatoryRelation: "self" };
const parse = (extra: Record<string, unknown>) => parseStoredConsent(JSON.stringify({ ...identity, ...extra }));

describe("stored consent reader", () => {
  it("refuses a record without its identity, or one that is not JSON", () => {
    expect(parseStoredConsent(null)).toBeNull();
    expect(parseStoredConsent("ليس JSON")).toBeNull();
    expect(parseStoredConsent(JSON.stringify({ ...identity, signatoryName: " " }))).toBeNull();
    expect(parseStoredConsent(JSON.stringify({ ...identity, signatoryRelation: "other" }))).toBeNull();
  });

  it("has no snapshot when no text section was stored (current records)", () => {
    expect(parse({})?.snapshot).toBeNull();
  });

  it("is complete only when terms are non-empty and every section was stored", () => {
    expect(parse({ terms: ["بند"], risks: [], postOpInstructions: [] })?.snapshot?.complete).toBe(true);
    expect(parse({ terms: ["بند"], risks: ["خطر"], postOpInstructions: ["عناية"] })?.snapshot).toMatchObject({
      complete: true, terms: { state: "stored", items: ["بند"] },
    });
  });

  it("keeps missing, malformed, empty and blank sections explicitly partial — never filled with []", () => {
    expect(parse({ terms: ["بند"] })?.snapshot).toMatchObject({
      complete: false, risks: { state: "missing" }, postOpInstructions: { state: "missing" },
    });
    expect(parse({ terms: ["بند"], risks: "خطر", postOpInstructions: [1] })?.snapshot).toMatchObject({
      complete: false, risks: { state: "malformed" }, postOpInstructions: { state: "malformed" },
    });
    expect(parse({ terms: [], risks: [], postOpInstructions: [] })?.snapshot?.complete).toBe(false);
    expect(parse({ terms: ["  "], risks: [], postOpInstructions: [] })?.snapshot?.complete).toBe(false);
    expect(parse({ risks: ["خطر"] })?.snapshot).toMatchObject({ complete: false, terms: { state: "missing" } });
  });
});

describe("the payload the signature screen actually saves", () => {
  const payload = (templateId: string, name: string, relation: "self" | "guardian", guardian: string | null) =>
    JSON.stringify(buildConsentNotePayload({ template: getConsentTemplate(templateId)!, signatoryName: name, signatoryRelation: relation,
      guardianRelation: guardian }));

  it("round-trips through the strict reader when it fits the document note limit", () => {
    for (const template of CONSENT_TEMPLATES) {
      const note = payload(template.id, "سعد", "self", null);
      if (note.length <= DOCUMENT_NOTE_LIMIT) {
        expect(parseStoredConsent(note)).toMatchObject({ templateId: template.id, signatoryName: "سعد", snapshot: null });
      }
    }
  });

  /*
   * Known capture defect (tracked, not fixed here): the upload route keeps only the first 300 characters of the note
   * (`rawNote.slice(0, 300)`). An ordinary payload can exceed it, the stored JSON is cut, and the strict reader then —
   * correctly — refuses to print a signed copy. The reader stays fail-closed; the capture repair is a separate change.
   */
  it("an ordinary surgical extraction payload exceeds the limit, and its truncated note is refused rather than half-read", () => {
    const note = payload("surgical_extraction", "أحمد علي", "self", null);
    expect(note.length).toBeGreaterThan(DOCUMENT_NOTE_LIMIT);
    expect(parseStoredConsent(note.slice(0, DOCUMENT_NOTE_LIMIT))).toBeNull();
  });

  it("states which current templates can be cut for a short self signatory and a guardian", () => {
    const over = CONSENT_TEMPLATES.flatMap((template) => [
      payload(template.id, "أحمد علي", "self", null), payload(template.id, "أحمد علي", "guardian", "الأب"),
    ].filter((note) => note.length > DOCUMENT_NOTE_LIMIT).map(() => template.id));
    expect(over.length).toBeGreaterThan(0);
    for (const id of over) {
      expect(parseStoredConsent(payload(id, "أحمد علي", "guardian", "الأب").slice(0, DOCUMENT_NOTE_LIMIT))).toBeNull();
    }
  });
});
