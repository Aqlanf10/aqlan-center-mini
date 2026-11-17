import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { seedCanonicalCoverage } from "../fixtures/canonical-ortho-coverage";
import { applyRuntimeMigrationFiles, loadMigrationFiles } from "../../lib/migrations";
import type { FollowupCoverageCommand } from "../../lib/ortho-followup-coverage";
vi.mock("server-only",()=>({})); assertRealPostgresUrl(); stubPostgresEnv(); vi.stubEnv("SESSION_SECRET","synthetic-coverage-retirement-secret-0123456789");
const db=await import("../../lib/db"), command=await import("../../lib/canonical-ortho-coverage-command"), status=await import("../../lib/canonical-ortho-coverage-status"), editor=await import("../../lib/canonical-ortho-coverage-editor");
const accounts={owner:{username:"SYN-RETIRE-OWNER",role:"admin",doctor:true}, denied:{username:"SYN-RETIRE-DENIED",role:"reception",patientScope:"none"}} as const;
let fx:CanonicalInventoryDatabase<keyof typeof accounts>;
beforeAll(async()=>{
 fx=await openCanonicalInventoryDatabase(db,accounts,"owner");
 // Explicit historical fixture, independent of whether fresh bootstrap activates 0079.
 const old=(await loadMigrationFiles()).find(f=>f.version==="0079");if(!old)throw new Error("Historical 0079 source required");
 await applyRuntimeMigrationFiles(fx.pool,[old]);
},180000);
afterAll(async()=>{await fx?.close();});
it("preserves exact historical receipts and rejects new or simultaneous requests without changing historical data",async()=>{
 const p=(await fx.pool.query("INSERT INTO patients(patient_number,full_name) VALUES('SYN-RETIRED-COV','Synthetic patient') RETURNING id")).rows[0].id;
 let snapshot:unknown;
 const observed={query:async(sql:string,values?:unknown[])=>{const r=await fx.pool.query(sql,values);if(sql.startsWith("WITH candidates AS MATERIALIZED"))snapshot=r.rows[0]?.sources?.[0]?.snapshot;return r;}} as Pick<Pool,"query">;
 const s=await seedCanonicalCoverage(observed,{patientId:p,actorId:fx.ids.owner,doctorId:fx.parties.owner!,save:false});
 await fx.pool.query("UPDATE ortho_cases SET status='active' WHERE id=$1",[s.ortho]);
 const {fingerprint,invoiceNumber:_n,serviceName:_s,...source}=s.source;
 const c:FollowupCoverageCommand={schemaVersion:1,commandId:randomUUID(),expectedRevisionId:null,source,expectedSourceFingerprint:fingerprint,scope:"routine_adjustments",decision:"included",reason:"SYN prior historical decision"};
 const hash=createHash("sha256").update(JSON.stringify({patientId:p,orthoCaseId:s.ortho,actorUserId:fx.ids.owner,command:c})).digest("hex");
 await fx.pool.query(`INSERT INTO ortho_followup_coverage_revisions(patient_id,ortho_case_id,clinical_case_id,plan_id,plan_item_id,invoice_id,version,scope,decision,source_fingerprint,source_snapshot,reason,actor_user_id,created_by,command_id,request_fingerprint)
 VALUES($1,$2,$3,$4,$5,$6,1,'routine_adjustments','included',$7,$8::jsonb,$9,$10,$11,$12,$13)`,[p,s.ortho,s.clinical,s.plan,s.item,s.invoice,fingerprint,JSON.stringify(snapshot),c.reason,fx.ids.owner,accounts.owner.username,c.commandId,hash]);
 const refused={...c,commandId:randomUUID(),decision:"excluded" as const};
 const refusedHash=createHash("sha256").update(JSON.stringify({patientId:p,orthoCaseId:s.ortho,actorUserId:fx.ids.owner,command:refused})).digest("hex");
 await fx.pool.query(`INSERT INTO ortho_followup_coverage_rejections(command_id,request_fingerprint,patient_id,ortho_case_id,actor_user_id,actor,command,code,message)
 VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,'stale_coverage','Synthetic original refusal')`,[refused.commandId,refusedHash,p,s.ortho,fx.ids.owner,accounts.owner.username,JSON.stringify(refused)]);
 const rows=async()=>(await fx.pool.query("SELECT (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM ortho_followup_coverage_revisions r) revisions,(SELECT jsonb_agg(to_jsonb(r) ORDER BY command_id) FROM ortho_followup_coverage_rejections r) rejections,(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM audit_log a) audits")).rows;
 const before=await rows(),owner=await fx.session("owner"),denied=await fx.session("denied");
 const historical=await status.readCanonicalCoverageCommandStatus(owner,p,s.ortho,c);expect(historical).toMatchObject({state:"committed",revision:{commandId:c.commandId}});
 expect(await command.commandCanonicalFollowupCoverage(owner,p,s.ortho,c)).toMatchObject({ok:true,replayed:true,revision:{commandId:c.commandId}});
 expect(await status.readCanonicalCoverageCommandStatus(owner,p,s.ortho,refused)).toMatchObject({state:"rejected",rejection:{commandId:refused.commandId,code:"stale_coverage"}});
 await expect(command.commandCanonicalFollowupCoverage(owner,p,s.ortho,refused)).rejects.toMatchObject({code:"stale_coverage"});
 const projection=await editor.readCanonicalCoverageEditor(owner,p,s.ortho);expect(projection).toMatchObject({enabled:true,canEdit:false,current:{decision:"included"}});expect(projection.current).not.toHaveProperty("commandId");
 await expect(status.readCanonicalCoverageCommandStatus(denied,p,s.ortho,c)).rejects.toThrow();
 await expect(command.commandCanonicalFollowupCoverage(denied,p,s.ortho,c)).rejects.toThrow();
 const fresh={...c,commandId:randomUUID(),expectedRevisionId:historical.state==="committed"?historical.revision.id:null};
 const results=await Promise.allSettled([command.commandCanonicalFollowupCoverage(owner,p,s.ortho,fresh),command.commandCanonicalFollowupCoverage(owner,p,s.ortho,fresh)]);
 expect(results).toHaveLength(2);for(const r of results){expect(r.status).toBe("rejected");if(r.status==="rejected")expect(r.reason).toMatchObject({code:"coverage_authoring_retired"});}
 await expect(command.commandCanonicalFollowupCoverage(owner,p,s.ortho,{...c,reason:"SYN tampered request"})).rejects.toMatchObject({code:"command_conflict"});
 expect(await rows()).toEqual(before);
 // An unavailable historical substrate must not be misreported as a terminal outcome.
 await fx.pool.query("ALTER TABLE visits DISABLE TRIGGER ortho_followup_visit_manifest");
 try { await expect(status.readCanonicalCoverageCommandStatus(owner,p,s.ortho,c)).rejects.toMatchObject({status:503,code:"coverage_not_ready"}); }
 finally { await fx.pool.query("ALTER TABLE visits ENABLE TRIGGER ortho_followup_visit_manifest"); }
 expect(await rows()).toEqual(before);
},180000);
