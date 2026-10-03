import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
export function runAuditJson(production = false) {
  const result = spawnSync("npm", ["audit", "--json", "--audit-level=moderate", "--registry=https://registry.npmjs.org", ...(production ? ["--omit=dev"] : []), "--fetch-timeout=120000", "--fetch-retries=0"],
    { encoding: "utf8", shell: false, timeout: 150_000, maxBuffer: 16 * 1024 * 1024 });
  let report = null;
  try { report = JSON.parse(result.stdout ?? ""); } catch { /* Missing/malformed output fails closed. */ }
  return { code: result.status, signal: result.signal, error: result.error, report, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
export async function preserveRawAudit(run, production, attempt, root = process.cwd()) {
  console.log(`----- RAW npm audit ${production ? "--omit=dev " : ""}(attempt ${attempt}; exit ${run.code}) -----`);
  console.log(run.stdout); // Exact, unredacted vulnerability report; no count subtraction.
  if (run.stderr) console.error(run.stderr);
  await mkdir(path.join(root, ".dependency-audit"), { recursive: true });
  const prefix = path.join(root, `.dependency-audit/${production ? "production" : "full"}-attempt-${attempt}`);
  await writeFile(`${prefix}.json`, run.stdout);
  await writeFile(`${prefix}.stderr.txt`, run.stderr);
  await writeFile(`${prefix}.process.json`, JSON.stringify({ checkedAt: new Date().toISOString(), code: run.code, signal: run.signal, error: run.error === undefined ? null : String(run.error), registry: "https://registry.npmjs.org" }, null, 2) + "\n");
}
