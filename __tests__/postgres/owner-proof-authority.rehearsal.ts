import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const socket = process.env.OWNER_PROOF_TEST_SOCKET;
const fixture = new URL("./fixtures/owner-proof-authority.sql", import.meta.url);
const roleSuffix = randomUUID().replaceAll("-", "");
const issuerLogin = `proof_test_issuer_${roleSuffix}`;
const redeemerLogin = `proof_test_redeemer_${roleSuffix}`;
let bootstrap: Pool;
let issuer: Pool;
let redeemer: Pool;
let installed = false;

type Connection = Pool | PoolClient;
type Subject = { clinic: string; environment: string; account: number; credential: string };

function subject(): Subject {
  return { clinic: `fixture-${randomUUID()}`, environment: "sandbox", account: 73, credential: "synthetic-first-credential" };
}
function code() {
  const raw = randomBytes(32);
  return { raw, digest: createHash("sha256").update(raw).digest() };
}
function fields(s: Subject) {
  return [s.clinic, s.environment, s.account, s.credential];
}
async function issue(s: Subject, digest: Buffer, ttl = 60) {
  const {
    rows: [row],
  } = await issuer.query("SELECT owner_proof.issue($1,$2,$3,$4,$5,$6) AS ok", [...fields(s), digest, ttl]);
  return row.ok;
}
async function redeem(s: Subject, raw: Buffer, connection: Connection = redeemer) {
  const {
    rows: [row],
  } = await connection.query("SELECT owner_proof.redeem($1,$2,$3,$4,$5) AS ok", [...fields(s), raw]);
  return row.ok;
}
async function current(s: Subject): Promise<string | null> {
  const {
    rows: [row],
  } = await redeemer.query("SELECT owner_proof.current_binding($1,$2,$3,$4)::text AS version", fields(s));
  return row.version;
}
async function revoke(s: Subject) {
  const {
    rows: [row],
  } = await issuer.query("SELECT owner_proof.revoke_binding($1,$2) AS ok", [s.clinic, s.environment]);
  return row.ok;
}
async function audit(s: Subject) {
  return (await bootstrap.query("SELECT * FROM owner_proof.audit WHERE clinic=$1 AND environment=$2 ORDER BY id", [
    s.clinic,
    s.environment,
  ])).rows;
}

describe("independent numbering enrollment authority on a private PostgreSQL socket", () => {
  beforeAll(async () => {
    if (socket !== "/tmp/aqlan-owner-enroll-pg/socket" || (await realpath(socket)) !== socket) {
      throw new Error("OWNER_PROOF_TEST_SOCKET must point to a private synthetic owner-proof socket");
    }
    const port = Number(process.env.OWNER_PROOF_TEST_PORT ?? 5432);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("Invalid owner proof test port");
    const target = {
      host: socket,
      port,
      database: "owner_proof_test",
      ssl: false,
      connectionTimeoutMillis: 5000,
      statement_timeout: 20000,
    };
    bootstrap = new Pool({ ...target, user: "enrollment_fixture" });
    const {
      rows: [identity],
    } = await bootstrap.query(`
      SELECT current_database() AS db, session_user AS actor, inet_server_addr() IS NULL AS local,
             current_setting('server_version_num')::int / 10000 AS major,
             (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')) AS public_tables,
             to_regnamespace('owner_proof') IS NULL AS fresh_schema,
             NOT EXISTS (SELECT FROM pg_roles WHERE rolname IN ('proof_issuer','proof_redeemer','proof_custodian')) AS fresh_groups`);
    expect(identity).toEqual({
      db: "owner_proof_test",
      actor: "enrollment_fixture",
      local: true,
      major: 18,
      public_tables: 0,
      fresh_schema: true,
      fresh_groups: true,
    });
    await bootstrap.query(await readFile(fixture, "utf8"));
    installed = true;
    await bootstrap.query(`
      CREATE ROLE ${issuerLogin} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE proof_issuer;
      CREATE ROLE ${redeemerLogin} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE proof_redeemer`);
    issuer = new Pool({ ...target, user: issuerLogin });
    redeemer = new Pool({ ...target, user: redeemerLogin });
  });

  afterAll(async () => {
    await Promise.all([issuer?.end(), redeemer?.end()]);
    try {
      if (installed) {
        await bootstrap.query(`DROP SCHEMA owner_proof CASCADE;
          DROP ROLE IF EXISTS ${issuerLogin}, ${redeemerLogin};
          DROP OWNED BY proof_issuer, proof_redeemer, proof_custodian;
          DROP ROLE proof_issuer, proof_redeemer, proof_custodian`);
      }
    } finally {
      await bootstrap?.end();
    }
  });

  it("limits each login to its own operations and denies direct table access", async () => {
    const s = subject();
    const ticket = code();
    for (const [pool, login, otherGroup] of [
      [issuer, issuerLogin, "proof_redeemer"],
      [redeemer, redeemerLogin, "proof_issuer"],
    ] as const) {
      const {
        rows: [session],
      } = await pool.query(
        "SELECT session_user AS login, pg_has_role(session_user,$1,'MEMBER') AS crossover, pg_has_role(session_user,'proof_custodian','MEMBER') AS custodian",
        [otherGroup],
      );
      expect(session).toEqual({ login, crossover: false, custodian: false });
      for (const table of ["scopes", "used_digests", "audit"]) {
        await expect(pool.query(`SELECT 1 FROM owner_proof.${table} LIMIT 0`)).rejects.toMatchObject({ code: "42501" });
        await expect(pool.query(`DELETE FROM owner_proof.${table} WHERE false`)).rejects.toMatchObject({ code: "42501" });
      }
    }
    await expect(
      redeemer.query("SELECT owner_proof.issue($1,$2,$3,$4,$5,$6)", [...fields(s), ticket.digest, 60]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(redeemer.query("SELECT owner_proof.revoke_binding($1,$2)", [s.clinic, s.environment])).rejects.toMatchObject(
      { code: "42501" },
    );
    await expect(issuer.query("SELECT owner_proof.current_binding($1,$2,$3,$4)", fields(s))).rejects.toMatchObject({
      code: "42501",
    });
    await expect(redeem(s, ticket.raw, issuer)).rejects.toMatchObject({ code: "42501" });
  });

  it("rejects wrong scopes, identity, credential and digest-as-code without consuming the genuine code", async () => {
    const s = subject();
    const ticket = code();
    expect(await issue(s, ticket.digest)).toBe(true);
    const mismatches = [
      { ...s, clinic: s.clinic + "-other" },
      { ...s, environment: "other" },
      { ...s, account: s.account + 1 },
      { ...s, credential: "synthetic-changed" },
    ];
    for (const other of mismatches) expect(await redeem(other, ticket.raw)).toBe(false);
    expect(await redeem(s, ticket.digest)).toBe(false);
    expect(await redeem(s, code().raw)).toBe(false);
    expect(await current(s)).toBeNull();
    expect(await redeem(s, ticket.raw)).toBe(true);
    expect(await current(s)).toBe("1");
    for (const other of mismatches) expect(await current(other)).toBeNull();
    expect(await redeem(s, ticket.raw)).toBe(false);
    const rows = await audit(s);
    expect(rows.map((row) => [row.event, row.account_id, row.actor_principal])).toEqual([
      ["issue", s.account, issuerLogin],
      ["redeem", s.account, redeemerLogin],
    ]);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        ["id", "event", "clinic", "environment", "account_id", "binding_version", "occurred_at", "actor_principal"].sort(),
      );
      const rendered = JSON.stringify(row);
      for (const sensitive of [
        ticket.raw.toString("hex"),
        ticket.raw.toString("base64url"),
        ticket.digest.toString("hex"),
        ticket.digest.toString("base64url"),
        s.credential,
      ]) {
        expect(rendered.includes(sensitive)).toBe(false);
      }
    }
  });

  it("checks expiry after a row-lock wait even when the transaction and redemption started earlier", async () => {
    const s = subject();
    const ticket = code();
    const client = await redeemer.connect();
    const locker = await bootstrap.connect();
    try {
      await client.query("BEGIN");
      const {
        rows: [session],
      } = await client.query("SELECT pg_backend_pid() AS pid");
      expect(await issue(s, ticket.digest, 0)).toBe(false);
      expect(await issue(s, ticket.digest, 61)).toBe(false);
      expect(await issue(s, ticket.digest, 3)).toBe(true);
      await locker.query("BEGIN");
      const { rowCount } = await locker.query(
        `SELECT 1 FROM owner_proof.scopes WHERE clinic=$1 AND environment=$2 FOR UPDATE`,
        [s.clinic, s.environment],
      );
      expect(rowCount).toBe(1);
      const pending = redeem(s, ticket.raw, client);
      let accepted;
      try {
        await expect
          .poll(
            async () =>
              (await locker.query("SELECT pg_backend_pid() = ANY(pg_blocking_pids($1)) AS blocked", [session.pid])).rows[0]
                .blocked,
            { timeout: 5000 },
          )
          .toBe(true);
        const {
          rows: [observed],
        } = await bootstrap.query(
          `SELECT a.query_start < s.expires_at AS started_before_expiry
          FROM pg_stat_activity a, owner_proof.scopes s
          WHERE a.pid=$1 AND s.clinic=$2 AND s.environment=$3`,
          [session.pid, s.clinic, s.environment],
        );
        expect(observed.started_before_expiry).toBe(true);
        await locker.query(
          `SELECT pg_sleep(greatest(0, extract(epoch FROM expires_at - clock_timestamp()))::float8 + 0.05)
          FROM owner_proof.scopes WHERE clinic=$1 AND environment=$2`,
          [s.clinic, s.environment],
        );
      } finally {
        await locker.query("ROLLBACK");
        accepted = await pending;
      }
      expect(accepted).toBe(false);
      await client.query("COMMIT");
    } finally {
      try {
        await Promise.all([client.query("ROLLBACK"), locker.query("ROLLBACK")]);
      } finally {
        client.release();
        locker.release();
      }
    }
    expect(await current(s)).toBeNull();
    expect((await audit(s)).map((row) => row.event)).toEqual(["issue"]);
  });

  it("serializes two independent redeemers and commits exactly one binding receipt", async () => {
    const s = subject();
    const ticket = code();
    expect(await issue(s, ticket.digest)).toBe(true);
    const winner = await redeemer.connect();
    const follower = await redeemer.connect();
    try {
      const leftPid = (await winner.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const rightPid = (await follower.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      expect(leftPid).not.toBe(rightPid);
      await winner.query("BEGIN");
      expect(await redeem(s, ticket.raw, winner)).toBe(true);
      const following = redeem(s, ticket.raw, follower);
      try {
        await expect
          .poll(
            async () =>
              (await bootstrap.query("SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked", [rightPid, leftPid]))
                .rows[0].blocked,
            { timeout: 5000 },
          )
          .toBe(true);
      } finally {
        await winner.query("COMMIT");
        await following;
      }
      expect(await following).toBe(false);
      expect(await current(s)).toBe("1");
      expect((await audit(s)).map((row) => row.event)).toEqual(["issue", "redeem"]);
    } finally {
      await winner.query("ROLLBACK");
      winner.release();
      follower.release();
    }
  });

  it("supersedes pending codes and advances the binding version through revocation and rotation", async () => {
    const s = subject();
    const oldCode = code();
    const replacement = code();
    const rotated = code();
    expect(await issue(s, oldCode.digest)).toBe(true);
    expect(await issue(s, replacement.digest)).toBe(true);
    expect(await redeem(s, oldCode.raw)).toBe(false);
    expect(await redeem(s, replacement.raw)).toBe(true);
    expect(await current(s)).toBe("1");
    expect(await issue(s, rotated.digest)).toBe(false);
    expect(await revoke(s)).toBe(true);
    expect(await current(s)).toBeNull();
    expect(await redeem(s, replacement.raw)).toBe(false);
    expect(await revoke(s)).toBe(false);
    expect(await issue(subject(), replacement.digest)).toBe(false);
    const newCredential = { ...s, credential: "synthetic-second-credential" };
    expect(await issue(newCredential, rotated.digest)).toBe(true);
    expect(await redeem(s, rotated.raw)).toBe(false);
    expect(await redeem(newCredential, rotated.raw)).toBe(true);
    expect(await current(s)).toBeNull();
    expect(await current(newCredential)).toBe("3");
    expect((await audit(s)).map((row) => row.event)).toEqual([
      "issue",
      "issue",
      "redeem",
      "revoke",
      "issue",
      "redeem",
    ]);
  });

  it("cancels a pending invitation before redemption and retains its digest retirement", async () => {
    const s = subject();
    const cancelled = code();
    expect(await issue(s, cancelled.digest)).toBe(true);
    expect(await revoke(s)).toBe(true);
    expect(await current(s)).toBeNull();
    expect(await redeem(s, cancelled.raw)).toBe(false);
    expect(await issue(s, cancelled.digest)).toBe(false);
    expect((await audit(s)).map((row) => [row.event, row.actor_principal])).toEqual([
      ["issue", issuerLogin],
      ["revoke", issuerLogin],
    ]);
  });

  it("rolls back issue, redemption and revocation when their mandatory audit receipt fails", async () => {
    const s = subject();
    const ticket = code();
    const failAudit = () =>
      bootstrap.query(
        `ALTER TABLE owner_proof.audit ADD CONSTRAINT proof_test_receipt_failure CHECK (clinic <> '${s.clinic}') NOT VALID`,
      );
    const allowAudit = () => bootstrap.query("ALTER TABLE owner_proof.audit DROP CONSTRAINT proof_test_receipt_failure");
    async function withFailingAudit(action: () => Promise<unknown>) {
      await failAudit();
      try {
        await expect(action()).rejects.toMatchObject({ code: "23514" });
      } finally {
        await allowAudit();
      }
    }
    await withFailingAudit(() => issue(s, ticket.digest));
    expect(await current(s)).toBeNull();
    expect((await audit(s)).length).toBe(0);
    expect(await issue(s, ticket.digest)).toBe(true);
    await withFailingAudit(() => redeem(s, ticket.raw));
    expect(await current(s)).toBeNull();
    expect(await redeem(s, ticket.raw)).toBe(true);
    await withFailingAudit(() => revoke(s));
    expect(await current(s)).toBe("1");
    expect(await revoke(s)).toBe(true);
    expect(await current(s)).toBeNull();
    expect((await audit(s)).map((row) => row.event)).toEqual(["issue", "redeem", "revoke"]);
  });

  it("ordinary staff login can enroll while numbering remains closed", async () => {
    const { proveExistingLogin } = await import("./fixtures/owner-proof-login");
    await proveExistingLogin(issuer, redeemer, bootstrap);
  });
});
