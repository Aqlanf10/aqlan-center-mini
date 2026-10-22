import {expect,it} from "vitest";
import {readFileSync} from "node:fs";
import {AGREEMENT_DELTA_SQL} from "../lib/agreement-delta-schema";
import {checksumOf,loadMigrationFiles} from "../lib/migration-files";
it("owns a byte-identical numbered and runtime migration without modifying prior history",async()=>{
 const sql=readFileSync("migrations/0066_agreement_delta_amendments.sql","utf8");
 expect(sql).toBe(AGREEMENT_DELTA_SQL);
 const file=(await loadMigrationFiles()).find(f=>f.version==="0066");
 expect(file?.checksum).toBe(checksumOf(sql));
 expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON agreement_delta_amendments/);
 expect(sql).toMatch(/amended plan work already financed/);
});
