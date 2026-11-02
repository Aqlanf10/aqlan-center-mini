import {describe,it,expect} from "vitest";
import {apiRouteVerdict} from "../lib/http-permissions";
describe("orthodontic link observation proxy admission",()=>{
 it("registers only GET/HEAD for clinical roles",()=>{
  for(const method of ["GET","HEAD"]) expect(apiRouteVerdict("/api/ortho/41/plan-link",method)).toEqual({kind:"registered",pattern:"/api/ortho/[id]/plan-link",access:["admin","reception","doctor"]});
  for(const method of ["POST","PATCH","DELETE"]) expect(apiRouteVerdict("/api/ortho/41/plan-link",method).kind).toBe("method-not-allowed");
 });
});
