import { DatabaseError } from "pg";

// Never expose PostgreSQL message/detail/hint/query, filesystem errors or stack.
// A fixed phase and bounded SQLSTATE retain a useful diagnosis without source values.
const phases = new Set(["archive", "preflight", "connect", "hold", "target", "migration", "replay", "documents", "verification", "unknown"]);
export function restoreDiagnostic(phase, error) {
  const safePhase = phases.has(phase) ? phase : "unknown";
  const code = error instanceof DatabaseError && typeof error.code === "string" && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : null;
  return `RESTORE_${safePhase.toUpperCase()}_FAILED${code ? ` (SQLSTATE ${code})` : ""}`;
}

// Exact parser contract messages contain no source values. Do not expose arbitrary
// filesystem or parser exceptions merely because they reached preflight.
const preflightMessages = new Set([
  "Unsupported escape string in backup SQL.", "Unsupported dollar quote in backup SQL.",
  "Incomplete statement in backup SQL.", "ملف SQL لا يحوي إطار معاملة الاستعادة المتوقع.",
  "Unsupported historical 0079-sensitive INSERT header", "Unsupported transaction/session command in backup SQL.",
  "Unsupported lab schema capability in backup SQL.", "Unsupported backup migration registry record",
  "Invalid historical 0079 registry record", "Historical 0079 data without its exact migration registry record",
  "Historical 0079 backup requires full archive restore to preserve its registry and timestamp.",
]);
export function restorePreflightDiagnostic(error) {
  const message = error instanceof Error ? error.message : "";
  return preflightMessages.has(message) ? message : "RESTORE_PREFLIGHT_FAILED";
}
