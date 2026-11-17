import type { NextApiRequest, NextApiResponse } from "next";
import { NextRequest } from "next/server";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { definePagesApi } from "@/lib/pages-api";
import { SESSION_COOKIE } from "@/lib/auth";
import { selectStaffEnvelope } from "@/lib/staff-session-admission";
import { requireSessionFromTransport } from "@/lib/session";
import { documentGet, documentDelete } from "@/lib/document-route-core";
import { nodeRequestForBoundedJson } from "@/lib/pages-body";

export const config = { api: { bodyParser: false } };

async function execute(req: NextApiRequest, res: NextApiResponse, method: "GET" | "DELETE", handler: typeof documentGet | typeof documentDelete) {
  const headers = new Headers();
  for (const [key,value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const part of value) headers.append(key,part);
    else if (value !== undefined) headers.set(key,value);
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  // Use the same RequestCookies parser as App Router, including duplicate-name handling.
  const cookie = new NextRequest(url, { headers }).cookies.get(SESSION_COOKIE)?.value;
  const authorization = headers.get("authorization");
  const selected = selectStaffEnvelope(cookie, authorization);
  const legacy = () => requireSessionFromTransport(cookie, authorization);
  const request = method === "DELETE" ? () => nodeRequestForBoundedJson(req, url, headers) : new Request(url, { headers });
  const raw = req.query.id; const id = typeof raw === "string" ? raw : "";
  const context = { params: Promise.resolve({ id }) };
  const response = method === "GET"
    ? await (handler as typeof documentGet)(request as Request, context, selected, legacy)
    : await (handler as typeof documentDelete)(request, context, selected, legacy);
  res.statusCode = response.status;
  response.headers.forEach((value,key) => {
    if (!["content-length","content-encoding","transfer-encoding"].includes(key.toLowerCase())) res.setHeader(key,value);
  });
  if (method === "GET" && response.status === 200) res.setHeader("Cache-Control", "private, no-store, no-transform");
  const length = response.headers.get("content-length");
  if (length !== null) res.setHeader("Content-Length", length);
  if (req.method === "HEAD" || response.body === null) {
    await response.body?.cancel();
    res.end();
    return;
  }
  // Preserve backpressure without buffering a second copy of the file.
  await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), res);
}

export default definePagesApi({
  GET: async (req, res) => execute(req, res, "GET", documentGet),
  DELETE: async (req, res) => execute(req, res, "DELETE", documentDelete),
});
