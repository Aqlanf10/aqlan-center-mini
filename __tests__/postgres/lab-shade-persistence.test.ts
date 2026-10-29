import { afterAll, beforeAll, expect, it } from "vitest";
import { validatePostgresTestTarget } from "./_safe-target";
import { stubPostgresEnv } from "./_setup";
import type { SessionPayload } from "../../lib/auth";
import type { LabShadeSpecification } from "../../lib/lab-shades";
import { LAB_SHADE_SPECIFICATION_SQL } from "../../lib/lab-shade-schema";
import { applyRuntimeMigrationFiles, checksumOf } from "../../lib/migrations";
validatePostgresTestTarget(process.env); stubPostgresEnv();
const db = await import("../../lib/db");
const q = async (sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows;
const session: SessionPayload = { userId: 1, username: "synthetic-shade-admin", role: "admin", credentialVersion: "synthetic", expiresAt: Date.now() + 3600000 };
const shade = (code = "A2"): LabShadeSpecification => ({ version: 1, teeth: [{ toothCode: 11, cervical: null, body: { guide: "vita_classical", code }, incisal: { guide: "vita_3d_master", code: "0M3" } }] });
let serial = 0;
beforeAll(async () => { await db.ensureSchema(); }, 180000);
afterAll(async () => { await db.resetPoolForTesting(); });
async function fixture(value: LabShadeSpecification | null = shade()) {
 const n = ++serial;
 const [patient] = await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic shade patient') RETURNING id", [`SHADE-${Date.now()}-${n}`]);
 const order = await db.createLabOrder({ patientId: patient.id, partyId: null, labName: "Synthetic shade lab", labPhone: null, workType: "Synthetic crown", details: null, sentDate: "2026-10-28", dueDate: "2026-11-01", note: null, costMinor: 1000, costCurrency: "YER", baseCurrency: "YER", exchangeRate: 1, createdBy: session.username, actorRole: session.role, toothNumbers: "11(Crown)", shade: "OM3", shadeSpecification: value });
 expect(order).not.toBeNull(); return order!;
}
const audits = (id: number) => q("SELECT * FROM audit_log WHERE action='lab_order.shade' AND entity_id=$1 ORDER BY id", [String(id)]);
it("persists structured creation, legacy shade and priced payable without binding regressions", async () => {
 const order = await fixture();
 expect(order.shadeSpecification).toEqual(shade()); expect(order.shade).toBe("OM3");
 expect((await db.getLabOrderById(order.id))?.shadeSpecification).toEqual(shade());
 expect(await q("SELECT amount_minor FROM payables WHERE lab_order_id=$1", [order.id])).toEqual([{ amount_minor: "1000" }]);
});
it("audits edits atomically without changing finance or legacy columns", async () => {
 const order = await fixture(null);
 const before = await q("SELECT shade,tooth_numbers,cost_minor,cost_currency,payable_id FROM lab_orders WHERE id=$1", [order.id]);
 expect(await db.updateLabOrderShades(order.id, { shadeSpecification: shade(), expectedShadeSpecification: null, session })).toBe("updated");
 expect(await q("SELECT shade,tooth_numbers,cost_minor,cost_currency,payable_id FROM lab_orders WHERE id=$1", [order.id])).toEqual(before);
 const audit = await audits(order.id); expect(audit).toHaveLength(1); expect(audit[0].actor).toBe(session.username);
 expect(audit[0].details).toMatchObject({ previous: null, current: shade() });
});
it("two connections editing the same observed value admit exactly one update and audit", async () => {
 const order = await fixture();
 const results = await Promise.all(["A1", "A3"].map(code => db.updateLabOrderShades(order.id, { shadeSpecification: shade(code), expectedShadeSpecification: shade(), session })));
 expect(results.sort()).toEqual(["conflict", "updated"]); expect(await audits(order.id)).toHaveLength(1);
 expect(["A1", "A3"]).toContain((await db.getLabOrderById(order.id))?.shadeSpecification?.teeth[0].body?.code);
});
it("audit failure rolls back the clinical update", async () => {
 const order = await fixture();
 await q("CREATE FUNCTION synthetic_shade_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='lab_order.shade' THEN RAISE EXCEPTION 'synthetic shade audit fault'; END IF; RETURN NEW; END $$");
 await q("CREATE TRIGGER synthetic_shade_audit_fault BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_shade_audit_fault()");
 try { await expect(db.updateLabOrderShades(order.id, { shadeSpecification: shade("A1"), expectedShadeSpecification: shade(), session })).rejects.toThrow("synthetic shade audit fault"); }
 finally { await q("DROP TRIGGER synthetic_shade_audit_fault ON audit_log"); await q("DROP FUNCTION synthetic_shade_audit_fault()"); }
 expect((await db.getLabOrderById(order.id))?.shadeSpecification).toEqual(shade()); expect(await audits(order.id)).toHaveLength(0);
});
it("refuses unselected teeth, denied roles and expired access without mutation", async () => {
 const order = await fixture();
 const invalid = shade(); invalid.teeth[0].toothCode = 21;
 expect(await db.updateLabOrderShades(order.id, { shadeSpecification: invalid, expectedShadeSpecification: shade(), session })).toBe("invalid");
 expect(await db.updateLabOrderShades(order.id, { shadeSpecification: null, expectedShadeSpecification: shade(), session: { ...session, role: "assistant" } })).toBe("forbidden");
 expect(await db.updateLabOrderShades(order.id, { shadeSpecification: null, expectedShadeSpecification: shade(), session: { ...session, expiresAt: 0 } })).toBe("forbidden");
 expect((await db.getLabOrderById(order.id))?.shadeSpecification).toEqual(shade()); expect(await audits(order.id)).toHaveLength(0);
});
it("enforces the SQL constraint and reapplies the migration without changing its registry", async () => {
 const order = await fixture();
 await expect(q("UPDATE lab_orders SET shade_specification=$2::jsonb WHERE id=$1", [order.id, JSON.stringify({ ...shade(), version: 2 })])).rejects.toThrow("lab_orders_shade_specification_valid");
 const before = await q("SELECT * FROM schema_migrations WHERE version='0089'");
 await applyRuntimeMigrationFiles(db.getPool(), [{ version: "0089", name: "lab_shade_specification", filename: "0089_lab_shade_specification.sql", sql: LAB_SHADE_SPECIFICATION_SQL, checksum: checksumOf(LAB_SHADE_SPECIFICATION_SQL) }]);
 expect(await q("SELECT * FROM schema_migrations WHERE version='0089'")).toEqual(before); expect(before).toHaveLength(1);
 expect((await db.getLabOrderById(order.id))?.shadeSpecification).toEqual(shade());
});
it("copies structured and legacy shades to a remake without guessing or dropping zones", async () => {
 const original = await fixture();
 const remake = await db.createLabOrderRemake(original.id, { remakeReason: "Synthetic shade remake", newDueDate: "2026-11-04", actor: session.username, actorRole: session.role });
 expect(remake).not.toBeNull(); expect(remake?.shadeSpecification).toEqual(shade()); expect(remake?.shade).toBe("OM3");
 expect(remake?.toothNumbers).toBe("11(Crown)");
 expect((await db.getLabOrderById(original.id))?.shadeSpecification).toEqual(shade());
});
