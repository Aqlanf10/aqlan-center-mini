import { readFileSync } from "node:fs";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

const css = postcss.parse(readFileSync(new URL("../app/print/print.css", import.meta.url), "utf8"));
const selectors = [".hr-staff-sheet", ".hr-tasks-sheet"];

describe("HR paper content box is independent from desktop preview dimensions", () => {
  it("resets only HR paper width, minimum height, margin and padding inside print media", () => {
    const resets: Record<string, string>[] = [];
    css.walkRules(rule => {
      if (rule.selectors.length !== 2 || !selectors.every(selector => rule.selectors.includes(selector))) return;
      if (rule.parent?.type !== "atrule" || rule.parent.name !== "media" || rule.parent.params !== "print") return;
      const values: Record<string, string> = {};
      rule.walkDecls(declaration => { values[declaration.prop] = declaration.value; });
      resets.push(values);
    });
    expect(resets).toEqual([{ width: "auto", "min-height": "0", margin: "0", padding: "0" }]);
  });

  it("keeps staff landscape and task portrait named pages", () => {
    const sizes: Record<string, string> = {};
    css.walkAtRules("page", page => {
      if (!["hr-staff", "hr-tasks"].includes(page.params)) return;
      page.walkDecls("size", declaration => { sizes[page.params] = declaration.value; });
    });
    expect(sizes).toEqual({ "hr-staff": "A4 landscape", "hr-tasks": "A4 portrait" });
  });
});
