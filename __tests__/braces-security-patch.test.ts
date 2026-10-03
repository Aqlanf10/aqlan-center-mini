import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { loadOfficialBracesFixture } from "../scripts/dependency-review/braces-fixture.mjs";

const require = createRequire(import.meta.url);
// Always compare with separately archived, integrity-verified official source.
// Future installation of the candidate cannot silently turn this into a
// candidate-versus-itself comparison.
const baseline = loadOfficialBracesFixture();
afterAll(() => baseline.cleanup());
const original = baseline.module;
const patched = require("../vendor/braces");
const { MAX_NESTING } = require("../vendor/braces/lib/nesting-guard");

const nested = (depth: number, open = "{", close = "}") =>
  open.repeat(depth) + "a,b" + close.repeat(depth);

function deepAst(depth: number, type = "paren") {
  const ast: any = { type: "root", nodes: [] };
  let cursor = ast;
  for (let index = 0; index < depth; index++) {
    const child: any = { type, nodes: [], parent: cursor };
    cursor.nodes.push(child);
    cursor = child;
  }
  cursor.nodes.push({ type: "text", value: "a", parent: cursor });
  return ast;
}

const expectBoundedRejection = (run: () => unknown) => {
  try {
    run();
    throw new Error("Expected an explicit nesting guard rejection");
  } catch (error: any) {
    expect(error.code).toBe("BRACES_NESTING_LIMIT");
    expect(error.message).not.toMatch(/Maximum call stack size exceeded/);
  }
};

// Parent-link cycles and shared child graphs can hang a regressed walker.
// Keep their failure proof outside the test runner with explicit time/memory
// limits, so a missing guard is a bounded failing test, not a stuck CI job.
function expectIsolatedRejection(source: string, code = "BRACES_INVALID_AST") {
  const result = spawnSync(process.execPath, ["--max-old-space-size=64", "-e", `
    const patched = require(${JSON.stringify(require.resolve("../vendor/braces"))});
    try { ${source}; throw new Error("Expected rejection"); }
    catch (error) {
      if (error.code !== ${JSON.stringify(code)}) {
        console.error(error.code || error.message);
        process.exitCode = 1;
      }
    }
  `], { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024 });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.signal, result.stderr).toBeNull();
  expect(result.status, result.stderr).toBe(0);
}

describe("local braces 3.0.3 depth guard", () => {
  it("preserves the official package identity rather than hiding its advisory", () => {
    const manifest = require("../vendor/braces/package.json");
    expect(manifest.name).toBe("braces");
    expect(manifest.version).toBe("3.0.3");
    expect(MAX_NESTING).toBe(128);
  });

  for (const method of ["parse", "compile", "expand", "stringify"]) {
    for (const [label, open, close] of [["braces", "{", "}"], ["parentheses", "(", ")"]]) {
      it(`${method} rejects deeply nested ${label} below the character limit`, () => {
        const pattern = nested(4_000, open, close);
        expect(pattern.length).toBeLessThan(10_000);
        expectBoundedRejection(() => patched[method](pattern));
        expectBoundedRejection(() => patched[method](pattern, { maxDepth: Infinity }));
      });
    }
    it(`${method} rejects mixed and unclosed nesting at the same boundary`, () => {
      expectBoundedRejection(() => patched[method]("{(".repeat(65) + "x"));
      expectBoundedRejection(() => patched[method]("{".repeat(MAX_NESTING + 1)));
    });
  }

  for (const method of ["compile", "expand", "stringify"]) {
    it(`${method} rejects a direct AST without invoking the parser`, () => {
      expectBoundedRejection(() => patched[method](deepAst(4_000)));
      expectBoundedRejection(() => require(`../vendor/braces/lib/${method}`)(deepAst(4_000)));
      // Naming nested containers root must not reset the structural budget.
      expectBoundedRejection(() => patched[method](deepAst(4_000, "root")));
    });
    it(`${method} rejects a child cycle`, () => {
      expectIsolatedRejection(`
        const ast = { type: "root", nodes: [] };
        ast.nodes.push(ast);
        patched.${method}(ast);
      `);
    });
    it(`${method} rejects a parent-link cycle`, () => {
      expectIsolatedRejection(`
        const child = { type: "paren", nodes: [{ type: "text", value: "a" }] };
        child.parent = child;
        patched.${method}({ type: "root", nodes: [child] });
      `);
    });
    it(`${method} rejects nested value arrays that bypass AST child edges`, () => {
      expect(() => patched[method]({ type: "root", nodes: [{ type: "text", value: [[["a"]]] }] })).toThrow(
        expect.objectContaining({ code: "BRACES_INVALID_AST" }),
      );
    });
    it(`${method} rejects a repeated-child DAG before exponential traversal`, () => {
      expectIsolatedRejection(`
        let child = { type: "text", value: "a" };
        for (let index = 0; index < 40; index++) child = { type: "paren", nodes: [child, child] };
        patched.${method}({ type: "root", nodes: [child] });
      `);
    });
  }

  it("expand bounds external ancestor queues without rejecting benign detached parser parents", () => {
    for (const wrapped of [false, true]) {
      expectIsolatedRejection(`
        let nestedQueue = "a";
        for (let index = 0; index < 4_000; index++) nestedQueue = [nestedQueue];
        const externalParent = { type: "root", queue: [nestedQueue] };
        const ast = { type: "paren", nodes: [{ type: "text", value: "a" }], parent: externalParent };
        patched.expand(${wrapped ? '{ type: "root", nodes: [ast] }' : 'ast'});
      `, "BRACES_NESTING_LIMIT");
    }
    expectIsolatedRejection(`
      const cycle = [];
      cycle.push(cycle);
      patched.expand({ type: "paren", nodes: [], parent: { type: "root", queue: cycle } });
    `);
  });

  it("protects the default, create and array APIs", () => {
    const pattern = nested(4_000);
    expectBoundedRejection(() => patched(pattern));
    expectBoundedRejection(() => patched.create(pattern));
    expectBoundedRejection(() => patched(["a/{b,c}", pattern]));
    expectBoundedRejection(() => patched(pattern, { expand: true }));
  });

  it("demonstrates the original artifact has no guard at the chosen boundary", () => {
    expect(() => original.parse(nested(MAX_NESTING + 1))).not.toThrow();
    expectBoundedRejection(() => patched.parse(nested(MAX_NESTING + 1)));
  });

  it("accepts the exact boundary and ordinary parser parent/prev links", () => {
    for (const [open, close] of [["{", "}"], ["(", ")"]]) {
      const pattern = nested(MAX_NESTING, open, close);
      expect(patched.compile(pattern)).toEqual(original.compile(pattern));
      expect(patched.stringify(pattern)).toEqual(original.stringify(pattern));
    }
    const pattern = nested(MAX_NESTING, "(", ")");
    expect(patched.expand(pattern)).toEqual(original.expand(pattern));
    const ast = patched.parse("src/{app,components}/**/*.{ts,tsx}");
    expect(patched.stringify(ast)).toBe("src/{app,components}/**/*.{ts,tsx}");
    expect(patched.stringify(ast.nodes[2])).toBe(original.stringify(original.parse("src/{app,components}/**/*.{ts,tsx}").nodes[2]));
  });

  it("does not count escaped, quoted or bracket-contained delimiters as nesting", () => {
    for (const pattern of ["\\{".repeat(200), '"' + "{".repeat(200) + '"', "[" + "{".repeat(200) + "]"]) {
      expect(patched.compile(pattern)).toEqual(original.compile(pattern));
      expect(patched.expand(pattern)).toEqual(original.expand(pattern));
    }
  });

  it("preserves existing maxLength and rangeLimit protection", () => {
    expect(() => patched.parse("a".repeat(10_001))).toThrow(/max characters/);
    expect(() => patched.parse("abc", { maxLength: 2 })).toThrow(/max characters/);
    expect(() => patched.expand("{1..10000}")).toThrow(/range limit/);
  });
});

describe("braces patch compatibility", () => {
  const patterns = [
    "", "a", "{}", "{a,b}", "{a,b,{c,d}}", "a/{b,c}/d", "{1..10}", "{01..05}",
    "{a..f}", "{1..9..2}", "{a,b}{c,d}", "{a,,b}", "${a,b}", "{a,b", "a,b}",
    "{a,b{c,d}", "(", "{a", "({a)", "({a,b}", "{(a,b}", "(a|b)", "\\{a,b\\}", '"{a,b}"', "[{a,b}]", "{1..3,7}",
    "./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "src/{app,lib}/**/*.{ts,tsx,js}",
  ];
  for (const prefix of ["", "src/", "a-"]) {
    for (const atom of ["{a,b}", "{1..3}", "{a..c}", "{a,b{c,d}}", "(a|b)", "[ab]", "\\{"]) {
      for (const suffix of ["", "/**/*.{ts,tsx}", ".{js,mjs}", "/{x,y}"]) {
        patterns.push(prefix + atom + suffix);
      }
    }
  }
  for (const method of ["compile", "expand", "stringify"]) {
    it(`${method} matches official output for ${patterns.length} patterns and option combinations`, () => {
      for (const pattern of patterns) {
        for (const options of [{}, { escapeInvalid: true }, { keepEscaping: true }, { noempty: true, nodupes: true }]) {
          expect(patched[method](pattern, options), JSON.stringify({ method, pattern, options })).toEqual(
            original[method](pattern, options),
          );
        }
      }
    });
  }
});
