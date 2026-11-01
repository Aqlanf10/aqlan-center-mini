/* Plain Node SELECT-only boundary. No environment, connections or initialization. */
import { staffIdentitySchemaName } from "./staff-identity-schema-name.mjs";
export function staffLifecycleLockKey(schema="public"){return `aqlan.canonical.identity.substrate.v1:${staffIdentitySchemaName(schema)}`;}
const relations=["staff_authority_control","staff_identity_generations","staff_identity_subjects","staff_identity_state","staff_identity_binding_events","staff_identity_current","staff_authority_identity","staff_execution_epochs","users_staff_subject_identity","staff_restore_hold"];
/** Target-owned authority relations and identity columns. Backup never carries them as
 * data (restore protocol B1/B2); their presence is an authority footprint. */
export const STAFF_AUTHORITY_RELATIONS=Object.freeze([...relations]);
export const STAFF_AUTHORITY_COLUMNS=Object.freeze({users:Object.freeze(["authorization_mode","authorization_epoch","staff_subject_id"]),parties:Object.freeze(["clinical_authority_epoch"])});
const functions=["staff_restore_hold_guard","staff_authority_control_guard","staff_account_authority_epoch_guard","staff_clinical_authority_epoch_guard","staff_identity_history_guard","staff_identity_state_guard","staff_identity_subject_guard","staff_identity_event_guard","staff_identity_current_guard","staff_subject_identity_immutable","staff_realm_identity_immutable","staff_execution_epoch_immutable"];
const triggers=["staff_restore_hold_guard_row","staff_restore_hold_no_truncate","staff_authority_control_guard_row","staff_authority_control_guard_truncate","staff_account_authority_epoch","staff_clinical_authority_epoch","users_subject_identity_immutable","staff_realm_identity_immutable","staff_execution_epoch_immutable",...['staff_identity_generations','staff_identity_subjects','staff_identity_binding_events'].flatMap(t=>[`${t}_immutable`,`${t}_no_truncate`]),...['staff_identity_state','staff_identity_subjects','staff_identity_binding_events','staff_identity_current'].map(t=>`${t}_guard`),"staff_identity_state_no_truncate","staff_identity_current_no_truncate"];
function refuse(reason){throw new Error(`LEGACY_STAFF_${reason}`);}
/** SELECT-only inspection. Any authority footprint means disruptive maintenance
 * hold, NOT a compatible mixed-authority rollout. Errors never mean absence. */
async function readFootprint(source,s){
 const {rows}=await source.query(`SELECT (
 (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[]))+
 (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.proname=ANY($3::text[]))+
 (SELECT count(*) FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND t.tgname=ANY($4::text[]))+
 (SELECT count(*) FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND NOT a.attisdropped AND ((c.relname='users' AND a.attname=ANY(ARRAY['authorization_mode','authorization_epoch','staff_subject_id'])) OR (c.relname='parties' AND a.attname='clinical_authority_epoch')))
 )::text AS markers,
 (SELECT c.relkind::text FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='users') AS users_kind,
 (SELECT c.relkind::text FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='parties') AS parties_kind`,[s,relations,functions,triggers]);
 if(rows.length!==1 || typeof rows[0].markers!=="string" || !/^[0-9]+$/.test(rows[0].markers))refuse("AUTHORITY_SCHEMA_HELD");
 return rows[0];
}
/** SELECT-only inspection. Any authority footprint means disruptive maintenance
 * hold, NOT a compatible mixed-authority rollout. Errors never mean absence. */
export async function readLegacyStaffSchema(source,schema="public"){
 const s=staffIdentitySchemaName(schema);
 const row=await readFootprint(source,s);
 if(row.markers!=="0")refuse("AUTHORITY_SCHEMA_HELD");
 if(row.users_kind===null && row.parties_kind===null)return "empty";
 if(row.users_kind!=="r" || row.parties_kind!=="r")refuse("BASE_SCHEMA_UNREADABLE");
 return "base";
}
/** Entry selection for one deployment state, never a per-request fallback:
 * a marker-free schema is "legacy"; ANY authority footprint is "canonical", where
 * only the canonical issuer/admission may act and every partial, quarantined or
 * drifted state denies there. Unreadable catalogue throws (never means absence). */
export async function readStaffEntryMode(source,schema="public"){
 const row=await readFootprint(source,staffIdentitySchemaName(schema));
 return row.markers==="0" ? "legacy" : "canonical";
}
