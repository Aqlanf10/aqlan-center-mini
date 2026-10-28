// M2 route → capability map: complete, exact and honest about proposals.
import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
const inventory = JSON.parse(fs.readFileSync(new URL("../../docs/security/staff-cutover/inventory.json", import.meta.url), "utf8"));
const map = JSON.parse(fs.readFileSync(new URL("../../docs/security/staff-cutover/M2_ROUTE_CAPABILITY_MAP.json", import.meta.url), "utf8"));
const catalogue = fs.readFileSync(new URL("../../lib/staff-capability-catalogue.ts", import.meta.url), "utf8");
const block = catalogue.slice(catalogue.indexOf("STAFF_CAPABILITIES = Object.freeze(["), catalogue.indexOf("] as const);"));
const existing = new Set([...block.matchAll(/"([a-z.-]+)"/g)].map(m => m[1]));
const ownerOnly = new Set(["staff.credentials.reset", "staff.clinician-link.change", "staff.role.change", "settings.security.change", "settings.integrations.change"]);
const key = r => `${r.method} ${r.route}`;
test("every staff route held for canonical admission has exactly one map entry", () => {
  const held = inventory.routes.filter(r => r.classification === "staff-legacy-held").map(key).sort();
  const mapped = map.map(key).sort();
  assert.equal(new Set(mapped).size, mapped.length, "duplicate map entries");
  assert.deepEqual(held.filter(k => !mapped.includes(k)), [], "held routes without a map entry");
  const known = new Set(inventory.routes.map(key));
  assert.deepEqual(mapped.filter(k => !known.has(k)), [], "map entries for routes that no longer exist");
});
test("existing entries use only catalogue capabilities; proposals are explicit", () => {
  for (const entry of map) {
    const caps = [...entry.need, ...entry.anyOf];
    assert.ok(["existing", "proposed", "owner-only", "self", "entry", "excluded", "canonical-done"].includes(entry.status), key(entry));
    if (entry.status === "existing") for (const c of caps) assert.ok(existing.has(c) || ownerOnly.has(c), `${key(entry)} uses unknown ${c}`);
    if (entry.status === "proposed") assert.ok(caps.some(c => !existing.has(c)), `${key(entry)} is marked proposed but uses only existing capabilities`);
    if (["self", "entry", "excluded", "canonical-done"].includes(entry.status)) assert.equal(entry.need.length + entry.anyOf.length, 0, key(entry));
    if (entry.scope !== null) assert.ok(["patient", "appointment"].includes(entry.scope), key(entry));
    // No entry may be admitted by a role label alone: every staff route names a capability,
    // a record scope or an explicit non-grant status.
    assert.ok(caps.length > 0 || entry.scope !== null || entry.status !== "existing", `${key(entry)} has no admission rule`);
  }
});
