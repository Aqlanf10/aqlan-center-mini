import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * إعادة الضبط على PostgreSQL 18 الحقيقي: كل جدولٍ مصنَّف، والبيانات التجريبية تُمسح،
 * والإعداد يبقى، والترقيم يعود إلى ١، وسجل التدقيق يبقى ويشهد.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const { ensureSchema, getPool, resetPoolForTesting, resetClinicData, clinicResetPreview, createPatient, recordAudit } =
  await import("../../lib/db");
const { RESET_KEEP_TABLES, RESET_WIPE_TABLES } = await import("../../lib/clinic-reset");

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}
const count = async (table: string) => Number((await q<{ n: string }>(`SELECT COUNT(*)::text AS n FROM ${table}`))[0].n);

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
});
afterAll(async () => { await resetPoolForTesting(); });

describe("clinic reset", () => {
  it("classifies every table in the live schema exactly once", async () => {
    const tables = (await q<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    )).map((row) => row.table_name).sort();
    const wipe = new Set<string>(RESET_WIPE_TABLES);
    const keep = new Set<string>(RESET_KEEP_TABLES);
    expect([...wipe].filter((table) => keep.has(table))).toEqual([]);
    expect(tables.filter((table) => !wipe.has(table) && !keep.has(table))).toEqual([]);
    // كل جدولٍ يُمسح موجودٌ فعلًا — وإلا سقط TRUNCATE كله. (schema_migrations يُنشئه مشغّل الهجرات لا ensureSchema.)
    expect([...wipe].filter((table) => !tables.includes(table))).toEqual([]);
  });

  it("wipes demo data, keeps setup and the audit trail, restarts numbering, and returns the files to delete", async () => {
    // الإعداد
    await q(`INSERT INTO parties (name, kind) VALUES ('د. التجربة', 'doctor'), ('مختبر التجربة', 'lab')`);
    await q(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('owner-reset', 'المالك', 'x', 'admin')`);
    const keptBefore: Record<string, number> = {};
    for (const table of ["parties", "users", "settings", "services", "expense_categories"]) keptBefore[table] = await count(table);
    await recordAudit({ action: "patient.create", entity: "patient", entityId: 1, actor: "admin" });

    // البيانات التجريبية
    const patient = await createPatient({
      fullName: "مريض تجريبي", phone: "777000111", altPhone: null, gender: "unknown", birthYear: null,
      address: null, medicalAlert: null, note: null,
    });
    await q(`INSERT INTO appointments (patient_id, scheduled_date, scheduled_time) VALUES ($1, CURRENT_DATE + 1, '10:00')`, [patient.id]);
    await q(`INSERT INTO visits (patient_id, patient_name, status) VALUES ($1, 'مريض تجريبي', 'done')`, [patient.id]);
    const [invoice] = await q<{ id: number }>(
      `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by)
       VALUES ('INV-T1', $1, 5000, 0, 'YER', 't') RETURNING id`, [patient.id]);
    const [shift] = await q<{ id: number }>(
      `INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd, status) VALUES ('t', 0, 0, 0, 'closed') RETURNING id`);
    await q(
      `INSERT INTO payments (receipt_number, patient_id, invoice_id, shift_id, kind, amount_minor, currency, exchange_rate,
                             base_amount_minor, base_currency, method, created_by)
       VALUES ('R-T1', $1, $2, $3, 'payment', 5000, 'YER', 1, 5000, 'YER', 'cash', 't')`, [patient.id, invoice.id, shift.id]);
    await q(
      `INSERT INTO patient_documents (patient_id, kind, title, mime_type, size_bytes, sha256, storage_key, uploaded_by)
       VALUES ($1, 'xray', 'بانوراما', 'image/jpeg', 10, 'abc', 'ab/abcdef.jpg', 't')`, [patient.id]);
    await q(`SELECT nextval('invoice_number_seq'), nextval('receipt_number_seq'), nextval('voucher_number_seq')`);

    const preview = await clinicResetPreview();
    expect(preview.patients).toBe(1);
    expect(preview.payments).toBe(1);

    const result = await resetClinicData(
      { actor: "owner-reset", actorRole: "admin" },
      async () => ({ ok: true, backupId: "backup-2026-09-25" }),
    );
    if (!result.ok) throw new Error("reset should succeed");
    expect(result.backupId).toBe("backup-2026-09-25");
    expect(result.counts).toMatchObject({ patients: 1, appointments: 1, visits: 1, invoices: 1, payments: 1, patient_documents: 1 });
    expect(result.storageKeys).toEqual(["ab/abcdef.jpg"]);

    for (const table of RESET_WIPE_TABLES) expect(await count(table), table).toBe(0);
    for (const [table, n] of Object.entries(keptBefore)) expect(await count(table), table).toBe(n);

    for (const sequence of ["patient_number_seq", "invoice_number_seq", "receipt_number_seq", "voucher_number_seq"]) {
      expect(Number((await q<{ v: string }>(`SELECT nextval('${sequence}')::text AS v`))[0].v), sequence).toBe(1);
    }
    const next = await createPatient({
      fullName: "أول مريض حقيقي", phone: null, altPhone: null, gender: "unknown", birthYear: null,
      address: null, medicalAlert: null, note: null,
    });
    expect(next.id).toBe(1);

    const audit = await q<{ action: string; details: Record<string, unknown> }>(`SELECT action, details FROM audit_log ORDER BY id`);
    expect(audit.map((row) => row.action)).toEqual(["patient.create", "system.reset"]);
    expect(audit[1].details).toMatchObject({ patients: 1, payments: 1, "نسخة_قبل_المسح": "backup-2026-09-25" });
  });

  it("freezes writes from before the backup snapshot until the wipe commits — nothing slips between them", async () => {
    await createPatient({
      fullName: "قبل النسخة", phone: null, altPhone: null, gender: "unknown", birthYear: null,
      address: null, medicalAlert: null, note: null,
    });
    const before = await count("patients");
    const writer = new Client({ connectionString: process.env.DATABASE_URL!, ssl: false });
    await writer.connect();
    try {
      await writer.query("SET lock_timeout = '300ms'");
      let writeDuringBackup = "not-attempted";
      let seenByBackup = -1;
      const result = await resetClinicData({ actor: "owner-reset", actorRole: "admin" }, async (client) => {
        // النسخة تقرأ بحرية…
        seenByBackup = Number((await client.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM patients")).rows[0].n);
        // …وكتابةٌ من الاستقبال في هذه اللحظة تنتظر ولا تدخل بين النسخة والمسح.
        try {
          await writer.query(`INSERT INTO patients (patient_number, full_name) VALUES ('RACE-1', 'كُتب أثناء النسخ')`);
          writeDuringBackup = "committed";
        } catch (error) {
          writeDuringBackup = (error as { code?: string }).code ?? "error";
        }
        return { ok: true, backupId: "b-race" };
      });
      expect(result.ok).toBe(true);
      expect(seenByBackup).toBe(before);
      expect(writeDuringBackup).toBe("55P03");
      expect(await count("patients")).toBe(0);
    } finally {
      await writer.end();
    }
  });

  it("wipes nothing when the backup step fails, and releases the freeze", async () => {
    await createPatient({
      fullName: "يبقى", phone: null, altPhone: null, gender: "unknown", birthYear: null,
      address: null, medicalAlert: null, note: null,
    });
    const auditBefore = await count("audit_log");
    const result = await resetClinicData({ actor: "owner-reset", actorRole: "admin" },
      async () => ({ ok: false, failure: "backup-disabled" }));
    expect(result).toEqual({ ok: false, failure: "backup-disabled" });
    expect(await count("patients")).toBe(1);
    expect(await count("audit_log")).toBe(auditBefore);
    // لا قفل عالق: الكتابة تعود فورًا.
    await createPatient({
      fullName: "بعد الفشل", phone: null, altPhone: null, gender: "unknown", birthYear: null,
      address: null, medicalAlert: null, note: null,
    });
    expect(await count("patients")).toBe(2);
  });

  it("the real backup snapshot reads everything under the freeze (no self-deadlock)", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { productionBackupBlocksWithClient } = await import("../../lib/productionBackup");
    const { parseTarBytes } = await import("../../lib/restore/archive");
    await createPatient({
      fullName: "في النسخة", phone: null, altPhone: null, gender: "unknown", birthYear: null,
      address: null, medicalAlert: null, note: null,
    });
    const documentsDir = await mkdtemp(path.join(tmpdir(), "aqlan-reset-docs-"));
    let sql = "";
    try {
      const result = await resetClinicData({ actor: "owner-reset", actorRole: "admin" }, async (client) => {
        const chunks: Buffer[] = [];
        for await (const chunk of productionBackupBlocksWithClient(client, { documentsDir })) chunks.push(Buffer.from(chunk));
        sql = Buffer.from(parseTarBytes(Buffer.concat(chunks)).entries.get("database.sql")!.data).toString("utf8");
        return { ok: true, backupId: "b-real" };
      });
      expect(result.ok).toBe(true);
      expect(sql).toContain("في النسخة");
      expect(await count("patients")).toBe(0);
    } finally {
      await rm(documentsDir, { recursive: true, force: true });
    }
  });
});
