import {expect,it} from "vitest";
import {isCanonicalCephList,type CanonicalCephList} from "../lib/canonical-ceph-projection";
const saved=():CanonicalCephList=>({projection:"ceph-summary",patientId:3,hasMore:false,analyses:[{id:4,patientId:3,status:"completed",phase:"pretreatment",xrayDate:"2024-02-29",createdAt:"2024-03-01T12:00:00Z",completedAt:"2024-03-01T12:00:00Z",imageState:"available",findings:{anb:3.125,fma:26.75,wits:-1.125}}]});
it("accepts exact saved precision and an honest empty/bounded feed without running a clinical engine",()=>{
 const feed=saved();expect(isCanonicalCephList(feed,3)).toBe(true);expect(feed.analyses[0].findings?.anb).toBe(3.125);
 expect(isCanonicalCephList({...feed,analyses:[]},3)).toBe(true);expect(isCanonicalCephList({...feed,hasMore:true},3)).toBe(true);
});
it.each([null,{},"wrong",{...saved(),patientId:7},{...saved(),projection:"legacy"},{...saved(),hasMore:undefined}])("rejects a wrong envelope without turning it into an empty list: %j",value=>expect(isCanonicalCephList(value,3)).toBe(false));
it.each([{patientId:7},{status:"discarded"},{id:0},{phase:"__proto__"},{xrayDate:42},{createdAt:"invalid"},{completedAt:42},{imageState:"public"},{findings:{anb:NaN,fma:2,wits:3}},{status:"draft",findings:{anb:1,fma:2,wits:3}}])("rejects invalid or foreign saved-row fields: %j",patch=>{
 const feed=saved();Object.assign(feed.analyses[0],patch);expect(isCanonicalCephList(feed,3)).toBe(false);
});
it("rejects an oversized response rather than silently discarding results in the browser",()=>{
 const feed=saved();feed.analyses=Array.from({length:301},(_,i)=>({...feed.analyses[0],id:i+1}));expect(isCanonicalCephList(feed,3)).toBe(false);
});

import {isCanonicalCephStudy,type CanonicalCephStudy} from "../lib/canonical-ceph-projection";
const study=():CanonicalCephStudy=>({projection:"ceph-saved-study",analysis:{...saved().analyses[0],device:null,refSet:"SYN old",note:null,createdBy:"SYN",completedBy:"SYN",calibration:null,mmPerPixel:null},measurementsState:"saved-approved",landmarks:[{code:"SYN_OLD",x:1.25,y:2.5,source:"manual",confirmedBy:"SYN"}],measurements:[{code:"SYN_OLD",value:123.123456}],diagnosis:{skeletal:null,dental:null,softTissue:null,note:null,finalDx:"SYN saved",createdBy:"SYN",updatedAt:"2024-03-01T12:00:00Z"}});
it("accepts saved unknown historical codes without interpreting or rounding them",()=>{const v=study();expect(isCanonicalCephStudy(v,3,4)).toBe(true);expect(v.measurements[0].value).toBe(123.123456);});
it.each([null,{}, {...study(),projection:"legacy"},{...study(),measurementsState:"saved-unapproved"},{...study(),analysis:{...study().analysis,patientId:99}},{...study(),analysis:{...study().analysis,id:99}},{...study(),analysis:{...study().analysis,calibration:{x1:0,y1:0,x2:1,y2:1,mm:0}}},{...study(),landmarks:[{code:"S",x:NaN,y:1,source:"manual",confirmedBy:"SYN"}]},{...study(),measurements:[{code:"ANB",value:Infinity}]},{...study(),diagnosis:{...study().diagnosis,updatedAt:"invalid"}}])("rejects malformed/foreign study data instead of exposing stale values: %j",value=>expect(isCanonicalCephStudy(value,3,4)).toBe(false));
