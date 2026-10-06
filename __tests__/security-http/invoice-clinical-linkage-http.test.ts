import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedMutation, harness } from "./_server";

/**
 * (INV-LINK B) الفاتورة العلاجية على التطبيق المبني: الربط السريري في الرد، مفتاح الإعادة، والرفض العربي
 * بلا تفاصيل داخلية. والأدوار كما كانت (الطبيب لا يصدر فاتورة).
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let patientId = 0;
let orthoService = 0;
let rctService = 0;
const stamp = Date.now();

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  ({ rows: [{ id: patientId }] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, 'فاتورة علاجية') RETURNING id`, [`IL-${stamp}`]));
  const service = async (name: string, category: string) => (await db.query<{ id: number }>(
    `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ($1, 3000000, TRUE, TRUE, $2) RETURNING id`,
    [`${name} ${stamp}`, category])).rows[0].id;
  orthoService = await service("تقويم ثابت", "ortho");
  rctService = await service("علاج عصب", "rct");
}, 120_000);
afterAll(async () => { await db?.end(); });

const post = (who: "reception" | "admin" | "doctorA", body: Record<string, unknown>) =>
  authedMutation("/api/invoices", h.sessions[who], "POST", JSON.stringify({ patientId, currency: "YER", ...body }));
const json = async (response: Response) => await response.json() as Record<string, unknown> & { message?: string };

describe("(INV-LINK B) POST /api/invoices — invoice-first clinical linkage", () => {
  it("an ortho invoice returns its clinical linkage; the same key replays the same invoice", async () => {
    const body = { items: [{ serviceId: orthoService }], idempotencyKey: `inv:http-${stamp}` };
    const created = await post("reception", body);
    expect(created.status).toBe(201);
    const first = await json(created) as { id: number; clinical: { planId: number; links: { kind: string; planItemCreated: boolean; caseCreated: boolean; specialty: string }[] } };
    expect(first.clinical.links[0]).toMatchObject({ kind: "clinical", specialty: "orthodontics", planItemCreated: true, caseCreated: true });

    const replay = await post("reception", body);
    expect(replay.status).toBe(200);
    expect((await json(replay)).id).toBe(first.id);

    const conflict = await post("reception", { ...body, items: [{ serviceId: orthoService, quantity: 2 }] });
    expect(conflict.status).toBe(409);
    expect((await json(conflict)).message).toContain("أُرسل سابقًا");
    const { rows } = await db.query(`SELECT 1 FROM invoices WHERE patient_id = $1`, [patientId]);
    expect(rows).toHaveLength(1);
  });

  it("the same treatment invoiced again from another tab is refused in Arabic", async () => {
    const response = await post("reception", { items: [{ serviceId: orthoService }], idempotencyKey: `inv:tab2-${stamp}` });
    expect(response.status).toBe(409);
    const payload = await json(response);
    expect(payload.message).toContain("مفوتر مسبقًا");
    expect(JSON.stringify(payload)).not.toMatch(/SELECT|plan_items|stack|Error:/i);
  });

  it("validation: bad key, bad tooth, bad case are Arabic 400s; doctors still cannot issue invoices", async () => {
    expect((await post("reception", { items: [{ serviceId: rctService, toothCode: 36 }], idempotencyKey: "bad key!" })).status).toBe(400);
    const tooth = await post("reception", { items: [{ serviceId: rctService, toothCode: 19 }] });
    expect(tooth.status).toBe(400);
    expect((await json(tooth)).message).toContain("السن");
    const kase = await post("reception", { items: [{ serviceId: rctService, toothCode: 36, caseId: "x" }] });
    expect(kase.status).toBe(400);
    expect((await post("doctorA", { items: [{ serviceId: rctService, toothCode: 36 }] })).status).toBe(403);
  });

  it("an RCT line on tooth 36 links to a new endo case; a description-only line stays financial", async () => {
    const response = await post("admin", { items: [{ serviceId: rctService, toothCode: 36 }, { description: "رسوم ملف", price: "1000" }] });
    expect(response.status).toBe(201);
    const payload = await json(response) as { clinical: { links: { kind: string; specialty: string | null; caseId: number | null }[] } };
    expect(payload.clinical.links.map((l) => l.kind)).toEqual(["clinical", "financial"]);
    expect(payload.clinical.links[0].specialty).toBe("endodontics");
    const { rows } = await db.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE action = 'invoice.create' AND details::text LIKE '%الربط_بالعلاج%' ORDER BY id DESC LIMIT 1`);
    expect(rows).toHaveLength(1);
  });
});
