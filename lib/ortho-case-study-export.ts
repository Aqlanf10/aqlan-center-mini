/** Public export intent only. No client actor, source projection, rendition,
 * storage key, lease, worker version or readiness claim is accepted here. */
import { journeyHash, journeyId, type Checked } from "./ortho-case-journey-records";
import type { ArtifactFormat } from "./ortho-case-study-artifact-chain";
export interface StudyExportCommand {
  schemaVersion: 1; clientRequestId: string;
  study: { id: number; contentHash: string; kind: "draft" | "documented" };
  formats: ArtifactFormat[]; expectedRenderingContractHash: string;
}
export function checkStudyExportCommand(raw: unknown): Checked<StudyExportCommand> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, code: "invalid_export_command" };
  const c = raw as Record<string, unknown>, keys = ["schemaVersion", "clientRequestId", "study", "formats", "expectedRenderingContractHash"];
  if (Object.keys(c).length !== keys.length || keys.some(key => !Object.hasOwn(c, key)) || c.schemaVersion !== 1
    || typeof c.clientRequestId !== "string" || !/^[A-Za-z0-9_-]{16,80}$/.test(c.clientRequestId)
    || !journeyHash(c.expectedRenderingContractHash) || !c.study || typeof c.study !== "object" || Array.isArray(c.study)) return { ok: false, code: "invalid_export_command" };
  const study = c.study as Record<string, unknown>;
  if (Object.keys(study).length !== 3 || !Object.hasOwn(study, "id") || !Object.hasOwn(study, "contentHash") || !Object.hasOwn(study, "kind")
    || !journeyId(study.id) || !journeyHash(study.contentHash) || study.kind !== "draft" && study.kind !== "documented") return { ok: false, code: "invalid_export_study" };
  if (!Array.isArray(c.formats) || c.formats.length < 1 || c.formats.length > 2
    || c.formats.some(format => format !== "pptx" && format !== "pdf") || new Set(c.formats).size !== c.formats.length
    || c.formats.length === 2 && (c.formats[0] !== "pptx" || c.formats[1] !== "pdf")) return { ok: false, code: "invalid_export_formats" };
  return { ok: true, value: { schemaVersion: 1, clientRequestId: c.clientRequestId,
    study: { id: study.id, contentHash: study.contentHash, kind: study.kind }, formats: [...c.formats] as ArtifactFormat[],
    expectedRenderingContractHash: c.expectedRenderingContractHash } };
}
