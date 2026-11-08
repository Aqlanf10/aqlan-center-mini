import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: ReactNode }) => createElement("a", props, children) }));
import { CephTracer } from "../components/CephTracer";
describe("unvalidated template is not presented as anatomical image detection", () => {
  it("renders manual tracing and saved points without an automatic placement action", () => {
    const html = renderToStaticMarkup(createElement(CephTracer, {
      patientName: "Synthetic", patientBirthYear: null,
      analysis: { id: 1, patientId: 2, documentId: 3, status: "draft", orthoCaseId: null, phase: "pretreatment",
        xrayDate: null, device: null, refSet: "", calibration: null, mmPerPixel: null, note: null,
        createdBy: "Synthetic", createdAt: "2026-11-05", completedBy: null, completedAt: null, findings: null },
      initialLandmarks: [{ code: "S", x: 21, y: 34, source: "manual" }], stamped: null, refValues: null, refSetName: null, diagnosis: null,
    }));
    expect(html).toContain("التحديد التلقائي غير متاح؛ حدّد المعالم يدويًا");
    expect(html).toContain("قالب هندسي غير متحقق سريريًا");
    expect(html).not.toContain("AI Auto-Locate");
    expect(html).not.toContain("اقتراح المعالم الذكي");
    expect(html).toContain("S ✓");
  });
});
