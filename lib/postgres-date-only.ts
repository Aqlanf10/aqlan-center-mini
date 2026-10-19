/** PostgreSQL DATE has no time zone. node-postgres returns its calendar fields
 * as a local-midnight Date; converting that value to UTC changes the civil day.
 * Use only for DATE columns, never TIMESTAMP / TIMESTAMPTZ instants. */
export function postgresDateOnly(value: unknown): string {
  const text = value instanceof Date && Number.isFinite(value.getTime())
    ? `${String(value.getFullYear()).padStart(4, "0")}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`
    : typeof value === "string" ? value : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error("Invalid PostgreSQL calendar date");
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new Error("Invalid PostgreSQL calendar date");
  }
  return text;
}
