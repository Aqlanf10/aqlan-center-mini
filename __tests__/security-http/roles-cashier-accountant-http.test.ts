import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, authedMutation, baseUrl, harness, loginStaff } from "./_server";

/**
 * (P2-1) الكاشير والمحاسب على التطبيق المبني — الباب يحرسهما بقائمة سماح:
 * الكاشير للصندوق وحده، والمحاسب يقرأ المالية ولا يقبض ولا يصرف، ولا أحدهما
 * يرى الملف السريري. ورسالة الرفض عربية.
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
const arabic = /[؀-ۿ]/;

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
});
afterAll(async () => { await db?.end(); });

describe("cashier", () => {
  it("reaches the cash desk: shifts, payments, the patient's ledger", async () => {
    for (const path of ["/api/shifts", "/api/payments", `/api/patients/${h.seeded.patientAId}/ledger`]) {
      expect((await authedGet(path, h.sessions.cashier)).status, path).toBe(200);
    }
  });

  it("never sees the clinical file, the schedule, reports or settings (Arabic 403)", async () => {
    for (const path of [`/api/patients/${h.seeded.patientAId}`, `/api/visits/${h.seeded.visitId}/clinical`,
      "/api/appointments", "/api/reports", "/api/users", "/api/settings/readiness"]) {
      const response = await authedGet(path, h.sessions.cashier);
      expect(response.status, path).toBe(403);
      expect((await response.json() as { message: string }).message).toMatch(arabic);
    }
  });

  it("a page outside the desk sends the cashier back to /finance", async () => {
    const response = await fetch(`${baseUrl}/patients/${h.seeded.patientAId}`, {
      headers: { Cookie: h.sessions.cashier.cookie }, redirect: "manual",
    });
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/finance");
  });

  it("the Bearer token is held to the same allowlist", async () => {
    const response = await fetch(`${baseUrl}/api/patients/${h.seeded.patientAId}`, {
      headers: { Authorization: `Bearer ${h.sessions.cashier.token}` },
    });
    expect(response.status).toBe(403);
  });
});

describe("accountant", () => {
  it("reads money: payments, shifts, expenses, payables", async () => {
    for (const path of ["/api/payments", "/api/shifts", "/api/expenses", "/api/payables"]) {
      expect((await authedGet(path, h.sessions.accountant)).status, path).toBe(200);
    }
  });

  it("issues nothing: no receipt, no voucher, no shift", async () => {
    for (const path of ["/api/payments", "/api/expenses", "/api/shifts"]) {
      const response = await authedMutation(path, h.sessions.accountant, "POST", JSON.stringify({}));
      expect(response.status, path).toBe(403);
      expect((await response.json() as { message: string }).message).toMatch(arabic);
    }
  });

  it("never sees the clinical file", async () => {
    expect((await authedGet(`/api/patients/${h.seeded.patientAId}`, h.sessions.accountant)).status).toBe(403);
  });
});

describe("role change", () => {
  it("moving a user to another role ends their session — the signed role always matches", async () => {
    const { hashPassword } = await import("../../lib/auth");
    await db.query(
      `INSERT INTO users (username, display_name, password_hash, role) VALUES ('secrolemove', 'نقل دور', $1, 'cashier')`,
      [await hashPassword("SecMove#Pass1")],
    );
    try {
      const session = await loginStaff("secrolemove", "SecMove#Pass1");
      expect((await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: session.cookie } })).status).toBe(200);
      await db.query(`UPDATE users SET role = 'reception' WHERE username = 'secrolemove'`);
      expect((await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: session.cookie } })).status).toBe(401);
    } finally {
      await db.query(`UPDATE users SET is_active = false WHERE username = 'secrolemove'`);
    }
  });
});
