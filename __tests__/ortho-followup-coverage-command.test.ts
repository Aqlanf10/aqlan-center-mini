import {describe,expect,it} from 'vitest';
import {parseFollowupCoverageCommand} from '../lib/ortho-followup-coverage';
const value=()=>({schemaVersion:1,commandId:'11111111-1111-4111-8111-111111111111',expectedRevisionId:null,source:{patientId:1,orthoCaseId:2,clinicalCaseId:3,planId:4,planItemId:5,invoiceId:6},expectedSourceFingerprint:'a'.repeat(64),scope:'routine_adjustments',decision:'included',reason:'Synthetic consented terms'});
describe('strict explicit followup command',()=>{
 it('accepts only the exact source, head and narrow scope contract',()=>{expect(parseFollowupCoverageCommand(value())).toEqual(value());});
 it.each([{scope:'all_services'},{decision:'waive_all'},{expectedRevisionId:1},{expectedSourceFingerprint:'bad'},{reason:'  '},{actorRole:'admin'},{expectedRevisionId:undefined}])('refuses fabricated or incomplete authority input %j',patch=>{expect(parseFollowupCoverageCommand({...value(),...patch})).toBeNull();});
 it('refuses malformed and foreign-shaped identities rather than ignoring unknown fields',()=>{expect(parseFollowupCoverageCommand({...value(),source:{...value().source,doctorId:5}})).toBeNull();expect(parseFollowupCoverageCommand({...value(),source:{...value().source,patientId:'1'}})).toBeNull();});
});
