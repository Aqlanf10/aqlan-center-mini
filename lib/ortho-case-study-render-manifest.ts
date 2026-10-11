/** Immutable export specification. Structural verification is independent of
 * PptxGenJS/PDF/Sharp availability. It does not grant source authority or attest
 * that a worker actually produced the recorded pixels. */
import { CASE_PPTX_RENDERER_VERSION, validateCaseManifest, validateCaseProjection,
  type CaseProjection, type CaseRenderManifest } from "./ortho-case-render-contract";
import { journeyContentHash } from "./ortho-case-journey-hash";
import { journeyHash, journeyId, type Checked } from "./ortho-case-journey-records";
import type { StudyRevision } from "./ortho-case-study-history";
import type { StudySavedContent } from "./ortho-case-study-capture";
import type { ArtifactFormat } from "./ortho-case-study-artifact-chain";
export interface StudyRenderingContract {
  schemaVersion: 1; pptxRendererVersion: string; pptxImplementationHash: string;
  pdfRuntimeKey: string | null; pdfAdapterVersion: string | null; pdfImplementationHash: string | null;
  templateHash: string; authorityPolicyVersion: "ortho-study-current-source-v1";
}
export interface StudyRenderSpecification {
  schemaVersion: 1;
  study: { id: number; contentHash: string; kind: "draft" | "documented" };
  rendering: StudyRenderingContract;
  formats: ArtifactFormat[];
  projection: CaseProjection;
  renderManifest: CaseRenderManifest;
}
const object = (value: unknown, keys: string[]): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k)));
const version = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value);
const invalid = (code: string): Checked<never> => ({ ok: false, code });
export function decodeStudyRenderSpecification(raw: unknown, saved: StudyRevision<StudySavedContent>): Checked<StudyRenderSpecification> {
  try {
    if (!object(raw, ["schemaVersion", "study", "rendering", "formats", "projection", "renderManifest"]) || raw.schemaVersion !== 1
      || !object(raw.study, ["id", "contentHash", "kind"]) || !journeyId(raw.study.id) || !journeyHash(raw.study.contentHash)
      || raw.study.id !== saved.id || raw.study.contentHash !== saved.contentHash || raw.study.kind !== saved.kind) return invalid("export_study_binding_changed");
    if (!object(raw.rendering, ["schemaVersion", "pptxRendererVersion", "pptxImplementationHash", "pdfRuntimeKey", "pdfAdapterVersion", "pdfImplementationHash", "templateHash", "authorityPolicyVersion"])) return invalid("invalid_rendering_contract");
    const r = raw.rendering;
    if (r.schemaVersion !== 1 || r.pptxRendererVersion !== CASE_PPTX_RENDERER_VERSION || !journeyHash(r.pptxImplementationHash)
      || !journeyHash(r.templateHash) || r.templateHash !== saved.content.authored.template.contentHash
      || r.authorityPolicyVersion !== "ortho-study-current-source-v1") return invalid("unsupported_rendering_contract");
    const noPdf = r.pdfRuntimeKey === null && r.pdfAdapterVersion === null && r.pdfImplementationHash === null;
    if (!noPdf && (!version(r.pdfRuntimeKey) || !version(r.pdfAdapterVersion) || !journeyHash(r.pdfImplementationHash))) return invalid("invalid_pdf_contract");
    if (!Array.isArray(raw.formats) || !["pptx", "pdf", "pptx,pdf"].includes(raw.formats.join(","))
      || raw.formats.some(f => f !== "pptx" && f !== "pdf") || raw.formats.includes("pdf") && noPdf) return invalid("invalid_export_formats");
    // These validators inspect every nested key, enum, bound, source and hash.
    const projection = raw.projection as CaseProjection, renderManifest = raw.renderManifest as CaseRenderManifest;
    validateCaseProjection(projection); validateCaseManifest(projection, renderManifest);
    if (projection.caseId !== saved.orthoCaseId || projection.studyRevisionId !== saved.id || projection.studyRevisionHash !== saved.contentHash
      || projection.state !== saved.kind || projection.privacy !== "clinical") return invalid("export_projection_scope_changed");
    const authored = saved.content.authored, sourceByKey = new Map(authored.sources.map(s => [s.key, s]));
    for (const source of projection.sources) {
      const exact = sourceByKey.get(source.key);
      if (!exact || journeyContentHash(source) !== journeyContentHash(exact)) return invalid("export_source_binding_changed");
    }
    const capturedByKey = new Map(saved.content.sources.map(s => [s.selection.key, s]));
    const included = authored.panels.filter(p => p.included);
    if (included.length !== projection.panels.length) return invalid("export_panel_selection_changed");
    for (let i = 0; i < included.length; i++) {
      const chosen = included[i], panel = projection.panels[i];
      if (chosen.instanceId !== panel.instanceId || chosen.layoutKey !== panel.layoutKey
        || journeyContentHash(chosen.sourceKeys) !== journeyContentHash(panel.sourceKeys)
        || journeyContentHash(chosen.images.map(b => ({ slotId: b.slot, useId: b.useId }))) !== journeyContentHash(panel.media)) return invalid("export_panel_selection_changed");
      for (const block of panel.blocks) {
        const rows = block.kind === "paragraph" ? [block] : block.rows;
        for (const row of rows) if (row.sourceKeys.some(key => capturedByKey.get(key)?.state !== "available")) return invalid("export_unavailable_fact_refused");
      }
    }
    const uses = new Map(authored.mediaUses.map(use => [use.useId, use]));
    for (const rendition of projection.renditions) {
      const use = uses.get(rendition.useId), source = sourceByKey.get(rendition.sourceKey);
      if (!use || !source || capturedByKey.get(source.key)?.state !== "available" || source.kind !== "document" || use.documentId !== source.id || use.sourceSha256 !== source.contentHash
        || journeyContentHash(use.recipe) !== journeyContentHash(rendition.recipe)) return invalid("export_media_selection_changed");
    }
    // Detach all nested arrays/objects from caller-owned memory. This is only a
    // structural copy; the trusted capture pipeline still verifies semantic
    // facts, current authority, processor receipts and the exact rendition bytes.
    const copied = JSON.parse(JSON.stringify(raw)) as StudyRenderSpecification;
    if (Buffer.byteLength(JSON.stringify(copied), "utf8") > 8 * 1024 * 1024) return invalid("export_manifest_limit");
    return { ok: true, value: copied };
  } catch { return invalid("invalid_export_manifest"); }
}
