import type { CaseStatus } from "./ortho";

/** This slice documents existing treatment episodes only. It does not admit
 * intake/assessment lifecycle states or activate a case. */
export const permitsOrthoDocumentation = (status: unknown): status is CaseStatus =>
  typeof status === "string" && ["active", "retention", "completed", "discontinued"].includes(status);
export const orthoDocumentationContext = (status: CaseStatus): "current" | "retrospective" =>
  status === "completed" || status === "discontinued" ? "retrospective" : "current";
