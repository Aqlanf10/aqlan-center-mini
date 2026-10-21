/** Mechanically extracted from the sealed synthetic-only offline proposal.
 * Original SHA256 befbf2eb7874b11fb3f3f46d60ccaf493d3095309f20e15d90d48785f900366a.
 * No replay, trigger operations or operational trust is provided here. */
import type { Client } from 'pg';
import { sequenceResets } from '../backup';
const qid=(s:string)=>`"${s.replaceAll('"','""')}"`;
export type OfflineRow={table:string;columns:string[];values:(string|boolean|null)[];identity:boolean};
export interface OfflineSequence {name:string;lastValue:string;isCalled:boolean;definition:{type:string;start:string;min:string;max:string;increment:string;cache:string;cycle:boolean;owner:string;acl:string|null}}
export async function captureOfflineSequences(client:Client):Promise<OfflineSequence[]>{
  const {rows}=await client.query<{name:string;definition:OfflineSequence['definition']}>(`SELECT c.relname AS name,
    pg_catalog.jsonb_build_object('type',pg_catalog.format_type(s.seqtypid,NULL),'start',s.seqstart::text,'min',s.seqmin::text,'max',s.seqmax::text,
      'increment',s.seqincrement::text,'cache',s.seqcache::text,'cycle',s.seqcycle,'owner',r.rolname,'acl',c.relacl::text) AS definition
    FROM pg_catalog.pg_sequence s JOIN pg_catalog.pg_class c ON c.oid=s.seqrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_roles r ON r.oid=c.relowner
    WHERE n.nspname='public' ORDER BY c.relname`);
  const result:OfflineSequence[]=[];
  for(const row of rows){const {rows:[state]}=await client.query<{last_value:string;is_called:boolean}>(`SELECT last_value::text,is_called FROM public.${qid(row.name)}`);
    result.push({...row,lastValue:state.last_value,isCalled:state.is_called});}
  return result;
}
export function decodeU0Archive(sql:string) {
  const statements:string[]=[];let start=0,quoted=false,lineComment=false,clean='';
  for(let i=0;i<sql.length;i++){
    const c=sql[i],next=sql[i+1];
    if(lineComment){if(c==='\n')lineComment=false;continue;}
    if(!quoted&&c==='-'&&next==='-'){lineComment=true;i++;continue;}
    if(c==="'"){clean+=c;if(quoted&&next==="'"){clean+=next;i++;continue;}quoted=!quoted;continue;}
    clean+=c;
    if(c===';'&&!quoted){statements.push(clean.slice(start).trim());start=clean.length;}
  }
  if(quoted||clean.slice(start).trim()||statements.shift()!=='BEGIN;'||statements.pop()!=='COMMIT;')throw new Error('Unsupported archive frame');
  const rows:OfflineRow[]=[],sequences:string[]=[];
  for(const statement of statements){
    const reset=/^SELECT setval\(pg_get_serial_sequence\('([a-z_][a-z0-9_]*)', 'id'\)/.exec(statement);
    if(reset){if(statement!==sequenceResets([reset[1]])[0])throw new Error('Unsupported archive sequence');sequences.push(reset[1]);continue;}
    const match=/^INSERT INTO ([a-z_][a-z0-9_]*) \(((?:"[a-z_][a-z0-9_]*"(?:, )?)+)\) (OVERRIDING SYSTEM VALUE )?VALUES \(([\s\S]*)\);$/.exec(statement);
    if(!match)throw new Error('Unsupported archive statement');
    const columns=match[2].split(', ').map(v=>v.slice(1,-1));
    const values:OfflineRow['values']=[];let remaining=match[4];
    while(remaining.length){
      const token=/^(?:'((?:[^']|'')*)'|(NULL|TRUE|FALSE)|(-?(?:\d+(?:\.\d+)?)(?:[eE][+-]?\d+)?))(?:, |$)/.exec(remaining);
      if(!token)throw new Error('Unsupported archive literal');
      values.push(token[1]!==undefined?token[1].replaceAll("''", "'"):token[2]==='NULL'?null:token[2]==='TRUE'?true:token[2]==='FALSE'?false:token[3]);
      remaining=remaining.slice(token[0].length);
    }
    if(values.length!==columns.length||new Set(columns).size!==columns.length)throw new Error('Archive column mismatch');
    if(match[1]!=='schema_migrations')rows.push({table:match[1],columns,values,identity:!!match[3]});
  }
  return {rows,sequences};
}
export async function offlineSchemaManifest(client:Client):Promise<string>{
  const {rows}=await client.query(`SELECT 'trigger' AS kind,c.relname||'.'||t.tgname AS name,
    pg_catalog.pg_get_triggerdef(t.oid) AS definition,t.tgenabled::text AS enabled,r.rolname AS owner,NULL::text AS acl
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_roles r ON r.oid=c.relowner
    WHERE n.nspname='public' AND NOT t.tgisinternal
    UNION ALL SELECT 'function',p.proname||'('||pg_catalog.pg_get_function_identity_arguments(p.oid)||')',pg_catalog.pg_get_functiondef(p.oid),p.prosecdef::text,r.rolname,p.proacl::text
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace JOIN pg_catalog.pg_roles r ON r.oid=p.proowner WHERE n.nspname='public' AND p.prokind='f'
    UNION ALL SELECT 'constraint',c.relname||'.'||k.conname,pg_catalog.pg_get_constraintdef(k.oid),k.convalidated::text,r.rolname,NULL
    FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid=k.conrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_roles r ON r.oid=c.relowner WHERE n.nspname='public'
    ORDER BY kind,name`);
  return JSON.stringify(rows);
}
