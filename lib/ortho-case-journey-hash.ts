import { createHash } from "node:crypto";
import { canonicalJourneyJSON } from "./ortho-case-journey-json";
export { canonicalJourneyJSON } from "./ortho-case-journey-json";
export function journeyContentHash(value: unknown): string { return createHash("sha256").update(canonicalJourneyJSON(value)).digest("hex"); }
