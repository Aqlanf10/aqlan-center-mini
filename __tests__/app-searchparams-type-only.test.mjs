import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ts = require('typescript');
// Require an installed native binding directly: Next's fallback loader can
// download or attempt to repair lockfiles when optional bindings are missing.
function localNextSwc() {
  const triples = require('next/dist/compiled/@napi-rs/triples').platformArchTriples;
  const next = require('next/package.json'), expected = next.version;
  for (const triple of triples[process.platform]?.[process.arch] ?? []) {
    try {
      const name = `@next/swc-${triple.platformArchABI}`;
      if (next.optionalDependencies?.[name] !== expected) continue;
      if (require(`${name}/package.json`).version !== expected) continue;
      const binding = require(name);
      if (typeof binding.transformSync === 'function') return binding;
    } catch { /* Try the next locally installed ABI; never download. */ }
  }
  throw new Error('No matching locally installed Next SWC native binding');
}

describe('App-only search parameter type assertions', () => {
  it.each(['app/hr/page.tsx', 'app/messages/page.tsx'])(
    'erases the local non-null assertion without changing emitted JavaScript in %s', async file => {
      const source = readFileSync(file, 'utf8');
      const asserted = 'const searchParams = useSearchParams()!';
      expect(source.split(asserted)).toHaveLength(2);
      const prior = source.replace(asserted, 'const searchParams = useSearchParams()');
      const tsOptions = { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.ReactJSX, sourceMap: false }, reportDiagnostics: true };
      const oldTs = ts.transpileModule(prior, tsOptions), newTs = ts.transpileModule(source, tsOptions);
      expect(oldTs.diagnostics ?? []).toEqual([]);
      expect(newTs.diagnostics ?? []).toEqual([]);
      expect(newTs.outputText).toBe(oldTs.outputText);
      const options = { filename: file, jsc: { parser: { syntax: 'typescript', tsx: true }, target: 'es2022',
        transform: { react: { runtime: 'automatic' } } }, module: { type: 'es6' }, sourceMaps: false };
      const swc = localNextSwc(), encoded = Buffer.from(JSON.stringify(options));
      const oldSwc = swc.transformSync(prior, false, encoded), newSwc = swc.transformSync(source, false, encoded);
      expect(newSwc.code).toBe(oldSwc.code);
    },
  );
  it('retains the Next compatibility null check outside the two local assertions', () => {
    const prefix = '/// <reference types="next" />\n/// <reference types="next/navigation-types/compat/navigation" />\n'
      + 'import { useSearchParams } from "next/navigation";\n';
    const options = { strict: true, noEmit: true, skipLibCheck: true, module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2022 };
    function errors(body, name) {
      const file = path.join(process.cwd(), `synthetic-searchparams-${name}.ts`), source = prefix + body;
      const host = ts.createCompilerHost(options), originalSource = host.getSourceFile.bind(host), originalExists = host.fileExists.bind(host);
      host.fileExists = target => target === file || originalExists(target);
      host.getSourceFile = (target, language, onError, create) => target === file
        ? ts.createSourceFile(target, source, language, true) : originalSource(target, language, onError, create);
      return ts.getPreEmitDiagnostics(ts.createProgram([file], options, host)).map(diagnostic => diagnostic.code);
    }
    expect(errors('const value = useSearchParams(); value.get("patient");', 'nullable')).toEqual([18047]);
    expect(errors('const value = useSearchParams()!; value.get("patient");', 'asserted')).toEqual([]);
  });
});
