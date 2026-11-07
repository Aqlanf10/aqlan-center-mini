import {describe,it,expect} from "vitest";
import {parseAdjustmentInterval} from "../lib/ortho-adjustment-interval";
import {adjustmentNewCommandError,createAdjustmentCommand,readAdjustmentCommand} from "../lib/ortho-adjustment-command";
describe("explicit authored interval",()=>{
 it.each([null,undefined,""," ","abc",0,"0",-1,1.5,"1.5",53,NaN,Infinity,true,false,[],[4],{}])("refuses %j without inventing four weeks",value=>{
  expect(parseAdjustmentInterval(value)).toBeNull();
 });
 it.each([1,4,52,"1","4","52"," 04 "])("accepts exact integer %j without rounding",value=>{
  expect(parseAdjustmentInterval(value)).toBe(Number(value));
 });
 it("does not freeze invalid new intervals and allows correction under a fresh command",()=>{
  const scope={patientId:1,caseId:2,authority:"synthetic"},rows=new Map<string,string>();
  const storage={getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value);},removeItem:(key:string)=>{rows.delete(key);}};
  const body={doneOn:"2026-10-02",upperWire:"",lowerWire:"",elastics:"none",elasticNote:"",done:"",nextWeeks:0};
  expect(adjustmentNewCommandError(body)).not.toBeNull();
  expect(()=>createAdjustmentCommand(storage,scope,body)).toThrow();expect(rows.size).toBe(0);
  expect(readAdjustmentCommand(storage,scope)).toBeNull();
  expect(JSON.parse(createAdjustmentCommand(storage,scope,{...body,nextWeeks:3}).body).nextWeeks).toBe(3);
 });
});
