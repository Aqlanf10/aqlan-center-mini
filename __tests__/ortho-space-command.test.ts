import {expect,it} from 'vitest';
import {readSpacePersistenceCommand} from '../lib/ortho-space-command';
const ipr={schemaVersion:2,clientRequestId:'synthetic_request_1',expectedHeadId:1,reason:'Synthetic actual care',content:{kind:'ipr',arch:'upper',planEntryId:1,teeth:[11,12],adjustmentId:1,performedUm:null,measurementNote:'Synthetic unknown',supersedesEntryId:null,reviewReason:'Synthetic review'},expectedSession:{visitId:1,occurredOn:'2026-10-01',recordedBy:'Synthetic doctor'}};
it('requires an explicit canonical witness for new performed care',()=>{
 expect(readSpacePersistenceCommand(ipr)).toEqual({ok:true,value:ipr});
 const {expectedSession,...rest}=ipr;expect(expectedSession.visitId).toBe(1);
 expect(readSpacePersistenceCommand({...rest,schemaVersion:1})).toMatchObject({ok:false,code:'ipr_session_witness_required'});
 expect(readSpacePersistenceCommand(rest)).toMatchObject({ok:false});
});
it('rejects missing, impossible-date, foreign-shape or extra witness fields',()=>{
 for(const expectedSession of [null,{}, {...ipr.expectedSession,visitId:0},{...ipr.expectedSession,occurredOn:'2026-02-31'},{...ipr.expectedSession,recordedBy:''},{...ipr.expectedSession,unreviewed:true}])expect(readSpacePersistenceCommand({...ipr,expectedSession})).toMatchObject({ok:false});
});
it('detaches witness and authored teeth from caller mutation',()=>{
 const input=structuredClone(ipr),r=readSpacePersistenceCommand(input);if(!r.ok||r.value.schemaVersion!==2)throw Error('fixture');input.expectedSession.recordedBy='changed';input.content.teeth[0]=13;expect(r.value.expectedSession.recordedBy).toBe('Synthetic doctor');expect(r.value.content.teeth).toEqual([11,12]);
});
