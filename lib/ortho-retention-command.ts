import { assertRetentionData } from "./ortho-retention-data";
import { checkRetentionEventCommand, type RetentionEventCommand } from './ortho-retention-events';
import { readRetentionDocumentWitnesses, type RetentionDocumentWitness } from './ortho-retention-document-witness';
import type { Checked } from './ortho-case-journey-records';
export type RetentionPersistenceCommand=Omit<RetentionEventCommand,'schemaVersion'>&{schemaVersion:2;expectedDocuments:RetentionDocumentWitness[]};
export function readRetentionPersistenceCommand(raw:unknown):Checked<RetentionPersistenceCommand>{
 try { assertRetentionData(raw, 10000); } catch { return {ok:false,code:"invalid_retention_data"}; }
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.getPrototypeOf(raw)!==Object.prototype||Object.getOwnPropertySymbols(raw).length)return {ok:false,code:'retention_command'};
 const r=raw as Record<string,unknown>;
 if(r.schemaVersion!==2||Object.keys(r).sort().join('|')!=='arch|archCorrectionReason|clientRequestId|content|expectedDocuments|expectedHeadId|reason|schemaVersion|supersedesEntryId')return {ok:false,code:'retention_document_witness_required'};
 const {expectedDocuments,...base}=r,parsed=checkRetentionEventCommand({...base,schemaVersion:1});if(!parsed.ok)return parsed;
 const documents=readRetentionDocumentWitnesses(expectedDocuments,parsed.value.content.documentIds);if(!documents.ok)return documents;
 return {ok:true,value:{...parsed.value,schemaVersion:2,expectedDocuments:documents.value}};
}
