import { ORTHO_CASE_JOURNEY_RECORD_SQL } from "./ortho-case-journey-record-schema";
import { ORTHO_CASE_STUDY_SQL } from "./ortho-case-study-schema";
import { ORTHO_CASE_STUDY_EXPORT_SQL } from "./ortho-case-study-export-schema";
/** Additive 0100; the CLI and runtime use the exact same bytes. Existing
 * unregistered relations/functions refuse adoption; no clinical/financial backfill. */
export const ORTHO_CASE_JOURNEY_SQL = `-- 0100: documentary decisions, physical retention events, saved studies and export evidence.
-- No backfilled clinical facts, automatic consent, treatment, appointments or financial writes.
${ORTHO_CASE_JOURNEY_RECORD_SQL}\n${ORTHO_CASE_STUDY_SQL}\n${ORTHO_CASE_STUDY_EXPORT_SQL}\n`
  .replaceAll("CREATE TABLE IF NOT EXISTS", "CREATE TABLE")
  .replaceAll("CREATE UNIQUE INDEX IF NOT EXISTS", "CREATE UNIQUE INDEX")
  .replaceAll("CREATE INDEX IF NOT EXISTS", "CREATE INDEX")
  .replaceAll("CREATE OR REPLACE FUNCTION", "CREATE FUNCTION").trimEnd() + "\n";
