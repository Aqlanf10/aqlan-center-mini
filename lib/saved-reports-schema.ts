/**
 * Power Reporting — Saved Reports schema.
 *
 * This string is also the exact body of migration 0015. Keeping one SQL source
 * for ensureSchema and the numbered migration prevents local/test schema from
 * drifting away from production migrations.
 */
export const SAVED_REPORTS_SQL = `CREATE TABLE IF NOT EXISTS saved_reports (
  id             SERIAL PRIMARY KEY,
  owner_username TEXT        NOT NULL REFERENCES users(username) ON UPDATE CASCADE ON DELETE CASCADE,
  name           TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  report_id      TEXT        NOT NULL CHECK (char_length(report_id) BETWEEN 1 AND 64),
  section_id     TEXT        NOT NULL CHECK (char_length(section_id) BETWEEN 1 AND 32),
  query_string   TEXT        NOT NULL CHECK (char_length(query_string) BETWEEN 1 AND 4096),
  is_favorite    BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS saved_reports_owner_name_uniq
  ON saved_reports (owner_username, lower(name));
CREATE INDEX IF NOT EXISTS saved_reports_owner_favorite_idx
  ON saved_reports (owner_username, is_favorite DESC, updated_at DESC, id DESC);
`;
