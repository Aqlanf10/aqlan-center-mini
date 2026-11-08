import { FACIAL_HISTORY_LIMITS, verifyFacialHistoryPage, type FacialHistoryExpected } from "./ortho-facial-history";

/** One bounded read; no cache, retry, edit permission or head substitution. */
export async function fetchFacialHistoryPage(expected: FacialHistoryExpected, signal: AbortSignal, denied: () => void) {
  const query = new URLSearchParams({ patientId: String(expected.patientId), documentId: String(expected.documentId),
    beforeRevisionId: String(expected.anchor.id), beforeContentHash: expected.anchor.contentHash });
  const response = await fetch(`/api/ortho/${expected.orthoCaseId}/facial-analysis/history?${query}`, { cache: "no-store", credentials: "same-origin", redirect: "error", signal });
  const refuse = (message: string): never => { void response.body?.cancel().catch(() => {}); throw Error(message); };
  if (signal.aborted) return refuse("facial_history_cancelled");
  if ([401, 403].includes(response.status)) { denied(); return refuse("facial_history_denied"); }
  if (response.status !== 200 || response.redirected || !/\bprivate\b/i.test(response.headers.get("cache-control") ?? "")
    || !/\bno-store\b/i.test(response.headers.get("cache-control") ?? "")
    || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) return refuse("facial_history_unavailable");
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > FACIAL_HISTORY_LIMITS.pageBytes)) return refuse("facial_history_too_large");
  if (!response.body) throw Error("facial_history_body_missing");
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw Error("facial_history_cancelled");
      const next = await reader.read();
      if (signal.aborted) throw Error("facial_history_cancelled");
      if (next.done) break;
      size += next.value.byteLength;
      if (size > FACIAL_HISTORY_LIMITS.pageBytes) throw Error("facial_history_too_large");
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return await verifyFacialHistoryPage(raw, expected);
  } finally { signal.removeEventListener("abort", abort); void reader.cancel().catch(() => {}); }
}
