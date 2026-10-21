/** Unmounted HTTP adapter candidate. No app route imports this module. Activation
 * requires coherent restore/runtime/security review, not an environment switch,
 * client boolean, database-table existence, or a preview eligibility result. */
import { requireSession } from './session';
import { readJsonBody, bodyErrorResponse } from './http-body';
import { JSON_BODY_LIMIT_BYTES } from './security-limits';
import { exactOriginVerdict, trustedOriginsFromEnv } from './origin-policy';
import { debtRequestHash } from './debt-source-proof';
import { DebtRepaymentError } from './debt-installments-db';
import { readUnpaidCurrencyCorrection, correctUnpaidInvoiceCurrency } from './invoice-unpaid-currency-db';
import type { UnpaidCurrencyPreview } from './invoice-unpaid-currency-recovery';
import { parseUnpaidCurrencyRequest } from './invoice-unpaid-currency-contract';

export const UNPAID_CURRENCY_READINESS = Object.freeze({
  enabled: false as const,
  code: 'unpaid_currency_not_activated' as const,
  message: 'تصحيح عملة الفاتورة غير المسددة غير مفعّل بعد. الطلبات السابقة محفوظة؛ لا تُعد إرسالها بمفتاح جديد.',
});
const json = (body: unknown, status: number) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
/** Candidate contract accepts explicit invoice and patient path IDs; neither is
 * inferred from the body. Auth uses the current canonical session, never a role
 * asserted by the client. This adapter is test-invoked only: no application
 * route imports it, and it does not register schema or grant runtime access. */
export async function unpaidCurrencyHttp(request: Request, path: { invoiceId: string; patientId: string }): Promise<Response> {
  // Failure describes this attempt only, never proof that an earlier delivery
  // did not commit. Recovery retains the exact command for every non-2xx reply.
  const failure = (code: string, status: number) => json({ code, ...(request.method === 'POST'
    ? { outcome: 'unconfirmed', recovery: 'retain_exact_command' } : {}) }, status);
  try {
    const session = await requireSession();
    if (!session) return failure('unauthenticated', 401);
    if (session.role !== 'admin') return failure('unauthorized', 403);
    if (!/^[1-9]\d*$/.test(path.invoiceId) || !/^[1-9]\d*$/.test(path.patientId)
      || !Number.isSafeInteger(Number(path.invoiceId)) || !Number.isSafeInteger(Number(path.patientId))) return failure('invalid_identity', 400);
    if (request.method !== 'GET' && request.method !== 'POST') return failure('method_not_allowed', 405);
    if (request.method === 'POST') {
      // Cookie-safe strict policy also for this currently browser-only candidate.
      // No forwarded host is trusted unless the canonical policy enables it.
      const verdict = exactOriginVerdict({ origin: request.headers.get('origin'), cookieAuthenticated: true,
        ownOrigin: new URL(request.url).origin, trustProxy: process.env.TRUST_PROXY === 'true',
        forwardedProto: request.headers.get('x-forwarded-proto'), forwardedHost: request.headers.get('x-forwarded-host'),
        isProduction: process.env.NODE_ENV === 'production', envTrustedOrigins: trustedOriginsFromEnv(process.env) });
      if (verdict !== 'allowed') return failure('origin_rejected', 403);
      const body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
      let parsed;
      try { parsed = parseUnpaidCurrencyRequest(body); } catch { return failure('invalid_request', 400); }
      if (parsed.invoiceId !== Number(path.invoiceId) || parsed.patientId !== Number(path.patientId)) return failure('identity_mismatch', 400);
      // The frozen actor-bound hash closes a valid-A to valid-B session switch
      // after client revalidation. It is NOT authority: recompute from the
      // canonical server session, never trust an actor asserted by the caller.
      const expectedHash = request.headers.get('x-unpaid-currency-request-hash');
      if (!expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash)) return failure('invalid_actor_binding', 400);
      const currentHash = debtRequestHash({ purpose: 'invoice-unpaid-currency-command-v1', request: parsed,
        actor: { userId: session.userId, username: session.username, role: session.role } });
      if (expectedHash !== currentHash) return failure('actor_binding_mismatch', 409);
      const result = await correctUnpaidInvoiceCurrency(parsed, session);
      return json({ acknowledgement: result.acknowledgement, replayed: result.replayed }, 200);
    }
    const snapshot = await readUnpaidCurrencyCorrection(Number(path.invoiceId), Number(path.patientId), session);
    // Keep envelope metadata OUT of the strict amount-source parser. Preserve
    // PostgreSQL's six fractional digits, never round-trip through JS Date.
    const preview: UnpaidCurrencyPreview = {
      actor: { userId: session.userId, username: session.username, role: 'admin' },
      source: { patientId: snapshot.patientId, invoiceId: snapshot.invoiceId,
        sourceHash: snapshot.sourceHash, currency: snapshot.currency,
        totalMinor: snapshot.totalMinor, discountMinor: snapshot.discountMinor, lines: snapshot.lines },
      sourceCreatedAt: snapshot.sourceCreatedAt,
    };
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(preview.sourceCreatedAt)) throw Error('invalid preview timestamp');
    return json(preview, 200);
  } catch (error) {
    const bodyError = bodyErrorResponse(error);
    if (bodyError) return failure('invalid_body', bodyError.status);
    if (error instanceof DebtRepaymentError) {
      const status = { invalid: 400, missing: 404, unauthorized: 403, stale: 409, conflict: 409 }[error.code];
      return failure(error.code, status);
    }
    // Includes lost COMMIT acknowledgement, SQL failures, and response faults.
    // Never flatten these into a definitive rejection or retire pending evidence.
    return failure('unconfirmed', 500);
  }
}
