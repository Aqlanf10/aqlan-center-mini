vi.mock("server-only", () => ({}));
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { withTransaction } from "../../lib/transactions";
import { INVENTORY_PROCUREMENT_SQL } from "../../lib/inventory-domain/schema-proposal";
import { INVENTORY_COMMAND_LIFECYCLE_SQL } from "../../lib/inventory-domain/command-lifecycle-schema-proposal";
import { createInventoryCommandLifecycle } from "../../lib/inventory-domain/command-lifecycle";
import {
  resolveInventoryPrincipal,
  type InventoryPrincipalDependencies,
} from "../../lib/inventory-domain/principal";
import {
  inventoryOperationInTransaction,
  inventoryOperationDigest,
  type InventoryActor,
} from "../../lib/inventory-domain/procurement-store";
import type { DbClient } from "../../lib/db";
assertRealPostgresUrl();
stubPostgresEnv();
const db = await import("../../lib/db");
const key = () => randomUUID(),
  scope = "synthetic.lifecycle";
const deps: InventoryPrincipalDependencies = {
  resolvePrincipal: async (actor) => ({
    realmId: "synthetic-authoritative-realm",
    subjectId: `subject:${actor.userId}`,
    actorUserId: actor.userId,
    username: actor.username,
  }),
};
const lifecycle = createInventoryCommandLifecycle(
  { scope, management: true },
  deps,
);
let admin: InventoryActor, other: InventoryActor;
const payload = {
  command: "synthetic.commit",
  quantity: "2",
  currency: "SAR",
  amountMinor: 125,
};
const tx = <T>(work: (client: DbClient) => Promise<T>) =>
  withTransaction(db.getPool(), work);
const admit = (k: string) => tx((c) => lifecycle.admit(c, admin, k, payload));
async function effects(k: string) {
  return (
    await db.getPool().query(
      `SELECT
 (SELECT count(*)::int FROM inventory_command_bindings WHERE scope=$1 AND actor_id=$2 AND operation_key=$3) AS bindings,
 (SELECT count(*)::int FROM inventory_command_retirements WHERE scope=$1 AND actor_id=$2 AND operation_key=$3) AS retirements,
 (SELECT count(*)::int FROM inventory_operations WHERE scope=$1 AND actor_id=$2 AND operation_key=$3) AS results,
 (SELECT count(*)::int FROM synthetic_lifecycle_effects WHERE id=$3) AS effects`,
      [scope, admin.userId, k],
    )
  ).rows[0];
}
async function business(c: DbClient, k: string) {
  await c.query("INSERT INTO synthetic_lifecycle_effects(id) VALUES($1)", [k]);
  return { id: k, effectCount: 1 };
}
beforeAll(async () => {
  vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", "true");
  await db.ensureSchema();
  await db.getPool().query(INVENTORY_PROCUREMENT_SQL);
  await db.getPool().query(INVENTORY_COMMAND_LIFECYCLE_SQL);
  await db
    .getPool()
    .query(
      "CREATE TABLE IF NOT EXISTS synthetic_lifecycle_effects(id TEXT PRIMARY KEY)",
    );
  for (let i = 0; i < 2; i++) {
    const username = `SYN-LIFECYCLE-${key()}`,
      userId = (
        await db
          .getPool()
          .query(
            "INSERT INTO users(username,display_name,password_hash,role) VALUES($1,$1,'synthetic-disabled','admin') RETURNING id",
            [username],
          )
      ).rows[0].id;
    const actor = { userId, username, role: "admin" };
    if (i === 0) admin = actor;
    else other = actor;
  }
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await db.resetPoolForTesting();
});

async function waitForAdvisoryWait(pid: number) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const row = (
      await db.getPool().query<{
        wait_event_type: string;
        wait_event: string;
      }>("SELECT wait_event_type,wait_event FROM pg_stat_activity WHERE pid=$1", [pid])
    ).rows[0];
    if (row?.wait_event_type === "Lock" && row.wait_event === "advisory")
      return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    "Synthetic contender never waited on the exact advisory lock",
  );
}

describe("prepared inventory command admission and retirement", () => {
  it("validates keys and rolls back an acknowledged retirement when its caller rolls back", async () => {
    await expect(admit("bad")).rejects.toMatchObject({
      code: "invalid_operation_key",
    });
    const k = key();
    await admit(k);
    await expect(
      tx(async (c) => {
        await lifecycle.retire(c, admin, k, payload, "Synthetic rollback");
        throw new Error("Caller rolled back");
      }),
    ).rejects.toThrow("Caller rolled back");
    expect(await effects(k)).toEqual({
      bindings: 1,
      retirements: 0,
      results: 0,
      effects: 0,
    });
    expect(
      (
        await tx((c) =>
          lifecycle.execute(c, admin, k, payload, () => business(c, k)),
        )
      ).status,
    ).toBe("committed");
  });
  it("leaves unbound legacy execution unchanged when the complete proposal is absent", async () => {
    const k = key();
    await expect(
      tx(async (c) => {
        await c.query(
          "DROP TRIGGER inventory_command_result_guard ON inventory_operations",
        );
        await c.query("DROP TABLE inventory_command_retirements");
        await c.query("DROP TABLE inventory_command_bindings");
        expect(
          (
            await inventoryOperationInTransaction(
              c,
              admin,
              k,
              scope,
              payload,
              true,
              () => business(c, k),
            )
          ).replayed,
        ).toBe(false);
        expect(
          (
            await inventoryOperationInTransaction(
              c,
              admin,
              k,
              scope,
              payload,
              true,
              async () => ({ unexpected: true }),
            )
          ).replayed,
        ).toBe(true);
        throw new Error("Restore synthetic schema by rollback");
      }),
    ).rejects.toThrow("Restore synthetic schema by rollback");
    expect(await effects(k)).toEqual({
      bindings: 0,
      retirements: 0,
      results: 0,
      effects: 0,
    });
  });
  it("SQL retirement insertion waits on JavaScript execution and cannot retire its committed result", async () => {
    const k = key();
    await admit(k);
    const a = await db.getPool().connect(),
      b = await db.getPool().connect();
    try {
      await a.query("BEGIN");
      await b.query("BEGIN");
      const pid = (
        await b.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0].pid;
      await lifecycle.execute(a, admin, k, payload, () => business(a, k));
      const inserted = b
        .query(
          "INSERT INTO inventory_command_retirements(scope,actor_id,operation_key,payload_hash,reason) VALUES($1,$2,$3,$4,'Synthetic raw contender')",
          [scope, admin.userId, k, inventoryOperationDigest(k, payload)],
        )
        .then(
          () => null,
          (error) => error,
        );
      await waitForAdvisoryWait(pid);
      await a.query("COMMIT");
      expect((await inserted)?.message).toContain(
        "Committed inventory command",
      );
    } finally {
      await a.query("ROLLBACK");
      await b.query("ROLLBACK");
      a.release();
      b.release();
    }
    expect(await effects(k)).toEqual({
      bindings: 1,
      retirements: 0,
      results: 1,
      effects: 1,
    });
  });
  it("keeps default resolver closed and validates server descriptor and exact stable principal projection", async () => {
    const k = key();
    await expect(
      tx((c) =>
        createInventoryCommandLifecycle({ scope, management: true }).admit(
          c,
          admin,
          k,
          payload,
        ),
      ),
    ).rejects.toMatchObject({ code: "principal_realm_unavailable" });
    for (const invalid of ["", 'bad"scope', "مرحبا", "x".repeat(161)])
      expect(() =>
        createInventoryCommandLifecycle(
          { scope: invalid, management: true },
          deps,
        ),
      ).toThrow();
    const principal = await resolveInventoryPrincipal(
      {
        resolvePrincipal: async () => ({
          ...(await resolveInventoryPrincipal(deps, admin)),
          permissions: { mutable: true },
          version: 99,
        }),
      },
      admin,
    );
    expect(Object.keys(principal).sort()).toEqual([
      "actorUserId",
      "realmId",
      "subjectId",
      "username",
    ]);
    await expect(
      resolveInventoryPrincipal(
        {
          resolvePrincipal: async () => ({
            ...principal,
            subjectId: " padded ",
          }),
        },
        admin,
      ),
    ).rejects.toMatchObject({ code: "principal_realm_unavailable" });
    expect(await effects(k)).toEqual({
      bindings: 0,
      retirements: 0,
      results: 0,
      effects: 0,
    });
  });
  it("refuses unadmitted execution/retirement and never adopts an unbound committed legacy success", async () => {
    const k = key(),
      work = vi.fn(async () => ({ ok: true }));
    await expect(
      tx((c) => lifecycle.execute(c, admin, k, payload, work)),
    ).rejects.toMatchObject({ code: "command_provenance_required" });
    await expect(
      tx((c) => lifecycle.retire(c, admin, k, payload, "Synthetic abandon")),
    ).rejects.toMatchObject({ code: "command_provenance_required" });
    expect(work).not.toHaveBeenCalled();
    const old = await tx((c) =>
      inventoryOperationInTransaction(c, admin, k, scope, payload, true, () =>
        business(c, k),
      ),
    );
    await expect(admit(k)).rejects.toMatchObject({
      code: "command_provenance_required",
    });
    await expect(
      tx((c) =>
        lifecycle.retire(
          c,
          admin,
          k,
          payload,
          "Do not infer legacy provenance",
        ),
      ),
    ).rejects.toMatchObject({ code: "command_provenance_required" });
    expect(
      await tx((c) =>
        inventoryOperationInTransaction(
          c,
          admin,
          k,
          scope,
          payload,
          true,
          work,
        ),
      ),
    ).toEqual({ ...old, replayed: true });
    expect(work).not.toHaveBeenCalled();
    expect(await effects(k)).toEqual({
      bindings: 0,
      retirements: 0,
      results: 1,
      effects: 1,
    });
  });
  it("admits exact content once with no domain effect and preserves binding after stale payload refusal", async () => {
    const k = key(),
      a = await admit(k);
    expect(await admit(k)).toEqual(a);
    expect(a.status).toBe("admitted");
    expect(a.identity.payloadDigest).toBe(inventoryOperationDigest(k, payload));
    await expect(
      tx((c) => lifecycle.admit(c, admin, k, { ...payload, amountMinor: 126 })),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(await effects(k)).toEqual({
      bindings: 1,
      retirements: 0,
      results: 0,
      effects: 0,
    });
    expect(
      (
        await db
          .getPool()
          .query(
            "SELECT count(*)::int AS n FROM audit_log WHERE entity='inventory_command' AND entity_id=$1",
            [k],
          )
      ).rows[0].n,
    ).toBe(1);
  });
  it("requires admission to commit before execute or retire, and rejects autocommit", async () => {
    const k = key(),
      client = await db.getPool().connect();
    try {
      await expect(
        lifecycle.admit(client, admin, k, payload),
      ).rejects.toMatchObject({ code: "transaction_required" });
    } finally {
      client.release();
    }
    await expect(
      tx(async (c) => {
        await lifecycle.admit(c, admin, k, payload);
        return lifecycle.execute(c, admin, k, payload, () => business(c, k));
      }),
    ).rejects.toMatchObject({ code: "command_admission_uncommitted" });
    expect(await effects(k)).toEqual({
      bindings: 0,
      retirements: 0,
      results: 0,
      effects: 0,
    });
    await expect(
      tx(async (c) => {
        await lifecycle.admit(c, admin, k, payload);
        return lifecycle.retire(c, admin, k, payload, "Uncommitted admission");
      }),
    ).rejects.toMatchObject({ code: "command_admission_uncommitted" });
    const principal = await resolveInventoryPrincipal(deps, admin);
    await expect(
      tx(async (c) => {
        await lifecycle.admit(c, admin, k, payload);
        return inventoryOperationInTransaction(
          c,
          admin,
          k,
          scope,
          payload,
          true,
          () => business(c, k),
          principal,
        );
      }),
    ).rejects.toMatchObject({ code: "command_admission_uncommitted" });
  });
  it("returns committed historical acknowledgement after lost reply and never retires a success", async () => {
    const k = key();
    await admit(k);
    const first = await tx((c) =>
      lifecycle.execute(c, admin, k, payload, () => business(c, k)),
    );
    expect(first.status).toBe("committed");
    const work = vi.fn(async () => ({ id: k, effectCount: 2 }));
    const replay = await tx((c) =>
      lifecycle.execute(c, admin, k, payload, work),
    );
    if (first.status !== "committed")
      throw new Error("Expected committed result");
    expect(replay).toEqual({
      ...first,
      result: { ...first.result, replayed: true },
    });
    expect(
      await tx((c) =>
        lifecycle.retire(c, admin, k, payload, "Lost successful reply"),
      ),
    ).toEqual(replay);
    expect(work).not.toHaveBeenCalled();
    expect(await effects(k)).toEqual({
      bindings: 1,
      retirements: 0,
      results: 1,
      effects: 1,
    });
  });
  it("returns durable retirement after lost reply and fences both prepared and ordinary callers", async () => {
    const k = key();
    await admit(k);
    const retired = await tx((c) =>
      lifecycle.retire(c, admin, k, payload, "Synthetic explicit withdrawal"),
    );
    expect(
      await tx((c) =>
        lifecycle.retire(
          c,
          admin,
          k,
          payload,
          "Later reason does not replace evidence",
        ),
      ),
    ).toEqual(retired);
    const work = vi.fn(async () => ({ ok: true }));
    expect(
      await tx((c) => lifecycle.execute(c, admin, k, payload, work)),
    ).toEqual(retired);
    await expect(
      tx((c) =>
        inventoryOperationInTransaction(
          c,
          admin,
          k,
          scope,
          payload,
          true,
          work,
        ),
      ),
    ).rejects.toMatchObject({ code: "command_provenance_required" });
    await expect(
      tx((c) =>
        lifecycle.execute(c, admin, k, { ...payload, quantity: "3" }, work),
      ),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(work).not.toHaveBeenCalled();
    expect(await effects(k)).toEqual({
      bindings: 1,
      retirements: 1,
      results: 0,
      effects: 0,
    });
  });
  it("ordinary helper cannot return a bound success without the verified principal", async () => {
    const k = key();
    await admit(k);
    await tx((c) =>
      lifecycle.execute(c, admin, k, payload, () => business(c, k)),
    );
    await expect(
      tx((c) =>
        inventoryOperationInTransaction(
          c,
          admin,
          k,
          scope,
          payload,
          true,
          async () => ({ ok: true }),
        ),
      ),
    ).rejects.toMatchObject({ code: "command_provenance_required" });
  });
  it("preserves committed admission through domain rollback, then permits explicit retirement", async () => {
    const k = key();
    await admit(k);
    await expect(
      tx((c) =>
        lifecycle.execute(c, admin, k, payload, async () => {
          await business(c, k);
          throw new Error("Synthetic work refusal");
        }),
      ),
    ).rejects.toThrow("Synthetic work refusal");
    expect(await effects(k)).toEqual({
      bindings: 1,
      retirements: 0,
      results: 0,
      effects: 0,
    });
    await tx((c) =>
      lifecycle.retire(c, admin, k, payload, "Explicit refusal recovery"),
    );
    expect(await effects(k)).toEqual({
      bindings: 1,
      retirements: 1,
      results: 0,
      effects: 0,
    });
  });
  it("rolls back admission and retirement when mandatory audit fails", async () => {
    const k = key();
    await db
      .getPool()
      .query(
        `CREATE OR REPLACE FUNCTION synthetic_lifecycle_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entity='inventory_command' AND NEW.entity_id='${k}' THEN RAISE EXCEPTION 'synthetic lifecycle audit failure'; END IF; RETURN NEW; END $$`,
      );
    await db
      .getPool()
      .query(
        "CREATE TRIGGER synthetic_lifecycle_audit_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_lifecycle_audit_fail()",
      );
    try {
      await expect(admit(k)).rejects.toThrow(
        "synthetic lifecycle audit failure",
      );
      expect(await effects(k)).toEqual({
        bindings: 0,
        retirements: 0,
        results: 0,
        effects: 0,
      });
    } finally {
      await db
        .getPool()
        .query("DROP TRIGGER synthetic_lifecycle_audit_fail ON audit_log");
    }
    await admit(k);
    await db
      .getPool()
      .query(
        "CREATE TRIGGER synthetic_lifecycle_audit_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_lifecycle_audit_fail()",
      );
    try {
      await expect(
        tx((c) =>
          lifecycle.retire(c, admin, k, payload, "Must roll back tombstone"),
        ),
      ).rejects.toThrow("synthetic lifecycle audit failure");
      expect(await effects(k)).toEqual({
        bindings: 1,
        retirements: 0,
        results: 0,
        effects: 0,
      });
    } finally {
      await db
        .getPool()
        .query("DROP TRIGGER synthetic_lifecycle_audit_fail ON audit_log");
    }
    expect(
      (
        await tx((c) =>
          lifecycle.execute(c, admin, k, payload, () => business(c, k)),
        )
      ).status,
    ).toBe("committed");
  });
  it("refuses realm, subject, actor and policy mismatch while preserving the admitted command", async () => {
    const k = key();
    await admit(k);
    for (const override of [
      { realmId: "another-realm" },
      { subjectId: "another-subject" },
    ]) {
      const wrong = createInventoryCommandLifecycle(
        { scope, management: true },
        {
          resolvePrincipal: async (actor) => ({
            ...(await resolveInventoryPrincipal(deps, actor)),
            ...override,
          }),
        },
      );
      await expect(
        tx((c) => wrong.retire(c, admin, k, payload, "Wrong identity")),
      ).rejects.toMatchObject({ code: "command_provenance_required" });
    }
    await expect(
      tx((c) =>
        lifecycle.retire(c, other, k, payload, "Another actor cannot retire"),
      ),
    ).rejects.toMatchObject({ code: "command_provenance_required" });
    const weaker = createInventoryCommandLifecycle(
      { scope, management: false },
      deps,
    );
    await expect(
      tx((c) => weaker.retire(c, admin, k, payload, "Changed policy")),
    ).rejects.toMatchObject({ code: "command_policy_mismatch" });
    await db
      .getPool()
      .query("UPDATE users SET is_active=FALSE WHERE id=$1", [admin.userId]);
    try {
      await expect(
        tx((c) => lifecycle.retire(c, admin, k, payload, "Revoked actor")),
      ).rejects.toMatchObject({ code: "actor_forbidden" });
    } finally {
      await db
        .getPool()
        .query("UPDATE users SET is_active=TRUE WHERE id=$1", [admin.userId]);
    }
    expect(await effects(k)).toEqual({
      bindings: 1,
      retirements: 0,
      results: 0,
      effects: 0,
    });
  });
  it("refuses missing/partial proposal and preserves gate-off behavior", async () => {
    const k = key();
    await expect(
      tx(async (c) => {
        await c.query(
          "ALTER TABLE inventory_command_retirements RENAME TO synthetic_hidden_retirements",
        );
        return lifecycle.admit(c, admin, k, payload);
      }),
    ).rejects.toMatchObject({ code: "schema_not_ready" });
    await expect(
      tx(async (c) => {
        await c.query(
          "ALTER TABLE inventory_command_retirements RENAME TO synthetic_hidden_retirements",
        );
        await c.query(
          "ALTER TABLE inventory_command_bindings RENAME TO synthetic_hidden_bindings",
        );
        return lifecycle.admit(c, admin, k, payload);
      }),
    ).rejects.toMatchObject({ code: "schema_not_ready" });
    vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", "false");
    try {
      await expect(admit(k)).rejects.toMatchObject({
        code: "inventory_integration_disabled",
      });
    } finally {
      vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", "true");
    }
  });
  it("execution wins its exact key lock and retirement returns committed success", async () => {
    const k = key();
    await admit(k);
    const a = await db.getPool().connect(),
      b = await db.getPool().connect();
    let release!: () => void, entered!: () => void;
    const hold = new Promise<void>((resolve) => {
        release = resolve;
      }),
      inside = new Promise<void>((resolve) => {
        entered = resolve;
      });
    try {
      await a.query("BEGIN");
      await b.query("BEGIN");
      const pid = (
        await b.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0].pid;
      const execution = lifecycle.execute(a, admin, k, payload, async () => {
        entered();
        await hold;
        return business(a, k);
      });
      await inside;
      const retirement = lifecycle.retire(
        b,
        admin,
        k,
        payload,
        "Concurrent withdrawal",
      );
      await waitForAdvisoryWait(pid);
      release();
      const committed = await execution;
      await a.query("COMMIT");
      expect((await retirement).status).toBe("committed");
      await b.query("COMMIT");
      expect(committed.status).toBe("committed");
    } finally {
      release();
      await a.query("ROLLBACK");
      await b.query("ROLLBACK");
      a.release();
      b.release();
    }
    expect(await effects(k)).toEqual({
      bindings: 1,
      retirements: 0,
      results: 1,
      effects: 1,
    });
  });
  it("retirement wins its exact key lock and execution never calls domain work", async () => {
    const k = key();
    await admit(k);
    const a = await db.getPool().connect(),
      b = await db.getPool().connect(),
      work = vi.fn(async () => ({ ok: true }));
    try {
      await a.query("BEGIN");
      await b.query("BEGIN");
      const pid = (
        await b.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0].pid;
      const terminal = await lifecycle.retire(
        a,
        admin,
        k,
        payload,
        "Retirement first",
      );
      const execution = lifecycle.execute(b, admin, k, payload, work);
      await waitForAdvisoryWait(pid);
      await a.query("COMMIT");
      expect(await execution).toEqual(terminal);
      await b.query("COMMIT");
    } finally {
      await a.query("ROLLBACK");
      await b.query("ROLLBACK");
      a.release();
      b.release();
    }
    expect(work).not.toHaveBeenCalled();
    expect(await effects(k)).toEqual({
      bindings: 1,
      retirements: 1,
      results: 0,
      effects: 0,
    });
  });
  it("SQL terminal guard contends on the identical JavaScript advisory identity", async () => {
    const k = key();
    await admit(k);
    const a = await db.getPool().connect(),
      b = await db.getPool().connect();
    try {
      await a.query("BEGIN");
      await b.query("BEGIN");
      const pid = (
        await b.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0].pid;
      await lifecycle.retire(
        a,
        admin,
        k,
        payload,
        "Durable tombstone before raw result",
      );
      const inserted = b
        .query(
          "INSERT INTO inventory_operations(scope,actor_id,operation_key,payload_hash,result) VALUES($1,$2,$3,$4,'{}'::jsonb)",
          [scope, admin.userId, k, inventoryOperationDigest(k, payload)],
        )
        .then(
          () => null,
          (error) => error,
        );
      await waitForAdvisoryWait(pid);
      await a.query("COMMIT");
      expect((await inserted)?.message).toContain("Retired inventory command");
    } finally {
      await a.query("ROLLBACK");
      await b.query("ROLLBACK");
      a.release();
      b.release();
    }
    expect(await effects(k)).toEqual({
      bindings: 1,
      retirements: 1,
      results: 0,
      effects: 0,
    });
  });
});
