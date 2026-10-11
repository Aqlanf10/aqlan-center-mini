import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASELINE = "85334d79cd7b1fb1e28bf494e7fb53c611b11817";
const prefix = "__tests__/security-http/";
const groups = {
  strategy: { files: ["patient-ortho-strategy-ui.test.ts"], baselineCount: 2, candidateCount: 34,
    pattern: "starts explicitly blank, searches without choosing" },
  clinical: { files: ["ceph-study-identity-ui-journey.test.ts", "ortho-records-case-ui.test.ts",
    "ortho-prescription-truth-built-page.test.ts", "patient-ceph-post-built-page.test.ts"],
    baselineCount: 8, candidateCount: 24,
    pattern: "lists earlier unlinked studies|keeps historical/unassigned records explicit|retains unrecorded and closed legacy custom prescriptions|retires a delayed POST after pillar" },
  account: { files: ["legacy-reconciliation-preview-built-page.test.ts", "patient-navigation-ui-journey.test.ts",
    "legacy-treatment-ui-journey.test.ts", "walkout-verified-balances-ui.test.ts"],
    baselineCount: 7, candidateCount: 19,
    pattern: "keeps arithmetic, provenance and draft lifetimes separate|explicit tab and specialty cancellation|records 300000/120000 as a 180000 opening|reopens adjustment-only work with 180000" },
};
const mode = process.env.UI_DIAGNOSTIC_MODE, group = process.env.UI_DIAGNOSTIC_GROUP;
const selected = groups[group];
if (process.env.GITHUB_ACTIONS !== "true" || !["baseline", "candidate"].includes(mode) || !selected
  || !/^\d+$/.test(process.env.GITHUB_RUN_ID ?? "") || !/^\d+$/.test(process.env.GITHUB_RUN_ATTEMPT ?? "")
  || !/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? "")) throw new Error("Isolated diagnostic identity missing");
const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }).trim();
const sourceCommit = git("rev-parse", "HEAD"), sourceTree = git("rev-parse", "HEAD^{tree}");
if (sourceCommit !== (mode === "baseline" ? BASELINE : process.env.GITHUB_SHA)) throw new Error("Wrong diagnostic checkout");
execFileSync("git", ["diff", "--exit-code", "HEAD", "--"]);
const toolsRoot = dirname(fileURLToPath(import.meta.url));
const toolCommit = execFileSync("git", ["-C", toolsRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (toolCommit !== process.env.GITHUB_SHA) throw new Error("Wrong diagnostic control source");
const output = resolve(process.env.UI_DIAGNOSTIC_OUTPUT);
if (!output.startsWith(resolve(process.env.RUNNER_TEMP) + "/")) throw new Error("Diagnostic output is not runner-local");
mkdirSync(output, { recursive: false });
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const file = path => { const bytes = readFileSync(path); return { bytes: bytes.length, sha256: sha(bytes) }; };
const url = new URL(process.env.TEST_DATABASE_URL);
if (url.hostname !== "127.0.0.1" || url.pathname !== "/aqlan_p1_test" || url.port !== "5432") throw new Error("Unsafe diagnostic database");
const require = createRequire(resolve("package.json"));
const { Client } = require("pg");
const db = new Client({ connectionString: url.toString(), ssl: false });
await db.connect();
try {
  const { rows: [version] } = await db.query("SELECT current_setting('server_version_num')::int AS version, current_database() AS database");
  if (version.version < 180000 || version.version >= 190000 || version.database !== "aqlan_p1_test") throw new Error("Expected isolated PostgreSQL18");
  const sourcePaths = [...selected.files.map(name => prefix + name), "vitest.config.security.mts",
    "__tests__/security-http/_global-setup.ts", "__tests__/security-http/_ortho-strategy-ui-fixture.ts",
    "components/useClinicalNavigationContext.ts", "components/PatientOrtho.tsx", "app/patients/[id]/page.tsx",
    "lib/patient-navigation.ts", "lib/clinical-navigation-db.ts", "app/api/patients/[id]/clinical-context/route.ts",
    ".github/workflows/ci.yml", "package.json", "package-lock.json"];
  const provenance = { protocol: "AQLAN_UI_FAILURE_DIAGNOSTIC_V1", acceptance: false, mode, group,
    runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT,
    sourceCommit, sourceTree, toolCommit, baseline: BASELINE, postgres: version,
    sources: Object.fromEntries([...new Set(sourcePaths)].map(path => [path, { ...file(path), blob: git("rev-parse", `HEAD:${path}`) }])),
    diagnosticTools: Object.fromEntries(["run.mjs", "reporter.mjs"].map(path => [path, file(resolve(toolsRoot, path))])),
    expectedExecutedCount: mode === "baseline" ? selected.baselineCount : selected.candidateCount,
    filter: mode === "baseline" ? selected.pattern : null };
  writeFileSync(resolve(output, "provenance.json"), JSON.stringify(provenance, null, 2) + "\n");
  writeFileSync(resolve(output, "source-tree.txt"), git("ls-tree", "-r", "HEAD") + "\n");
  const args = [resolve("node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.config.security.mts",
    ...selected.files.map(name => prefix + name), "--reporter=verbose", `--reporter=${resolve(toolsRoot, "reporter.mjs")}`];
  if (mode === "baseline") args.push("--testNamePattern", selected.pattern);
  const child = spawn(process.execPath, args, { stdio: "inherit", env: process.env });
  const outcome = await new Promise((resolveOutcome, reject) => {
    child.once("error", reject); child.once("exit", (code, signal) => resolveOutcome({ code, signal }));
  });
  const result = JSON.parse(readFileSync(resolve(output, "results.json"), "utf8"));
  const executed = result.results.filter(row => ["passed", "failed"].includes(row.state));
  const { rows: [cleanup] } = await db.query("SELECT NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'aqlan_sec_http') AS removed");
  const complete = executed.length === provenance.expectedExecutedCount && cleanup.removed === true
    && result.unhandledErrors.length === 0 && ["passed", "failed"].includes(result.reason) && outcome.signal === null;
  const manifest = { ...provenance, outcome, complete, cleanup, reason: result.reason,
    executed: executed.length, failed: executed.filter(row => row.state === "failed").length,
    retained: Object.fromEntries(["provenance.json", "events.jsonl", "results.json", "source-tree.txt"].map(path => [path, file(resolve(output, path))])) };
  writeFileSync(resolve(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  // Preserve the original failing exit status in BOTH trials. Baseline red is
  // diagnostic evidence, never a substitute for mandatory normal CI success.
  process.exitCode = complete ? outcome.code ?? 1 : 1;
} finally { await db.end(); }
