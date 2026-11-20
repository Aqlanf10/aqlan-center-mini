import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { build } from "esbuild";
import type { Pool, PoolClient } from "pg";
import { PatientNumberingPostgresBackend } from "../../../lib/patient-numbering-postgres";
import { planPatientNumbering, parseNumberingRequest } from "../../../lib/patient-numbering-policy";
import { ownerContextFromTrustedBinding, resolveStaffCapabilities, staffAuthorizationFingerprint } from "../../../lib/staff-capabilities";
import { executePatientNumberingSave, type PatientNumberingPreviewClaims } from "../../../lib/patient-numbering-controller";
import { withPatientNumberingInsertScope } from "../../../lib/patient-numbering-insert-scope";

async function json(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  if (request.headers["content-type"] !== "application/json") return null;
  const parts: Buffer[] = [];
  let length = 0;
  for await (const part of request) {
    const bytes = Buffer.from(part);
    length += bytes.byteLength;
    if (length > 8 * 1024) return null;
    parts.push(bytes);
  }
  try {
    const body = JSON.parse(Buffer.concat(parts).toString("utf8"));
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch { return null; }
}
function compare(first: string, second: string) {
  const a = Buffer.from(first), b = Buffer.from(second);
  return a.length === b.length && timingSafeEqual(a, b);
}
/** Private local Playwright server, never a Next/API route or package script. */
export async function startNumberingBrowserFixture(options: {
  pool: Pool; schema: string; databaseName: string;
  ordinary: () => Promise<string>;
}) {
  if (!/^aqlan_numbering_browser_[0-9a-f]{32}$/.test(options.databaseName)
    || !/^numbering_fixture_[0-9a-f]{32}$/.test(options.schema) || process.env.NODE_ENV !== "test") {
    throw new Error("Not an owned executable browser fixture");
  }
  const ownerToken = randomBytes(32).toString("base64url");
  const adminToken = randomBytes(32).toString("base64url");
  const previewKey = randomBytes(32);
  const binding = ownerContextFromTrustedBinding({ ownerUserId: 99, bindingVersion: "synthetic-browser-only" });
  const auth = (actorId: number) => resolveStaffCapabilities({
    subject: { userId: actorId, role: "admin", isActive: true, clinicianPartyId: null },
    permissionDocument: { schemaVersion: 2, confirmation: "owner", revision: 1, patientScope: "none", appointmentScope: "none", grants: {} },
  }, binding);
  const sign = (text: string) => createHmac("sha256", previewKey).update(text).digest("base64url");
  function encode(claims: PatientNumberingPreviewClaims) {
    const data = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return data + "." + sign(data);
  }
  function verify(token: string): PatientNumberingPreviewClaims | null {
    const [data, mac, extra] = token.split(".");
    if (!data || !mac || extra !== undefined || !compare(mac, sign(data))) return null;
    try { return JSON.parse(Buffer.from(data, "base64url").toString("utf8")); } catch { return null; }
  }
  const javascript = (await build({
    entryPoints: ["__tests__/fixtures/numbering-browser/client.tsx"],
    platform: "browser", bundle: true, format: "iife", write: false, jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
  })).outputFiles[0].contents;
  const html = '<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>مختبر الترقيم</title><div id="root"></div><script defer src="/fixture.js"></script></html>';
  let origin = "";
  const server = createServer(async (request, response) => {
    function send(status: number, object: unknown) {
      response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify(object));
    }
    try {
      if (request.socket.remoteAddress !== "127.0.0.1" || request.headers.host !== new URL(origin).host) {
        send(404, { ok: false }); return;
      }
      if (request.method === "GET" && request.url === "/") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html); return;
      }
      if (request.method === "GET" && request.url === "/fixture.js") {
        response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" }).end(javascript); return;
      }
      const raw = request.headers["x-synthetic-numbering-token"];
      const actorId = typeof raw === "string" && compare(raw, ownerToken) ? 99
        : typeof raw === "string" && compare(raw, adminToken) ? 100 : 0;
      if (request.method !== "POST" || request.headers.origin !== origin || !actorId) { send(404, { ok: false }); return; }
      const body = await json(request);
      if (!body) { send(400, { ok: false, reason: "invalid-input" }); return; }
      const sessionBinding = sign("fixture-session:" + actorId);
      async function ownerSession(client: PoolClient) {
        const checked = (await client.query("SELECT current_database() AS name")).rows[0]?.name;
        if (checked !== options.databaseName) throw new Error("Synthetic target identity mismatch");
        return { access: auth(actorId), sessionBinding };
      }
      const backend = new PatientNumberingPostgresBackend({ pool: options.pool, schema: options.schema, ownerSession });
      if (request.url === "/test/ordinary") {
        const number = await withPatientNumberingInsertScope(async client => {
          if ((await client.query("SELECT current_database() AS name")).rows[0]?.name !== options.databaseName) {
            throw new Error("Synthetic target identity mismatch");
          }
          return backend.allocateInExistingTransaction(client);
        }, options.ordinary);
        send(200, { ok: true, number }); return;
      }
      if (request.url === "/test/save") {
        const result = await executePatientNumberingSave(body, { backend, verifyPreview: async token => verify(token) });
        send(result.ok ? 200 : 403, result); return;
      }
      if (request.url !== "/test/read" && request.url !== "/test/preview") { send(404, { ok: false }); return; }
      const result = await backend.transaction(async tx => {
        const paired = await tx.ownerSession?.();
        const fingerprint = paired && staffAuthorizationFingerprint(paired.access);
        if (!paired?.access.isOwner || !fingerprint) return { ok: false, reason: "owner-required" };
        if (request.url === "/test/read") {
          const probe = await tx.snapshot("P");
          const prefix = probe.revision.split(":")[1];
          const current = prefix === "P" ? probe : await tx.snapshot(prefix);
          return { ok: true, readId: randomUUID(), current: {
            prefix, next: (current.pendingNext ?? current.allocatedThrough + 1n).toString(), revision: current.revision,
          } };
        }
        const parsed = parseNumberingRequest(body.prefix, body.next);
        const reason = typeof body.reason === "string" ? body.reason.trim() : "";
        if (!parsed || !reason || reason.length > 500) return { ok: false, reason: "invalid-input" };
        const current = await tx.snapshot(parsed.prefix);
        const plan = planPatientNumbering(parsed, current, current.revision);
        if (!plan.ok) return plan;
        const command = { ...parsed, reason, expectedRevision: plan.expectedRevision, requestId: randomUUID() };
        const previewToken = encode({ version: 1, purpose: "patient-numbering.change", actorId,
          authorityFingerprint: fingerprint, sessionBinding, command, expiresAt: Date.now() + 60_000 });
        return { ok: true, ticket: { ...command, preview: plan.preview, previewToken } };
      });
      send(result.ok ? 200 : 403, result);
    } catch { send(500, { ok: false, reason: "fixture-failed" }); }
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server address missing");
  origin = "http://127.0.0.1:" + address.port;
  return { origin, ownerToken, adminToken, close: () => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
  }) };
}
