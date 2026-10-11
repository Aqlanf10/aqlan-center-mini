import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { hashPassword } from "../../lib/auth";
import { DEFAULT_DOCTOR_PERMISSIONS, type DoctorPermissions } from "../../lib/doctor-permissions";
import { assertPostgresMajorOrThrow, postgresMajorFromVersionNum } from "../../lib/env-contract";
import { validateLocalVerificationTarget, validateOperationalVerificationEnvironment } from "../../lib/verification-target-policy.mjs";
import type { StrategyCommand } from "../../lib/ortho-treatment-strategy";
import { authedGet, authedMutation, harness, loginStaff } from "./_server";

type Harness = Awaited<ReturnType<typeof harness>>;
export type StrategySession = { cookie: string };
type DatabaseIdentity = { name: string; oid: string; owner: string };

/** The added live proof is authorized only inside this repository's existing
 * disposable PostgreSQL service job, not merely on a database named "test". */
export function assertStrategyCiBoundary(environment: NodeJS.ProcessEnv = process.env): void {
  if (environment.CI !== "true" || environment.GITHUB_ACTIONS !== "true"
    || environment.GITHUB_REPOSITORY !== "Aqlanf10/aqlan-center-mini"
    || !/^[1-9]\d*$/.test(environment.GITHUB_RUN_ID ?? "") || environment.GITHUB_JOB !== "quality") {
    throw new Error("Strategy live proof is restricted to the repository's disposable GitHub Actions quality job.");
  }
}

/** Source-only regression fixture. Execution is restricted to the disposable
 * PostgreSQL 18 service owned by the security-HTTP CI job. The inherited global
 * setup resets its fixed aqlan_sec_http database; this helper does not make that
 * setup safe for an arbitrary existing local cluster. Never target Production.
 * All application rows here are UUID-owned. No fixture deletes history/audit,
 * disables constraints/triggers, resets a schema, or rewrites shared users. */
export async function createStrategyFixture(h: Harness, label: string, options: {
  status?: "active" | "retention" | "completed" | "discontinued";
  permissions?: Partial<DoctorPermissions>;
} = {}) {
  assertStrategyCiBoundary();
  validateOperationalVerificationEnvironment(process.env);
  const target = validateLocalVerificationTarget(h.seeded.dbUrl, process.env, {
    varName: "security-http seeded dbUrl", databaseName: "aqlan_sec_http",
  });
  const uuid = randomUUID().replaceAll("-", "");
  const marker = `STRATEGY_PRIVATE_${uuid}`;
  const username = `strategy_${uuid}`;
  const password = `Synthetic#${uuid}`;
  const db = new Client({ connectionString: target.toString(), ssl: false,
    application_name: `strategy_fixture_${uuid}` });
  await db.connect();
  let closed = false;
  try {
    const identity = async () => {
      const result = await db.query<DatabaseIdentity & { version: string; current_user_name: string }>(
        `SELECT datname AS name, oid::text, datdba::text AS owner,
          current_setting('server_version_num') AS version,
          (SELECT usesysid::text FROM pg_user WHERE usename = current_user) AS current_user_name
         FROM pg_database WHERE datname = current_database()`);
      if (result.rows.length !== 1 || result.rows[0].name !== "aqlan_sec_http"
        || result.rows[0].owner !== result.rows[0].current_user_name) {
        throw new Error("Strategy fixture requires the CI-owned security-HTTP database and owner.");
      }
      assertPostgresMajorOrThrow(postgresMajorFromVersionNum(result.rows[0].version));
      return result.rows[0];
    };
    const originalIdentity = await identity();
    const assertDatabaseIdentity = async () => {
      const current = await identity();
      if (current.name !== originalIdentity.name || current.oid !== originalIdentity.oid
        || current.owner !== originalIdentity.owner) throw new Error("Strategy fixture database identity changed.");
    };
    const seeded = await db.query<{ id: number; patient_number: string }>(
      "SELECT id, patient_number FROM patients WHERE id = ANY($1::int[]) ORDER BY id",
      [[h.seeded.patientAId, h.seeded.patientBId]]);
    if (seeded.rows.length !== 2
      || !seeded.rows.some(row => row.id === h.seeded.patientAId && row.patient_number === "SECA-001")
      || !seeded.rows.some(row => row.id === h.seeded.patientBId && row.patient_number === "SECB-002")) {
      throw new Error("Security-HTTP seeded identities are missing; fixture writes refused.");
    }
    const partyId = (await db.query<{ id: number }>(
      "INSERT INTO parties(name,kind) VALUES($1,'doctor') RETURNING id", [`Synthetic strategy ${label} ${uuid}`])).rows[0].id;
    const permissions = { ...DEFAULT_DOCTOR_PERMISSIONS, canViewAllPatients: false,
      canViewPlans: true, canEditPlans: true, ...options.permissions };
    const userId = (await db.query<{ id: number }>(
      `INSERT INTO users(username,display_name,password_hash,role,party_id,permissions)
       VALUES($1,$2,$3,'doctor',$4,$5::jsonb) RETURNING id`,
      [username, `Synthetic clinician ${uuid}`, await hashPassword(password), partyId, JSON.stringify(permissions)])).rows[0].id;
    const patientNumber = `STRATEGY-${uuid}`;
    const patientId = (await db.query<{ id: number }>(
      "INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,$2,$3) RETURNING id",
      [patientNumber, `Synthetic strategy patient ${uuid}`, partyId])).rows[0].id;
    const planId = (await db.query<{ id: number }>(
      `INSERT INTO treatment_plans(patient_id,title,total_minor,base_currency,created_by)
       VALUES($1,$2,13579,'YER',$3) RETURNING id`, [patientId, marker, username])).rows[0].id;
    const orthoCaseId = (await db.query<{ id: number }>(
      `INSERT INTO ortho_cases(patient_id,created_by,status,upper_wire,lower_wire,note,plan_id,
        closed_at,closed_by,closed_note) VALUES($1,$2,$3,'014 NiTi','012 NiTi',$4,$5,
        CASE WHEN $3 IN ('completed','discontinued') THEN clock_timestamp() ELSE NULL END,
        CASE WHEN $3 IN ('completed','discontinued') THEN $2 ELSE NULL END,
        CASE WHEN $3 IN ('completed','discontinued') THEN 'Synthetic preserved closure' ELSE NULL END) RETURNING id`,
      [patientId, username, options.status ?? "active", marker, planId])).rows[0].id;
    const clinicalCaseId = (await db.query<{ id: number }>(
      `INSERT INTO clinical_cases(patient_id,specialty,title,site,ortho_case_id,created_by)
       VALUES($1,'orthodontics',$2,'upper and lower',$3,$4) RETURNING id`,
      [patientId, marker, orthoCaseId, username])).rows[0].id;
    const problemId = (await db.query<{ id: number }>(
      `INSERT INTO patient_problems(patient_id,label,site,specialty,case_id,noted_by)
       VALUES($1,$2,'upper','orthodontics',$3,$4) RETURNING id`,
      [patientId, `${marker}_PROBLEM`, clinicalCaseId, username])).rows[0].id;
    const itemId = (await db.query<{ id: number }>(
      `INSERT INTO plan_items(plan_id,case_id,service_name,tooth_code,unit_price_minor,status)
       VALUES($1,$2,$3,11,13579,'planned') RETURNING id`,
      [planId, clinicalCaseId, `${marker}_ITEM`])).rows[0].id;
    const session = await loginStaff(username, password);
    const path = `/api/ortho/${orthoCaseId}/strategy`;
    const command = (overrides: Partial<StrategyCommand> = {}): StrategyCommand => ({
      schemaVersion: 1, commandId: `strategy_${randomUUID().replaceAll("-", "")}`,
      expectedRevisionId: null, reason: `Synthetic clinical documentation ${label}`,
      rows: [{ problemId, objective: "Clinician-entered objective", strategy: "Clinician-entered strategy",
        planItemIds: [itemId], rationale: null }], ...overrides,
    });
    const history = async () => (await db.query<{ row: Record<string, unknown> }>(
      "SELECT to_jsonb(r) AS row FROM ortho_strategy_revisions r WHERE ortho_case_id=$1 ORDER BY version", [orthoCaseId])).rows.map(row => row.row);
    const audit = async () => (await db.query<{ row: Record<string, unknown> }>(
      `SELECT to_jsonb(a) AS row FROM audit_log a WHERE action='ortho.strategy_revision'
       AND details->>'orthoCaseId'=$1 ORDER BY id`, [String(orthoCaseId)])).rows.map(row => row.row);
    const counts = async () => ({ revisions: (await history()).length, audits: (await audit()).length });
    /** Whole-table byte-equivalent JSON witnesses, including unrelated cases.
     * Suite configuration is serial; these tables must not change on strategy
     * reads/writes/refusals. Explicit fixture surgery takes a fresh baseline. */
    const snapshot = async () => {
      const result: Record<string, unknown> = {};
      for (const table of ["patients", "clinical_cases", "patient_problems", "ortho_cases", "ortho_adjustments",
        "treatment_plans", "plan_items", "plan_item_dependencies", "plan_installments", "planned_visits",
        "treatment_sessions", "visits", "visit_procedures", "patient_diagnoses", "prescriptions", "tooth_conditions",
        "invoices", "invoice_items", "payments", "patient_opening_balances", "inventory_movements",
        "appointments", "patient_documents", "journal_manual", "journal_manual_lines"] as const) {
        result[table] = (await db.query<{ rows: unknown }>(
          `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM ${table} t`)).rows[0].rows;
      }
      return result;
    };
    return { db, dbUrl: target.toString(), uuid, marker, username, password, permissions, userId, partyId,
      patientId, patientNumber, orthoCaseId, clinicalCaseId, problemId, planId, itemId, session, path,
      command, history, audit, counts, snapshot, assertDatabaseIdentity,
      post: (body: unknown = command(), as: StrategySession = session) => authedMutation(path, as, "POST", JSON.stringify(body)),
      read: (revisionId?: number, as: StrategySession = session) => authedGet(
        `${path}${revisionId === undefined ? "" : `?revisionId=${revisionId}`}`, as),
      setPermissions: async (changes: Partial<DoctorPermissions>) => {
        await assertDatabaseIdentity(); Object.assign(permissions, changes);
        const updated = await db.query("UPDATE users SET permissions=$1::jsonb WHERE id=$2 AND username=$3",
          [JSON.stringify(permissions), userId, username]);
        if (updated.rowCount !== 1) throw new Error("Owned strategy user disappeared.");
      },
      close: async () => { if (!closed) { closed = true; await db.end(); } },
    };
  } catch (error) {
    closed = true; await db.end(); throw error;
  }
}
export type StrategyFixture = Awaited<ReturnType<typeof createStrategyFixture>>;
