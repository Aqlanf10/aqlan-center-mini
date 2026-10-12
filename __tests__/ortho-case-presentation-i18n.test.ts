import { describe, expect, it } from "vitest";
import { CASE_LAYOUTS } from "../lib/ortho-case-template";
import { STUDY_SOURCE_KINDS } from "../lib/ortho-case-study";
import { canonicalJourneyJSON } from "../lib/ortho-case-journey-json";
import { readStudyDisplayLocale, studyDirection, studyLayoutTitle, studySourceName, studySourceReason, studyText } from "../lib/ortho-case-presentation-i18n";

describe("display language is independent of the clinical document", () => {
  it("accepts only supported preferences; corrupt or unrelated stored values cannot become labels or direction", () => {
    for (const input of [null, undefined, {}, "en-US", "<script>", "../../other", "AR"]) expect(readStudyDisplayLocale(input)).toBe("ar");
    expect(readStudyDisplayLocale("en")).toBe("en");
    expect(studyDirection("ar")).toBe("rtl"); expect(studyDirection("en")).toBe("ltr");
  });
  it("selects declared section titles without modifying the template or its canonical content", () => {
    const before = canonicalJourneyJSON(CASE_LAYOUTS);
    expect(studyLayoutTitle("interview", "en")).toMatch(/history/i);
    for (const layout of CASE_LAYOUTS) {
      expect(studyLayoutTitle(layout.key, "ar")).toBe(layout.titleAr);
      expect(studyLayoutTitle(layout.key, "en")).toBe(layout.titleEn);
    }
    expect(canonicalJourneyJSON(CASE_LAYOUTS)).toBe(before);
    expect(studyLayoutTitle("unknown", "en")).toBe("Unavailable");
  });
  it("names all source types and keeps unavailable data distinct from a normal result", () => {
    for (const kind of STUDY_SOURCE_KINDS) {
      expect(studySourceName(kind, "en")).not.toMatch(/[\u0600-\u06ff]/);
      expect(studySourceName(kind, "ar")).toMatch(/[\u0600-\u06ff]/);
    }
    expect(studyText("en", "لم يُختر مصدر. لا تُفترض نتائج طبيعية.")).toBe("No source selected. Normal findings are not assumed.");
    expect(studyText("en", "غير مسجل")).not.toBe(studyText("en", "غير متاح"));
  });
  it("describes only recognized reader codes and never interprets unknown reasons or authored text", () => {
    for (const reason of ["source_missing_or_outside_case", "source_schema_unavailable", "document_removed", "ceph_review_projection_unavailable",
      "source_unavailable", "assessment_layout_not_mapped", "retention_event_not_debond", "layout_source_projection_not_implemented"]) {
      expect(studySourceReason(reason, "en")).toEqual(expect.any(String));
      expect(studySourceReason(reason, "en")).not.toMatch(/[\u0600-\u06ff]/);
      expect(studySourceReason(reason, "ar")).toMatch(/[\u0600-\u06ff]/);
    }
    expect(studySourceReason("source_missing_or_outside_case", "en")).toBe("The source is missing or does not belong to this case.");
    for (const unknown of ["future_reason", "__proto__", "constructor", "toString", "Document_Removed", "document_removed ", "<img src=x onerror=alert(1)>", "ملاحظة الطبيب"]) {
      expect(studySourceReason(unknown, "ar")).toBeNull(); expect(studySourceReason(unknown, "en")).toBeNull();
    }
  });
});
