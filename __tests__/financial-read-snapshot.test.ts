import {afterEach,describe,expect,it,vi} from "vitest";
import {withFinancialReadSnapshot} from "../lib/financial-read-snapshot";
afterEach(()=>vi.unstubAllEnvs());
describe("financial read snapshot lifecycle",()=>{
 it.each(["success","read","commit","rollback"] as const)("preserves the original outcome and disposes correctly after %s",async fault=>{
  vi.stubEnv("USE_LOCAL_DB","false");const failure=new Error("synthetic read failure"),query=vi.fn(async(sql:string)=>{
   if(fault==="commit"&&sql==="COMMIT")throw failure;
   if(fault==="rollback"&&sql==="ROLLBACK")throw new Error("synthetic cleanup failure");return {rows:[]};
  }),release=vi.fn(),client={query,release},pool={query,connect:vi.fn(async()=>client)};
  const operation=withFinancialReadSnapshot(pool,async runner=>{expect(runner).toBe(client);if(fault==="read"||fault==="rollback")throw failure;return 42;});
  if(fault==="success")await expect(operation).resolves.toBe(42);else await expect(operation).rejects.toBe(failure);
  expect(query.mock.calls[0][0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  expect(query.mock.calls.at(-1)?.[0]).toBe(fault==="success"?"COMMIT":"ROLLBACK");
  expect(release.mock.calls).toEqual(fault==="rollback"?[[true]]:[[false]]);
 });
 it("does not start a transaction on PGlite's shared connection",async()=>{
  vi.stubEnv("USE_LOCAL_DB","true");const pool={query:vi.fn(),connect:vi.fn()};
  await expect(withFinancialReadSnapshot(pool,async runner=>{expect(runner).toBe(pool);return 42;},true)).resolves.toBe(42);
  expect(pool.connect).not.toHaveBeenCalled();expect(pool.query).not.toHaveBeenCalled();
 });
});
