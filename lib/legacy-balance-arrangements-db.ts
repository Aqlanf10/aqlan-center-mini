import { ensureSchema, getPool, type DbClient } from "./db";
import { isCurrency, type Currency } from "./money";
import {
  legacyArrangementProgress,
  type LegacyArrangementCadence,
  type LegacyBalanceArrangement,
  type LegacyArrangementProgress,
} from "./legacy-balance-arrangements";

interface ArrangementRow {
  id: number;
  patient_id: number;
  currency: string;
  cadence: LegacyArrangementCadence;
  installment_minor: string;
  starting_due_minor: string;
  first_due_date: string | Date | null;
  note: string | null;
  created_by: string;
  created_at: Date;
  cancelled_by: string | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
}

export interface LegacyBalanceArrangementView extends LegacyBalanceArrangement {
  progress: LegacyArrangementProgress;
}

function dateOnly(value: string | Date | null): string | null {
  if (value === null) return null;
  if (typeof value === "string") return value.slice(0, 10);
  /* pg يقرأ DATE منتصف ليلٍ محلي؛ toISOString يزيحه يومًا في خادمٍ شرق UTC — فالمكونات المحلية. */
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function rowToArrangement(row: ArrangementRow): LegacyBalanceArrangement {
  if (!isCurrency(row.currency)) throw new Error(`عملة ترتيب رصيد قديم غير صالحة: ${row.currency}`);
  return {
    id: row.id,
    patientId: row.patient_id,
    currency: row.currency,
    cadence: row.cadence,
    installmentMinor: Number(row.installment_minor),
    startingDueMinor: Number(row.starting_due_minor),
    firstDueDate: dateOnly(row.first_due_date),
    note: row.note,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    cancelledBy: row.cancelled_by,
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
    cancelReason: row.cancel_reason,
  };
}

async function openingPosition(
  client: Pick<DbClient, "query">,
  patientId: number,
  currency: Currency,
): Promise<{ openingMinor: number; settledMinor: number; remainingMinor: number } | null> {
  const { rows } = await client.query<{ amount_minor: string; settled_minor: string }>(
    `SELECT o.amount_minor::text,
            COALESCE(SUM(
              (CASE WHEN p.kind = 'refund' THEN -1 ELSE 1 END) *
              (CASE
                 WHEN p.currency = o.currency THEN p.amount_minor
                 WHEN o.currency = 'YER' THEN p.base_amount_minor
                 ELSE 0
               END)
            ), 0)::text AS settled_minor
       FROM patient_opening_balances o
       LEFT JOIN payments p
         ON p.patient_id = o.patient_id AND p.opening_currency = o.currency
      WHERE o.patient_id = $1 AND o.currency = $2
      GROUP BY o.patient_id, o.currency, o.amount_minor`,
    [patientId, currency],
  );
  const row = rows[0];
  if (!row) return null;
  const openingMinor = Number(row.amount_minor);
  const settledMinor = Number(row.settled_minor);
  return { openingMinor, settledMinor, remainingMinor: Math.max(0, openingMinor - settledMinor) };
}

export interface LegacyOpeningPosition {
  currency: Currency;
  openingMinor: number;
  settledMinor: number;
  remainingMinor: number;
}

export async function listLegacyOpeningPositions(patientId: number): Promise<LegacyOpeningPosition[]> {
  await ensureSchema();
  const { rows } = await getPool().query<{ currency: string }>(
    `SELECT currency FROM patient_opening_balances WHERE patient_id = $1 ORDER BY currency`,
    [patientId],
  );
  const positions: LegacyOpeningPosition[] = [];
  for (const row of rows) {
    if (!isCurrency(row.currency)) throw new Error(`عملة رصيد افتتاحي غير صالحة: ${row.currency}`);
    const position = await openingPosition(getPool() as unknown as DbClient, patientId, row.currency);
    if (position) positions.push({ currency: row.currency, ...position });
  }
  return positions;
}

async function paidSince(
  patientId: number,
  currency: Currency,
  since: Date,
): Promise<number> {
  const { rows } = await getPool().query<{
    payment_currency: string;
    amount_minor: string;
    base_amount_minor: string;
  }>(
    `SELECT currency AS payment_currency,
            COALESCE(SUM((CASE WHEN kind = 'refund' THEN -1 ELSE 1 END) * amount_minor), 0)::text AS amount_minor,
            COALESCE(SUM((CASE WHEN kind = 'refund' THEN -1 ELSE 1 END) * base_amount_minor), 0)::text AS base_amount_minor
       FROM payments
      WHERE patient_id = $1 AND opening_currency = $2 AND created_at >= $3
      GROUP BY currency`,
    [patientId, currency, since],
  );
  let settled = 0;
  for (const row of rows) {
    if (!isCurrency(row.payment_currency)) {
      throw new Error(`عملة دفعة رصيد سابق غير صالحة: ${row.payment_currency}`);
    }
    if (row.payment_currency === currency) settled += Number(row.amount_minor);
    else if (currency === "YER") settled += Number(row.base_amount_minor);
    else {
      // مسار الدفع يمنع أصلًا foreign→foreign، فنفشل هنا بدل تخمين تحويل تاريخي.
      throw new Error(`دفعة رصيد سابق بعملة غير قابلة للتسوية: ${row.payment_currency} → ${currency}`);
    }
  }
  return Math.max(0, settled);
}

async function viewOf(row: ArrangementRow, today: string): Promise<LegacyBalanceArrangementView> {
  const arrangement = rowToArrangement(row);
  const position = await openingPosition(getPool() as unknown as DbClient, arrangement.patientId, arrangement.currency);
  const paid = await paidSince(arrangement.patientId, arrangement.currency, row.created_at);
  return {
    ...arrangement,
    progress: legacyArrangementProgress({
      startingDueMinor: arrangement.startingDueMinor,
      installmentMinor: arrangement.installmentMinor,
      cadence: arrangement.cadence,
      firstDueDate: arrangement.firstDueDate,
      currentOpeningDueMinor: position?.remainingMinor ?? 0,
      paidSinceStartMinor: paid,
      today,
    }),
  };
}

export async function listLegacyBalanceArrangements(
  patientId: number,
  today: string,
  includeCancelled = false,
): Promise<LegacyBalanceArrangementView[]> {
  await ensureSchema();
  const { rows } = await getPool().query<ArrangementRow>(
    `SELECT * FROM legacy_balance_arrangements
      WHERE patient_id = $1 ${includeCancelled ? "" : "AND cancelled_at IS NULL"}
      ORDER BY created_at DESC, id DESC`,
    [patientId],
  );
  return Promise.all(rows.map((row) => viewOf(row, today)));
}

export type CreateLegacyArrangementResult =
  | { ok: true; arrangement: LegacyBalanceArrangementView }
  | { ok: false; reason: "patient_not_found" | "no_opening_balance" | "opening_settled" | "already_active" | "installment_exceeds_remaining" };

export async function createLegacyBalanceArrangement(input: {
  patientId: number;
  currency: Currency;
  cadence: LegacyArrangementCadence;
  installmentMinor: number;
  firstDueDate: string | null;
  note: string | null;
  createdBy: string;
  today: string;
}): Promise<CreateLegacyArrangementResult> {
  await ensureSchema();
  const client = await getPool().connect();
  let created: ArrangementRow | null = null;
  try {
    await client.query("BEGIN");
    const patient = await client.query(`SELECT 1 FROM patients WHERE id = $1 FOR SHARE`, [input.patientId]);
    if (!patient.rowCount) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "patient_not_found" };
    }
    const locked = await client.query(
      `SELECT 1 FROM patient_opening_balances WHERE patient_id = $1 AND currency = $2 FOR UPDATE`,
      [input.patientId, input.currency],
    );
    if (!locked.rowCount) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "no_opening_balance" };
    }
    const position = await openingPosition(client, input.patientId, input.currency);
    if (!position || position.remainingMinor <= 0) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "opening_settled" };
    }
    if (input.installmentMinor > position.remainingMinor) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "installment_exceeds_remaining" };
    }
    const active = await client.query(
      `SELECT id FROM legacy_balance_arrangements
        WHERE patient_id = $1 AND currency = $2 AND cancelled_at IS NULL FOR UPDATE`,
      [input.patientId, input.currency],
    );
    if (active.rowCount) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "already_active" };
    }
    const inserted = await client.query<ArrangementRow>(
      `INSERT INTO legacy_balance_arrangements
         (patient_id, currency, cadence, installment_minor, starting_due_minor,
          first_due_date, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8)
       RETURNING *`,
      [
        input.patientId, input.currency, input.cadence, input.installmentMinor,
        position.remainingMinor, input.cadence === "monthly" ? input.firstDueDate : null,
        input.note, input.createdBy,
      ],
    );
    created = inserted.rows[0];
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if ((error as { code?: string } | null)?.code === "23505") {
      return { ok: false, reason: "already_active" };
    }
    throw error;
  } finally {
    client.release();
  }
  return { ok: true, arrangement: await viewOf(created!, input.today) };
}

export type CancelLegacyArrangementResult =
  | { ok: true; arrangement: LegacyBalanceArrangement }
  | { ok: false; reason: "not_found" | "already_cancelled" };

export async function cancelLegacyBalanceArrangement(input: {
  patientId: number;
  arrangementId: number;
  actor: string;
  reason: string;
}): Promise<CancelLegacyArrangementResult> {
  await ensureSchema();
  const { rows } = await getPool().query<ArrangementRow>(
    `UPDATE legacy_balance_arrangements
        SET cancelled_by = $3, cancelled_at = NOW(), cancel_reason = $4
      WHERE id = $1 AND patient_id = $2 AND cancelled_at IS NULL
      RETURNING *`,
    [input.arrangementId, input.patientId, input.actor, input.reason],
  );
  if (rows[0]) return { ok: true, arrangement: rowToArrangement(rows[0]) };
  const existing = await getPool().query(
    `SELECT cancelled_at FROM legacy_balance_arrangements WHERE id = $1 AND patient_id = $2`,
    [input.arrangementId, input.patientId],
  );
  return existing.rowCount
    ? { ok: false, reason: "already_cancelled" }
    : { ok: false, reason: "not_found" };
}
