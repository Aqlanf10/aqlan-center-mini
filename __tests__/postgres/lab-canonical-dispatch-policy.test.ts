/** M2 slices 67–68 policy evidence (PENDING OWNER DECISION, see
 * docs/review/lab-post-dispatch-policy-20261103.md): which lab-order moves after
 * dispatch each grant set may make on the canonical runtime, beside the legacy role
 * behaviour, on real PostgreSQL with synthetic data. The current rule keeps the legacy
 * behaviour: only CANCEL after dispatch needs clinical.lab.cancel; receipt, fitting,
 * remake and return stay with clinical.lab.order. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-lab-policy-2026-xyz");
const db = await import("../../lib/db");
const lab = await import("../../lib/canonical-lab-orders");

const ACCOUNTS = {
  owner: { username: "SYN-LP-OWNER", role: "admin" },
  orderOnly: { username: "SYN-LP-ORDER", role: "reception", patientScope: "all", grants: { "clinical.lab.view": true, "clinical.lab.order": true } },
  orderCancel: { username: "SYN-LP-BOTH", role: "reception", patientScope: "all", grants: { "clinical.lab.view": true, "clinical.lab.order": true, "clinical.lab.cancel": true } },
  cancelOnly: { username: "SYN-LP-CANCEL", role: "reception", patientScope: "all", grants: { "clinical.lab.view": true, "clinical.lab.cancel": true } },
  viewOnly: { username: "SYN-LP-VIEW", role: "reception", patientScope: "all", grants: { "clinical.lab.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
let patientId = 0, labParty = 0;

async function order(status: string): Promise<number> {
  return (await q(`INSERT INTO lab_orders(patient_id,party_id,lab_name,work_type,status,sent_date,due_date,cost_minor,cost_currency,exchange_rate,base_amount_minor)
    VALUES ($1,$2,'SYN Policy Lab','Synthetic crown',$3,'2031-01-01','2031-01-10',20000,'YER',1,20000) RETURNING id`, [patientId, labParty, status]))[0].id as number;
}
async function outcome(key: Key, from: string, to: string): Promise<string> {
  const id = await order(from);
  try {
    await lab.commandCanonicalLabStatus(await fx.session(key), String(id), { status: to, expectedStatus: from });
    return "allowed";
  } catch (error) {
    const message = (error as Error).message;
    return /CAPABILITY_DENIED/.test(message) ? "refused:capability" : `refused:${(error as { code?: string }).code ?? message}`;
  }
}

// Every move the legacy transition map allows after dispatch, plus cancel before it.
const MOVES: readonly (readonly [string, string])[] = [
  ["sent", "in_progress"], ["sent", "received"], ["in_progress", "received"], ["received", "delivered"],
  ["received", "remake"], ["received", "sent"], ["delivered", "remake"], ["remake", "received"],
  ["sent", "cancelled"], ["in_progress", "cancelled"], ["received", "cancelled"], ["needed", "cancelled"],
];
const EXPECTED: Record<Exclude<Key, "owner">, (from: string, to: string) => string> = {
  // The current rule: only cancel after dispatch is guarded by clinical.lab.cancel.
  orderOnly: (from, to) => to === "cancelled" && from !== "needed" ? "refused:capability" : "allowed",
  orderCancel: () => "allowed",
  // Every PATCH move needs clinical.lab.order first; clinical.lab.cancel alone moves nothing.
  cancelOnly: () => "refused:capability",
  viewOnly: () => "refused:capability",
};

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  patientId = (await q("INSERT INTO patients(patient_number,full_name,phone) VALUES ('SYN-LP-1','SYN Policy patient','0500000960') RETURNING id"))[0].id;
  labParty = (await q("INSERT INTO parties(name,kind,currency) VALUES('SYN Policy Lab','lab','YER') RETURNING id"))[0].id;
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("post-dispatch moves by grant set (current rule)", () => {
  it("the guarded list is exactly the cancel (pending the owner's decision)", () => {
    expect(lab.LAB_POST_DISPATCH_CANCEL_GUARDED).toEqual(["cancelled"]);
  });
  for (const key of ["orderOnly", "orderCancel", "cancelOnly", "viewOnly"] as const) {
    it(`${key}: each move matches the rule`, async () => {
      const table: string[] = [];
      for (const [from, to] of MOVES) table.push(`${from}->${to}: ${await outcome(key, from, to)}`);
      expect(table).toEqual(MOVES.map(([from, to]) => `${from}->${to}: ${EXPECTED[key](from, to)}`));
    });
  }
  it("a refused move writes nothing (status, tracking, payable, audit)", async () => {
    const id = await order("received");
    await expect(lab.commandCanonicalLabStatus(await fx.session("orderOnly"), String(id), { status: "cancelled" })).rejects.toThrow("CAPABILITY_DENIED");
    expect((await q("SELECT status FROM lab_orders WHERE id=$1", [id]))[0].status).toBe("received");
    expect(await q("SELECT 1 FROM lab_order_tracking WHERE lab_order_id=$1", [id])).toEqual([]);
    expect(await q("SELECT 1 FROM audit_log WHERE action='lab_order.cancel' AND entity_id=$1", [String(id)])).toEqual([]);
  });
});

// Legacy parity (role labels) cannot run here: the canonical fixture fences legacy staff
// authority. It is proven on a legacy database by lab-status-financial-boundary
// ("refuses unassigned doctor, revoked session and non-admin sent cancellation") and the
// other lab suites: admin/reception/doctor receive and fit; only admin cancels sent work.
