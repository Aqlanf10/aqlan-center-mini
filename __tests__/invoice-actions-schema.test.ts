import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { INVOICE_ARCHIVE_SQL } from "../lib/invoice-archive-schema";
import { INVOICE_SERVICE_ADDITIONS_SQL } from "../lib/invoice-service-additions-schema";
import { INVOICE_ACTION_HISTORY_TABLES, RESET_KEEP_TABLES, RESET_WIPE_TABLES } from "../lib/clinic-reset";
import { loadMigrationFiles } from "../lib/migration-files";
it("registers exact numbered invoice action bytes, preserving reserved gaps", async () => {
 const files = await loadMigrationFiles();
 expect(createHash("sha256").update(INVOICE_ARCHIVE_SQL).digest("hex")).toBe("e03d14bb7500c98c806116e251a3b3bbd29db06da53717a074cce93290a430aa");
 expect(createHash("sha256").update(INVOICE_SERVICE_ADDITIONS_SQL).digest("hex")).toBe("df2e093757385a3260012d03271f7abb0d5e6e682644bddce5409ec12dcee214");
 for (const [version, name, sql] of [["0081", "invoice_archive", INVOICE_ARCHIVE_SQL], ["0082", "invoice_service_additions", INVOICE_SERVICE_ADDITIONS_SQL]]) {
  const file=files.find(file=>file.version===version)!;
  expect(file).toMatchObject({name,filename:`${version}_${name}.sql`,checksum:createHash("sha256").update(sql).digest("hex")});
  expect(file.sql).toBe(sql);
  expect(readFileSync("lib/db.ts","utf8")).toContain(`version: "${version}", name: "${name}"`);
  expect(sql).toContain("transaction_isolation");
  expect(sql).not.toContain("DISABLE TRIGGER");
 }
 expect(files.find(file=>file.version === "0079")?.filename).toBe("0079_ortho_followup_coverage.sql");
});
it("classifies all durable command successes and refusals as protected history",()=>{
 expect(INVOICE_ACTION_HISTORY_TABLES).toEqual(["invoice_archive_events","invoice_archive_rejections","invoice_service_additions","invoice_service_addition_rejections"]);
 for(const table of INVOICE_ACTION_HISTORY_TABLES){expect(RESET_KEEP_TABLES).toContain(table);expect(RESET_WIPE_TABLES).not.toContain(table);}
 expect(readFileSync("app/api/settings/reset/route.ts","utf8")).toContain('code: "protected-invoice-action-history"');
});
