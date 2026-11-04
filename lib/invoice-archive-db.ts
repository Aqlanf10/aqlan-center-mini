import {withLegacyStaffReadOnlySnapshot} from "./legacy-staff-readonly-snapshot";
import type { SessionPayload } from "./auth";
import { CLINIC_TIME_ZONE, ensureSchema, getInvoice, getPool, insertAuditRow, listPatientInvoices, type DbClient, type Invoice } from "./db";
import { debtRequestHash } from "./debt-source-proof";
import { readInvoiceSettlementPosition, InvoiceSettlementError } from "./invoice-settlement-position";
import { requireCurrency } from "./money";
import { canViewMoney } from "./roles";
import { clinicDateString } from "./schedule";
import { revalidateSessionInTransaction } from "./session";
import { INVOICE_ARCHIVE_MIGRATION_MESSAGE, InvoiceArchiveError, invoiceArchiveEligibility, parseInvoiceArchiveCommand,
  type InvoiceArchiveEligibility, type InvoiceArchiveReceipt, type InvoiceArchiveResult, type InvoiceArchiveView } from "./invoice-archive";

type EventRow = { id: string; invoice_id: number; patient_id: number; invoice_number: string; invoice_created_at: Date; currency: string;
  version: number; action: "archive" | "restore"; reason: string; idempotency_key: string; request_hash: string; actor_user_id: number; actor: string; created_at: Date };
const positiveId = (value: number) => Number.isSafeInteger(value) && value > 0;
function receipt(row: EventRow): InvoiceArchiveReceipt {
  return { eventId: row.id, invoiceId: row.invoice_id, patientId: row.patient_id, invoiceNumber: row.invoice_number,
    invoiceCreatedAt: row.invoice_created_at.toISOString(), currency: requireCurrency(row.currency, "أرشيف فاتورة", row.invoice_id), version: row.version,
    action: row.action, archived: row.action === "archive", reason: row.reason, idempotencyKey: row.idempotency_key,
    actorUserId: row.actor_user_id, actor: row.actor, at: row.created_at.toISOString() };
}
async function authority(client: DbClient, session: SessionPayload, writing: boolean) {
  const current = await revalidateSessionInTransaction(session, client);
  if (!current || (writing ? current.role !== "admin" : !canViewMoney(current.role)
    || ((current.role === "cashier" || current.role === "accountant") && !current.financeAccess?.viewPatientLedger))) {
    throw new InvoiceArchiveError("unauthorized", writing ? "الأرشفة والاسترجاع يحتاجان جلسة مدير سارية." : "قراءة الأرشيف تحتاج صلاحية قراءة الفواتير.");
  }
}
/** Read-only readiness. Numbered migration ownership belongs to ensureSchema, never this reader. */
export async function invoiceArchiveReady(client: DbClient): Promise<boolean> {
  const { rows: [table] } = await client.query<{ target: string | null }>("SELECT to_regclass('public.invoice_archive_events')::text AS target");
  if (!table.target) return false;
  const expectedColumns: Record<string, string> = { id: "bigint", invoice_id: "integer", patient_id: "integer", invoice_number: "text", invoice_created_at: "timestamp with time zone",
    currency: "text", version: "integer", action: "text", reason: "text", idempotency_key: "text", request_hash: "text", actor_user_id: "integer", actor: "text", created_at: "timestamp with time zone" };
  const { rows: columns } = await client.query<{ name: string; type: string; required: boolean }>(`SELECT attname AS name,format_type(atttypid,atttypmod) AS type,attnotnull AS required
    FROM pg_attribute WHERE attrelid='public.invoice_archive_events'::regclass AND attnum>0 AND NOT attisdropped`);
  if (columns.length !== Object.keys(expectedColumns).length || columns.some(column => !column.required || expectedColumns[column.name] !== column.type)) return false;
  const { rows: [proof] } = await client.query<{ ready: boolean }>(`WITH attrs AS (
      SELECT attname,attnum FROM pg_attribute WHERE attrelid='public.invoice_archive_events'::regclass AND attnum>0 AND NOT attisdropped
    ) SELECT
    EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.invoice_archive_events'::regclass AND tgname='invoice_archive_events_guard'
      AND tgfoid=to_regprocedure('public.aqlan_invoice_archive_event_guard()') AND tgenabled='O' AND tgtype=31)
    AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.invoice_archive_events'::regclass AND tgname='invoice_archive_events_no_truncate'
      AND tgfoid=to_regprocedure('public.aqlan_invoice_archive_event_guard()') AND tgenabled='O' AND tgtype=34)
    AND (SELECT count(*)=8 FROM pg_constraint WHERE conrelid='public.invoice_archive_events'::regclass
      AND conname IN ('invoice_archive_currency','invoice_archive_version_positive','invoice_archive_action','invoice_archive_reason','invoice_archive_key','invoice_archive_hash','invoice_archive_actor','invoice_archive_invoice_version') AND convalidated)
    AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.invoice_archive_events'::regclass AND contype='u' AND convalidated AND NOT condeferrable
      AND conkey=ARRAY[(SELECT attnum FROM attrs WHERE attname='idempotency_key')])
    AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.invoice_archive_events'::regclass AND contype='p' AND convalidated
      AND conkey=ARRAY[(SELECT attnum FROM attrs WHERE attname='id')])
    AND NOT EXISTS (SELECT 1 FROM (VALUES ('invoice_id','invoices'),('patient_id','patients'),('actor_user_id','users')) required(column_name,table_name)
      WHERE NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid='public.invoice_archive_events'::regclass AND c.contype='f' AND c.convalidated AND NOT c.condeferrable
        AND c.confdeltype='r' AND c.conkey=ARRAY[(SELECT attnum FROM attrs WHERE attname=required.column_name)]
        AND c.confrelid=to_regclass('public.'||required.table_name)
        AND c.confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.confrelid AND attname='id')])) AS ready`);
  if (!proof.ready) return false;
  const { rows: [rejections] } = await client.query<{ target: string | null }>("SELECT to_regclass('public.invoice_archive_rejections')::text AS target");
  if (!rejections.target) return false;
  const expectedRejections: Record<string, string> = { idempotency_key: "text", invoice_id: "integer", actor_user_id: "integer", request_hash: "text", code: "text", message: "text", rejected_at: "timestamp with time zone" };
  const { rows: rejectionColumns } = await client.query<{ name: string; type: string; required: boolean }>(`SELECT attname AS name,format_type(atttypid,atttypmod) AS type,attnotnull AS required
    FROM pg_attribute WHERE attrelid='public.invoice_archive_rejections'::regclass AND attnum>0 AND NOT attisdropped`);
  if (rejectionColumns.length !== Object.keys(expectedRejections).length || rejectionColumns.some(column => !column.required || expectedRejections[column.name] !== column.type)) return false;
  const { rows: [rejectionProof] } = await client.query<{ ready: boolean }>(`WITH attrs AS (
    SELECT attname,attnum FROM pg_attribute WHERE attrelid='public.invoice_archive_rejections'::regclass AND attnum>0 AND NOT attisdropped
  ) SELECT
    EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.invoice_archive_rejections'::regclass AND tgname='invoice_archive_rejections_guard'
      AND tgfoid=to_regprocedure('public.aqlan_invoice_archive_rejection_guard()') AND tgenabled='O' AND tgtype=31)
    AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.invoice_archive_rejections'::regclass AND tgname='invoice_archive_rejections_no_truncate'
      AND tgfoid=to_regprocedure('public.aqlan_invoice_archive_rejection_guard()') AND tgenabled='O' AND tgtype=34)
    AND (SELECT count(*)=4 FROM pg_constraint WHERE conrelid='public.invoice_archive_rejections'::regclass AND convalidated
      AND conname IN ('invoice_archive_rejection_key','invoice_archive_rejection_hash','invoice_archive_rejection_code','invoice_archive_rejection_message'))
    AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.invoice_archive_rejections'::regclass AND contype='p' AND convalidated AND NOT condeferrable
      AND conkey=ARRAY[(SELECT attnum FROM attrs WHERE attname='idempotency_key')])
    AND NOT EXISTS (SELECT 1 FROM (VALUES ('invoice_id','invoices'),('actor_user_id','users')) required(column_name,table_name)
      WHERE NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid='public.invoice_archive_rejections'::regclass AND c.contype='f' AND c.convalidated AND NOT c.condeferrable
        AND c.confdeltype='r' AND c.conkey=ARRAY[(SELECT attnum FROM attrs WHERE attname=required.column_name)]
        AND c.confrelid=to_regclass('public.'||required.table_name)
        AND c.confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.confrelid AND attname='id')])) AS ready`);
  return rejectionProof.ready === true;
}
async function lastEvent(client: DbClient, invoiceId: number): Promise<EventRow | null> {
  return (await client.query<EventRow>("SELECT *,id::text FROM invoice_archive_events WHERE invoice_id=$1 ORDER BY version DESC LIMIT 1", [invoiceId])).rows[0] ?? null;
}
async function locked(client: DbClient, invoice: Invoice): Promise<boolean> {
  const { rows: [setting] } = await client.query<{ value: string }>("SELECT value FROM settings WHERE key='finance.locked_before'");
  const boundary = setting?.value.trim();
  return Boolean(boundary && clinicDateString(new Date(invoice.createdAt), CLINIC_TIME_ZONE) < boundary);
}
async function view(client: DbClient, invoice: Invoice, ready: boolean): Promise<InvoiceArchiveView> {
  const latest = ready ? await lastEvent(client, invoice.id) : null;
  let eligibility: InvoiceArchiveEligibility;
  if (!ready) eligibility = { canArchive: false, code: "migration_pending", message: INVOICE_ARCHIVE_MIGRATION_MESSAGE, remainingMinor: null };
  else {
    let remaining: number | null = null;
    try { remaining = (await readInvoiceSettlementPosition(client, { patientId: invoice.patientId, invoiceId: invoice.id, currency: invoice.baseCurrency })).remainingMinor; }
    catch (error) { if (!(error instanceof InvoiceSettlementError)) throw error; }
    eligibility = invoiceArchiveEligibility(invoice.status, remaining);
    if (await locked(client, invoice)) eligibility = { ...eligibility, canArchive: false, code: "period_locked", message: "الفاتورة في فترة مقفلة؛ الأرشفة والاسترجاع غير متاحين لهذه الفترة." };
  }
  return { invoiceId: invoice.id, patientId: invoice.patientId, invoiceNumber: invoice.invoiceNumber, currency: invoice.baseCurrency, status: invoice.status,
    version: latest?.version ?? 0, archived: latest?.action === "archive", latest: latest ? receipt(latest) : null,
    readiness: ready ? "ready" : "migration_pending", eligibility };
}
async function readOnly<T>(session: SessionPayload, run: (client: DbClient) => Promise<T>): Promise<T> {
  return withLegacyStaffReadOnlySnapshot(session,{
    allows:current=>canViewMoney(current.role)&&(!["cashier","accountant"].includes(current.role)||!!current.financeAccess?.viewPatientLedger),
    unauthorized:()=>new InvoiceArchiveError("unauthorized","قراءة الأرشيف تحتاج صلاحية قراءة الفواتير."),
  },client=>run(client));
}
export async function readInvoiceArchive(invoiceId: number, session: SessionPayload): Promise<InvoiceArchiveView> {
  if (!positiveId(invoiceId)) throw new InvoiceArchiveError("invalid", "رقم الفاتورة غير صالح.");
  return readOnly(session, async client => {
    const invoice = await getInvoice(invoiceId, client);
    if (!invoice) throw new InvoiceArchiveError("missing", "الفاتورة غير موجودة.");
    return view(client, invoice, await invoiceArchiveReady(client));
  });
}
export async function listInvoiceArchive(patientId: number, session: SessionPayload): Promise<{
  readiness: "ready" | "migration_pending"; invoices: InvoiceArchiveView[]; archivedInvoices: { invoice: Invoice; archive: InvoiceArchiveView }[];
}> {
  if (!positiveId(patientId)) throw new InvoiceArchiveError("invalid", "رقم المريض غير صالح.");
  return readOnly(session, async client => {
    const ready = await invoiceArchiveReady(client), documents = await listPatientInvoices(patientId, client);
    const states: InvoiceArchiveView[] = [];
    for (const invoice of documents) states.push(await view(client, invoice, ready));
    return { readiness: ready ? "ready" : "migration_pending", invoices: states,
      archivedInvoices: states.flatMap((state, index) => state.archived ? [{ invoice: documents[index], archive: state }] : []) };
  });
}

/** Documentary transitions only. The immutable financial and clinical graph is never rewritten. */
export async function changeInvoiceArchive(invoiceId: number, source: unknown, session: SessionPayload): Promise<InvoiceArchiveResult> {
  if (!positiveId(invoiceId)) throw new InvoiceArchiveError("invalid", "رقم الفاتورة غير صالح.");
  if (session.role !== "admin") throw new InvoiceArchiveError("unauthorized", "الأرشفة والاسترجاع للمدير وحده.");
  const command = parseInvoiceArchiveCommand(source);
  const hash = debtRequestHash({ purpose: "invoice-archive-v1", invoiceId, command, actor: { id: session.userId, username: session.username } });
  await ensureSchema(); const client = await getPool().connect(); let destroy = false, committed = false;
  try {
    await client.query("BEGIN"); await authority(client, session, true);
    if (!await invoiceArchiveReady(client)) throw new InvoiceArchiveError("migration_pending", INVOICE_ARCHIVE_MIGRATION_MESSAGE);
    // Global command identity prevents conflicting keys racing across invoices.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('invoice-archive:' || $1))", [command.idempotencyKey]);
    const { rows: [owner] } = await client.query<{ patient_id: number }>("SELECT patient_id FROM invoices WHERE id=$1", [invoiceId]);
    if (!owner) throw new InvoiceArchiveError("missing", "الفاتورة غير موجودة.");
    await client.query("SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE", [owner.patient_id]);
    await client.query("SELECT id FROM invoices WHERE id=$1 FOR UPDATE", [invoiceId]);
    const invoice = await getInvoice(invoiceId, client);
    if (!invoice || invoice.patientId !== owner.patient_id) throw new InvoiceArchiveError("conflict", "تغيرت هوية الفاتورة؛ حدّث المعاينة.");
    const acknowledgment = { idempotencyKey: command.idempotencyKey, action: command.action, expectedVersion: command.expectedVersion,
      actor: session.username, invoiceId, patientId: invoice.patientId };
    const { rows: [saved] } = await client.query<EventRow>("SELECT *,id::text FROM invoice_archive_events WHERE idempotency_key=$1", [command.idempotencyKey]);
    if (saved) {
      if (saved.request_hash !== hash || saved.invoice_id !== invoiceId || saved.actor_user_id !== session.userId || saved.actor !== session.username) {
        throw new InvoiceArchiveError("conflict", "مفتاح الأرشفة استُعمل بطلب أو مستخدم مختلف.");
      }
      const current = await view(client, invoice, true);
      await authority(client, session, true); await client.query("COMMIT");
      return { receipt: receipt(saved), current, replayed: true, noop: false, acknowledgment };
    }
    const refusal = { ...command, kind: "durable_rejection" as const, invoiceId, patientId: invoice.patientId, actor: session.username, currentVersion: command.expectedVersion };
    const { rows: [rejected] } = await client.query<{ invoice_id: number; actor_user_id: number; request_hash: string; code: "period_locked" | "policy_decision_required"; message: string }>(
      "SELECT * FROM invoice_archive_rejections WHERE idempotency_key=$1", [command.idempotencyKey]);
    if (rejected) {
      if (rejected.invoice_id !== invoiceId || rejected.actor_user_id !== session.userId || rejected.request_hash !== hash) {
        throw new InvoiceArchiveError("conflict", "مفتاح المحاولة المرفوضة يخص طلبًا أو مستخدمًا مختلفًا.");
      }
      throw new InvoiceArchiveError(rejected.code, rejected.message, refusal);
    }
    const reject = async (code: "period_locked" | "policy_decision_required", message: string): Promise<never> => {
      await client.query(`INSERT INTO invoice_archive_rejections (idempotency_key,invoice_id,actor_user_id,request_hash,code,message)
        VALUES ($1,$2,$3,$4,$5,$6)`, [command.idempotencyKey,invoiceId,session.userId,hash,code,message]);
      await authority(client, session, true); await client.query("COMMIT"); committed = true;
      throw new InvoiceArchiveError(code, message, refusal);
    };
    const current = await view(client, invoice, true);
    if (command.expectedVersion !== current.version) throw new InvoiceArchiveError("stale", "تغيرت حالة الأرشفة؛ حدّث المعاينة قبل طلب جديد.",
      current.version > command.expectedVersion ? { ...command, kind: "version_advanced", invoiceId, patientId: invoice.patientId, actor: session.username, currentVersion: current.version } : undefined);
    if (current.archived === (command.action === "archive")) {
      await authority(client, session, true); await client.query("COMMIT");
      return { receipt: current.latest, current, replayed: false, noop: true, acknowledgment };
    }
    await client.query("LOCK TABLE settings IN SHARE MODE");
    if (await locked(client, invoice)) await reject("period_locked", "الفاتورة في فترة مقفلة؛ الأرشفة والاسترجاع غير متاحين لهذه الفترة.");
    if (command.action === "archive" && !current.eligibility.canArchive) {
      await reject(current.eligibility.code === "period_locked" ? "period_locked" : "policy_decision_required", current.eligibility.message ?? "تسوية الفاتورة تحتاج مراجعة.");
    }
    const { rows: [event] } = await client.query<EventRow>(`INSERT INTO invoice_archive_events
      (invoice_id,patient_id,invoice_number,invoice_created_at,currency,version,action,reason,idempotency_key,request_hash,actor_user_id,actor)
      SELECT id,patient_id,invoice_number,created_at,base_currency,$2,$3,$4,$5,$6,$7,$8 FROM invoices WHERE id=$1 RETURNING *,id::text`,
    [invoiceId, current.version + 1, command.action, command.reason, command.idempotencyKey, hash, session.userId, session.username]);
    await insertAuditRow(client, { action: command.action === "archive" ? "invoice.archive" : "invoice.restore", entity: "invoice", entityId: invoiceId,
      entityLabel: invoice.invoiceNumber, actor: session.username, actorRole: session.role,
      details: { السبب: command.reason, المريض: invoice.patientId, النسخة: event.version, الإجراء: command.action, أثر_محاسبي: "لا تغيير في الفاتورة أو الدين أو السندات" } });
    const result = { receipt: receipt(event), current: await view(client, invoice, true), replayed: false, noop: false, acknowledgment };
    await authority(client, session, true); await client.query("COMMIT"); return result;
  } catch (error) { if (!committed) try { await client.query("ROLLBACK"); } catch { destroy = true; } throw error; }
  finally { client.release(destroy); }
}
