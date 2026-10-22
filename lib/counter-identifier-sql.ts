type CounterIdentifierColumn = "patient_number" | "invoice_number" | "receipt_number" | "voucher_number";

/** Bootstrap-only identifier projection. Keep historical digit extraction, but
 * never cast an unrepresentable TEXT identifier or round/truncate its digits.
 * The CASE guards the cast itself, regardless of planner predicate ordering.
 * Callers pass only these static column names, never request input. */
export function counterIdentifierBigintSql(column: CounterIdentifierColumn): string {
  return `(SELECT CASE
    WHEN length(digits) < 19
      OR (length(digits) = 19 AND digits COLLATE "C" <= '9223372036854775807' COLLATE "C")
    THEN COALESCE(NULLIF(digits, ''), '0')::bigint
    ELSE NULL
    END
    FROM (SELECT ltrim(regexp_replace(${column}, '\\D', '', 'g'), '0') AS digits) normalized_counter_identifier)`;
}
