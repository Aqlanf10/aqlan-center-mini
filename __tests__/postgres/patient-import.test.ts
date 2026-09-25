import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (P1-5) استيراد مرضى المركز القديم على PostgreSQL 18 الحقيقي: كلها أو لا شيء،
 * والرصيد اليمني يُثبَت بسجلّه، والمكرر لا يُنشأ، والملف لا يُستورد مرتين.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const { ensureSchema, getPool, resetPoolForTesting, commitPatientImport, findPatientImport, createPatient } = await import("../../lib/db");
const { parseCsv } = await import("../../lib/patient-import");

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

function importFile(csv: string, includePossibleDuplicates = false) {
  return commitPatientImport({
    rows: parseCsv(csv), fileSha256: sha(csv), fileName: "old.csv", today: "2026-09-25",
    includePossibleDuplicates, actor: "admin", actorRole: "admin",
  });
}

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  await q(`INSERT INTO patients (patient_number, full_name, phone, birth_year) VALUES
    ('P-90001', 'علي حسن محمد', '967777111222', 1990),
    ('P-90002', 'خالد عمر ناصر', NULL, 1985)`);
});

afterAll(async () => {
  await resetPoolForTesting();
});

describe("commitPatientImport", () => {
  const csv = [
    "الاسم,الهاتف,سنة الميلاد,رقم الملف,الرصيد,العملة",
    "سعيد ناجي,771000001,2000,10,\"15,000\",",
    "علي حسن,0777111222,,11,,",
    "خالد عمر ناصر,,1999,12,,",
    "هدى صالح,771000004,,13,100,دولار",
    ",771000009,,14,,",
  ].join("\n");

  it("creates only new rows, sets the YER opening balance with history, skips duplicates, and audits the file hash", async () => {
    const before = Number((await q<{ n: string }>(`SELECT count(*) n FROM patients`))[0].n);
    const result = await importFile(csv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created.map((row) => row.fullName)).toEqual(["سعيد ناجي", "هدى صالح"]);
    expect(Number((await q<{ n: string }>(`SELECT count(*) n FROM patients`))[0].n)).toBe(before + 2);

    const saeed = result.created[0];
    const [patient] = await q<{ phone: string; note: string; patient_number: string }>(
      `SELECT phone, note, patient_number FROM patients WHERE id = $1`, [saeed.id]);
    expect(patient.phone).toBe("967771000001");
    expect(patient.note).toContain("رقم الملف في النظام القديم: 10");
    expect(patient.patient_number).toMatch(/^P-\d{5}$/);

    const [balance] = await q<{ amount_minor: string; as_of_date: string }>(
      `SELECT amount_minor::text, as_of_date::text FROM patient_opening_balances WHERE patient_id = $1`, [saeed.id]);
    expect(balance).toEqual({ amount_minor: "15000", as_of_date: "2026-09-25" });
    const history = await q<{ action: string; reason: string }>(
      `SELECT action, reason FROM patient_opening_balance_history WHERE patient_id = $1`, [saeed.id]);
    expect(history).toEqual([{ action: "set", reason: "استيراد بيانات المركز القديم" }]);

    // الدولار لا يُحوَّل: لا رصيد افتتاحي لهدى.
    expect(await q(`SELECT 1 FROM patient_opening_balances WHERE patient_id = $1`, [result.created[1].id])).toHaveLength(0);

    const [audit] = await q<{ details: Record<string, unknown>; summary: string }>(
      `SELECT details, summary FROM audit_log WHERE action = 'patient.import' ORDER BY id DESC LIMIT 1`);
    expect(audit.details.fileSha256).toBe(sha(csv));
    expect(audit.details["أُنشئ"]).toBe(2);
    expect(audit.details["مكرر_متخطّى"]).toBe(1);
    expect(audit.details["مشتبه"]).toBe(1);
    expect(audit.details["غير_صالح"]).toBe(1);
    expect(await findPatientImport(sha(csv))).not.toBeNull();
  });

  it("refuses to import the same file twice", async () => {
    const before = Number((await q<{ n: string }>(`SELECT count(*) n FROM patients`))[0].n);
    const again = await importFile(csv);
    expect(again).toMatchObject({ ok: false, reason: "already_imported", actor: "admin" });
    expect(Number((await q<{ n: string }>(`SELECT count(*) n FROM patients`))[0].n)).toBe(before);
  });

  it("imports a possible duplicate only when explicitly asked", async () => {
    const file = "الاسم,سنة الميلاد\nخالد عمر ناصر,1970\n";
    const result = await importFile(file, true);
    expect(result.ok && result.created.map((row) => row.fullName)).toEqual(["خالد عمر ناصر"]);
  });

  it("re-classifies at commit time: a patient added after the preview is not created twice", async () => {
    const file = "الاسم,الهاتف\nمنى صالح,771555666\n";
    await q(`INSERT INTO patients (patient_number, full_name, phone) VALUES ('P-90003', 'منى صالح', '967771555666')`);
    const result = await importFile(file);
    expect(result.ok && result.created).toEqual([]);
    expect(await q(`SELECT id FROM patients WHERE full_name = 'منى صالح'`)).toHaveLength(1);
  });

  it("rolls back every row when one insert fails", async () => {
    const before = Number((await q<{ n: string }>(`SELECT count(*) n FROM patients`))[0].n);
    await q(`ALTER TABLE patients ADD CONSTRAINT import_test_no_x CHECK (full_name <> 'ممنوع للاختبار')`);
    try {
      await expect(importFile("الاسم\nأول جديد\nممنوع للاختبار\n")).rejects.toThrow();
    } finally {
      await q(`ALTER TABLE patients DROP CONSTRAINT import_test_no_x`);
    }
    expect(Number((await q<{ n: string }>(`SELECT count(*) n FROM patients`))[0].n)).toBe(before);
    expect(await findPatientImport(sha("الاسم\nأول جديد\nممنوع للاختبار\n"))).toBeNull();
  });

  it("an ordinary patient create waits for a running import instead of racing its snapshot (review)", async () => {
    const importer = await getPool().connect();
    try {
      await importer.query("BEGIN");
      await importer.query(`SELECT pg_advisory_xact_lock(hashtext('patient_import'))`);
      let done = false;
      const creating = createPatient({
        fullName: "ينتظر الاستيراد", phone: null, altPhone: null, gender: "unknown", birthYear: null,
        address: null, medicalAlert: null, note: null,
      }).then((patient) => { done = true; return patient; });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(done).toBe(false);
      await importer.query("COMMIT");
      expect((await creating).fullName).toBe("ينتظر الاستيراد");
    } finally {
      importer.release();
    }
  });
});
