/** Test-only interpretation of raw painted samples; no DOM, renderer or application dependency. */
export interface PreviewTextRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
export interface PreviewTextHit {
  point: string;
  x: number;
  y: number;
  owned: boolean;
  hitTag: string | null;
  hitsNativeLabelControl: boolean;
}
export interface PreviewNativeLabelControl {
  nativeLabel: boolean;
  nativeControl: boolean;
  tag: string;
  bounds: PreviewTextRect;
}
export interface PreviewTextLineEvidence {
  kind: string;
  bounds: PreviewTextRect;
  hits: readonly PreviewTextHit[];
  associatedControl: PreviewNativeLabelControl | null;
}

function finiteRect(rect: PreviewTextRect | null | undefined): rect is PreviewTextRect {
  return !!rect && [rect.left, rect.right, rect.top, rect.bottom].every(Number.isFinite)
    && rect.left < rect.right && rect.top < rect.bottom;
}

/**
 * All five raw samples remain available. Only one field-label bottom sample may
 * land on its exact native associated input/select at a <=1 CSSpx trailing Range
 * boundary. No descendant, paragraph, chrome or other point gains an exception.
 */
export function previewTextLineHasOwnedHits(evidence: PreviewTextLineEvidence): boolean {
  const { bounds, hits, associatedControl: control } = evidence;
  const names = ["centre", "top", "bottom", "left", "right"];
  if (!finiteRect(bounds) || !Array.isArray(hits) || hits.length !== names.length
    || new Set(hits.map(hit => hit?.point)).size !== names.length
    || !hits.every(hit => hit && names.includes(hit.point)
      && (hit.owned === true || hit.owned === false) && Number.isFinite(hit.x) && Number.isFinite(hit.y)
      && hit.x >= bounds.left && hit.x <= bounds.right && hit.y >= bounds.top && hit.y <= bounds.bottom)) return false;
  const unowned = hits.filter(hit => !hit.owned);
  if (unowned.length === 0) return true;
  if (!/^field-label-[0-3]$/.test(evidence.kind) || unowned.length !== 1
    || unowned[0].point !== "bottom" || !control || control.nativeLabel !== true
    || control.nativeControl !== true || !["input", "select"].includes(control.tag)
    || !finiteRect(control.bounds)) return false;
  const bottom = unowned[0];
  const overlap = bounds.bottom - control.bounds.top;
  return bottom.hitsNativeLabelControl === true && bottom.hitTag === control.tag
    && bottom.y === control.bounds.top && bottom.x > control.bounds.left && bottom.x < control.bounds.right
    && bounds.top < control.bounds.top && Number.isFinite(overlap) && overlap > 0 && overlap <= 1;
}
