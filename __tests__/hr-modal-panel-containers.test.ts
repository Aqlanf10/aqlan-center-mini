import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

// The shared native Modal supplies the backdrop, not an editor card. Every HR
// caller must own one bounded opaque root, including loading/error branches.
const inventory = [
  ["ContractsPanel", 4, true], ["AttendancePanel", 3, true],
  ["LeavesPanel", 2, true], ["PayrollPanel", 2, true],
  ["StaffProfileModal", 1, true], ["StaffPanel", 1, false],
  ["TasksPanel", 2, false], ["ReportsPanel", 0, false],
] as const;

for (const [name, expected, repaired] of inventory) {
  it(`${name} keeps every native dialog inside its own opaque bounded panel`, () => {
    const source = ts.createSourceFile(`${name}.tsx`, readFileSync(join(process.cwd(), "components/hr", `${name}.tsx`), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const modals: ts.JsxElement[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === "Modal") modals.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(modals).toHaveLength(expected);
    for (const modal of modals) {
      const panels = modal.children.filter(ts.isJsxElement);
      expect(panels).toHaveLength(1);
      const panel = panels[0].openingElement;
      expect(["div", "form"]).toContain(panel.tagName.getText(source));
      const classes = panel.attributes.properties.find((attribute): attribute is ts.JsxAttribute => ts.isJsxAttribute(attribute) && attribute.name.getText(source) === "className");
      expect(classes?.initializer && ts.isStringLiteral(classes.initializer)).toBe(true);
      const tokens = new Set((classes!.initializer as ts.StringLiteral).text.split(/\s+/));
      for (const token of ["mx-auto", "w-full", "bg-white", "rounded-2xl"]) expect(tokens.has(token)).toBe(true);
      expect([...tokens].some(token => /^max-w-(lg|2xl|3xl)$/.test(token))).toBe(true);
      if (repaired) {
        for (const token of ["min-w-0", "[overflow-wrap:anywhere]", "[&_div]:min-w-0", "[&_fieldset]:min-w-0", "[&_input]:min-w-0", "[&_select]:min-w-0", "[&_textarea]:min-w-0"]) expect(tokens.has(token)).toBe(true);
        expect(modal.openingElement.attributes.properties.some(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(source) === "alignTop")).toBe(true);
      }
    }
  });
}
