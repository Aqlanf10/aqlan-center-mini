import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { tarBytes } from "./helpers/backup-tar";
import { parseTarBytes, documentEntryName, safeTarName } from "../lib/restore/archive";
import { validateBackupArchive, parseManifest } from "../lib/restore/validate";
import { tarEnd, tarHeader, tarPadding } from "../lib/tar";

/**
 * اختبارات التحقق الكامل من الأرشيف قبل أي استعادة (P1.12) — عشرة تحققات،
 * وكل فشل فيها يعني: لم تُلمس قاعدة هدف أصلًا.
 */

function storageKeyOf(content: string): string {
  const hash = createHash("sha256").update(content).digest("hex");
  return `${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}.png`;
}

function buildValidArchive() {
  const sql = "BEGIN;\nINSERT INTO patients (id) VALUES (1);\nCOMMIT;\n";
  const sqlSha = createHash("sha256").update(sql).digest("hex");
  const doc1Content = "PNG-DATA-1";
  const doc2Content = "PDF-DATA-2-LONGER";
  const key1 = storageKeyOf(doc1Content);
  const key2 = storageKeyOf(doc2Content);
  const manifest = {
    format: "aqlan-full-backup",
    version: 1,
    createdAt: new Date().toISOString(),
    databaseSha256: sqlSha,
    documents: [
      { id: 1, storageKey: key1, sha256: createHash("sha256").update(doc1Content).digest("hex"), sizeBytes: doc1Content.length, title: "أشعة", patientId: 1 },
      { id: 2, storageKey: key2, sha256: createHash("sha256").update(doc2Content).digest("hex"), sizeBytes: doc2Content.length, title: "تقرير", patientId: 2 },
    ],
  };
  const entries = [
    { name: "database.sql", data: Buffer.from(sql, "utf8") },
    { name: `documents/${safeTarName(key1)}`, data: Buffer.from(doc1Content, "utf8") },
    { name: `documents/${safeTarName(key2)}`, data: Buffer.from(doc2Content, "utf8") },
    { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest), "utf8") },
  ];
  return { tar: tarBytes(entries), manifest, sql, key1, key2, doc1Content, doc2Content };
}

const DOCS_DIR = "/data/documents";

describe("أرشيف النسخة الكاملة — التحقق قبل أي لمس", () => {
  it("أرشيف سليم ⇒ يمر كاملًا ويعيد SQL والمستندات ومساراتها", () => {
    const { tar } = buildValidArchive();
    const parsed = parseTarBytes(tar);
    const result = validateBackupArchive(parsed, { documentsDir: DOCS_DIR });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Buffer.from(result.sql).toString("utf8")).toContain("COMMIT;");
      expect(result.documents).toHaveLength(2);
      expect(result.documents[0].relativePath).toMatch(/^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}\.png$/);
      expect(result.manifest.format).toBe("aqlan-full-backup");
    }
  });

  it("أرشيف مبتر (حجم مدخل أكبر من الموجود) ⇒ رفض فوري", () => {
    const { tar } = buildValidArchive();
    const truncated = tar.subarray(0, tar.length - 700); // بتر قبل النهاية
    const result = validateBackupArchive(parseTarBytes(truncated), { documentsDir: DOCS_DIR });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toMatch(/مبتر|ناقص|غير موجود/);
  });

  it("بلا manifest.json (تنزيل مقطوع) ⇒ لا استعادة قاعدة أصلًا", () => {
    const { tar, key1, key2 } = buildValidArchive();
    const entries = [
      { name: "database.sql", data: Buffer.from("BEGIN;\nSELECT 1;\nCOMMIT;\n") },
    ];
    void key1; void key2;
    const result = validateBackupArchive(parseTarBytes(tarBytes(entries)), { documentsDir: DOCS_DIR });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toMatch(/manifest/);
  });

  it("manifest ليس آخر مدخل ⇒ رفض (ترتيب الكاتب شهادة اكتمال)", () => {
    const { tar, key1 } = buildValidArchive();
    void key1;
    // أعد الترتيب: manifest قبل مستند
    const parsed = parseTarBytes(tar);
    const manifestEntry = parsed.entries.get("manifest.json")!;
    const docEntry = [...parsed.entries.values()].find((e) => e.name.startsWith("documents/"))!;
    const rebuilt = tarBytes([
      { name: "database.sql", data: Buffer.from(parsed.entries.get("database.sql")!.data) },
      { name: manifestEntry.name, data: Buffer.from(manifestEntry.data) },
      { name: docEntry.name, data: Buffer.from(docEntry.data) },
    ]);
    const result = validateBackupArchive(parseTarBytes(rebuilt), { documentsDir: DOCS_DIR });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toMatch(/آخر مدخل/);
  });

  it("بصمة SQL لا تطابق ⇒ رفض قبل أي لمس للقاعدة", () => {
    const { manifest, key1, key2, doc1Content, doc2Content } = buildValidArchive();
    const tamperedSql = "BEGIN;\nINSERT INTO patients (id) VALUES (999);\nCOMMIT;\n";
    const entries = [
      { name: "database.sql", data: Buffer.from(tamperedSql, "utf8") },
      { name: `documents/${safeTarName(key1)}`, data: Buffer.from(doc1Content) },
      { name: `documents/${safeTarName(key2)}`, data: Buffer.from(doc2Content) },
      { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest)) },
    ];
    const result = validateBackupArchive(parseTarBytes(tarBytes(entries)), { documentsDir: DOCS_DIR });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toMatch(/بصمة ملف البيانات/);
  });

  it("مستند واحد تالف البصمة ⇒ الأرشيف كله يُرفض (لا استعادة جزئية)", () => {
    const { manifest, key1, key2, sql, doc1Content } = buildValidArchive();
    const corruptedDoc2 = "TAMPERED-SAME-17!"; // نفس الطول (17): البصمة وحدها هي الكاشف
    const entries = [
      { name: "database.sql", data: Buffer.from(sql, "utf8") },
      { name: `documents/${safeTarName(key1)}`, data: Buffer.from(doc1Content) },
      { name: `documents/${safeTarName(key2)}`, data: Buffer.from(corruptedDoc2) },
      { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest)) },
    ];
    const result = validateBackupArchive(parseTarBytes(tarBytes(entries)), { documentsDir: DOCS_DIR });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toMatch(/بصمة مستند/);
  });

  it("حجم مستند مخالف ⇒ رفض", () => {
    const { manifest, key1, key2, sql, doc1Content, doc2Content } = buildValidArchive();
    const entries = [
      { name: "database.sql", data: Buffer.from(sql, "utf8") },
      { name: `documents/${safeTarName(key1)}`, data: Buffer.from(doc1Content + "EXTRA") },
      { name: `documents/${safeTarName(key2)}`, data: Buffer.from(doc2Content) },
      { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest)) },
    ];
    const result = validateBackupArchive(parseTarBytes(tarBytes(entries)), { documentsDir: DOCS_DIR });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toMatch(/حجم مستند/);
  });

  it("مستند مفقود من الأرشيف مذكور في المفتاح ⇒ رفض", () => {
    const { manifest, key1, sql, doc1Content } = buildValidArchive();
    const entries = [
      { name: "database.sql", data: Buffer.from(sql, "utf8") },
      { name: `documents/${safeTarName(key1)}`, data: Buffer.from(doc1Content) },
      { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest)) },
    ];
    const result = validateBackupArchive(parseTarBytes(tarBytes(entries)), { documentsDir: DOCS_DIR });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toMatch(/مستند مفقود/);
  });

  it("path traversal في مفتاح تخزين بالمفتاح ⇒ رفض", () => {
    const sql = "BEGIN;\nSELECT 1;\nCOMMIT;\n";
    const content = "X";
    const evilKey = "../../etc/passwd";
    const manifest = {
      format: "aqlan-full-backup", version: 1, createdAt: new Date().toISOString(),
      databaseSha256: createHash("sha256").update(sql).digest("hex"),
      documents: [{ id: 1, storageKey: evilKey, sha256: createHash("sha256").update(content).digest("hex"), sizeBytes: 1, title: "x", patientId: 1 }],
    };
    const entries = [
      { name: "database.sql", data: Buffer.from(sql) },
      { name: `documents/${safeTarName(evilKey)}`, data: Buffer.from(content) },
      { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest)) },
    ];
    const result = validateBackupArchive(parseTarBytes(tarBytes(entries)), { documentsDir: DOCS_DIR });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toMatch(/غير آمن|يخرج/);
  });

  it("مفاتيح مختلفة نصيًّا تتحل إلى نفس الوجهة ⇒ وجهة مكررة مكتشفة", () => {
    const sql = "BEGIN;\nSELECT 1;\nCOMMIT;\n";
    const content = "X";
    const keyA = "ab/cd/".padEnd(70, "0") + ".png";
    const keyB = "ab\\cd\\" + "0".repeat(70 - 6) + ".png"; // فواصل مختلفة، نفس الحل
    const sha = createHash("sha256").update(content).digest("hex");
    const manifest = {
      format: "aqlan-full-backup", version: 1, createdAt: new Date().toISOString(),
      databaseSha256: createHash("sha256").update(sql).digest("hex"),
      documents: [
        { id: 1, storageKey: keyA, sha256: sha, sizeBytes: 1, title: "a", patientId: 1 },
        { id: 2, storageKey: keyB, sha256: sha, sizeBytes: 1, title: "b", patientId: 2 },
      ],
    };
    const entries = [
      { name: "database.sql", data: Buffer.from(sql) },
      { name: `documents/${safeTarName(keyA)}`, data: Buffer.from(content) },
      { name: `documents/${safeTarName(keyB)}`, data: Buffer.from(content) },
      { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest)) },
    ];
    const result = validateBackupArchive(parseTarBytes(tarBytes(entries)), { documentsDir: DOCS_DIR });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toMatch(/مكررة|غير آمن/);
  });

  it("manifest بصيغة مجهولة أو JSON مكسور ⇒ رفض", () => {
    const sql = "BEGIN;\nSELECT 1;\nCOMMIT;\n";
    const entries = [
      { name: "database.sql", data: Buffer.from(sql) },
      { name: "manifest.json", data: Buffer.from("{not-json") },
    ];
    const result = validateBackupArchive(parseTarBytes(tarBytes(entries)), { documentsDir: DOCS_DIR });
    expect(result.ok).toBe(false);

    const entries2 = [
      { name: "database.sql", data: Buffer.from(sql) },
      { name: "manifest.json", data: Buffer.from(JSON.stringify({ format: "unknown", version: 9, documents: [] })) },
    ];
    const result2 = validateBackupArchive(parseTarBytes(tarBytes(entries2)), { documentsDir: DOCS_DIR });
    expect(result2.ok).toBe(false);
    if (!result2.ok) {
      expect(result2.errors.join()).toMatch(/صيغة|إصدار/);
    }
  });

  it("SQL بلا خاتمة COMMIT (لقطة غير مكتملة) ⇒ رفض", () => {
    const sql = "BEGIN;\nINSERT INTO patients (id) VALUES (1);\n"; // بلا COMMIT
    const manifest = {
      format: "aqlan-full-backup", version: 1, createdAt: new Date().toISOString(),
      databaseSha256: createHash("sha256").update(sql).digest("hex"),
      documents: [],
    };
    const entries = [
      { name: "database.sql", data: Buffer.from(sql) },
      { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest)) },
    ];
    const result = validateBackupArchive(parseTarBytes(tarBytes(entries)), { documentsDir: DOCS_DIR });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toMatch(/COMMIT/);
  });

  it("parseManifest يرفض المفاتيح المكررة والبصمات غير الصالحة", () => {
    const bad = parseManifest({
      format: "aqlan-full-backup", version: 1, createdAt: "2026-01-01T00:00:00Z",
      databaseSha256: "not-a-hash",
      documents: [
        { id: 1, storageKey: "a/b/c.png", sha256: "zz", sizeBytes: -5, title: "x", patientId: 1 },
        { id: 2, storageKey: "a/b/c.png", sha256: "zz", sizeBytes: 1, title: "y", patientId: 1 },
      ],
    });
    expect("errors" in bad).toBe(true);
    if ("errors" in bad) expect(bad.errors.length).toBeGreaterThanOrEqual(3);
  });

  it("اسم مدخل المستند يطابق الكاتب (documentEntryName = documents/<safeTarName>)", () => {
    expect(documentEntryName("ab/cd/hash.png")).toBe("documents/ab_cd_hash.png");
    expect(safeTarName("a/b/c")).toBe("a_b_c");
    expect(safeTarName(".hidden")).toBe("d.hidden");
  });

  it("tarEnd/tarHeader من lib/tar تُنتج بنية صالحة للقارئ (توافق كاتب-قارئ)", () => {
    const content = Buffer.from("hello");
    const chunks: Uint8Array[] = [
      tarHeader("x.txt", content.length, new Date()),
      content,
      tarPadding(content.length),
      tarEnd(),
    ];
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const tar = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { tar.set(chunk, offset); offset += chunk.length; }
    const parsed = parseTarBytes(tar);
    expect(parsed.truncated).toBe(false);
    expect(Buffer.from(parsed.entries.get("x.txt")!.data).toString("utf8")).toBe("hello");
  });
});
