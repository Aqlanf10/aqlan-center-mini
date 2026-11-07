import {describe,it,expect} from 'vitest';
import {readRetentionPersistenceCommand} from '../lib/ortho-retention-command';
import {decodeRetentionSavedContent} from '../lib/ortho-retention-history-store';
import {journeyContentHash} from '../lib/ortho-case-journey-hash';
const payload={kind:'debond',extent:'documentary',occurrence:{occurredOn:null,dateProvenance:'unknown',sourceNote:''},note:'',documentIds:[7]};
const base={arch:'upper',supersedesEntryId:null,archCorrectionReason:null,payload};
const witness={id:7,patientId:1,orthoCaseId:2,sha256:'a'.repeat(64),metadataHash:'b'.repeat(64)};
describe('retention persisted witness compatibility',()=>{
 it('preserves exact legacy shape/hash, never invents a witness',()=>{const r=decodeRetentionSavedContent(base);expect(r).toEqual({ok:true,value:base});if(r.ok)expect(journeyContentHash(r.value)).toBe(journeyContentHash(base));});
 it('preserves full v2 witness shape/hash',()=>{const v2={...base,savedVersion:2,documentWitnesses:[witness]},r=decodeRetentionSavedContent(v2);expect(r).toEqual({ok:true,value:v2});if(r.ok)expect(journeyContentHash(r.value)).toBe(journeyContentHash(v2));});
 it('refuses absent, mismatched, extra and malformed witnesses',()=>{for(const documentWitnesses of [[],[{...witness,id:8}],[{...witness,sha256:'bad'}],[{...witness,url:'private'}]])expect(decodeRetentionSavedContent({...base,savedVersion:2,documentWitnesses}).ok).toBe(false);});
 it('requires a v2 exact command; canonical witness remains bound',()=>{
 const command={schemaVersion:2,clientRequestId:'synthetic_command_1',expectedHeadId:null,reason:'documentary',arch:base.arch,supersedesEntryId:null,archCorrectionReason:null,content:payload,expectedDocuments:[witness]};
 expect(readRetentionPersistenceCommand(command)).toEqual({ok:true,value:command});
 expect(readRetentionPersistenceCommand({...command,schemaVersion:1}).ok).toBe(false);
 expect(readRetentionPersistenceCommand({...command,expectedDocuments:[]}).ok).toBe(false);
 });
});
