import { PATIENT_COUNTER_LOCK_SQL } from "./patient-numbering-schema";
import type { DbClient } from "./db";
import { counterIdentifierBigintSql } from "./counter-identifier-sql";
import { canonicalPatientPrefix, LEGACY_NUMBER_MAX, MANAGED_NUMBER_MAX, patientNumberDigits, patientNumberFloor } from "./patient-numbering-input";

export interface PatientNumberingSnapshot {
  prefix: string;
  nextNumber: string;
  perPrefix?: true;
}

export interface PatientNumberingInput {
  prefix: string;
  firstNumber: string;
  requestId: string;
}

export type PatientNumberingErrorCode = "invalid_input" | "number_consumed" | "request_conflict";

export class PatientNumberingError extends Error {
  constructor(public readonly code: PatientNumberingErrorCode) {
    super(code);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeInput(input: PatientNumberingInput): PatientNumberingInput {
  const prefix = typeof input?.prefix === "string" && canonicalPatientPrefix(input.prefix);
  const firstNumber = typeof input?.firstNumber === "string" && patientNumberDigits(input.firstNumber);
  if (!prefix || !firstNumber || !/^[1-9][0-9]{0,18}$/.test(firstNumber)
    || BigInt(firstNumber) > LEGACY_NUMBER_MAX || typeof input.requestId !== "string" || !UUID.test(input.requestId)) {
    throw new PatientNumberingError("invalid_input");
  }
  return { prefix, firstNumber, requestId: input.requestId.toLowerCase() };
}

type QueryClient = Pick<DbClient, "query">;

async function numberingProfile(client: QueryClient): Promise<{ prefix: string; first: string; managed: boolean; hasPolicy: boolean }> {
  const { rows: [catalog] } = await client.query<{ has_policy: boolean; managed: boolean }>(
    `SELECT pg_catalog.to_regclass('public.patient_numbering_policy') IS NOT NULL AS has_policy,
            (pg_catalog.to_regnamespace('numbering_bridge') IS NOT NULL OR EXISTS (
              SELECT FROM pg_catalog.pg_constraint
              WHERE conrelid = pg_catalog.to_regclass('public.patient_numbering_policy')
                AND conname = 'patient_numbering_managed_first_range')) AS managed`,
  );
  if (!catalog?.has_policy) {
    return { prefix: "P", first: "7000", managed: Boolean(catalog?.managed), hasPolicy: false };
  }
  const { rows: [profile] } = await client.query<{ prefix: string; first: string }>(
    `SELECT coalesce(policy.prefix, 'P') AS prefix, coalesce(policy.first_number, 7000)::text AS first
       FROM (VALUES (true)) anchor(singleton) LEFT JOIN public.patient_numbering_policy policy USING (singleton)`,
  );
  return { prefix: profile.prefix, first: profile.first, managed: Boolean(catalog.managed), hasPolicy: true };
}

async function managedSnapshot(client: QueryClient, prefix: string): Promise<PatientNumberingSnapshot> {
  const { rows: [snapshot] } = await client.query<{ nextNumber: string }>(`
    WITH limits AS MATERIALIZED (
      SELECT numbering_bridge.next_available($1) AS independent_next,
             numbering_bridge.local_consumed($1) AS consumed
    )
    SELECT greatest(independent_next, consumed::numeric + 1, policy.first_number,
             CASE WHEN $1 = 'P' THEN seq.last_value::numeric + seq.is_called::int END)::text AS "nextNumber"
      FROM limits CROSS JOIN public.patient_number_seq seq
      LEFT JOIN public.patient_numbering_policy policy ON policy.singleton AND policy.prefix = $1
     WHERE independent_next BETWEEN $2::numeric AND ($3::numeric + 1) AND consumed BETWEEN 0 AND $3::numeric`,
  [prefix, patientNumberFloor(prefix, true).toString(), MANAGED_NUMBER_MAX.toString()]);
  if (!snapshot) throw new Error("Unavailable independent numbering bounds");
  return { prefix, nextNumber: snapshot.nextNumber, perPrefix: true };
}

// Use numeric for the projection, so exhausted bigint sequences report their
// next position accurately without overflowing or rounding through JavaScript.
async function legacySnapshot(client: QueryClient, hasPolicy = true): Promise<PatientNumberingSnapshot> {
  if (!hasPolicy) {
    const { rows } = await client.query<PatientNumberingSnapshot>(
      `SELECT 'P' AS prefix,
              greatest(7000,
                seq.last_value::numeric + seq.is_called::int,
                coalesce((SELECT max(${counterIdentifierBigintSql("patient_number")})::numeric + 1 FROM public.patients), 7000)
              )::text AS "nextNumber"
         FROM public.patient_number_seq seq`,
    );
    return rows[0];
  }
  const { rows } = await client.query<PatientNumberingSnapshot>(
    `SELECT coalesce(policy.prefix, 'P') AS prefix,
            greatest(7000, policy.first_number,
              seq.last_value::numeric + seq.is_called::int,
              coalesce((
                SELECT max(n)::numeric + 1 FROM (
                  SELECT ${counterIdentifierBigintSql("patient_number")} AS n FROM public.patients
                  UNION ALL
                  SELECT ${counterIdentifierBigintSql("patient_number")} AS n FROM public.patient_number_retirements
                ) known
              ), 7000)
            )::text AS "nextNumber"
       FROM public.patient_number_seq seq
       LEFT JOIN public.patient_numbering_policy policy ON policy.singleton`,
  );
  return rows[0];
}

async function confirmActiveChoice(client: QueryClient, profile: { prefix: string; first: string }) {
  const { rows: [choice] } = await client.query<{ prefix: string; first: string }>(
    "SELECT active_prefix AS prefix, active_first::text AS first FROM numbering_bridge.active_choice()",
  );
  if (choice?.prefix !== profile.prefix || choice.first !== profile.first) {
    throw new Error("Independent and local numbering selections disagree");
  }
}

export async function readPatientNumbering(client: QueryClient): Promise<PatientNumberingSnapshot> {
  const profile = await numberingProfile(client);
  if (!profile.managed) return legacySnapshot(client, profile.hasPolicy);
  await confirmActiveChoice(client, profile);
  return managedSnapshot(client, profile.prefix);
}

/** Runtime bootstrap has reconciled the surviving patient rows. A configured
 * first number can still be pending, and a retired file has no surviving row.
 * A complete backup also restores the sequence itself for reservations which
 * never produced a patient or retirement record. */
export async function reconcilePatientNumberingPolicy(client: DbClient): Promise<void> {
  await client.query("LOCK TABLE patients IN SHARE ROW EXCLUSIVE MODE");
  await client.query(PATIENT_COUNTER_LOCK_SQL);
  const profile = await numberingProfile(client);
  if (profile.managed) {
    const { rows: [mirror] } = await client.query<{ consistent: boolean }>(`
      SELECT pg_catalog.to_regprocedure('numbering_bridge.next_available(text)') IS NOT NULL
        AND pg_catalog.to_regprocedure('numbering_bridge.select_prefix(text,bigint)') IS NOT NULL
        AND numbering_bridge.local_consumed('P') < seq.last_value::numeric + seq.is_called::int AS consistent
      FROM public.patient_number_seq seq`);
    if (!mirror?.consistent) throw new Error("Incomplete managed numbering bridge or inconsistent P sequence");
    return;
  }
  if (!profile.hasPolicy) return;
  await client.query(`WITH known AS (
    SELECT coalesce((SELECT first_number FROM patient_numbering_policy WHERE singleton), 7000) AS floor,
           coalesce(max(${counterIdentifierBigintSql("patient_number")}), 0) AS retired
      FROM (
        SELECT patient_number FROM patients
        UNION ALL
        SELECT patient_number FROM patient_number_retirements
      ) all_numbers
  )
  SELECT setval('patient_number_seq', greatest(known.floor, known.retired, seq.last_value),
    CASE WHEN greatest(known.floor, known.retired) > seq.last_value THEN known.retired >= known.floor
         WHEN greatest(known.floor, known.retired) = seq.last_value THEN seq.is_called OR known.retired = seq.last_value
         ELSE seq.is_called END)
    FROM known, patient_number_seq seq
   WHERE seq.last_value < greatest(known.floor, known.retired)
      OR (known.retired = seq.last_value AND NOT seq.is_called)`);
}

/** Caller owns a READ COMMITTED transaction and verifies ownership in it. */
export async function configurePatientNumbering(
  client: DbClient,
  request: PatientNumberingInput,
  actor: { userId: number; username: string; role: string },
): Promise<PatientNumberingSnapshot> {
  const input = normalizeInput(request);
  const { requestId } = input;
  // INSERT obtains ROW EXCLUSIVE before evaluating nextval, including on old
  // binaries. The sequence lock also covers reservations without a patient row.
  await client.query("LOCK TABLE patients IN SHARE ROW EXCLUSIVE MODE");
  const isolation = await client.query<{ level: string }>("SELECT current_setting('transaction_isolation') AS level");
  if (isolation.rows[0].level !== "read committed") throw new Error("Patient numbering needs READ COMMITTED");
  const profile = await numberingProfile(client);
  const first = BigInt(input.firstNumber);
  if (first < patientNumberFloor(input.prefix, profile.managed) || (profile.managed && first > MANAGED_NUMBER_MAX)) {
    throw new PatientNumberingError("invalid_input");
  }
  const { rows: receipts } = await client.query<{
    details: { userId: number; prefix: string; firstNumber: string };
  }>(
    `SELECT details FROM audit_log
      WHERE entity = 'patient_numbering' AND action = 'settings.update' AND entity_id = $1
      ORDER BY id LIMIT 1`,
    [requestId],
  );
  if (receipts[0]) {
    const previous = receipts[0].details;
    if (previous.userId !== actor.userId || previous.prefix !== input.prefix || previous.firstNumber !== input.firstNumber) {
      throw new PatientNumberingError("request_conflict");
    }
    if (profile.managed) {
      await confirmActiveChoice(client, profile);
      await managedSnapshot(client, input.prefix);
    }
    return { prefix: previous.prefix, nextNumber: previous.firstNumber, ...(profile.managed && { perPrefix: true as const }) };
  }
  // PostgreSQL holds this DDL lock until commit. RESTART is transactional
  // unlike setval: a failed audit or rolled-back settings write cannot move it.
  await client.query(PATIENT_COUNTER_LOCK_SQL);
  const before = profile.managed ? await managedSnapshot(client, profile.prefix) : await legacySnapshot(client, profile.hasPolicy);
  const target = profile.managed && before.prefix !== input.prefix ? await managedSnapshot(client, input.prefix) : before;
  if (first < BigInt(target.nextNumber)) throw new PatientNumberingError("number_consumed");
  if (!profile.managed) {
    const sequence = await client.query<{ next: string }>(
      "SELECT (last_value::numeric + is_called::int)::text AS next FROM patient_number_seq",
    );
    if (first > BigInt(sequence.rows[0].next)) {
      // Utility statements cannot take bind parameters. The input is already a bounded decimal.
      await client.query(`ALTER SEQUENCE patient_number_seq RESTART WITH ${input.firstNumber}`);
    }
  }
  await client.query(
    `INSERT INTO patient_numbering_policy (singleton, prefix, first_number) VALUES (true, $1, $2)
     ON CONFLICT (singleton) DO UPDATE SET prefix = EXCLUDED.prefix, first_number = EXCLUDED.first_number`,
    [input.prefix, input.firstNumber],
  );
  await client.query(
    `INSERT INTO audit_log (action, entity, entity_id, summary, details, actor, actor_role)
     VALUES ('settings.update', 'patient_numbering', $1, 'ترقيم ملفات المرضى الجديدة', $2::jsonb, $3, $4)`,
    [requestId,
      JSON.stringify({ userId: actor.userId, prefix: input.prefix, firstNumber: input.firstNumber, before }),
      actor.username, actor.role],
  );
  if (profile.managed) {
    try {
      const { rows: [confirmed] } = await client.query<{ prefix: string }>(
        "SELECT numbering_bridge.select_prefix($1, $2::bigint) AS prefix", [input.prefix, input.firstNumber],
      );
      if (confirmed?.prefix !== input.prefix) throw new Error("Independent numbering selection was not confirmed");
    } catch (error) {
      if ((error as { code?: string })?.code === "22003") throw new PatientNumberingError("number_consumed");
      throw error;
    }
  }
  return { prefix: input.prefix, nextNumber: input.firstNumber, ...(profile.managed && { perPrefix: true as const }) };
}
