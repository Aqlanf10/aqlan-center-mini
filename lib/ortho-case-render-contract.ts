/** Pure server contract: no presentation generator, converter, filesystem or network.
 * Retained study/export readers use this single validator without render capability.
 * Node crypto/zlib definitions come from the shared security module; no pixel/ZIP
 * parser is invoked by these structural/hash validators. This is not an authority check.
 */
import { CASE_TEMPLATE_IDENTITY, CASE_PAGE, CASE_TEMPLATE_KEY, CASE_TEMPLATE_VERSION, caseLayout, type CaseRect } from "./ortho-case-template";
import { canonicalOrthoMediaRecipe, canonicalOrthoMediaGeometryWitness, parseOrthoMediaRecipe, verifyOrthoMediaBasis, ORTHO_MEDIA_GEOMETRY_VERSION, type OrthoMediaRecipe } from "./ortho-study-media";
import { CASE_RENDER_LIMITS as LIMITS, assertHash, canonicalJson, exactKeys, hashBytes, hashJson, idValue, refuse, textValue } from "./ortho-case-render-security";

export const CASE_PPTX_RENDERER_VERSION = "ortho-full-case-pptx-v5-pptxgenjs-4.0.1";
export const CASE_TEMPLATE_HASH = hashJson(CASE_TEMPLATE_IDENTITY);
export type CaseSourceKind = "assessment" | "diagnosis" | "strategy" | "decision" | "retention_event" | "document" | "clinic-logo" | "ceph_study" | "adjustment" | "plan_consent";
export type CaseSource = { key: string; kind: CaseSourceKind; id: number; version: number | null; contentHash: string };
export type CaseParagraph = { kind: "paragraph"; text: string; sourceKeys: string[]; review: "draft" | "documented" };
export type CaseTable = { kind: "table"; headers: string[]; rows: Array<{ cells: string[]; sourceKeys: string[]; review: "draft" | "documented" }> };
export type CasePanel = {
  instanceId: string; layoutKey: string; state: "available" | "restricted" | "unavailable" | "not-recorded";
  title: string; occurrenceLabel: string; sourceKeys: string[]; blocks: Array<CaseParagraph | CaseTable>;
  comments: string[]; media: Array<{ slotId: string; useId: string }>;
};
export type CaseRendition = {
  useId: string; panelInstanceId: string; slotId: string; sourceKey: string; originalSourceHash: string;
  recipe: OrthoMediaRecipe; recipeHash: string; geometryVersion: string; geometryHash: string;
  frame: { width: number; height: number }; verifiedBasis: { encodedWidth: number; encodedHeight: number; exifOrientation: number };
  processorVersion: string; processorHash: string; renditionHash: string; disclosure: "clinical" | "share-reviewed";
};
export type CaseProjection = {
  schema: 1; caseId: number; studyRevisionId: number; studyRevisionHash: string; capturedAt: string;
  language: "ar" | "en"; state: "draft" | "documented"; privacy: "clinical" | "share";
  identity: { patientLabel: string; clinicLabel: string; doctorLabel: string; disclosureId: string; authorityCaptureHash: string };
  sources: CaseSource[]; panels: CasePanel[]; renditions: CaseRendition[];
};
export type CaseRenderManifest = {
  id: string; caseId: number; studyRevisionId: number; studyRevisionHash: string; capturedAt: string;
  projectionHash: string; sourceSetHash: string; renditionSetHash: string; templateKey: string; templateVersion: string; templateHash: string;
};
export type CaseImageBytes = { useId: string; bytes: Uint8Array };
export type CaseGeneratedPptx = {
  bytes: Buffer; mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  sha256: string; slideCount: number; rendererVersion: string; capturedAt: string; manifest: CaseRenderManifest;
};
export function casePixelFrame(frame: CaseRect): { width: number; height: number } {
  return { width: Math.ceil(frame.w * CASE_PAGE.imageDpi), height: Math.ceil(frame.h * CASE_PAGE.imageDpi) };
}
export function caseGeometryHash(recipe: OrthoMediaRecipe, frame: { width: number; height: number }): string {
  return hashBytes(canonicalOrthoMediaGeometryWitness(recipe, frame));
}
const positiveId = (v: unknown): void => { if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) refuse("invalid_id"); };
const sourceKinds: CaseSourceKind[] = ["assessment", "diagnosis", "strategy", "decision", "retention_event", "document", "clinic-logo", "ceph_study", "adjustment", "plan_consent"];
const stamp = (v: string): void => {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) || new Date(v).toISOString() !== v) refuse("invalid_capture_time");
};
export function caseProjectionHash(projection: CaseProjection): string { return hashJson(projection); }
export function caseRenditionSetHash(projection: CaseProjection): string {
  return hashJson([...projection.renditions].sort((a, b) => a.useId.localeCompare(b.useId, "en")));
}
export function validateCaseProjection(value: CaseProjection): void {
  exactKeys(value, ["schema", "caseId", "studyRevisionId", "studyRevisionHash", "capturedAt", "language", "state", "privacy", "identity", "sources", "panels", "renditions"]);
  if (value.schema !== 1 || !["ar", "en"].includes(value.language) || !["draft", "documented"].includes(value.state) || !["clinical", "share"].includes(value.privacy)) refuse("invalid_projection");
  positiveId(value.caseId); positiveId(value.studyRevisionId); assertHash(value.studyRevisionHash); stamp(value.capturedAt);
  exactKeys(value.identity, ["patientLabel", "clinicLabel", "doctorLabel", "disclosureId", "authorityCaptureHash"]);
  for (const field of [value.identity.patientLabel, value.identity.clinicLabel, value.identity.doctorLabel]) textValue(field, 300);
  idValue(value.identity.disclosureId); assertHash(value.identity.authorityCaptureHash);
  if (!Array.isArray(value.sources) || value.sources.length > LIMITS.sources || !Array.isArray(value.panels) || value.panels.length < 1 ||
      value.panels.length > LIMITS.panels || !Array.isArray(value.renditions) || value.renditions.length > LIMITS.media) refuse("projection_limit_exceeded");
  const sources = new Map<string, CaseSource>(), instances = new Set<string>(), singular = new Set<string>(), bindings = new Map<string, { panel: CasePanel; slot: string }>();
  let textSize = value.identity.patientLabel.length + value.identity.clinicLabel.length + value.identity.doctorLabel.length;
  for (const source of value.sources) {
    exactKeys(source, ["key", "kind", "id", "version", "contentHash"]); idValue(source.key); positiveId(source.id); assertHash(source.contentHash);
    if (!sourceKinds.includes(source.kind) || sources.has(source.key)) refuse("invalid_source");
    if (["document", "clinic-logo"].includes(source.kind)) { if (source.version !== null) refuse("invented_document_revision"); }
    else if (source.version !== null) positiveId(source.version);
    sources.set(source.key, source);
  }
  const checkSourceKeys = (keys: string[]): void => {
    if (!Array.isArray(keys) || keys.length > LIMITS.sources || new Set(keys).size !== keys.length || keys.some(key => !sources.has(key))) refuse("source_binding_mismatch");
  };
  for (const panel of value.panels) {
    exactKeys(panel, ["instanceId", "layoutKey", "state", "title", "occurrenceLabel", "sourceKeys", "blocks", "comments", "media"]);
    idValue(panel.instanceId); const registered = caseLayout(panel.layoutKey);
    if (!registered || instances.has(panel.instanceId) || registered.singular && singular.has(panel.layoutKey)) refuse("invalid_panel");
    instances.add(panel.instanceId); if (registered.singular) singular.add(panel.layoutKey);
    if (!["available", "restricted", "unavailable", "not-recorded"].includes(panel.state)) refuse("invalid_panel_state");
    textValue(panel.title, 300); textValue(panel.occurrenceLabel, 1000); textSize += panel.title.length + panel.occurrenceLabel.length; checkSourceKeys(panel.sourceKeys);
    if (!Array.isArray(panel.blocks) || panel.blocks.length > 200 || !Array.isArray(panel.comments) || panel.comments.length > 100 ||
        !Array.isArray(panel.media) || panel.media.length > registered.images.length) refuse("projection_limit_exceeded");
    if (panel.state !== "available" && (panel.blocks.length || panel.media.length)) refuse("unavailable_content_refused");
    for (const block of panel.blocks) {
      if (block.kind === "paragraph") {
        exactKeys(block, ["kind", "text", "sourceKeys", "review"]); textValue(block.text); checkSourceKeys(block.sourceKeys); textSize += block.text.length;
        if (!["draft", "documented"].includes(block.review) || (!block.sourceKeys.length || block.sourceKeys.some(k => !panel.sourceKeys.includes(k)))) refuse("unbound_clinical_fact");
      } else if (block.kind === "table") {
        exactKeys(block, ["kind", "headers", "rows"]);
        if (!Array.isArray(block.headers) || block.headers.length < 1 || block.headers.length > 12 || !Array.isArray(block.rows) || block.rows.length > 4000) refuse("projection_limit_exceeded");
        for (const header of block.headers) { textValue(header, 1000); textSize += header.length; }
        for (const row of block.rows) {
          exactKeys(row, ["cells", "sourceKeys", "review"]); checkSourceKeys(row.sourceKeys);
          if (!Array.isArray(row.cells) || row.cells.length !== block.headers.length || (!row.sourceKeys.length || row.sourceKeys.some(k => !panel.sourceKeys.includes(k))) || !["draft", "documented"].includes(row.review)) refuse("unbound_clinical_fact");
          for (const cell of row.cells) { textValue(cell); textSize += cell.length; }
        }
      } else refuse("invalid_block");
    }
    const slots = new Set<string>();
    for (const binding of panel.media) {
      exactKeys(binding, ["slotId", "useId"]); idValue(binding.useId);
      if (!registered.images.some(slot => slot.slotId === binding.slotId) || slots.has(binding.slotId) || bindings.has(binding.useId)) refuse("media_slot_mismatch");
      slots.add(binding.slotId); bindings.set(binding.useId, { panel, slot: binding.slotId });
    }
    for (const comment of panel.comments) { textValue(comment, 4000); textSize += comment.length; }
  }
  const renditions = new Set<string>();
  for (const rendition of value.renditions) {
    exactKeys(rendition, ["useId", "panelInstanceId", "slotId", "sourceKey", "originalSourceHash", "recipe", "recipeHash", "geometryVersion", "geometryHash", "frame", "verifiedBasis", "processorVersion", "processorHash", "renditionHash", "disclosure"]);
    const binding = bindings.get(rendition.useId), source = sources.get(rendition.sourceKey);
    if (!binding || renditions.has(rendition.useId) || binding.panel.instanceId !== rendition.panelInstanceId || binding.slot !== rendition.slotId ||
        !source || !binding.panel.sourceKeys.includes(source.key) || !["document", "clinic-logo"].includes(source.kind) ||
        rendition.originalSourceHash !== source.contentHash) refuse("media_source_mismatch");
    const slot = caseLayout(binding.panel.layoutKey)!.images.find(s => s.slotId === rendition.slotId)!;
    if (slot.sourceKind === "clinic-logo" ? source.kind !== "clinic-logo" : source.kind !== "document") refuse("media_source_kind_mismatch");
    exactKeys(rendition.frame, ["width", "height"]); exactKeys(rendition.verifiedBasis, ["encodedWidth", "encodedHeight", "exifOrientation"]);
    const expected = casePixelFrame(slot), recipe = parseOrthoMediaRecipe(rendition.recipe);
    verifyOrthoMediaBasis(recipe, rendition.verifiedBasis);
    if (canonicalJson(recipe) !== canonicalJson(rendition.recipe) || rendition.frame.width !== expected.width || rendition.frame.height !== expected.height ||
        rendition.recipeHash !== hashBytes(canonicalOrthoMediaRecipe(recipe)) || rendition.geometryVersion !== ORTHO_MEDIA_GEOMETRY_VERSION ||
        rendition.geometryHash !== caseGeometryHash(recipe, expected)) refuse("media_recipe_binding_mismatch");
    assertHash(rendition.processorHash); assertHash(rendition.renditionHash); idValue(rendition.processorVersion);
    if (!["clinical", "share-reviewed"].includes(rendition.disclosure) || value.privacy === "share" && rendition.disclosure !== "share-reviewed") refuse("image_disclosure_required");
    renditions.add(rendition.useId);
  }
  if (!singular.has("cover")) refuse("cover_required");
  if (renditions.size !== bindings.size || textSize > LIMITS.text) refuse("projection_limit_exceeded");
  // Order is intentionally unconstrained: this exact array is persisted and hashed.
  canonicalJson(value);
}
export function validateCaseManifest(projection: CaseProjection, manifest: CaseRenderManifest): void {
  exactKeys(manifest, ["id", "caseId", "studyRevisionId", "studyRevisionHash", "capturedAt", "projectionHash", "sourceSetHash", "renditionSetHash", "templateKey", "templateVersion", "templateHash"]);
  idValue(manifest.id);
  if (manifest.caseId !== projection.caseId || manifest.studyRevisionId !== projection.studyRevisionId || manifest.studyRevisionHash !== projection.studyRevisionHash ||
      manifest.capturedAt !== projection.capturedAt || manifest.templateKey !== CASE_TEMPLATE_KEY || manifest.templateVersion !== CASE_TEMPLATE_VERSION || manifest.templateHash !== CASE_TEMPLATE_HASH ||
      manifest.projectionHash !== caseProjectionHash(projection) || manifest.sourceSetHash !== hashJson(projection.sources) ||
      manifest.renditionSetHash !== caseRenditionSetHash(projection)) refuse("manifest_binding_mismatch");
}
