import { createHash } from "node:crypto";
import { tarEnd, tarHeader, tarPadding } from "../../lib/tar";
import { safeTarName } from "../../lib/restore/archive";

/**
 * بناء أرشيفات نسخٍ صالحة/تالفة للاختبار — نفس صيغة كاتب lib/fullBackup الحقيقي
 * (tar خام؛ الضغط يجري في المحرك نفسه)، وبنفس أسماء المداخل (safeTarName).
 */

export interface TarTestEntry {
  name: string;
  data: Buffer | Uint8Array;
}

export function storageKeyOf(content: string): string {
  const hash = createHash("sha256").update(content).digest("hex");
  return `${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}.png`;
}

export function sha256Of(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export interface BackupTestDocument {
  id: number;
  storageKey: string;
  content: string;
  title?: string;
}

/** مداخل أرشيف سليم البنية: SQL مع COMMIT + مستندات + manifest أخيرًا. */
export function validBackupEntries(options: {
  sql?: string;
  documents?: BackupTestDocument[];
  manifestOverride?: Record<string, unknown>;
  dropEntry?: string;
  duplicateEntry?: string;
} = {}): { entries: TarTestEntry[]; sql: string; documents: BackupTestDocument[]; manifest: Record<string, unknown> } {
  const sql = options.sql ?? "BEGIN;\n-- لقطة اختبار\nCOMMIT;\n";
  const documents = options.documents ?? [
    { id: 1, storageKey: storageKeyOf("PNG-DATA-ONE"), content: "PNG-DATA-ONE", title: "أشعة أ" },
    { id: 2, storageKey: storageKeyOf("PDF-DATA-TWO-LONGER"), content: "PDF-DATA-TWO-LONGER", title: "تقرير ب" },
  ];
  const manifest = options.manifestOverride ?? {
    format: "aqlan-full-backup",
    version: 1,
    createdAt: new Date().toISOString(),
    databaseSha256: sha256Of(sql),
    documentCount: documents.length,
    documentsBytes: documents.reduce((total, doc) => total + doc.content.length, 0),
    documents: documents.map((doc) => ({
      id: doc.id,
      storageKey: doc.storageKey,
      sha256: sha256Of(doc.content),
      sizeBytes: doc.content.length,
      title: doc.title ?? "",
      patientId: doc.id,
      removedAt: null,
    })),
  };

  const entries: TarTestEntry[] = [];
  if (options.dropEntry !== "database.sql") {
    entries.push({ name: "database.sql", data: Buffer.from(sql, "utf8") });
  }
  for (const doc of documents) {
    entries.push({ name: `documents/${safeTarName(doc.storageKey)}`, data: Buffer.from(doc.content, "utf8") });
  }
  if (options.dropEntry !== "manifest.json") {
    entries.push({ name: "manifest.json", data: Buffer.from(JSON.stringify(manifest), "utf8") });
  }
  if (options.duplicateEntry) {
    entries.push({ name: options.duplicateEntry, data: Buffer.from("duplicate", "utf8") });
  }
  return { entries, sql, documents, manifest };
}

/** مولّد كتل من مداخل — يُمرَّر للمحرك/البوابة كحقن. mtime قابل للتثبيت للحتمية. */
export function blocksFromEntries(entries: TarTestEntry[], modified: Date = new Date()): () => AsyncGenerator<Uint8Array> {
  return async function* () {
    for (const entry of entries) {
      yield tarHeader(entry.name, entry.data.length, modified);
      yield entry.data as Uint8Array;
      yield tarPadding(entry.data.length);
    }
    yield tarEnd();
  };
}

export function validBlocksFactory(options?: Parameters<typeof validBackupEntries>[0]): {
  blocks: () => AsyncGenerator<Uint8Array>;
  sql: string;
  documents: BackupTestDocument[];
} {
  const built = validBackupEntries(options);
  return { blocks: blocksFromEntries(built.entries), sql: built.sql, documents: built.documents };
}
