// Target guard shared by every harness entry point. It imports no runtime code, so a helper can call it
// before it loads either runtime. Synthetic proof only: every connection must be a loopback PostgreSQL URL,
// and the inherited environment that could reroute a connection (libpq PG* variables, the runtime's other
// database URL names, platform identities) is removed before any runtime module is loaded.
import { spawnSync } from "node:child_process";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
// Runtime and gate database URL names (lib/verification-target-policy.mjs) other than DATABASE_URL, plus libpq.
const REROUTING = ["POSTGRES_URL", "POSTGRES_PRISMA_URL", "POSTGRES_URL_NON_POOLING", "TEST_DATABASE_URL", "SOURCE_DATABASE_URL",
  "PGHOST", "PGHOSTADDR", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD", "PGSERVICE", "PGSERVICEFILE", "PGPASSFILE", "PGOPTIONS",
  "PGSSLMODE", "PGTARGETSESSIONATTRS", "USE_LOCAL_DB"];
const PLATFORM_PREFIXES = ["RAILWAY_", "VERCEL_"];

export const DEPLOYED_COMMIT = "f2b5eef97047994438729fe8a2da72e214cdf881";
export const CANDIDATE_COMMIT = "c998b435306f8295a217e49f20080293c479c359";
export const PROOF_DIR = "docs/review/finance-upgrade-proof";

/** Parses a connection URL and refuses anything that is not a loopback PostgreSQL target.
 * @param {string | undefined} raw @param {string} label @returns {URL} */
export function assertLoopbackUrl(raw, label) {
  if (!raw) throw new Error(`refusing: ${label} is required (synthetic proof only)`);
  let url;
  try { url = new URL(raw); } catch { throw new Error(`refusing: ${label} is not a URL`); }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error(`refusing: ${label} is not a PostgreSQL URL`);
  if (!LOOPBACK.has(url.hostname)) throw new Error(`refusing a non-local database target in ${label}: synthetic proof only`);
  for (const key of url.searchParams.keys()) {
    if (["host", "hostaddr", "service", "options"].includes(key.toLowerCase())) throw new Error(`refusing: ${label} overrides its target with ?${key}=`);
  }
  return url;
}

/** An environment for a child process: rerouting variables removed, DATABASE_URL pinned to a loopback URL.
 * @param {string} databaseUrl @param {Record<string, string | undefined>} [base] @returns {Record<string, string | undefined>} */
export function sanitizedEnv(databaseUrl, base = process.env) {
  assertLoopbackUrl(databaseUrl, "DATABASE_URL");
  /** @type {Record<string, string | undefined>} */
  const env = { ...base };
  for (const name of Object.keys(env)) {
    if (REROUTING.includes(name) || PLATFORM_PREFIXES.some((prefix) => name.startsWith(prefix))) delete env[name];
  }
  return { ...env, DATABASE_URL: databaseUrl, NODE_ENV: "test" };
}

/** Removes rerouting variables from this process (an orchestrator's own pg connections included). */
export function stripReroutingFromProcess() {
  for (const name of Object.keys(process.env)) {
    if (REROUTING.includes(name) || PLATFORM_PREFIXES.some((prefix) => name.startsWith(prefix))) delete process.env[name];
  }
}

/** For directly runnable helpers: validate this process's own DATABASE_URL and strip rerouting variables
 * before any runtime module is imported. */
export function guardHelperProcess() {
  assertLoopbackUrl(process.env.DATABASE_URL, "DATABASE_URL");
  stripReroutingFromProcess();
  process.env.NODE_ENV = "test";
}

/** @param {string} root @param {string[]} args */
const git = (root, args) => {
  const child = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  return { status: child.status, out: (child.stdout ?? "").trim() };
};

/** The deployed checkout must be exactly f2b5eef9 with a clean tree; the candidate checkout must contain
 * c998b435 and differ from it only inside this proof directory (committed or not).
 * @param {string | undefined} oldRoot @param {string | undefined} newRoot */
export function assertRuntimeRoots(oldRoot, newRoot) {
  if (!oldRoot || !newRoot) throw new Error("OLD_ROOT and NEW_ROOT are required");
  const deployedHead = git(oldRoot, ["rev-parse", "HEAD"]).out;
  if (deployedHead !== DEPLOYED_COMMIT) throw new Error(`OLD_ROOT is ${deployedHead || "not a git checkout"}, expected ${DEPLOYED_COMMIT}`);
  const deployedDirty = git(oldRoot, ["status", "--porcelain"]).out;
  if (deployedDirty) throw new Error(`OLD_ROOT has local changes:\n${deployedDirty}`);
  const candidateHead = git(newRoot, ["rev-parse", "HEAD"]).out;
  if (git(newRoot, ["merge-base", "--is-ancestor", CANDIDATE_COMMIT, "HEAD"]).status !== 0) throw new Error(`NEW_ROOT ${candidateHead} does not contain ${CANDIDATE_COMMIT}`);
  const outside = [".", `:(exclude)${PROOF_DIR}`];
  if (git(newRoot, ["diff", "--quiet", CANDIDATE_COMMIT, "--", ...outside]).status !== 0) throw new Error(`NEW_ROOT differs from ${CANDIDATE_COMMIT} outside ${PROOF_DIR}`);
  const untracked = git(newRoot, ["status", "--porcelain", "--", ...outside]).out;
  if (untracked) throw new Error(`NEW_ROOT has changes outside ${PROOF_DIR}:\n${untracked}`);
  return { deployedRuntime: deployedHead, deployedTreeClean: true, candidateCheckout: candidateHead, candidateRuntime: CANDIDATE_COMMIT, candidateRuntimeTreeEqualsCandidate: true };
}
