import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runOffsiteRestoreDrill } from "@/lib/backup-offsite-drill";
import type { S3Client } from "@/lib/s3-client";

/**
 * (P0-3 — مراجعة) تجربة الاستعادة لا تكتب في مجلد المستندات الحيّ.
 *
 * العيب: الأداة كانت تأخذ دليل الـstaging من DOCUMENTS_DIR — وفي بيئة الإنتاج هو
 * مخزن المستندات الحقيقي، فتُكتب فوقه ملفات النسخة ولو كانت القاعدة معزولة.
 */

let root = "";
const untouchable = new Proxy({}, {
  get: () => () => { throw new Error("لا يجوز لمس الحاوية قبل التحقق من دليل التجربة"); },
}) as unknown as S3Client;

function drill(stagingDir: string, env: Record<string, string>) {
  return runOffsiteRestoreDrill({
    client: untouchable, keyHex: "a".repeat(64), targetUrl: "postgres://unused", stagingDir,
    witness: "الشاهد", operator: "المنفّذ", env,
  });
}

beforeAll(async () => { root = await mkdtemp(path.join(tmpdir(), "drill-guard-")); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe("runOffsiteRestoreDrill staging guard", () => {
  it("refuses the live documents directory itself, or anything inside it, before touching the bucket", async () => {
    const live = path.join(root, "documents");
    await mkdir(live, { recursive: true });
    for (const stagingDir of [live, path.join(live, "drill")]) {
      const report = await drill(stagingDir, { DOCUMENTS_DIR: live });
      expect(report.ok).toBe(false);
      expect(report.errors.join(" ")).toContain("مجلد المستندات الحيّ");
      expect(report.restore).toBeNull();
    }
  });

  it("refuses a directory that contains the live documents, and a non-empty staging directory", async () => {
    const live = path.join(root, "vol", "documents");
    await mkdir(live, { recursive: true });
    expect((await drill(path.join(root, "vol"), { DOCUMENTS_DIR: live })).errors.join(" ")).toContain("مجلد المستندات الحيّ");

    const used = path.join(root, "used");
    await mkdir(used, { recursive: true });
    await writeFile(path.join(used, "x.jpg"), "x");
    const report = await drill(used, {});
    expect(report.ok).toBe(false);
    expect(report.errors.join(" ")).toContain("فارغ");
  });
});
