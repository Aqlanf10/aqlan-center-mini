/**
 * Reception can upload external clinical documents for record keeping, but
 * must not receive saved metadata after the write.
 *
 * This is only the POST-response boundary. GET, binary, preview and print
 * routes still require independent read permission checks.
 */
export function projectUploadedClinicalDocument<T extends object>(
  role: string,
  saved: T,
): T | { readonly uploaded: true } {
  if (role === "reception") return { uploaded: true };
  return saved;
}
