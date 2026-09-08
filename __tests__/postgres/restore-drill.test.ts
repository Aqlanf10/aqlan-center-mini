import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { createGzip } from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Client } from "pg";
import { assertRealPostgresUrl, createIsolatedDatabase, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * تدريب الاستعادة الكامل على بيئة معزولة (P1.14) — الرحلة:
 *
 *   إنشاء بيانات معروفة (مريض/موعد/فاتورة/دفعة/ردّ/وصفة/مخزون/مستند)
 *   → إنشاء نسخة احتياطية كاملة (SQL + مستندات + manifest + SHA256)
 *   → تدمير الهدف المعزول (قاعدة معزولة مستقلة — ليس الإنتاج)
 *   → استعادة عبر stagedRestore (تحقق كامل ثم استعادة)
 *   → التحقق: العدّادات، العملات، علاقات الردّ، WAC، العدّادات التسلسلية،
 *     عدد المستندات وبصماتها.
 *
 * ممنوع بحكم التصميم: أي لمس لقاعدة الإنتاج — الهدف قاعدة معزولة تُنشأ وتُدمَّر
 * داخل الاختبار نفسه.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const sourceDocsDir = await mkdtemp(path.join(tmpdir(), "aqlan-drill-docs-"));
vi.stubEnv("DOCUMENTS_DIR", sourceDocsDir);

const { fullBackupBlocks } = await import("../../lib/fullBackup");
const { putFile } = await import("../../lib/files");
const {
  getPool, resetPoolForTesting, ensureSchema, openShift, recordPayment,
  createInventoryMovement, recordDocument, listInventoryMovements,
} = await import("../../lib/db");
const { costNow } = await import("../../lib/inventoryCost");

const DRILL_DB = `aqlan_p1_drill_${Date.now().toString(36)}`;
let archivePath: string;
let targetUrl: string;
let stagingDir: string;

interface Dataset {
  patientId: number;
  invoiceId: number;
  paymentId: number;
  refundId: number;
  prescriptionId: number;
  appointmentId: number;
  inventoryItemId: number;
  documentId: number;
  documentKey: string;
  documentSha: string;
  documentBytes: Buffer;
  wacBefore: { qty: number; valueMinor: number; unitCostMinor: number | null };
}

let dataset: Dataset;

beforeAll(async () => {
  // ── المصدر: قاعدة الاختبار الرئيسية بمخطط نظيف وبيانات معروفة
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  await openShift({ openedBy: "drill", opening: { YER: 0, SAR: 0, USD: 0 } });
  const pool = getPool();

  const { rows: [patient] } = await pool.query(
    `INSERT INTO patients (patient_number, full_name) VALUES ('DRILL-1', 'مريض التدريب') RETURNING id`,
  );
  const { rows: [appointment] } = await pool.query(
    `INSERT INTO appointments (patient_id, scheduled_date, scheduled_time, appointment_type)
     VALUES ($1, CURRENT_DATE + 1, '10:00', 'متابعة') RETURNING id`, [patient.id],
  );
  const { rows: [invoice] } = await pool.query(
    `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency)
     VALUES ('DRILL-INV', $1, 60000, 5000, 'YER') RETURNING id`, [patient.id],
  );
  await pool.query(
    `INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price_minor, total_minor)
     VALUES ($1, NULL, 'تنظيف', 2, 30000, 60000)`, [invoice.id],
  );
  const paid = await recordPayment({
    patientId: patient.id, invoiceId: invoice.id, kind: "payment", amountMinor: 50000,
    currency: "SAR", baseCurrency: "YER", exchangeRate: 660, method: "cash",
    note: null, createdBy: "drill", idempotencyKey: "drill-payment-0001",
  });
  expect(paid.payment).not.toBeNull();
  const refunded = await recordPayment({
    patientId: patient.id, invoiceId: null, kind: "refund", amountMinor: 10000,
    currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash",
    note: "رد جزئي", createdBy: "drill", reversalOfId: paid.payment!.id,
  });
  expect(refunded.payment).not.toBeNull();

  const { rows: [prescription] } = await pool.query(
    `INSERT INTO prescriptions (patient_id, diagnosis, items, created_by)
     VALUES ($1, 'تسوس', $2::jsonb, 'drill') RETURNING id`,
    [patient.id, JSON.stringify([{ drug: "أموكسيسيلين", dose: "500mg" }])],
  );

  const { rows: [item] } = await pool.query(
    `INSERT INTO inventory_items (name, unit, is_active, created_by)
     VALUES ('قفازات DRILL', 'صندوق', TRUE, 'drill') RETURNING id`,
  );
  await createInventoryMovement({ itemId: item.id, kind: "in", qty: 50, unitCostMinor: 1200, createdBy: "drill" });
  await createInventoryMovement({ itemId: item.id, kind: "out", qty: 7, createdBy: "drill" });
  const movements = (await listInventoryMovements(item.id, 100))
    .slice().sort((a, b) => a.id - b.id)
    .map((movement) => ({
      id: movement.id, kind: movement.kind, qty: movement.qty,
      unitCostMinor: movement.unitCostMinor, isReturn: movement.isReturn,
    }));

  // مستند حقيقي على القرص (putFile) مع صفّه في القاعدة
  const documentBytes = Buffer.from("DRILL-XRAY-BINARY-CONTENT-12345", "utf8");
  const stored = await putFile(documentBytes, "png");
  const document = await recordDocument({
    patientId: patient.id, visitId: null, kind: "xray" as never, title: "أشعة تدريب",
    mimeType: "image/png", sizeBytes: stored.sizeBytes, sha256: stored.sha256,
    storageKey: stored.key, note: null, takenOn: null, uploadedBy: "drill",
  });

  dataset = {
    patientId: patient.id,
    invoiceId: invoice.id,
    paymentId: paid.payment!.id,
    refundId: refunded.payment!.id,
    prescriptionId: prescription.id,
    appointmentId: appointment.id,
    inventoryItemId: item.id,
    documentId: document.id,
    documentKey: stored.key,
    documentSha: stored.sha256,
    documentBytes,
    wacBefore: costNow(movements),
  };
  expect(dataset.wacBefore.qty).toBe(43); // 50 داخل - 7 خارج

  // ── النسخة الاحتياطية الكاملة (تدفق fullBackup الحقيقي + gzip كما في مسار API)
  archivePath = path.join(await mkdtemp(path.join(tmpdir(), "aqlan-drill-archive-")), "backup.tar.gz");
  await pipeline(
    Readable.from(fullBackupBlocks()),
    createGzip(),
    createWriteStream(archivePath),
  );

  // ── الهدف: قاعدة معزولة تُنشأ الآن وتُدمَّر عند انتهاء الاختبار
  targetUrl = await createIsolatedDatabase(DRILL_DB);
  stagingDir = await mkdtemp(path.join(tmpdir(), "aqlan-drill-staging-"));
}, 300_000);

afterAll(async () => {
  // تنظيف: قاعدة التدريب تُدمَّر (بيئة اختبار فقط) والpool يعاد
  try {
    const admin = new Client({ connectionString: process.env.DATABASE_URL!.replace(/\/[^/]+$/, "/postgres"), ssl: false });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DRILL_DB} WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  } catch {}
  await rm(sourceDocsDir, { recursive: true, force: true }).catch(() => {});
  await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  await resetPoolForTesting();
});

describe("تدريب الاستعادة الكامل (قاعدة معزولة + دليل مستندات معزول)", () => {
  it("الاستعادة تنجح وتنتج READY FOR CUTOVER", async () => {
    const { stagedRestore } = await import("../../lib/restore/staging");
    const result = await stagedRestore({
      archivePath, targetUrl, stagingDir,
    });
    expect(result.validationErrors).toEqual([]);
    if (!result.ok) console.error("STAGED RESTORE ERRORS:", JSON.stringify(result.errors, null, 2));
    expect(result.ok).toBe(true);
    expect(result.readyForCutover).toBe(true);
    expect(result.documentsRestored).toBe(1);
    expect(result.documentsVerified).toBe(1);
    expect(result.verification.criticalProbeOk).toBe(true);
    expect(result.verification.migrationConsistent).toBe(true);
    expect(result.cutoverSteps.length).toBeGreaterThan(3);
  });

  it("عدد المرضى والمواعيد والفواتير مطابق للمصدر", async () => {
    const client = new Client({ connectionString: targetUrl, ssl: false });
    await client.connect();
    try {
      const counts = async (table: string) =>
        Number((await client.query<{ n: string }>(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n);
      expect(await counts("patients")).toBe(1);
      expect(await counts("appointments")).toBe(1);
      expect(await counts("invoices")).toBe(1);
      expect(await counts("invoice_items")).toBe(1);
      expect(await counts("prescriptions")).toBe(1);
      expect(await counts("patient_documents")).toBe(1);
      expect(await counts("cashier_shifts")).toBe(1);
    } finally {
      await client.end();
    }
  });

  it("الأحداث المالية والعملات وعلاقة الردّ سليمة", async () => {
    const client = new Client({ connectionString: targetUrl, ssl: false });
    await client.connect();
    try {
      const { rows: [payment] } = await client.query(
        `SELECT amount_minor, currency, exchange_rate, base_amount_minor, idempotency_key FROM payments WHERE id = $1`,
        [dataset.paymentId],
      );
      expect(Number(payment.amount_minor)).toBe(50000);
      expect(payment.currency).toBe("SAR");
      expect(Number(payment.exchange_rate)).toBe(660);
      expect(Number(payment.base_amount_minor)).toBe(330000); // 50 SAR × 660
      expect(payment.idempotency_key).toBe("drill-payment-0001");

      const { rows: [refund] } = await client.query(
        `SELECT kind, reversal_of_id, amount_minor, currency FROM payments WHERE id = $1`,
        [dataset.refundId],
      );
      expect(refund.kind).toBe("refund");
      expect(Number(refund.reversal_of_id)).toBe(dataset.paymentId); // علاقة الردّ بقيت
      expect(refund.currency).toBe("YER");

      // المفتاح idempotency ظل فريدًا عبر الاستعادة
      const { rows: [dup] } = await client.query(
        `SELECT COUNT(*)::int AS n FROM payments WHERE idempotency_key = 'drill-payment-0001'`,
      );
      expect(dup.n).toBe(1);
    } finally {
      await client.end();
    }
  });

  it("WAC والمخزون: نفس الكمية والقيمة والمتوسط قبل الاستعادة", async () => {
    const client = new Client({ connectionString: targetUrl, ssl: false });
    await client.connect();
    try {
      const { rows } = await client.query(
        `SELECT kind, qty, unit_cost_minor, is_return FROM inventory_movements
          WHERE item_id = $1 ORDER BY id`, [dataset.inventoryItemId],
      );
      const movements = rows.map((row) => ({
        id: 0, kind: row.kind, qty: Number(row.qty),
        unitCostMinor: row.unit_cost_minor === null ? null : Number(row.unit_cost_minor),
        isReturn: Boolean(row.is_return),
      }));
      const wacAfter = costNow(movements);
      expect(wacAfter.qty).toBe(dataset.wacBefore.qty);
      expect(wacAfter.valueMinor).toBe(dataset.wacBefore.valueMinor);
      expect(wacAfter.unitCostMinor).toBe(dataset.wacBefore.unitCostMinor);
    } finally {
      await client.end();
    }
  });

  it("العدّادات التسلسلية: إدخال جديد بعد الاستعادة لا يصطدم", async () => {
    const client = new Client({ connectionString: targetUrl, ssl: false });
    await client.connect();
    try {
      const { rows: [maxBefore] } = await client.query(`SELECT MAX(id) AS m FROM patients`);
      const { rows: [inserted] } = await client.query(
        `INSERT INTO patients (patient_number, full_name) VALUES ('DRILL-AFTER', 'مريض بعد الاستعادة') RETURNING id`,
      );
      expect(inserted.id).toBeGreaterThan(Number(maxBefore.m)); // العدّاد تجاوز الأقصى
      // والوصفة الجديدة كذلك (SERIAL مستعاد بsequence reset)
      const { rows: [maxRx] } = await client.query(`SELECT MAX(id) AS m FROM prescriptions`);
      const { rows: [newRx] } = await client.query(
        `INSERT INTO prescriptions (patient_id, items, created_by) VALUES ($1, '[]'::jsonb, 'drill') RETURNING id`,
        [dataset.patientId],
      );
      expect(newRx.id).toBeGreaterThan(Number(maxRx.m));
    } finally {
      await client.end();
    }
  });

  it("المستند: موجود في staging وبصمته ومقاسه مطابقان تمامًا", async () => {
    const restored = await readFile(path.join(stagingDir, dataset.documentKey));
    expect(restored.length).toBe(dataset.documentBytes.length);
    expect(createHash("sha256").update(restored).digest("hex")).toBe(dataset.documentSha);
    expect(restored.equals(dataset.documentBytes)).toBe(true);
  });

  it("الهدف غير الفارغ يُرفض افتراضيًا (بلا allowNonEmptyTarget)", async () => {
    const { stagedRestore } = await import("../../lib/restore/staging");
    const result = await stagedRestore({ archivePath, targetUrl, stagingDir });
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toMatch(/ليس فارغًا/);
    // وبالعادة الصريحة يعمل (استعادة فوق استعادة — القيود ستكشف الاصطدام إن وقع)
    const explicit = await stagedRestore({ archivePath, targetUrl, stagingDir, allowNonEmptyTarget: true });
    // الاصطدام بمفاتيح مكررة يُرفض من القاعدة — لا استعادة صامتة فوق بيانات
    expect(explicit.ok).toBe(false);
    expect(explicit.errors.join()).toMatch(/مفتاح|duplicate|يتكرر|اصطدام/i);
  });

  it("أرشيف فاسد البصمة ⇒ لا استعادة قاعدة أصلًا (P1.12 على أرض الواقع)", async () => {
    // انسخ الأرشيف وأفسد بايتًا داخل ملف SQL (وليس الرأس)
    const corruptPath = archivePath.replace(/\.tar\.gz$/, ".corrupt.tar.gz");
    const bytes = await readFile(archivePath);
    const corrupted = Buffer.from(bytes);
    corrupted[corrupted.length - 1200] = (corrupted[corrupted.length - 1200] + 1) % 256;
    await writeFile(corruptPath, corrupted);

    const freshDb = await createIsolatedDatabase(`${DRILL_DB}_corrupt`);
    const { stagedRestore } = await import("../../lib/restore/staging");
    const result = await stagedRestore({
      archivePath: corruptPath, targetUrl: freshDb, stagingDir: stagingDir + "-corrupt",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toMatch(/بصمة|تالف|مبتر/);

    // والقاعدة الهدف لم تُمس: لا جداول أنشئت
    const client = new Client({ connectionString: freshDb, ssl: false });
    await client.connect();
    try {
      const { rows } = await client.query(
        `SELECT COUNT(*)::int AS n FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
      );
      expect(rows[0].n).toBe(0); // لم تُنشأ حتى جداول الهجرات — لا لمس قبل التحقق
    } finally {
      await client.end();
      const admin = new Client({ connectionString: process.env.DATABASE_URL!.replace(/\/[^/]+$/, "/postgres"), ssl: false });
      await admin.connect();
      await admin.query(`DROP DATABASE IF EXISTS ${DRILL_DB}_corrupt WITH (FORCE)`).catch(() => {});
      await admin.end().catch(() => {});
    }
    await rm(corruptPath, { force: true }).catch(() => {});
  });
});
