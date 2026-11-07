import { CASE_TEMPLATE_IDENTITY } from "./ortho-case-template";
import { journeyContentHash } from "./ortho-case-journey-hash";
/** New recovery template contract: sorted object keys, ordered arrays, UTF-8 SHA256.
 * This is a source registry dependency, never a renderer execution dependency. */
export const STUDY_TEMPLATE_HASH = journeyContentHash(CASE_TEMPLATE_IDENTITY);
