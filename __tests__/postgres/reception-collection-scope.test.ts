import { afterAll, beforeAll, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

assertRealPostgresUrl();
stubPostgresEnv();
const { ensureSchema, getPool, insertAuditRow, resetPoolForTesting } = await import("../../lib/db");
const { CollectionScopeDenied, receptionCollectionAllowed, requireCollectionScope } = await import("../../lib/reception-collection-scope");
const timeZone = "Asia/Aden";
const collector = "synthetic-collector";
let patientId: number;
let collectorId: number;
const number = "TEST-DESK-A";
beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  const db = getPool();
  const accounts = await db.query("INSERT INTO users(username, display_name, password_hash, role) VALUES($1,'TEST','unused','reception'), ('synthetic-peer','TEST','unused','reception') RETURNING id, username", [collector]);
  collectorId = accounts.rows.find(row => row.username === collector).id;
  patientId = (await db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Test Collection') RETURNING id", [number])).rows[0].id;
});
afterAll(resetPoolForTesting);

it("limits visit and appointment admission to the clinic date and a current status", async () => {
  const db = getPool();
  const allowed = () => receptionCollectionAllowed(db, patientId, collector, timeZone, true);
  expect(await allowed()).toBe(false);
  const visit = (await db.query("INSERT INTO visits(patient_name,patient_id,arrived_at) VALUES('TEST',$1,now()-interval '1 day') RETURNING id", [patientId])).rows[0].id;
  expect(await allowed()).toBe(false);
  await db.query("UPDATE visits SET arrived_at=now() WHERE id=$1", [visit]);
  expect(await allowed()).toBe(true);
  await db.query("UPDATE visits SET status='cancelled' WHERE id=$1", [visit]);
  expect(await allowed()).toBe(false);
  const appointment = (await db.query("INSERT INTO appointments(patient_id,scheduled_date,scheduled_time) VALUES($1,(now() AT TIME ZONE $2)::date,'09:00') RETURNING id", [patientId,timeZone])).rows[0].id;
  expect(await allowed()).toBe(true);
  await db.query("UPDATE appointments SET scheduled_date=scheduled_date+1 WHERE id=$1", [appointment]);
  expect(await allowed()).toBe(false);
  await db.query("UPDATE appointments SET scheduled_date=scheduled_date-1,status='cancelled' WHERE id=$1", [appointment]);
  expect(await allowed()).toBe(false);
});

it("applies a grant only to the named active collector and honours a committed revocation", async () => {
  const db = getPool();
  const decision = (action: "collection.assign" | "collection.revoke") => insertAuditRow(db, {
    action, entity: "patient", entityId: patientId, actorRole: "admin", actor: "synthetic-supervisor",
    details: { collectorId, patientNumber: number },
  });
  await decision("collection.assign");
  expect(await receptionCollectionAllowed(db, patientId, "synthetic-peer", timeZone)).toBe(false);
  expect(await receptionCollectionAllowed(db, patientId + 1, collector, timeZone)).toBe(false);
  await expect(requireCollectionScope(db, "reception", patientId, collector, timeZone)).resolves.toBeUndefined();
  await db.query("UPDATE users SET is_active=false WHERE id=$1", [collectorId]);
  expect(await receptionCollectionAllowed(db, patientId, collector, timeZone)).toBe(false);
  await db.query("UPDATE users SET is_active=true WHERE id=$1", [collectorId]);
  await decision("collection.revoke");
  await expect(requireCollectionScope(db, "reception", patientId, collector, timeZone)).rejects.toBeInstanceOf(CollectionScopeDenied);
});
