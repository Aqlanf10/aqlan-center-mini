import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";

async function fresh() {
  vi.resetModules();
  return (await import("./security-http/coverage-fixture-phase-diagnostic")).runCoverageFixturePhases;
}
afterEach(() => { vi.restoreAllMocks(); });

describe("synthetic coverage fixture stage observation", () => {
  it("connects the real beforeEach seed and update to the two-stage wrapper", () => {
    const source = readFileSync(new URL("./security-http/canonical-ortho-coverage-command-journey.test.ts", import.meta.url), "utf8");
    const tree = ts.createSourceFile("synthetic-coverage-journey.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const matches: ts.CallExpression[] = [];
    const walk = (node: ts.Node, predicate: (item: ts.Node) => void) => { predicate(node); ts.forEachChild(node, child => walk(child, predicate)); };
    let beforeEach: ts.CallExpression | undefined;
    walk(tree, node => { if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "beforeEach") beforeEach = node; });
    if (beforeEach) walk(beforeEach, node => { if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "runCoverageFixturePhases") matches.push(node); });
    const call = matches[0];
    let seed = false, assignment = false, update = false;
    if (call?.arguments.length === 2) {
      walk(call.arguments[0], node => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "seedCanonicalCoverage") seed = true;
        if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left) && node.left.text === "caseId" && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) assignment = true;
      });
      walk(call.arguments[1], node => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "query"
          && ts.isPropertyAccessExpression(node.expression.expression) && ts.isIdentifier(node.expression.expression.expression)
          && node.expression.expression.expression.text === "journey" && node.expression.expression.name.text === "db") update = true;
      });
    }
    expect(matches.length === 1 && !!call && call.arguments.length === 2 && seed && assignment && update).toBe(true);
  });

  it("preserves the ordered seed result and update without extra work", async () => {
    const run = await fresh(), events: string[] = [], emit = vi.fn(), value = { synthetic: true };
    const timer = vi.spyOn(globalThis, "setTimeout");
    const seed = vi.fn(async () => { events.push("seed"); return value; });
    const update = vi.fn(async () => { events.push("update"); return { synthetic: true }; });
    const result = await run(seed, update, emit);
    expect(result).toBe(value); expect(events).toEqual(["seed", "update"]);
    expect(seed).toHaveBeenCalledTimes(1); expect(update).toHaveBeenCalledTimes(1);
    expect(emit).not.toHaveBeenCalled(); expect(timer).not.toHaveBeenCalled();
  });

  it("classifies a failing seed, does not run update, and rethrows the identical value", async () => {
    const run = await fresh(), original = new Error("SYNTHETIC_PRIVATE\n::error::do-not-print"), output: string[] = [];
    const update = vi.fn(async () => undefined);
    await expect(run(async () => { throw original; }, update, line => output.push(line))).rejects.toBe(original);
    expect(update).not.toHaveBeenCalled();
    expect(output).toEqual(["::notice title=Synthetic coverage phase::phase=seed\n"]);
    expect(output[0].includes("SYNTHETIC_PRIVATE")).toBe(false);
  });

  it("classifies a failing update after one successful seed and rethrows the same object", async () => {
    const run = await fresh(), original = Object.assign(new Error("SYNTHETIC_PRIVATE"), { code: "SYNTHETIC_CODE" });
    const output: string[] = [], seed = vi.fn(async () => ({ synthetic: true })), update = vi.fn(async () => { throw original; });
    await expect(run(seed, update, line => output.push(line))).rejects.toBe(original);
    expect(seed).toHaveBeenCalledTimes(1); expect(update).toHaveBeenCalledTimes(1);
    expect(output).toEqual(["::notice title=Synthetic coverage phase::phase=update\n"]);
    expect(output[0].includes("SYNTHETIC_PRIVATE") || output[0].includes("SYNTHETIC_CODE")).toBe(false);
  });

  it("uses process.stdout.write for the fixed notice without printing the thrown payload", async () => {
    const run = await fresh(), output: string[] = [], marker = "SYNTHETIC_PRIVATE_0123456789";
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { output.push(String(chunk)); return true; });
    const original = new Error(marker);
    let identical = false;
    try { identical = await run(async () => { throw original; }, async () => undefined).then(() => false, error => error === original); }
    finally { stdout.mockRestore(); }
    expect(identical).toBe(true);
    expect(output).toEqual(["::notice title=Synthetic coverage phase::phase=seed\n"]);
    expect(output.join("").includes(marker)).toBe(false);
  });

  it("never inspects a thrown hostile proxy or runs update after a seed failure", async () => {
    const run = await fresh(), trap = vi.fn(() => { throw new Error("SYNTHETIC_PRIVATE"); });
    const original = new Proxy({}, { get: trap, getOwnPropertyDescriptor: trap });
    const output: string[] = [], update = vi.fn(async () => undefined);
    const identical = await run(async () => { throw original; }, update, line => output.push(line)).then(() => false, error => error === original);
    expect(identical).toBe(true); expect(trap).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
    expect(output).toEqual(["::notice title=Synthetic coverage phase::phase=seed\n"]);
  });

  it("preserves the original failure even if the output writer throws", async () => {
    const run = await fresh(), original = new Error("SYNTHETIC_ORIGINAL"), update = vi.fn(async () => undefined);
    await expect(run(async () => { throw original; }, update, () => { throw new Error("SYNTHETIC_WRITER"); })).rejects.toBe(original);
    expect(update).not.toHaveBeenCalled();
  });

  it("bounds notices to one per fixed phase per loaded module instance", async () => {
    const run = await fresh(), output: string[] = [];
    for (let i = 0; i < 5; i++) {
      const original = new Error("SYNTHETIC_SEED");
      await expect(run(async () => { throw original; }, async () => undefined, line => output.push(line))).rejects.toBe(original);
    }
    for (let i = 0; i < 5; i++) {
      const original = new Error("SYNTHETIC_UPDATE");
      await expect(run(async () => true, async () => { throw original; }, line => output.push(line))).rejects.toBe(original);
    }
    expect(output).toEqual(["::notice title=Synthetic coverage phase::phase=seed\n", "::notice title=Synthetic coverage phase::phase=update\n"]);
  });
});
