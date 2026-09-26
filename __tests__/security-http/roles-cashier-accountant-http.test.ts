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
const mediaIds: number[] = [];
const arabic = /[؀-ۿ]/;

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
});
afterAll(async () => {
  if (db && mediaIds.length) await db.query(`DELETE FROM messages WHERE id = ANY($1::int[])`, [mediaIds]);
  await db?.end();
});

async function mediaMessage(kind: "file" | "voice", target: "broadcast" | "direct" | "portal"): Promise<number> {
  const { rows: [admin] } = await db.query<{ id: number }>(`SELECT id FROM users WHERE username = 'secadmin'`);
  const { rows: [cashier] } = await db.query<{ id: number }>(`SELECT id FROM users WHERE username = 'seccashier'`);
  const patient = target === "portal";
  const { rows: [message] } = await db.query<{ id: number }>(
    `INSERT INTO messages (sender_type, sender_user_id, sender_patient_id, recipient_type,
      recipient_user_id, recipient_patient_id, kind, voice_mime, voice_data, voice_ms,
      file_name, file_mime, file_size, file_data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [patient ? "patient" : "user", patient ? null : admin.id, patient ? h.seeded.patientAId : null,
      target === "direct" ? "user" : "staff_all", target === "direct" ? cashier.id : null, null,
      kind, kind === "voice" ? "audio/webm" : null, kind === "voice" ? "VEVTVA==" : null,
      kind === "voice" ? 1000 : null, kind === "file" ? "test.txt" : null,
      kind === "file" ? "text/plain" : null, kind === "file" ? 4 : null,
      kind === "file" ? "VEVTVA==" : null],
  );
  mediaIds.push(message.id);
  return message.id;
}

describe("cashier", () => {
  it("returns only finance-safe patient identity fields for search and pagination", async () => {
    for (const session of [h.sessions.cashier, h.sessions.accountant]) {
      for (const path of ["/api/patients?q=مريض", "/api/patients"]) {
        const response = await authedGet(path, session);
        expect(response.status, path).toBe(200);
        const payload = await response.json() as Record<string, unknown> | Record<string, unknown>[];
        const rows = Array.isArray(payload) ? payload : payload.rows as Record<string, unknown>[];
        expect(rows.length, path).toBeGreaterThan(0);
        for (const row of rows) {
          expect(Object.keys(row).sort()).toEqual(["fullName", "id", "patientNumber", "phone"]);
          expect(row).not.toHaveProperty("medicalAlert");
        }
      }
    }
    for (const session of [h.sessions.admin, h.sessions.reception, h.sessions.doctorA]) {
      const response = await authedGet("/api/patients?q=مريض", session);
      expect(response.status).toBe(200);
      const rows = await response.json() as Record<string, unknown>[];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]).toHaveProperty("medicalAlert");
    }
  });

  it("blocks direct file and voice URLs for both restricted roles, including staff broadcasts and own direct messages", async () => {
    for (const kind of ["file", "voice"] as const) {
      for (const target of ["broadcast", "direct"] as const) {
        const id = await mediaMessage(kind, target);
        for (const session of [h.sessions.cashier, h.sessions.accountant]) {
          expect((await authedGet(`/api/messages/${kind}/${id}`, session)).status).toBe(403);
          const bearer = await fetch(`${baseUrl}/api/messages/${kind}/${id}`, {
            headers: { Authorization: `Bearer ${session.token}` },
          });
          expect(bearer.status).toBe(403);
        }
        expect((await authedGet(`/api/messages/${kind}/${id}`, h.sessions.admin)).status).toBe(200);
      }
      const portalId = await mediaMessage(kind, "portal");
      expect((await authedGet(`/api/messages/${kind}/${portalId}`, h.sessions.portalA)).status).toBe(200);
      expect((await authedGet(`/api/messages/${kind}/${portalId}`, h.sessions.portalB)).status).toBe(403);
    }
  });
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

  it("public endpoints stay public for a signed-in cashier (switching user on the same device)", async () => {
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { Cookie: h.sessions.cashier.cookie, "content-type": "application/json", Origin: baseUrl, "Sec-Fetch-Site": "same-origin" },
      body: JSON.stringify({ username: "nobody-here", password: "wrong-password-1" }),
    });
    expect(login.status).not.toBe(403);
    const display = await fetch(`${baseUrl}/api/display`, { headers: { Cookie: h.sessions.cashier.cookie } });
    expect(display.status).toBe(200);
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

  it("cannot edit, delete, or reverse a mistaken receipt without the manager", async () => {
    for (const method of ["PATCH", "DELETE"] as const) {
      const response = await authedMutation("/api/payments", h.sessions.cashier, method, JSON.stringify({ id: 1, amount: "999999" }));
      expect(response.status).toBe(403);
    }
    const reversal = await authedMutation("/api/payments", h.sessions.cashier, "POST", JSON.stringify({
      patientId: h.seeded.patientAId, currency: "YER", amount: "999999", kind: "refund", reversalOfId: 1,
    }));
    expect(reversal.status).toBe(403);
    expect((await reversal.json() as { message: string }).message).toMatch(arabic);
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

describe("per-user finance permissions", () => {
  it("admin settings revoke only the selected cashier's actions and old session", async () => {
    const { hashPassword } = await import("../../lib/auth");
    const { financeAccessFor } = await import("../../lib/finance-permissions");
    const username = `secfinflags${Date.now()}`;
    const { rows: [user] } = await db.query<{ id: number }>(
      `INSERT INTO users (username, display_name, password_hash, role) VALUES ($1, 'صلاحيات مالية', $2, 'cashier') RETURNING id`,
      [username, await hashPassword("FinFlags#Pass1")],
    );
    try {
      const oldSession = await loginStaff(username, "FinFlags#Pass1");
      expect((await authedGet(`/api/patients/${h.seeded.patientAId}/ledger`, oldSession)).status).toBe(200);
      const changed = await authedMutation(`/api/users/${user.id}`, h.sessions.admin, "PATCH", JSON.stringify({
        permissions: { financeAccess: { ...financeAccessFor("cashier"), collectPayments: false, viewPatientLedger: false } },
      }));
      expect(changed.status).toBe(200);
      expect((await authedGet("/api/auth/me", oldSession)).status).toBe(401);
      const updatedSession = await loginStaff(username, "FinFlags#Pass1");
      expect((await authedGet(`/api/patients/${h.seeded.patientAId}/ledger`, updatedSession)).status).toBe(403);
      expect((await authedMutation("/api/payments", updatedSession, "POST", JSON.stringify({}))).status).toBe(403);
      expect((await authedGet("/api/payments", updatedSession)).status).toBe(200);
      expect((await authedGet(`/api/patients/${h.seeded.patientAId}/ledger`, h.sessions.cashier)).status).toBe(200);
    } finally {
      await db.query(`DELETE FROM users WHERE id = $1`, [user.id]);
    }
  });
});
