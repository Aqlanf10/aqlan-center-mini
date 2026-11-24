import { afterAll, beforeAll, expect, it } from "vitest";
import { Client } from "pg";
import { reportCsv, reportExcel } from "../../lib/report-export";
import type { ReportResult } from "../../lib/reports-types";
import { authedGet, harness } from "./_server";

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let patientId: number;
const patientName = "SYN REPORT SCHEDULING CONTACT";
const clinical = "SYN-PRIVATE-REPORT-WORK";
const stamp = Date.now();

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl });
  await db.connect();
  const id = async (sql: string, values: unknown[]) => (await db.query<{ id: number }>(sql, values)).rows[0].id;
  patientId = await id("INSERT INTO patients(patient_number, full_name) VALUES ($1,$2) RETURNING id", [`SYN-REPORT-${stamp}`, patientName]);
  const serviceId = await id("INSERT INTO services(name,price_minor,is_active,category) VALUES ($1,91397,true,'general') RETURNING id", [clinical]);
  const visitId = await id("INSERT INTO visits(patient_name,patient_id,status) VALUES ($1,$2,'done') RETURNING id", [patientName, patientId]);
  await db.query("INSERT INTO visit_procedures(visit_id,service_id,quantity,unit_price_minor) VALUES ($1,$2,1,91397)", [visitId, serviceId]);
  const planId = await id("INSERT INTO treatment_plans(patient_id,title,total_minor,base_currency,status,start_date) VALUES ($1,$2,91397,'YER','active',CURRENT_DATE) RETURNING id", [patientId, clinical]);
  await db.query("INSERT INTO plan_items(plan_id,service_name,category,quantity,unit_price_minor,status) VALUES ($1,$2,'general',1,91397,'planned')", [planId, clinical]);
  await db.query(`INSERT INTO patient_referrals(patient_id,to_name,to_specialty,reason,teeth,created_by,kind,doctor_party_id,to_party_id,workflow_state)
    SELECT $1,'SYN REFERRAL DOCTOR','endodontics',$2,'21, 31','secdoctora','internal',a.party_id,b.party_id,'accepted'
    FROM users a,users b WHERE a.username='secdoctora' AND b.username='secdoctorb'`, [patientId, clinical]);
});
afterAll(async () => { await db?.end(); });

it("returns reception filter choices without the clinical catalogue or payment recipients", async () => {
  const path = "/api/reports?report=options";
  const desk = await (await authedGet(path, h.sessions.reception)).json();
  expect(desk.doctors.length).toBeGreaterThan(0);
  expect(desk).toMatchObject({ receivers: [], services: [], methods: [] });
  const admin = await (await authedGet(path, h.sessions.admin)).json();
  expect(admin.services).toContainEqual(expect.objectContaining({ name: clinical }));
});

it.each([
  ["visits", "services", clinical, ["services", "workSource", "invoiceText", "collection"], ["invoiced", "notInvoiced"]],
  ["unscheduled-treatment", "planTitle", clinical, ["planTitle", "consentLabel", "pendingItems", "pendingMinor", "currency"], ["items", "pending"]],
  ["internal-referrals", "teeth", "21, 31", ["teeth", "blocks", "specialty"], []],
] as const)("serves only scheduling data in %s JSON, prints and exported views", async (report, key, marker, forbidden, blockedKpis) => {
  const params = new URLSearchParams({ report, preset: "today", patientId: String(patientId) });
  const path = "/api/reports?" + params;
  const getReport = async (url: string, role: "reception" | "admin") => {
    const response = await authedGet(url, h.sessions[role]);
    expect(response.status).toBe(200);
    return (await response.json()).result as ReportResult;
  };
  const admin = await getReport(path, "admin");
  expect(admin.rows?.find(row => row.patientId === patientId)?.[key]).toBe(marker);
  const desk = await getReport(path, "reception");
  expect(desk.rows?.find(row => row.patientId === patientId)).toMatchObject({ patientName });
  const row = desk.rows!.find(row => row.patientId === patientId)!;
  for (const field of forbidden) {
    expect(row).not.toHaveProperty(field);
    expect(desk.columns?.map(column => column.key)).not.toContain(field);
  }
  for (const blocked of blockedKpis) expect(desk.kpis.some(kpi => kpi.key.startsWith(blocked))).toBe(false);
  const outputs = [
    JSON.stringify(desk),
    reportCsv(desk.columns!, desk.rows!, desk.baseCurrency),
    reportExcel(desk.columns!, desk.rows!, desk.baseCurrency),
  ];
  const print = await authedGet("/print/report?" + params + "&columns=" + key, h.sessions.reception);
  expect(print.status).toBe(200);
  outputs.push(await print.text());
  for (const output of outputs) {
    expect(output).toContain(patientName);
    expect(output).not.toContain(marker);
  }
  if (report === "visits" || report === "unscheduled-treatment") {
    const filtered = await getReport(path + "&specialty=implant&serviceId=2147483647&patientStatus=stopped", "reception");
    expect(filtered.rows).toEqual(desk.rows);
  }
});
