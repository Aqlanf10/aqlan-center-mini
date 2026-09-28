import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToothField, ToothPicker, parseTeethText, toggleArch, toggleTooth } from "../components/ToothPicker";
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

  it("single tooth (procedure / plan item): no arch buttons, the chosen tooth named", () => {
    const html = renderToStaticMarkup(createElement(ToothPicker, { value: [36], onChange: () => undefined, single: true }));
    expect(html).not.toContain("الفك العلوي كله");
    expect(html).toContain("36 — الرحى الأولى السفلي الأيسر");
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
  });

  it("the tooth field shows the chosen tooth as a button and keeps the chart closed until tapped", () => {
    const html = renderToStaticMarkup(createElement(ToothField, { value: "16", onChange: () => undefined }));
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="رقم السن"');
    expect(html).toContain('<span dir="ltr">16</span>');
    expect(html).not.toContain(">18</button>");
    expect(renderToStaticMarkup(createElement(ToothField, { value: "", onChange: () => undefined }))).toContain("🦷 السن");
  });

  it("referral text ↔ chart: «14, 24» parses back to the selection", () => {
    expect(parseTeethText("24, 14 ، 14")).toEqual([14, 24]);
    expect(parseTeethText("")).toEqual([]);
  });

  it("every screen that takes teeth uses the chart — no typed tooth numbers left", () => {
    const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");
    const visit = read("components/ClinicalVisit.tsx");
    expect(visit).toContain("<ToothField value={draft.toothCode}");
    expect(visit).not.toContain('placeholder="رقم السن"');
    const plans = read("components/PatientPlans.tsx");
    expect(plans).toContain("<ToothField value={row.tooth}");
    expect(plans).toContain("<ToothField value={tooth} onChange={setTooth}");
    expect(plans).not.toContain('placeholder="السن"');
    const referrals = read("components/PatientReferrals.tsx");
    expect(referrals).toContain("<ToothPicker value={parseTeethText(form.teeth)}");
    expect(referrals).not.toContain('placeholder="14, 24, 34, 44"');
  });
});
