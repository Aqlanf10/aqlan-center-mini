/** Browser-safe archive transport. Storage paths and render manifests are server-only. */
export const STUDY_EXPORT_ARCHIVE_LIMITS = Object.freeze({ bytes: 24 * 1024 * 1024, pages: 300, images: 40, list: 25, leaseSeconds: 60 });
export const STUDY_EXPORT_FORMATS = ["text-pptx", "illustrated-pptx"] as const;
export type StudyExportFormat = typeof STUDY_EXPORT_FORMATS[number];
export const STUDY_EXPORT_FAILURES = ["render_failed", "render_limit", "storage_unavailable", "storage_failed", "authority_changed", "lease_expired", "renderer_unavailable"] as const;
export type StudyExportFailure = typeof STUDY_EXPORT_FAILURES[number];
export interface StudyExportCommand { schemaVersion: 1; clientRequestId: string; revisionId: number; revisionHash: string; format: StudyExportFormat }
export interface StudyExportJob {
  id: number; revisionId: number; revisionHash: string; format: StudyExportFormat;
  state: "queued" | "running" | "ready" | "failed" | "cancelled";
  generation: number; creatorId: number; createdAt: string; updatedAt: string; failureCode: StudyExportFailure | null;
  artifact: { sha256: string; sizeBytes: number; pageCount: number; createdAt: string } | null;
}
export function readStudyExportCommand(raw: unknown): StudyExportCommand {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("invalid_study_export_command");
  const value = raw as Record<string, unknown>;
  const keys = ["schemaVersion", "clientRequestId", "revisionId", "revisionHash", "format"];
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))
    || value.schemaVersion !== 1 || typeof value.clientRequestId !== "string" || !/^[a-zA-Z0-9_-]{16,80}$/.test(value.clientRequestId)
    || !Number.isSafeInteger(value.revisionId) || (value.revisionId as number) < 1
    || typeof value.revisionHash !== "string" || !/^[a-f0-9]{64}$/.test(value.revisionHash)
    || !STUDY_EXPORT_FORMATS.includes(value.format as StudyExportFormat)) throw Error("invalid_study_export_command");
  return { schemaVersion: 1, clientRequestId: value.clientRequestId, revisionId: value.revisionId as number, revisionHash: value.revisionHash, format: value.format as StudyExportFormat };
}
