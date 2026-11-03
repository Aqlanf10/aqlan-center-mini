import { afterAll, beforeAll, expect, it } from "vitest";
import { stubPostgresEnv } from "./_setup";
import { openInventoryPurchaseFixture } from "./_inventory-purchase-fixture";
stubPostgresEnv();
let fixture: Awaited<ReturnType<typeof openInventoryPurchaseFixture>>;
let doctor = 0;
const ids: number[] = [];
beforeAll(async () => {
  fixture = await openInventoryPurchaseFixture();
  doctor = (await fixture.pool.query("INSERT INTO parties(kind,name) VALUES ('doctor','Synthetic category scope doctor') RETURNING id")).rows[0].id;
  for (let i = 0; i < 32; i++) {
    const patient = (await fixture.pool.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES ($1,$2,$3) RETURNING id", [`SYN-CAT-${i}`, `Synthetic category patient ${String(i).padStart(2, "0")}`, i < 31 ? doctor : null])).rows[0].id;
    ids.push(patient);
    // Only explicit category counts: a service name/note is never a classifier.
    await fixture.pool.query("INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,status,clinical_category,note) VALUES ($1,'2026-01-01','10:00','done',$2,'endodontics')", [patient, i >= 29 ? "endodontics" : null]);
    if (i === 29) await fixture.pool.query("INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,status,clinical_category) VALUES ($1,'2026-01-02','10:00','cancelled','endodontics')", [patient]);
  }
});
afterAll(async () => { await fixture?.close(); });
it("filters the entire patient population before pagination and keeps distinct patients and explicit history", async () => {
  const page = await fixture.db.browsePatients({ offset: 0, limit: 1, filter: "all", sort: "name", today: "2026-11-03", appointmentCategory: "endodontics" });
  expect(page.total).toBe(3);
  expect(page.rows.map(row => row.id)).toEqual([ids[29]]);
  const next = await fixture.db.browsePatients({ offset: 1, limit: 1, filter: "all", sort: "name", today: "2026-11-03", appointmentCategory: "endodontics" });
  expect(next.rows.map(row => row.id)).toEqual([ids[30]]);
});
it("composes doctor scope and text search without leaking another patient's category", async () => {
  const scoped = await fixture.db.browsePatients({ offset: 0, limit: 25, filter: "all", sort: "name", today: "2026-11-03", doctorPartyId: doctor, appointmentCategory: "endodontics" });
  expect(scoped.total).toBe(2);
  expect(scoped.rows.map(row => row.id)).toEqual([ids[29], ids[30]]);
  expect((await fixture.db.searchPatients("Synthetic category patient", 20, doctor, "endodontics")).map(row => row.id)).toEqual([ids[29], ids[30]]);
  expect(await fixture.db.searchPatients("Synthetic category patient 31", 20, doctor, "endodontics")).toEqual([]);
  expect(await fixture.db.searchPatients("Synthetic", 20, null, "filling")).toEqual([]);
});
