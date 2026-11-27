import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { validatePostgresTestTarget } from "./_safe-target";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import type { LabOrderStatus } from "../../lib/lab";

// Check the original environment before stubPostgresEnv can remove hosted markers.
assertRealPostgresUrl();
const target = validatePostgresTestTarget(process.env, { allowDatabaseUrlFallback: true });
stubPostgresEnv();
const db = await import("../../lib/db");

const ACTOR = "synthetic-lab-worklist-operator";
const LAB = "Synthetic worklist lab";
const CATEGORY = "Synthetic worklist cost category";
const EXPENSE_ACCOUNT = "5101";

const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> =>
  (await db.getPool().query<T>(sql, values)).rows;
const id = async (sql: string, values: unknown[] = []) => (await q<{ id: number }>(sql, values))[0].id;

beforeAll(async () => {
  await dropPublicSchema(target.testUrl.toString());
  await db.ensureSchema();
});
beforeEach(async () => {
  await q("TRUNCATE lab_order_tracking, lab_orders RESTART IDENTITY CASCADE");
});
afterAll(async () => { await db.resetPoolForTesting(); });

async function seedCrowdedWorklist(label: string) {
  const archivedPatient = await id(`INSERT INTO patients(patient_number, full_name)
    VALUES ($1, 'Synthetic archived worklist patient') RETURNING id`, [`LAB-ARCHIVE-${label}`]);
  const patientId = await id(`INSERT INTO patients(patient_number, full_name)
    VALUES ($1, 'Synthetic active worklist patient') RETURNING id`, [`LAB-ACTIVE-${label}`]);
  const partyId = await id(`INSERT INTO parties(name,kind,currency,expense_account_code)
    VALUES ($1,'lab','YER','5901') RETURNING id`, [`${LAB} ${label}`]);
  const categoryId = await id(`INSERT INTO expense_categories(key,name,account_code)
    VALUES ($1,$2,$3) RETURNING id`, [`synthetic-worklist-${label}`, CATEGORY, EXPENSE_ACCOUNT]);
  const archived = await q<{ id: number }>(`INSERT INTO lab_orders
    (patient_id, lab_name, party_id, work_type, sent_date, due_date, status, delivered_at, expense_category_id)
    SELECT $1, $2, $3, 'Synthetic crown', DATE '1999-12-01', DATE '2000-01-01',
      CASE WHEN n=300 THEN 'cancelled' ELSE 'delivered' END,
      CASE WHEN n=300 THEN NULL ELSE NOW()-INTERVAL '90 days' END, $4
    FROM generate_series(1,300) AS n RETURNING id`, [archivedPatient, LAB, partyId, categoryId]);
  return { archivedPatient, patientId, partyId, categoryId, archivedIds: archived.map((row) => row.id).sort((a,b)=>b-a) };
}

async function financialSnapshot(partyId: number, orderId: number) {
  return {
    originalMoney: await q(`SELECT payable_id, cost_minor, cost_currency, base_amount_minor, exchange_rate, financial_status
      FROM lab_orders WHERE id=$1`, [orderId]),
    payables: await q("SELECT * FROM payables WHERE party_id=$1 OR lab_order_id=$2 ORDER BY id", [partyId, orderId]),
    expenses: await q("SELECT * FROM expenses ORDER BY id"),
    allocations: await q("SELECT * FROM expense_payable_allocations ORDER BY id"),
    journalEntries: await q("SELECT * FROM journal_manual ORDER BY id"),
    journalLines: await q("SELECT * FROM journal_manual_lines ORDER BY id"),
    canonical: (await db.partyDueByCurrency()).filter((row) => row.partyId === partyId),
  };
}

describe("recent and actionable laboratory worklist", () => {
  it("filters before the cap, retaining expense-category identity and explicit archive queries", async () => {
    const f = await seedCrowdedWorklist("window");
    const statusMatrix = [
      {status:"sent", age:null}, {status:"needed", age:null},
      {status:"in_progress", age:null}, {status:"received", age:null},
      {status:"delivered", age:29}, {status:"delivered", age:31}, {status:"remake", age:null},
    ] as const satisfies ReadonlyArray<{ status:LabOrderStatus; age:number|null }>;
    const selectedIds: {id:number; status:LabOrderStatus}[] = [];
    for (const [index, row] of statusMatrix.entries()) {
      const orderId = await id(`INSERT INTO lab_orders
        (patient_id, lab_name, party_id, work_type, sent_date, due_date, status, delivered_at, expense_category_id)
        VALUES($1,$2,$3,'Synthetic crown',DATE '2001-01-01',DATE '2002-01-01' + $4::int,
          $5,NOW()-make_interval(days => $6::int),$7) RETURNING id`,
      [f.patientId, LAB, f.partyId, index, row.status, row.age, f.categoryId]);
      selectedIds.push({id:orderId,status:row.status});
    }
    const expected = selectedIds.filter((_,index)=>index!==5);
    for (const filters of [undefined, { limit:300 }, { limit:2 }]) {
      const list = await db.listLabOrders(filters);
      expect.soft(list.map(({id,status})=>({id,status}))).toEqual(expected.slice(0, filters?.limit));
      expect.soft(list.every((row)=>row.expenseCategoryId===f.categoryId
        && row.expenseCategoryName===CATEGORY && row.expenseAccountCode===EXPENSE_ACCOUNT)).toBe(true);
    }
    const history = await db.listLabOrders({patientId:f.archivedPatient});
    expect(history.map((row)=>row.id)).toEqual(f.archivedIds);
    expect(history[0]).toMatchObject({status:"cancelled",expenseCategoryName:CATEGORY,expenseAccountCode:EXPENSE_ACCOUNT});
    expect((await db.listLabOrders({status:"delivered",limit:1}))[0].id).toBe(f.archivedIds[1]);
    expect((await db.listLabOrders({status:"active"})).map((row)=>row.id))
      .toEqual(selectedIds.filter((row)=>row.status!=="delivered").map((row)=>row.id));
    expect((await db.listLabOrders({patientId:f.patientId})).map((row)=>row.id)).toEqual(selectedIds.map((row)=>row.id));
  });

  it("keeps the single still-active remake visible and does not create or modify its original payable", async () => {
    const f = await seedCrowdedWorklist("remake");
    const order = await db.createLabOrder({
      patientId:f.patientId, partyId:f.partyId, labName:LAB, labPhone:null, workType:"Synthetic crown",
      details:null, note:null, sentDate:"2001-01-01", dueDate:"2002-01-01", toothNumbers:"14",
      status:"sent", source:"manual", expenseCategoryId:f.categoryId, isPosted:true,
      costMinor:400, costCurrency:"YER", baseCurrency:"YER", exchangeRate:1, createdBy:ACTOR, actorRole:"admin",
    });
    if (!order?.payableId) throw new Error("Synthetic worklist fixture must start with a posted payable");
    const context = {actor:ACTOR,actorRole:"admin"};
    await db.setLabOrderStatus(order.id,"received",context);
    const before = await financialSnapshot(f.partyId,order.id);
    expect(before.payables).toHaveLength(1);
    expect(before.payables[0]).toMatchObject({id:order.payableId,amount_minor:"400",currency:"YER"});
    expect(before.canonical).toEqual([expect.objectContaining({partyId:f.partyId,currency:"YER",dueMinor:400})]);

    expect.soft((await db.listLabOrders()).map((row)=>row.id)).toEqual([order.id]);
    const remade = await db.setLabOrderStatus(order.id,"remake",context);
    expect(remade).toMatchObject({id:order.id,status:"remake",deliveredAt:null,payableId:order.payableId});
    const open = await db.listLabOrders();
    expect.soft(open.map(({id,status})=>({id,status}))).toEqual([{id:order.id,status:"remake"}]);
    expect.soft(open.find((row)=>row.id===order.id) ?? null).toEqual(expect.objectContaining({
      expenseCategoryId:f.categoryId,expenseCategoryName:CATEGORY,expenseAccountCode:EXPENSE_ACCOUNT,
    }));
    for (const status of ["remake","active"] as const) {
      expect((await db.listLabOrders({status})).map((row)=>row.id)).toEqual([order.id]);
    }
    expect(await financialSnapshot(f.partyId,order.id)).toEqual(before);

    expect(await db.setLabOrderStatus(order.id,"received",context)).toMatchObject({id:order.id,status:"received"});
    expect(await db.listLabOrders({status:"remake"})).toEqual([]);
    expect.soft((await db.listLabOrders({limit:300})).map(({id,status})=>({id,status})))
      .toEqual([{id:order.id,status:"received"}]);
    expect(await q("SELECT id FROM lab_orders WHERE patient_id=$1 ORDER BY id",[f.patientId])).toEqual([{id:order.id}]);
    expect(await q(`SELECT from_status,to_status FROM lab_order_tracking
      WHERE lab_order_id=$1 AND action='status_change' ORDER BY id`,[order.id])).toEqual([
      {from_status:"sent",to_status:"received"},
      {from_status:"received",to_status:"remake"},
      {from_status:"remake",to_status:"received"},
    ]);
    expect(await financialSnapshot(f.partyId,order.id)).toEqual(before);
  });
});
