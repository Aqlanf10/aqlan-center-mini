import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildChart, type ToothRecord } from "../lib/dental";
import { Odontogram } from "../components/dental/Odontogram";

const record: ToothRecord = { id: 1, toothCode: 26, condition: "missing", stage: "existing", surfaces: null,
  note: null, recordedBy: "synthetic", recordedAt: "2026-01-01T00:00:00Z", visitId: null };
const chart = buildChart([record, { ...record, id: 2, toothCode: 27, condition: "filling", stage: "planned" }]);
const render = (chartKnown: boolean) => renderToStaticMarkup(createElement(Odontogram, {
  chart, chartKnown, selected: [26], onPick: () => undefined, touch: true,
}));

describe("shared odontogram anatomy without verified chart evidence", () => {
  it("keeps anatomy selectable and selection visible without claiming healthy, absent or planned conditions", () => {
    const html = render(false);
    expect(html).toContain('data-testid="odontogram-tooth-26"');
    expect(html).toContain('data-chart-known="false"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("الحالة غير متاحة");
    expect(html).toContain('stroke-dasharray="2 2"');
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain("fill-white");
    expect(html).not.toContain("M4 5 L20 25 M20 5 L4 25");
    expect(html).not.toContain("fill-amber-500 stroke-white");
  });
  it("retains the clinical chart's normal rendering when its read is verified", () => {
    const html = render(true);
    expect(html).toContain('data-chart-known="true"');
    expect(html).toContain("M4 5 L20 25 M20 5 L4 25");
    expect(html).toContain("fill-amber-500 stroke-white");
    expect(html).not.toContain('stroke-dasharray="2 2"');
  });
});
