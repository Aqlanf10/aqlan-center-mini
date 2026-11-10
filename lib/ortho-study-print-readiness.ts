/** Browser-only physical-fit check. It authorizes no data; current source/export
 * permission has already been checked by the server before this DOM is released. */
export function fullStudyPrintFits(root: HTMLElement): boolean {
  const sheets = [...root.querySelectorAll<HTMLElement>('[data-print-sheet]')];
  if (!sheets.length || sheets.length > 300 || document.fonts.status !== 'loaded') return false;
  if ([...root.querySelectorAll<HTMLImageElement>('[data-print-sheet] img')].some(image => !image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0)) return false;
  // FontFaceSet.status returns 'loaded' even when a declared webfont failed.
  // Refuse a failed family actually used by this printout; unrelated unused
  // declarations do not make an otherwise complete document unavailable.
  const failed: string[] = [];
  document.fonts.forEach(face => { if (face.status === 'error') failed.push(face.family.replace(/["']/g, '').toLowerCase()); });
  if (failed.length) {
    const families = new Set([root, ...root.querySelectorAll<HTMLElement>('[data-print-content]')]
      .flatMap(node => getComputedStyle(node).fontFamily.split(',').map(family => family.trim().replace(/["']/g, '').toLowerCase())));
    if (failed.some(family => families.has(family))) return false;
  }
  const tolerance = 1;
  for (const sheet of sheets) {
    const frame = sheet.getBoundingClientRect();
    if (frame.width <= 0 || frame.height <= 0 || sheet.scrollWidth > sheet.clientWidth + tolerance || sheet.scrollHeight > sheet.clientHeight + tolerance) return false;
    const regions = [...sheet.querySelectorAll<HTMLElement>('[data-print-region]')];
    if (regions.length !== 4) return false;
    for (const region of regions) {
      const box = region.getBoundingClientRect();
      if (box.left < frame.left - tolerance || box.right > frame.right + tolerance || box.top < frame.top - tolerance || box.bottom > frame.bottom + tolerance
        || region.scrollHeight > region.clientHeight + tolerance || region.scrollWidth > region.clientWidth + tolerance) return false;
      for (const child of region.querySelectorAll<HTMLElement>('[data-print-content]')) {
        const bounds = child.getBoundingClientRect();
        if (bounds.left < box.left - tolerance || bounds.right > box.right + tolerance || bounds.top < box.top - tolerance || bounds.bottom > box.bottom + tolerance
          || child.scrollHeight > child.clientHeight + tolerance || child.scrollWidth > child.clientWidth + tolerance) return false;
      }
    }
  }
  return true;
}
