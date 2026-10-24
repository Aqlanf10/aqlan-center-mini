// Self-test of the target guard. Runs every directly runnable helper ON ITS OWN with unsafe targets and
// requires an immediate refusal before any runtime module is imported (the runtime root given is a path
// that does not exist, so reaching the import would fail differently). Targets use TEST-NET addresses and
// reserved names that are never contacted. Also checks that rerouting variables are stripped.
// Env: EVIDENCE.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertLoopbackUrl, sanitizedEnv } from "./guard.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const { EVIDENCE } = process.env;
if (!EVIDENCE) throw new Error("EVIDENCE required");
const MISSING_ROOT = "/nonexistent-runtime-root";
const HELPERS = ["init.mjs", "fixtures.mjs", "balances.mjs", "checksums.mjs"];
/** @type {Array<[string, Record<string, string>]>} */
const UNSAFE = [
  ["remote host", { DATABASE_URL: "postgresql://synthetic:synthetic@192.0.2.10:5432/aqlan" }],
  ["platform host name", { DATABASE_URL: "postgresql://synthetic:synthetic@postgres.railway.internal:5432/aqlan" }],
  ["loopback URL rerouted by ?host=", { DATABASE_URL: "postgresql://synthetic:synthetic@127.0.0.1:5432/aqlan?host=192.0.2.10" }],
  ["socket-only URL", { DATABASE_URL: "postgresql:///aqlan?host=/var/run/postgresql" }],
  ["no DATABASE_URL, only POSTGRES_URL", { POSTGRES_URL: "postgresql://synthetic:synthetic@127.0.0.1:5432/aqlan" }],
];
const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("PG") && !/DATABASE_URL|POSTGRES_/.test(k)));
const results = [];
for (const helper of HELPERS) for (const [label, extra] of UNSAFE) {
  const started = performance.now();
  const child = spawnSync("npx", ["tsx", path.join(here, helper), MISSING_ROOT], { encoding: "utf8", timeout: 30000, env: { ...base, ...extra } });
  const refused = child.status !== 0 && /refusing/.test(child.stderr) && !/Cannot find module|ERR_MODULE_NOT_FOUND/.test(child.stderr);
  results.push({ helper, target: label, status: child.status, refusedBeforeRuntimeImport: refused, ms: Math.round(performance.now() - started) });
}
// Control: with a loopback target the guard lets the helper through, and it then fails at the runtime import
// (the root does not exist). This shows the refusals above happened before that import.
const controls = HELPERS.map((helper) => {
  const child = spawnSync("npx", ["tsx", path.join(here, helper), MISSING_ROOT], { encoding: "utf8", timeout: 30000,
    env: { ...base, DATABASE_URL: "postgresql://synthetic:synthetic@127.0.0.1:1/aqlan" } });
  return { helper, status: child.status, passedGuardThenFailedAtRuntimeImport: child.status !== 0 && !/refusing/.test(child.stderr) && /Cannot find module|ERR_MODULE_NOT_FOUND/.test(child.stderr) };
});
const stripped = sanitizedEnv("postgresql://synthetic:synthetic@127.0.0.1:5432/aqlan",
  { PGHOST: "192.0.2.10", PGHOSTADDR: "192.0.2.10", PGSERVICE: "remote", POSTGRES_URL: "postgresql://x@192.0.2.10/a", RAILWAY_PROJECT_ID: "synthetic", VERCEL_ENV: "production", KEEP: "1" });
const strippedOk = ["PGHOST", "PGHOSTADDR", "PGSERVICE", "POSTGRES_URL", "RAILWAY_PROJECT_ID", "VERCEL_ENV"].every((k) => !(k in stripped)) && stripped.KEEP === "1" && stripped.NODE_ENV === "test";
let loopbackAccepted = true;
for (const ok of ["postgresql://u:p@127.0.0.1:5432/a?sslmode=disable", "postgres://u:p@localhost/a", "postgresql://u:p@[::1]:5432/a"]) {
  try { assertLoopbackUrl(ok, "DATABASE_URL"); } catch { loopbackAccepted = false; }
}
const checks = [
  { check: `every helper refuses every unsafe target before importing runtime code (${results.length} cases)`, ok: results.every((r) => r.refusedBeforeRuntimeImport) },
  { check: "rerouting variables (libpq PG*, other runtime database URLs, RAILWAY_*, VERCEL_*) are stripped from child environments", ok: strippedOk },
  { check: "loopback targets are accepted", ok: loopbackAccepted },
  { check: "control: with a loopback target each helper passes the guard and reaches the runtime import", ok: controls.every((c) => c.passedGuardThenFailedAtRuntimeImport) },
];
const result = checks.every((c) => c.ok) ? "PASS" : "FAIL";
writeFileSync(EVIDENCE, JSON.stringify({ result, checks, cases: results, controls }, null, 2) + "\n");
console.log(JSON.stringify(checks, null, 1), result);
if (result !== "PASS") process.exit(1);
