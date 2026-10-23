import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Structural contract for already draft-only callers. These links never navigate in tests.
function links(path: string) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const result: ts.JsxElement[] = [];
  const walk = (node: ts.Node) => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(file) === "a") result.push(node);
    ts.forEachChild(node, walk);
  };
  walk(file);
  return { result, file, source };
}

describe("appointment draft-only entry points", () => {
  it("keeps Today's next-booking draft retryable, with no send or dismiss handler", () => {
    const { result, file } = links("../app/page.tsx");
    const link = result.find((node) => node.openingElement.attributes.getText(file).includes("nextBooked.link"));
    expect(link).toBeDefined();
    expect(link!.getText(file)).toContain("فتح مسودة الموعد بواتساب");
    expect(link!.openingElement.attributes.properties.some((prop) => ts.isJsxAttribute(prop)
      && /^on/.test(prop.name.getText(file)))).toBe(false);
    expect(link!.openingElement.attributes.getText(file)).toContain('target="_blank"');
  });

  it("does not add appointment-stamping side effects to patient-file contact links", () => {
    const { result, file, source } = links("../app/patients/[id]/page.tsx");
    const contact = result.filter((node) => node.openingElement.attributes.getText(file).includes("https://wa.me/"));
    expect(contact).toHaveLength(2);
    for (const link of contact) {
      expect(link.openingElement.attributes.properties.some((prop) => ts.isJsxAttribute(prop)
        && /^on/.test(prop.name.getText(file)))).toBe(false);
    }
    expect(source).not.toContain('action: "reminded"');
  });
});
