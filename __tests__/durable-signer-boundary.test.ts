import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { createSessionToken, readSessionToken, signDurableSessionClaims } from "../lib/auth";
import { readVerifiedDurableSession, revalidateVerifiedDurableSession } from "../lib/staff-durable-session";

/**
 * The private durable signer (OWNER_READINESS_AND_ISSUANCE.md §5.4) is reachable only
 * from the transaction-owning issuer. Any other source that names it, reaches lib/auth
 * through a namespace/dynamic import or re-exports it fails here.
 */
const root = join(__dirname, "..");
const SIGNER = "signDurableSessionClaims";
const ALLOWED = new Set(["lib/auth.ts", "lib/staff-durable-issuer.ts"]);
const SCANNED = ["app", "components", "lib", "scripts", "proxy.ts"];
function sources(path: string): string[] {
 const absolute = join(root, path);
 if (!statSync(absolute, { throwIfNoEntry: false })) return [];
 if (statSync(absolute).isFile()) return /\.(c|m)?(t|j)sx?$/.test(path) ? [path] : [];
 return readdirSync(absolute).flatMap(entry => entry === "node_modules" || entry.startsWith(".") ? [] : sources(join(path, entry)));
}
const authSpecifier = (value: string) => /(^|\/)lib\/auth$|^\.\.?\/auth$|^@\/lib\/auth$/.test(value);

describe("private durable signer boundary", () => {
 it("only the issuer names, imports or re-exports the signer; lib/auth is never namespace/dynamic-imported", () => {
  const violations: string[] = [];
  for (const file of SCANNED.flatMap(sources)) {
   const rel = relative(root, join(root, file)).replaceAll("\\", "/");
   const text = readFileSync(join(root, file), "utf8");
   // Cheap prefilter: only sources that could name the signer or reach lib/auth indirectly are parsed.
   if (!text.includes(SIGNER) && !/import\s*\*|import\s*\(|export\s*\*/.test(text)) continue;
   const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
   const visit = (node: ts.Node): void => {
    if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isPrivateIdentifier(node)) && node.text.includes(SIGNER) && !ALLOWED.has(rel)) violations.push(`${rel}: names ${SIGNER}`);
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && authSpecifier(node.moduleSpecifier.text)
     && node.importClause?.namedBindings && ts.isNamespaceImport(node.importClause.namedBindings)) violations.push(`${rel}: namespace import of lib/auth`);
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && authSpecifier(node.moduleSpecifier.text)
     && (!node.exportClause || ts.isNamespaceExport(node.exportClause))) violations.push(`${rel}: wildcard re-export of lib/auth`);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && authSpecifier(node.arguments[0].text)) violations.push(`${rel}: dynamic import of lib/auth`);
    ts.forEachChild(node, visit);
   };
   visit(source);
  }
  expect(violations).toEqual([]);
 }, 60_000);

 it("the issuer is itself imported only by the login route", () => {
  const importers = SCANNED.flatMap(sources).filter(file => /from\s+["'](?:@\/lib|\.{1,2}(?:\/[\w.-]+)*)\/staff-durable-issuer["']|import\s*\(\s*["'][^"']*staff-durable-issuer["']/.test(readFileSync(join(root, file), "utf8")) && file !== "lib/staff-durable-issuer.ts");
  expect(importers.map(f => f.replaceAll("\\", "/")).sort()).toEqual(["app/api/auth/login/route.ts"]);
 });
});

describe("private durable signer shape", () => {
 const claims = () => ({
  userId: 2, username: "synthetic", expiresAt: Date.now() + 60_000,
  durableIdentity: { schemaVersion: 2, policyVersion: 4, realmId: "11111111-1111-4111-8111-111111111111", subjectId: "22222222-2222-4222-8222-222222222222",
   generationId: "33333333-3333-4333-8333-333333333333", registryRevision: "4", controlEpoch: "2", accountEpoch: "3", permissionRevision: 1,
   credentialVersion: "a".repeat(43), provider: null },
 });
 it("signs exactly the strict durable shape, which only the durable parser accepts", () => {
  const token = signDurableSessionClaims(claims());
  const handle = readVerifiedDurableSession(token);
  expect(handle).not.toBeNull();
  expect(revalidateVerifiedDurableSession(handle!)?.durableIdentity.subjectId).toBe("22222222-2222-4222-8222-222222222222");
  expect(readSessionToken(token)).toBeNull();
 });
 it.each([
  ["legacy role", (c: ReturnType<typeof claims>) => ({ ...c, role: "admin" })],
  ["extra identity field", (c: ReturnType<typeof claims>) => ({ ...c, durableIdentity: { ...c.durableIdentity, role: "admin" } })],
  ["missing identity field", (c: ReturnType<typeof claims>) => { const { provider: _p, ...rest } = c.durableIdentity; return { ...c, durableIdentity: rest }; }],
  ["missing username", (c: ReturnType<typeof claims>) => { const { username: _u, ...rest } = c; return rest; }],
  ["array identity", (c: ReturnType<typeof claims>) => ({ ...c, durableIdentity: [] })],
 ])("refuses %s", (_label, mutate) => {
  expect(() => signDurableSessionClaims(mutate(claims()))).toThrow("DURABLE_SESSION_SHAPE_INVALID");
 });
 it("legacy issuance still refuses canonical markers", () => {
  expect(() => createSessionToken({ ...claims(), role: "admin" } as never)).toThrow("CANONICAL_SESSION_ISSUANCE_UNSUPPORTED");
 });
});
