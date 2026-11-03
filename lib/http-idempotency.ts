import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { ensureSchema, getPool, type DbClient, type DbPool } from "./db";
import { IDEMPOTENCY_KEY_PATTERN } from "./idempotency-key";

export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export type HttpIdempotencyTxOutcome<TBody = unknown> = {
  status: number;
  body: TBody;
  replay?: boolean;
};

export interface HttpIdempotencyTxOptions<TBody = unknown> {
  /**
   * Optional predicate controlling whether a 2xx outcome should be persisted as
   * `completed` (e.g., prescription preview `200 requiresAcknowledgement` should
   * not freeze the key before final `201` creation).
   */
  shouldCache?: (result: HttpIdempotencyTxOutcome<TBody>) => boolean;
}

function lockNamespaceKey(scope: string, actor: string, key: string): string {
  return `http_idem:${scope}:${actor}:${key}`;
}

export function extractIdempotencyKey(
  request: Request,
  fallbackClientKey?: string | null,
): { ok: true; key: string | null } | { ok: false; status: 400; body: { reason: string; message: string } } {
  const rawHeader = request.headers.get("idempotency-key");
  const candidate = (rawHeader?.trim() || fallbackClientKey?.trim() || "");
  if (!candidate) {
    return { ok: true, key: null };
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(candidate)) {
    return {
      ok: false,
      status: 400,
      body: {
        reason: "invalid_idempotency_key",
        message: "صيغة مفتاح منع التكرار (Idempotency-Key) غير صالحة.",
      },
    };
  }
  return { ok: true, key: candidate };
}

/**
 * Transactional HTTP idempotency (`withHttpIdempotencyInTx`):
 * 1. Acquires a transaction-scoped PostgreSQL advisory lock (`pg_advisory_xact_lock`)
 *    on `(scope, actor, key)` BEFORE reading `http_idempotency_keys`, preventing both
 *    concurrent 0-row phantom races and slow-request (>60s) takeovers.
 * 2. Fails closed (`409 idempotency_outcome_uncertain`) if a prior non-transactional
 *    `in_progress` marker exists after the advisory lock is free.
 * 3. Persists `state = 'completed'` inside the SAME DB transaction as `execute()`,
 *    so domain mutations and idempotency completion commit or roll back atomically.
 */
export async function withHttpIdempotencyInTx<TBody = unknown>(
  client: DbClient,
  request: Request,
  scope: string,
  actor: string,
  rawPayload: unknown,
  execute: () => Promise<HttpIdempotencyTxOutcome<TBody>>,
  options?: HttpIdempotencyTxOptions<TBody>,
): Promise<HttpIdempotencyTxOutcome<TBody>> {
  const parsedKey = extractIdempotencyKey(request);
  if (!parsedKey.ok) {
    return { status: parsedKey.status, body: parsedKey.body as unknown as TBody };
  }
  if (!parsedKey.key) {
    return execute();
  }
  const key = parsedKey.key;
  const requestHash = createHash("sha256").update(canonicalJson(rawPayload)).digest("hex");

  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [lockNamespaceKey(scope, actor, key)],
  );

  const existing = await client.query<{
    request_hash: string;
    state: string;
    status_code: number | null;
    response_body: unknown;
  }>(
    `SELECT request_hash, state, status_code, response_body
       FROM http_idempotency_keys
      WHERE scope = $1 AND actor = $2 AND idempotency_key = $3
      FOR UPDATE`,
    [scope, actor, key],
  );
  const row = existing.rows[0];
  if (row) {
    if (row.request_hash !== requestHash) {
      return {
        status: 409,
        body: {
          reason: "idempotency_conflict",
          message: "مفتاح الإعادة مستعمل بعملية مختلفة.",
        } as unknown as TBody,
      };
    }
    if (row.state === "completed") {
      return {
        status: row.status_code ?? 200,
        body: row.response_body as TBody,
        replay: true,
      };
    }
    return {
      status: 409,
      body: {
        reason: "idempotency_outcome_uncertain",
        message:
          "تعذّر الجزم بنتيجة طلب سابق يحمل المفتاح نفسه؛ راجع السجل قبل المحاولة بمفتاح جديد.",
      } as unknown as TBody,
    };
  }

  await client.query("SAVEPOINT http_idempotency_tx_sp");
  try {
    const result = await execute();
    const isSuccess = result.status >= 200 && result.status < 300;
    const cacheable = options?.shouldCache ? options.shouldCache(result) : isSuccess;

    if (cacheable) {
      await client.query(
        `INSERT INTO http_idempotency_keys
           (scope, actor, idempotency_key, request_hash, state, status_code, response_body, completed_at)
         VALUES ($1, $2, $3, $4, 'completed', $5, $6::jsonb, NOW())
         ON CONFLICT (scope, actor, idempotency_key) DO UPDATE
            SET state = 'completed',
                status_code = EXCLUDED.status_code,
                response_body = EXCLUDED.response_body,
                completed_at = NOW()`,
        [scope, actor, key, requestHash, result.status, JSON.stringify(result.body ?? null)],
      );
      await client.query("RELEASE SAVEPOINT http_idempotency_tx_sp");
      return result;
    }

    if (result.status >= 400) {
      await client.query("ROLLBACK TO SAVEPOINT http_idempotency_tx_sp");
    }
    await client.query("RELEASE SAVEPOINT http_idempotency_tx_sp");
    return result;
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT http_idempotency_tx_sp").catch(() => {});
    await client.query("RELEASE SAVEPOINT http_idempotency_tx_sp").catch(() => {});
    throw error;
  }
}

export type OutboundReservationResult =
  | { kind: "unkeyed" }
  | { kind: "reserved"; key: string; requestHash: string }
  | { kind: "replay"; status: number; body: unknown }
  | { kind: "conflict"; status: 400 | 409; body: { reason: string; code?: string; message: string } };

/**
 * Claims a durable `in_progress` reservation inside a short pre-transport DB transaction
 * AFTER live authorization, scope, consent, and channel readiness checks pass.
 * Once committed, external network transport may proceed without holding DB locks; if
 * post-transport DB recording fails or transport outcome is uncertain, `in_progress`
 * remains on disk so retries fail closed (`409 outbound_delivery_uncertain`) rather than
 * sending a duplicate external message.
 */
export async function claimOutboundIdempotencyInTx(
  client: DbClient,
  request: Request,
  scope: string,
  actor: string,
  rawPayload: unknown,
  fallbackClientKey?: string | null,
): Promise<OutboundReservationResult> {
  const parsedKey = extractIdempotencyKey(request, fallbackClientKey);
  if (!parsedKey.ok) {
    return { kind: "conflict", status: parsedKey.status, body: parsedKey.body };
  }
  if (!parsedKey.key) {
    return { kind: "unkeyed" };
  }
  const key = parsedKey.key;
  const requestHash = createHash("sha256").update(canonicalJson(rawPayload)).digest("hex");

  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [lockNamespaceKey(scope, actor, key)],
  );

  const existing = await client.query<{
    request_hash: string;
    state: string;
    status_code: number | null;
    response_body: unknown;
  }>(
    `SELECT request_hash, state, status_code, response_body
       FROM http_idempotency_keys
      WHERE scope = $1 AND actor = $2 AND idempotency_key = $3
      FOR UPDATE`,
    [scope, actor, key],
  );
  const row = existing.rows[0];
  if (row) {
    if (row.request_hash !== requestHash) {
      return {
        kind: "conflict",
        status: 409,
        body: {
          reason: "idempotency_conflict",
          code: "idempotency_conflict",
          message: "مفتاح الإعادة مستعمل بعملية مختلفة.",
        },
      };
    }
    if (row.state === "completed") {
      return {
        kind: "replay",
        status: row.status_code ?? 201,
        body: row.response_body,
      };
    }
    return {
      kind: "conflict",
      status: 409,
      body: {
        reason: "outbound_delivery_uncertain",
        code: "outbound_delivery_uncertain",
        message:
          "تعذّر الجزم بحالة محاولة إرسال سابقة لهذا المفتاح — راجع سجل الرسائل ولا تُعد الإرسال تلقائيًّا.",
      },
    };
  }

  await client.query(
    `INSERT INTO http_idempotency_keys (scope, actor, idempotency_key, request_hash, state)
     VALUES ($1, $2, $3, $4, 'in_progress')`,
    [scope, actor, key, requestHash],
  );
  return { kind: "reserved", key, requestHash };
}

export async function completeOutboundIdempotency(
  pool: DbPool,
  scope: string,
  actor: string,
  key: string,
  statusCode: number,
  responseBody: unknown,
): Promise<boolean> {
  try {
    await pool.query(
      `UPDATE http_idempotency_keys
          SET state = 'completed',
              status_code = $4,
              response_body = $5::jsonb,
              completed_at = NOW()
        WHERE scope = $1 AND actor = $2 AND idempotency_key = $3`,
      [scope, actor, key, statusCode, JSON.stringify(responseBody ?? null)],
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Releases an `in_progress` outbound reservation ONLY when it is certain that no
 * external transport was attempted (validation/consent/channel/authority refusal).
 */
export async function releaseOutboundReservation(
  pool: DbPool,
  scope: string,
  actor: string,
  key: string,
  requestHash: string,
): Promise<void> {
  await pool
    .query(
      `DELETE FROM http_idempotency_keys
        WHERE scope = $1 AND actor = $2 AND idempotency_key = $3
          AND request_hash = $4 AND state = 'in_progress'`,
      [scope, actor, key, requestHash],
    )
    .catch(() => {});
}

/**
 * (DATA-04) Standalone HTTP idempotency for legacy route handlers:
 * - Holds a session-scoped PostgreSQL advisory lock (`pg_try_advisory_lock`) for the
 *   entire execution lifetime, so slow requests (>60s) can NEVER be taken over while
 *   still running (`409 idempotency_in_progress`).
 * - Once `execute()` is entered, NEVER deletes the `in_progress` marker on `2xx`
 *   recording failures, `5xx` responses, or thrown errors whose commit outcome is
 *   unknown. Subsequent retries with the same key fail closed (`409 idempotency_outcome_uncertain`)
 *   instead of risking duplicate financial or clinical mutations.
 */
export async function withHttpIdempotency(
  request: Request,
  scope: string,
  actor: string,
  rawPayload: unknown,
  execute: () => Promise<NextResponse>,
  pool?: DbPool,
): Promise<NextResponse> {
  const parsedKey = extractIdempotencyKey(request);
  if (!parsedKey.ok) {
    return NextResponse.json(parsedKey.body, { status: parsedKey.status });
  }
  if (!parsedKey.key) {
    return execute();
  }
  const key = parsedKey.key;
  const requestHash = createHash("sha256").update(canonicalJson(rawPayload)).digest("hex");

  let activePool: DbPool;
  if (pool) {
    activePool = pool;
  } else {
    await ensureSchema();
    activePool = getPool();
  }

  const lockKey = lockNamespaceKey(scope, actor, key);
  const lockClient = await activePool.connect();
  let lockHeld = false;
  try {
    const { rows: [lk] } = await lockClient.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
      [lockKey],
    );
    if (!lk?.locked) {
      return NextResponse.json(
        { reason: "idempotency_in_progress", message: "الطلب الأول لا يزال قيد المعالجة." },
        { status: 409 },
      );
    }
    lockHeld = true;

    const existing = await lockClient.query<{
      request_hash: string;
      state: string;
      status_code: number | null;
      response_body: unknown;
    }>(
      `SELECT request_hash, state, status_code, response_body
         FROM http_idempotency_keys
        WHERE scope = $1 AND actor = $2 AND idempotency_key = $3`,
      [scope, actor, key],
    );
    const row = existing.rows[0];
    if (row) {
      if (row.request_hash !== requestHash) {
        return NextResponse.json(
          { reason: "idempotency_conflict", message: "مفتاح الإعادة مستعمل بعملية مختلفة." },
          { status: 409 },
        );
      }
      if (row.state === "completed") {
        return NextResponse.json(row.response_body, {
          status: row.status_code ?? 200,
          headers: { "X-Idempotent-Replay": "true" },
        });
      }
      return NextResponse.json(
        {
          reason: "idempotency_outcome_uncertain",
          message:
            "تعذّر الجزم بنتيجة طلب سابق يحمل المفتاح نفسه؛ راجع السجل قبل المحاولة بمفتاح جديد.",
        },
        { status: 409 },
      );
    }

    await lockClient.query(
      `INSERT INTO http_idempotency_keys (scope, actor, idempotency_key, request_hash, state)
       VALUES ($1, $2, $3, $4, 'in_progress')`,
      [scope, actor, key, requestHash],
    );

    const response = await execute();
    if (response.status >= 200 && response.status < 300) {
      let bodyJson: unknown = null;
      try {
        bodyJson = await response.clone().json();
      } catch {
        bodyJson = null;
      }
      // Best-effort transition to `completed`: if this UPDATE fails after `execute()`
      // already committed its 2xx mutation, keep `in_progress` on disk so retries fail
      // closed (`idempotency_outcome_uncertain`) rather than re-running `execute()`.
      await lockClient
        .query(
          `UPDATE http_idempotency_keys
              SET state = 'completed',
                  status_code = $4,
                  response_body = $5::jsonb,
                  completed_at = NOW()
            WHERE scope = $1 AND actor = $2 AND idempotency_key = $3`,
          [scope, actor, key, response.status, JSON.stringify(bodyJson)],
        )
        .catch(() => {});
    } else if (response.status >= 400 && response.status < 500) {
      await lockClient
        .query(
          `DELETE FROM http_idempotency_keys
            WHERE scope = $1 AND actor = $2 AND idempotency_key = $3 AND state = 'in_progress'`,
          [scope, actor, key],
        )
        .catch(() => {});
    }
    return response;
  } finally {
    if (lockHeld) {
      await lockClient
        .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey])
        .catch(() => {});
    }
    lockClient.release();
  }
}
