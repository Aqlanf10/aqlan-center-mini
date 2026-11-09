/**
 * M2 slice 96 — the service catalogue, prices and service materials (owner decision G4-3),
 * built application, owned database and server. Synthetic data.
 *
 * Direct API access on the canonical cookie:
 * - the priced list only with finance.service-prices.view (refused, never blanked, for the
 *   documenter); ?catalogue=1 is the documenter's price-free allowlist;
 * - writes only with finance.service-prices.edit, audited; material links by their grants.
 * No request runs DDL.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";

const ARABIC = /[؀-ۿ]/;
const ACCOUNTS = {
  owner: { username: "canon-svj-owner", password: "Canon#SVJOwner1", role: "admin", display: "المالك التجريبي" },
  viewer: { username: "canon-svj-view", password: "Canon#SVJView1", role: "accountant", display: "قارئ الأسعار", grants: { "finance.service-prices.view": true } },
  editor: { username: "canon-svj-edit", password: "Canon#SVJEdit1", role: "reception", display: "محرر الأسعار", grants: { "finance.service-prices.view": true, "finance.service-prices.edit": true } },
  documenter: { username: "canon-svj-doc", password: "Canon#SVJDoc1", role: "doctor", display: "الطبيب الموثّق", grants: { "clinical.visits.document": true } },
  materials: { username: "canon-svj-mat", password: "Canon#SVJMat1", role: "reception", display: "منسق المواد", grants: { "settings.view": true, "settings.operational.edit": true, "finance.cost-prices.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>;
const ctx = { service: 0, item: 0 };

beforeAll(async () => {
  journey = await openCanonicalJourney({
    portOffset: 148, secret: "canonical-services-journey-secret-0123456789abcdef", accounts: ACCOUNTS, ownerKey: "owner",
    async seed(db) {
      ctx.service = (await db.query<{ id: number }>("INSERT INTO services(name,category,price_minor,price_configured,sort_order) VALUES('تنظيف تجريبي','cleaning',4567800,TRUE,9001) RETURNING id")).rows[0].id;
      ctx.item = (await db.query<{ id: number }>("INSERT INTO inventory_items(name,unit,created_by) VALUES('قفازات تجريبية','box','synthetic') RETURNING id")).rows[0].id;
    },
  });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);

it("HTTP: prices only with finance.service-prices.view; the documenter reads only the price-free catalogue", async () => {
  const documenter = await journey.login("documenter");
  const refused = await journey.api("/api/services", documenter.cookie);
  expect(refused.status).toBe(403);
  const refusedText = await refused.text();
  expect(refusedText).toMatch(ARABIC);
  expect(refusedText).not.toContain("4567800");
  const catalogue = await journey.api("/api/services?catalogue=1", documenter.cookie);
  expect(catalogue.status).toBe(200);
  expect(catalogue.headers.get("cache-control") ?? "").toMatch(/no-store/);
  const catalogueText = await catalogue.text();
  expect(catalogueText).not.toMatch(/4567800|price|cost|Quote/i);
  expect(JSON.parse(catalogueText)).toContainEqual({ id: ctx.service, name: "تنظيف تجريبي", category: "cleaning", sortOrder: 9001 });
  const viewer = await journey.login("viewer");
  const priced = await (await journey.api("/api/services", viewer.cookie)).json();
  expect(priced.find((row: { id: number }) => row.id === ctx.service)).toMatchObject({ priceMinor: 4567800, priceIn: expect.any(Object) });
  expect((await journey.api("/api/services?catalogue=1", viewer.cookie)).status).toBe(403);
  expect(await journey.ddlLog()).toEqual([]);
});

it("HTTP: writes by finance.service-prices.edit with audits; material links by their grants; others refused", async () => {
  const viewer = await journey.login("viewer");
  expect((await journey.api(`/api/services/${ctx.service}`, viewer.cookie, { method: "PATCH", body: JSON.stringify({ price: "1" }) })).status).toBe(403);
  const editor = await journey.login("editor");
  const patched = await journey.api(`/api/services/${ctx.service}`, editor.cookie, { method: "PATCH", body: JSON.stringify({ price: "46000" }) });
  expect(patched.status).toBe(200);
  expect((await patched.json()).priceMinor).toBe(4600000);
  const batch = await journey.api("/api/services/prices", editor.cookie, { method: "POST", body: JSON.stringify({ entries: [{ id: ctx.service, price: "47000" }] }) });
  expect([batch.status, await batch.json()]).toEqual([200, { updated: 1 }]);
  const created = await journey.api("/api/services", editor.cookie, { method: "POST", body: JSON.stringify({ name: "خدمة تجريبية جديدة", category: "perio", price: "15000" }) });
  expect(created.status).toBe(201);
  const missing = await journey.api("/api/services/999999", editor.cookie, { method: "PATCH", body: JSON.stringify({ price: "1" }) });
  expect([missing.status, (await missing.json()).code]).toEqual([404, "service_not_found"]);
  const audits = await journey.db.query<{ action: string; actor: string }>(
    "SELECT action, actor FROM audit_log WHERE action IN ('service.update','service.prices.batch','services.price_batch','service.create') ORDER BY id");
  expect(audits.rows).toEqual([
    { action: "service.update", actor: "canon-svj-edit" }, { action: "services.price_batch", actor: "canon-svj-edit" },
    { action: "service.prices.batch", actor: "canon-svj-edit" }, { action: "service.create", actor: "canon-svj-edit" },
  ]);

  expect((await journey.api("/api/service-materials", editor.cookie, { method: "POST", body: JSON.stringify({ serviceId: ctx.service, itemId: ctx.item, qtyPerUnit: 1 }) })).status).toBe(403);
  const materials = await journey.login("materials");
  const link = await journey.api("/api/service-materials", materials.cookie, { method: "POST", body: JSON.stringify({ serviceId: ctx.service, itemId: ctx.item, qtyPerUnit: 2 }) });
  expect(link.status).toBe(201);
  const linkId = (await link.json()).id as number;
  const rows = await (await journey.api(`/api/service-materials?serviceId=${ctx.service}`, materials.cookie)).json();
  expect(rows).toEqual([expect.objectContaining({ id: linkId, qtyPerUnit: 2, createdBy: "canon-svj-mat" })]);
  expect((await journey.api(`/api/service-materials?id=${linkId}`, materials.cookie, { method: "DELETE" })).status).toBe(200);
  expect((await journey.api("/api/service-materials", viewer.cookie)).status).toBe(403);
  expect(await journey.ddlLog()).toEqual([]);
});
