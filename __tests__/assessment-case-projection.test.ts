import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssessmentBanner } from "../components/AssessmentBanner";
import { readWorkflowCases } from "../lib/patient-workflow-cases";

afterEach(() => vi.unstubAllGlobals());
describe("assessment banner uses only validated shared workflow evidence", () => {
  it("renders truthful provenance without a banner-owned request", () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const accepted = readWorkflowCases({ patient: { id: 7 }, assessmentCases: [{ id: 12, patientId: 7,
      kind: "specialty", orthoCaseId: null, specialty: "endodontics", title: "Pending case", needsAssessment: true }] }, 7)!;
    const html = renderToStaticMarkup(createElement(AssessmentBanner, { cases: accepted.assessmentCases,
      specialty: "endodontics", hint: "" }));
    expect(html).toContain("Pending case");
    expect(html).toContain("الفاتورة لا تثبت الموافقة السريرية أو اكتمال السداد");
    expect(html).not.toContain("مقبول ماليًّا"); expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not display a retired or unrelated projection", () => {
    expect(renderToStaticMarkup(createElement(AssessmentBanner, { cases: [], specialty: "endodontics", hint: "" }))).toBe("");
    expect(readWorkflowCases({ patient: { id: 8 }, assessmentCases: [] }, 7)).toBeNull();
  });
});
