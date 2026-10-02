// Run actual verify-ci in plain Node with a wholly synthetic environment. The
// only real child is this tiny test process; all operational spawn/DB/runtime
// imports are blocked or mocked before the CLI module is evaluated.
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const environment = JSON.parse(process.argv[2]);
const entryUrl = new URL("../../scripts/verify-ci.mjs", import.meta.url);
const loadEnvUrl = new URL("../../scripts/load-env.mjs", import.meta.url).href;
const runtimeDbUrl = new URL("../../lib/db.ts", import.meta.url).href;
const output = { children: 0, exit: null, error: null };
const write = process.stdout.write.bind(process.stdout);
globalThis.__verificationEntryBoundary = output;
process.env = environment;
process.argv = [process.execPath, fileURLToPath(entryUrl)];
console.log = () => {};
console.error = () => {};

class CliExit extends Error {
  constructor(code) { super("MOCK_CLI_EXIT"); this.code = code; }
}
process.exit = (code) => { throw new CliExit(Number(code ?? 0)); };

const asModule = (source) => ({
  url: `data:text/javascript,${encodeURIComponent(source)}`,
  shortCircuit: true,
});

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "node:child_process" || specifier === "child_process") {
      return asModule(`
        export function spawn() {
          globalThis.__verificationEntryBoundary.children++;
          return { on(event, callback) {
            if (event === "close") queueMicrotask(() => callback(0));
            return this;
          } };
        }
      `);
    }
    if (specifier === "pg" || specifier.startsWith("pg/")) {
      throw new Error("FORBIDDEN_PG_IMPORT_IN_PURE_CLI_GUARD");
    }
    const resolved = nextResolve(specifier, context);
    if (resolved.url === loadEnvUrl) return asModule("export {};");
    if (resolved.url === runtimeDbUrl) throw new Error("FORBIDDEN_RUNTIME_DB_IMPORT_IN_PURE_CLI_GUARD");
    return resolved;
  },
});

try {
  await import(entryUrl.href);
} catch (error) {
  if (error instanceof CliExit) output.exit = error.code;
  else output.error = error.message;
}
write(JSON.stringify(output));
