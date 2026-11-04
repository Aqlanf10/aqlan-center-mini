/**
 * M2 slice 81 — canonical visit ↔ file actions, built application, owned database and
 * server. Synthetic data only.
 *
 * HTTP: the desk links a walk-in to a file (audit) and opens a file from another walk-in
 * (patient.create audit); a queue account without patients.create is refused (403,
 * Arabic); deferring payment stays refused (409, financial group); the remover deletes an
 * unsigned visit (audit) and a signed one is refused (409); an account without
 * visits.delete is refused (403). No DDL.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";

const ARABIC = /[؀-ۿ]/;
const ACCOUNTS = {
  owner: { username: "canon-vf-owner", password: "Canon#VfOwner1", role: "admin", display: "المالك التجريبي" },
  desk: { username: "canon-vf-desk", password: "Canon#VfDesk1", role: "reception", display: "الاستقبال", patientScope: "all",
    grants: { "visits.manage": true, "patients.create": true } },
  queue: { username: "canon-vf-queue", password: "Canon#VfQueue1", role: "reception", display: "الطابور", patientScope: "all",
    grants: { "visits.manage": true } },
  remover: { username: "canon-vf-del", password: "Canon#VfDel1", role: "reception", display: "حذف الزيارات", patientScope: "all",
    grants: { "visits.manage": true, "visits.delete": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>;
const ids = { file: 0, walkIn: 0, fresh: 0, mistaken: 0, signed: 0 };

beforeAll(async () => {
  journey = await openCanonicalJourney({
    portOffset: 138, secret: "canonical-visit-file-journey-secret-0123456789abc", accounts: ACCOUNTS, ownerKey: "owner",
    async seed(db) {
      ids.file = (await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone) VALUES ('SYN-VJ-1','مريض الربط التجريبي','0500000851') RETURNING id")).rows[0].id;
      const visit = async (name: string, phone: string | null) => (await db.query<{ id: number }>("INSERT INTO visits (patient_name, patient_phone) VALUES ($1,$2) RETURNING id", [name, phone])).rows[0].id;
      ids.walkIn = await visit("زائر للربط", null);
      ids.fresh = await visit("زائر جديد", "0500000861");
      ids.mistaken = await visit("زيارة خاطئة", null);
      ids.signed = await visit("زيارة موقعة", null);
      await db.query("UPDATE visits SET signed_at = NOW(), signed_by = 'SYN' WHERE id = $1", [ids.signed]);
    },
  });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);

it("HTTP: link, open file, defer stays refused, delete by its own grant", async () => {
  const patch = (visitId: number, cookie: string, body: Record<string, unknown>) =>
    journey.api(`/api/visits/${visitId}`, cookie, { method: "PATCH", body: JSON.stringify(body) });
  const desk = await journey.login("desk");
  const linked = await patch(ids.walkIn, desk.cookie, { action: "link", patientId: ids.file });
  expect(linked.status).toBe(200);
  expect(linked.headers.get("cache-control")).toContain("no-store");
  expect(await linked.json()).toEqual({ ok: true, patientName: "مريض الربط التجريبي" });
  const opened = await patch(ids.fresh, desk.cookie, { action: "open_file" });
  expect(opened.status).toBe(200);
  const created = await opened.json();
  expect(created).toMatchObject({ ok: true, created: true });
  expect((await journey.db.query("SELECT action, actor FROM audit_log WHERE action IN ('visit.link','patient.create') ORDER BY id")).rows)
    .toEqual([{ action: "visit.link", actor: "canon-vf-desk" }, { action: "patient.create", actor: "canon-vf-desk" }]);

  const queue = await journey.login("queue");
  const denied = await patch(ids.mistaken, queue.cookie, { action: "open_file" });
  expect(denied.status).toBe(403);
  expect((await denied.json()).message).toMatch(ARABIC);
  const deferred = await patch(ids.signed, desk.cookie, { action: "defer" });
  expect(deferred.status).toBe(409);
  expect((await deferred.json()).message).toMatch(ARABIC);

  const noGrant = await journey.api(`/api/visits/${ids.mistaken}`, desk.cookie, { method: "DELETE", body: JSON.stringify({}) });
  expect(noGrant.status).toBe(403);
  expect((await noGrant.json()).message).toMatch(ARABIC);
  const remover = await journey.login("remover");
  const removed = await journey.api(`/api/visits/${ids.mistaken}`, remover.cookie, { method: "DELETE", body: JSON.stringify({ reason: "تسجيل خاطئ" }) });
  expect(removed.status).toBe(200);
  const signed = await journey.api(`/api/visits/${ids.signed}`, remover.cookie, { method: "DELETE", body: JSON.stringify({}) });
  expect(signed.status).toBe(409);
  expect((await signed.json()).message).toMatch(ARABIC);
  expect((await journey.db.query("SELECT id FROM visits WHERE id = ANY($1::int[]) ORDER BY id", [[ids.mistaken, ids.signed]])).rows.map(row => row.id)).toEqual([ids.signed]);
  expect((await journey.db.query("SELECT actor FROM audit_log WHERE action='visit.delete' AND entity_id=$1::text", [ids.mistaken])).rows.map(row => row.actor)).toEqual(["canon-vf-del"]);
  expect(await journey.ddlLog()).toEqual([]);
});
