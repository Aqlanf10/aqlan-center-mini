import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, rawPool, stubPostgresEnv } from "./_setup";
import { invoiceCatalogRequestFingerprint, invoiceCommandFingerprint, parseInvoiceCommand } from "../../lib/invoice-template";
import { DEFAULT_SPECIALTY_TEMPLATES } from "../../lib/specialty-templates";
import type { SessionPayload } from "../../lib/auth";
import type { DebtRepaymentTerms } from "../../lib/debt-installments";
import { invoicePriceQuote } from "../../lib/invoice-price-quote";
import { invoicePricingSettings } from "../../lib/invoice-price-settings-db";

assertRealPostgresUrl(); stubPostgresEnv();
const db = await import("../../lib/db");
const { createLinkedInvoice, recoverLinkedInvoice } = await import("../../lib/invoice-linkage-db");
const { InvoiceTemplateAuthorityError, InvoiceTemplateAuthorizationError, InvoiceTemplateBusyError } = await import("../../lib/invoice-template-db");
const { hashPassword, sessionCredentialVersion } = await import("../../lib/auth");
let session: SessionPayload;
let serviceId: number;
const q = async (sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!); await db.ensureSchema();
  const password = await hashPassword("synthetic-invoice-catalog-authority-password");
  const [user] = await q(`INSERT INTO users(username,display_name,password_hash,role,is_active)
    VALUES('catalog-reception','Synthetic catalogue reception',$1,'reception',TRUE) RETURNING id`, [password]);
  session = { userId: user.id, username: "catalog-reception", role: "reception", expiresAt: Date.now()+3_600_000,
    credentialVersion: sessionCredentialVersion(password) };
  serviceId = (await q(`INSERT INTO services(name,category,price_minor,price_configured,is_active,price_sar_minor)
    VALUES('Synthetic priced consultation','consultation',10000,TRUE,TRUE,12345) RETURNING id`))[0].id;
}, 180_000);
afterAll(async () => { await db.resetPoolForTesting(); });

async function command(name: string,repaymentTerms?:DebtRepaymentTerms) {
  const patientId = (await q("INSERT INTO patients(patient_number,full_name) VALUES($1,$1) RETURNING id", [name]))[0].id as number;
  const source = { patientId, currency: "SAR", items: [{ serviceId, price: "123.45", catalogPriceMinor: 12345 }], idempotencyKey: name,...(repaymentTerms?{repaymentTerms}:{}) };
  const parsed = parseInvoiceCommand(source, new Map((await db.listServices()).map(s => [s.id,s])), new Set(), await db.getSettings(), true);
  if (!parsed.ok) throw new Error(parsed.message);
  const input = { patientId, baseCurrency: parsed.baseCurrency, discountMinor: parsed.discountMinor, note: parsed.note,
    existingPlanId: parsed.existingPlanId, items: parsed.items, createdBy: session.username, actorRole: session.role,
    templates: DEFAULT_SPECIALTY_TEMPLATES, idempotencyKey: source.idempotencyKey,
    requestHash: invoiceCatalogRequestFingerprint(source,session),
    catalogueAuthority: { source, fingerprint: invoiceCommandFingerprint(parsed), session }, auditDetails: {} };
  return { input, source };
}
const counts = (id: number) => q(`SELECT (SELECT count(*)::int FROM invoices WHERE patient_id=$1) AS invoices,
  (SELECT count(*)::int FROM payments WHERE patient_id=$1) AS payments,
  (SELECT count(*)::int FROM treatment_plans WHERE patient_id=$1) AS plans`, [id]);

describe("ordinary invoice transaction catalogue authority", () => {
  it("locks and snapshots configured FX, refuses same-rounded-price drift, and replays the successful original without repricing", async () => {
    const prior = await q("SELECT value FROM settings WHERE key='finance.rate.SAR'");
    const fxId = (await q("INSERT INTO services(name,category,price_minor,price_configured,is_active) VALUES('Synthetic converted consultation','consultation',2200,TRUE,TRUE) RETURNING id"))[0].id;
    try {
      await q("INSERT INTO settings(key,value) VALUES('finance.rate.SAR','440') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
      const make = async (name: string) => {
        const patientId = (await q("INSERT INTO patients(patient_number,full_name) VALUES($1,$1) RETURNING id", [name]))[0].id;
        const catalog = new Map((await db.listServices()).map(row => [row.id, row]));
        const source = { patientId, currency: "SAR", items: [{ serviceId: fxId, price: "5", catalogPriceMinor: null, priceQuote: invoicePriceQuote(catalog.get(fxId)!, "SAR", { SAR: 440 }) }], idempotencyKey: name };
        const parsed = parseInvoiceCommand(source, catalog, new Set(), { ...(await invoicePricingSettings()), "finance.rate.SAR": "440" }, true);
        if (!parsed.ok) throw new Error(parsed.message);
        return { patientId, source, input: { patientId, baseCurrency: parsed.baseCurrency, discountMinor: 0, note: null, items: parsed.items,
          createdBy: session.username, actorRole: session.role, templates: DEFAULT_SPECIALTY_TEMPLATES, idempotencyKey: name,
          requestHash: invoiceCatalogRequestFingerprint(source, session), catalogueAuthority: { source, fingerprint: invoiceCommandFingerprint(parsed), session }, auditDetails: {} } };
      };
      const successful = await make("CAT-CONVERTED-SUCCESS");
      const first = await createLinkedInvoice(successful.input); if (!first.ok) throw new Error(first.reason);
      expect((await q("SELECT details FROM audit_log WHERE action='invoice.create' AND entity_id=$1", [String(first.invoice.id)]))[0].details.invoicePriceSnapshots[0]).toMatchObject({ serviceId: fxId, quote: { source: "converted", rate: 440, rateSource: "finance.rate.SAR", rounding: "nearest-major-unit", minor: 500 } });
      const stale = await make("CAT-CONVERTED-SAME-ROUNDING-STALE");
      await q("UPDATE settings SET value='441' WHERE key='finance.rate.SAR'");
      await expect(createLinkedInvoice(stale.input)).rejects.toBeInstanceOf(InvoiceTemplateAuthorityError);
      expect(await counts(stale.patientId)).toEqual([{ invoices: 0, payments: 0, plans: 0 }]);
      expect(await createLinkedInvoice(successful.input)).toMatchObject({ ok: true, replayed: true, invoice: { id: first.invoice.id, totalMinor: 500 } });
      expect(await counts(successful.patientId)).toEqual([{ invoices: 1, payments: 0, plans: 0 }]);
    } finally {
      if (prior.length) await q("UPDATE settings SET value=$1 WHERE key='finance.rate.SAR'", [prior[0].value]);
      else await q("DELETE FROM settings WHERE key='finance.rate.SAR'");
    }
  });
  it("persists exact installment terms atomically with an ordinary invoice and replays once",async()=>{
    const terms:DebtRepaymentTerms={mode:"installments",installments:[{dueDate:"2026-10-12",amountMinor:2345,kind:"down_payment"},{dueDate:"2026-11-12",amountMinor:10000,kind:"installment"}]};
    const {input}=await command("CAT-REPAYMENT-EXACT",terms);
    const first=await createLinkedInvoice(input);expect(first.ok).toBe(true);if(!first.ok)return;
    expect(await createLinkedInvoice(input)).toMatchObject({ok:true,replayed:true,invoice:{id:first.invoice.id}});
    const schedules=await import("../../lib/debt-installments-db");
    expect(await schedules.invoiceDebtRepaymentReceipt(input.patientId,first.invoice.id)).toMatchObject({version:1,terms});
    expect(await counts(input.patientId)).toEqual([{invoices:1,payments:0,plans:0}]);
    expect((await q("SELECT count(*)::int AS n FROM debt_repayment_revisions r JOIN debt_repayment_arrangements a ON a.id=r.arrangement_id WHERE a.patient_id=$1",[input.patientId]))[0].n).toBe(1);
  });
  it("rolls the new invoice and terms back when pre-existing account credit requires allocation review",async()=>{
    const {input}=await command("CAT-REPAYMENT-CREDIT",{mode:"full",installments:[]});
    await db.openShift({openedBy:session.username,opening:{YER:0,SAR:0,USD:0}});
    const planId=(await q("INSERT INTO treatment_plans(patient_id,title,total_minor,base_currency) VALUES($1,'Synthetic existing SAR plan',1000,'SAR') RETURNING id",[input.patientId]))[0].id;
    await db.recordPayment({patientId:input.patientId,invoiceId:null,planId,amountMinor:1000,currency:"SAR",baseCurrency:"YER",exchangeRate:140,kind:"payment",method:"cash",note:null,createdBy:session.username,idempotencyKey:"cat-existing-credit"});
    await expect(createLinkedInvoice(input)).rejects.toMatchObject({code:"stale"});
    expect(await counts(input.patientId)).toEqual([{invoices:0,payments:1,plans:1}]);
    expect((await q("SELECT count(*)::int AS n FROM debt_repayment_arrangements WHERE patient_id=$1",[input.patientId]))[0].n).toBe(0);
  });
  it.each(["price", "inactive", "session"] as const)("refuses %s drift after admission while waiting on the patient lock", async drift => {
    const { input } = await command(`CAT-WAIT-${drift}`);
    const before = await counts(input.patientId);
    const pool = rawPool(); const holder = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await holder.query("BEGIN");
      const { rows: [{ pid }] } = await holder.query("SELECT pg_backend_pid() AS pid");
      await holder.query("SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE", [input.patientId]);
      pending = createLinkedInvoice(input).then(value => ({ value }), error => ({ error }));
      await expect.poll(async () => (await pool.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity a
        WHERE $1=ANY(pg_blocking_pids(a.pid))) AS blocked`, [pid])).rows[0].blocked, { timeout: 5000, interval: 20 }).toBe(true);
      if (drift === "price") await q("UPDATE services SET price_sar_minor=13000 WHERE id=$1", [serviceId]);
      else if (drift === "inactive") await q("UPDATE services SET is_active=FALSE WHERE id=$1", [serviceId]);
      else await q("UPDATE users SET is_active=FALSE WHERE id=$1", [session.userId]);
      await holder.query("COMMIT");
      const outcome = await pending as { error: unknown };
      expect(outcome.error).toBeInstanceOf(drift === "session" ? InvoiceTemplateAuthorizationError : InvoiceTemplateAuthorityError);
      expect(await counts(input.patientId)).toEqual(before);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined); await pending; holder.release(); await pool.end();
      await q("UPDATE services SET price_sar_minor=12345,is_active=TRUE WHERE id=$1", [serviceId]);
      await q("UPDATE users SET is_active=TRUE WHERE id=$1", [session.userId]);
    }
    expect(await createLinkedInvoice(input)).toMatchObject({ ok: true, replayed: false });
  });

  it("fails closed against a locked catalogue writer without consuming the request", async () => {
    const { input } = await command("CAT-LOCKED-WRITER");
    const pool = rawPool(); const holder = await pool.connect();
    try {
      await holder.query("BEGIN"); await holder.query("UPDATE services SET price_sar_minor=13000 WHERE id=$1", [serviceId]);
      await expect(createLinkedInvoice(input)).rejects.toBeInstanceOf(InvoiceTemplateBusyError);
      expect(await counts(input.patientId)).toEqual([{ invoices: 0, payments: 0, plans: 0 }]);
    } finally { await holder.query("ROLLBACK"); holder.release(); await pool.end(); }
    expect(await createLinkedInvoice(input)).toMatchObject({ ok: true, replayed: false });
  });

  it("recovers exact submitted intent after price drift, with one invoice and no receipt", async () => {
    const { input, source } = await command("CAT-RECOVER-EXACT");
    const first = await createLinkedInvoice(input); if (!first.ok) throw new Error(first.reason);
    try {
      await q("UPDATE services SET price_sar_minor=13000 WHERE id=$1", [serviceId]);
      const recovery = { patientId: input.patientId, idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash, createdBy: session.username, session };
      expect(await recoverLinkedInvoice(recovery)).toMatchObject({ ok: true, replayed: true, invoice: { id: first.invoice.id, totalMinor: 12345 } });
      expect(await recoverLinkedInvoice({ ...recovery, requestHash: invoiceCatalogRequestFingerprint({ ...source, note: "changed intent" },session) }))
        .toMatchObject({ ok: false, reason: "idempotency_conflict" });
      expect(await counts(input.patientId)).toEqual([{ invoices: 1, payments: 0, plans: 0 }]);
    } finally { await q("UPDATE services SET price_sar_minor=12345 WHERE id=$1", [serviceId]); }
  });
});
