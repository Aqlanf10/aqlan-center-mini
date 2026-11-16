import {expect,it} from "vitest";
import {readNumberingPreview,readPatientNumberSnapshot} from "../lib/patient-numbering-read-model";
const preview={minimumNext:"7000",version:"1",sequenceValue:"1",sequenceCalled:false,maximumCurrent:"0",maximumRetired:"0",nextNumber:"P-07000",exhausted:false};
it("accepts only the exact patient and keeps legacy confirmation spelling",()=>{
 expect(readPatientNumberSnapshot({patientId:42,patientNumber:" legacy-42 ",version:"1"},42)).toEqual({patientId:42,patientNumber:" legacy-42 ",version:"1"});
 expect(readPatientNumberSnapshot({patientId:43,patientNumber:"P-07000",version:"1"},42)).toBeNull();
});
it.each([null,[],{}, {patientId:42,patientNumber:"",version:"1"},{patientId:42,patientNumber:"P-07000",version:"0"},{patientId:42,patientNumber:"P-07000",version:1}])("rejects malformed patient response %j",value=>expect(readPatientNumberSnapshot(value,42)).toBeNull());
it("accepts coherent preview and larger historical high-water",()=>{
 expect(readNumberingPreview(preview)).toEqual(preview);
 expect(readNumberingPreview({...preview,maximumRetired:"9000",nextNumber:"P-09001"})?.nextNumber).toBe("P-09001");
});
it.each([{minimumNext:"not-a-number"},{version:"0"},{sequenceValue:"1.5"},{sequenceCalled:"true"},{maximumCurrent:"-1"},{maximumRetired:"9".repeat(100)},{nextNumber:"P-07001"},{exhausted:true},{nextNumber:null},{maximumRetired:"9000"}])("rejects malformed or contradictory preview %j",patch=>expect(readNumberingPreview({...preview,...patch})).toBeNull());
it("accepts exhausted maximum sentinel without unsafe numeric conversion",()=>{
 expect(readNumberingPreview({...preview,maximumCurrent:"9223372036854775808",nextNumber:null,exhausted:true})?.exhausted).toBe(true);
});
