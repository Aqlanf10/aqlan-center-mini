import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/** (P2-8) تاريخ الميلاد ووليّ الأمر ورقم الهوية — حفظٌ وتعديلٌ ومسحٌ على PostgreSQL 18. */

assertRealPostgresUrl();
stubPostgresEnv();

const { ensureSchema, resetPoolForTesting, createPatient, updatePatient, getPatient } = await import("../../lib/db");

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
});

afterAll(async () => {
  await resetPoolForTesting();
});

describe("patient demographics", () => {
  it("creates, updates and clears the new fields without touching the others", async () => {
    const created = await createPatient({
      fullName: "سارة علي", phone: "777000111", altPhone: null, gender: "female", birthYear: 2014,
      address: null, medicalAlert: null, note: null,
      birthDate: "2014-03-02", guardianName: "علي محمد", guardianPhone: "777123456", nationalId: "A123",
    });
    expect(created).toMatchObject({ birthDate: "2014-03-02", guardianName: "علي محمد", nationalId: "A123" });
    expect(created.guardianPhone).toContain("777123456");

    const updated = await updatePatient(created.id, { guardianName: "أم سارة", nationalId: null });
    expect(updated).toMatchObject({ guardianName: "أم سارة", nationalId: null, birthDate: "2014-03-02", phone: created.phone });

    const again = await getPatient(created.id);
    expect(again).toMatchObject({ guardianName: "أم سارة", birthDate: "2014-03-02" });
  });

  it("an old-style patient without the new fields still works", async () => {
    const created = await createPatient({
      fullName: "مريض قديم", phone: null, altPhone: null, gender: "unknown", birthYear: null,
      address: null, medicalAlert: null, note: null,
    });
    expect(created).toMatchObject({ birthDate: null, guardianName: null, guardianPhone: null, nationalId: null });
  });
});
