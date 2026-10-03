import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { Currency } from "../../lib/money";

type TimelineDb = Pick<typeof import("../../lib/db"), "getPool" | "patientTimeline">;

// Real query/mapper contract shared by PostgreSQL and the application's PGlite
// adapter. All rows are synthetic and linked to an existing patient; the signed
// clinical visit also references its invoice. No unlinked-visit fixture exists.
export function patientTimelineCurrencyContract(db: TimelineDb, adapter: string) {
  describe(`${adapter}: saved timeline currency`, () => {
    const namespace = `TL-CURRENCY-${randomUUID()}`;
    // These same validated codes feed patient/invoice/receipt numbering. UUIDs
    // stay in free-text labels; counter reseeding must see only bounded digits.
    const numberNamespace = namespace.replace(/[0-9]/g, (digit) => String.fromCharCode(103 + Number(digit)));
    function fixtureNumber(index: number) {
      expect(Number.isSafeInteger(index) && index > 0 && index < 1000).toBe(true);
      const code = `${numberNamespace}-${890000 + index}`;
      const extracted = code.replace(/\D/g, "");
      expect(extracted).toMatch(/^[0-9]{1,10}$/);
      expect(BigInt(extracted) <= 9223372036854775807n).toBe(true);
      return code;
    }
    let sequence = 0;
    let doctorId: number;
    let shiftId: number;
    const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) =>
      (await db.getPool().query<T>(sql, values)).rows;

    beforeAll(async () => {
      doctorId = (await q<{ id: number }>(
        `INSERT INTO parties (kind, name) VALUES ('doctor', $1) RETURNING id`,
        [`Synthetic timeline doctor ${namespace}`],
      ))[0].id;
      // A historical closed shift avoids competing with the single-open-shift
      // index. This is fixture setup, not a payment/shift transition test.
      shiftId = (await q<{ id: number }>(
        `INSERT INTO cashier_shifts (opened_by, status, closed_by, closed_at)
         VALUES ($1, 'closed', $1, '2026-10-01T12:00:00Z') RETURNING id`, [namespace],
      ))[0].id;
    });

    async function fixture(currency: Currency, options: { zero?: boolean; cancelled?: boolean; refund?: boolean } = {}) {
      const tag = fixtureNumber(++sequence);
      const patientId = (await q<{ id: number }>(
        `INSERT INTO patients (patient_number, full_name, primary_doctor_id)
         VALUES ($1, 'Synthetic timeline patient', $2) RETURNING id`, [tag, doctorId],
      ))[0].id;
      const total = options.zero ? 0 : 123456;
      const discount = options.zero ? 0 : 789;
      const invoiceId = (await q<{ id: number }>(
        `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, '2026-10-01T10:00:00Z') RETURNING id`,
        [tag, patientId, total, discount, currency, options.cancelled ? "cancelled" : "open"],
      ))[0].id;
      const visitId = (await q<{ id: number }>(
        `INSERT INTO visits (patient_id, patient_name, doctor_id, invoice_id, status, signed_at, signed_by, treatment_done)
         VALUES ($1, 'Synthetic timeline patient', $2, $3, 'done', '2026-10-01T09:00:00Z', $4,
                 'Synthetic clinical timeline detail') RETURNING id`, [patientId, doctorId, invoiceId, namespace],
      ))[0].id;
      const paymentId = (await q<{ id: number }>(
        `INSERT INTO payments (receipt_number, patient_id, invoice_id, shift_id, kind, amount_minor,
                               currency, exchange_rate, base_amount_minor, base_currency, created_at)
         VALUES ($1, $2, $3, $4, $5, 1250, $6, 1, 1250, $6, '2026-10-01T11:00:00Z') RETURNING id`,
        [tag, patientId, invoiceId, shiftId, options.refund ? "refund" : "payment", currency],
      ))[0].id;
      expect(await q(`SELECT patient_id, doctor_id, invoice_id FROM visits WHERE id = $1`, [visitId]))
        .toEqual([{ patient_id: patientId, doctor_id: doctorId, invoice_id: invoiceId }]);
      return { patientId, visitId, invoiceId, paymentId, tag, amountMinor: total - discount };
    }

    async function snapshot(patientId: number) {
      return {
        invoices: await q(`SELECT * FROM invoices WHERE patient_id = $1 ORDER BY id`, [patientId]),
        payments: await q(`SELECT * FROM payments WHERE patient_id = $1 ORDER BY id`, [patientId]),
        visits: await q(`SELECT * FROM visits WHERE patient_id = $1 ORDER BY id`, [patientId]),
      };
    }

    it.each(["YER", "SAR", "USD"] as const)("preserves %s invoice and payment currency, with clinical null amounts", async (currency) => {
      const f = await fixture(currency);
      const before = await snapshot(f.patientId);
      const events = await db.patientTimeline(f.patientId, 60);
      expect(events.find((event) => event.key === `invoice:${f.invoiceId}`)).toEqual({
        key: `invoice:${f.invoiceId}`, kind: "invoice", at: "2026-10-01T10:00:00.000Z",
        title: `فاتورة ${f.tag}`, detail: null, amountMinor: f.amountMinor,
        currency, href: `/patients/${f.patientId}?tab=account`,
      });
      expect(events.find((event) => event.key === `payment:${f.paymentId}`)).toEqual({
        key: `payment:${f.paymentId}`, kind: "payment", at: "2026-10-01T11:00:00.000Z",
        title: "دفعة", detail: "cash", amountMinor: 1250, currency,
        href: `/patients/${f.patientId}?tab=account`,
      });
      expect(events.find((event) => event.key === `visit:${f.visitId}`)).toMatchObject({
        kind: "visit", at: "2026-10-01T09:00:00.000Z", title: "زيارة سريرية",
        detail: "Synthetic clinical timeline detail", amountMinor: null, currency: null,
        href: `/visits/${f.visitId}/clinical`, doctorName: `Synthetic timeline doctor ${namespace}`,
      });
      expect(events.map((event) => event.key)).toEqual([
        `payment:${f.paymentId}`, `invoice:${f.invoiceId}`, `visit:${f.visitId}`,
      ]);
      expect(await snapshot(f.patientId)).toEqual(before);
    });

    it("preserves a genuine zero invoice instead of confusing zero with a withheld amount", async () => {
      const f = await fixture("USD", { zero: true });
      expect((await db.patientTimeline(f.patientId)).find((event) => event.key === `invoice:${f.invoiceId}`))
        .toMatchObject({ amountMinor: 0, currency: "USD" });
    });

    it("does not change cancelled-invoice arithmetic or refund representation", async () => {
      const f = await fixture("SAR", { cancelled: true, refund: true });
      const before = await snapshot(f.patientId);
      const events = await db.patientTimeline(f.patientId);
      expect(events.find((event) => event.key === `invoice:${f.invoiceId}`))
        .toMatchObject({ amountMinor: 122667, currency: "SAR", detail: "ملغاة" });
      expect(events.find((event) => event.key === `payment:${f.paymentId}`))
        .toMatchObject({ title: "استرداد دفعة", amountMinor: 1250, currency: "SAR" });
      expect(await snapshot(f.patientId)).toEqual(before);
    });

    it("keeps another linked synthetic patient's invoices out of the requested timeline", async () => {
      const requested = await fixture("YER");
      const other = await fixture("USD");
      const events = await db.patientTimeline(requested.patientId);
      expect(events.map((event) => event.key)).toEqual([
        `payment:${requested.paymentId}`, `invoice:${requested.invoiceId}`, `visit:${requested.visitId}`,
      ]);
      expect(JSON.stringify(events)).not.toContain(other.tag);
    });
  });
}
