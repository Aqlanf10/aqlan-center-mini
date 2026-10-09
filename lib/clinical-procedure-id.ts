/** PostgreSQL int8 identities arrive as text; never round or truncate an identifier. */
export function normalizeClinicalProcedureId(value: unknown): number {
  const id = typeof value === "number" ? value
    : typeof value === "string" && /^[1-9][0-9]*$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0
    || (typeof value === "string" && String(id) !== value)) {
    throw new RangeError("Invalid clinical procedure identifier");
  }
  return id;
}
