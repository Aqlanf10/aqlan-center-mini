import { describe, expect, it } from "vitest";
import { createS3Provider, s3ObjectKeyOf } from "@/lib/backupDestinations";
import { decryptArchiveBuffer, looksEncrypted } from "@/lib/backupEncryption";
import { sha256Hex } from "@/lib/s3-client";
import type { BackupRunConfig } from "@/lib/backupConfig";

/** (P0-3) النسخ خارج المنصة — الحواجز بترتيبها، والتشفير قبل الخروج، والتحقق بعد الرفع. */

const KEY = "a".repeat(64);
const plain = Buffer.from("archive-bytes: database.sql + documents");
const archive = {
  filename: "aqlan-backup-2026-09-25T030000Z.tar.gz", sha256: sha256Hex(plain), bytes: plain.length,
  databaseSha256: "d", documentCount: 3, createdAt: "2026-09-25T03:00:00Z", localPath: "/data/backups/x.tar.gz",
};
const env = {
  BACKUP_ENCRYPTION_KEY: KEY, BACKUP_S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com", BACKUP_S3_BUCKET: "clinic",
  BACKUP_S3_ACCESS_KEY_ID: "k", BACKUP_S3_SECRET_ACCESS_KEY: "s",
};
function config(s3: boolean): { config: BackupRunConfig } {
  return { config: {
    backupEnabled: true, scheduleEnabled: true, scheduleTime: "03:00", scheduleTimeZone: "Asia/Aden",
    retentionDailyCount: 30, retentionWeeklyCount: 12, destinations: { railwayVolume: true, googleDrive: false, s3 },
  } };
}

function fakeBucket(overrideHeadBytes?: number) {
  const objects = new Map<string, { body: Buffer; headers: Record<string, string> }>();
  const fetchImpl = (async (url: URL, init: RequestInit) => {
    const key = decodeURIComponent(new URL(String(url)).pathname.replace(/^\/clinic\//, ""));
    if (init.method === "PUT") {
      objects.set(key, { body: Buffer.from(init.body as Buffer), headers: init.headers as Record<string, string> });
      return new Response(null, { status: 200 });
    }
    if (init.method === "HEAD") {
      const found = objects.get(key);
      if (!found) return new Response(null, { status: 404 });
      return new Response(null, { status: 200, headers: { "content-length": String(overrideHeadBytes ?? found.body.length) } });
    }
    return new Response(null, { status: 400 });
  }) as never;
  return { objects, fetchImpl };
}

describe("createS3Provider", () => {
  it("مطفأة في الإعدادات ⇒ skipped ولا طلب واحد", async () => {
    const bucket = fakeBucket();
    const result = await createS3Provider({ env, fetchImpl: bucket.fetchImpl, read: async () => plain }).replicate(archive, config(false));
    expect(result.status).toBe("skipped");
    expect(bucket.objects.size).toBe(0);
  });

  it("بلا مفتاح تشفير ⇒ blocked قبل أي بايت يخرج", async () => {
    const bucket = fakeBucket();
    const { BACKUP_ENCRYPTION_KEY: _unused, ...noKey } = env;
    const result = await createS3Provider({ env: noKey, fetchImpl: bucket.fetchImpl, read: async () => plain }).replicate(archive, config(true));
    expect(result.status).toBe("blocked");
    expect(bucket.objects.size).toBe(0);
  });

  it("بلا مفاتيح الحاوية ⇒ not_connected بأسماء المتغيرات لا قيمها", async () => {
    const result = await createS3Provider({ env: { BACKUP_ENCRYPTION_KEY: KEY }, read: async () => plain }).replicate(archive, config(true));
    expect(result).toMatchObject({ status: "not_connected" });
    expect(result.detail).toContain("BACKUP_S3_ENDPOINT");
  });

  it("النجاح: يُرفع مشفّرًا (لا نص صريح) بمفتاحٍ ثابت، ويُفكّ بالمفتاح إلى الأرشيف نفسه", async () => {
    const bucket = fakeBucket();
    const result = await createS3Provider({ env, fetchImpl: bucket.fetchImpl, read: async () => plain }).replicate(archive, config(true));
    expect(result).toMatchObject({ status: "success", providerFileId: s3ObjectKeyOf(archive.filename), sha256: archive.sha256 });
    const stored = bucket.objects.get(s3ObjectKeyOf(archive.filename))!;
    expect(looksEncrypted(stored.body)).toBe(true);
    expect(stored.body.includes(plain)).toBe(false);
    expect(decryptArchiveBuffer(stored.body, KEY).equals(plain)).toBe(true);
    expect(stored.headers["x-amz-meta-archive-sha256"]).toBe(archive.sha256);
    expect(stored.headers["x-amz-meta-key-fingerprint"]).toMatch(/^[0-9a-f]{16}$/);
  });

  it("حجمٌ مختلف في الحاوية بعد الرفع ⇒ failed لا نجاحٌ كاذب", async () => {
    const bucket = fakeBucket(7);
    const result = await createS3Provider({ env, fetchImpl: bucket.fetchImpl, read: async () => plain }).replicate(archive, config(true));
    expect(result.status).toBe("failed");
  });

  it("الملف على القرص تغيّر عن المُتحقق منه ⇒ failed ولا يُرفع شيء", async () => {
    const bucket = fakeBucket();
    const result = await createS3Provider({ env, fetchImpl: bucket.fetchImpl, read: async () => Buffer.from("tampered") }).replicate(archive, config(true));
    expect(result.status).toBe("failed");
    expect(bucket.objects.size).toBe(0);
  });

  it("رفضٌ من المزوّد يُعاد برسالة عربية معقّمة", async () => {
    const result = await createS3Provider({
      env, read: async () => plain, fetchImpl: (async () => new Response("<Error>AccessDenied</Error>", { status: 403 })) as never,
    }).replicate(archive, config(true));
    expect(result).toMatchObject({ status: "failed", detail: "رفض التخزين الخارجي الرفع (HTTP 403)." });
  });
});
