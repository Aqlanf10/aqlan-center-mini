import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OrthoPhotoCompletenessPanel, PhotoCompletenessView } from "../components/OrthoPhotoCompleteness";
import { DEFAULT_PHOTO_STAGE_REQUIREMENTS, FULL_SET_VIEWS } from "@/lib/ortho-photos";
import { photoCompleteness, type CompletenessDocument } from "@/lib/ortho-photo-completeness";

/** OP-2 presentation. Synthetic documents only. */
let id = 1;
const doc = (extra: Partial<CompletenessDocument>): CompletenessDocument => ({
  id: id++, patientId: 1, orthoCaseId: 2, adjustmentId: 3, isImage: true, removedAt: null,
  photoStage: "initial", photoView: "smile", takenOn: "2026-01-04", ...extra,
});
const view = (documents: CompletenessDocument[]) => renderToStaticMarkup(createElement(PhotoCompletenessView, {
  requirements: DEFAULT_PHOTO_STAGE_REQUIREMENTS,
  result: photoCompleteness({ documents, patientId: 1, caseId: 2, photosVisible: true, requirements: DEFAULT_PHOTO_STAGE_REQUIREMENTS }),
}));

describe("PhotoCompletenessView (OP-2)", () => {
  it("shows each capture set separately with its count, missing views and optional views outside the ratio", () => {
    const out = view([
      ...FULL_SET_VIEWS.slice(0, 7).map(photoView => doc({ photoView })),
      doc({ photoView: "extraoral_45" }),
      doc({ photoView: "smile", photoStage: "progress", takenOn: "2026-06-01", adjustmentId: null }),
      doc({ photoView: "lateral_ceph" }),
    ]);
    expect(out).toContain('<bdi dir="ltr">2026-01-04</bdi>');
    expect(out).toContain("7 من 8 مطلوبة");
    expect(out).toContain("ينقص: قوام سفلي");
    expect(out).toContain("اختياري (لا يدخل النسبة)");
    expect(out).toContain("وجه مائل 45°: مصوّرة");
    expect(out).toContain("البروز الأمامي (جانبي للقواطع): غير مصوّرة");
    expect(out).toContain("1 من 8 مطلوبة");
    expect(out).toContain("بلا جلسة");
    expect(out).toContain("الأشعة (مؤشر منفصل، لا يدخل نسبة الصور):");
    expect(out).toMatch(/سيفالومترية جانبية\s*موجودة بتاريخ <span><bdi dir="ltr">2026-01-04<\/bdi><\/span>/);
    expect(out).toContain("لم تُصوَّر بعد:");
  });

  it("states unclassified images and an empty case honestly", () => {
    expect(view([doc({ takenOn: null })])).toContain("1 صورة غير مصنّفة");
    expect(view([])).toContain("لا مجموعات تصوير مصنّفة لهذه الحالة بعد.");
  });

  it.each([false, undefined])("without photo permission (%s) the panel is hidden and never fetches", (photosVisible) => {
    const out = renderToStaticMarkup(createElement(OrthoPhotoCompletenessPanel, { patientId: 1, caseId: 2, photosVisible }));
    expect(out).toContain("لا صلاحية لعرض صور المريض.");
    expect(out).not.toMatch(/مطلوبة|الأشعة|جارٍ/);
  });
});
