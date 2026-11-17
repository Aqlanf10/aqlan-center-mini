import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const preload = fileURLToPath(new URL("./fixtures/raw-restore-io-probe.mjs", import.meta.url));
const script = fileURLToPath(new URL("../scripts/restore.mjs", import.meta.url));
const archive = path.resolve(root, "SYNTHETIC-NO-ARCHIVE-READ.sql");
const envFile = path.resolve(root, ".env.local");
const message = "الاستعادة من SQL الخام معطّلة مؤقتًا؛ لم يُقرأ ملف النسخة ولم يُفتح اتصال بالهدف.";
const env = { PATH: process.env.PATH, NODE_OPTIONS: "", NODE_ENV: "test" as const,
  SYNTHETIC_ARCHIVE_PATH: archive, SYNTHETIC_ENV_PATH: envFile };

function run(args: string[], extraEnv: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, ["--import", preload, ...args], {
    cwd: root, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 15_000,
  });
}

it.each([
  ["archive read", "require('node:fs').readFileSync(process.env.SYNTHETIC_ARCHIVE_PATH)", "SYNTHETIC_FILE_IO_BLOCKED"],
  ["environment lookup", "require('node:fs').existsSync(process.env.SYNTHETIC_ENV_PATH)", "SYNTHETIC_FILE_IO_BLOCKED"],
  ["network", "require('node:net').connect({host:'127.0.0.1',port:1})", "SYNTHETIC_NETWORK_BLOCKED"],
  ["PostgreSQL client", "import('pg').then(({Client})=>new Client())", "SYNTHETIC_PG_CLIENT_BLOCKED"],
])("the synthetic probe actually blocks %s", (_name, code, marker) => {
  const result = run(["-e", code]);
  expect(result.error).toBeUndefined();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(marker);
});

it("keeps the legacy importer unreachable when process.exit is replaced", () => {
  const result = run(["--input-type=module", "-e", "process.exit=()=>{}; await import('./scripts/restore.mjs')"], {
    DATABASE_URL: "postgresql://synthetic:synthetic@127.0.0.1:1/aqlan_backup_precision_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr.trim()).toBe(message);
});

it.each([
  { name: "no inputs", args: [], extra: {} },
  { name: "archive and target", args: [archive], extra: { DATABASE_URL: "postgresql://synthetic:synthetic@127.0.0.1:1/aqlan_backup_precision_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } },
  { name: "options and attempted override", args: [archive, "--allow-non-empty-target"], extra: { DATABASE_URL: "postgresql://synthetic:synthetic@127.0.0.1:1/aqlan_backup_precision_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", RAW_RESTORE_ENABLED: "true" } },
  { name: "help", args: ["--help"], extra: {} },
])("refuses $name before archive/env access or Client", ({ args, extra }) => {
  const result = run([script, ...args], extra);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr.trim()).toBe(message);
});
