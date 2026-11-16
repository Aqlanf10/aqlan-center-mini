import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LAB_WORK_INTENT_SQL } from "../lib/lab-work-intent-schema";

describe("lab-only 0074 original-source boundary", () => {
  it("pairs exact reviewed SQL bytes without importing deferred clinical authority", () => {
    expect(readFileSync("migrations/0074_lab_work_intents.sql", "utf8")).toBe(LAB_WORK_INTENT_SQL);
    expect(createHash("sha256").update(LAB_WORK_INTENT_SQL).digest("hex")).toBe("d4e3839ca32d053827a67f0b60b3efaddc69850f4c1d062577c541031b93195c");
    expect(LAB_WORK_INTENT_SQL).not.toMatch(/agreement_clinical_|clinical_authorization_event_id/);
    expect(LAB_WORK_INTENT_SQL).not.toMatch(/CREATE (?:OR REPLACE )?FUNCTION aqlan_(?:inventory|agreement|collection)/);
  });
  it("keeps original geometry, canonical plan alias and exact corrected invoice provenance mandatory", () => {
    expect(LAB_WORK_INTENT_SQL).toContain("IF (pi.service_id,pi.tooth_code,pi.quantity,pi.category) IS DISTINCT FROM");
    expect(LAB_WORK_INTENT_SQL).toContain("(m.service_id,m.tooth_code,m.quantity,m.source_category)");
    expect(LAB_WORK_INTENT_SQL).toContain("lab immutable plan geometry mismatch");
    expect(LAB_WORK_INTENT_SQL).toContain("lab source requires its canonical exact plan alias");
    expect(LAB_WORK_INTENT_SQL).toContain("lab invoice correction changes source identity");
    expect(LAB_WORK_INTENT_SQL).toContain("lab invoice lacks exact typed source identity");
    expect(LAB_WORK_INTENT_SQL).toContain("lab visit alias requires exact signed member geometry and authority");
  });
  it("retains deferred historical graph checks and fresh-snapshot history protection", () => {
    expect(LAB_WORK_INTENT_SQL).toContain("lab historical graph requires READ COMMITTED identity admission");
    expect(LAB_WORK_INTENT_SQL).toContain("lab order reciprocal identity is invalid");
    expect(LAB_WORK_INTENT_SQL).toContain("CREATE TRIGGER lab_intent_insert_lock BEFORE INSERT ON lab_work_intents");
    expect(LAB_WORK_INTENT_SQL.match(/pg_try_advisory_xact_lock\(hashtext\('lab-intent'\)/g)).toHaveLength(3);
    expect(LAB_WORK_INTENT_SQL).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(LAB_WORK_INTENT_SQL).toContain("current_setting('transaction_isolation') <> 'read committed'");
    expect(LAB_WORK_INTENT_SQL).toContain("$$ LANGUAGE plpgsql VOLATILE;");
    for (const table of ["lab_work_intents", "lab_work_members", "lab_prescription_source_memberships", "lab_work_commands"]) {
      expect(LAB_WORK_INTENT_SQL).toContain(`BEFORE TRUNCATE ON ${table}`);
    }
    expect(LAB_WORK_INTENT_SQL).not.toMatch(/DISABLE TRIGGER|SET session_replication_role/);
  });
});
