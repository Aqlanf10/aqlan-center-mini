import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { baseUrl, harness } from "./_server";

/**
 * (P3-6) مرفقات سند الصرف على التطبيق المبني.
 *
 * العيب (تدقيق الجاهزية): سند الصرف بلا صورة إيصال — فلا ورقة تُبرز حين يُراجَع مصروف.
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let expenseId = 0;

const VALID_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0, 0, 0, 13]),
  Buffer.from("IHDR"),
  Buffer.alloc(25, 0),
]);

function upload(cookie: string, id: number, bytes: Buffer, type = "image/png") {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type }), "receipt.png");
  return fetch(`${baseUrl}/api/expenses/${id}/attachments`, {
    method: "POST",
    headers: { Cookie: cookie, Origin: baseUrl, "Sec-Fetch-Site": "same-origin" },
    body: form,
  });
}

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const { rows: [shift] } = await db.query<{ id: number }>(
    `INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd)
     SELECT 'p36-http', 0, 0, 0 WHERE NOT EXISTS (SELECT 1 FROM cashier_shifts WHERE status = 'open')
     RETURNING id`,
  );
  const shiftId = shift?.id ?? (await db.query<{ id: number }>(
    `SELECT id FROM cashier_shifts WHERE status = 'open' ORDER BY id DESC LIMIT 1`,
  )).rows[0].id;
  ({ rows: [{ id: expenseId }] } = await db.query<{ id: number }>(
    `INSERT INTO expenses (voucher_number, category, payee_text, shift_id, amount_minor, currency,
                           exchange_rate, base_amount_minor, base_currency, created_by)
     VALUES ('V-P36-' || floor(random() * 1e6)::text, 'other', 'مورد نثريات', $1, 5000, 'YER', 1, 5000, 'YER', 'secreception')
     RETURNING id`,
    [shiftId],
  ));
}, 240_000);

afterAll(async () => {
  await db?.end();
});

describe("P3-6 — expense voucher attachments", () => {
  it("reception attaches a receipt photo; it is listed and served privately", async () => {
    const response = await upload(h.sessions.reception.cookie, expenseId, VALID_PNG);
    expect(response.status).toBe(201);
    const attachment = await response.json() as { id: number; title: string; expenseId: number };
    expect(attachment.expenseId).toBe(expenseId);

    const list = await fetch(`${baseUrl}/api/expenses/${expenseId}/attachments`, { headers: { Cookie: h.sessions.admin.cookie } });
    expect(list.status).toBe(200);
    expect(((await list.json()) as { attachments: { id: number }[] }).attachments.map((a) => a.id)).toContain(attachment.id);

    const file = await fetch(`${baseUrl}/api/expense-attachments/${attachment.id}`, { headers: { Cookie: h.sessions.admin.cookie } });
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/png");
    expect(file.headers.get("cache-control")).toContain("no-store");
    expect(Buffer.from(await file.arrayBuffer()).equals(VALID_PNG)).toBe(true);

    const { rows } = await db.query(`SELECT actor FROM audit_log WHERE action = 'expense.attachment' ORDER BY id DESC LIMIT 1`);
    expect(rows[0]?.actor).toBe("secreception");
  });

  it("a doctor can neither attach nor view", async () => {
    expect((await upload(h.sessions.doctorA.cookie, expenseId, VALID_PNG)).status).toBe(403);
    const list = await fetch(`${baseUrl}/api/expenses/${expenseId}/attachments`, { headers: { Cookie: h.sessions.doctorA.cookie } });
    expect(list.status).toBe(403);
    const file = await fetch(`${baseUrl}/api/expense-attachments/1`, { headers: { Cookie: h.sessions.doctorA.cookie } });
    expect(file.status).toBe(403);
  });

  it("a disguised file and an unknown voucher are refused in Arabic", async () => {
    const fake = await upload(h.sessions.admin.cookie, expenseId, Buffer.from("#!/bin/sh\nnot a png"));
    expect(fake.status).toBe(400);
    expect(typeof ((await fake.json()) as { message: string }).message).toBe("string");
    const missing = await upload(h.sessions.admin.cookie, 999_999, VALID_PNG);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { message: string }).message).toBe("سند الصرف غير موجود.");
  });

  it("attachments are append-only in the database", async () => {
    await expect(db.query(`DELETE FROM expense_attachments WHERE expense_id = $1`, [expenseId])).rejects.toThrow(/append-only/);
  });
});
