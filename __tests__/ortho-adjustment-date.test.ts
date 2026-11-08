import {describe,it,expect} from "vitest";
import {isAdjustmentDate} from "../lib/ortho-adjustment-date";
import {adjustmentNewCommandError,createAdjustmentCommand,readAdjustmentCommand} from "../lib/ortho-adjustment-command";
describe("new explicit Gregorian adjustment date",()=>{
 it.each([null,undefined,""," ","not-a-date","0000-01-01","1900-02-29","2026-02-30","2026-04-31","10000-01-01","2026-1-01",true,20260101,{},[]])("refuses %j",value=>expect(isAdjustmentDate(value)).toBe(false));
 it.each(["0001-01-01","0099-12-31","2000-02-29","2024-02-29","9999-12-31"])("accepts %s",value=>expect(isAdjustmentDate(value)).toBe(true));
 it("refuses before storage and preserves frozen historical decoder semantics",()=>{
  const scope={patientId:1,caseId:2,authority:"synthetic"},rows=new Map<string,string>();
  const storage={getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value);},removeItem:(key:string)=>{rows.delete(key);}};
  const body={doneOn:"2026-02-30",upperWire:"",lowerWire:"",elastics:"none",elasticNote:"",done:"",nextWeeks:4};
  expect(adjustmentNewCommandError(body)).not.toBeNull();expect(()=>createAdjustmentCommand(storage,scope,body)).toThrow();expect(rows.size).toBe(0);
  const command=createAdjustmentCommand(storage,scope,{...body,doneOn:"2024-02-29"});
  const key=[...rows.keys()][0],raw=JSON.parse(rows.get(key)!); raw.body=JSON.stringify(body); rows.set(key,JSON.stringify(raw));
  const restored=readAdjustmentCommand(storage,scope);expect(restored?.body).toBe(JSON.stringify(body));expect(restored?.key).toBe(command.key);
 });
});
