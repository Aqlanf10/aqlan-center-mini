/** Step 4: the provenance status wording on screen and in print. Text only; never a number change. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cephProvenanceLabelAr } from "../lib/ceph-provenance/labels";

describe("provenance label", () => {
  it("says nothing for drafts and distinguishes historical, broken and sealed completions", () => {
    expect(cephProvenanceLabelAr(undefined)).toBeNull();
    expect(cephProvenanceLabelAr({ state: "not-completed" })).toBeNull();
    expect(cephProvenanceLabelAr({ state: "unversioned", reason: "completed_before_provenance" })).toMatch(/سابق لتفعيل سجل الاعتماد/);
    // A NEW approval through the legacy path is not described as historical.
    const legacy = cephProvenanceLabelAr({ state: "unversioned", reason: "completed_without_seal" })!;
    expect(legacy).toMatch(/مسار لا يكتب سجلًا موثّقًا/);
    expect(legacy).not.toMatch(/سابق/);
    expect(cephProvenanceLabelAr({ state: "unversioned", reason: "provenance_start_unknown" })).toMatch(/تعذّر تحديد/);
    expect(cephProvenanceLabelAr({ state: "integrity-unavailable", reason: "x" })).toMatch(/تعذّر التحقق/);
    const sealed = cephProvenanceLabelAr({ state: "versioned", witnessSha256: "a".repeat(64), sealedAt: "2026-11-18T08:00:00.000000Z", sealedBy: "synthetic.doctor",
      engineVersion: "2026-11-18.1", sourceIdentityMeaning: "submitted_source_identity_matches_server_capture", measurementsWithAssumption: 2, measurementsWithLegacyDefinitionDifference: 5 })!;
    expect(sealed).toMatch(/synthetic\.doctor/);
    expect(sealed).toMatch(/2 قيمة غير مقيسة بالكامل/);
    expect(sealed).toMatch(/5 قيمة يخالف تعريفها القديم المصدر/);
    expect(sealed).toMatch(/لا يعني تحققًا سريريًا مستقلًا/);
  });

  it("is wired on the study screen, in print, and the completion request carries the reviewed sources", () => {
    expect(readFileSync(new URL("../components/patient/CanonicalCephStudy.tsx", import.meta.url), "utf8")).toContain("cephProvenanceLabelAr(feed.provenance)");
    expect(readFileSync(new URL("../app/print/ceph/[id]/page.tsx", import.meta.url), "utf8")).toContain("cephProvenanceLabelAr(await readCephProvenanceState(getPool(), study.analysis.id))");
    expect(readFileSync(new URL("../components/patient/CanonicalCephComplete.tsx", import.meta.url), "utf8")).toContain("expectedSources: feed.completionSources");
  });

  it("the browser-safe modules never import node crypto", () => {
    for (const f of ["source-identity.ts", "labels.ts", "engine-identity.ts"]) {
      const runtimeImports = readFileSync(new URL(`../lib/ceph-provenance/${f}`, import.meta.url), "utf8").split("\n").filter((l) => /^import /.test(l) && !/^import type /.test(l)).join("\n");
      expect(runtimeImports, f).not.toMatch(/node:crypto|"\.\/(witness|canonical-json|capture)"|"\.\.\/db"/);
    }
  });
});
