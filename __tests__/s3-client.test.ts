import { describe, expect, it } from "vitest";
import { S3Client, amzDateOf, s3ConfigFromEnv, sha256Hex, signV4 } from "@/lib/s3-client";

/** (P0-3) توقيع SigV4 مطابقٌ لأمثلة AWS الرسمية — لا نثق بتوقيعٍ لم يُطابَق. */
describe("signV4 — AWS reference vectors", () => {
  it("aws-sig-v4-test-suite get-vanilla", () => {
    const authorization = signV4({
      method: "GET",
      url: new URL("https://example.amazonaws.com/"),
      headers: { "X-Amz-Date": "20150830T123600Z" },
      payloadHash: sha256Hex(""),
      amzDate: "20150830T123600Z",
      region: "us-east-1",
      service: "service",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    });
    expect(authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, "
      + "SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  it("S3 documentation example: GET Object with Range", () => {
    const authorization = signV4({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: {
        range: "bytes=0-9",
        "x-amz-content-sha256": sha256Hex(""),
        "x-amz-date": "20130524T000000Z",
      },
      payloadHash: sha256Hex(""),
      amzDate: "20130524T000000Z",
      region: "us-east-1",
      service: "s3",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    });
    expect(authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, "
      + "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, "
      + "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("amzDateOf formats UTC basic time", () => {
    expect(amzDateOf(new Date("2026-09-25T15:04:05.123Z"))).toBe("20260925T150405Z");
  });
});

describe("s3ConfigFromEnv", () => {
  it("names the missing variables, never their values", () => {
    const result = s3ConfigFromEnv({ BACKUP_S3_BUCKET: "b" });
    expect(result).toEqual({
      ok: false,
      missing: ["BACKUP_S3_ENDPOINT", "BACKUP_S3_ACCESS_KEY_ID", "BACKUP_S3_SECRET_ACCESS_KEY"],
    });
  });

  it("defaults the region to auto (Cloudflare R2) and trims the endpoint", () => {
    const result = s3ConfigFromEnv({
      BACKUP_S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com/", BACKUP_S3_BUCKET: "clinic",
      BACKUP_S3_ACCESS_KEY_ID: "k", BACKUP_S3_SECRET_ACCESS_KEY: "s",
    });
    expect(result.ok && result.config).toMatchObject({ endpoint: "https://acct.r2.cloudflarestorage.com", region: "auto" });
  });
});

describe("S3Client requests", () => {
  it("PUT is path-style, signed, carries the payload hash and metadata", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = new S3Client(
      { endpoint: "https://acct.r2.cloudflarestorage.com", bucket: "clinic", accessKeyId: "k", secretAccessKey: "s", region: "auto" },
      (async (url: URL, init: RequestInit) => { calls.push({ url: String(url), init }); return new Response(null, { status: 200 }); }) as never,
    );
    const body = new TextEncoder().encode("encrypted");
    await client.putObject("aqlan-backups/x.enc", body, { sha256: "abc" });
    expect(calls[0].url).toBe("https://acct.r2.cloudflarestorage.com/clinic/aqlan-backups/x.enc");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["x-amz-content-sha256"]).toBe(sha256Hex(body));
    expect(headers["x-amz-meta-sha256"]).toBe("abc");
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=k\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-meta-sha256, Signature=[0-9a-f]{64}$/);
  });

  it("a refused upload throws an Arabic error without echoing the provider body", async () => {
    const client = new S3Client(
      { endpoint: "https://x.example", bucket: "b", accessKeyId: "k", secretAccessKey: "s", region: "auto" },
      (async () => new Response("<Error>SignatureDoesNotMatch secret</Error>", { status: 403 })) as never,
    );
    await expect(client.putObject("k", new Uint8Array([1]))).rejects.toThrow("رفض التخزين الخارجي الرفع (HTTP 403).");
  });

  it("listObjects follows continuation tokens so the newest backup is never missed (> 1000 objects)", async () => {
    const urls: string[] = [];
    const page = (keys: string[], next: string | null) => `<?xml version="1.0"?><ListBucketResult>${keys.map((key) =>
      `<Contents><Key>${key}</Key><Size>1</Size><LastModified>2026-09-${key.slice(-6, -4)}T00:00:00Z</LastModified></Contents>`).join("")}`
      + `<IsTruncated>${next ? "true" : "false"}</IsTruncated>${next ? `<NextContinuationToken>${next}</NextContinuationToken>` : ""}</ListBucketResult>`;
    const client = new S3Client(
      { endpoint: "https://x.example", bucket: "b", accessKeyId: "k", secretAccessKey: "s", region: "auto" },
      (async (url: URL) => {
        urls.push(String(url));
        const token = new URL(String(url)).searchParams.get("continuation-token");
        return new Response(token === "p2" ? page(["aqlan-backups/c-25.enc"], null) : page(["aqlan-backups/a-01.enc", "aqlan-backups/b-02.enc"], "p2"), { status: 200 });
      }) as never,
    );
    const keys = (await client.listObjects("aqlan-backups/")).map((object) => object.key);
    expect(keys).toEqual(["aqlan-backups/a-01.enc", "aqlan-backups/b-02.enc", "aqlan-backups/c-25.enc"]);
    expect(urls).toHaveLength(2);
    expect(new URL(urls[1]).searchParams.get("continuation-token")).toBe("p2");
  });
});
