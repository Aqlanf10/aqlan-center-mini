/** Browser-only boundaries for selecting existing documentary references.
 * The inventory's hash/version validate its exact selection envelope; retention
 * stores only document IDs. No document metadata or case membership is inferred. */
import { journeyId, type JourneyScope } from "./ortho-case-journey-records";
import { readStudyInventoryResponse, type StudyInventoryRead } from "./ortho-case-study-inventory-client";

export const RETENTION_DOCUMENT_LIMIT = 30;
export const RETENTION_DOCUMENT_PAGE_BYTE_LIMIT = 64 * 1024;
const fail = (code: string): never => { throw new Error(code); };

export function retentionDocumentIds(raw: unknown): number[] {
  if (!Array.isArray(raw) || raw.length > RETENTION_DOCUMENT_LIMIT || Array.from(raw).some(id => !journeyId(id))
    || new Set(raw).size !== raw.length) return fail("invalid_retention_document_ids");
  return [...raw];
}

export function retentionDocumentInventoryURL(scope: JourneyScope, afterId: number | null): string {
  if (![scope.patientId, scope.orthoCaseId, scope.clinicalCaseId].every(journeyId)
    || afterId !== null && !journeyId(afterId)) return fail("invalid_retention_document_scope");
  const query = new URLSearchParams({ patientId: String(scope.patientId), kind: "document" });
  if (afterId !== null) query.set("afterId", String(afterId));
  return `/api/ortho/${scope.orthoCaseId}/case-study/sources?${query}`;
}

export function readRetentionDocumentPage(raw: unknown, scope: JourneyScope, afterId: number | null): StudyInventoryRead {
  retentionDocumentInventoryURL(scope, afterId);
  const page = readStudyInventoryResponse(raw, scope, "document");
  // The shared parser checks ordering within a page. Also bind this page to the
  // requested cursor, so an older/overlapping page cannot become a next page.
  if (afterId !== null && (page.choices.some(choice => choice.id <= afterId)
    || page.nextAfterId !== null && page.nextAfterId <= afterId)) return fail("invalid_retention_document_cursor");
  return page;
}

/** Explicit removal is allowed for a retained historical ID even when that ID
 * is not available on the current page. Reads never filter a correction draft. */
export function editRetentionDocumentIds(current: readonly number[], page: StudyInventoryRead | null,
  action: { type: "add" | "remove"; id: number }): number[] | null {
  const ids = retentionDocumentIds(current);
  if (!journeyId(action.id)) return null;
  if (action.type === "remove") return ids.includes(action.id) ? ids.filter(id => id !== action.id) : null;
  if (action.type !== "add" || ids.includes(action.id) || ids.length >= RETENTION_DOCUMENT_LIMIT
    || page?.kind !== "document" || page.state !== "available") return null;
  const choice = page.choices.find(row => row.id === action.id);
  if (!choice || choice.kind !== "document" || choice.state !== "available" || !choice.selection
    || choice.selection.kind !== "document" || choice.selection.id !== choice.id) return null;
  return [...ids, choice.id];
}

/** Much smaller than a retention-history response: this endpoint contains at
 * most 25 ID-only envelopes. Abort cancels a held stream as well as fetch. */
export async function readRetentionDocumentResponseJSON(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d{1,10}$/.test(length) || Number(length) > RETENTION_DOCUMENT_PAGE_BYTE_LIMIT))
    return fail("retention_document_response_limit");
  if (signal.aborted) return fail("retention_document_read_retired");
  if (!response.body) return fail("retention_document_missing_body");
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  const cancel = () => { void reader.cancel().catch(() => {}); };
  let bytes = 0, text = "";
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) return fail("retention_document_read_retired");
    for (;;) {
      const chunk = await reader.read();
      if (signal.aborted) return fail("retention_document_read_retired");
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > RETENTION_DOCUMENT_PAGE_BYTE_LIMIT) return fail("retention_document_response_limit");
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    const value: unknown = JSON.parse(text);
    if (signal.aborted) return fail("retention_document_read_retired");
    return value;
  } catch (error) { cancel(); throw error; }
  finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
}
