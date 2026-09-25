import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import { assertRealPostgresUrl, createIsolatedDatabase, dropPublicSchema, stubPostgresEnv, adminClient } from "./_setup";

/**
 * (P0-3) رحلة كاملة على PostgreSQL 18 الحقيقي: نسخة ← رفعٌ مشفّر خارج المنصة ←
 * تجربة استعادة مشهودة إلى قاعدةٍ فارغة معزولة ← المريض موجود في المستعادة.
 *
 * التخزين الخارجي هنا خادم HTTP محلي **يتحقق من توقيع SigV4 لكل طلب** بإعادة
 * حسابه — فالطلبات حقيقية على الشبكة، والتوقيع الخاطئ يُرفض كما يرفضه R2.
 */

assertRealPostgresUrl();
stubPostgresEnv();

// المستندات داخل القرص الدائم كما في الإنتاج — المحرّك يرفض دليلًا خارجه (misconfigured).
const volume = await mkdtemp(path.join(tmpdir(), "aqlan-offsite-volume-"));
const sourceDocsDir = path.join(volume, "documents");
await mkdir(sourceDocsDir, { recursive: true });
vi.stubEnv("DOCUMENTS_DIR", sourceDocsDir);

const { fullBackupBlocks } = await import("../../lib/fullBackup");
const { ensureSchema, getPool, resetPoolForTesting } = await import("../../lib/db");
const { runBackupCycle } = await import("../../lib/backupEngine");
const { createS3Provider, railwayVolumeProvider, s3ObjectKeyOf } = await import("../../lib/backupDestinations");
const { S3Client, signV4, sha256Hex } = await import("../../lib/s3-client");
const { runOffsiteRestoreDrill, drillReportText } = await import("../../lib/backup-offsite-drill");

const KEY = "b".repeat(64);
const ACCESS = "test-access";
const SECRET = "test-secret";
const objects = new Map<string, { body: Buffer; meta: Record<string, string>; lastModified: string }>();
let server: Server;
let endpoint = "";
let rejectedSignatures = 0;
const TARGET_DB = `aqlan_offsite_drill_${Date.now().toString(36)}`;
const TARGET_DB_2 = `${TARGET_DB}_b`;

function bodyOf(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

/** يعيد حساب التوقيع من الطلب كما وصل — ما لم يطابق يُرفض 403 كـR2. */
function signatureValid(request: IncomingMessage, body: Buffer): boolean {
  const auth = String(request.headers.authorization ?? "");
  const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth);
  if (!match || match[1] !== ACCESS) return false;
  const payloadHash = String(request.headers["x-amz-content-sha256"] ?? "");
  if (payloadHash !== sha256Hex(body)) return false;
  const headers: Record<string, string> = {};
  for (const name of match[4].split(";")) if (name !== "host") headers[name] = String(request.headers[name] ?? "");
  const expected = signV4({
    method: request.method ?? "GET", url: new URL(`http://${request.headers.host}${request.url}`), headers, payloadHash,
    amzDate: String(request.headers["x-amz-date"]), region: match[3], service: "s3", accessKeyId: ACCESS, secretAccessKey: SECRET,
  });
  return expected === auth;
}

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const body = await bodyOf(request);
    if (!signatureValid(request, body)) { rejectedSignatures++; response.writeHead(403).end("<Error>SignatureDoesNotMatch</Error>"); return; }
    const url = new URL(`http://x${request.url}`);
    const key = decodeURIComponent(url.pathname.replace(/^\/clinic\/?/, ""));
    if (request.method === "PUT") {
      const meta: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) if (name.startsWith("x-amz-meta-")) meta[name.slice(11)] = String(value);
      objects.set(key, { body, meta, lastModified: new Date().toISOString() });
      response.writeHead(200).end();
    } else if (request.method === "HEAD" || (request.method === "GET" && key)) {
      const found = objects.get(key);
      if (!found) { response.writeHead(404).end(); return; }
      const headers: Record<string, string> = { "content-length": String(found.body.length) };
      for (const [name, value] of Object.entries(found.meta)) headers[`x-amz-meta-${name}`] = value;
      response.writeHead(200, headers).end(request.method === "HEAD" ? undefined : found.body);
    } else {
      const prefix = url.searchParams.get("prefix") ?? "";
      const contents = [...objects.entries()].filter(([name]) => name.startsWith(prefix))
        .map(([name, value]) => `<Contents><Key>${name}</Key><Size>${value.body.length}</Size><LastModified>${value.lastModified}</LastModified></Contents>`).join("");
      response.writeHead(200, { "content-type": "application/xml" }).end(`<ListBucketResult>${contents}</ListBucketResult>`);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  endpoint = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  await getPool().query(`INSERT INTO patients (patient_number, full_name, phone) VALUES ('OFF-1', 'مريض النسخة الخارجية', '777999000')`);
}, 180_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await resetPoolForTesting();
  const admin = adminClient("postgres");
  await admin.connect();
  try {
    for (const name of [TARGET_DB, TARGET_DB_2]) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
  await rm(volume, { recursive: true, force: true }).catch(() => {});
});

const env = () => ({
  BACKUP_ENCRYPTION_KEY: KEY, BACKUP_S3_ENDPOINT: endpoint, BACKUP_S3_BUCKET: "clinic",
  BACKUP_S3_ACCESS_KEY_ID: ACCESS, BACKUP_S3_SECRET_ACCESS_KEY: SECRET, BACKUP_S3_REGION: "auto",
});
const client = () => new S3Client({ endpoint, bucket: "clinic", accessKeyId: ACCESS, secretAccessKey: SECRET, region: "auto" });
let uploadedKey = "";

describe("P0-3 — النسخ خارج المنصة وتجربة الاستعادة المشهودة", () => {
  it("دورة النسخ ترفع الأرشيف المُتحقق منه مشفّرًا إلى الحاوية، والتوقيع يُقبل", async () => {
    const result = await runBackupCycle({
      triggerType: "manual",
      volumeRoot: volume,
      documentsDir: sourceDocsDir,
      now: new Date("2026-09-25T03:00:00Z"),
      config: {
        backupEnabled: true, scheduleEnabled: true, scheduleTime: "03:00", scheduleTimeZone: "Asia/Aden",
        retentionDailyCount: 30, retentionWeeklyCount: 12, destinations: { railwayVolume: true, googleDrive: false, s3: true },
      },
      blocks: () => fullBackupBlocks(),
      providers: [railwayVolumeProvider, createS3Provider({ env: env() })],
      log: () => {},
    });
    expect(result.backup?.status).toBe("verified");
    const s3 = result.destinations?.find((destination) => destination.destination === "s3");
    expect(s3?.status).toBe("success");
    expect(result.replicationStatus).toBe("complete");
    uploadedKey = s3ObjectKeyOf(result.backup!.backupId);
    expect(objects.has(uploadedKey)).toBe(true);
    expect(rejectedSignatures).toBe(0);
  });

  it("تجربة الاستعادة المشهودة: تنزيل ← تحقق البصمات والمفتاح ← استعادة إلى قاعدة فارغة ← المريض موجود", async () => {
    const targetUrl = await createIsolatedDatabase(TARGET_DB);
    const stagingDir = await mkdtemp(path.join(tmpdir(), "aqlan-offsite-staging-"));
    const report = await runOffsiteRestoreDrill({
      client: client(), keyHex: KEY, targetUrl, stagingDir, witness: "د. الشاهد", operator: "المنفِّذ",
    });
    expect(report.errors).toEqual([]);
    expect(report).toMatchObject({
      ok: true, objectKey: uploadedKey, witness: "د. الشاهد",
      checks: { encryptedHashMatches: true, keyFingerprintMatches: true, archiveHashMatches: true },
    });
    expect(report.restore?.criticalProbeOk).toBe(true);
    expect(drillReportText(report)).toContain("نجحت ✔");

    const restored = new Client({ connectionString: targetUrl, ssl: false });
    await restored.connect();
    try {
      const { rows } = await restored.query(`SELECT full_name FROM patients WHERE patient_number = 'OFF-1'`);
      expect(rows[0]?.full_name).toBe("مريض النسخة الخارجية");
    } finally {
      await restored.end();
    }
    await rm(stagingDir, { recursive: true, force: true });
  });

  it("مفتاحٌ آخر ⇒ التجربة ترفض قبل أي لمس للقاعدة", async () => {
    const report = await runOffsiteRestoreDrill({
      client: client(), keyHex: "c".repeat(64), targetUrl: "postgres://unused", stagingDir: "/nonexistent", witness: "ش", operator: "م",
    });
    expect(report.ok).toBe(false);
    expect(report.checks.keyFingerprintMatches).toBe(false);
    expect(report.restore).toBeNull();
  });

  it("ملفٌ عُبث به في الحاوية ⇒ بصمة المنزَّل لا تطابق، ولا استعادة", async () => {
    const stored = objects.get(uploadedKey)!;
    const tampered = Buffer.from(stored.body);
    tampered[tampered.length - 1] ^= 0xff;
    objects.set(uploadedKey, { ...stored, body: tampered });
    const report = await runOffsiteRestoreDrill({
      client: client(), keyHex: KEY, targetUrl: await createIsolatedDatabase(TARGET_DB_2), stagingDir: "/nonexistent", witness: "ش", operator: "م",
    });
    expect(report.ok).toBe(false);
    expect(report.checks.encryptedHashMatches).toBe(false);
    expect(report.restore).toBeNull();
    objects.set(uploadedKey, stored);
  });

  it("بلا شاهد ⇒ لا تجربة", async () => {
    const report = await runOffsiteRestoreDrill({
      client: client(), keyHex: KEY, targetUrl: "postgres://unused", stagingDir: "/x", witness: "  ", operator: "م",
    });
    expect(report.errors[0]).toContain("اسم الشاهد مطلوب");
  });
});
