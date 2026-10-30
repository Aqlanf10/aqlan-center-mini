import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { ensureSchema, getPool } from "./db";
import { IDEMPOTENCY_KEY_PATTERN } from "./idempotency-key";

function canonicalJson(value: unknown): string {
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

/**
 * (DATA-04) حماية عدم التكرار لمسارات الكتابة المالية والسريرية الحرجة عبر ترويسة `Idempotency-Key`.
 *
 * - إذا لم تُرسل الترويسة، يعمل المسار مباشرةً بلا أي استعلام إضافي (متوافق مع الاختبارات الحالية).
 * - إذا أُرسلت الترويسة، يُتحقق من صيغتها وبصمة الطلب (`SHA-256`)، ويُعاد نفس الرد المحفوظ عند التكرار
 *   أو يُرفض بـ `409` عند استخدام نفس المفتاح لحمولة مختلفة.
 */
export async function withHttpIdempotency(
  request: Request,
  scope: string,
  actor: string,
  rawPayload: unknown,
  execute: () => Promise<NextResponse>,
): Promise<NextResponse> {
  const rawHeader = request.headers.get("idempotency-key");
  const key = rawHeader?.trim() ?? "";
  if (!key) {
    return execute();
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    return NextResponse.json(
      { reason: "invalid_idempotency_key", message: "صيغة مفتاح منع التكرار (Idempotency-Key) غير صالحة." },
      { status: 400 },
    );
  }

  const requestHash = createHash("sha256").update(canonicalJson(rawPayload)).digest("hex");
  await ensureSchema();
  const pool = getPool();

  const claimed = await pool.query<{ id: string }>(
    `INSERT INTO http_idempotency_keys (scope, actor, idempotency_key, request_hash, state)
     VALUES ($1, $2, $3, $4, 'in_progress')
     ON CONFLICT (scope, actor, idempotency_key) DO NOTHING
     RETURNING id::text`,
    [scope, actor, key, requestHash],
  );

  if (!claimed.rows[0]) {
    const existing = await pool.query<{
      request_hash: string;
      state: string;
      status_code: number | null;
      response_body: unknown;
      age_ms: number;
    }>(
      `SELECT request_hash, state, status_code, response_body,
              EXTRACT(EPOCH FROM (NOW() - created_at)) * 1000 AS age_ms
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
      if (Number(row.age_ms ?? 0) < 60_000) {
        return NextResponse.json(
          { reason: "idempotency_in_progress", message: "الطلب الأول لا يزال قيد المعالجة." },
          { status: 409 },
        );
      }
      await pool.query(
        `UPDATE http_idempotency_keys
            SET created_at = NOW(), state = 'in_progress'
          WHERE scope = $1 AND actor = $2 AND idempotency_key = $3 AND state = 'in_progress'`,
        [scope, actor, key],
      );
    }
  }

  try {
    const response = await execute();
    if (response.status >= 200 && response.status < 300) {
      let bodyJson: unknown = null;
      try {
        bodyJson = await response.clone().json();
      } catch {
        bodyJson = null;
      }
      await pool.query(
        `UPDATE http_idempotency_keys
            SET state = 'completed',
                status_code = $4,
                response_body = $5::jsonb,
                completed_at = NOW()
          WHERE scope = $1 AND actor = $2 AND idempotency_key = $3`,
        [scope, actor, key, response.status, JSON.stringify(bodyJson)],
      );
    } else {
      await pool.query(
        `DELETE FROM http_idempotency_keys
          WHERE scope = $1 AND actor = $2 AND idempotency_key = $3 AND state = 'in_progress'`,
        [scope, actor, key],
      );
    }
    return response;
  } catch (error) {
    await pool
      .query(
        `DELETE FROM http_idempotency_keys
          WHERE scope = $1 AND actor = $2 AND idempotency_key = $3 AND state = 'in_progress'`,
        [scope, actor, key],
      )
      .catch(() => {});
    throw error;
  }
}
