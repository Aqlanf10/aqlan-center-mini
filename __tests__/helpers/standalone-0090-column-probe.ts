/** Synthetic test target only. Return a bounded code, never the database error. */
export async function read0090ColumnErrorCode(query: (sql: string) => Promise<unknown>): Promise<string | null> {
  try {
    await query("SELECT request_key FROM public.booking_requests LIMIT 0");
    return null;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
    return typeof code === "string" && /^[A-Z0-9]{5}$/.test(code) ? code : "OTHER";
  }
}
