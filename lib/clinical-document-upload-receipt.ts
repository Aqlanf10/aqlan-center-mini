/** The front desk may upload outside records without ever reading stored clinical metadata. */
export function projectUploadedClinicalDocument<T extends object>(
  role: string,
  saved: T,
): T | { readonly uploaded: true } {
  // This projection is defense in depth: GET/bytes/print authorization is separate.
  // Never return IDs, titles, links, notes, storage keys or clinical dimensions to reception.
  if (role === "reception") return { uploaded: true };
  return saved;
}
