import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * إعادة الضبط على PostgreSQL 18 الحقيقي: كل جدولٍ مصنَّف، والبيانات التجريبية تُمسح،
 * والإعداد يبقى، وترقيم المرضى لا يعود للخلف، وسجل التدقيق يبقى ويشهد.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const { ensureSchema, getPool, resetPoolForTesting, resetClinicData, clinicResetPreview, createPatient, recordAudit } =
  await import("../../lib/db");
const { ProtectedPatientNumberHistoryError, RESET_KEEP_TABLES, RESET_WIPE_TABLES } = await import("../../lib/clinic-reset");

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}
const count = async (table: string) => Number((await q<{ n: string }>(`SELECT COUNT(*)::text AS n FROM ${table}`))[0].n);

beforeEach(async () => {
  await resetPoolForTesting();
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

  it("wipes nonpatient demo data, keeps setup/audit and patient high-water while restarting other document counters", async () => {
    // الإعداد
    await q(`INSERT INTO parties (name, kind) VALUES ('د. التجربة', 'doctor'), ('مختبر التجربة', 'lab')`);
    await q(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('owner-reset', 'المالك', 'x', 'admin')`);
    const keptBefore: Record<string, number> = {};
    for (const table of ["parties", "users", "settings", "services", "expense_categories"]) keptBefore[table] = await count(table);
    await recordAudit({ action: "patient.create", entity: "patient", entityId: 1, actor: "admin" });

    // Nonpatient demo data may be wiped; issued patient identities may never be erased.
    await q(`INSERT INTO booking_requests(full_name,phone) VALUES ('طلب تجريبي','777000111')`);
    await q(`INSERT INTO cashier_shifts(opened_by,opening_yer,opening_sar,opening_usd,status) VALUES ('t',0,0,0,'closed')`);
    await q(`SELECT setval('patient_number_seq',8123,true), nextval('invoice_number_seq'), nextval('receipt_number_seq'), nextval('voucher_number_seq')`);
    const sequenceBefore = await q(`SELECT last_value,is_called FROM patient_number_seq`);

    const preview = await clinicResetPreview();
    expect(preview.patients).toBe(0);
    expect(preview.cashier_shifts).toBe(1);

    const result = await resetClinicData(
      { actor: "owner-reset", actorRole: "admin" },
      async () => ({ ok: true, backupId: "backup-2026-09-25" }),
    );
    if (!result.ok) throw new Error("reset should succeed");
    expect(result.backupId).toBe("backup-2026-09-25");
    expect(result.counts).toMatchObject({ patients: 0, booking_requests: 1, cashier_shifts: 1 });
    expect(result.storageKeys).toEqual([]);
    expect(await q(`SELECT last_value,is_called FROM patient_number_seq`)).toEqual(sequenceBefore);

    for (const table of RESET_WIPE_TABLES) expect(await count(table), table).toBe(0);
    for (const [table, n] of Object.entries(keptBefore)) expect(await count(table), table).toBe(n);

    for (const sequence of ["invoice_number_seq", "receipt_number_seq", "voucher_number_seq"]) {
      expect(Number((await q<{ v: string }>(`SELECT nextval('${sequence}')::text AS v`))[0].v), sequence).toBe(1);
    }
    const next = await createPatient({
      fullName: "أول مريض حقيقي", phone: null, altPhone: null, gender: "unknown", birthYear: null,
      address: null, medicalAlert: null, note: null,
    });
    expect(next.id).toBe(1);
    expect(next.patientNumber).toBe("P-08124");

    const audit = await q<{ action: string; details: Record<string, unknown> }>(`SELECT action, details FROM audit_log ORDER BY id`);
    expect(audit.map((row) => row.action)).toEqual(["patient.create", "system.reset"]);
    expect(audit[1].details).toMatchObject({ patients: 0, payments: 0, "نسخة_قبل_المسح": "backup-2026-09-25" });
  });

  it("freezes writes from before the backup snapshot until the wipe commits — nothing slips between them", async () => {
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
    await q(`INSERT INTO booking_requests(full_name,phone) VALUES ('يبقى','777000111')`);
    const auditBefore = await count("audit_log");
    const result = await resetClinicData({ actor: "owner-reset", actorRole: "admin" },
      async () => ({ ok: false, failure: "backup-disabled" }));
    expect(result).toEqual({ ok: false, failure: "backup-disabled" });
    expect(await count("booking_requests")).toBe(1);
    expect(await count("patients")).toBe(0);
    expect(await count("audit_log")).toBe(auditBefore);
    // لا قفل عالق: الكتابة تعود فورًا.
    await createPatient({
      fullName: "بعد الفشل", phone: null, altPhone: null, gender: "unknown", birthYear: null,
      address: null, medicalAlert: null, note: null,
    });
    expect(await count("patients")).toBe(1);
  });

  it("the real backup snapshot reads everything under the freeze (no self-deadlock)", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { productionBackupBlocksWithClient } = await import("../../lib/productionBackup");
    const { parseTarBytes } = await import("../../lib/restore/archive");
    await q(`INSERT INTO booking_requests(full_name,phone) VALUES ('في النسخة','777000111')`);
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
  it.each([false,true])("refuses issued patient identities before backup, including retired-only=%s",async retired=>{
    const patient=await createPatient({fullName:"Synthetic protected file",phone:null,altPhone:null,gender:"unknown",birthYear:null,address:null,medicalAlert:null,note:null});
    if(retired) await q("DELETE FROM patients WHERE id=$1",[patient.id]);
    const state=async()=>({patients:await q("SELECT * FROM patients"),retired:await q("SELECT * FROM retired_patient_numbers"),sequence:await q("SELECT last_value,is_called FROM patient_number_seq"),audit:await q("SELECT * FROM audit_log")});
    const before=await state(),backup=vi.fn(async()=>({ok:true as const,backupId:"must-not-run"}));
    await expect(resetClinicData({actor:"synthetic",actorRole:"admin"},backup)).rejects.toBeInstanceOf(ProtectedPatientNumberHistoryError);
    expect(backup).not.toHaveBeenCalled();expect(await state()).toEqual(before);
  });

});
