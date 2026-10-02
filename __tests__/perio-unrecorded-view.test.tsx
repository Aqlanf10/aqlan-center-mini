import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PerioChartView } from "../components/DentalChart";
import { type ToothPerioRecord } from "../lib/dental";

vi.mock("../components/SessionProvider", () => ({ useSession: () => null }));

const recordedTooth: ToothPerioRecord = {
  toothCode: 16,
  facial: [{ depth: 1, bleeding: false }, { depth: 4, bleeding: true }, { depth: 7, bleeding: false }],
  lingual: [{ depth: 3, bleeding: true }, { depth: 5, bleeding: false }, { depth: 9, bleeding: true }],
};

// Exercise only the dormant view. The live DentalChart still passes false;
// perio-recording-containment.test.tsx separately guards that production entry.
const renderAvailableView = (records: Record<number, ToothPerioRecord>, initialTooth: number, canEdit = true) =>
  renderToStaticMarkup(createElement(PerioChartView, {
    teethUpper: [16, 17], teethLower: [], system: "fdi", records, initialTooth,
    onUpdate: () => { throw new Error("Rendering must not create measurements"); },
    canEdit, recordingAvailable: true,
  }));

const toothCells = (html: string) => [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)]
  .slice(0, 2).map((match) => match[1]);

describe("unrecorded periodontal teeth", () => {
  it.each([true, false])("shows no invented depths or BOP editor for missing records (canEdit=%s)", (canEdit) => {
    const html = renderAvailableView({}, 16, canEdit);
    expect(html).toContain("قياسات اللثة لهذا السن غير مسجّلة");
    expect(toothCells(html)).toHaveLength(2);
    for (const cell of toothCells(html)) {
      expect(cell).toContain("غير مسجّل");
      expect(cell).not.toMatch(/BOP|🩸|جيب|bg-emerald|>2</);
    }
    expect(html).not.toMatch(/<select|<input|BOP|🩸|\d mm/);
    expect(html).not.toContain("طبيعي");
  });

  it("keeps recorded and unrecorded teeth distinct when the selected tooth is missing", () => {
    const html = renderAvailableView({ 16: recordedTooth }, 17);
    const [recorded, missing] = toothCells(html);
    expect(recorded).not.toContain("غير مسجّل");
    expect(recorded).toContain(">1</span>");
    expect(recorded).toContain(">4</span>");
    expect(recorded).toContain(">7</span>");
    expect(recorded).toContain("نزف عند السبر BOP");
    expect(recorded).toContain("جيب");
    expect(missing).toContain("غير مسجّل");
    expect(missing).not.toMatch(/BOP|🩸|جيب|bg-emerald|>2</);
    expect(html).toContain("قياسات اللثة لهذا السن غير مسجّلة");
    expect(html).not.toMatch(/<select|<input|title="نزف عند السبر \(BOP\)"/);
  });

  it.each([true, false])("retains all six supplied depths and BOP values (canEdit=%s)", (canEdit) => {
    const originalRecord = structuredClone(recordedTooth);
    const html = renderAvailableView({ 16: recordedTooth }, 16, canEdit);
    const selectedDepths = [...html.matchAll(/<option value="(\d)" selected="">/g)].map((match) => Number(match[1]));
    expect(selectedDepths).toEqual([1, 4, 7, 3, 5, 9]);
    const bleedingButtons = [...html.matchAll(/<button[^>]*title="نزف عند السبر \(BOP\)"[^>]*>/g)].map((match) => match[0]);
    expect(bleedingButtons).toHaveLength(6);
    expect(bleedingButtons.map((button) => button.includes("border-red-500 bg-red-100")))
      .toEqual([false, true, false, true, false, true]);
    expect(bleedingButtons.every((button) => button.includes('disabled=""') === !canEdit)).toBe(true);
    expect(toothCells(html)[1]).toContain("غير مسجّل");
    expect(html).not.toContain("قياسات اللثة لهذا السن غير مسجّلة");
    expect(recordedTooth).toEqual(originalRecord);
  });
});
