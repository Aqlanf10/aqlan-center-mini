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

  it("keeps clinician text and matching birth-date changes on a separate administrative partial update", async () => {
    const created = await createPatient({
      fullName: "Synthetic concurrent demographics", phone: null, altPhone: null, gender: "unknown",
      birthYear: 2001, birthDate: "2001-01-10", address: "Old synthetic address",
      medicalAlert: "Old synthetic clinical alert", note: "Old synthetic clinical note", referralSource: "Synthetic referral",
    });
    const before = await getPatient(created.id);
    expect(before).toMatchObject({ birthYear: 2001, birthDate: "2001-01-10" });
    await updatePatient(created.id, {
      medicalAlert: "New synthetic clinical alert", note: "New synthetic clinical note", birthYear: 2002, birthDate: "2002-02-12",
    });
    const after = await updatePatient(created.id, { address: "New synthetic address", birthYear: 2002 }, { reconcileYearOnlyBirthDate: true });
    expect(after).toMatchObject({ address: "New synthetic address", referralSource: "Synthetic referral",
      medicalAlert: "New synthetic clinical alert", note: "New synthetic clinical note", birthYear: 2002, birthDate: "2002-02-12" });
    await updatePatient(created.id, { birthYear: 2003 }, { reconcileYearOnlyBirthDate: true });
    expect(await getPatient(created.id)).toMatchObject({ birthYear: 2003, birthDate: null });
  });

  it("an old-style patient without the new fields still works", async () => {
    const created = await createPatient({
      fullName: "مريض قديم", phone: null, altPhone: null, gender: "unknown", birthYear: null,
      address: null, medicalAlert: null, note: null,
    });
    expect(created).toMatchObject({ birthDate: null, guardianName: null, guardianPhone: null, nationalId: null });
  });
});


it("selects desk demographics without clinical fields and scopes assistant reads to the clinic day", async () => {
  const { readOperationalPatient, readOperationalWorkflow } = await import("../../lib/patient-operational-read");
  const { CLINIC_TIME_ZONE } = await import("../../lib/db");
  const { clinicDateString } = await import("../../lib/schedule");
  const patient = await createPatient({ fullName: "Synthetic operational patient", gender: "unknown", phone: null,
    altPhone: null, birthYear: null, address: null, medicalAlert: "SYNTHETIC PRIVATE ALERT", note: "SYNTHETIC CLINICAL NOTE" });
  const desk = await readOperationalPatient(patient.id, "reception");
  expect(desk).toMatchObject({ id: patient.id, patientNumber: patient.patientNumber, fullName: patient.fullName });
  expect(desk?.flags).toEqual([]);
  for (const key of ["medicalAlert", "note", "nationalId", "photoDocumentId"]) expect(desk).not.toHaveProperty(key);
  expect(await readOperationalPatient(patient.id, "assistant")).toBeNull();
  const workflow = await readOperationalWorkflow(patient.id, "reception", clinicDateString(new Date(), CLINIC_TIME_ZONE));
  expect(workflow?.patient.id).toBe(patient.id);
  expect(JSON.stringify(workflow)).not.toContain("SYNTHETIC PRIVATE ALERT");
});
