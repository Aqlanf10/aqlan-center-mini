import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (P3-8) الإحالات الصادرة على PostgreSQL 18 الحقيقي.
 *
 * الخطاب يُحفظ ويبقى مفتوحًا حتى يُغلق مرة واحدة بنتيجته أو بإلغاءٍ مسبَّب،
 * ولا يختفي بحذف الملف، ويتبع المريض إذا دُمج ملفّه المكرر.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const {
  ensureSchema, getPool, resetPoolForTesting, createReferral, closeReferral, listPatientReferrals,
  deletePatientCascade, mergeDuplicatePatient,
} = await import("../../lib/db");

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

async function patient(number: string): Promise<number> {
  const [row] = await q<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, 'مريض إحالة') RETURNING id`, [number],
  );
  return row.id;
}

function draft(patientId: number) {
  return {
    patientId, toName: "د. سامي", toSpecialty: "oral_surgery" as const, reason: "قلع الضواحك الأولى",
    teeth: "14, 24, 34, 44", urgency: "routine" as const, doctorPartyId: null, actor: "doc",
  };
}

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
});

afterAll(async () => {
  await resetPoolForTesting();
});

describe("P3-8 — الإحالات الصادرة", () => {
  it("تُحفظ مفتوحة، وتُغلق مرة واحدة بنتيجتها، ويُسجَّل الإصدار والإغلاق في التدقيق", async () => {
    const id = await patient("RF-1");
    const referral = await createReferral(draft(id));
    expect(referral).toMatchObject({ status: "sent", teeth: "14, 24, 34, 44", closedAt: null });

    const done = await closeReferral({ id: referral!.id, status: "completed", note: "قُلعت الأربعة", actor: "rec" });
    expect(done.ok && done.referral).toMatchObject({ status: "completed", outcomeNote: "قُلعت الأربعة", closedBy: "rec" });

    const again = await closeReferral({ id: referral!.id, status: "cancelled", note: "خطأ", actor: "rec" });
    expect(again).toEqual({ ok: false, reason: "already_closed" });

    const audits = await q<{ action: string }>(
      `SELECT action FROM audit_log WHERE entity = 'patient' AND entity_id = $1 ORDER BY id`, [String(id)],
    );
    expect(audits.map((row) => row.action)).toEqual(["referral.create", "referral.complete"]);
  });

  it("إحالة لمريضٍ غير موجود لا تُحفظ، وإغلاق رقمٍ غير موجود not_found", async () => {
    expect(await createReferral(draft(999_999))).toBeNull();
    expect(await closeReferral({ id: 999_999, status: "completed", note: null, actor: "x" }))
      .toEqual({ ok: false, reason: "not_found" });
  });

  it("القاعدة نفسها ترفض إلغاءً بلا سبب وإغلاقًا بلا ختم", async () => {
    const id = await patient("RF-2");
    const referral = await createReferral(draft(id));
    await expect(q(`UPDATE patient_referrals SET status = 'cancelled', closed_at = NOW() WHERE id = $1`, [referral!.id]))
      .rejects.toThrow();
    await expect(q(`UPDATE patient_referrals SET status = 'completed' WHERE id = $1`, [referral!.id]))
      .rejects.toThrow();
  });

  it("ملفٌّ فيه إحالة سجلٌّ طبي لا يُحذف", async () => {
    const id = await patient("RF-3");
    await createReferral(draft(id));
    const result = await deletePatientCascade(id, { actor: "admin", actorRole: "admin", reason: "خطأ" });
    expect(result).toMatchObject({ ok: false, reason: "has_clinical_history", counts: { referrals: 1 } });
  });

  it("دمج الملف المكرر ينقل إحالاته إلى الملف الأصلي", async () => {
    const target = await patient("RF-4");
    const source = await patient("RF-5");
    await createReferral(draft(source));
    const merged = await mergeDuplicatePatient(source, target, { actor: "admin" });
    expect(merged.ok).toBe(true);
    expect(await listPatientReferrals(target)).toHaveLength(1);
  });

  it("مراجعة: اسم الطبيب في الخطاب لقطةٌ وقت الإصدار — تغيير اسم الجهة لاحقًا لا يغيّر خطابًا قديمًا", async () => {
    const id = await patient("RF-6");
    const [doctor] = await q<{ id: number }>(`INSERT INTO parties (name, kind) VALUES ('د. أحمد الأول', 'doctor') RETURNING id`);
    const referral = await createReferral({ ...draft(id), doctorPartyId: doctor.id });
    expect(referral?.doctorName).toBe("د. أحمد الأول");
    await q(`UPDATE parties SET name = 'د. أحمد (اسم جديد)' WHERE id = $1`, [doctor.id]);
    const [reloaded] = (await listPatientReferrals(id));
    expect(reloaded?.doctorName).toBe("د. أحمد الأول");
  });
});

