import { createHash } from "node:crypto";
import type { AuditInput, DbClient, DbPool } from "./db";
import { isValidTooth, toothName } from "./dental";
import { withTransaction } from "./transactions";
import { isPeriodontalId, parsePeriodontalCommand, parsePeriodontalSites,
  type PeriodontalCommand, type PeriodontalRecord } from "./periodontal";

/** Unregistered domain: no production adapter, route, initializer or UI calls this factory. */
export interface PeriodontalPorts {
  pool: DbPool;
  /**
   * Trusted adapter must call requireSession(client), then canonical
   * canAccessPatient(session, patientId, undefined, client) on EVERY invocation.
   * Both use this transaction's client: current account FOR SHARE plus one
   * granting ownership row stay locked through audit/commit. A preflight check,
   * pool query or cached principal is not an implementation of this contract.
   * No production adapter is registered by this inactive foundation.
   */
  authorizePatient(client: DbClient, patientId: number): Promise<{ username: string; role: string } | null>;
  /** Activation must pass the canonical throwing insertAuditRow, on this same client. */
  insertAudit(client: DbClient, input: AuditInput): Promise<void>;
}
export type PeriodontalRefusal = "invalid" | "denied" | "not_found" | "head_conflict" | "request_conflict";
type Refused = { ok: false; reason: PeriodontalRefusal; message: string };
const refusal = (reason: PeriodontalRefusal, message: string): Refused => ({ ok: false, reason, message });
const denied = () => refusal("denied", "غير مصرّح لك بهذا الإجراء على مخطط المريض.");
const missing = () => refusal("not_found", "ملف المريض غير موجود.");
const conflict = () => refusal("request_conflict", "مفتاح الحفظ مستخدم لطلب مختلف. تحقّق من السجل المحفوظ.");
interface RecordRow {
  id: number; patient_id: number; tooth_code: number; prior_record_id: number | null;
  recorded_by: string; recorded_at: Date; sites: unknown;
}
const RECORD_SELECT = `SELECT r.id, r.patient_id, r.tooth_code, r.prior_record_id, r.recorded_by, r.recorded_at,
  (SELECT jsonb_agg(jsonb_build_object('surface', s.surface, 'position', s.position,
    'depthMm', s.depth_mm::text, 'bleeding', s.bleeding) ORDER BY s.surface, s.position)
    FROM periodontal_sites s WHERE s.record_id = r.id) AS sites
  FROM periodontal_records r`;

function recordView(row: RecordRow): PeriodontalRecord {
  const sites = parsePeriodontalSites(row.sites);
  if (!sites.ok || !isPeriodontalId(row.id) || !isPeriodontalId(row.patient_id)
    || !isValidTooth(row.tooth_code) || (row.prior_record_id !== null && !isPeriodontalId(row.prior_record_id))
    || typeof row.recorded_by !== "string" || !row.recorded_by.trim()
    || !(row.recorded_at instanceof Date) || !Number.isFinite(row.recorded_at.getTime())
    || !sites.value.some((site) => site.depthMm !== null || site.bleeding !== null)) {
    // Missing/corrupt storage is unavailable, never an invented empty/healthy chart.
    throw new Error("تعذّر التحقق من قياسات اللثة المحفوظة.");
  }
  return { id: row.id, patientId: row.patient_id, toothCode: row.tooth_code,
    priorRecordId: row.prior_record_id, recordedBy: row.recorded_by,
    recordedAt: row.recorded_at.toISOString(), sites: sites.value };
}

function fingerprint(patientId: number, actor: string, command: PeriodontalCommand): string {
  return createHash("sha256").update(JSON.stringify({ patientId, actor, toothCode: command.toothCode,
    expectedHeadId: command.expectedHeadId, sites: command.sites })).digest("hex");
}

/** To be called by the EXISTING patient-delete transaction only after activation. */
export async function periodontalHistoryCount(client: DbClient, patientId: number): Promise<number> {
  if (!isPeriodontalId(patientId)) throw new Error("رقم المريض غير صالح.");
  const { rows } = await client.query<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM periodontal_records WHERE patient_id = $1", [patientId]);
  if (rows.length !== 1 || !Number.isInteger(rows[0].count) || rows[0].count < 0) {
    throw new Error("تعذّر التحقق من السجل السريري.");
  }
  return rows[0].count;
}

export function createPeriodontalDomain(ports: PeriodontalPorts) {
  async function save(patientId: number, raw: unknown): Promise<Refused | {
    ok: true; replayed: boolean; record: PeriodontalRecord;
  }> {
    if (!isPeriodontalId(patientId)) return refusal("invalid", "رقم المريض غير صالح.");
    // Detach caller-owned intent before any connection/account/row-lock await.
    // Validation (including capture exceptions) is disclosed only after locked admission.
    const checked: ReturnType<typeof parsePeriodontalCommand> = (() => {
      try { return parsePeriodontalCommand(raw); }
      catch { return { ok: false, message: "طلب قياسات اللثة غير صالح." }; }
    })();
    try {
      return await withTransaction(ports.pool, async (client) => {
        // Patient first: serialize first saves, corrections, canonical merge and patient deletion.
        const { rows: patients } = await client.query("SELECT id FROM patients WHERE id = $1 FOR UPDATE", [patientId]);
        const authorized = await ports.authorizePatient(client, patientId);
        if (!authorized || !authorized.username.trim() || !["doctor", "admin"].includes(authorized.role)) return denied();
        const principal = { username: authorized.username, role: authorized.role };
        if (!checked.ok) return refusal("invalid", checked.message);
        if (!patients[0]) return missing();
        const command = checked.value;
        const hash = fingerprint(patientId, principal.username, command);
        const { rows: replays } = await client.query<{
          id: number; patient_id: number; tooth_code: number; request_fingerprint: string;
        }>(`SELECT id, patient_id, tooth_code, request_fingerprint FROM periodontal_records
              WHERE recorded_by = $1 AND request_key = $2`, [principal.username, command.requestKey]);
        if (replays[0]) {
          const replay = replays[0];
          if (replay.patient_id !== patientId || replay.tooth_code !== command.toothCode || replay.request_fingerprint !== hash) return conflict();
          const { rows } = await client.query<RecordRow>(`${RECORD_SELECT} WHERE r.id = $1 AND r.patient_id = $2`, [replay.id, patientId]);
          if (!rows[0]) throw new Error("تعذّر التحقق من نتيجة الحفظ السابقة.");
          return { ok: true as const, replayed: true, record: recordView(rows[0]) };
        }
        const { rows: heads } = await client.query<{ id: number }>(`SELECT id FROM periodontal_records
          WHERE patient_id = $1 AND tooth_code = $2 ORDER BY id DESC LIMIT 1`, [patientId, command.toothCode]);
        const headId = heads[0]?.id ?? null;
        if (headId !== command.expectedHeadId) return refusal("head_conflict", "تغيّر سجل هذا السن. أعد قراءته قبل حفظ قياس جديد.");
        const { rows: inserted } = await client.query<{ id: number }>(`INSERT INTO periodontal_records
          (patient_id, tooth_code, prior_record_id, request_key, request_fingerprint, recorded_by)
          VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [patientId, command.toothCode, headId, command.requestKey, hash, principal.username]);
        const recordId = inserted[0]?.id;
        if (!isPeriodontalId(recordId)) throw new Error("تعذّر إنشاء سجل قياسات اللثة.");
        for (const site of command.sites) {
          await client.query(`INSERT INTO periodontal_sites (record_id, surface, position, depth_mm, bleeding)
            VALUES ($1, $2, $3, $4::numeric, $5::boolean)`,
          [recordId, site.surface, site.position, site.depthMm, site.bleeding]);
        }
        await ports.insertAudit(client, {
          action: "perio.record", entity: "patient", entityId: patientId, entityLabel: toothName(command.toothCode),
          actor: principal.username, actorRole: principal.role,
          details: { recordId, toothCode: command.toothCode, priorRecordId: headId,
            depthSites: command.sites.filter((site) => site.depthMm !== null).length,
            bleedingSitesRecorded: command.sites.filter((site) => site.bleeding !== null).length },
        });
        const { rows } = await client.query<RecordRow>(`${RECORD_SELECT} WHERE r.id = $1 AND r.patient_id = $2`, [recordId, patientId]);
        if (!rows[0]) throw new Error("تعذّر التحقق من سجل قياسات اللثة.");
        return { ok: true as const, replayed: false, record: recordView(rows[0]) };
      });
    } catch (error) {
      // Same key on distinct patients can race without sharing a patient lock. Never retarget it.
      if ((error as { code?: string })?.code === "23505"
        && (error as { constraint?: string })?.constraint === "periodontal_records_one_request") return conflict();
      throw error;
    }
  }

  async function read(patientId: number, history?: { toothCode: number; beforeId: number | null }): Promise<Refused | {
    ok: true; records: PeriodontalRecord[]; nextBeforeId: number | null;
  }> {
    if (!isPeriodontalId(patientId)) return refusal("invalid", "رقم المريض غير صالح.");
    let scope: typeof history;
    let invalidHistory = false;
    try {
      scope = history ? { toothCode: history.toothCode, beforeId: history.beforeId } : undefined;
      invalidHistory = Boolean(scope && (!isValidTooth(scope.toothCode)
        || (scope.beforeId !== null && !isPeriodontalId(scope.beforeId))));
    } catch { invalidHistory = true; }
    return withTransaction(ports.pool, async (client) => {
      const { rows: patients } = await client.query("SELECT id FROM patients WHERE id = $1 FOR KEY SHARE", [patientId]);
      if (!await ports.authorizePatient(client, patientId)) return denied();
      if (invalidHistory) {
        return refusal("invalid", "مرجع سجل السن غير صالح.");
      }
      if (!patients[0]) return missing();
      const { rows } = await client.query<RecordRow>(scope
        ? `${RECORD_SELECT} WHERE r.patient_id = $1 AND r.tooth_code = $2 AND ($3::int IS NULL OR r.id < $3)
            ORDER BY r.id DESC LIMIT 51`
        : `${RECORD_SELECT} WHERE r.patient_id = $1 AND r.id IN
            (SELECT MAX(id) FROM periodontal_records WHERE patient_id = $1 GROUP BY tooth_code) ORDER BY r.tooth_code`,
      scope ? [patientId, scope.toothCode, scope.beforeId] : [patientId]);
      const more = Boolean(scope && rows.length > 50);
      const records = (more ? rows.slice(0, 50) : rows).map(recordView);
      return { ok: true as const, records, nextBeforeId: more ? records[records.length - 1].id : null };
    });
  }
  return { save, read };
}
