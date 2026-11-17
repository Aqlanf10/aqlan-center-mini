import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SQL_NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;
const HISTORICAL_0079 = "5603226d149a9be0635d4e99eeaff606d5cc881ce1552b56bf7fbad203044c99";
const isSafeRelative = (name) => typeof name === "string" && name !== "" && !name.includes("\\")
  && !path.posix.isAbsolute(name) && name.split("/").every((part) => part !== "" && part !== "." && part !== "..");
const fail = (code) => { throw new Error(code); };
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Parse the actual checked-in declaration; reject nonliteral/ambiguous lists.
// Do not maintain a duplicate allowlist that might silently lag the provenance gate.
function parsePreflightList(source) {
  const tree = ts.createSourceFile("preflight-provenance.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (tree.parseDiagnostics.length) fail("INVALID_PREFLIGHT_LIST");
  const declarations = [];
  for (const statement of tree.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === "PREFLIGHT_SOURCE_FILES") declarations.push(declaration);
    }
  }
  if (declarations.length !== 1) fail("INVALID_PREFLIGHT_LIST");
  let value = declarations[0].initializer;
  if (value && ts.isAsExpression(value)) value = value.expression;
  if (!value || !ts.isArrayLiteralExpression(value) || value.elements.some((item) => !ts.isStringLiteral(item))) fail("INVALID_PREFLIGHT_LIST");
  const names = value.elements.map((item) => item.text);
  if (!names.length || names.some((name) => !isSafeRelative(name)) || new Set(names).size !== names.length) fail("INVALID_PREFLIGHT_LIST");
  return names;
}

async function readPlain(root, name) {
  if (!isSafeRelative(name)) fail("INVALID_PATH");
  const parts = name.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const entry = await lstat(path.join(root, ...parts.slice(0, i))).catch(() => fail("REQUIRED_FILE_MISSING"));
    if (entry.isSymbolicLink() || (i < parts.length ? !entry.isDirectory() : !entry.isFile())) fail("REQUIRED_FILE_NOT_REGULAR");
  }
  return readFile(path.join(root, ...parts));
}

/** Verify source-derived assets and reject unexpected raw files, without reading them. */
export async function verifyStandaloneAssets(projectRoot, standaloneRoot) {
  const project = path.resolve(projectRoot), bundle = path.resolve(standaloneRoot);
  const provenance = await readPlain(project, "lib/preflight-provenance.ts");
  const preflight = parsePreflightList(provenance.toString("utf8"));
  const sourceEntries = await readdir(path.join(project, "migrations"), { withFileTypes: true });
  const migrations = sourceEntries.filter((entry) => SQL_NAME.test(entry.name)).map((entry) => entry.name).sort();
  if (!migrations.length || !migrations[0].startsWith("0001_") || new Set(migrations.map((name) => name.slice(0, 4))).size !== migrations.length) fail("INVALID_MIGRATION_CATALOG");
  const old = migrations.find((name) => name.startsWith("0079_"));
  if (old !== "0079_ortho_followup_coverage.sql" || digest(await readPlain(project, `migrations/${old}`)) !== HISTORICAL_0079) fail("INVALID_HISTORICAL_0079");

  const allowed = new Set(["server.js", "package.json", ...preflight, ...migrations.map((name) => `migrations/${name}`)]);
  for (const name of ["server.js", "package.json"]) await readPlain(bundle, name);
  const [buildId, shippedId] = await Promise.all([readPlain(project, ".next/BUILD_ID"), readPlain(bundle, ".next/BUILD_ID")]);
  if (!buildId.toString("utf8").trim() || !buildId.equals(shippedId)) fail("BUILD_ID_MISMATCH");
  const serverDir = await lstat(path.join(bundle, ".next/server")).catch(() => fail("REQUIRED_FILE_MISSING"));
  if (!serverDir.isDirectory() || serverDir.isSymbolicLink()) fail("REQUIRED_FILE_NOT_REGULAR");
  for (const name of [...preflight, ...migrations.map((file) => `migrations/${file}`)]) {
    const [source, shipped] = await Promise.all([readPlain(project, name), readPlain(bundle, name)]);
    if (digest(source) !== digest(shipped)) fail("SHIPPED_ASSET_MISMATCH");
  }

  // Only these roots are opaque generated/runtime trees; their contents are
  // separately covered by existing build/third-party verifiers. Never follow
  // symlinks or read unexpected files while checking raw root-level material.
  const opaque = new Set([".next", "node_modules", "public"]);
  const queue = [""];
  while (queue.length) {
    const relative = queue.pop();
    const entries = await readdir(path.join(bundle, relative), { withFileTypes: true });
    for (const entry of entries) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (!isSafeRelative(name)) fail("INVALID_PATH");
      if (entry.isSymbolicLink()) fail("UNEXPECTED_RAW_ENTRY");
      if (entry.isDirectory()) {
        if (relative === "" && opaque.has(entry.name)) continue;
        if (![...allowed].some((file) => file.startsWith(`${name}/`))) fail("UNEXPECTED_RAW_ENTRY");
        queue.push(name);
      } else if (!entry.isFile() || !allowed.has(name)) fail("UNEXPECTED_RAW_ENTRY");
    }
  }
  // Check names in generated trees as well, without following links or opening
  // file contents. These exact markers belong to the synthetic build probe.
  for (const tree of opaque) {
    const pending = [tree];
    while (pending.length) {
      const current = pending.pop();
      let entries;
      try { entries = await readdir(path.join(bundle, current), { withFileTypes: true }); }
      catch (error) { if (error.code === "ENOENT" && current === tree) continue; throw error; }
      for (const entry of entries) {
        if (/synthetic-trace-(?:data|witness|probe)/i.test(entry.name)) fail("SYNTHETIC_TRACE_MARKER");
        if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(`${current}/${entry.name}`);
      }
    }
  }
  return { migrationCount: migrations.length, preflightSourceCount: preflight.length };
}

const ownFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === ownFile) {
  if (process.argv.length !== 2) { console.error("INVALID_ARGUMENTS"); process.exitCode = 1; }
  else {
    const root = path.resolve(path.dirname(ownFile), "..");
    try {
      const result = await verifyStandaloneAssets(root, path.join(root, ".next/standalone"));
      console.log(`Standalone verified: ${result.migrationCount} migrations, ${result.preflightSourceCount} provenance sources.`);
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
