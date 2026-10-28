import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { AGREEMENT_RECONCILIATION_SQL } from "../lib/agreement-reconciliation-schema";
import { AGREEMENT_HISTORY_TABLES, RESET_KEEP_TABLES } from "../lib/clinic-reset";
it("registers exact independently reviewed0078 bytes in runtime and migration",()=>{
 const migration=readFileSync("migrations/0078_agreement_reconciliation.sql","utf8");
 expect(migration).toBe(readFileSync("docs/proposals/0078_agreement_reconciliation.sql","utf8"));
 expect(AGREEMENT_RECONCILIATION_SQL).toBe(migration);
 expect(createHash("sha256").update(migration).digest("hex")).toBe("e07a3b1540fe708d9d53c5bb2ba8ca1d733c991ddfe4315392a5b26c596ebf30");
 const source=readFileSync("lib/db.ts","utf8");
 expect(source).toContain('version: "0078"');
 for(const table of ["agreement_reconciliations","agreement_reconciliation_sources","agreement_reconciliation_rejections"]){expect(AGREEMENT_HISTORY_TABLES).toContain(table);expect(RESET_KEEP_TABLES).toContain(table);}
});
