import { readStaffEntryMode } from "./legacy-staff-schema.mjs";

/** Read-only review aid. This is not an authority proof or a provisioning plan
 * that can be applied. No account is inferred and no connection is opened here. */
export async function inspectClinicOwnerBindingCandidate(source, { userId, doctorId }) {
  for (const id of [userId, doctorId]) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("OWNER_PLAN_EXPLICIT_IDS_REQUIRED");
  }
  const mode = await readStaffEntryMode(source);
  if (mode !== "legacy") return { mode, canApply: false, blockers: ["CANONICAL_REGISTRY_REQUIRED"] };
  const { rows } = await source.query(`SELECT u.id AS user_id, u.role, u.is_active AS user_active,
    u.party_id AS linked_doctor_id, p.id AS doctor_id, p.kind, p.is_active AS doctor_active
    FROM users u CROSS JOIN parties p WHERE u.id=$1 AND p.id=$2`, [userId, doctorId]);
  const candidate = rows.length === 1 ? rows[0] : null;
  const eligible = !!candidate && candidate.user_active === true && candidate.doctor_active === true
    && candidate.kind === "doctor" && ["admin", "doctor"].includes(candidate.role)
    && candidate.linked_doctor_id === doctorId;
  return {
    mode, canApply: false, candidate, eligibleForFurtherReview: eligible,
    blockers: [...(!eligible ? ["ACCOUNT_PROVIDER_PAIR_INVALID"] : []),
      "BINDING_SCHEMA_NOT_IMPLEMENTED", "TARGET_INSTALLATION_WITNESS_NOT_INTEGRATED", "EXPLICIT_PROVISIONING_REVIEW_REQUIRED"],
  };
}
