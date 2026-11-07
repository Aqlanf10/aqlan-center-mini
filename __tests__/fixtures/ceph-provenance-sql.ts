import { parseCephSourceIdentity, sameCephSourceIdentity } from "../../lib/ceph-source-review";
import type { DbPool } from "../../lib/db";
import type { CephCompletionSnapshot } from "../../lib/ceph-completion-snapshot";
import type { PGlite } from "@electric-sql/pglite";
import type { SessionPayload } from "../../lib/auth";
import { captureCephCompletionWitness, readCephCompletionProvenance, cephProvenanceHash, readCephCompletionSources } from "../../lib/ceph-completion-provenance";
/** Minimal existing exact-body SQL fixtures isolate completion math/writer behavior.
 * Real session/row locks, schema triggers and archive parity have separate PG18 tests. */
export const cephProvenanceDependencies = { parseCephSourceIdentity, sameCephSourceIdentity, captureCephCompletionWitness, readCephCompletionProvenance, cephProvenanceHash,
  authorizeCephCompletion: async () => 9 };
export const syntheticCephSession = (username: string): SessionPayload => ({userId:9,username,role:"admin",partyId:null,
  expiresAt:Date.now()+60_000,credentialVersion:"synthetic-test-only"});
export async function installCephProvenanceFixture(sql: PGlite) {
  await sql.exec(`
    ALTER TABLE ceph_landmarks ADD COLUMN IF NOT EXISTS confirmed_by TEXT NOT NULL DEFAULT 'synthetic-reviewer';
    ALTER TABLE ceph_landmarks ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    CREATE TABLE ceph_completion_provenance(analysis_id BIGINT PRIMARY KEY,schema_version INTEGER,witness JSONB,witness_sha256 TEXT,
      actor_user_id INTEGER,sealed_by TEXT,sealed_at TIMESTAMPTZ);
    CREATE TABLE patient_documents(id INTEGER PRIMARY KEY,patient_id INTEGER,sha256 TEXT,width INTEGER,height INTEGER,removed_at TIMESTAMPTZ);
    INSERT INTO patient_documents VALUES(22,11,repeat('a',64),800,600,NULL);
    CREATE TABLE ceph_reference_sets(id INTEGER PRIMARY KEY,key TEXT,name TEXT,population TEXT,age_min INTEGER,age_max INTEGER,sex TEXT,version TEXT,active BOOLEAN);
    INSERT INTO ceph_reference_sets VALUES(1,'builtin_default','Synthetic references',NULL,NULL,NULL,NULL,'v1',TRUE);
    CREATE TABLE ceph_reference_values(set_id INTEGER,code TEXT,mean DOUBLE PRECISION,sd DOUBLE PRECISION);
  `);
}

export async function syntheticCephSources(pool:DbPool,snapshot:CephCompletionSnapshot) {
  const sources=await readCephCompletionSources(pool,snapshot);
  if(sources.state!=="available")throw new Error("Synthetic source fixture unavailable");
  return sources.identity;
}
