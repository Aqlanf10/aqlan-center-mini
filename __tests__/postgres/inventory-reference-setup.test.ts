import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { withTransaction } from "../../lib/transactions";
import type { DbClient } from "../../lib/db";
import { INVENTORY_PROCUREMENT_SQL } from "../../lib/inventory-domain/schema-proposal";
import { INVENTORY_COMMAND_LIFECYCLE_SQL } from "../../lib/inventory-domain/command-lifecycle-schema-proposal";
import {
  createReferenceSetupService,
  type ReferenceSetupContext,
  type ReferenceSetupAuthority,
} from "../../lib/inventory-domain/reference-setup";
import {
  REFERENCE_PROTOCOL,
  type ReferenceIntent,
  type ReferenceInput,
  type ReferenceReply,
} from "../../lib/inventory-reference-protocol";
import { invariant } from "../../lib/inventory-domain/quantities";
assertRealPostgresUrl();
stubPostgresEnv();
const db = await import("../../lib/db");
const tx = <T>(work: (client: DbClient) => Promise<T>) =>
  withTransaction(db.getPool(), work);
const realm = randomUUID(),
  subject = randomUUID();
let actor: ReferenceSetupContext["actor"],
  generation = randomUUID(),
  grant = true,
  historyProof = false;
const authority: ReferenceSetupAuthority<number> = {
  async revalidateInTransaction(c, id, _action) {
    invariant(
      id === actor.userId,
      "actor_forbidden",
      "Explicit synthetic session binding required",
    );
    const row = (
      await c.query<{ username: string; role: string; is_active: boolean }>(
        "SELECT username,role,is_active FROM users WHERE id=$1 FOR SHARE",
        [id],
      )
    ).rows[0];
    invariant(
      row?.is_active && row.username === actor.username,
      "actor_forbidden",
      "Synthetic authority revoked",
    );
    invariant(grant, "operation_forbidden", "Synthetic capability revoked");
    return {
      actor,
      principal: {
        realmId: realm,
        subjectId: subject,
        actorUserId: id,
        username: row.username,
      },
      generation,
      allowedActions: [
        "item.create",
        "unit.revise",
        "location.create",
        "policy.revise",
      ],
    };
  },
  async verifyHistoricalBindingInTransaction() {
    invariant(
      historyProof,
      "historical_binding_unproven",
      "Synthetic restore provenance not provided",
    );
  },
};
const service = createReferenceSetupService(authority);
const intent = (input: ReferenceInput): ReferenceIntent => ({
  protocol: REFERENCE_PROTOCOL,
  authority: { realmId: realm, subjectId: subject, generation },
  nonce: randomUUID(),
  input,
});
const item = (): ReferenceInput => ({
  action: "item.create",
  name: `SYN-REFERENCE-${randomUUID()}`,
  category: "other",
  baseUnit: "piece",
  basePrecision: 0,
  minLevel: "0",
  note: "",
  reason: "Synthetic first-use reference",
});
const run = (
  i: ReferenceIntent,
  mode: "admit" | "execute" | "lookup" | "retire",
  reason?: string,
) => tx((c) => service.command(c, actor.userId, i, mode, reason));
async function commit(input: ReferenceInput) {
  const i = intent(input);
  await run(i, "admit");
  const result = await run(i, "execute");
  expect(result.status).toBe("committed");
  return {
    intent: i,
    result: result as Extract<ReferenceReply, { status: "committed" }>,
  };
}
beforeAll(async () => {
  vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", "true");
  await db.ensureSchema();
  await db.getPool().query(INVENTORY_PROCUREMENT_SQL);
  await db.getPool().query(INVENTORY_COMMAND_LIFECYCLE_SQL);
  const username = `SYN-REF-${randomUUID()}`;
  const id = (
    await db
      .getPool()
      .query(
        "INSERT INTO users(username,display_name,password_hash,role) VALUES($1,$1,'synthetic-disabled','admin') RETURNING id",
        [username],
      )
  ).rows[0].id;
  actor = { userId: id, username, role: "admin" };
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await db.getPool().end?.();
});
describe("first-use reference core with explicit synthetic authority (not canonical adapter acceptance)", () => {
  it("default authority remains closed and autocommit is refused", async () => {
    await expect(
      tx((c) => createReferenceSetupService().read(c, {})),
    ).rejects.toThrow("inventory_reference_authority_unavailable");
    const c = await db.getPool().connect();
    try {
      await expect(service.read(c, actor.userId)).rejects.toMatchObject({
        code: "25P01",
      });
    } finally {
      c.release?.();
    }
  });
  it("reference catalog permission does not authorize financial readiness counts", async () => {
    const { createReferenceTransport } = await import(
      "../../lib/inventory-domain/reference-transport"
    );
    const transport = createReferenceTransport<number>({
      ...authority,
      async revalidateInTransaction(c, session, action) {
        invariant(
          action === "read",
          "operation_forbidden",
          "Readiness requires a distinct central decision",
        );
        return authority.revalidateInTransaction(c, session, action);
      },
    });
    await expect(transport.read(actor.userId, "", 1)).resolves.toBeDefined();
    await expect(transport.readiness(actor.userId)).rejects.toMatchObject({
      code: "operation_forbidden",
    });
  });
  it("creates item/base unit atomically without stock or finance, exact lost-reply replay", async () => {
    const input = item();
    const before = (
      await db
        .getPool()
        .query(
          "SELECT (SELECT count(*) FROM inventory_movements)::text AS movements,(SELECT count(*) FROM payables)::text AS payables",
        )
    ).rows[0];
    const done = await commit(input),
      replay = await run(done.intent, "execute");
    expect(replay).toMatchObject({
      status: "committed",
      identity: done.result.identity,
      result: { ...done.result.result, replayed: true },
    });
    const rows = (
      await db
        .getPool()
        .query(
          "SELECT i.name,u.version,u.factor::text FROM inventory_items i JOIN inventory_item_unit_versions u ON u.item_id=i.id WHERE i.id=$1",
          [done.result.result.id],
        )
    ).rows;
    expect(rows).toEqual([
      {
        name: input.action === "item.create" ? input.name : "",
        version: 1,
        factor: "1.000000000",
      },
    ]);
    expect(
      (
        await db
          .getPool()
          .query(
            "SELECT (SELECT count(*) FROM inventory_movements)::text AS movements,(SELECT count(*) FROM payables)::text AS payables",
          )
      ).rows[0],
    ).toEqual(before);
  });
  it("requires admission in a separately committed transaction", async () => {
    const i = intent(item());
    await expect(
      tx(async (c) => {
        await service.command(c, actor.userId, i, "admit");
        await service.command(c, actor.userId, i, "execute");
      }),
    ).rejects.toMatchObject({ code: "command_admission_uncommitted" });
    await expect(run(i, "execute")).rejects.toMatchObject({
      code: "command_provenance_required",
    });
  });
  it("adds immutable package version and serializes competing expected versions", async () => {
    const created = await commit(item());
    const itemId = Number(created.result.result.id);
    const a = intent({
      action: "unit.revise",
      itemId,
      expectedVersion: 1,
      enteredUnit: "box",
      factor: "12",
      enteredPrecision: 0,
      basePrecision: 0,
      reason: "Synthetic package label verified",
    });
    const b = intent({ ...a.input } as ReferenceInput);
    await run(a, "admit");
    await run(b, "admit");
    const results = await Promise.allSettled([
      run(a, "execute"),
      run(b, "execute"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: "stale_version" },
    });
    expect(
      (
        await db
          .getPool()
          .query(
            "SELECT version,factor::text FROM inventory_item_unit_versions WHERE item_id=$1 ORDER BY version",
            [itemId],
          )
      ).rows,
    ).toEqual([
      { version: 1, factor: "1.000000000" },
      { version: 2, factor: "12.000000000" },
    ]);
  });
  it("registers store and transit with no ownership inference; invalid custody refuses", async () => {
    for (const kind of ["store", "transit"] as const) {
      const i = await commit({
        action: "location.create",
        id: `syn-${randomUUID()}`,
        label: `Synthetic ${kind}`,
        kind,
        doctorPartyId: null,
        reason: "Synthetic explicit location",
      });
      expect(i.result.result.version).toBe(1);
    }
    const i = intent({
      action: "location.create",
      id: `syn-${randomUUID()}`,
      label: "Invalid custody",
      kind: "custody",
      doctorPartyId: 2147483647,
      reason: "Synthetic invalid doctor",
    });
    await run(i, "admit");
    await expect(run(i, "execute")).rejects.toMatchObject({
      code: "location_forbidden",
    });
  });
  it("policy revision is explicit YER, preserves no-self-approval and expected version", async () => {
    const version = Number(
      (
        await db
          .getPool()
          .query(
            "SELECT COALESCE(MAX(version),0) AS v FROM inventory_approval_policies WHERE branch_key='clinic'",
          )
      ).rows[0].v,
    );
    const done = await commit({
      action: "policy.revise",
      expectedVersion: version,
      limitMinor: 500000,
      reason: "Synthetic explicit approval limit",
    });
    expect(
      (
        await db
          .getPool()
          .query(
            "SELECT version,currency,limit_minor::text,allow_self_approval FROM inventory_approval_policies WHERE id=$1",
            [done.result.result.id],
          )
      ).rows[0],
    ).toEqual({
      version: version + 1,
      currency: "YER",
      limit_minor: "500000",
      allow_self_approval: false,
    });
    const stale = intent({ ...done.intent.input } as ReferenceInput);
    await run(stale, "admit");
    await expect(run(stale, "execute")).rejects.toMatchObject({
      code: "stale_version",
    });
  });
  it("current permission and active user are rechecked even before committed replay", async () => {
    const done = await commit(item());
    grant = false;
    try {
      await expect(run(done.intent, "execute")).rejects.toMatchObject({
        code: "operation_forbidden",
      });
    } finally {
      grant = true;
    }
    await db
      .getPool()
      .query("UPDATE users SET is_active=FALSE WHERE id=$1", [actor.userId]);
    try {
      await expect(run(done.intent, "lookup")).rejects.toMatchObject({
        code: "actor_forbidden",
      });
    } finally {
      await db
        .getPool()
        .query("UPDATE users SET is_active=TRUE WHERE id=$1", [actor.userId]);
    }
  });
  it("generation rotation requires explicit historical provenance and never executes old pending", async () => {
    const done = await commit(item()),
      pending = intent(item());
    await run(pending, "admit");
    generation = randomUUID();
    await expect(run(done.intent, "lookup")).rejects.toMatchObject({
      code: "historical_binding_unproven",
    });
    historyProof = true;
    try {
      expect(await run(done.intent, "admit")).toMatchObject({
        status: "committed",
        identity: done.result.identity,
      });
      await expect(run(pending, "execute")).rejects.toMatchObject({
        code: "reference_generation_mismatch",
      });
      await expect(
        run(pending, "retire", "Synthetic retirement request"),
      ).rejects.toMatchObject({ code: "reference_generation_mismatch" });
    } finally {
      historyProof = false;
    }
  });
  it("payload and subject replacement cannot reuse a nonce", async () => {
    const i = intent(item());
    await run(i, "admit");
    await expect(
      run(
        { ...i, input: { ...i.input, reason: "Changed original reason" } },
        "execute",
      ),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      run(
        { ...i, authority: { ...i.authority, subjectId: randomUUID() } },
        "execute",
      ),
    ).rejects.toMatchObject({ code: "reference_identity_mismatch" });
  });
  it("mandatory audit failure rolls back item/base unit and journal result", async () => {
    const i = intent(item());
    await run(i, "admit");
    await db
      .getPool()
      .query(
        "CREATE FUNCTION synthetic_reference_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entity='inventory_reference' THEN RAISE EXCEPTION 'synthetic reference audit refusal'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_reference_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_reference_audit()",
      );
    try {
      await expect(run(i, "execute")).rejects.toThrow(
        "synthetic reference audit refusal",
      );
      expect(
        (
          await db
            .getPool()
            .query("SELECT id FROM inventory_items WHERE name=$1", [
              i.input.action === "item.create" ? i.input.name : "",
            ])
        ).rows,
      ).toHaveLength(0);
    } finally {
      await db
        .getPool()
        .query(
          "DROP TRIGGER synthetic_reference_audit ON audit_log; DROP FUNCTION synthetic_reference_audit()",
        );
    }
    expect(await run(i, "execute")).toMatchObject({ status: "committed" });
  });
  it("explicit retirement durably fences pending execution and preserves committed acknowledgement", async () => {
    const i = intent(item());
    await run(i, "admit");
    const retired = await run(
      i,
      "retire",
      "Synthetic operator no longer needs item",
    );
    expect(retired.status).toBe("retired");
    expect(await run(i, "execute")).toEqual(retired);
    const done = await commit(item());
    expect(
      await run(done.intent, "retire", "Synthetic late retirement request"),
    ).toMatchObject({ status: "committed", identity: done.result.identity });
  });
  it("read exposes bounded references, current policy and no fabricated ready flag", async () => {
    const read = await tx((c) =>
      service.read(c, actor.userId, "SYN-REFERENCE", 0),
    );
    expect(read.items.length).toBeGreaterThan(0);
    expect(read.items.length).toBeLessThanOrEqual(20);
    expect(read).not.toHaveProperty("canActivate");
    expect(read.policy?.allowSelfApproval).toBe(false);
  });
});
