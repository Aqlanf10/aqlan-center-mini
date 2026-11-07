/** Persistence v2 pins an actual session witness. The v1 pure foundation remains
 * decodable for history; it cannot authorize a new performed-care write. */
import {readSpaceCommand,type SpaceCommand,type IprPerformance} from './ortho-space-ledger';
import {journeyId,type Checked} from './ortho-case-journey-records';
export interface SpaceSessionWitness {visitId:number;occurredOn:string;recordedBy:string}
export type WitnessedIprCommand=Omit<SpaceCommand,'schemaVersion'|'content'>&{schemaVersion:2;content:IprPerformance;expectedSession:SpaceSessionWitness};
export type SpacePersistenceCommand=SpaceCommand|WitnessedIprCommand;
export function readSpacePersistenceCommand(raw:unknown):Checked<SpacePersistenceCommand>{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return {ok:false,code:'space_command'};
 const r=raw as Record<string,unknown>;
 if(r.schemaVersion===1){const parsed=readSpaceCommand(raw);if(!parsed.ok)return parsed;return parsed.value.content.kind==='plan'?parsed:{ok:false,code:'ipr_session_witness_required'};}
 if(r.schemaVersion!==2||Object.getOwnPropertySymbols(r).length||Object.keys(r).sort().join('|')!=='clientRequestId|content|expectedHeadId|expectedSession|reason|schemaVersion')return {ok:false,code:'space_command'};
 const {expectedSession,...base}=r, parsed=readSpaceCommand({...base,schemaVersion:1});
 if(!parsed.ok)return parsed;if(parsed.value.content.kind!=='ipr')return {ok:false,code:'space_command'};
 if(!expectedSession||typeof expectedSession!=='object'||Array.isArray(expectedSession))return {ok:false,code:'ipr_session_witness'};
 const w=expectedSession as Record<string,unknown>;
 if(Object.getOwnPropertySymbols(w).length||Object.keys(w).sort().join('|')!=='occurredOn|recordedBy|visitId'||!journeyId(w.visitId)
 ||typeof w.occurredOn!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(w.occurredOn)||!Number.isFinite(Date.parse(w.occurredOn))||new Date(w.occurredOn).toISOString().slice(0,10)!==w.occurredOn
 ||typeof w.recordedBy!=='string'||!w.recordedBy.trim()||w.recordedBy.length>200)return {ok:false,code:'ipr_session_witness'};
 return {ok:true,value:{...parsed.value,schemaVersion:2,content:parsed.value.content,expectedSession:{visitId:w.visitId,occurredOn:w.occurredOn,recordedBy:w.recordedBy}}};
}
