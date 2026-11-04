import { caseLayout } from "./ortho-case-template";
import { readStudyDraftContent, type StudyDraftContent, type StudySourceSelection } from "./ortho-case-study";
import { canonicalOrthoMediaRecipe, defaultOrthoMediaRecipe, type OrthoMediaRecipe } from "./ortho-study-media";

/** Assign only a verified, unchanged selected source into an empty slot.
 * Replacement is explicit removal followed by a fresh use/basis/recipe. */
export function attachStudyImage(content: StudyDraftContent, source: StudySourceSelection, panelId: string, slotId: string, recipe: OrthoMediaRecipe, useId: string): StudyDraftContent {
  const panel = content.panels.find(p => p.instanceId === panelId);
  if (source.kind !== "document" || !content.sources.some(s => s.key === source.key && s.kind === source.kind && s.id === source.id && s.contentHash === source.contentHash)
    || !panel?.sourceKeys.includes(source.key) || panel.images.some(i => i.slot === slotId)
    || !caseLayout(panel.layoutKey)?.images.some(i => i.slotId === slotId && i.sourceKind === "patient-document")) throw Error("study_image_selection_changed");
  if (recipe.basis.exifOrientation === null || canonicalOrthoMediaRecipe(recipe) !== canonicalOrthoMediaRecipe(defaultOrthoMediaRecipe(recipe.basis.orientedWidth,recipe.basis.orientedHeight,recipe.basis.exifOrientation))) throw Error("study_image_basis_required");
  const usedOrders = new Set(content.mediaUses.filter(u => u.groupId === null).map(u => u.order));
  let order = 0; while (usedOrders.has(order)) order++;
  return readStudyDraftContent({...content,mediaUses:[...content.mediaUses,{useId,documentId:source.id,sourceSha256:source.contentHash,groupId:null,slotId,order,view:"unassigned",caption:"",recipe}],
    panels:content.panels.map(p => p === panel ? {...p,state:"available",images:[...p.images,{slot:slotId,useId}]} : p)});
}
export function detachStudyImage(content: StudyDraftContent, useId: string): StudyDraftContent {
  return readStudyDraftContent({...content,mediaUses:content.mediaUses.filter(u => u.useId !== useId),panels:content.panels.map(p => ({...p,images:p.images.filter(i => i.useId !== useId)}))});
}
