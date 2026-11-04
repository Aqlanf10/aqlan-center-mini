/** M2 slice 84: the canonical visit cockpit read and lab receipt read on real PostgreSQL,
 * synthetic data only. A clinical grant inside the scope by the queue read's condition;
 * the money group only with finance.invoices.view or the protected owner (omitted, never
 * zeroed); ortho only with clinical.ortho.view; an unlinked visit's phone-matched file
 * outside the scope contributes nothing; the receipt read needs clinical.lab.order. */
vi.mock("server-only", () => ({}));
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-visit-clinical-secret-84");
const db = await import("../../lib/db");
const cockpit = await import("../../lib/canonical-visit-clinical");

const ACCOUNTS = {
  owner: { username: "SYN-VC-OWNER", role: "admin" },
  doctor: { username: "SYN-VC-DR", role: "doctor", doctor: true, patientScope: "own", grants: { "clinical.visits.document": true, "clinical.lab.view": true, "clinical.lab.order": true } },
  biller: { username: "SYN-VC-BILL", role: "reception", patientScope: "all", grants: { "clinical.visits.document": true, "finance.invoices.view": true } },
  orthoist: { username: "SYN-VC-ORTHO", role: "assistant", patientScope: "all", grants: { "clinical.visits.document": true, "clinical.ortho.view": true } },
  front: { username: "SYN-VC-FRONT", role: "reception", patientScope: "all", grants: { "appointments.create": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; status?: number }) => error);
const ids = { mine: 0, other: 0, visit: 0, walkIn: 0, otherVisit: 0, service: 0 };
const PRICE = 43219;
const MONEY = /unitPriceMinor|totalMinor|planCurrency|billingCurrency|invoiceId|invoiceReferenceState|planWarning|sessionPricing|labSignVersion|billingRule|adjustmentBillingClass|43219/;

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  const patient = async (number: string, phone: string, doctor: number | null) =>
    (await q("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES ($1,$2,$3,$4) RETURNING id", [number, `SYN VC ${number}`, phone, doctor]))[0].id as number;
  ids.mine = await patient("SYN-VC-1", "0500000841", fx.parties.doctor!);
  ids.other = await patient("SYN-VC-2", "0500000842", null);
  ids.service = (await q("INSERT INTO services(name,price_minor,is_active,price_configured,category) VALUES('SYN VC filling',$1,TRUE,TRUE,'restorative') RETURNING id", [PRICE]))[0].id;
  ids.visit = (await q("INSERT INTO visits (patient_name, patient_id, doctor_id, chief_complaint) VALUES ('SYN VC 1', $1, $2, 'ألم اصطناعي') RETURNING id", [ids.mine, fx.parties.doctor!]))[0].id;
  await q("INSERT INTO visit_procedures (visit_id, service_id, quantity, unit_price_minor, tooth_code) VALUES ($1,$2,1,$3,16)", [ids.visit, ids.service, PRICE]);
  // The other file: a signed earlier visit with a private finding, and its own open visit.
  await q("INSERT INTO visits (patient_name, patient_id, diagnosis, signed_at, signed_by, arrived_at) VALUES ('SYN VC 2', $1, 'SYN-PRIVATE-FINDING', now() - interval '3 days', 'SYN', now() - interval '3 days')", [ids.other]);
  await q("INSERT INTO clinical_cases (patient_id, specialty, title, status, created_by) VALUES ($1,'endodontics','SYN-PRIVATE-CASE','active','SYN')", [ids.other]);
  ids.otherVisit = (await q("INSERT INTO visits (patient_name, patient_id) VALUES ('SYN VC 2', $1) RETURNING id", [ids.other]))[0].id;
  // A walk-in assigned to the doctor, unlinked, whose phone matches the other file.
  ids.walkIn = (await q("INSERT INTO visits (patient_name, patient_phone, doctor_id) VALUES ('SYN VC walk-in', '0500000842', $1) RETURNING id", [fx.parties.doctor!]))[0].id;
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("visit cockpit read", () => {
  it("the owner reads the legacy composite unchanged (nothing dropped by the allowlist)", async () => {
    const legacy = await db.getClinicalVisit(ids.visit, { actorPartyId: null });
    const canonical = await cockpit.readCanonicalVisitClinical(await fx.session("owner"), ids.visit);
    // Slice 87 adds one clinical field, the money-free lab review fence; everything else is the legacy composite.
    const { labReviewVersion, ...rest } = JSON.parse(JSON.stringify(canonical));
    expect(labReviewVersion).toMatch(/^[a-f0-9]{64}$/);
    expect(rest).toEqual(JSON.parse(JSON.stringify(legacy)));
    expect(canonical).toMatchObject({ totalMinor: PRICE, procedures: [{ unitPriceMinor: PRICE, totalMinor: PRICE }] });
  });

  it("a clinician without the invoice view sees the work, never its price; the money group is omitted, not zeroed", async () => {
    const read = await cockpit.readCanonicalVisitClinical(await fx.session("doctor"), String(ids.visit)) as Record<string, unknown>;
    expect(read).toMatchObject({ id: ids.visit, patientId: ids.mine, chiefComplaint: "ألم اصطناعي", status: "open" });
    expect(read.procedures).toEqual([expect.objectContaining({ serviceId: ids.service, serviceName: "SYN VC filling", toothCode: 16, quantity: 1 })]);
    expect(JSON.stringify(read)).not.toMatch(MONEY);
    expect(read).not.toHaveProperty("ortho");
  });

  it("finance.invoices.view brings the money group; clinical.ortho.view brings the ortho projection", async () => {
    const billed = await cockpit.readCanonicalVisitClinical(await fx.session("biller"), ids.visit);
    expect(billed).toMatchObject({ totalMinor: PRICE, invoiceId: null, procedures: [{ unitPriceMinor: PRICE }] });
    expect(billed).not.toHaveProperty("ortho");
    const ortho = await cockpit.readCanonicalVisitClinical(await fx.session("orthoist"), ids.visit);
    expect(ortho).toHaveProperty("ortho", null);
    expect(JSON.stringify(ortho)).not.toMatch(MONEY);
  });

  it("outside the scope reads like missing; a walk-in's matched file outside the scope contributes nothing", async () => {
    expect(await refusal(cockpit.readCanonicalVisitClinical(await fx.session("doctor"), ids.otherVisit))).toMatchObject({ code: "patient_not_found" });
    expect(await refusal(cockpit.readCanonicalVisitClinical(await fx.session("doctor"), 2147483000))).toMatchObject({ code: "patient_not_found" });
    expect(await refusal(cockpit.readCanonicalVisitClinical(await fx.session("doctor"), "1e3"))).toMatchObject({ code: "invalid_patient_query" });
    const walkIn = await cockpit.readCanonicalVisitClinical(await fx.session("doctor"), ids.walkIn);
    expect(walkIn).toMatchObject({ id: ids.walkIn, patientId: null, activeCases: [], outstanding: [] });
    expect(JSON.stringify(walkIn)).not.toMatch(/SYN-PRIVATE/);
    // The owner's scope admits the matched file: the legacy preview is kept, as legacy shows it.
    const legacy = await db.getClinicalVisit(ids.walkIn, { actorPartyId: null });
    expect(JSON.stringify(legacy)).toContain("SYN-PRIVATE-CASE");
    const { labReviewVersion: _fence, ...ownerRead } = JSON.parse(JSON.stringify(await cockpit.readCanonicalVisitClinical(await fx.session("owner"), ids.walkIn)));
    expect(ownerRead).toEqual(JSON.parse(JSON.stringify(legacy)));
  });

  it("no clinical grant is refused", async () => {
    expect(await refusal(cockpit.readCanonicalVisitClinical(await fx.session("front"), ids.visit))).not.toBeNull();
  });

  it("the projection filters ortho active cases and keeps clinical lines without the grants", () => {
    const visit = {
      id: 1, procedures: [], outstanding: [{ planItemId: 2, serviceName: "x", unitPriceMinor: 5, billingRule: "per_session", planCurrency: "YER" }],
      activeCases: [{ kind: "ortho", title: "o" }, { kind: "specialty", title: "s" }],
      ortho: { caseId: 3, phase: "p", adjustmentBillingClass: "INCLUDED" },
    } as unknown as Parameters<typeof cockpit.projectCanonicalVisitClinical>[0];
    expect(cockpit.projectCanonicalVisitClinical(visit, { money: false, ortho: false }))
      .toEqual({ id: 1, procedures: [], outstanding: [{ planItemId: 2, serviceName: "x" }], activeCases: [{ kind: "specialty", title: "s" }] });
    expect(cockpit.projectCanonicalVisitClinical(visit, { money: false, ortho: true }))
      .toMatchObject({ activeCases: [{ kind: "ortho" }, { kind: "specialty" }], ortho: { caseId: 3, phase: "p" } });
    expect(cockpit.projectCanonicalVisitClinical(visit, { money: false, ortho: true }).ortho).not.toHaveProperty("adjustmentBillingClass");
  });
});

describe("lab receipt read", () => {
  const key = "syn-vc-receipt-0001", hash = "b".repeat(64);
  it("finds the actor's own receipt for the visit; absent reads as not found", async () => {
    expect((await q("SELECT to_regclass('public.lab_work_commands')::text AS t"))[0].t).toBe("lab_work_commands");
    expect(await cockpit.readCanonicalVisitLabCommand(await fx.session("doctor"), String(ids.visit), key, hash, fx.pool)).toEqual({ found: false });
    await q("INSERT INTO lab_work_commands(actor_user_id,request_key,patient_id,source_kind,source_id,request_hash,result) VALUES($1,$2,$3,'visit',$4,$5,'{\"outcome\":\"rejected\",\"code\":\"stale_intent\"}')",
      [fx.ids.doctor, key, ids.mine, ids.visit, createHash("sha256").update(hash).digest("hex")]);
    expect(await cockpit.readCanonicalVisitLabCommand(await fx.session("doctor"), String(ids.visit), key, hash, fx.pool)).toMatchObject({
      found: true, receipt: { requestKey: key, visitId: ids.visit, patientId: ids.mine, actor: "SYN-VC-DR" }, result: { outcome: "rejected", code: "stale_intent" },
    });
    // Another actor's key is never this actor's receipt.
    expect(await cockpit.readCanonicalVisitLabCommand(await fx.session("owner"), String(ids.visit), key, hash, fx.pool)).toEqual({ found: false });
  });
  it("a mismatched hash is a conflict; outside the scope is missing; without clinical.lab.order it is refused", async () => {
    expect(await refusal(cockpit.readCanonicalVisitLabCommand(await fx.session("doctor"), String(ids.visit), key, "c".repeat(64), fx.pool))).toMatchObject({ code: "idempotency_conflict", status: 409 });
    expect(await refusal(cockpit.readCanonicalVisitLabCommand(await fx.session("doctor"), String(ids.otherVisit), key, hash, fx.pool))).toMatchObject({ code: "visit_not_found", status: 404 });
    expect(await refusal(cockpit.readCanonicalVisitLabCommand(await fx.session("doctor"), String(ids.walkIn), key, hash, fx.pool))).toMatchObject({ code: "visit_not_found", status: 404 });
    expect(await refusal(cockpit.readCanonicalVisitLabCommand(await fx.session("doctor"), String(ids.visit), "short", hash, fx.pool))).toMatchObject({ code: "invalid_command", status: 400 });
    expect(await refusal(cockpit.readCanonicalVisitLabCommand(await fx.session("biller"), String(ids.visit), key, hash, fx.pool))).toMatchObject({ message: expect.stringMatching(/CAPABILITY_DENIED$/) });
  });
});
