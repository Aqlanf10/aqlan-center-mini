import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

it("keeps Vitest polling assertions out of compact-reminder beforeAll setup", () => {
  const path = join(__dirname, "security-http/appointment-reminder-compact-ui.test.ts");
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const setupHooks: ts.CallExpression[] = [];
  const invalidPolls: ts.CallExpression[] = [];
  function visit(node: ts.Node, inSetup = false) {
    const isSetup = ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === "beforeAll";
    if (isSetup) setupHooks.push(node);
    if (inSetup && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "expect"
      && node.expression.name.text === "poll") invalidPolls.push(node);
    ts.forEachChild(node, child => visit(child, inSetup || isSetup));
  }
  visit(source);
  expect(setupHooks).toHaveLength(1);
  expect(invalidPolls).toHaveLength(0);
});
