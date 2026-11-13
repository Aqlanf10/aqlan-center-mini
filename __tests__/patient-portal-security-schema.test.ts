/**
 * الهجرة 0127 (تأمين بوابة المريض): تحقّق التطابق الحرفي بايت ببايت بين الملف المرقّم
 * وثابت التشغيل `PATIENT_PORTAL_SECURITY_SQL`، وتسجيلها في `ensureSchema()`، وإضافيتها الصرفة،
 * وإدراج جداولها في قوائم تصفير العيادة (`clinic-reset`).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PATIENT_PORTAL_SECURITY_SQL } from "../lib/patient-portal-security-schema";
import { RESET_KEEP_TABLES, RESET_WIPE_TABLES } from "../lib/clinic-reset";

describe("patient portal security schema (0127)", () => {
  it("the numbered migration 0127_patient_portal_security.sql is byte-for-byte identical to the runtime SQL", () => {
    expect(readFileSync(new URL("../migrations/0127_patient_portal_security.sql", import.meta.url), "utf8")).toBe(
      PATIENT_PORTAL_SECURITY_SQL,
    );
  });

  it("is registered at runtime under 0127 with the checksum of the same text", () => {
    const source = readFileSync(new URL("../lib/db.ts", import.meta.url), "utf8");
    expect(source).toContain(
      '{ version: "0127", name: "patient_portal_security", filename: "0127_patient_portal_security.sql", sql: PATIENT_PORTAL_SECURITY_SQL, checksum: checksumOf(PATIENT_PORTAL_SECURITY_SQL) }',
    );
  });

  it("is strictly additive: creates only its 3 portal security tables and indexes without altering existing tables", () => {
    const sql = PATIENT_PORTAL_SECURITY_SQL;
    expect(sql).not.toMatch(
      /\bALTER\s+TABLE\b|\bDROP\s+(TABLE|COLUMN|INDEX|FUNCTION)\b|\bDELETE\s+FROM\b|\bUPDATE\s+\w+\s+SET\b|\bTRUNCATE\b/i,
    );
    expect([...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((match) => match[1])).toEqual([
      "patient_portal_accounts",
      "patient_portal_tokens",
      "patient_portal_staff_grants",
    ]);
  });

  it("wipes patient portal accounts & tokens before patients on clinic reset while keeping staff portal grants", () => {
    const wipe: readonly string[] = RESET_WIPE_TABLES;
    const keep: readonly string[] = RESET_KEEP_TABLES;
    expect(wipe).toContain("patient_portal_tokens");
    expect(wipe).toContain("patient_portal_accounts");
    expect(wipe.indexOf("patient_portal_tokens")).toBeLessThan(wipe.indexOf("patients"));
    expect(wipe.indexOf("patient_portal_accounts")).toBeLessThan(wipe.indexOf("patients"));
    expect(keep).toContain("patient_portal_staff_grants");
    expect(wipe).not.toContain("patient_portal_staff_grants");
  });
});
