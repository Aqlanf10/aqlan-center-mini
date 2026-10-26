import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import type { SessionPayload } from "../../lib/auth";
import { currentStatementInvoices } from "../../lib/statement-lines";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
const requestSession = vi.hoisted(() => ({ value: null as SessionPayload | null }));
vi.mock("@/lib/session", async original => ({ ...await original<typeof import("../../lib/session")>(), requireSession: async () => requestSession.value }));
assertRealPostgresUrl(); stubPostgresEnv();
const db = await import("../../lib/db"), auth = await import("../../lib/auth");
const archive = await import("../../lib/invoice-archive-db");
const proposal = readFileSync(new URL("../../migrations/proposals/invoice-archive.sql", import.meta.url), "utf8");
const q = async (sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows;
let session: SessionPayload, serial = 0;
beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!); await db.ensureSchema();
  const password = await auth.hashPassword("synthetic-archive-password");
  const [user] = await q("INSERT INTO users(username,display_name,password_hash,role,is_active) VALUES ('archive-owner','Synthetic archive owner',$1,'admin',TRUE) RETURNING id", [password]);
  session = { userId: user.id, username: "archive-owner", role: "admin", credentialVersion: auth.sessionCredentialVersion(password), expiresAt: Date.now() + 3_600_000 };
  requestSession.value = session;
  await db.openShift({ openedBy: session.username, opening: { YER: 0, SAR: 0, USD: 0 } });
});
afterAll(async () => { await db.resetPoolForTesting(); });
async function fixture(paid = 10000, total = 10000) {
  const [patient] = await q("INSERT INTO patients(patient_number,full_name) VALUES ($1,'Synthetic archive patient') RETURNING id", [`SYN-ARC-${++serial}`]);
  const invoice = await db.createInvoice({ patientId: patient.id, baseCurrency: "YER", discountMinor: 0, note: null, createdBy: session.username,
    items: [{ serviceId: null, doctorId: null, description: "Synthetic archive service", quantity: 1, unitPriceMinor: total }] });
  if (!invoice) throw new Error("Synthetic invoice missing");
  if (paid) expect((await db.recordPayment({ patientId: patient.id, invoiceId: invoice.id, kind: "payment", amountMinor: paid, currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash", note: null, createdBy: session.username, idempotencyKey: `archive-payment-${serial}` })).reason).toBeNull();
  return invoice;
}
const command = (action: "archive" | "restore" = "archive", expectedVersion = 0) => ({ action, expectedVersion, reason: "Synthetic documentary organization", idempotencyKey: `invoice-archive-test-${++serial}` });
const financial = async () => Promise.all(["invoices", "invoice_items", "payments", "treatment_plans", "plan_items", "visits", "visit_procedures", "treatment_sessions", "lab_orders", "hr_payroll_items", "doctor_commission_history", "document_prints", "clinical_cases"].map(async table =>
  [table, (await q(`SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'|' ORDER BY to_jsonb(t)::text),'')) AS hash FROM ${table} t`))[0].hash]));

describe("reversible documentary archive, independent of cancellation and money", () => {
  it("fails closed without auto-installing the unnumbered schema proposal", async () => {
    const invoice = await fixture();
    expect(await archive.readInvoiceArchive(invoice.id, session)).toMatchObject({ readiness: "migration_pending", version: 0, archived: false });
    await expect(archive.changeInvoiceArchive(invoice.id, command(), session)).rejects.toMatchObject({ code: "migration_pending" });
    expect((await q("SELECT to_regclass('public.invoice_archive_events') AS target"))[0].target).toBeNull();
    await q(proposal);
  });
  it("archives a paid invoice without changing any financial/clinical row or statement document", async () => {
    const invoice = await fixture(), before = await financial();
    const ledger = await db.patientLedger(invoice.patientId), balance = db.ledgerBalancesByCurrency(invoice.patientId, ledger, new Map());
    const saved = await archive.changeInvoiceArchive(invoice.id, command(), session);
    expect(saved).toMatchObject({ replayed: false, noop: false, receipt: { invoiceId: invoice.id, action: "archive", version: 1, archived: true }, current: { archived: true, version: 1 } });
    expect(await financial()).toEqual(before);
    expect(await db.getInvoice(invoice.id)).toEqual((await db.listPatientInvoices(invoice.patientId))[0]);
    const afterLedger = await db.patientLedger(invoice.patientId);
    expect(db.ledgerBalancesByCurrency(invoice.patientId, afterLedger, new Map())).toEqual(balance);
    expect(currentStatementInvoices(afterLedger.invoices).map(row => row.id)).toContain(invoice.id);
    const listed = await archive.listInvoiceArchive(invoice.patientId, session);
    expect(listed.archivedInvoices.map(row => row.invoice.id)).toEqual([invoice.id]);
    expect(await q("SELECT id FROM audit_log WHERE action='invoice.archive' AND entity_id=$1", [String(invoice.id)])).toHaveLength(1);
  });
  it.each([0, 4000])("requires a policy decision for %s paid and never trusts manual paid status", async paid => {
    const invoice = await fixture(paid); await db.setInvoiceStatus(invoice.id, "paid", { actor: session.username, actorRole: "admin" });
    const before = await financial();
    expect(await archive.readInvoiceArchive(invoice.id, session)).toMatchObject({ eligibility: { canArchive: false, code: "policy_decision_required", remainingMinor: 10000 - paid } });
    await expect(archive.changeInvoiceArchive(invoice.id, command(), session)).rejects.toMatchObject({ code: "policy_decision_required" });
    expect(await financial()).toEqual(before);
    expect(await q("SELECT id FROM invoice_archive_events WHERE invoice_id=$1", [invoice.id])).toHaveLength(0);
  });
  it("replays a lost acknowledgement and serializes concurrent identical requests once", async () => {
    const invoice = await fixture(), input = command();
    const [left, right] = await Promise.all([archive.changeInvoiceArchive(invoice.id, input, session), archive.changeInvoiceArchive(invoice.id, input, session)]);
    expect([left.replayed, right.replayed].sort()).toEqual([false, true]);
    expect(left.receipt).toEqual(right.receipt);
    expect((await archive.changeInvoiceArchive(invoice.id, input, session)).receipt).toEqual(left.receipt);
    await expect(archive.changeInvoiceArchive(invoice.id, { ...input, reason: "Different synthetic reason" }, session)).rejects.toMatchObject({ code: "conflict" });
    expect(await q("SELECT id FROM invoice_archive_events WHERE invoice_id=$1", [invoice.id])).toHaveLength(1);
  });
  it("does not write another event/audit for rearchive and an old request cannot rearchive after restore", async () => {
    const invoice = await fixture(), firstInput = command();
    const first = await archive.changeInvoiceArchive(invoice.id, firstInput, session);
    expect(await archive.changeInvoiceArchive(invoice.id, command("archive", 1), session)).toMatchObject({ noop: true, current: { version: 1 } });
    expect(await q("SELECT id FROM invoice_archive_events WHERE invoice_id=$1", [invoice.id])).toHaveLength(1);
    expect(await q("SELECT id FROM audit_log WHERE action='invoice.archive' AND entity_id=$1", [String(invoice.id)])).toHaveLength(1);
    await archive.changeInvoiceArchive(invoice.id, command("restore", 1), session);
    const replay = await archive.changeInvoiceArchive(invoice.id, firstInput, session);
    expect(replay.receipt).toEqual(first.receipt);
    expect(replay).toMatchObject({ replayed: true, current: { archived: false, version: 2 } });
    await expect(archive.changeInvoiceArchive(invoice.id, command("archive", 1), session)).rejects.toMatchObject({ code: "stale" });
    expect(await archive.changeInvoiceArchive(invoice.id, command("archive", 2), session)).toMatchObject({ current: { archived: true, version: 3 } });
  });
  it("restores even after a real refund creates debt, with no debt or receipt write from restore", async () => {
    const invoice = await fixture(); await archive.changeInvoiceArchive(invoice.id, command(), session);
    const [payment] = await q("SELECT id FROM payments WHERE invoice_id=$1 AND kind='payment'", [invoice.id]);
    expect((await db.recordPayment({ patientId: invoice.patientId, invoiceId: invoice.id, kind: "refund", amountMinor: 1000, currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash", note: "Synthetic refund after archive", createdBy: session.username, reversalOfId: payment.id, idempotencyKey: `archive-refund-${++serial}` })).reason).toBeNull();
    const before = await financial();
    expect(await archive.changeInvoiceArchive(invoice.id, command("restore", 1), session)).toMatchObject({ current: { archived: false, eligibility: { remainingMinor: 1000 } } });
    expect(await financial()).toEqual(before);
    const ledger = await db.patientLedger(invoice.patientId);
    expect(db.ledgerBalancesByCurrency(invoice.patientId, ledger, new Map()).YER.dueMinor).toBe(1000);
  });
  it("refuses missing authority, revoked credentials and locked periods without transitions", async () => {
    const invoice = await fixture(), input = command();
    await expect(archive.changeInvoiceArchive(invoice.id, input, { ...session, role: "reception" })).rejects.toMatchObject({ code: "unauthorized" });
    await q("UPDATE users SET is_active=FALSE WHERE id=$1", [session.userId]);
    try { await expect(archive.changeInvoiceArchive(invoice.id, input, session)).rejects.toMatchObject({ code: "unauthorized" }); }
    finally { await q("UPDATE users SET is_active=TRUE WHERE id=$1", [session.userId]); }
    await q("INSERT INTO settings(key,value) VALUES('finance.locked_before','2099-01-01') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
    try { await expect(archive.changeInvoiceArchive(invoice.id, input, session)).rejects.toMatchObject({ code: "period_locked" }); }
    finally { await q("DELETE FROM settings WHERE key='finance.locked_before'"); }
    expect(await q("SELECT id FROM invoice_archive_events WHERE invoice_id=$1", [invoice.id])).toHaveLength(0);
  });
  it("keeps events append-only, refuses direct invoice deletion and proposal rerun changes no history", async () => {
    const invoice = await fixture(); await archive.changeInvoiceArchive(invoice.id, command(), session);
    const before = await q("SELECT * FROM invoice_archive_events ORDER BY id");
    await expect(q("UPDATE invoice_archive_events SET reason='Changed synthetic reason' WHERE invoice_id=$1", [invoice.id])).rejects.toThrow(/append-only/);
    await expect(q("DELETE FROM invoice_archive_events WHERE invoice_id=$1", [invoice.id])).rejects.toThrow(/append-only/);
    await expect(q("TRUNCATE invoice_archive_events")).rejects.toThrow(/append-only/);
    await expect(q("DELETE FROM invoices WHERE id=$1", [invoice.id])).rejects.toThrow();
    await q(proposal); expect(await q("SELECT * FROM invoice_archive_events ORDER BY id")).toEqual(before);
  });
  it("refuses malformed schema readiness instead of claiming operational archive", async () => {
    await q("ALTER TABLE invoice_archive_events DISABLE TRIGGER invoice_archive_events_guard");
    try { const invoice = await fixture(); expect(await archive.readInvoiceArchive(invoice.id, session)).toMatchObject({ readiness: "migration_pending" });
      await expect(archive.changeInvoiceArchive(invoice.id, command(), session)).rejects.toMatchObject({ code: "migration_pending" }); }
    finally { await q("ALTER TABLE invoice_archive_events ENABLE TRIGGER invoice_archive_events_guard"); }
  });
  it("returns command-bound monotonic refusal after a lost no-op response and another restore", async () => {
    const invoice = await fixture(); await archive.changeInvoiceArchive(invoice.id, command(), session);
    const noop = command("archive", 1); expect(await archive.changeInvoiceArchive(invoice.id, noop, session)).toMatchObject({ noop: true });
    await archive.changeInvoiceArchive(invoice.id, command("restore", 1), session);
    await expect(archive.changeInvoiceArchive(invoice.id, noop, session)).rejects.toMatchObject({ code: "stale", refusal: { ...noop, kind: "version_advanced", invoiceId: invoice.id, patientId: invoice.patientId, actor: session.username, currentVersion: 2 } });
    expect(await q("SELECT id FROM invoice_archive_events WHERE invoice_id=$1", [invoice.id])).toHaveLength(2);
  });
  it("serializes distinct concurrent archive keys as one event and one terminal stale refusal", async () => {
    const invoice = await fixture();
    const results = await Promise.allSettled([archive.changeInvoiceArchive(invoice.id, command(), session), archive.changeInvoiceArchive(invoice.id, command(), session)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "stale", refusal: { kind: "version_advanced", expectedVersion: 0, currentVersion: 1 } } });
    expect(await q("SELECT id FROM invoice_archive_events WHERE invoice_id=$1", [invoice.id])).toHaveLength(1);
  });
  it("refuses an ambiguous correction lineage without treating settlement failure as zero debt", async () => {
    const invoice = await fixture(); await q("UPDATE invoices SET note='تصحيح للفاتورة synthetic-unstructured' WHERE id=$1", [invoice.id]);
    expect(await archive.readInvoiceArchive(invoice.id, session)).toMatchObject({ eligibility: { code: "policy_decision_required", remainingMinor: null } });
    await expect(archive.changeInvoiceArchive(invoice.id, command(), session)).rejects.toMatchObject({ code: "policy_decision_required" });
  });
  it.each([
    { change: "ALTER TABLE invoice_archive_events DROP CONSTRAINT invoice_archive_events_idempotency_key_key", restore: "ALTER TABLE invoice_archive_events ADD CONSTRAINT invoice_archive_events_idempotency_key_key UNIQUE(idempotency_key)" },
    { change: "ALTER TABLE invoice_archive_events ALTER COLUMN reason TYPE VARCHAR", restore: "ALTER TABLE invoice_archive_events ALTER COLUMN reason TYPE TEXT" },
    { change: "ALTER TABLE invoice_archive_events DROP CONSTRAINT invoice_archive_events_invoice_id_fkey", restore: "ALTER TABLE invoice_archive_events ADD CONSTRAINT invoice_archive_events_invoice_id_fkey FOREIGN KEY(invoice_id) REFERENCES invoices(id) ON DELETE RESTRICT" },
    { change: "ALTER TABLE invoice_archive_events DISABLE TRIGGER invoice_archive_events_no_truncate", restore: "ALTER TABLE invoice_archive_events ENABLE TRIGGER invoice_archive_events_no_truncate" },
  ])("fails closed on incomplete schema: $change", async ({ change, restore }) => {
    const invoice = await fixture(); await q(change);
    try { expect(await archive.readInvoiceArchive(invoice.id, session)).toMatchObject({ readiness: "migration_pending" });
      await expect(archive.changeInvoiceArchive(invoice.id, command(), session)).rejects.toMatchObject({ code: "migration_pending" }); }
    finally { await q(restore); }
    expect(await archive.readInvoiceArchive(invoice.id, session)).toMatchObject({ readiness: "ready" });
  });

  it("preserves completed clinical work, signed visit source, lab cost, nonzero commission/payroll history and printable original", async () => {
    const [patient] = await q("INSERT INTO patients(patient_number,full_name) VALUES ($1,'Synthetic archive completed treatment') RETURNING id", [`SYN-ARC-CL-${++serial}`]);
    const doctor = await db.createParty({ name: "Synthetic archive clinician", kind: "doctor", phone: null, commissionPercent: 30, note: null });
    const [service] = await q("INSERT INTO services(name,category,price_minor,is_active) VALUES ('Synthetic archive endodontics','rct',10000,TRUE) RETURNING id");
    const linked = await import("../../lib/invoice-linkage-db"), { DEFAULT_SPECIALTY_TEMPLATES } = await import("../../lib/specialty-templates");
    const issued = await linked.createLinkedInvoice({ patientId: patient.id, baseCurrency: "YER", discountMinor: 0, note: null, createdBy: session.username, actorRole: "admin",
      items: [{ serviceId: service.id, doctorId: doctor.id, category: "rct", description: "Synthetic archive endodontics", quantity: 1, unitPriceMinor: 10000, toothCode: 36, caseId: null, sessions: null }],
      templates: DEFAULT_SPECIALTY_TEMPLATES, idempotencyKey: null, requestHash: null, auditDetails: {} });
    if (!issued.ok) throw new Error("Synthetic linked invoice refused");
    const invoice = issued.invoice, itemId = issued.links[0].planItemId!;
    const [visit] = await q("INSERT INTO visits(patient_id,patient_name,doctor_id,case_id,invoice_id,status,signed_at,signed_by) VALUES ($1,'Synthetic archived signed visit',$2,$3,$4,'done',NOW(),$5) RETURNING id", [patient.id, doctor.id, issued.links[0].caseId, invoice.id, session.username]);
    await q("INSERT INTO visit_procedures(visit_id,service_id,doctor_id,tooth_code,quantity,unit_price_minor,plan_item_id) VALUES ($1,$2,$3,36,1,10000,$4)", [visit.id, service.id, doctor.id, itemId]);
    await q("UPDATE plan_items SET status='completed',sessions_completed=1,started_at=NOW() WHERE id=$1", [itemId]);
    await q("UPDATE treatment_sessions SET status='completed',visit_id=$2,completed_at=NOW() WHERE plan_item_id=$1", [itemId, visit.id]);
    await q("INSERT INTO lab_orders(patient_id,visit_id,lab_name,work_type,due_date,status,cost_minor,cost_currency) VALUES ($1,$2,'Synthetic archive lab','Synthetic archived work',CURRENT_DATE,'delivered',2000,'YER')", [patient.id, visit.id]);
    expect((await db.recordPayment({ patientId: patient.id, invoiceId: invoice.id, kind: "payment", amountMinor: 10000, currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash", note: null, createdBy: session.username, idempotencyKey: `archive-clinical-paid-${++serial}` })).reason).toBeNull();
    const commissions = await db.commissionReport("1970-01-01", "2999-12-31");
    const row = commissions.find(row => row.doctorId === doctor.id && row.currency === "YER");
    expect(row!.accruedMinor).toBeGreaterThan(0);
    const [staff] = await q("INSERT INTO hr_staff(full_name,created_by) VALUES ('Synthetic archive clinician payroll',$1) RETURNING id", [session.username]);
    const [period] = await q("INSERT INTO hr_payroll_periods(period_key,name,start_date,end_date,created_by) VALUES ('2026-10','Synthetic archive period','2026-10-01','2026-10-31',$1) RETURNING id", [session.username]);
    const [run] = await q("INSERT INTO hr_payroll_runs(period_id,currency,created_by) VALUES ($1,'YER',$2) RETURNING id", [period.id, session.username]);
    await q("INSERT INTO hr_payroll_items(run_id,staff_id,currency,commissions_minor,commission_details,net_due_minor,remaining_minor) VALUES ($1,$2,'YER',$3,$4::jsonb,$3,$3)", [run.id, staff.id, row!.accruedMinor, JSON.stringify([{ invoiceId: invoice.id, doctorId: doctor.id, amountMinor: row!.accruedMinor }])]);
    await q("INSERT INTO document_prints(doc_type,doc_id,printed_by) VALUES ('invoice',$1,$2)", [invoice.id, session.username]);
    const { default: InvoicePage } = await import("../../app/print/invoice/[id]/page");
    const printedBefore = renderToStaticMarkup(await InvoicePage({ params: Promise.resolve({ id: String(invoice.id) }) }));
    const before = await financial(), visitBefore = await db.visitWalkout(visit.id);
    expect(await q("SELECT id FROM doctor_commission_history WHERE party_id=$1", [doctor.id])).not.toHaveLength(0);
    expect(await q("SELECT id FROM treatment_sessions WHERE plan_item_id=$1 AND status='completed'", [itemId])).not.toHaveLength(0);
    await archive.changeInvoiceArchive(invoice.id, command(), session);
    await archive.changeInvoiceArchive(invoice.id, command("restore", 1), session);
    expect(await financial()).toEqual(before);
    expect(await db.commissionReport("1970-01-01", "2999-12-31")).toEqual(commissions);
    expect(await db.visitWalkout(visit.id)).toEqual(visitBefore);
    expect(renderToStaticMarkup(await InvoicePage({ params: Promise.resolve({ id: String(invoice.id) }) }))).toEqual(printedBefore);
  });
  it("commits state and audit atomically or neither", async () => {
    const invoice = await fixture();
    await q("CREATE FUNCTION synthetic_archive_audit_failure() RETURNS TRIGGER AS $$ BEGIN IF NEW.action='invoice.archive' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql");
    await q("CREATE TRIGGER synthetic_archive_audit_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_archive_audit_failure()");
    try { await expect(archive.changeInvoiceArchive(invoice.id, command(), session)).rejects.toThrow(/synthetic audit failure/); }
    finally { await q("DROP TRIGGER synthetic_archive_audit_failure ON audit_log"); await q("DROP FUNCTION synthetic_archive_audit_failure()"); }
    expect(await q("SELECT id FROM invoice_archive_events WHERE invoice_id=$1", [invoice.id])).toHaveLength(0);
    expect(await q("SELECT id FROM audit_log WHERE action='invoice.archive' AND entity_id=$1", [String(invoice.id)])).toHaveLength(0);
  });
  it("uses real archive handlers, gives bound stale refusal, and rejects non-admin mutation", async () => {
    const route = await import("../../app/api/invoices/[id]/archive/route"), listRoute = await import("../../app/api/invoices/archive/route");
    const invoice = await fixture(), input = command(), context = { params: Promise.resolve({ id: String(invoice.id) }) };
    const request = (body: unknown) => new Request(`http://localhost/api/invoices/${invoice.id}/archive`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect((await route.POST(request(input), context)).status).toBe(201);
    expect((await route.POST(request(input), context)).status).toBe(200);
    const stale = command("restore", 0), response = await route.POST(request(stale), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "stale", refusal: { ...stale, kind: "version_advanced", invoiceId: invoice.id, patientId: invoice.patientId, actor: session.username, currentVersion: 1 } });
    expect((await listRoute.GET(new Request(`http://localhost/api/invoices/archive?patientId=${invoice.patientId}`))).status).toBe(200);
    requestSession.value = { ...session, role: "reception" };
    try { expect((await route.POST(request(command("restore", 1)), context)).status).toBe(403); }
    finally { requestSession.value = session; }
  });

  it.each(["cashier", "accountant"] as const)("revalidates stored %s patient-ledger read permissions before exposing settlement", async role => {
    const invoice = await fixture(), password = await auth.hashPassword(`synthetic-archive-${role}`), username = `archive-${role}`;
    const access = { viewPatientLedger: false };
    const [user] = await q("INSERT INTO users(username,display_name,password_hash,role,is_active,permissions) VALUES ($1,'Synthetic restricted archive reader',$2,$3,TRUE,$4) RETURNING id", [username, password, role, JSON.stringify({ financeAccess: access })]);
    const reader: SessionPayload = { userId: user.id, username, role, credentialVersion: auth.sessionCredentialVersion(password), permissionVersion: auth.sessionPermissionVersion(role, access), expiresAt: Date.now() + 3_600_000 };
    await expect(archive.readInvoiceArchive(invoice.id, reader)).rejects.toMatchObject({ code: "unauthorized" });
    await expect(archive.listInvoiceArchive(invoice.patientId, reader)).rejects.toMatchObject({ code: "unauthorized" });
    await q("UPDATE users SET permissions=$2 WHERE id=$1", [user.id, JSON.stringify({ financeAccess: { viewPatientLedger: true } })]);
    const allowed = { ...reader, permissionVersion: auth.sessionPermissionVersion(role, { viewPatientLedger: true }) };
    expect(await archive.readInvoiceArchive(invoice.id, allowed)).toMatchObject({ invoiceId: invoice.id, readiness: "ready" });
    await expect(archive.changeInvoiceArchive(invoice.id, command(), allowed)).rejects.toMatchObject({ code: "unauthorized" });
  });

  it.each(["zero", "cancelled"])("archives and restores %s documentary history without changing its financial status", async kind => {
    const invoice = kind === "zero" ? await fixture(0, 0) : await fixture();
    if (kind === "cancelled") await db.setInvoiceStatus(invoice.id, "cancelled", { actor: session.username, actorRole: "admin" });
    const original = await db.getInvoice(invoice.id), before = await financial();
    await archive.changeInvoiceArchive(invoice.id, command(), session);
    await archive.changeInvoiceArchive(invoice.id, command("restore", 1), session);
    expect(await db.getInvoice(invoice.id)).toEqual(original);
    expect(await financial()).toEqual(before);
  });

  it("rejects forged archive ownership, actor and version in the proposal guard", async () => {
    const invoice = await fixture(); await archive.changeInvoiceArchive(invoice.id, command(), session);
    const before = await q("SELECT * FROM invoice_archive_events WHERE invoice_id=$1", [invoice.id]);
    for (const mutation of ["patient_id+100000", "patient_id"]) {
      const forgedVersion = mutation === "patient_id" ? 3 : 2;
      await expect(q(`INSERT INTO invoice_archive_events(invoice_id,patient_id,invoice_number,invoice_created_at,currency,version,action,reason,idempotency_key,request_hash,actor_user_id,actor)
        SELECT invoice_id,${mutation},invoice_number,invoice_created_at,currency,$2,'restore',reason,$3,request_hash,actor_user_id,actor FROM invoice_archive_events WHERE invoice_id=$1`, [invoice.id, forgedVersion, `forged-archive-${++serial}`])).rejects.toThrow(/ownership mismatch|version\/state mismatch/);
    }
    await expect(q(`INSERT INTO invoice_archive_events(invoice_id,patient_id,invoice_number,invoice_created_at,currency,version,action,reason,idempotency_key,request_hash,actor_user_id,actor)
      SELECT invoice_id,patient_id,invoice_number,invoice_created_at,currency,2,'restore',reason,$2,request_hash,actor_user_id,'forged synthetic actor' FROM invoice_archive_events WHERE invoice_id=$1`, [invoice.id, `forged-archive-actor-${++serial}`])).rejects.toThrow(/actor mismatch/);
    expect(await q("SELECT * FROM invoice_archive_events WHERE invoice_id=$1", [invoice.id])).toEqual(before);
  });

});
