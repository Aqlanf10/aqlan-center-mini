import { createHash, createHmac } from "node:crypto";

/**
 * (P0-3) عميل تخزينٍ متوافق مع S3 — Cloudflare R2 وBackblaze B2 وAWS S3 سواء.
 *
 * بلا اعتمادية جديدة: توقيع AWS Signature Version 4 القياسي بمكتبة التشفير المدمجة،
 * وfetch المدمج. أربع عمليات فقط يحتاجها النسخ خارج المنصة: رفع، وفحص، وتنزيل،
 * وسرد. والأسرار من متغيرات البيئة وحدها — لا تُخزَّن في قاعدة البيانات ولا تُطبع.
 */

export interface S3Config {
  /** https://<account>.r2.cloudflarestorage.com أو https://s3.<region>.backblazeb2.com */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** R2 يقبل "auto"؛ Backblaze/AWS منطقة الحاوية. */
  region: string;
}

export const S3_ENV = {
  endpoint: "BACKUP_S3_ENDPOINT",
  bucket: "BACKUP_S3_BUCKET",
  accessKeyId: "BACKUP_S3_ACCESS_KEY_ID",
  secretAccessKey: "BACKUP_S3_SECRET_ACCESS_KEY",
  region: "BACKUP_S3_REGION",
} as const;

/** التكوين من البيئة — أو null بأسماء المتغيرات الناقصة (لا قيمها). */
export function s3ConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): { ok: true; config: S3Config } | { ok: false; missing: string[] } {
  const read = (name: string) => (env[name] ?? "").trim();
  const missing = [S3_ENV.endpoint, S3_ENV.bucket, S3_ENV.accessKeyId, S3_ENV.secretAccessKey].filter((name) => !read(name));
  if (missing.length > 0) return { ok: false, missing };
  const endpoint = read(S3_ENV.endpoint).replace(/\/+$/, "");
  if (!/^https?:\/\/[^/\s]+$/.test(endpoint)) return { ok: false, missing: [S3_ENV.endpoint] };
  return {
    ok: true,
    config: {
      endpoint,
      bucket: read(S3_ENV.bucket),
      accessKeyId: read(S3_ENV.accessKeyId),
      secretAccessKey: read(S3_ENV.secretAccessKey),
      region: read(S3_ENV.region) || "auto",
    },
  };
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** ترميز URI بقواعد SigV4 (RFC 3986، والشرطة المائلة محفوظة في المسار). */
export function uriEncode(value: string, keepSlash: boolean): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%2F/g, keepSlash ? "/" : "%2F");
}

export interface SignInput {
  method: string;
  url: URL;
  /** رؤوسٌ تُوقَّع (يُضاف host تلقائيًّا). */
  headers: Record<string, string>;
  payloadHash: string;
  /** YYYYMMDDTHHMMSSZ */
  amzDate: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** توقيع SigV4 — يعيد قيمة رأس Authorization. دالة خالصة تُختبر بمتجه AWS الرسمي. */
export function signV4(input: SignInput): string {
  const headers: Record<string, string> = { host: input.url.host };
  for (const [name, value] of Object.entries(input.headers)) headers[name.toLowerCase()] = value.trim().replace(/\s+/g, " ");
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${headers[name]}\n`).join("");
  const signedHeaders = names.join(";");
  const query = [...input.url.searchParams.entries()]
    .map(([key, value]) => [uriEncode(key, false), uriEncode(value, false)] as const)
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const canonicalRequest = [
    input.method,
    uriEncode(decodeURIComponent(input.url.pathname), true) || "/",
    query,
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  const day = input.amzDate.slice(0, 8);
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", input.amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), input.service), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

export function amzDateOf(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

type Fetch = typeof fetch;

export class S3Client {
  constructor(private readonly config: S3Config, private readonly fetchImpl: Fetch = fetch) {}

  private objectUrl(key: string, query?: Record<string, string>): URL {
    // مسارٌ على نمط path-style: يعمل مع R2 وB2 وMinIO بلا DNS لكل حاوية.
    const url = new URL(`${this.config.endpoint}/${uriEncode(this.config.bucket, false)}/${uriEncode(key, true)}`);
    for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
    return url;
  }

  private async send(method: string, url: URL, body?: Uint8Array, extra: Record<string, string> = {}): Promise<Response> {
    const payloadHash = sha256Hex(body ?? "");
    const amzDate = amzDateOf(new Date());
    const headers: Record<string, string> = {
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...extra,
    };
    const authorization = signV4({
      method, url, headers, payloadHash, amzDate, region: this.config.region, service: "s3",
      accessKeyId: this.config.accessKeyId, secretAccessKey: this.config.secretAccessKey,
    });
    return this.fetchImpl(url, {
      method,
      headers: { ...headers, authorization },
      body: body ? Buffer.from(body) : undefined,
    });
  }

  async putObject(key: string, body: Uint8Array, metadata: Record<string, string> = {}): Promise<void> {
    const extra: Record<string, string> = { "content-type": "application/octet-stream" };
    for (const [name, value] of Object.entries(metadata)) extra[`x-amz-meta-${name.toLowerCase()}`] = value;
    const response = await this.send("PUT", this.objectUrl(key), body, extra);
    if (!response.ok) throw new Error(`رفض التخزين الخارجي الرفع (HTTP ${response.status}).`);
  }

  async headObject(key: string): Promise<{ bytes: number; metadata: Record<string, string> } | null> {
    const response = await this.send("HEAD", this.objectUrl(key));
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`تعذّر فحص الملف في التخزين الخارجي (HTTP ${response.status}).`);
    const metadata: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      if (name.startsWith("x-amz-meta-")) metadata[name.slice("x-amz-meta-".length)] = value;
    });
    return { bytes: Number(response.headers.get("content-length") ?? "0"), metadata };
  }

  async getObject(key: string): Promise<Buffer> {
    const response = await this.send("GET", this.objectUrl(key));
    if (!response.ok) throw new Error(`تعذّر تنزيل الملف من التخزين الخارجي (HTTP ${response.status}).`);
    return Buffer.from(await response.arrayBuffer());
  }

  /** مفاتيح تبدأ بالبادئة، مع أحجامها وتواريخها — للحاق بأحدث نسخة. */
  async listObjects(prefix: string): Promise<{ key: string; bytes: number; lastModified: string }[]> {
    const url = new URL(`${this.config.endpoint}/${uriEncode(this.config.bucket, false)}`);
    url.searchParams.set("list-type", "2");
    url.searchParams.set("prefix", prefix);
    const response = await this.send("GET", url);
    if (!response.ok) throw new Error(`تعذّر سرد التخزين الخارجي (HTTP ${response.status}).`);
    const xml = await response.text();
    return [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((match) => ({
      key: decodeXml(/<Key>([\s\S]*?)<\/Key>/.exec(match[1])?.[1] ?? ""),
      bytes: Number(/<Size>(\d+)<\/Size>/.exec(match[1])?.[1] ?? "0"),
      lastModified: /<LastModified>([^<]+)<\/LastModified>/.exec(match[1])?.[1] ?? "",
    }));
  }
}

function decodeXml(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
