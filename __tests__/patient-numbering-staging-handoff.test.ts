import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  SESSION_COOKIE,
  createSessionToken,
  hashPassword,
  sessionCredentialVersion,
} from "../lib/auth";
import { PATIENT_NUMBERING_POLICY_SCHEMA_SQL } from "../lib/patient-numbering-schema";
import {
  canPerformOwnerOperation,
  ownerContextFromTrustedBinding,
  resolveStaffCapabilities,
} from "../lib/staff-capabilities";
import { createIndependentPgReservationBackend } from "../lib/restore/numbering-pg-reservation";
import { reserveRestoredNumber } from "../lib/restore/numbering-reservation";
import { prepareBackupSql } from "../lib/restore/sql.mjs";
import * as ownerProvider from "../lib/patient-numbering-owner-provider";
import { ownerProofForLogin } from "./postgres/fixtures/owner-proof-session";

// Strictly isolated in-memory PGlite instances only — zero network or clinic DB access.
vi.stubEnv("USE_LOCAL_DB", "true");
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("DATABASE_URL", "");
vi.stubEnv("POSTGRES_URL", "");
vi.stubEnv("POSTGRES_PRISMA_URL", "");
vi.stubEnv("POSTGRES_URL_NON_POOLING", "");
vi.stubEnv("TEST_DATABASE_URL", "");
vi.stubEnv("RAILWAY_PROJECT_ID", "");
vi.stubEnv("SESSION_SECRET", randomBytes(48).toString("hex"));

const cookieJar = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (key: string) => (key === SESSION_COOKIE && cookieJar.token ? { value: cookieJar.token } : undefined),
  }),
  headers: async () => new Headers(),
}));

const db = await import("../lib/db");
const { GET: getSettingsRoute } = await import("../app/api/settings/route");
const { PATCH: patchNumberingRoute } = await import("../app/api/settings/patient-numbering/route");
const { readPatientNumbering } = await import("../lib/patient-numbering");

const policyRangeSql = readFileSync(
  new URL("../lib/restore/experimental-numbering-policy-range.sql", import.meta.url),
  "utf8",
);
const allocatorSql = readFileSync(
  new URL("../lib/restore/experimental-numbering-allocator.sql", import.meta.url),
  "utf8",
);
const ownerProofSql = readFileSync(
  new URL("./postgres/fixtures/owner-proof-authority.sql", import.meta.url),
  "utf8",
);

function pglitePoolAdapter(instance: PGlite): Pick<Pool, "connect" | "query"> {
  const runQuery = async (sql: string, values?: unknown[]) => {
    const res = await instance.query(sql, values);
    const trimmed = sql.trimStart().toUpperCase();
    const command = trimmed.split(/\s+/)[0]?.replace(/;$/, "") ?? "SELECT";
    return {
      command,
      rows: res.rows as never[],
      rowCount: res.affectedRows ?? res.rows.length,
    };
  };
  return {
    query: runQuery as unknown as Pool["query"],
    connect: async () =>
      ({
        query: runQuery,
        release: () => {},
      }) as never,
  };
}

interface LedgerSeriesState {
  reservedThrough: bigint;
  selectedFloor: bigint;
}

/**
 * Independent durable ledger state held completely outside the clinic PGlite
 * heap so destroying and rebuilding the clinic DB during disaster recovery
 * preserves every committed and rolled-back reservation watermark.
 */
class SyntheticExternalLedger {
  generation: "source" | "closed" | "target" = "source";
  activePrefix = "P";
  activeFirst = 7000n;
  watermarks = new Map<string, LedgerSeriesState>([["P", { reservedThrough: 7000n, selectedFloor: 7000n }]]);
  receipts: Array<{ prefix: string; number: string; generation: string }> = [];
  selections: Array<{ prefix: string; firstNumber: string; generation: string }> = [];

  async syncToClinicBridge(clinicPool: ReturnType<typeof db.getPool>, expectedGeneration: "source" | "target") {
    await clinicPool.query(`
      DO $roles$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'recovery_numbering_bridge') THEN
          CREATE ROLE recovery_numbering_bridge NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
        END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'recovery_app') THEN
          CREATE ROLE recovery_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
        END IF;
      END;
      $roles$;
      CREATE SCHEMA IF NOT EXISTS numbering_bridge;
      CREATE TABLE IF NOT EXISTS numbering_bridge.external_mirror_state (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
        admitted_generation text NOT NULL,
        expected_generation text NOT NULL,
        active_prefix text COLLATE "C" NOT NULL,
        active_first bigint NOT NULL
      );
      CREATE TABLE IF NOT EXISTS numbering_bridge.external_mirror_watermarks (
        prefix text COLLATE "C" PRIMARY KEY,
        reserved_through bigint NOT NULL,
        selected_floor bigint NOT NULL
      );
    `);
    await clinicPool.query(
      `INSERT INTO numbering_bridge.external_mirror_state (singleton, admitted_generation, expected_generation, active_prefix, active_first)
       VALUES (true, $1, $2, $3, $4::bigint)
       ON CONFLICT (singleton) DO UPDATE
         SET admitted_generation = EXCLUDED.admitted_generation,
             expected_generation = EXCLUDED.expected_generation,
             active_prefix = EXCLUDED.active_prefix,
             active_first = EXCLUDED.active_first`,
      [this.generation, expectedGeneration, this.activePrefix, this.activeFirst.toString()],
    );
    for (const [prefix, state] of this.watermarks.entries()) {
      await clinicPool.query(
        `INSERT INTO numbering_bridge.external_mirror_watermarks (prefix, reserved_through, selected_floor)
         VALUES ($1, $2::bigint, $3::bigint)
         ON CONFLICT (prefix) DO UPDATE
           SET reserved_through = EXCLUDED.reserved_through,
               selected_floor = EXCLUDED.selected_floor`,
        [prefix, state.reservedThrough.toString(), state.selectedFloor.toString()],
      );
    }

    await clinicPool.query(`
      CREATE OR REPLACE FUNCTION numbering_bridge.active_choice()
        RETURNS TABLE(active_prefix text, active_first bigint)
      LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
      DECLARE
        st numbering_bridge.external_mirror_state%ROWTYPE;
      BEGIN
        SELECT * INTO STRICT st FROM numbering_bridge.external_mirror_state WHERE singleton;
        IF st.admitted_generation IS DISTINCT FROM st.expected_generation THEN
          RAISE EXCEPTION 'Generation is fenced' USING ERRCODE = '55000';
        END IF;
        active_prefix := st.active_prefix;
        active_first := st.active_first;
        RETURN NEXT;
      END;
      $body$;

      CREATE OR REPLACE FUNCTION numbering_bridge.next_available(requested_prefix text) RETURNS bigint
      LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
      DECLARE
        st numbering_bridge.external_mirror_state%ROWTYPE;
        wm numbering_bridge.external_mirror_watermarks%ROWTYPE;
      BEGIN
        SELECT * INTO STRICT st FROM numbering_bridge.external_mirror_state WHERE singleton;
        IF st.admitted_generation IS DISTINCT FROM st.expected_generation THEN
          RAISE EXCEPTION 'Generation is fenced' USING ERRCODE = '55000';
        END IF;
        SELECT * INTO wm FROM numbering_bridge.external_mirror_watermarks WHERE prefix = requested_prefix;
        IF NOT FOUND THEN
          IF requested_prefix = 'P' THEN RAISE EXCEPTION 'Series is not enrolled' USING ERRCODE = 'P0002'; END IF;
          RETURN 1;
        END IF;
        RETURN greatest(wm.reserved_through + 1, wm.selected_floor, CASE WHEN requested_prefix = 'P' THEN 7000 ELSE 1 END);
      END;
      $body$;

      CREATE OR REPLACE FUNCTION numbering_bridge.select_prefix(requested_prefix text, requested_first bigint) RETURNS text
      LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
      DECLARE
        st numbering_bridge.external_mirror_state%ROWTYPE;
        avail bigint;
      BEGIN
        IF NOT EXISTS (SELECT FROM public.patient_numbering_policy WHERE singleton
          AND prefix COLLATE "C" = requested_prefix AND first_number = requested_first) THEN
          RAISE EXCEPTION 'Expected a corresponding local settings change' USING ERRCODE = '55000';
        END IF;
        SELECT * INTO STRICT st FROM numbering_bridge.external_mirror_state WHERE singleton FOR UPDATE;
        IF st.admitted_generation IS DISTINCT FROM st.expected_generation THEN
          RAISE EXCEPTION 'Generation is fenced' USING ERRCODE = '55000';
        END IF;
        avail := numbering_bridge.next_available(requested_prefix);
        IF requested_first IS NULL OR requested_first < avail OR requested_first > 999999999999999999 THEN
          RAISE EXCEPTION 'Invalid or consumed first number' USING ERRCODE = '22003';
        END IF;
        INSERT INTO numbering_bridge.external_mirror_watermarks (prefix, reserved_through, selected_floor)
          VALUES (requested_prefix, 0, requested_first)
          ON CONFLICT (prefix) DO UPDATE SET selected_floor = EXCLUDED.selected_floor;
        UPDATE numbering_bridge.external_mirror_state
          SET active_prefix = requested_prefix, active_first = requested_first
          WHERE singleton;
        RETURN requested_prefix;
      END;
      $body$;

      CREATE OR REPLACE FUNCTION numbering_bridge.reserve(requested_prefix text, last_consumed bigint, pending_next bigint)
        RETURNS TABLE(confirmed_prefix text, reserved_number bigint)
      LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
      DECLARE
        st numbering_bridge.external_mirror_state%ROWTYPE;
        wm numbering_bridge.external_mirror_watermarks%ROWTYPE;
        local_prefix text;
        local_first bigint;
        avail bigint;
      BEGIN
        SELECT p.prefix, p.first_number INTO local_prefix, local_first
          FROM public.patient_numbering_policy p WHERE p.singleton;
        IF NOT FOUND THEN local_prefix := 'P'; local_first := 7000; END IF;
        IF local_prefix COLLATE "C" IS DISTINCT FROM requested_prefix THEN
          RAISE EXCEPTION 'Unexpected local numbering choice' USING ERRCODE = '55000';
        END IF;
        SELECT * INTO STRICT st FROM numbering_bridge.external_mirror_state WHERE singleton FOR UPDATE;
        IF st.admitted_generation IS DISTINCT FROM st.expected_generation THEN
          RAISE EXCEPTION 'Generation is fenced' USING ERRCODE = '55000';
        END IF;
        IF st.active_prefix COLLATE "C" IS DISTINCT FROM requested_prefix OR st.active_first IS DISTINCT FROM local_first THEN
          RAISE EXCEPTION 'Independent numbering choice differs' USING ERRCODE = '55000';
        END IF;
        SELECT * INTO STRICT wm FROM numbering_bridge.external_mirror_watermarks WHERE prefix = requested_prefix FOR UPDATE;
        IF wm.reserved_through < last_consumed THEN
          RAISE EXCEPTION 'Independent history does not cover local history' USING ERRCODE = '55000';
        END IF;
        avail := greatest(wm.reserved_through + 1, wm.selected_floor, CASE WHEN requested_prefix = 'P' THEN 7000 ELSE 1 END);
        UPDATE numbering_bridge.external_mirror_watermarks
          SET reserved_through = greatest(avail, pending_next)
          WHERE prefix = requested_prefix
          RETURNING prefix, reserved_through INTO STRICT confirmed_prefix, reserved_number;
        RETURN NEXT;
      END;
      $body$;
      GRANT USAGE ON SCHEMA numbering_bridge TO recovery_numbering_bridge;
      ALTER TABLE numbering_bridge.external_mirror_state OWNER TO recovery_numbering_bridge;
      ALTER TABLE numbering_bridge.external_mirror_watermarks OWNER TO recovery_numbering_bridge;
      ALTER FUNCTION numbering_bridge.active_choice() OWNER TO recovery_numbering_bridge;
      ALTER FUNCTION numbering_bridge.next_available(text) OWNER TO recovery_numbering_bridge;
      ALTER FUNCTION numbering_bridge.select_prefix(text, bigint) OWNER TO recovery_numbering_bridge;
      ALTER FUNCTION numbering_bridge.reserve(text, bigint, bigint) OWNER TO recovery_numbering_bridge;
    `);
  }

  async pullCommittedFromClinic(clinicPool: ReturnType<typeof db.getPool>) {
    const {
      rows: [state],
    } = await clinicPool.query<{ active_prefix: string; active_first: string }>(
      "SELECT active_prefix, active_first::text FROM numbering_bridge.external_mirror_state WHERE singleton",
    );
    this.activePrefix = state.active_prefix;
    this.activeFirst = BigInt(state.active_first);
    const { rows } = await clinicPool.query<{ prefix: string; reserved_through: string; selected_floor: string }>(
      "SELECT prefix, reserved_through::text, selected_floor::text FROM numbering_bridge.external_mirror_watermarks",
    );
    for (const row of rows) {
      this.watermarks.set(row.prefix, {
        reservedThrough: BigInt(row.reserved_through),
        selectedFloor: BigInt(row.selected_floor),
      });
    }
  }

  recordDurableBurn(prefix: string, number: bigint, generation: string) {
    const prev = this.watermarks.get(prefix) ?? { reservedThrough: 0n, selectedFloor: 1n };
    if (number > prev.reservedThrough) {
      this.watermarks.set(prefix, { ...prev, reservedThrough: number });
    }
    this.receipts.push({ prefix, number: number.toString(), generation });
  }
}

async function installManagedClinicStack(
  clinicPool: ReturnType<typeof db.getPool>,
  external: SyntheticExternalLedger,
  generation: "source" | "target",
) {
  await external.syncToClinicBridge(clinicPool, generation);
  await clinicPool.query(policyRangeSql);
  const {
    rows: [binding],
  } = await clinicPool.query<{ matches: boolean }>(`
    SELECT chosen.active_prefix COLLATE "C" = coalesce(p.prefix, 'P')
       AND chosen.active_first = coalesce(p.first_number, 7000) AS matches
      FROM numbering_bridge.active_choice() chosen
      LEFT JOIN public.patient_numbering_policy p ON p.singleton`);
  if (!binding?.matches) {
    throw Object.assign(new Error("Restored settings differ from the independent numbering choice"), { code: "55000" });
  }
  await clinicPool.query(allocatorSql);
  await clinicPool.query(`
    ALTER FUNCTION public.aqlan_next_patient_number() OWNER TO recovery_numbering_bridge;
    GRANT USAGE ON SCHEMA public TO recovery_numbering_bridge;
    GRANT SELECT, INSERT, UPDATE ON public.patients TO recovery_numbering_bridge;
    GRANT SELECT ON public.patient_number_retirements, public.patient_numbering_policy TO recovery_numbering_bridge;
    GRANT SELECT, UPDATE ON SEQUENCE public.patient_number_seq TO recovery_numbering_bridge;
  `);
}

describe("Patient Numbering & Recovery Staging Handoff — 5 Mandatory Guarantees (Synthetic PGlite)", () => {
  let ownerAuthorityDb: PGlite;
  let pgReservationAuthorityDb: PGlite;
  const externalLedger = new SyntheticExternalLedger();

  let ownerUser: { id: number; username: string; passwordHash: string };
  let nonOwnerAdmin: { id: number; username: string; passwordHash: string };
  let receptionUser: { id: number; username: string; passwordHash: string };

  function signSessionFor(account: { id: number; username: string; passwordHash: string }, role: string) {
    return createSessionToken({
      userId: account.id,
      username: account.username,
      role,
      expiresAt: Date.now() + 60_000,
      credentialVersion: sessionCredentialVersion(account.passwordHash),
    });
  }

  beforeAll(async () => {
    ownerAuthorityDb = new PGlite();
    await ownerAuthorityDb.exec(ownerProofSql);

    pgReservationAuthorityDb = new PGlite();
    await pgReservationAuthorityDb.exec(`
      CREATE SCHEMA proof;
      CREATE TABLE proof.generation_admission (lineage text PRIMARY KEY, generation text NOT NULL);
      CREATE TABLE proof.numbering_watermarks (
        lineage text REFERENCES proof.generation_admission(lineage),
        prefix text NOT NULL,
        reserved_through bigint NOT NULL CHECK (reserved_through BETWEEN 0 AND 999999999999999999),
        PRIMARY KEY (lineage, prefix)
      );
    `);

    await db.resetPoolForTesting();
    vi.stubEnv("SKIP_SEED", "true");
    await db.ensureSchema();
    const pool = db.getPool();

    // Seed synthetic staff accounts: an owner candidate admin, a second non-owner admin, and reception.
    const ownerHash = await hashPassword("Owner#SyntheticPass1");
    const adminHash = await hashPassword("Admin#SyntheticPass2");
    const receptionHash = await hashPassword("Reception#SyntheticPass3");
    const { rows: insertedUsers } = await pool.query<{ id: number; username: string; password_hash: string }>(
      `INSERT INTO users (username, display_name, password_hash, role)
       VALUES ('synthetic-owner', 'Synthetic Owner', $1, 'admin'),
              ('synthetic-other-admin', 'Synthetic Non-Owner Admin', $2, 'admin'),
              ('synthetic-reception', 'Synthetic Reception', $3, 'reception')
       RETURNING id, username, password_hash`,
      [ownerHash, adminHash, receptionHash],
    );
    ownerUser = {
      id: insertedUsers[0].id,
      username: insertedUsers[0].username,
      passwordHash: insertedUsers[0].password_hash,
    };
    nonOwnerAdmin = {
      id: insertedUsers[1].id,
      username: insertedUsers[1].username,
      passwordHash: insertedUsers[1].password_hash,
    };
    receptionUser = {
      id: insertedUsers[2].id,
      username: insertedUsers[2].username,
      passwordHash: insertedUsers[2].password_hash,
    };
  }, 60_000);

  afterAll(async () => {
    cookieJar.token = "";
    vi.restoreAllMocks();
    await db.resetPoolForTesting();
    await ownerAuthorityDb?.close();
    await pgReservationAuthorityDb?.close();
  });

  it("Guarantee 5 & 3: Runtime numbering activation remains LOCKED (403) by default, and non-owner admins are denied", async () => {
    // Unauthenticated requests get 401
    cookieJar.token = "";
    expect((await getSettingsRoute()).status).toBe(401);
    expect(
      (
        await patchNumberingRoute(
          new Request("http://localhost/api/settings/patient-numbering", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prefix: "BRW", firstNumber: "١٥٠٠", requestId: randomUUID() }),
          }),
        )
      ).status,
    ).toBe(401);

    // Non-owner admin: GET /api/settings omits __patientNumbering; PATCH /api/settings/patient-numbering returns 403!
    cookieJar.token = signSessionFor(nonOwnerAdmin, "admin");
    const adminSettingsRes = await getSettingsRoute();
    expect(adminSettingsRes.status).toBe(200);
    const adminSettingsBody = (await adminSettingsRes.json()) as Record<string, unknown>;
    expect(Object.hasOwn(adminSettingsBody, "__patientNumbering")).toBe(false);

    const adminPatchRes = await patchNumberingRoute(
      new Request("http://localhost/api/settings/patient-numbering", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prefix: "BRW", firstNumber: "١٥٠٠", requestId: randomUUID() }),
      }),
    );
    expect(adminPatchRes.status).toBe(403);

    // Enroll synthetic-owner in the separate owner_proof authority, and prove:
    // (a) non-owner admin CANNOT redeem the owner's invitation,
    // (b) even after synthetic-owner redeems in the authority, the unmocked runtime route STILL stays locked (403)!
    const authorityPool = pglitePoolAdapter(ownerAuthorityDb);
    const rawCode = randomBytes(32);
    const digest = createHash("sha256").update(rawCode).digest();
    const issued = await authorityPool.query<{ ok: boolean }>(
      "SELECT owner_proof.issue($1, $2, $3, $4, $5, 60) AS ok",
      [
        "aqlan-mini",
        "staging-rehearsal",
        ownerUser.id,
        sessionCredentialVersion(ownerUser.passwordHash),
        digest,
      ],
    );
    expect(issued.rows[0].ok).toBe(true);

    const proof = ownerProofForLogin(authorityPool, "aqlan-mini", "staging-rehearsal");
    cookieJar.token = signSessionFor(nonOwnerAdmin, "admin");
    expect(await proof.redeem(rawCode.toString("hex"))).toBe(false);
    expect(await proof.current()).toBeNull();

    cookieJar.token = signSessionFor(ownerUser, "admin");
    expect(await proof.redeem(rawCode.toString("hex"))).toBe(true);
    const enrolledBinding = await proof.current();
    expect(enrolledBinding?.ownerUserId).toBe(ownerUser.id);

    // Runtime provider is still unconnected -> GET hides __patientNumbering and PATCH returns 403!
    const lockedGet = await getSettingsRoute();
    expect(lockedGet.status).toBe(200);
    expect(Object.hasOwn(await lockedGet.json(), "__patientNumbering")).toBe(false);

    const lockedPatch = await patchNumberingRoute(
      new Request("http://localhost/api/settings/patient-numbering", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prefix: "brw", firstNumber: "١٥٠٠", requestId: randomUUID() }),
      }),
    );
    expect(lockedPatch.status).toBe(403);
  });

  it("Guarantees 1, 2, 3, 4 & 5 end-to-end: BRW + ١٥٠٠ -> BRW-01500, P-01500 & P-07000 preserved, non-owner denied, and post-backup 1501/1502 never reused after restore (-> BRW-01503)", async () => {
    const sourcePool = db.getPool();

    // Seed historical P-01500 and first default P-07000 BEFORE installing managed policy
    const {
      rows: [historicalP1500],
    } = await sourcePool.query<{ id: number; patient_number: string }>(
      "INSERT INTO patients (patient_number, full_name) VALUES ('P-01500', 'Synthetic Historical P1500') RETURNING id, patient_number",
    );
    const defaultP7000 = await db.createPatient({
      fullName: "Synthetic Default P7000",
      phone: null,
      altPhone: null,
      gender: "unknown",
      birthYear: null,
      address: null,
      medicalAlert: null,
      note: null,
    });
    expect(historicalP1500.patient_number).toBe("P-01500");
    expect(defaultP7000.patientNumber).toBe("P-07000");

    // Install opt-in policy schema + managed allocator bridge on source clinic DB
    await sourcePool.query(PATIENT_NUMBERING_POLICY_SCHEMA_SQL);
    externalLedger.watermarks.set("P", { reservedThrough: 7000n, selectedFloor: 7000n });
    await installManagedClinicStack(sourcePool, externalLedger, "source");

    // Capture an older archive BEFORE switching from P to BRW (to prove stale-choice rejection later!)
    let preBrwBackupSql = "";
    let archiveSql = "";
    for await (const line of db.backupSqlLines()) preBrwBackupSql += line;

    // Bind synthetic verified owner provider ONLY to ownerUser via the independent owner_proof authority!
    const authorityPool = pglitePoolAdapter(ownerAuthorityDb);
    const proof = ownerProofForLogin(authorityPool, "aqlan-mini", "staging-rehearsal");
    cookieJar.token = signSessionFor(ownerUser, "admin");
    const verifiedBinding = await proof.current();
    expect(verifiedBinding).not.toBeNull();
    const trustedOwnerCtx = ownerContextFromTrustedBinding(verifiedBinding!);

    const providerSpy = vi
      .spyOn(ownerProvider, "loadPatientNumberingOwnerAccess")
      .mockImplementation(async (session) =>
        resolveStaffCapabilities(
          {
            subject: { userId: session.userId, role: session.role, isActive: true, clinicianPartyId: null },
            permissionDocument: { schemaVersion: 1, revision: 1, patientScope: "none", appointmentScope: "none", grants: {} },
          },
          session.userId === ownerUser.id ? trustedOwnerCtx : null,
        ),
      );

    try {
      // Guarantee 3: Even while the owner provider is connected, non-owner admin & reception get 403!
      for (const [acct, role] of [
        [nonOwnerAdmin, "admin"],
        [receptionUser, "reception"],
      ] as const) {
        cookieJar.token = signSessionFor(acct, role);
        const getRes = await getSettingsRoute();
        expect(Object.hasOwn(await getRes.json(), "__patientNumbering")).toBe(false);
        const deniedRes = await patchNumberingRoute(
          new Request("http://localhost/api/settings/patient-numbering", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prefix: "brw", firstNumber: "١٥٠٠", requestId: randomUUID() }),
          }),
        );
        expect(deniedRes.status).toBe(403);
      }

      // Guarantee 1: Verified Owner selects `brw` + `١٥٠٠` -> normalizes to `BRW` + `1500` (`BRW-01500`)!
      cookieJar.token = signSessionFor(ownerUser, "admin");
      const ownerGetBefore = await getSettingsRoute();
      expect(ownerGetBefore.status).toBe(200);
      expect((await ownerGetBefore.json()).__patientNumbering).toEqual({
        prefix: "P",
        nextNumber: "7001",
        perPrefix: true,
      });

      const requestId = randomUUID();
      const ownerPatch = await patchNumberingRoute(
        new Request("http://localhost/api/settings/patient-numbering", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prefix: "brw", firstNumber: "١٥٠٠", requestId }),
        }),
      );
      expect(ownerPatch.status).toBe(200);
      expect(await ownerPatch.json()).toEqual({ prefix: "BRW", nextNumber: "1500", perPrefix: true });

      // Replay with canonical values is idempotent and writes only 1 audit row; conflicting replay gets 409; P < 7000 gets 400
      const replayPatch = await patchNumberingRoute(
        new Request("http://localhost/api/settings/patient-numbering", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prefix: "BRW", firstNumber: "1500", requestId }),
        }),
      );
      expect(replayPatch.status).toBe(200);
      expect(
        (
          await patchNumberingRoute(
            new Request("http://localhost/api/settings/patient-numbering", {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ prefix: "BRW", firstNumber: "1501", requestId }),
            }),
          )
        ).status,
      ).toBe(409);
      expect(
        (
          await patchNumberingRoute(
            new Request("http://localhost/api/settings/patient-numbering", {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ prefix: "P", firstNumber: "1500", requestId: randomUUID() }),
            }),
          )
        ).status,
      ).toBe(400);

      const { rows: auditRows } = await sourcePool.query(
        `SELECT details->>'prefix' AS prefix, details->>'firstNumber' AS first_number
         FROM audit_log WHERE entity = 'patient_numbering' AND action = 'settings.update'`,
      );
      expect(auditRows).toEqual([{ prefix: "BRW", first_number: "1500" }]);
      await externalLedger.pullCommittedFromClinic(sourcePool);

      // Issue first patient under BRW -> must be BRW-01500!
      const issuedBrw1500 = await db.createPatient({
        fullName: "Synthetic First BRW Patient",
        phone: null,
        altPhone: null,
        gender: "unknown",
        birthYear: null,
        address: null,
        medicalAlert: null,
        note: null,
      });
      expect(issuedBrw1500.patientNumber).toBe("BRW-01500");
      externalLedger.recordDurableBurn("BRW", 1500n, "source");

      // Guarantee 2: Historical P-01500 and P-07000 remain unchanged and distinct alongside BRW-01500!
      const p1500Matches = await db.searchPatients("P-01500");
      const p7000Matches = await db.searchPatients("P-07000");
      const brwArabicMatches = await db.searchPatients("brw-٠١٥٠٠");
      const suffixMatches = await db.searchPatients("٠١٥٠٠");
      expect(p1500Matches.map((p) => ({ id: p.id, n: p.patientNumber }))).toEqual([
        { id: historicalP1500.id, n: "P-01500" },
      ]);
      expect(p7000Matches.map((p) => ({ id: p.id, n: p.patientNumber }))).toEqual([
        { id: defaultP7000.id, n: "P-07000" },
      ]);
      expect(brwArabicMatches.map((p) => ({ id: p.id, n: p.patientNumber }))).toEqual([
        { id: issuedBrw1500.id, n: "BRW-01500" },
      ]);
      expect(suffixMatches.map((p) => p.patientNumber).sort()).toEqual(["BRW-01500", "P-01500"]);

      // Legacy P sequence cursor was NOT moved by BRW-01500
      expect((await sourcePool.query("SELECT last_value::text, is_called FROM patient_number_seq")).rows[0]).toEqual({
        last_value: "7000",
        is_called: true,
      });

      // Capture backup snapshot containing P-01500, P-07000, and BRW-01500
      for await (const line of db.backupSqlLines()) archiveSql += line;
      expect(archiveSql).toContain("Managed patient numbering archive requires the managed restore schema");

      // Post-backup activity on source BEFORE disaster:
      // 1) BRW-01501 is issued and committed on source
      const issuedAfterBackup = await db.createPatient({
        fullName: "Synthetic Post-Backup BRW 1501",
        phone: null,
        altPhone: null,
        gender: "unknown",
        birthYear: null,
        address: null,
        medicalAlert: null,
        note: null,
      });
      expect(issuedAfterBackup.patientNumber).toBe("BRW-01501");
      externalLedger.recordDurableBurn("BRW", 1501n, "source");

      // 2) BRW-01502 is reserved from allocator inside a transaction that ROLLS BACK on clinic DB,
      //    while the independent external authority durably retains watermark 1502!
      const txClient = await sourcePool.connect();
      try {
        await txClient.query("BEGIN");
        const {
          rows: [rolledBack],
        } = await txClient.query<{ n: string }>("SELECT public.aqlan_next_patient_number() AS n");
        expect(rolledBack.n).toBe("BRW-01502");
        externalLedger.recordDurableBurn("BRW", 1502n, "source");
        // Direct literal insert of a standalone reservation is rejected by patient_number_guard!
        await expect(
          txClient.query("INSERT INTO patients (patient_number, full_name) VALUES ($1, 'Rejected Literal')", [
            rolledBack.n,
          ]),
        ).rejects.toMatchObject({ code: "23514" });
        await txClient.query("ROLLBACK");
      } finally {
        txClient.release();
      }
    } finally {
      providerSpy.mockRestore();
    }

    // Also verify #602 createIndependentPgReservationBackend + reserveRestoredNumber on separate PGlite!
    const pgAuthPool = pglitePoolAdapter(pgReservationAuthorityDb);
    await pgAuthPool.query(
      "INSERT INTO proof.generation_admission (lineage, generation) VALUES ('synthetic_handoff_lineage', 'synthetic_source_generation')",
    );
    await pgAuthPool.query(
      "INSERT INTO proof.numbering_watermarks (lineage, prefix, reserved_through) VALUES ('synthetic_handoff_lineage', 'BRW', 1500), ('synthetic_handoff_lineage', 'P', 7000)",
    );
    const pgBackend = createIndependentPgReservationBackend(pgAuthPool, "proof");
    const brwSnapshot = {
      prefix: "BRW",
      allocatedThrough: 1500n,
      historicalThrough: 1500n,
      pendingNext: null,
      historyComplete: true,
      revision: "r-brw-archive",
    };
    expect(
      await reserveRestoredNumber(
        brwSnapshot,
        { lineage: "synthetic_handoff_lineage", generation: "synthetic_source_generation" },
        pgBackend,
      ),
    ).toEqual({ ok: true, prefix: "BRW", reserved: "1501" });
    expect(
      await reserveRestoredNumber(
        brwSnapshot,
        { lineage: "synthetic_handoff_lineage", generation: "synthetic_source_generation" },
        pgBackend,
      ),
    ).toEqual({ ok: true, prefix: "BRW", reserved: "1502" });
    await pgAuthPool.query(
      "UPDATE proof.generation_admission SET generation = 'synthetic_target_generation' WHERE lineage = 'synthetic_handoff_lineage'",
    );
    expect(
      await reserveRestoredNumber(
        brwSnapshot,
        { lineage: "synthetic_handoff_lineage", generation: "synthetic_source_generation" },
        pgBackend,
      ),
    ).toEqual({ ok: false, reason: "watermark-reservation-unconfirmed" });
    expect(
      await reserveRestoredNumber(
        brwSnapshot,
        { lineage: "synthetic_handoff_lineage", generation: "synthetic_target_generation" },
        pgBackend,
      ),
    ).toEqual({ ok: true, prefix: "BRW", reserved: "1503" });

    // Guarantee 4: Full source destruction & older backup restore onto a fresh clinic PGlite target!
    externalLedger.generation = "closed";
    await db.resetPoolForTesting(); // physically destroys the in-memory source clinic PGlite instance!

    // Step 4a: Attempting to replay the managed archive onto an ordinary target schema WITHOUT managed range fails closed!
    await db.ensureSchema();
    const unmigratedTarget = db.getPool();
    await unmigratedTarget.query(PATIENT_NUMBERING_POLICY_SCHEMA_SQL);
    await expect(
      unmigratedTarget.query("BEGIN;\n" + prepareBackupSql(archiveSql).dataSql + "\nCOMMIT;"),
    ).rejects.toThrow(/Managed patient numbering archive requires the managed restore schema/);

    // Step 4b: Attempting to install target bridge over the stale pre-BRW archive (which still says P) fails closed (55000)!
    await db.resetPoolForTesting();
    await db.ensureSchema();
    const staleTarget = db.getPool();
    await staleTarget.query(PATIENT_NUMBERING_POLICY_SCHEMA_SQL);
    await staleTarget.query(`DO $r$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='recovery_app') THEN CREATE ROLE recovery_app LOGIN; END IF; END; $r$;`);
    await staleTarget.query(policyRangeSql);
    await staleTarget.query(
      "BEGIN;\nSET CONSTRAINTS ALL DEFERRED;\n" + prepareBackupSql(preBrwBackupSql).dataSql + "\nCOMMIT;",
    );
    externalLedger.generation = "target";
    await expect(installManagedClinicStack(staleTarget, externalLedger, "target")).rejects.toMatchObject({
      code: "55000",
    });

    // Step 4c: Clean target restore of the BRW-01500 archive + independent ledger watermark 1502 -> next number is BRW-01503!
    await db.resetPoolForTesting();
    await db.ensureSchema();
    const restoredTarget = db.getPool();
    await restoredTarget.query(PATIENT_NUMBERING_POLICY_SCHEMA_SQL);
    await restoredTarget.query(`DO $r$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='recovery_app') THEN CREATE ROLE recovery_app LOGIN; END IF; END; $r$;`);
    await restoredTarget.query(policyRangeSql);
    await restoredTarget.query(
      "BEGIN;\nSET CONSTRAINTS ALL DEFERRED;\n" + prepareBackupSql(archiveSql).dataSql + "\nCOMMIT;",
    );
    await installManagedClinicStack(restoredTarget, externalLedger, "target");

    // Archived records P-01500, P-07000, BRW-01500 are present; post-backup BRW-01501 & BRW-01502 are absent from patients
    const restoredPatients = (
      await restoredTarget.query<{ id: number; patient_number: string }>(
        "SELECT id, patient_number FROM patients ORDER BY id",
      )
    ).rows;
    expect(restoredPatients).toEqual([
      { id: historicalP1500.id, patient_number: "P-01500" },
      { id: defaultP7000.id, patient_number: "P-07000" },
      { id: expect.any(Number), patient_number: "BRW-01500" },
    ]);

    expect(await readPatientNumbering(restoredTarget)).toEqual({
      prefix: "BRW",
      nextNumber: "1503",
      perPrefix: true,
    });

    const firstAfterRestore = await db.createPatient({
      fullName: "Synthetic First Patient After Disaster Recovery",
      phone: null,
      altPhone: null,
      gender: "unknown",
      birthYear: null,
      address: null,
      medicalAlert: null,
      note: null,
    });
    expect(firstAfterRestore.patientNumber).toBe("BRW-01503");

    // Guarantee 5 after restore: runtime owner gate remains closed (403)
    cookieJar.token = signSessionFor(ownerUser, "admin");
    expect(canPerformOwnerOperation(
      resolveStaffCapabilities({
        subject: { userId: ownerUser.id, role: "admin", isActive: true, clinicianPartyId: null },
        permissionDocument: { schemaVersion: 1, revision: 1, patientScope: "none", appointmentScope: "none", grants: {} },
      }),
      "settings.security.change",
    )).toBe(false);
    expect((await ownerProvider.loadPatientNumberingOwnerAccess({
      userId: ownerUser.id,
      username: ownerUser.username,
      role: "admin",
      expiresAt: Date.now() + 60_000,
    }))).toBeNull();
    expect(
      (
        await patchNumberingRoute(
          new Request("http://localhost/api/settings/patient-numbering", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prefix: "BRW", firstNumber: "1600", requestId: randomUUID() }),
          }),
        )
      ).status,
    ).toBe(403);
  }, 90_000);
});
