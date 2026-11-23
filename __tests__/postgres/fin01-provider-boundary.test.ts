import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
import { DEFAULT_SPECIALTY_TEMPLATES } from "../../lib/specialty-templates";

assertRealPostgresUrl();
stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_p1_fin01");
process.env.TEST_DATABASE_URL = process.env.DATABASE_URL;

const { ensureSchema, getPool, resetPoolForTesting, createPlanV2 } = await import("../../lib/db");
const { createLinkedInvoice, previewInvoiceLinkage } = await import("../../lib/invoice-linkage-db");
type Input = Parameters<typeof createLinkedInvoice>[0];
type Line = Input["items"][number];

const categories = [
  ["ortho", null, "both"], ["rct", 36, null], ["post", 14, null], ["crown", 26, null],
  ["bridge", 14, null], ["implant", 36, null], ["cleaning", null, "full_mouth"],
  ["extraction", 46, null], ["surgery", 38, null], ["veneer", 11, null], ["whitening", null, null],
  ["filling", 26, null], ["sealant", 16, null],
] as const;
const fixture = "fin01-postgres-ordinary";
const price = 10_000;
const services = new Map<string, number>();
let primary = 0;
let physician = 0;
let ordinal = 0;

async function rows<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await getPool().query<T>(sql, params)).rows;
}
beforeAll(async () => {
  await ensureSchema();
  const doctors = await rows<{ id: number }>(
    "INSERT INTO parties(kind, name) VALUES ('doctor','Synthetic primary'),('doctor','Synthetic treating doctor') RETURNING id");
  primary = doctors[0].id;
  physician = doctors[1].id;
  for (const category of [...categories.map(([name]) => name), "consultation", "xray"]) {
    const [{ id }] = await rows<{ id: number }>(
      "INSERT INTO services(name, category, price_minor, is_active, price_configured) VALUES($1,$1,$2,true,true) RETURNING id",
      [category, price]);
    services.set(category, id);
  }
});
afterAll(async () => { await resetPoolForTesting(); });

async function patient() {
  return (await rows<{ id: number }>(
    "INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES ($1,'Synthetic FIN01', $2) RETURNING id",
    [`FIN01-PG-${++ordinal}`, primary]))[0].id;
}
function line(category: string | null, toothCode: number | null = null, scope: string | null = null,
  doctorId: number | null = null): Line {
  return { serviceId: category ? services.get(category)! : null, category, description: category ?? "رسوم ملف",
    quantity: 1, unitPriceMinor: price, doctorId, toothCode, caseId: null, scope, sessions: null,
    surfaces: category === "filling" ? "O" : null, episodeTeeth: category === "bridge" ? [14, 15, 16] : null };
}
function command(patientId: number, items: Line[], override: Partial<Input> = {}): Input {
  return { patientId, items, baseCurrency: "YER", discountMinor: 0, note: null, createdBy: fixture,
    actorRole: "reception", templates: DEFAULT_SPECIALTY_TEMPLATES, idempotencyKey: null,
    requestHash: null, auditDetails: {}, ...override };
}
async function footprint(patientId: number) {
  return (await rows(`SELECT
    (SELECT count(*)::int FROM invoices WHERE patient_id=$1) AS invoices,
    (SELECT count(*)::int FROM invoice_items ii JOIN invoices i ON i.id=ii.invoice_id WHERE i.patient_id=$1) AS invoice_items,
    (SELECT count(*)::int FROM treatment_plans WHERE patient_id=$1) AS plans,
    (SELECT count(*)::int FROM plan_items pi JOIN treatment_plans t ON t.id=pi.plan_id WHERE t.patient_id=$1) AS plan_items,
    (SELECT count(*)::int FROM clinical_cases WHERE patient_id=$1) AS cases,
    (SELECT count(*)::int FROM payments WHERE patient_id=$1) AS payments,
    (SELECT count(*)::int FROM audit_log WHERE actor=$2) AS command_audits,
    (SELECT row(last_value,is_called)::text FROM invoice_number_seq) AS invoice_sequence`, [patientId, fixture]))[0];
}
async function exactItem(patientId: number, doctorId: number | null) {
  const serviceId = services.get("filling")!;
  const plan = await createPlanV2({
    patientId, title: "Synthetic existing dated item", specialty: null, primaryDoctorId: primary,
    billingMode: "per_procedure", baseCurrency: "YER", startDate: "2026-10-01", note: null,
    createdBy: "fin01-pg-fixture", installments: [], items: [{ serviceId, serviceName: "filling", category: "filling",
      toothCode: 26, surfaces: "O", quantity: 1, unitPriceMinor: price, billingRule: "on_completion", sessionCount: 1, note: null }],
  });
  if (!plan.ok) throw new Error(plan.message);
  const [{ id }] = await rows<{ id: number }>("SELECT id FROM plan_items WHERE plan_id=$1", [plan.planId]);
  await rows("UPDATE plan_items SET doctor_id=$1 WHERE id=$2", [doctorId, id]);
  return { itemId: id, planId: plan.planId };
}

describe("FIN01 future clinical writes, synthetic PostgreSQL", () => {
  it.each(categories)("%s demands its own physician before any new number, invoice, clinical row or audit", async (category, tooth, scope) => {
    const patientId = await patient();
    const items = category === "bridge"
      ? [14, 15, 16].map((member) => line(category, member, scope))
      : [line(category, tooth, scope)];
    const cmd = command(patientId, [line("consultation"), ...items]);
    const before = await footprint(patientId);
    const preview = await previewInvoiceLinkage(cmd);
    expect(preview[0]).toMatchObject({ kind: "financial", refusal: null });
    expect(preview[1]).toMatchObject({ kind: "clinical", refusal: "provider_required", financialReviewRequired: true });
    expect(await createLinkedInvoice(cmd)).toEqual({ ok: false, reason: "provider_required", line: 1 });
    expect(await footprint(patientId)).toEqual(before);
  });

  it("uses the exact matched work item’s physician, not patient/plan primary; an explicit conflict never writes", async () => {
    const patientId = await patient();
    const { itemId, planId } = await exactItem(patientId, physician);
    const item = { ...line("filling", 26), planItemId: itemId };
    const before = await footprint(patientId);
    const conflict = command(patientId, [{ ...item, doctorId: primary }], { existingPlanId: planId });
    expect((await previewInvoiceLinkage(conflict))[0].refusal).toBe("bad_provider");
    expect(await createLinkedInvoice(conflict)).toEqual({ ok: false, reason: "bad_provider", line: 0 });
    expect(await footprint(patientId)).toEqual(before);

    const cmd = command(patientId, [item], { existingPlanId: planId });
    expect((await previewInvoiceLinkage(cmd))[0]).toMatchObject({ refusal: null, item: { mode: "existing", id: itemId } });
    const result = await createLinkedInvoice(cmd);
    if (!result.ok) throw new Error(result.reason);
    expect(result.links[0]).toMatchObject({ planItemId: itemId, planItemCreated: false });
    expect(await rows("SELECT doctor_id,plan_item_id FROM invoice_items WHERE invoice_id=$1", [result.invoice.id]))
      .toEqual([{ doctor_id: physician, plan_item_id: itemId }]);
  });

  it("will not guess the physician when the exact existing work item is unassigned", async () => {
    const patientId = await patient();
    const { itemId, planId } = await exactItem(patientId, null);
    const cmd = command(patientId, [{ ...line("filling", 26), planItemId: itemId }], { existingPlanId: planId });
    const before = await footprint(patientId);
    expect((await previewInvoiceLinkage(cmd))[0].refusal).toBe("provider_required");
    expect(await createLinkedInvoice(cmd)).toEqual({ ok: false, reason: "provider_required", line: 0 });
    expect(await footprint(patientId)).toEqual(before);
    expect(await rows("SELECT doctor_id,billing_status FROM plan_items WHERE id=$1", [itemId]))
      .toEqual([{ doctor_id: null, billing_status: "unbilled" }]);
  });

  it("preserves an exactly replayed historical physician-less clinical obligation byte for byte", async () => {
    const patientId = await patient();
    const { itemId } = await exactItem(patientId, null);
    const historical = command(patientId, [line("filling", 26)], {
      idempotencyKey: "fin01:historic:fixture", requestHash: "synthetic-immutable-command-legacy",
    });
    const [{ id }] = await rows<{ id: number }>(`INSERT INTO invoices
      (invoice_number,patient_id,total_minor,created_by,idempotency_key,idempotency_request_hash,created_at)
      VALUES('SYNTHETIC-HISTORY-01',$1,$2,$3,$4,$5,'2026-10-01T09:00:00Z') RETURNING id`,
    [patientId, price, fixture, historical.idempotencyKey, historical.requestHash]);
    await rows(`INSERT INTO invoice_items
      (invoice_id,service_id,description,quantity,unit_price_minor,total_minor,doctor_id,plan_item_id,source_type,source_id)
      VALUES($1,$2,'filling',1,$3,$3,NULL,$4,'plan_item',$5)`, [id, services.get("filling"), price, itemId, itemId]);
    await rows(`UPDATE plan_items SET billing_status='needs_financial_review',billed_invoice_id=$1 WHERE id=$2`, [id, itemId]);

    const snapshot = async () => (await rows(`SELECT row_to_json(i)::text AS header, row_to_json(ii)::text AS line,
        row_to_json(pi)::text AS linked FROM invoices i JOIN invoice_items ii ON ii.invoice_id=i.id
        JOIN plan_items pi ON pi.id=ii.plan_item_id WHERE i.id=$1`, [id]))[0];
    const prior = await snapshot();
    const before = await footprint(patientId);
    const replayed = await createLinkedInvoice(historical);
    expect(replayed).toMatchObject({ ok: true, replayed: true, invoice: { id },
      links: [{ kind: "clinical", planItemId: itemId }] });
    expect(await createLinkedInvoice(command(patientId, [line("filling", 26, null, physician)])))
      .toEqual({ ok: false, reason: "needs_financial_review", line: 0 });
    expect(await footprint(patientId)).toEqual(before);
    expect(await snapshot()).toEqual(prior);
  });
});
