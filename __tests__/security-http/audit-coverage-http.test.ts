import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedMutation, harness } from "./_server";

/**
 * (P1-4) التعديلات الحساسة تُدقَّق بقبل/بعد — على التطبيق المبني وعبر الشاشات نفسها.
 *
 * العيب (تدقيق الجاهزية): إنشاء مريض وتعديل بياناته، وإنشاء جهة وتعديلها، وإضافة خدمة
 * وتغيير سعرها وتسعير الدليل دفعةً — كلها كانت تمرّ بلا سطرٍ واحد في سجل التدقيق.
 * فلا يُعرف من غيّر سعر خدمةٍ ولا من غيّر هاتف مريض.
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
const stamp = Date.now();

async function lastAudit(action: string, entityId: string | number): Promise<{ actor: string; details: Record<string, unknown> } | null> {
  const { rows } = await db.query<{ actor: string; details: Record<string, unknown> }>(
    `SELECT actor, details FROM audit_log WHERE action = $1 AND entity_id = $2 ORDER BY id DESC LIMIT 1`,
    [action, String(entityId)],
  );
  return rows[0] ?? null;
}

async function json<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
}, 120_000);
afterAll(async () => { await db?.end(); });

describe("P1-4 — sensitive edits leave an audit trail with before/after", () => {
  it("patient create and demographic edit", async () => {
    const created = await authedMutation("/api/patients", h.sessions.reception, "POST", JSON.stringify({
      fullName: `مريض تدقيق ${stamp}`, phone: `77${String(stamp).slice(-7)}`, gender: "male", confirmDuplicate: true,
    }));
    expect(created.status).toBe(201);
    const patient = await json<{ id: number }>(created);
    const createAudit = await lastAudit("patient.create", patient.id);
    expect(createAudit?.actor).toBe("secreception");

    const edited = await authedMutation(`/api/patients/${patient.id}`, h.sessions.reception, "PATCH", JSON.stringify({ phone: "771234567" }));
    expect(edited.status).toBe(200);
    const updateAudit = await lastAudit("patient.update", patient.id);
    expect(updateAudit?.actor).toBe("secreception");
    expect(JSON.stringify(updateAudit?.details)).toContain("771234567");
    expect(JSON.stringify(updateAudit?.details)).toContain(`77${String(stamp).slice(-7)}`);
  });

  it("party create and edit (name, phone, active)", async () => {
    const created = await authedMutation("/api/parties", h.sessions.admin, "POST", JSON.stringify({
      name: `مورد تدقيق ${stamp}`, kind: "supplier", phone: "700000001",
    }));
    expect(created.status).toBe(201);
    const party = await json<{ id: number }>(created);
    expect((await lastAudit("party.create", party.id))?.actor).toBe("secadmin");

    const edited = await authedMutation(`/api/parties/${party.id}`, h.sessions.admin, "PATCH", JSON.stringify({ phone: "700000002", isActive: false }));
    expect(edited.status).toBe(200);
    const audit = await lastAudit("party.update", party.id);
    expect(JSON.stringify(audit?.details)).toContain("700000001");
    expect(JSON.stringify(audit?.details)).toContain("700000002");
  });

  it("service create, price edit and batch pricing", async () => {
    const created = await authedMutation("/api/services", h.sessions.admin, "POST", JSON.stringify({
      name: `خدمة تدقيق ${stamp}`, category: "filling", price: "15000",
    }));
    expect(created.status).toBe(201);
    const service = await json<{ id: number; priceMinor: number }>(created);
    expect((await lastAudit("service.create", service.id))?.actor).toBe("secadmin");

    const priced = await authedMutation(`/api/services/${service.id}`, h.sessions.admin, "PATCH", JSON.stringify({ price: "18000" }));
    expect(priced.status).toBe(200);
    const audit = await lastAudit("service.update", service.id);
    expect(JSON.stringify(audit?.details)).toContain("15000");
    expect(JSON.stringify(audit?.details)).toContain("18000");

    const batch = await authedMutation("/api/services/prices", h.sessions.admin, "POST", JSON.stringify({
      entries: [{ id: service.id, price: "20000" }],
    }));
    expect(batch.status).toBe(200);
    const { rows } = await db.query<{ details: Record<string, unknown> }>(
      `SELECT details FROM audit_log WHERE action = 'service.prices.batch' ORDER BY id DESC LIMIT 1`,
    );
    expect(JSON.stringify(rows[0]?.details)).toContain("20000");
  });
});
