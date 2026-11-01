/** Slice 48: real PostgreSQL authority, unchanged commercial lineage, isolated RR. */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { waitForBlockedBy, capabilityDocument } from "./_canonical-ready-fixture";
import { seedCanonicalCoverage } from "../fixtures/canonical-ortho-coverage";
vi.mock("server-only", () => ({}));
assertRealPostgresUrl(); stubPostgresEnv(); vi.stubEnv("SESSION_SECRET", "synthetic-coverage-secret-0123456789abcdef");
const db = await import("../../lib/db"), reads = await import("../../lib/canonical-ortho-coverage"), store = await import("../../lib/ortho-followup-coverage-db");
const GRANTS = { "finance.agreements.manage": true, "finance.patient-ledger.view": true };
const ACCOUNTS = {
  owner: { username: "SYN-COV-OWNER", role: "admin" },
  own: { username: "SYN-COV-OWN", role: "doctor", doctor: true, patientScope: "own", grants: GRANTS },
  all: { username: "SYN-COV-ALL", role: "reception", patientScope: "all", grants: GRANTS },
  invoice: { username: "SYN-COV-INVOICE", role: "reception", patientScope: "all", grants: { ...GRANTS, "finance.invoices.view": true } },
  adjacent: { username: "SYN-COV-ADJACENT", role: "admin", patientScope: "all", grants: { "finance.invoices.view": true, "finance.patient-ledger.view": true, "clinical.ortho.view": true } },
  none: { username: "SYN-COV-NONE", role: "doctor", doctor: true, patientScope: "none", grants: GRANTS },
  unlinked: { username: "SYN-COV-UNLINKED", role: "doctor", patientScope: "own", grants: GRANTS },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>, side: Pool;
const ids = { own: 0, outside: 0 };
let base: Awaited<ReturnType<typeof seedCanonicalCoverage>>;
const episode = (patientId = ids.own, save = true) => seedCanonicalCoverage(fx.pool, { patientId, actorId: fx.ids.owner, doctorId: fx.parties.own!, save });
const read = async (key: Key, f = base) => reads.readCanonicalOrthoCoverage(await fx.session(key), f.patient, f.ortho);
beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner"); side = new Pool({ connectionString: fx.pool.options.connectionString, max: 3 });
  for (const key of ["own", "outside"] as const) ids[key] = (await fx.pool.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,$1,$2) RETURNING id", [`SYN-COV-${key}`, key === "own" ? fx.parties.own! : null])).rows[0].id;
  base = await episode();
}, 180_000);
afterAll(async () => { await side?.end(); await fx?.close(); });
it.each(["own", "all", "owner"] as const)("%s reads the exact saved decision without granting clinical or invoice access", async key => {
  const result = await read(key);
  expect(result).toMatchObject({ projection: "ortho-followup-coverage", enabled: true, applicable: true, current: { id: base.revision, decision: "included", reason: "SYN سبب الاتفاق المحفوظ" } });
  expect(Object.keys(result).sort()).toEqual(["applicable", "current", "enabled", "invoiceSources", "orthoCaseId", "patientId", "projection"]);
  expect(Object.keys(result.current!).sort()).toEqual(["createdAt", "createdBy", "decision", "id", "reason", "version"]);
  expect(JSON.stringify(result)).not.toMatch(/sourceFingerprint|commandId|250000|snapshot|tooth|private clinical|private plan|phone|medical/);
  if (key !== "owner") expect(result.invoiceSources).toEqual({ state: "restricted" });
});
it.each(["none", "unlinked", "adjacent"] as const)("denies %s regardless of legacy role", async key => { await expect(read(key)).rejects.toThrow(/CAPABILITY_DENIED|RECORD_SCOPE_DENIED|PROVIDER/); });
it("invoice details need their independent grant and the owner retains them", async () => {
  for (const key of ["invoice", "owner"] as const) expect((await read(key)).invoiceSources).toEqual({ state: "allowed", items: [{ invoiceId: base.invoice, invoiceNumber: base.source.invoiceNumber, serviceName: "SYN invoice service" }] });
  expect(JSON.stringify(await read("own"))).not.toContain(base.source.invoiceNumber);
});
it("missing, foreign and mismatched patient/case references reveal the same missing record", async () => {
  const foreign = await episode(ids.outside), failures: {code:string;message:string}[] = [];
  for (const [patient, ortho] of [[foreign.patient, foreign.ortho], [ids.own, foreign.ortho], [2147483647, base.ortho], [ids.own, 2147483647]]) {
    try { await reads.readCanonicalOrthoCoverage(await fx.session("own"), patient, ortho); throw new Error("unexpected success"); }
    catch (e) { failures.push({ code: (e as {code:string}).code, message: (e as Error).message }); }
  }
  expect(failures.every(f => f.code === "patient_not_found" && f.message === failures[0].message)).toBe(true);
});
it("no saved decision remains distinct from an excluded decision", async () => { expect(await read("owner", await episode(ids.own, false))).toMatchObject({ enabled: true, current: null, applicable: false }); });
it("unavailable activation remains unavailable, without DDL or an invented exclusion", async () => {
  await fx.pool.query("ALTER TABLE visits DISABLE TRIGGER ortho_followup_visit_manifest");
  try { expect(await read("owner")).toMatchObject({ enabled: false, current: null, applicable: false, invoiceSources: { state: "allowed", items: [] } }); }
  finally { await fx.pool.query("ALTER TABLE visits ENABLE TRIGGER ortho_followup_visit_manifest"); }
});
it("shares the exact legacy commercial fingerprint and valid source selection", async () => {
  const legacy = await store.readFollowupCoverage({ session: { userId: fx.ids.owner, username: "SYN", role: "admin", expiresAt: Date.now() + 30000 }, patientId: base.patient, orthoCaseId: base.ortho });
  const current = await store.readFollowupCoverageSnapshotWith(fx.pool, base.patient, base.ortho);
  expect(current.sources).toEqual(legacy.sources); expect(current.applicable).toBe(legacy.applicable); expect(current.current).toEqual(legacy.current);
});
it.each(["invoice", "plan", "lineage", "site", "origin"])("changed %s source never silently changes the immutable decision", async field => {
  const f = await episode();
  if (field === "invoice") await fx.pool.query("UPDATE invoices SET total_minor=260000 WHERE id=$1", [f.invoice]);
  if (field === "plan") await fx.pool.query("UPDATE treatment_plans SET patient_id=$1 WHERE id=$2", [ids.outside, f.plan]);
  if (field === "lineage") await fx.pool.query("UPDATE invoice_items SET source_id=source_id+100000 WHERE plan_item_id=$1", [f.item]);
  if (field === "site") await fx.pool.query("UPDATE clinical_cases SET site='upper' WHERE id=$1", [f.clinical]);
  if (field === "origin") await fx.pool.query("UPDATE invoices SET status='cancelled' WHERE id=$1", [f.invoice]);
  const result = await read("owner", f); expect(result).toMatchObject({ current: { id: f.revision, decision: "included" }, applicable: false });
  if (field !== "invoice") expect(result.invoiceSources).toEqual({ state: "allowed", items: [] });
});
it("payment and treatment progress do not alter the original commercial applicability rule", async () => {
  const f = await episode();
  const shift = (await fx.pool.query("INSERT INTO cashier_shifts(opened_by,status,closed_at,closed_by) VALUES('SYN','closed',NOW(),'SYN') RETURNING id")).rows[0].id;
  await fx.pool.query("INSERT INTO payments(receipt_number,patient_id,invoice_id,shift_id,kind,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,method,created_by) VALUES($1,$2,$3,$4,'payment',12345,'YER',1,12345,'YER','cash','SYN')", [`SYN-COV-PAY-${f.invoice}`, f.patient, f.invoice, shift]);
  await fx.pool.query("UPDATE plan_items SET status='in_progress' WHERE id=$1", [f.item]);
  expect((await read("owner", f)).applicable).toBe(true);
});
it("same RR connection preserves the prior source when an independent writer changes it", async () => {
  const f = await episode(), original = store.readFollowupCoverageSnapshotWith;
  const spy = vi.spyOn(store, "readFollowupCoverageSnapshotWith").mockImplementationOnce(async (q, patient, ortho) => {
    expect((await q.query("SHOW transaction_isolation")).rows[0].transaction_isolation).toBe("repeatable read");
    expect((await q.query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("on");
    await side.query("UPDATE invoices SET total_minor=260000 WHERE id=$1", [f.invoice]); return original(q, patient, ortho);
  });
  try { expect((await read("owner", f)).applicable).toBe(true); } finally { spy.mockRestore(); }
  expect((await read("owner", f)).applicable).toBe(false);
});
it("scope removal is snapshot-consistent and denied on the next read", async () => {
  const original = store.readFollowupCoverageSnapshotWith;
  const spy = vi.spyOn(store, "readFollowupCoverageSnapshotWith").mockImplementationOnce(async (q, p, c) => { await side.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1", [ids.own]); return original(q, p, c); });
  try { expect((await read("own")).current?.id).toBe(base.revision); spy.mockRestore(); await expect(read("own")).rejects.toMatchObject({code:"patient_not_found"}); }
  finally { spy.mockRestore(); await fx.pool.query("UPDATE patients SET primary_doctor_id=$1 WHERE id=$2", [fx.parties.own, ids.own]); }
});
it("one lease covers scope, activation, decision and sources; reads change no persisted money/history/audit", async () => {
  const sql = "SELECT (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM ortho_followup_coverage_revisions r) revisions,(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invoices i) invoices,(SELECT count(*) FROM audit_log)::int audits";
  const before = (await fx.pool.query(sql)).rows, session = await fx.session("own"), pool = db.getPool();
  const connect = vi.spyOn(pool, "connect"), query = vi.spyOn(pool, "query"), initialize = vi.spyOn(db, "ensureSchema");
  try { await reads.readCanonicalOrthoCoverage(session, base.patient, base.ortho); expect(connect).toHaveBeenCalledTimes(1); expect(query).not.toHaveBeenCalled(); expect(initialize).not.toHaveBeenCalled(); }
  finally { connect.mockRestore(); query.mockRestore(); initialize.mockRestore(); }
  expect((await fx.pool.query(sql)).rows).toEqual(before);
});
it("current grant removal and credential retirement refuse old sessions", async () => {
  const stale = await fx.session("all"); await fx.setGrants("all", {}, { patientScope: "all" });
  try { await expect(reads.readCanonicalOrthoCoverage(stale, base.patient, base.ortho)).rejects.toThrow(/STALE/); await expect(read("all")).rejects.toThrow(/CAPABILITY_DENIED/); }
  finally { await fx.setGrants("all", GRANTS, { patientScope: "all" }); }
  const old = await fx.session("all"); await fx.pool.query("UPDATE users SET password_hash='SYN changed coverage hash' WHERE id=$1", [fx.ids.all]);
  await expect(reads.readCanonicalOrthoCoverage(old, base.patient, base.ortho)).rejects.toThrow(/SESSION|STALE/);
});
it("waits before the RR snapshot and rechecks a permission revocation behind the identity fence", async () => {
  const session = await fx.session("all"), locker = await side.connect();
  try {
    await locker.query("BEGIN"); const pid = (await locker.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    await locker.query("SELECT pg_advisory_xact_lock(hashtextextended('aqlan.canonical.identity.substrate.v1:public',0))");
    const pending = reads.readCanonicalOrthoCoverage(session, base.patient, base.ortho).then(v => ({v}), e => ({e}));
    await waitForBlockedBy(fx.pool, pid);
    await locker.query("UPDATE users SET permissions=$1 WHERE id=$2", [JSON.stringify(capabilityDocument({ grants: {}, patientScope: "all" }, 50)), fx.ids.all]); await locker.query("COMMIT");
    expect(await pending).toHaveProperty("e");
  } finally { await locker.query("ROLLBACK"); locker.release(); await fx.setGrants("all", GRANTS, { patientScope: "all" }); }
});
it("failed SQL refuses the whole response and leaves the next lease clean", async () => {
  const spy = vi.spyOn(store, "readFollowupCoverageSnapshotWith").mockImplementationOnce(async q => { await q.query("SELECT 1/0"); throw Error("unreachable"); });
  try { await expect(read("own")).rejects.toThrow(); } finally { spy.mockRestore(); }
  expect((await read("own")).applicable).toBe(true);
});
it("rejects a source envelope over 2 MiB without hiding or rewriting it", async () => {
  const f = await episode(); await fx.pool.query("UPDATE plan_items SET service_name=repeat('x',2100000) WHERE id=$1", [f.item]);
  await expect(read("owner", f)).rejects.toThrow("STAFF_READ_READ_FAILED");
  expect((await fx.pool.query("SELECT length(service_name) n FROM plan_items WHERE id=$1", [f.item])).rows[0].n).toBe(2100000);
});
it("refuses candidate 257 without returning a silently shortened decision context", async () => {
  const f = await episode(ids.own, false);
  await fx.pool.query(`INSERT INTO plan_items(plan_id,case_id,service_id,service_name,category,doctor_id,quantity,unit_price_minor,billing_status,billed_invoice_id,origin_invoice_id,origin,session_count)
    SELECT $1,$2,$3,'SYN additional candidate','ortho',$4,1,250000,'billed',$5,$5,'invoice',12 FROM generate_series(1,255)`, [f.plan, f.clinical, f.service, fx.parties.own, f.invoice]);
  expect((await read("owner", f)).enabled).toBe(true);
  await fx.pool.query(`INSERT INTO plan_items(plan_id,case_id,service_id,service_name,category,doctor_id,quantity,unit_price_minor,billing_status,billed_invoice_id,origin_invoice_id,origin,session_count)
    VALUES($1,$2,$3,'SYN candidate 257','ortho',$4,1,250000,'billed',$5,$5,'invoice',12)`, [f.plan, f.clinical, f.service, fx.parties.own, f.invoice]);
  await expect(read("owner", f)).rejects.toThrow("STAFF_READ_READ_FAILED");
  expect((await fx.pool.query("SELECT count(*)::int n FROM plan_items WHERE plan_id=$1", [f.plan])).rows[0].n).toBe(257);
});
