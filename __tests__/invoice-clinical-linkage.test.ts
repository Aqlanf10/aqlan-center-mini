import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INVOICE_LINKAGE_SQL } from "../lib/invoice-linkage-schema";
import {
  caseGroupKey, caseSiteCompatible, linkageRefusalStatus, parseLineSiteFields, siteGroupKey, siteText, toothScope, validateLineSite, INVOICE_LINKAGE_MESSAGE, invoiceRequestFingerprint, lineLinkage, sessionsFor, shellCaseTitle,
} from "../lib/invoice-clinical-linkage";
import { DEFAULT_SPECIALTY_TEMPLATES } from "../lib/specialty-templates";

describe("(INV-LINK B) schema 0041", () => {
  it("keeps the migration byte-equal to the runtime SQL", () => {
    const lines = readFileSync("migrations/0041_invoice_clinical_linkage.sql", "utf8").split("\n");
    const index = lines.findIndex((line) => !line.startsWith("--"));
    expect(lines.slice(index).join("\n").trim()).toBe(INVOICE_LINKAGE_SQL.trim());
  });
  it("is additive only: nullable columns, no defaults, no rewrite, no drop", () => {
    expect(INVOICE_LINKAGE_SQL).not.toMatch(/DROP\s|^\s*(DELETE|UPDATE|INSERT)\s/im);
    expect(INVOICE_LINKAGE_SQL).not.toMatch(/ADD COLUMN[^;]*(NOT NULL|DEFAULT)/);
    expect(INVOICE_LINKAGE_SQL.match(/ADD COLUMN IF NOT EXISTS/g)).toHaveLength(8);
    expect(INVOICE_LINKAGE_SQL).not.toMatch(/ON DELETE CASCADE/);
  });
});

describe("(INV-LINK B) line classification uses the catalog category only", () => {
  it("clinical categories map to a specialty; restorative has no case", () => {
    expect(lineLinkage({ serviceId: 1, category: "ortho" })).toEqual({ kind: "clinical", specialty: "orthodontics", needsCase: true });
    expect(lineLinkage({ serviceId: 1, category: "rct" })).toEqual({ kind: "clinical", specialty: "endodontics", needsCase: true });
    expect(lineLinkage({ serviceId: 1, category: "crown" })).toMatchObject({ specialty: "prosthodontics" });
    expect(lineLinkage({ serviceId: 1, category: "implant" })).toMatchObject({ specialty: "implantology" });
    expect(lineLinkage({ serviceId: 1, category: "cleaning" })).toMatchObject({ specialty: "periodontics" });
    expect(lineLinkage({ serviceId: 1, category: "extraction" })).toMatchObject({ specialty: "surgery" });
    expect(lineLinkage({ serviceId: 1, category: "veneer" })).toMatchObject({ specialty: "cosmetic" });
    expect(lineLinkage({ serviceId: 1, category: "filling" })).toEqual({ kind: "clinical", specialty: "restorative", needsCase: false });
  });
  it("no service, consultation, x-ray or an unknown category stay financial-only (no text inference)", () => {
    expect(lineLinkage({ serviceId: null, category: "ortho" })).toEqual({ kind: "financial" });
    for (const category of ["consultation", "xray", "mystery", null]) {
      expect(lineLinkage({ serviceId: 9, category })).toEqual({ kind: "financial" });
    }
  });
  it("sessions: request, else template step, else one", () => {
    expect(sessionsFor("rct", 5, DEFAULT_SPECIALTY_TEMPLATES)).toBe(5);
    expect(sessionsFor("rct", null, DEFAULT_SPECIALTY_TEMPLATES)).toBe(3);
    expect(sessionsFor("unknown", null, DEFAULT_SPECIALTY_TEMPLATES)).toBe(1);
    expect(sessionsFor("rct", 0, DEFAULT_SPECIALTY_TEMPLATES)).toBe(3);
  });
  it("shell titles say only that a clinical assessment is needed", () => {
    expect(shellCaseTitle("orthodontics", null)).toBe("تقويم — تحتاج تقييمًا سريريًّا");
    expect(shellCaseTitle("endodontics", 36)).toBe("علاج جذور — سن 36 — تحتاج تقييمًا سريريًّا");
  });
  it("the fingerprint changes with any money/identity field and every refusal is Arabic", () => {
    const base = { patientId: 1, currency: "YER", discountMinor: 0, items: [{ serviceId: 2, description: "x", quantity: 1, unitPriceMinor: 10, doctorId: null }] };
    expect(invoiceRequestFingerprint(base)).toBe(invoiceRequestFingerprint({ ...base }));
    expect(invoiceRequestFingerprint(base)).not.toBe(invoiceRequestFingerprint({ ...base, items: [{ ...base.items[0], unitPriceMinor: 11 }] }));
    expect(invoiceRequestFingerprint(base)).not.toBe(invoiceRequestFingerprint({ ...base, items: [{ ...base.items[0], toothCode: 36 }] }));
    for (const message of Object.values(INVOICE_LINKAGE_MESSAGE)) expect(message).toMatch(/[؀-ۿ]/);
  });
});

describe("(INV-LINK) case site compatibility", () => {
  it("tooth-bound specialties need an empty or matching site; whole-mouth specialties match by specialty", () => {
    expect(caseSiteCompatible("endodontics", "11", 36)).toBe(false);
    expect(caseSiteCompatible("endodontics", "36", 36)).toBe(true);
    expect(caseSiteCompatible("endodontics", "36، 37", 37)).toBe(true);
    expect(caseSiteCompatible("endodontics", "136", 36)).toBe(false);
    expect(caseSiteCompatible("endodontics", null, 36)).toBe(true);
    expect(caseSiteCompatible("endodontics", "11", null)).toBe(true);
    expect(caseSiteCompatible("orthodontics", "11", 36)).toBe(true);
    expect(caseGroupKey("prosthodontics", 36)).not.toBe(caseGroupKey("prosthodontics", 46));
    expect(caseGroupKey("orthodontics", 36)).toBe(caseGroupKey("orthodontics", null));
  });
});

describe("(INV-LINK TOOTH) per-service tooth scope and site validation", () => {
  it("maps catalog categories to a scope mode", () => {
    expect(["rct", "post", "implant", "extraction", "surgery"].map(toothScope)).toEqual(Array(5).fill("per_tooth_episode"));
    expect(["crown", "veneer", "bridge"].map(toothScope)).toEqual(Array(3).fill("multi_tooth_episode"));
    expect(["filling", "sealant"].map(toothScope)).toEqual(["tooth_surfaces", "tooth_surfaces"]);
    expect(toothScope("cleaning")).toBe("region");
    expect(toothScope("ortho")).toBe("arch");
    expect([null, "consultation", "xray", "whitening", "unknown"].map(toothScope)).toEqual(Array(5).fill("none"));
  });
  it("validates and normalizes the site", () => {
    expect(validateLineSite({ category: "rct", toothCode: null })).toEqual({ ok: false, reason: "tooth_required" });
    expect(validateLineSite({ category: "rct", toothCode: 19 })).toEqual({ ok: false, reason: "bad_tooth" });
    expect(validateLineSite({ category: "rct", toothCode: 36, episodeTeeth: [36, 37] })).toEqual({ ok: false, reason: "episode_split_required" });
    expect(validateLineSite({ category: "rct", toothCode: 36, episodeTeeth: [36] })).toMatchObject({ ok: true });
    const bridge = validateLineSite({ category: "bridge", toothCode: 15, episodeTeeth: [16, 14, 15, 15] });
    expect(bridge.ok && bridge.site.episodeTeeth).toEqual([14, 15, 16]);
    expect(bridge.ok && siteText(bridge.site)).toBe("14، 15، 16");
    expect(bridge.ok && siteGroupKey("prosthodontics", bridge.site)).toBe("prosthodontics:ep:14,15,16");
    const filling = validateLineSite({ category: "filling", toothCode: 26, surfaces: "o, m" });
    expect(filling.ok && filling.site.surfaces).toBe("MO");
    expect(validateLineSite({ category: "filling", toothCode: 26, surfaces: "MQ" })).toEqual({ ok: false, reason: "bad_surfaces" });
    expect(validateLineSite({ category: "ortho", toothCode: null, scope: "both" })).toMatchObject({ ok: true, site: { scope: "both" } });
    expect(validateLineSite({ category: "ortho", toothCode: 11 })).toEqual({ ok: false, reason: "bad_scope" });
    expect(validateLineSite({ category: "cleaning", toothCode: null, scope: "both" })).toEqual({ ok: false, reason: "bad_scope" });
    expect(validateLineSite({ category: "consultation", toothCode: 36, scope: "upper" })).toMatchObject({ ok: true, site: { toothCode: null, scope: null } });
  });
  it("parses request site fields strictly and maps refusals to HTTP statuses", () => {
    expect(parseLineSiteFields({})).toEqual({ surfaces: null, episodeTeeth: null, scope: null });
    expect(parseLineSiteFields({ surfaces: "MO", episodeTeeth: [14, 15], scope: "upper" })).toEqual({ surfaces: "MO", episodeTeeth: [14, 15], scope: "upper" });
    expect(parseLineSiteFields({ episodeTeeth: "14,15" })).toBeUndefined();
    expect(parseLineSiteFields({ episodeTeeth: [14.5] })).toBeUndefined();
    expect(parseLineSiteFields({ surfaces: 12 })).toBeUndefined();
    expect(linkageRefusalStatus("tooth_required")).toBe(400);
    expect(linkageRefusalStatus("episode_split_required")).toBe(400);
    expect(linkageRefusalStatus("already_billed")).toBe(409);
  });
  it("the idempotency fingerprint covers surfaces, episode teeth and scope", () => {
    const base = { patientId: 1, currency: "YER", discountMinor: 0,
      items: [{ serviceId: 1, description: "x", quantity: 1, unitPriceMinor: 1, doctorId: null, toothCode: 26 }] };
    const fp = invoiceRequestFingerprint(base);
    expect(invoiceRequestFingerprint({ ...base, items: [{ ...base.items[0], surfaces: "MO" }] })).not.toBe(fp);
    expect(invoiceRequestFingerprint({ ...base, items: [{ ...base.items[0], episodeTeeth: [26, 27] }] })).not.toBe(fp);
    expect(invoiceRequestFingerprint({ ...base, items: [{ ...base.items[0], scope: "upper" }] })).not.toBe(fp);
  });
});
