import { ORTHO_CASE_JOURNEY_RECORD_SQL } from "./ortho-case-journey-record-schema";
import { ORTHO_CASE_STUDY_SQL } from "./ortho-case-study-schema";
import { ORTHO_CASE_STUDY_EXPORT_SQL } from "./ortho-case-study-export-schema";
/** Same exact body as the reserved0053 migration. Bootstrap integration must
 * execute after0052; converters are never required to initialize these tables. */
export const ORTHO_CASE_JOURNEY_SQL = `-- Unpublished reserved0053: documentary decisions, physical retention events, saved studies and export evidence.
-- No backfilled clinical facts, automatic consent, treatment, appointments or financial writes.
${ORTHO_CASE_JOURNEY_RECORD_SQL}\n${ORTHO_CASE_STUDY_SQL}\n${ORTHO_CASE_STUDY_EXPORT_SQL}\n`;
