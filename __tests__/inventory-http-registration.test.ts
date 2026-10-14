import { describe, expect, it } from "vitest";
import { apiRouteVerdict } from "../lib/http-permissions";
describe("delegated exact inventory route registration",()=>{
 it("literal procurement beats the dynamic inventory item route",()=>{
  expect(apiRouteVerdict("/api/inventory/procurement","POST")).toMatchObject({kind:"registered",pattern:"/api/inventory/procurement",access:["admin","reception","doctor"]});
  expect(apiRouteVerdict("/api/inventory/procurement","GET")).toMatchObject({kind:"registered",pattern:"/api/inventory/procurement"});
  expect(apiRouteVerdict("/api/inventory/17","GET")).toMatchObject({kind:"registered",pattern:"/api/inventory/[id]"});
  expect(apiRouteVerdict("/api/inventory/17/movements","POST")).toMatchObject({kind:"registered",pattern:"/api/inventory/[id]/movements"});
 });
 it("unknown paths and undeclared verbs remain rejected",()=>{
  expect(apiRouteVerdict("/api/inventory/procurement/unregistered","POST")).toEqual({kind:"unknown-route"});
  expect(apiRouteVerdict("/api/inventory/procurement","DELETE")).toMatchObject({kind:"method-not-allowed"});
  expect(apiRouteVerdict("/api/inventory/17","POST")).toMatchObject({kind:"method-not-allowed"});
 });
});
