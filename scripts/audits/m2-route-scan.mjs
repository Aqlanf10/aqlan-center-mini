// Source scans for the M2 route → capability map (Dot review 6480538845 items 2 and 3).
// Lexical evidence only: a hit names a request-body branch or a role-dependent read that
// the map must describe; it never proves semantic coverage on its own.
// `node scripts/audits/m2-route-scan.mjs --write` regenerates the projection inventory.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { discoverPagesApi } from "./pages-api-inventory.mjs";
const root = new URL("../../", import.meta.url);
const read = path => fs.readFileSync(new URL(path, root), "utf8");
const routeFile = route => `app${route}/route.ts`;
const exists = path => fs.existsSync(new URL(path, root));
function handler(src, method) {
  const start = src.indexOf(`export async function ${method}`);
  if (start < 0) return "";
  const next = src.indexOf("\nexport async function", start + 10);
  return src.slice(start, next > 0 ? next : src.length);
}
function bodyFor(route, method) {
  const file = routeFile(route);
  const pages = discoverPagesApi(fileURLToPath(root));
  if (pages.issues.length) throw new Error("Pages API source issues require review");
  const matches = pages.entries.filter(entry => entry.route === route);
  if (matches.length > 1 || (matches.length && exists(file))) throw new Error(`Duplicate API route: ${route}`);
  if (matches.length) return matches[0].methods[method] ?? "";
  return exists(file) ? handler(read(file), method) : "";
}
const TYPEOF_RESULTS = new Set(["string", "number", "boolean", "object", "undefined", "function", "bigint", "symbol"]);
/** Request-body discriminators: `<name> === "<value>"` for action/op/mode/decision in a handler. */
export function scanBranches(route, method) {
  const body = bodyFor(route, method);
  const found = {};
  for (const m of body.matchAll(/\b(action|op|mode|decision)\s*===?\s*"([a-z_]+)"/g)) {
    // `typeof source.action === "string"` is a type check, not a branch.
    if (TYPEOF_RESULTS.has(m[2])) continue;
    (found[m[1]] ??= new Set()).add(m[2]);
  }
  return Object.fromEntries(Object.entries(found).map(([k, v]) => [k, [...v].sort()]));
}
/** Role-dependent signals inside a GET handler: legacy role labels, role helpers and legacy permission flags. */
export function scanProjectionSignals(route) {
  const body = bodyFor(route, "GET");
  const hits = new Set();
  for (const m of body.matchAll(/(isAdmin\(|canViewMoney\(|canHandleMoney\(|isRestrictedRole\(|role\s*[!=]==?\s*"[a-z]+"|permissions\?\.\w+|financeAccess)/g)) hits.add(m[1].replace(/\s+/g, " "));
  return [...hits].sort();
}
export function projectionInventory(map) {
  const routes = [...new Set(map.filter(r => r.method === "GET" && !["excluded", "entry"].includes(r.status)).map(r => r.route))].sort();
  return Object.fromEntries(routes.map(route => [route, scanProjectionSignals(route)]).filter(([, hits]) => hits.length > 0));
}
if (process.argv.includes("--write")) {
  const map = JSON.parse(read("docs/security/staff-cutover/M2_ROUTE_CAPABILITY_MAP.json"));
  fs.writeFileSync(new URL("docs/security/staff-cutover/M2_PROJECTION_INVENTORY.json", root), `${JSON.stringify(projectionInventory(map), null, 1)}\n`);
}
