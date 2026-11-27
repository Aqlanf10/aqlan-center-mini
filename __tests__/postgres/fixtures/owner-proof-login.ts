import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { expect, vi } from "vitest";
import { POST as login } from "../../../app/api/auth/login/route";
import { PATCH as editNumbering } from "../../../app/api/settings/patient-numbering/route";
import { hashPassword, SESSION_COOKIE, sessionCredentialVersion } from "../../../lib/auth";
import { ensureSchema, getPool, resetPoolForTesting } from "../../../lib/db";
import { ownerContextFromTrustedBinding, resolveStaffCapabilities, staffAuthorizationFingerprint } from "../../../lib/staff-capabilities";
import { ownerProofForLogin } from "./owner-proof-session";

// Supply only the request cookie jar; login, session validation, and both DBs are real.
const jar = vi.hoisted(() => ({ cookie: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (key: string) => (key === SESSION_COOKIE && jar.cookie ? { value: jar.cookie } : undefined) }),
  headers: async () => new Headers(),
}));

async function staffLogin(username: string, password: string) {
  const response = await login(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username, password }),
    }),
  );
  expect(response.status).toBe(303);
  expect(new URL(response.headers.get("location")!).pathname).toBe("/");
  const cookie = response.cookies.get(SESSION_COOKIE);
  if (!cookie?.httpOnly || !cookie.value) throw new Error("Missing ordinary staff login cookie");
  return cookie.value;
}

export async function proveExistingLogin(issuer: Pool, redeemer: Pool, bootstrap: Pool) {
  const socket = bootstrap.options.host;
  if (socket !== "/tmp/aqlan-owner-enroll-pg/socket" || bootstrap.options.database !== "owner_proof_test") {
    throw new Error("Expected the disposable owner-proof authority");
  }
  const suffix = randomUUID().replaceAll("-", "");
  const db = "proof_accounts_" + suffix;
  const role = "proof_app_" + suffix;
  const url = new URL("postgresql://localhost/" + db);
  url.username = role;
  url.port = String(bootstrap.options.port ?? 5432);
  url.searchParams.set("host", socket);
  url.searchParams.set("sslmode", "disable");
  const clinic = "clinic-login";
  const environment = "rehearsal";
  let createdRole = false;
  let createdDb = false;
  try {
    await bootstrap.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB`);
    createdRole = true;
    await bootstrap.query(`CREATE DATABASE ${db} OWNER ${role}`);
    createdDb = true;
    vi.stubEnv("DATABASE_URL", url.toString());
    vi.stubEnv("SESSION_SECRET", randomBytes(32).toString("hex"));
    await ensureSchema();
    const {
      rows: [privileges],
    } = await getPool().query(
      `SELECT current_database() AS db, to_regnamespace('owner_proof') IS NULL AS separate,
              pg_has_role(current_user, 'proof_issuer', 'MEMBER') AS issuer,
              pg_has_role(current_user, 'proof_custodian', 'MEMBER') AS custodian`,
    );
    expect(privileges).toEqual({ db, separate: true, issuer: false, custodian: false });
    const password = randomBytes(24).toString("hex");
    const ownerHash = await hashPassword(password);
    const otherPassword = randomBytes(24).toString("hex");
    const otherHash = await hashPassword(otherPassword);
    const { rows: accounts } = await getPool().query<{ id: number; username: string }>(
      `INSERT INTO users(username,display_name,password_hash,role)
       VALUES ('fixture-first','Fixture first admin',$1,'admin'), ('fixture-owner','Fixture owner',$2,'admin')
       RETURNING id,username`,
      [otherHash, ownerHash],
    );
    const owner = accounts.find((account) => account.username === "fixture-owner")!;
    const credential = sessionCredentialVersion(ownerHash);
    const ownerLogin = await staffLogin(owner.username, password);
    const otherLogin = await staffLogin("fixture-first", otherPassword);
    const proof = ownerProofForLogin(redeemer, clinic, environment);
    async function issue() {
      const raw = randomBytes(32);
      const result = await issuer.query<{ ok: boolean }>(
        "SELECT owner_proof.issue($1,$2,$3,$4,$5,60) AS ok",
        [clinic, environment, owner.id, credential, createHash("sha256").update(raw).digest()],
      );
      expect(result.rows[0].ok).toBe(true);
      return raw.toString("hex");
    }

    const code = await issue();
    jar.cookie = "";
    expect(await proof.redeem(code)).toBe(false);
    jar.cookie = otherLogin;
    expect(await proof.redeem(code)).toBe(false);
    expect(await proof.current()).toBeNull();
    jar.cookie = ownerLogin;
    expect(await proof.current()).toBeNull();
    expect(await proof.redeem(code)).toBe(true);
    function fingerprint(binding: NonNullable<Awaited<ReturnType<typeof proof.current>>>) {
      const access = resolveStaffCapabilities(
        {
          subject: { userId: owner.id, role: "admin", isActive: true, clinicianPartyId: null },
          permissionDocument: { schemaVersion: 1, revision: 1, patientScope: "none", appointmentScope: "none", grants: {} },
        },
        ownerContextFromTrustedBinding(binding),
      );
      expect(access.isOwner).toBe(true);
      return staffAuthorizationFingerprint(access);
    }
    const first = await proof.current();
    expect(first?.ownerUserId).toBe(owner.id);
    expect(await proof.redeem(code)).toBe(false);
    jar.cookie = otherLogin;
    expect(await proof.current()).toBeNull();
    jar.cookie = ownerLogin;
    const closed = await editNumbering(
      new Request("http://localhost/api/settings/patient-numbering", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    expect(closed.status).toBe(403);

    expect((await issuer.query("SELECT owner_proof.revoke_binding($1,$2) AS ok", [clinic, environment])).rows[0].ok).toBe(
      true,
    );
    expect(await proof.current()).toBeNull();
    expect(await proof.redeem(code)).toBe(false);
    expect(await proof.redeem(await issue())).toBe(true);
    const rebound = await proof.current();
    expect(rebound?.ownerUserId).toBe(owner.id);
    if (!first || !rebound) throw new Error("Expected a fresh binding after new enrollment");
    const originalFingerprint = fingerprint(first);
    expect(originalFingerprint).toMatch(/^staff-v1:/);
    expect(fingerprint(rebound)).not.toEqual(originalFingerprint);

    // A password reset cannot let a second administrator inherit the owner's binding.
    const replacement = randomBytes(24).toString("hex");
    await getPool().query("UPDATE users SET password_hash=$1 WHERE id=$2", [await hashPassword(replacement), owner.id]);
    expect(await proof.current()).toBeNull();
    jar.cookie = await staffLogin(owner.username, replacement);
    expect(await proof.current()).toBeNull();
    expect((await getPool().query("SELECT count(*)::int AS n FROM users")).rows[0].n).toBe(2);
  } finally {
    jar.cookie = "";
    await resetPoolForTesting();
    vi.unstubAllEnvs();
    if (createdDb) await bootstrap.query(`DROP DATABASE ${db}`);
    if (createdRole) await bootstrap.query(`DROP ROLE ${role}`);
  }
}
