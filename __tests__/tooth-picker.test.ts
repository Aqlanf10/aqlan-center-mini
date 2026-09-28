import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToothPicker, toggleArch, toggleTooth } from "../components/ToothPicker";
import { PERMANENT_LOWER, PERMANENT_UPPER } from "../lib/dental";

/**
 * (SPEC-T1) مخطط اختيار الأسنان في «خطة من قالب التخصص» — بدل كتابة «16, 26» يدويًا.
 * لا jsdom في المستودع: المنطق الخالص يُختبر مباشرة، والعرض عبر renderToStaticMarkup.
 */

const render = (value: number[]) => renderToStaticMarkup(createElement(ToothPicker, { value, onChange: () => undefined }));

describe("(SPEC-T1) tooth picker", () => {
  it("a tap adds the tooth, a second tap removes it; the result stays sorted", () => {
    expect(toggleTooth([], 26)).toEqual([26]);
    expect(toggleTooth([26], 16)).toEqual([16, 26]);
    expect(toggleTooth([16, 26], 26)).toEqual([16]);
  });

  it("whole arch: completes it, then clears only that arch", () => {
    const upper = toggleArch([36], "upper");
    expect(upper).toHaveLength(17);
    expect(upper).toEqual(expect.arrayContaining([...PERMANENT_UPPER, 36]));
    expect(toggleArch(upper, "upper")).toEqual([36]);
    expect(toggleArch([11, 46], "lower")).toEqual([11, ...[...PERMANENT_LOWER].sort((a, b) => a - b)]);
  });

  it("renders all 32 permanent teeth in the usual facing layout, selection marked and summarised", () => {
    const html = render([16, 26]);
    for (const tooth of [...PERMANENT_UPPER, ...PERMANENT_LOWER]) expect(html).toContain(`>${tooth}</button>`);
    expect(html).toContain('dir="ltr"');
    expect(html.indexOf(">18</button>")).toBeLessThan(html.indexOf(">28</button>"));
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(2);
    expect(html).toContain("الرحى الأولى العلوي الأيمن");
    expect(html).toContain("المختارة (2): 16، 26");
    expect(html).not.toContain(">55</button>");
  });

  it("primary teeth appear when the selection already has one", () => {
    expect(render([55])).toContain(">55</button>");
  });

  it("the template plan form picks teeth on the chart, no free-text tooth numbers", () => {
    const source = readFileSync(resolve(process.cwd(), "components/TemplatePlanForm.tsx"), "utf8");
    expect(source).toContain("<ToothPicker value={teeth} onChange={setTeeth} />");
    expect(source).not.toContain("teethText");
  });
});
