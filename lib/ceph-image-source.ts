/** A digest binds an authenticated image request to metadata AND response bytes.
 * Only explicit null permits an ordinary draft/legacy document preview. A missing
 * or malformed witnessed source must never silently become an ordinary URL. */
export function cephDocumentImageUrl(documentId: unknown, source: { sha256: unknown } | null | undefined): string | null {
  if (typeof documentId !== "number" || !Number.isSafeInteger(documentId) || documentId <= 0) return null;
  const url = `/api/documents/${documentId}`;
  if (source === null) return url;
  if (!source || typeof source.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(source.sha256)) return null;
  return `${url}?cephSource=${source.sha256}`;
}

export const CEPH_IMAGE_UNAVAILABLE_NOTICE = "تعذّر تحميل صورة الأشعة المطابقة لمصدر الدراسة. الصورة والتراكب غير متاحين؛ لا تُستبدل الصورة بمصدر آخر.";
