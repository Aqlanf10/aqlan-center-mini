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
    // A migrated route keeps its admission rule, held to the same catalogue check.
    if (entry.status === "existing" || entry.status === "canonical-done") for (const c of caps) assert.ok(existing.has(c) || ownerOnly.has(c), `${key(entry)} uses unknown ${c}`);
    if (entry.status === "proposed") assert.ok(caps.some(c => !existing.has(c)), `${key(entry)} is marked proposed but uses only existing capabilities`);
    if (["self", "entry", "excluded"].includes(entry.status)) assert.equal(entry.need.length + entry.anyOf.length, 0, key(entry));
    if (entry.scope !== null) assert.ok(["patient", "appointment"].includes(entry.scope), key(entry));
    // No entry may be admitted by a role label alone: every staff route names a capability,
    // a record scope or an explicit non-grant status.
    const branchCaps = Object.values(entry.branches?.values ?? {}).flatMap(rule => rule.need);
    assert.ok(caps.length > 0 || entry.scope !== null || entry.status !== "existing" || (branchCaps.length > 0 && Object.values(entry.branches.values).every(rule => rule.need.length > 0)), `${key(entry)} has no admission rule`);
  }
});

// Dot review 6480538845 items 2 and 3: route+method rows are not enough.
import { projectionInventory, scanBranches } from "./m2-route-scan.mjs";
const doc = fs.readFileSync(new URL("../../docs/security/staff-cutover/M2_ROUTE_CAPABILITY_MAP.md", import.meta.url), "utf8");
const proposed = new Set([...doc.matchAll(/\|\s*[^|\n]+\|\s*`([a-z][a-z.-]+)`\s*\|/g)].map(m => m[1]));
const proposedOwnerOnly = new Set(["clinic.data.import", "clinic.data.export", "clinic.backup.manage", "clinic.reset"]);
const knownName = c => existing.has(c) || ownerOnly.has(c) || proposed.has(c) || proposedOwnerOnly.has(c);
test("every request-body branch has its own requirement; neighbouring branches never share by default", () => {
  for (const entry of map) {
    if (["excluded", "entry"].includes(entry.status) || entry.branchExempt) continue;
    const found = scanBranches(entry.route, entry.method);
    for (const [discriminator, values] of Object.entries(found)) {
      assert.ok(entry.branches, `${key(entry)} branches on ${discriminator} but declares no branches`);
      assert.equal(entry.branches.discriminator, discriminator, `${key(entry)} discriminator`);
      for (const value of values) assert.ok(value in entry.branches.values, `${key(entry)} has no rule for ${discriminator}=${value}`);
    }
  }
  for (const entry of map.filter(e => e.branches)) {
    for (const [value, rule] of Object.entries(entry.branches.values)) for (const c of rule.need) assert.ok(knownName(c), `${key(entry)} ${value} uses unknown ${c}`);
    for (const rule of entry.branches.fields ?? []) for (const c of rule.need) assert.ok(knownName(c), `${key(entry)} field ${rule.field} uses unknown ${c}`);
  }
  // The reviewed example: rejecting a booking request needs its own capability, not booking.
  const booking = map.find(e => key(e) === "PATCH /api/booking-requests/[id]");
  assert.deepEqual(booking.branches.values.reject.need, ["appointments.cancel"]);
  assert.deepEqual(booking.branches.values.confirm.need, ["appointments.create"]);
  assert.deepEqual(booking.need, []);
});
test("role-dependent reads are inventoried, and no GET route is migrated without a declared projection", () => {
  const checkedIn = JSON.parse(fs.readFileSync(new URL("../../docs/security/staff-cutover/M2_PROJECTION_INVENTORY.json", import.meta.url), "utf8"));
  assert.deepEqual(projectionInventory(map), checkedIn, "projection inventory drift: run node scripts/audits/m2-route-scan.mjs --write and review");
  for (const entry of map.filter(e => e.method === "GET" && e.status === "canonical-done" && e.route in checkedIn)) {
    assert.ok(entry.projection, `${key(entry)} is canonical-done but declares no projection for its legacy signals`);
  }
  const documents = map.find(e => key(e) === "GET /api/patients/[id]/documents");
  assert.match(documents.projection.groups.removed, /never clinical\.xrays\.view alone/);
});
