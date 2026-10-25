import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";
import { expect, it } from "vitest";

// Static guard for the proven hosted 390px / 200%-text regression. The real
// browser geometry assertions remain authoritative; this is not layout proof.
const css = postcss.parse(readFileSync(resolve(process.cwd(), "components/leadership/leadership.module.css"), "utf8"));
function declarations(selector: string) {
  const values: Record<string, string> = {};
  css.walkRules(rule => {
    if (!rule.selectors.includes(selector)) return;
    rule.walkDecls(declaration => { values[declaration.prop] = declaration.value; });
  });
  return values;
}
it("allows nested financial flex content to shrink and text to wrap without clipping", () => {
  expect(declarations(".stack")["min-width"]).toBe("0");
  expect(declarations(".sectionHeading > *")["min-width"]).toBe("0");
  expect(declarations(".workspace")["overflow-wrap"]).toBe("anywhere");
  expect(declarations(".workspace")["overflow-x"] ?? "visible").not.toMatch(/hidden|clip/);
});
it("gives date labels a shrinkable wrapping track instead of their native input's intrinsic width", () => {
  expect(declarations(".financeDates > .dayLabel")).toMatchObject({ "min-width": "0", "max-width": "100%", flex: "1 1 12rem" });
  expect(declarations(".financeDates .dayLabel input")).toMatchObject({ "min-width": "0", width: "100%", flex: "1 1 10rem" });
});
it("wraps enlarged navigation labels and constrains financial facts, without reducing text size", () => {
  expect(declarations(".pillGroup button")).toMatchObject({ "max-width": "100%", "white-space": "normal" });
  expect(declarations(".operationalFacts > div")["min-width"]).toBe("0");
});
