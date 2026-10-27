/** Synthetic trusted-ready runtime evidence ONLY. This setup proves no operator,
 * owner bootstrap, source recovery or real account activation authority. */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { randomBytes, randomUUID, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { assertRealPostgresUrl } from "./_setup";
import { staffIdentitySubstrateSql } from "../../lib/staff-identity-substrate-schema.mjs";
import { initializeStaffIdentitySubstrate, bindStaffAccountIncarnation } from "../../lib/staff-identity-substrate.mjs";
import { staffRuntimeSchemaSql } from "../../lib/staff-runtime-schema.mjs";
import { sessionCredentialVersion } from "../../lib/auth";
import { readVerifiedDurableSession } from "../../lib/staff-durable-session";
import { withStaffOperation, staffOperationIdentity, staffOperationReferenceCapabilities, type StaffOperationHandle } from "../../lib/staff-operation-runtime";
import { commandCanonicalInventoryItemCreate, readCanonicalInventoryReferences } from "../../lib/inventory-domain/reference-setup";
import { PURCHASE_RESET_FENCE } from "../../lib/clinic-reset";
import { STAFF_AUTHORIZATION_POLICY_VERSION } from "../../lib/staff-capability-catalogue";
import { INVENTORY_PROCUREMENT_SQL } from "../../lib/inventory-domain/schema-proposal";
import { INVENTORY_COMMAND_LIFECYCLE_SQL } from "../../lib/inventory-domain/command-lifecycle-schema-proposal";
import { runCanonicalInventoryItemCreateLifecycle } from "../../lib/inventory-domain/command-lifecycle";
import { REFERENCE_PROTOCOL, type ReferenceIntent, type ReferenceInput } from "../../lib/inventory-reference-protocol";
import type { DbPool } from "../../lib/db";
assertRealPostgresUrl();
const schema = `aqlan_identity_${randomBytes(8).toString("hex")}`;
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, ssl: false, max: 10, options: `-c search_path=${schema},pg_catalog` });
const doc = (grants: Record<string, boolean>) => ({ schemaVersion: 1, revision: 1, patientScope: "none", appointmentScope: "none", grants });
function sign(payload: unknown) { const body = Buffer.from(JSON.stringify(payload)).toString("base64url"); return `${body}.${createHmac("sha256", process.env.SESSION_SECRET!).update(body).digest("base64url")}`; }
async function claims(userId = 2) {
    const { rows: [r] } = await pool.query(`SELECT u.id,u.username,u.password_hash,u.authorization_epoch::text,u.permissions,u.party_id,p.clinical_authority_epoch::text,
 h.realm_id::text,h.generation_id::text,h.registry_revision::text,c.binding_epoch::text,b.subject_id::text
 FROM ${schema}.users u CROSS JOIN ${schema}.staff_identity_state h CROSS JOIN ${schema}.staff_authority_control c
 JOIN ${schema}.staff_identity_current b ON b.user_id=$1 LEFT JOIN ${schema}.parties p ON p.id=u.party_id WHERE u.id=$1`, [userId]);
    return { userId: r.id, username: r.username, expiresAt: Date.now() + 60000, durableIdentity: { schemaVersion: 2, policyVersion: STAFF_AUTHORIZATION_POLICY_VERSION, realmId: r.realm_id, subjectId: r.subject_id, generationId: r.generation_id, registryRevision: r.registry_revision, controlEpoch: r.binding_epoch, accountEpoch: r.authorization_epoch, permissionRevision: r.permissions.revision, credentialVersion: sessionCredentialVersion(r.password_hash), provider: r.party_id === null ? null : { partyId: r.party_id, clinicalEpoch: r.clinical_authority_epoch } } };
}
async function session(userId = 2) {
    const handle = readVerifiedDurableSession(sign(await claims(userId)));
    if (!handle)
        throw new Error("synthetic token fixture invalid");
    return handle;
}
async function waitForBlockedBy(holderPid: number) {
    const deadline = performance.now() + 3000;
    while (performance.now() < deadline) {
        const { rows } = await pool.query<{
            pid: number;
        }>("SELECT pid FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid))", [holderPid]);
        if (rows.length)
            return rows.map(r => r.pid);
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("real PostgreSQL blocking barrier was not observed");
}
const both = { "inventory.references.view": true, "inventory.items.create": true };
beforeAll(async () => {
    vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", "true");
    const c = await pool.connect();
    try {
        await c.query(`CREATE SCHEMA ${schema};SET search_path TO ${schema},pg_catalog`);
        await c.query(`CREATE TABLE ${schema}.parties(id INTEGER PRIMARY KEY,kind TEXT,name TEXT,is_active BOOLEAN);
   CREATE TABLE ${schema}.users(id INTEGER PRIMARY KEY,username TEXT,display_name TEXT,password_hash TEXT,role TEXT,is_active BOOLEAN,party_id INTEGER,permissions JSONB);
   CREATE TABLE ${schema}.inventory_items(id SERIAL PRIMARY KEY,name TEXT NOT NULL,category TEXT,unit TEXT,min_level NUMERIC,note TEXT,created_by TEXT,is_active BOOLEAN NOT NULL DEFAULT TRUE);
   CREATE TABLE ${schema}.inventory_movements(id INTEGER PRIMARY KEY);
   CREATE TABLE ${schema}.payables(id INTEGER PRIMARY KEY);
   CREATE TABLE ${schema}.audit_log(id BIGSERIAL PRIMARY KEY,action TEXT,entity TEXT,entity_id TEXT,summary TEXT,details JSONB,actor TEXT,actor_role TEXT,source_ip TEXT,user_agent TEXT,created_at TIMESTAMPTZ DEFAULT now());`);
        await c.query(readFileSync(new URL("../fixtures/staff-identity/frozen-0076.sql", import.meta.url), "utf8"));
        await c.query(staffIdentitySubstrateSql(schema));
        await c.query(`INSERT INTO ${schema}.parties(id,kind,is_active) VALUES(20,'doctor',TRUE)`);
        for (const [id, role, party, grants] of [[1, "admin", null, {}], [2, "doctor", 20, both], [3, "admin", null, {}], [4, "doctor", 20, { "inventory.references.view": true }], [5, "doctor", 20, { "inventory.items.create": true }], [6, "doctor", 20, {}]] as const)
            await c.query(`INSERT INTO ${schema}.users(id,username,role,is_active,password_hash,party_id,permissions) VALUES($1,$2,$3,TRUE,'synthetic-hash',$4,$5)`, [id, `synthetic-${id}`, role, party, JSON.stringify(doc(grants))]);
        await c.query("BEGIN");
        let h = await initializeStaffIdentitySubstrate(c, schema);
        for (const userId of [1, 2, 3, 4, 5, 6])
            h = await bindStaffAccountIncarnation(c, { userId, currentSubjectId: null, expected: { generationId: h.generationId, registryRevision: h.registryRevision } }, schema);
        await c.query("COMMIT");
        await c.query(staffRuntimeSchemaSql(schema));
        // Hypothetical trusted-ready fixture, NOT a provisioning/bootstrap API.
        await c.query("BEGIN");
        await c.query(`UPDATE ${schema}.users SET authorization_mode='canonical'`);
        await c.query(`UPDATE ${schema}.staff_authority_control SET state='prepared',pending_owner_user_id=1,conversion_digest=repeat('a',64),recovery_reference='synthetic-item-evidence-not-bootstrap' WHERE singleton`);
        await c.query(`UPDATE ${schema}.staff_authority_control SET state='active',owner_user_id=1,pending_owner_user_id=NULL WHERE singleton`);
        await c.query("COMMIT");
        await c.query(`UPDATE ${schema}.staff_identity_state SET status='ready',ready_owner_subject_id=(SELECT subject_id FROM ${schema}.staff_identity_current WHERE user_id=1),ready_control_epoch=(SELECT binding_epoch FROM ${schema}.staff_authority_control) WHERE singleton`);
        // Install complete reviewed proposals, including append-only and terminal guards.
        await c.query(INVENTORY_PROCUREMENT_SQL);
        await c.query(INVENTORY_COMMAND_LIFECYCLE_SQL);
    }
    finally {
        c.release();
    }
});
afterAll(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end(); });
async function intent(id = 2): Promise<ReferenceIntent> {
    const p = await claims(id);
    return Object.freeze({ protocol: REFERENCE_PROTOCOL, nonce: randomUUID(), authority: Object.freeze({ realmId: p.durableIdentity.realmId, subjectId: p.durableIdentity.subjectId, generation: p.durableIdentity.generationId }), input: Object.freeze({ action: "item.create" as const, name: `Synthetic ${randomUUID()}`, category: "supply", baseUnit: "unit", basePrecision: 0, minLevel: "0", note: "Synthetic acceptance only", reason: "Explicit fixture item creation" }) });
}
const command = async (original: ReferenceIntent, mode: "admit" | "execute" | "lookup" | "retire", id = 2) => commandCanonicalInventoryItemCreate(pool, await session(id), original, mode, mode === "retire" ? "Synthetic explicit withdrawal" : undefined, schema);
async function snapshot() {
    const { rows: tables } = await pool.query<{
        tablename: string;
    }>("SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename", [schema]);
    const result: Record<string, unknown> = {};
    for (const { tablename } of tables)
        result[tablename] = (await pool.query(`SELECT to_jsonb(t) AS row FROM ${schema}."${tablename}" t ORDER BY to_jsonb(t)::text`)).rows;
    return result; // Sequences intentionally excluded: PostgreSQL sequence gaps do not roll back.
}
async function counts(original: ReferenceIntent) {
    const { rows: [r] } = await pool.query(`SELECT
 (SELECT count(*)::int FROM ${schema}.inventory_items WHERE name=$1) AS items,
 (SELECT count(*)::int FROM ${schema}.inventory_item_unit_versions v JOIN ${schema}.inventory_items i ON i.id=v.item_id WHERE i.name=$1) AS units,
 (SELECT count(*)::int FROM ${schema}.audit_log a JOIN ${schema}.inventory_items i ON i.id::text=a.entity_id WHERE i.name=$1 AND a.entity='inventory_reference') AS audits`, [original.input.action === "item.create" ? original.input.name : ""]);
    return r;
}
it.each([1, 2])("owner/delegated nonadmin %s creates one item and base unit with exact replay", async (id) => {
    const original = await intent(id), before = await snapshot();
    await expect(command(original, "execute", id)).rejects.toMatchObject({ code: "command_provenance_required" });
    expect(await snapshot()).toEqual(before);
    const admitted = await command(original, "admit", id);
    expect(admitted.status).toBe("admitted");
    const afterAdmission = await snapshot();
    expect(await command(original, "admit", id)).toEqual(admitted);
    expect(await snapshot()).toEqual(afterAdmission);
    expect(await counts(original)).toEqual({ items: 0, units: 0, audits: 0 });
    const committed = await command(original, "execute", id);
    expect(committed.status).toBe("committed");
    if (committed.status !== "committed")
        throw Error("Expected committed result");
    const after = await snapshot();
    for (const mode of ["admit", "execute", "lookup", "retire"] as const) {
        expect(await command(original, mode, id)).toEqual({ ...committed, result: { ...committed.result, replayed: true } });
        expect(await snapshot()).toEqual(after);
    }
    expect(await counts(original)).toEqual({ items: 1, units: 1, audits: 1 });
    expect((await pool.query(`SELECT entered_unit,base_unit,factor::text,entered_precision,base_precision FROM ${schema}.inventory_item_unit_versions WHERE item_id=$1`, [committed.result.id])).rows).toEqual([{ entered_unit: "unit", base_unit: "unit", factor: "1.000000000", entered_precision: 0, base_precision: 0 }]);
    expect((await pool.query(`SELECT actor_role FROM ${schema}.audit_log WHERE entity='inventory_reference' AND entity_id=$1`, [committed.result.id])).rows[0].actor_role).toBe(id === 1 ? "admin" : "doctor");
});
it.each([3, 4, 5, 6])("admin label, absent grant or missing prerequisite %s never authorizes any mode", async (id) => {
    const original = await intent(id), before = await snapshot();
    for (const mode of ["admit", "execute", "lookup", "retire"] as const)
        await expect(command(original, mode, id)).rejects.toThrow(/STAFF_OPERATION_/);
    expect(await snapshot()).toEqual(before);
});
it("reader advertises create only for owner or exact effective grant; DTO is not authority", async () => {
    for (const id of [1, 2, 4]) {
        const dto = await readCanonicalInventoryReferences(pool, await session(id), "", 0, schema);
        expect(dto.allowedActions).toEqual(id === 1 ? ["item.create", "unit.revise", "location.create"] : id === 4 ? [] : ["item.create"]);
        await expect(commandCanonicalInventoryItemCreate(pool, dto as never, await intent(id), "admit", undefined, schema)).rejects.toThrow(/SESSION/);
    }
});
it("adjacent valid reference inputs cannot enter the item-only facade", async () => {
    const original = await intent(), before = await snapshot();
    const inputs: ReferenceInput[] = [{ action: "location.create", id: "synthetic-place", label: "Synthetic", kind: "store", doctorPartyId: null, reason: "Synthetic attempt" }, { action: "policy.revise", expectedVersion: 0, limitMinor: 100, reason: "Synthetic attempt" }, { action: "unit.revise", itemId: 1, expectedVersion: 0, enteredUnit: "box", factor: "10", enteredPrecision: 0, basePrecision: 0, reason: "Synthetic attempt" }];
    for (const input of inputs)
        for (const mode of ["admit", "execute", "lookup", "retire"] as const)
            await expect(command({ ...original, input }, mode)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
});
it("same nonce changed payload conflicts in every mode without rewriting admission", async () => {
    const original = await intent();
    await command(original, "admit");
    const before = await snapshot();
    const changed = { ...original, input: { ...original.input, reason: "Changed immutable payload" } };
    for (const mode of ["admit", "execute", "lookup", "retire"] as const)
        await expect(command(changed, mode)).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(await snapshot()).toEqual(before);
    expect((await command(original, "execute")).status).toBe("committed");
});
it("retirement survives lost reply and prevents all later item writes", async () => {
    const original = await intent();
    await command(original, "admit");
    const retired = await command(original, "retire");
    expect(retired.status).toBe("retired");
    const before = await snapshot();
    for (const mode of ["admit", "execute", "lookup", "retire"] as const)
        expect(await command(original, mode)).toEqual(retired);
    expect(await counts(original)).toEqual({ items: 0, units: 0, audits: 0 });
    expect(await snapshot()).toEqual(before);
});
it("admission must commit before execute/retire even inside a genuine operation handle", async () => {
    for (const mode of ["execute", "retire"] as const) {
        const original = await intent(), before = await snapshot();
        await expect(withStaffOperation(pool, await session(), "inventory.items.create", async (c, h) => {
            await runCanonicalInventoryItemCreateLifecycle(c, h, original, "admit", undefined, schema);
            await runCanonicalInventoryItemCreateLifecycle(c, h, original, mode, "Synthetic rollback", schema);
        }, schema)).rejects.toMatchObject({ code: "command_admission_uncommitted" });
        expect(await snapshot()).toEqual(before);
    }
});
it("only current exact subject/generation intent is accepted; never rewrite old intent", async () => {
    const original = await intent();
    await command(original, "admit");
    const before = await snapshot();
    for (const key of ["realmId", "subjectId", "generation"] as const) {
        const old = { ...original, authority: { ...original.authority, [key]: randomUUID() } };
        for (const mode of ["admit", "execute", "lookup", "retire"] as const)
            await expect(command(old, mode)).rejects.toThrow();
    }
    expect(await snapshot()).toEqual(before);
});
it("lower facade rejects cloned/projection, wrong action/client/schema and expired handles", async () => {
    const original = await intent(), before = await snapshot();
    for (const kind of ["empty", "clone", "projection"] as const) {
        await expect(withStaffOperation(pool, await session(), "inventory.items.create", async (c, h) => {
            const fake = kind === "empty" ? {} : kind === "clone" ? { ...h } : await staffOperationIdentity(c, h, "inventory.items.create", schema);
            return runCanonicalInventoryItemCreateLifecycle(c, fake as StaffOperationHandle, original, "admit", undefined, schema);
        }, schema)).rejects.toThrow(/HANDLE_INVALID/);
    }
    await expect(withStaffOperation(pool, await session(), "inventory.items.create", async (_c, h) => {
        const other = await pool.connect();
        try {
            return await runCanonicalInventoryItemCreateLifecycle(other, h, original, "admit", undefined, schema);
        } finally {
            other.release();
        }
    }, schema)).rejects.toThrow(/HANDLE_INVALID/);
    await expect(withStaffOperation(pool, await session(), "inventory.items.create", (c, h) =>
        runCanonicalInventoryItemCreateLifecycle(c, h, original, "admit", undefined, "public"), schema)).rejects.toThrow("STAFF_OPERATION_HANDLE_SCHEMA_MISMATCH");
    await expect(withStaffOperation(pool, await session(), "inventory.references.view", (c, h) =>
        runCanonicalInventoryItemCreateLifecycle(c, h, original, "admit", undefined, schema), schema)).rejects.toThrow(/HANDLE_INVALID/);
    let escaped: StaffOperationHandle | undefined;
    await withStaffOperation(pool, await session(), "inventory.items.create", async (_c, h) => { escaped = h; }, schema);
    const c = await pool.connect();
    try {
        await expect(runCanonicalInventoryItemCreateLifecycle(c, escaped!, original, "admit", undefined, schema)).rejects.toThrow(/HANDLE_INVALID/);
    } finally {
        c.release();
    }
    expect(await snapshot()).toEqual(before);
});
/** Wrap only transport for deterministic fault/barrier injection; every SQL query,
 * signature verification, admission, guard and commit remains the real runtime. */
function observedPool(after: (sql: string, values: unknown[] | undefined) => Promise<void> | void): DbPool {
    return { query: pool.query.bind(pool) as DbPool["query"], connect: async () => {
            const c = await pool.connect();
            return { query: async <T>(sql: string, values?: unknown[]) => {
                    const result = await c.query(sql, values);
                    await after(sql, values);
                    return result as {
                        rows: T[];
                        rowCount: number | null;
                    };
                }, release: () => c.release() };
        } };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
it.each(["inventory_items", "inventory_item_unit_versions", "audit_log", "inventory_operations"])("failure at %s rolls back every execution row, not sequence gaps", async (table) => {
    const original = await intent();
    await command(original, "admit");
    const before = await snapshot();
    await pool.query(`CREATE FUNCTION ${schema}.synthetic_item_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic item write failure'; END $$;
 CREATE TRIGGER synthetic_item_fail AFTER INSERT ON ${schema}.${table} FOR EACH ROW EXECUTE FUNCTION ${schema}.synthetic_item_fail()`);
    try {
        await expect(command(original, "execute")).rejects.toThrow("synthetic item write failure");
    }
    finally {
        await pool.query(`DROP TRIGGER synthetic_item_fail ON ${schema}.${table};DROP FUNCTION ${schema}.synthetic_item_fail()`);
    }
    expect(await snapshot()).toEqual(before);
    expect(await counts(original)).toEqual({ items: 0, units: 0, audits: 0 });
    expect((await command(original, "execute")).status).toBe("committed");
});
it.each(["admit", "retire"] as const)("mandatory %s audit failure rolls back its lifecycle row", async (mode) => {
    const original = await intent();
    if (mode === "retire")
        await command(original, "admit");
    const before = await snapshot();
    await pool.query(`CREATE FUNCTION ${schema}.synthetic_item_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic lifecycle audit failure'; END $$;
 CREATE TRIGGER synthetic_item_fail AFTER INSERT ON ${schema}.audit_log FOR EACH ROW EXECUTE FUNCTION ${schema}.synthetic_item_fail()`);
    try {
        await expect(command(original, mode)).rejects.toThrow("synthetic lifecycle audit failure");
    }
    finally {
        await pool.query(`DROP TRIGGER synthetic_item_fail ON ${schema}.audit_log;DROP FUNCTION ${schema}.synthetic_item_fail()`);
    }
    expect(await snapshot()).toEqual(before);
});
it("final runtime assertion rolls back completed item/unit/audit/result after expiration", async () => {
    const original = await intent();
    await command(original, "admit");
    const before = await snapshot(), p = await claims();
    const verified = readVerifiedDurableSession(sign(p))!;
    let resultInserted = false;
    const observed = observedPool(sql => {
        if (sql.startsWith(`INSERT INTO ${schema}.inventory_operations`)) {
            resultInserted = true;
            vi.spyOn(Date, "now").mockReturnValue(p.expiresAt + 1);
        }
    });
    try {
        await expect(commandCanonicalInventoryItemCreate(observed, verified, original, "execute", undefined, schema)).rejects.toThrow(/SESSION/);
        expect(resultInserted).toBe(true);
    }
    finally {
        vi.restoreAllMocks();
    }
    expect(await snapshot()).toEqual(before);
    expect(await counts(original)).toEqual({ items: 0, units: 0, audits: 0 });
});
it.each(["admit", "execute", "lookup", "retire"] as const)("expiration during observed domain fence wait refuses %s without writes", async (mode) => {
    const original = await intent();
    if (mode !== "admit")
        await command(original, "admit");
    const before = await snapshot(), p = await claims(), verified = readVerifiedDurableSession(sign(p))!;
    const holder = await pool.connect();
    await holder.query("BEGIN");
    const pid = (await holder.query<{
        pid: number;
    }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [PURCHASE_RESET_FENCE]);
    const pending = commandCanonicalInventoryItemCreate(pool, verified, original, mode, mode === "retire" ? "Synthetic cancellation" : undefined, schema).then(() => null, e => e);
    try {
        await waitForBlockedBy(pid);
        vi.spyOn(Date, "now").mockReturnValue(p.expiresAt + 1);
        await holder.query("COMMIT");
        expect(await pending).toMatchObject({ message: "STAFF_OPERATION_SESSION_OR_ACTION_INVALID" });
    }
    finally {
        vi.restoreAllMocks();
        await holder.query("ROLLBACK");
        holder.release();
        await pending;
    }
    expect(await snapshot()).toEqual(before);
});
it("revocation committed during observed identity fence wait denies pre-signed session", async () => {
    const original = await intent();
    await command(original, "admit");
    const verified = await session();
    const holder = await pool.connect();
    await holder.query("BEGIN");
    const pid = (await holder.query<{
        pid: number;
    }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`aqlan.canonical.identity.substrate.v1:${schema}`]);
    const pending = commandCanonicalInventoryItemCreate(pool, verified, original, "execute", undefined, schema).then(() => null, e => e);
    try {
        await waitForBlockedBy(pid);
        await holder.query(`UPDATE ${schema}.users SET permissions=$1 WHERE id=2`, [JSON.stringify(doc({ "inventory.references.view": true }))]);
        await holder.query("COMMIT");
        expect(await pending).toBeInstanceOf(Error);
        await expect(command(original, "execute")).rejects.toThrow(/STAFF_OPERATION_/);
        expect(await counts(original)).toEqual({ items: 0, units: 0, audits: 0 });
    }
    finally {
        await holder.query("ROLLBACK");
        holder.release();
        await pending;
        await pool.query(`UPDATE ${schema}.users SET permissions=$1 WHERE id=2`, [JSON.stringify(doc(both))]);
    }
    expect((await command(original, "execute")).status).toBe("committed");
});
async function contend(firstMode: "admit" | "execute" | "retire", secondMode: "admit" | "execute" | "retire") {
    const original = await intent();
    if (firstMode !== "admit")
        await command(original, "admit");
    const entered = deferred(), release = deferred();
    let firstPid = 0, held = false;
    const target = firstMode === "admit" ? "inventory_command_bindings" : firstMode === "execute" ? "inventory_items" : "inventory_command_retirements";
    // Discover PID on the actual owned connection; hold only after real insert.
    const observed: DbPool = { query: pool.query.bind(pool) as DbPool["query"], connect: async () => {
            const c = await pool.connect();
            firstPid = (await c.query<{
                pid: number;
            }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
            return { query: async <T>(sql: string, values?: unknown[]) => {
                    const result = await c.query(sql, values);
                    if (!held && sql.startsWith(`INSERT INTO ${schema}.${target}`)) {
                        held = true;
                        entered.resolve();
                        await release.promise;
                    }
                    return result as {
                        rows: T[];
                        rowCount: number | null;
                    };
                }, release: () => c.release() };
        } };
    const first = commandCanonicalInventoryItemCreate(observed, await session(), original, firstMode, firstMode === "retire" ? "First durable cancellation" : undefined, schema);
    let second: ReturnType<typeof command> | undefined;
    try {
        await Promise.race([entered.promise, first.then(() => { throw Error("Contender never entered intended write barrier"); })]);
        second = command(original, secondMode);
        await waitForBlockedBy(firstPid);
        release.resolve();
        const a = await first, b = await second;
        expect(a.status).toBe(firstMode === "admit" ? "admitted" : firstMode === "execute" ? "committed" : "retired");
        expect(b.status).toBe(a.status);
        expect(await counts(original)).toEqual(firstMode === "execute" ? { items: 1, units: 1, audits: 1 } : { items: 0, units: 0, audits: 0 });
        if (firstMode === "admit")
            expect((await command(original, "execute")).status).toBe("committed");
        const { rows: [n] } = await pool.query(`SELECT (SELECT count(*)::int FROM ${schema}.inventory_command_bindings WHERE operation_key=$1) AS bindings,(SELECT count(*)::int FROM ${schema}.inventory_operations WHERE operation_key=$1) AS results,(SELECT count(*)::int FROM ${schema}.inventory_command_retirements WHERE operation_key=$1) AS retirements`, [a.identity.operationKey]);
        expect(n).toEqual({ bindings: 1, results: firstMode === "retire" ? 0 : 1, retirements: firstMode === "retire" ? 1 : 0 });
    }
    finally {
        release.resolve();
        await Promise.allSettled([first, ...(second ? [second] : [])]);
    }
}
it("same-key concurrent admissions serialize to one durable binding", () => contend("admit", "admit"));
it("same-key concurrent executions serialize to one complete result", () => contend("execute", "execute"));
it("execute wins exact key race; retirement returns committed result", () => contend("execute", "retire"));
it("retire wins exact key race; execute returns tombstone without writing", () => contend("retire", "execute"));
it("SQL remains schema-qualified under unrelated search_path", async () => {
    const original = await intent();
    await command(original, "admit");
    const isolated: DbPool = { query: pool.query.bind(pool) as DbPool["query"], connect: async () => { const c = await pool.connect(); await c.query("SET search_path TO pg_catalog"); return { query: c.query.bind(c) as import("../../lib/db").DbClient["query"], release: () => c.release(true) }; } };
    expect((await commandCanonicalInventoryItemCreate(isolated, await session(), original, "execute", undefined, schema)).status).toBe("committed");
    expect(await counts(original)).toEqual({ items: 1, units: 1, audits: 1 });
});
it.each(["admit", "execute", "retire"] as const)("real commit with lost %s response recovers durably without duplicate evidence", async (mode) => {
    const original = await intent();
    if (mode !== "admit")
        await command(original, "admit");
    let committed = false;
    const lost = observedPool(sql => {
        if (sql === "COMMIT") {
            committed = true;
            throw Error("Synthetic lost transport reply after commit");
        }
    });
    await expect(commandCanonicalInventoryItemCreate(lost, await session(), original, mode, mode === "retire" ? "Synthetic explicit withdrawal" : undefined, schema)).rejects.toThrow("Synthetic lost transport reply after commit");
    expect(committed).toBe(true);
    const after = await snapshot(), recovered = await command(original, mode);
    expect(recovered.status).toBe(mode === "admit" ? "admitted" : mode === "execute" ? "committed" : "retired");
    expect(await snapshot()).toEqual(after);
    expect(await counts(original)).toEqual(mode === "execute" ? { items: 1, units: 1, audits: 1 } : { items: 0, units: 0, audits: 0 });
});
it("gate, invalid mode and malformed original refuse before acquiring a connection", async () => {
    const connect = vi.fn(() => { throw Error("pool must not be touched"); });
    const forbidden = { connect } as unknown as DbPool;
    const verified = await session(), original = await intent();
    vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", "false");
    try {
        await expect(commandCanonicalInventoryItemCreate(forbidden, verified, original, "admit", undefined, schema)).rejects.toThrow();
    }
    finally {
        vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", "true");
    }
    await expect(commandCanonicalInventoryItemCreate(forbidden, verified, original, "unknown" as never, undefined, schema)).rejects.toThrow();
    await expect(commandCanonicalInventoryItemCreate(forbidden, verified, { ...original, nonce: "bad" }, "admit", undefined, schema)).rejects.toThrow();
    await expect(commandCanonicalInventoryItemCreate(forbidden, verified, { ...original, extra: true } as ReferenceIntent, "admit", undefined, schema)).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
});
it("lookup of admitted intent is pending and never an inferred domain success", async () => {
    const original = await intent();
    await command(original, "admit");
    const before = await snapshot();
    expect((await command(original, "lookup")).status).toBe("pending");
    expect(await snapshot()).toEqual(before);
});
it.each([false, true])("renamed username cannot adopt or rewrite original binding (committed=%s)", async (committed) => {
    const original = await intent();
    await command(original, "admit");
    if (committed)
        await command(original, "execute");
    await pool.query(`UPDATE ${schema}.users SET username='synthetic-renamed-2' WHERE id=2`);
    try {
        const before = await snapshot();
        for (const mode of ["admit", "execute", "lookup", "retire"] as const)
            await expect(command(original, mode)).rejects.toThrow();
        expect(await snapshot()).toEqual(before);
    }
    finally {
        await pool.query(`UPDATE ${schema}.users SET username='synthetic-2' WHERE id=2`);
    }
});
it.each(["subjectId", "generationId", "registryRevision", "controlEpoch", "accountEpoch", "credentialVersion", "permissionRevision"])("stale signed %s cannot execute the saved intent", async (key) => {
    const original = await intent();
    await command(original, "admit");
    const before = await snapshot(), p = await claims();
    const d = { ...p.durableIdentity, [key]: key.endsWith("Id") ? randomUUID() : key === "credentialVersion" ? "a".repeat(43) : key === "permissionRevision" ? 999 : "999" };
    const stale = readVerifiedDurableSession(sign({ ...p, durableIdentity: d }));
    expect(stale).not.toBeNull();
    await expect(commandCanonicalInventoryItemCreate(pool, stale!, original, "execute", undefined, schema)).rejects.toThrow(/STAFF_OPERATION_/);
    expect(await snapshot()).toEqual(before);
});
it("create handle cannot be substituted for the exact reference-preview handle", async () => {
    await withStaffOperation(pool, await session(), "inventory.items.create", async (c, h) => {
        await expect(staffOperationReferenceCapabilities(c, h, schema)).rejects.toThrow(/HANDLE_INVALID/);
    }, schema);
});
it.each(["execute", "retire"] as const)("temporary decoy journals cannot shadow %s guards; caller search_path is restored", async (mode) => {
    const original = await intent(), admitted = await command(original, "admit"), verified = await session();
    const isolated: DbPool = { query: pool.query.bind(pool) as DbPool["query"], connect: async () => {
            const c = await pool.connect();
            await c.query(`CREATE TEMP TABLE inventory_operations(scope TEXT,actor_id INTEGER,operation_key TEXT,payload_hash TEXT);
   CREATE TEMP TABLE inventory_command_retirements(scope TEXT,actor_id INTEGER,operation_key TEXT,payload_hash TEXT);
   SET search_path TO pg_temp,pg_catalog`);
            for (const table of ["inventory_operations", "inventory_command_retirements"])
                await c.query(`INSERT INTO pg_temp.${table} VALUES($1,$2,$3,$4)`, [admitted.identity.scope, admitted.identity.actorUserId, admitted.identity.operationKey, admitted.identity.payloadDigest]);
            return { query: c.query.bind(c) as import("../../lib/db").DbClient["query"], release: () => c.release(true) };
        } };
    const outcome = await withStaffOperation(isolated, verified, "inventory.items.create", async (c, h) => {
        const before = (await c.query<{
            path: string;
        }>("SELECT current_setting('search_path') AS path")).rows[0].path;
        const result = await runCanonicalInventoryItemCreateLifecycle(c, h, original, mode, mode === "retire" ? "Synthetic temp decoy cancellation" : undefined, schema);
        expect((await c.query<{
            path: string;
        }>("SELECT current_setting('search_path') AS path")).rows[0].path).toBe(before);
        for (const table of ["inventory_operations", "inventory_command_retirements"])
            expect((await c.query<{
                n: number;
            }>(`SELECT count(*)::int AS n FROM pg_temp.${table}`)).rows[0].n).toBe(1);
        return result;
    }, schema);
    expect(outcome.status).toBe(mode === "execute" ? "committed" : "retired");
    expect(await counts(original)).toEqual(mode === "execute" ? { items: 1, units: 1, audits: 1 } : { items: 0, units: 0, audits: 0 });
});
it.each(["execute", "retire"] as const)("released admission savepoint is not a committed transaction for %s", async mode => {
    const original = await intent(), before = await snapshot();
    await expect(withStaffOperation(pool, await session(), "inventory.items.create", async (c, h) => {
        const xid = (await c.query<{ xid: string }>("SELECT pg_current_xact_id()::text AS xid")).rows[0].xid;
        await c.query("SAVEPOINT synthetic_item_admission");
        await runCanonicalInventoryItemCreateLifecycle(c, h, original, "admit", undefined, schema);
        await c.query("RELEASE SAVEPOINT synthetic_item_admission");
        expect((await c.query<{ xid: string }>("SELECT pg_current_xact_id()::text AS xid")).rows[0].xid).toBe(xid);
        await runCanonicalInventoryItemCreateLifecycle(c, h, original, mode, "Synthetic savepoint refusal", schema);
    }, schema)).rejects.toMatchObject({ code: "command_admission_uncommitted" });
    expect(await snapshot()).toEqual(before);
});
it.each(["execute", "retire"] as const)("rolled-back admission savepoint leaves no provenance for %s in the same top-level XID", async mode => {
    const original = await intent(), before = await snapshot();
    await expect(withStaffOperation(pool, await session(), "inventory.items.create", async (c, h) => {
        const xid = (await c.query<{ xid: string }>("SELECT pg_current_xact_id()::text AS xid")).rows[0].xid;
        await c.query("SAVEPOINT synthetic_item_admission");
        await runCanonicalInventoryItemCreateLifecycle(c, h, original, "admit", undefined, schema);
        await c.query("ROLLBACK TO SAVEPOINT synthetic_item_admission");
        await c.query("RELEASE SAVEPOINT synthetic_item_admission");
        expect((await c.query<{ xid: string }>("SELECT pg_current_xact_id()::text AS xid")).rows[0].xid).toBe(xid);
        await runCanonicalInventoryItemCreateLifecycle(c, h, original, mode, "Synthetic rolled-back admission", schema);
    }, schema)).rejects.toMatchObject({ code: "command_provenance_required" });
    expect(await snapshot()).toEqual(before);
});
