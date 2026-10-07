/** Synthetic-only seed shared by real PostgreSQL and built-HTTP regressions. */
type Query = (sql: string, values?: unknown[]) => Promise<{ rows: { id: number }[] }>;

export const PATIENT_LAB_QUERY_MONEY = [
  { costMinor: 1200, costCurrency: "YER", baseAmountMinor: 1200, exchangeRate: 1 },
  { costMinor: 4500, costCurrency: "SAR", baseAmountMinor: 6356, exchangeRate: 141.25 },
  { costMinor: 6789, costCurrency: "USD", baseAmountMinor: 36058, exchangeRate: 531.125 },
] as const;

export async function seedPatientLabQuery(query: Query, prefix: string) {
  const patient = async (label: string) => (await query(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, $2) RETURNING id`,
    [`${prefix}-${label}`, `Synthetic patient lab query ${label}`],
  )).rows[0].id;
  const targetPatientId = await patient("target");
  const otherPatientId = await patient("other");
  const emptyPatientId = await patient("empty");
  const targetOrderIds: number[] = [];
  const statuses = ["sent", "cancelled", "delivered"];
  for (const [index, money] of PATIENT_LAB_QUERY_MONEY.entries()) {
    const { rows: [row] } = await query(
      `INSERT INTO lab_orders
        (patient_id, lab_name, work_type, status, sent_date, due_date, created_at, delivered_at,
         cost_minor, cost_currency, base_amount_minor, exchange_rate)
       VALUES ($1, $2, $3, $4, '2000-01-01', '2091-01-01', '2000-01-01T00:00:00Z',
         CASE WHEN $4 = 'delivered' THEN '2000-01-15T00:00:00Z'::timestamptz ELSE NULL END,
         $5, $6, $7, $8) RETURNING id`,
      [targetPatientId, `${prefix} target lab`, `Synthetic ${money.costCurrency} work`, statuses[index],
        money.costMinor, money.costCurrency, money.baseAmountMinor, money.exchangeRate],
    );
    targetOrderIds.push(row.id);
  }
  // Same due date plus newer IDs place every target row beyond the global 300-row cap.
  // These newer unrelated orders must not consume a patient-scoped query's limit.
  const unrelated = await query(
    `INSERT INTO lab_orders (patient_id, lab_name, work_type, status, due_date, created_at)
     SELECT $1, $2, 'Synthetic unrelated work ' || n, 'sent', '2091-01-01', '2020-01-01T00:00:00Z'
       FROM generate_series(1, 301) AS n RETURNING id`,
    [otherPatientId, `${prefix} other lab`],
  );
  return {
    targetPatientId, otherPatientId, emptyPatientId,
    targetOrderIds: targetOrderIds.reverse(),
    unrelatedOrderIds: unrelated.rows.map((row) => row.id).sort((a, b) => b - a),
    patientIds: [targetPatientId, otherPatientId, emptyPatientId],
  };
}
