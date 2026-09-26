import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, authedMutation, harness } from "./_server";

/**
 * (PAT-3) الأعلام والبريد وموافقات التواصل عبر المسار الحقيقي: الاستقبال يسجّل الموافقة،
 * الطبيب يقرأ ولا يسجّل، الأدوار المالية لا ترى شيئًا، والعلَم خارج القائمة يُرفض بالعربية.
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let patientId = 0;
const arabic = /[؀-ۿ]/;

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  ({ rows: [{ id: patientId }] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, phone) VALUES ($1, 'مريض التواصل', '967771234567') RETURNING id`,
    [`IDH-${Date.now()}`]));
}, 120_000);
afterAll(async () => { await db?.end(); });

describe("(PAT-3) patient flags and email via PATCH /api/patients/[id]", () => {
  it("saves listed flags and a valid email; refuses an unlisted flag and a bad email in Arabic", async () => {
    const ok = await authedMutation(`/api/patients/${patientId}`, h.sessions.reception, "PATCH",
      JSON.stringify({ flags: ["VIP"], email: "Patient@Example.com", preferredChannel: "whatsapp" }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ flags: ["VIP"], email: "patient@example.com", preferredChannel: "whatsapp" });
    for (const body of [{ flags: ["علم مخترع"] }, { email: "x@" }, { preferredChannel: "fax" }]) {
      const bad = await authedMutation(`/api/patients/${patientId}`, h.sessions.reception, "PATCH", JSON.stringify(body));
      expect(bad.status).toBe(400);
      expect((await bad.json() as { message: string }).message).toMatch(arabic);
    }
  });
});

describe("(PAT-3) /api/patients/[id]/contact", () => {
  it("reception records a withdrawal; the state and log follow; the messaging route then refuses to send", async () => {
    const saved = await authedMutation(`/api/patients/${patientId}/contact`, h.sessions.reception, "POST",
      JSON.stringify({ channel: "whatsapp", granted: false, source: "phone" }));
    expect(saved.status).toBe(201);
    const view = await (await authedGet(`/api/patients/${patientId}/contact`, h.sessions.admin)).json() as {
      states: Record<string, string>; history: unknown[]; mode: string;
    };
    expect(view).toMatchObject({ mode: "opt_out", states: { whatsapp: "withdrawn", sms: "unknown", email: "unknown" } });
    expect(view.history).toHaveLength(1);

    const send = await authedMutation(`/api/messages/outbound`, h.sessions.reception, "POST",
      JSON.stringify({ channel: "whatsapp", patientId, body: "مرحبا" }));
    expect(send.status).toBe(409);
    expect((await send.json() as { message: string }).message).toContain("سحب موافقته");
  });

  it("the system-only source and malformed input are refused in Arabic", async () => {
    for (const body of [
      { channel: "whatsapp", granted: false, source: "inbound_stop" },
      { channel: "fax", granted: true, source: "phone" },
      { channel: "sms", granted: "yes", source: "phone" },
    ]) {
      const bad = await authedMutation(`/api/patients/${patientId}/contact`, h.sessions.reception, "POST", JSON.stringify(body));
      expect(bad.status).toBe(400);
      expect((await bad.json() as { message: string }).message).toMatch(arabic);
    }
  });

  it("finance roles see nothing; an unrelated doctor cannot read; no doctor records consent", async () => {
    for (const session of [h.sessions.cashier, h.sessions.accountant, h.sessions.doctorB]) {
      expect((await authedGet(`/api/patients/${patientId}/contact`, session)).status).toBe(403);
    }
    for (const session of [h.sessions.cashier, h.sessions.doctorB]) {
      expect((await authedMutation(`/api/patients/${patientId}/contact`, session, "POST",
        JSON.stringify({ channel: "sms", granted: true, source: "phone" }))).status).toBe(403);
    }
  });
});

describe("(PAT-3) PUT /api/patients/[id]/photo", () => {
  it("refuses a document of another patient and finance roles", async () => {
    const { rows: [other] } = await db.query<{ id: number }>(
      `INSERT INTO patients (patient_number, full_name) VALUES ($1, 'آخر') RETURNING id`, [`IDH2-${Date.now()}`]);
    const { rows: [document] } = await db.query<{ id: number }>(
      `INSERT INTO patient_documents (patient_id, kind, title, mime_type, size_bytes, sha256, storage_key, uploaded_by)
       VALUES ($1, 'photo', 'صورة', 'image/jpeg', 10, repeat('b', 64), 'k/' || gen_random_uuid(), 'x') RETURNING id`, [other.id]);
    const foreign = await authedMutation(`/api/patients/${patientId}/photo`, h.sessions.reception, "PUT", JSON.stringify({ documentId: document.id }));
    expect(foreign.status).toBe(404);
    expect((await foreign.json() as { message: string }).message).toMatch(arabic);
    expect((await authedMutation(`/api/patients/${patientId}/photo`, h.sessions.cashier, "PUT", JSON.stringify({ documentId: null }))).status).toBe(403);
    const own = await authedMutation(`/api/patients/${other.id}/photo`, h.sessions.reception, "PUT", JSON.stringify({ documentId: document.id }));
    expect(own.status).toBe(200);
    expect(await own.json()).toMatchObject({ photoDocumentId: document.id });
  });
});
