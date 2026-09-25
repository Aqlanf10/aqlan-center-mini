import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/** (P3-8ب) مصدر المريض على PostgreSQL 18: الإنشاء والتعديل والدمج. */

assertRealPostgresUrl();
stubPostgresEnv();

const { ensureSchema, resetPoolForTesting, createPatient, updatePatient, mergeDuplicatePatient } = await import("../../lib/db");

const base = {
  phone: null, altPhone: null, gender: "female" as const, birthYear: null, address: null, medicalAlert: null, note: null,
};

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
});

afterAll(async () => {
  await resetPoolForTesting();
});

describe("patients.referral_source / referred_by", () => {
  it("يُحفظ عند الإنشاء، ويُعدَّل ويُمسح صراحةً", async () => {
    const created = await createPatient({ ...base, fullName: "منى علي", referralSource: "طبيب أحاله", referredBy: "د. سامي" });
    expect(created).toMatchObject({ referralSource: "طبيب أحاله", referredBy: "د. سامي" });
    const untouched = await updatePatient(created.id, { note: "ملاحظة" });
    expect(untouched).toMatchObject({ referralSource: "طبيب أحاله" });
    const cleared = await updatePatient(created.id, { referralSource: null, referredBy: null });
    expect(cleared).toMatchObject({ referralSource: null, referredBy: null });
  });

  it("الدمج: الأصل أولى، والمكرر يملأ الفراغ فقط", async () => {
    const target = await createPatient({ ...base, fullName: "هدى سالم" });
    const source = await createPatient({ ...base, fullName: "هدى سالم", referralSource: "وسائل التواصل الاجتماعي" });
    const merged = await mergeDuplicatePatient(source.id, target.id, { actor: "admin" });
    expect(merged.ok && merged.target).toMatchObject({ referralSource: "وسائل التواصل الاجتماعي" });

    const keep = await createPatient({ ...base, fullName: "ريم", referralSource: "توصية مريض" });
    const dup = await createPatient({ ...base, fullName: "ريم", referralSource: "لافتة أو مرور" });
    const second = await mergeDuplicatePatient(dup.id, keep.id, { actor: "admin" });
    expect(second.ok && second.target).toMatchObject({ referralSource: "توصية مريض" });
  });
});
