import { checksumOf, type MigrationFile } from "../../lib/migration-files";

// Reviewed shipped identities, not an assumption that every reserved number exists.
// Keep historical 0001–0043 intact. 0044–0050 are not part of this reviewed chain;
// 0050 remains reserved separately. Extend this list only with reviewed migration files.
export const REVIEWED_MIGRATION_FILENAMES = [
  "0001_baseline_schema.sql",
  "0002_confirmation_claim_ttl_index.sql",
  "0003_payment_idempotency_and_reversal.sql",
  "0004_material_rate_history.sql",
  "0005_financial_append_only.sql",
  "0006_appointment_lifecycle.sql",
  "0007_appointment_services_and_capacity.sql",
  "0008_appointment_chair_and_new_patient_snapshots.sql",
  "0009_waiting_list.sql",
  "0010_waiting_list_completion.sql",
  "0011_appointment_waiting_link.sql",
  "0012_doctor_commission_history.sql",
  "0013_supplier_payment_settlement.sql",
  "0014_shift_close_expected_difference.sql",
  "0015_saved_reports.sql",
  "0016_finance_controls.sql",
  "0017_stock_supplier_link.sql",
  "0018_patient_demographics.sql",
  "0019_audit_source.sql",
  "0020_expense_attachments.sql",
  "0021_patient_referrals.sql",
  "0022_patient_referral_source.sql",
  "0023_opening_balance_currency.sql",
  "0024_legacy_archive.sql",
  "0025_messaging_channels.sql",
  "0026_visit_currency.sql",
  "0027_medical_history.sql",
  "0028_patient_identity.sql",
  "0029_planned_visit_interval.sql",
  "0030_party_opening_balances.sql",
  "0031_journal_line_currency.sql",
  "0032_specialty_cases.sql",
  "0033_internal_referrals.sql",
  "0034_ortho_legacy_baseline.sql",
  "0035_commission_case_overrides.sql",
  "0036_visit_clearance.sql",
  "0037_patient_families.sql",
  "0038_legacy_balance_arrangements.sql",
  "0039_ortho_adjustment_billing_decision.sql",
  "0040_endodontics.sql",
  "0041_invoice_clinical_linkage.sql",
  "0042_legacy_treatment_agreements.sql",
  "0043_legacy_treatment_coverage.sql",
  "0051_ortho_treatment_strategy.sql",
] as const;
export const LATEST_REVIEWED_MIGRATION_VERSION = REVIEWED_MIGRATION_FILENAMES.at(-1)!.slice(0, 4);
type Identity = Pick<MigrationFile, "version" | "filename">;

/** Accept only exact reviewed prefixes; unknown, missing, duplicate and reordered files fail closed. */
export function assertReviewedMigrationChain(files: readonly Identity[], requiredLastVersion?: string): void {
  if (files.length < 40 || files.length > REVIEWED_MIGRATION_FILENAMES.length) {
    throw new Error("Unreviewed shipped migration baseline for fixture.");
  }
  files.forEach((file, index) => {
    const filename = REVIEWED_MIGRATION_FILENAMES[index];
    if (file.filename !== filename || file.version !== filename.slice(0, 4)) {
      throw new Error("Shipped migration chain is missing, reordered, duplicated or unreviewed.");
    }
  });
  if (requiredLastVersion !== undefined && files.at(-1)!.version !== requiredLastVersion) {
    throw new Error("Required reviewed migration boundary is missing or exceeded.");
  }
}

/** Select a historical boundary only after validating every file in the complete input. */
export function migrationFilesThrough<T extends Identity>(files: readonly T[], version: string): T[] {
  assertReviewedMigrationChain(files);
  const boundary = files.findIndex(file => file.version === version);
  if (boundary < 0) throw new Error("Required reviewed migration boundary is missing.");
  return files.slice(0, boundary + 1);
}

/** Exact fresh-fixture registry: names and SHA-256 come from the unchanged loaded SQL. */
export function expectedMigrationRegistry(files: readonly MigrationFile[]) {
  assertReviewedMigrationChain(files);
  return files.map(file => {
    const name = file.filename.slice(5, -4);
    if (file.name !== name || file.checksum !== checksumOf(file.sql)) {
      throw new Error("Migration filename, SQL or checksum provenance changed.");
    }
    return { version: file.version, name, checksum: file.checksum, adopted: false };
  });
}

