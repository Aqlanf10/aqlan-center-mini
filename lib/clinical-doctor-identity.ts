import type { DbClient } from "./db";

/** An explicit performer is clinical provenance, never a hint to replace silently. */
export class ClinicalDoctorIdentityConflict extends Error {
  readonly code = "invalid_procedure_doctor";

  constructor() {
    super("طبيب أحد الإجراءات غير صالح — اختر طبيبًا معالجًا صحيحًا قبل الحفظ أو التوقيع.");
  }
}

const partyId = (value: number): boolean => Number.isInteger(value) && value > 0 && value <= 2_147_483_647;

/**
 * Caller owns the transaction. SHARE protects the non-key kind field through
 * commit; KEY SHARE would still allow it to change after this check. Match the
 * existing sign-off semantics: a real doctor remains valid when inactive.
 */
export async function lockClinicalDoctors(
  client: DbClient,
  explicitDoctorIds: readonly (number | null | undefined)[],
  fallbackDoctorIds: readonly (number | null | undefined)[] = [],
): Promise<Set<number>> {
  const explicit = [...new Set(explicitDoctorIds.filter((id): id is number => id != null))];
  if (explicit.some((id) => !partyId(id))) throw new ClinicalDoctorIdentityConflict();
  const candidates = [...new Set([...explicit, ...fallbackDoctorIds.filter(
    (id): id is number => typeof id === "number" && partyId(id),
  )])].sort((a, b) => a - b);
  if (candidates.length === 0) return new Set();
  const { rows } = await client.query<{ id: number }>(
    `SELECT id FROM parties WHERE id = ANY($1::int[]) AND kind = 'doctor' ORDER BY id FOR SHARE`,
    [candidates],
  );
  const doctors = new Set(rows.map((row) => row.id));
  if (explicit.some((id) => !doctors.has(id))) throw new ClinicalDoctorIdentityConflict();
  return doctors;
}
