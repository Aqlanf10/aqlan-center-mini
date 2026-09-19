import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * اختبارات P-01 (تصحيح ٢ — مراجعة المالك) على PostgreSQL حقيقي: عمولات
 * العملات المختلطة — لكل (طبيب × عملة).
 *
 * الجولة السابقة للعمولات كانت توزّع **مجمّعًا واحدًا** للتحصيل على فواتير
 * بعملات مختلفة (مزج محظور)، وتقرأ صرف العمولة بمكافئه الأساسي وحده فيطرح
 * من استحقاقٍ مختلط. هذه الجولة تُثبت على المحرك الحقيقي:
 *
 *  - استحقاق كل فاتورة بعملتها (دلو لكل عملة)؛
 *  - تحصيل العملة يسوّي فواتير دلوها فقط (FIFO داخل الدلو)؛
 *  - المصروف للطبيب بعملته نفسها يُطرح من دَين عملته حصرًا — صرفٌ سعودي
 *    لا يمسّ دَينًا يمنيًّا ولا دولاريًّا؛
 *  - صفٌّ مستقل لكل (طبيب × عملة) بلا أي رقمٍ مجموعٍ عابر.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const { getPool, resetPoolForTesting, ensureSchema, commissionReport } = await import("../../lib/db");
const { dbTodayISO } = await import("../../lib/reports");

let TODAY = "";
let doctorId = 0;
let patientId = 0;

const YER_NET = 100000;
const SAR_NET = 20000;
const USD_NET = 3000;
const YER_PAID = 50000;
const SAR_PAID = 20000;
const SAR_PAYOUT = 1000_00; // 1,000.00 SAR صُرفت للطبيب بالسعودي حصرًا
const PERCENT = 30;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  const pool = getPool();

  const { rows: [shift] } = await pool.query(
    `INSERT INTO cashier_shifts (opened_by) VALUES ('p01-comm-pg') RETURNING id`,
  );
  const { rows: [doctor] } = await pool.query(
    `INSERT INTO parties (name, kind, commission_percent) VALUES ('طبيب العملات', 'doctor', $1) RETURNING id`,
    [String(PERCENT)],
  );
  doctorId = doctor.id;
  const { rows: [patient] } = await pool.query(
    `INSERT INTO patients (patient_number, full_name) VALUES ('P01-COMM-A', 'مريض عمولة العملات') RETURNING id`,
  );
  patientId = patient.id;

  const seeds: { number: string; currency: string; net: number; paid: number }[] = [
    { number: "P01-COMM-INV-YER", currency: "YER", net: YER_NET, paid: YER_PAID },
    { number: "P01-COMM-INV-SAR", currency: "SAR", net: SAR_NET, paid: SAR_PAID },
    { number: "P01-COMM-INV-USD", currency: "USD", net: USD_NET, paid: 0 },
  ];
  for (const seed of seeds) {
    const { rows: [invoice] } = await pool.query(
      `INSERT INTO invoices (invoice_number, patient_id, status, total_minor, discount_minor, base_currency, created_at)
       VALUES ($1, $2, 'open', $3, 0, $4, NOW()) RETURNING id`,
      [seed.number, patientId, seed.net, seed.currency],
    );
    // بند الفاتورة للطبيب بكامل قيمتها — بعملة فاتورتها.
    await pool.query(
      `INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price_minor, total_minor, doctor_id)
       VALUES ($1, NULL, 'حشوة', 1, $2, $2, $3)`,
      [invoice.id, seed.net, doctorId],
    );
    // الدفعة على فاتورتها بعملتها: عملة الدفعة = عملة الفاتورة.
    if (seed.paid > 0) {
      await pool.query(
        `INSERT INTO payments (receipt_number, patient_id, invoice_id, shift_id, kind, amount_minor, currency, exchange_rate, base_amount_minor, base_currency, method)
         VALUES ($1, $2, $3, $4, 'payment', $5, $6, 1, $5, 'YER', 'cash')`,
        [`P01-COMM-PAY-${seed.currency}`, patientId, invoice.id, shift.id, seed.paid, seed.currency],
      );
    }
  }

  // سند صرف عمولة بالسعودي وحده: يُطرح من دَين السعودي حصرًا.
  await pool.query(
    `INSERT INTO expenses (voucher_number, category, party_id, shift_id, amount_minor, currency, exchange_rate, base_amount_minor, base_currency)
     VALUES ('P01-COMM-EXP-SAR', 'commission', $1, $2, $3, 'SAR', 130, $4, 'YER')`,
    [doctorId, shift.id, SAR_PAYOUT, Math.round(SAR_PAYOUT * 130)],
  );

  TODAY = await dbTodayISO();
});

afterAll(async () => {
  await resetPoolForTesting();
});

describe("P-01 (تصحيح ٢) على PostgreSQL حقيقي: العمولة لكل (طبيب × عملة)", () => {
  it("ثلاثة صفوف للطبيب الواحد — صفٌّ لكل عملة، بلا رقمٍ مجموعٍ عابر", async () => {
    const rows = await commissionReport(TODAY, TODAY);
    const mine = rows.filter((row) => row.doctorId === doctorId);
    expect(mine.map((row) => row.currency)).toEqual(["YER", "SAR", "USD"]);
    // كل صف موسوم بعملته — والمجموع الممزوج لا يظهر في أي حقل.
    for (const row of mine) {
      expect(row.currency === "YER" || row.currency === "SAR" || row.currency === "USD").toBe(true);
    }
    const mixedSums = [
      YER_NET + SAR_NET + USD_NET,
      Math.round(YER_NET * PERCENT / 100) + Math.round(SAR_NET * PERCENT / 100) + Math.round(USD_NET * PERCENT / 100),
    ];
    for (const row of mine) {
      for (const mixed of mixedSums) {
        expect(row.accruedMinor).not.toBe(mixed);
        expect(row.earnedMinor).not.toBe(mixed);
        expect(row.dueMinor).not.toBe(mixed);
      }
    }
  });

  it("الاستحقاق بعملة كل فاتورة، والتحصيل يسوّي دلو عملته فقط", async () => {
    const rows = await commissionReport(TODAY, TODAY);
    const yer = rows.find((row) => row.doctorId === doctorId && row.currency === "YER")!;
    const sar = rows.find((row) => row.doctorId === doctorId && row.currency === "SAR")!;
    const usd = rows.find((row) => row.doctorId === doctorId && row.currency === "USD")!;

    // اليمني: استحقاق 30% من 100,000 = 30,000؛ محصّل الدلو 50,000 من 100,000
    // فالتغطية نصفٌ — والمستحق 15,000. (القديم كان يخلط تحصيل السعودي والدولار
    // فيغطّي اليمني كاملًا بعملةٍ أخرى.)
    expect(yer.accruedMinor).toBe(Math.round(YER_NET * PERCENT / 100));
    expect(yer.earnedMinor).toBe(Math.round(yer.accruedMinor * YER_PAID / YER_NET));
    // السعودي: محصّله يغطّيه كاملًا فاستحقاقه = مستحققه.
    expect(sar.accruedMinor).toBe(Math.round(SAR_NET * PERCENT / 100));
    expect(sar.earnedMinor).toBe(sar.accruedMinor);
    // الدولار: استحقاقٌ بلا تحصيل — مستحق الصفر.
    expect(usd.accruedMinor).toBe(Math.round(USD_NET * PERCENT / 100));
    expect(usd.earnedMinor).toBe(0);
  });

  it("المصروف بعملته نفسها يُطرح من دَين عملته حصرًا — لا يعبر الدلاء", async () => {
    const rows = await commissionReport(TODAY, TODAY);
    const yer = rows.find((row) => row.doctorId === doctorId && row.currency === "YER")!;
    const sar = rows.find((row) => row.doctorId === doctorId && row.currency === "SAR")!;
    const usd = rows.find((row) => row.doctorId === doctorId && row.currency === "USD")!;

    // صرفٌ سعودي 1,000.00: يُطرح من دَين السعودي وحده.
    expect(sar.paidMinor).toBe(SAR_PAYOUT);
    expect(sar.dueMinor).toBe(sar.earnedMinor - SAR_PAYOUT);
    // واليمني والدولار لم يُمسّا: صُرف له فيهما صفر.
    expect(yer.paidMinor).toBe(0);
    expect(yer.dueMinor).toBe(yer.earnedMinor);
    expect(usd.paidMinor).toBe(0);
  });

  it("الترتيب داخل العملة والعملات بترتيب الدلاء — لا مقارنة عابرة", async () => {
    const rows = await commissionReport(TODAY, TODAY);
    const currencies = rows.map((row) => row.currency);
    // كل YER قبل كل SAR قبل كل USD — بغضّ النظر عن أحجام الأرقام عبر العملات.
    const firstSar = currencies.indexOf("SAR");
    const firstUsd = currencies.indexOf("USD");
    const lastYer = currencies.lastIndexOf("YER");
    expect(firstSar).toBeGreaterThan(lastYer);
    expect(firstUsd).toBeGreaterThan(currencies.lastIndexOf("SAR"));
  });
});
