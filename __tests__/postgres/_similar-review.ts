/**
 * The operator's answer to the advisory similar-receipt review, for route-level suites whose subject
 * is NOT that review (FX replay, audit atomicity…): when the payments route asks for a review, resend
 * the SAME request (same key and body) with exactly the receipt IDs it reported. The review is never
 * skipped, and every other response is returned unchanged. The review itself is covered by
 * similar-collection-advisory.test.ts.
 */
export async function answeringSimilarReview(handler: (request: Request) => Promise<Response>, request: Request): Promise<Response> {
  const retry = request.clone();
  const first = await handler(request);
  if (first.status !== 409) return first;
  const body = await first.clone().json().catch(() => null) as { reason?: string; receipts?: { id: number }[] } | null;
  if (body?.reason !== "similar_collection_review_required" || !Array.isArray(body.receipts)) return first;
  const headers = new Headers(retry.headers);
  headers.set("x-collection-similarity-review", body.receipts.length ? `ids:${body.receipts.map((receipt) => receipt.id).join(",")}` : "none");
  return handler(new Request(retry, { headers }));
}
