/**
 * Minimal loadVisits query contract for isolated session-TEMP report fixtures.
 * Production owns these fields in migrations/0001_baseline_schema.sql; do not
 * initialize the application schema or fall through to public tables here.
 * Like _currency-read-temp-schema, this supplies read dependencies only.
 */
export const REPORT_VISIT_TEMP_SCHEMA = `
  ALTER TABLE pg_temp.services ADD COLUMN name text;
  CREATE TEMP TABLE visit_procedures (
    id bigint PRIMARY KEY,
    visit_id integer NOT NULL REFERENCES pg_temp.visits(id),
    service_id integer NOT NULL REFERENCES pg_temp.services(id)
  );
`;
