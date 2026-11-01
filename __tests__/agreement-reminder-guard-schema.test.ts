import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {expect,it} from "vitest";
import {AGREEMENT_REMINDER_GUARD_SQL} from "../lib/agreement-reminder-guard-schema";
it("adds exact 0087 bytes while preserving published 0078",()=>{
 expect(AGREEMENT_REMINDER_GUARD_SQL).toBe(readFileSync("migrations/0087_agreement_reminder_metadata.sql","utf8"));
 expect(createHash("sha256").update(readFileSync("migrations/0078_agreement_reconciliation.sql")).digest("hex")).toBe("e07a3b1540fe708d9d53c5bb2ba8ca1d733c991ddfe4315392a5b26c596ebf30");
 expect(AGREEMENT_REMINDER_GUARD_SQL).toContain("to_jsonb(NEW) - 'last_reminder_at'");
});
