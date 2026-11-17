import type { NextApiRequest } from "next";
import { Readable } from "node:stream";

/** Create lazily after pre-body authorization. The caller must pass this request
 * exclusively to the existing bounded JSON reader. */
export function nodeRequestForBoundedJson(req: NextApiRequest, url: URL, headers: Headers): Request {
  return new Request(url, { method: "DELETE", headers, body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: "half" } as RequestInit);
}
