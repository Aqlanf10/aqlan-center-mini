#!/usr/bin/env node
/**
 * منصّة الإعدادات — الرحلة التشغيلية.
 *
 * ما تُثبته وحدها ولا يُثبته اختبار وحدة، لأنه كلّه عن حال القاعدة:
 *
 *   ١) الكتابة تُغيّر القيمة المحسومة، وتُبقي ما لم يُمسّ.
 *   ٢) كل تغييرٍ يترك صفَّ تدقيقٍ بقيمته قبل وبعد وبسببه — والذي لم يتغيّر لا يترك شيئًا.
 *   ٣) السجلّ يُميّز إعدادات المركز عن `settings.update` المُثقَل بمسارات المختبرات.
 *   ٤) الكتابة الضائعة مردودة: من يكتب على طابعٍ قديم يُردّ ولا يُمحى عمل غيره،
 *      ولا يُكتب شيءٌ من دفعته كلّها.
 *   ٥) الإعادة إلى الافتراضي حدثٌ جديد لا محوٌ للتاريخ.
 *   ٦) التراجع كتابةٌ جديدة بقيمةٍ قديمة — والسجلّ يحتفظ بالثلاثة.
 *   ٧) المستهلك يقرأ الإعداد: تغيير مدى المتابعة يغيّر ما تُرجعه القائمتان.
 *
 *   node --import tsx scripts/verify-settings.mjs
 */
import "./use-pglite.mjs";

const db = await import("../lib/db.ts");
const { SETTING_DEFAULTS } = await import("../lib/settings.ts");

let failed = false;
const check = (label, ok, extra = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failed = true;
};
const pool = db.getPool();

async function main() {
  console.log("منصّة الإعدادات — التحقق التشغيلي");
  await db.ensureSchema();

  /* ═══ ١ — الكتابة والقيمة المحسومة ═══ */
  console.log("\n── ١: الكتابة تُغيّر المحسوم ولا تمسّ سواه ──");
  const chairsBefore = (await db.getSettings())["clinic.chairs"];
  const first = await db.saveSettingsAudited({
    values: { "ops.late_tolerance_minutes": "22" },
    actor: "المدير", actorRole: "admin", reason: "زحمة الصباح",
  });
  check("الكتابة نجحت", first.ok === true && first.changed.length === 1);
  const after = await db.getSettings();
  check("القيمة المحسومة تغيّرت", after["ops.late_tolerance_minutes"] === "22");
  check("وما لم يُمسّ بقي", after["clinic.chairs"] === chairsBefore);

  /* ═══ ٢ — التدقيق بالقيمة ═══ */
  console.log("\n── ٢: صفُّ تدقيقٍ بقيمته قبل وبعد ──");
  let history = await db.listSettingHistory({ key: "ops.late_tolerance_minutes" });
  check("سُجّل صفٌّ واحد", history.length === 1, `${history.length}`);
  check("بقيمته قبل وبعد", history[0]?.before === "15" && history[0]?.after === "22",
    `${history[0]?.before} ← ${history[0]?.after}`);
  check("وبسببه وفاعله", history[0]?.reason === "زحمة الصباح" && history[0]?.actor === "المدير");
  check("وبفعلٍ خاصٍّ بإعدادات المركز", history[0]?.action === "clinic_settings.update");

  const unchanged = await db.saveSettingsAudited({
    values: { "ops.late_tolerance_minutes": "22" }, actor: "المدير", actorRole: "admin",
  });
  check("والذي لم يتغيّر لا يترك صفًّا", unchanged.ok && unchanged.changed.length === 0
    && (await db.listSettingHistory({ key: "ops.late_tolerance_minutes" })).length === 1);

  /* ═══ ٣ — التمييز عن الأفعال الأخرى ═══ */
  console.log("\n── ٣: سجلّ الإعدادات لا يبتلع أفعال المختبرات ──");
  await db.recordAudit({
    action: "settings.update", entity: "laboratory", entityId: "7",
    details: { المفاتيح: ["اسم المختبر"] }, actor: "المدير", actorRole: "admin",
  });
  history = await db.listSettingHistory({});
  check("فعل المختبر خارج سجلّ الإعدادات",
    history.every((row) => row.action.startsWith("clinic_settings.")),
    history.map((r) => r.action).join("، "));
  const { rows: labRow } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'settings.update' AND entity = 'laboratory'`,
  );
  check("وهو باقٍ في سجل التدقيق كما كان — لم يُعَد كتابته", labRow[0].n === 1);

  /* ═══ ٤ — الكتابة الضائعة ═══ */
  console.log("\n── ٤: من يكتب على طابعٍ قديم يُردّ ──");
  const stored = await db.readStoredSettings();
  const staleStamp = stored.get("ops.late_tolerance_minutes")?.updatedAt ?? null;
  await db.saveSettingsAudited({
    values: { "ops.late_tolerance_minutes": "33" }, actor: "مدير ثانٍ", actorRole: "admin",
  });
  const lost = await db.saveSettingsAudited({
    values: { "ops.late_tolerance_minutes": "44", "clinic.chairs": "9" },
    expected: { "ops.late_tolerance_minutes": staleStamp },
    actor: "المدير الأول", actorRole: "admin",
  });
  check("الكتابة القديمة مردودة", lost.ok === false
    && lost.conflict.key === "ops.late_tolerance_minutes");
  const afterConflict = await db.getSettings();
  check("وقيمة الثاني باقية لم تُمحَ", afterConflict["ops.late_tolerance_minutes"] === "33");
  check("ولم يُكتب شيءٌ من دفعة المردود — كلّها أو لا شيء",
    afterConflict["clinic.chairs"] === chairsBefore, afterConflict["clinic.chairs"]);

  const fresh = await db.readStoredSettings();
  const good = await db.saveSettingsAudited({
    values: { "ops.late_tolerance_minutes": "18" },
    expected: { "ops.late_tolerance_minutes": fresh.get("ops.late_tolerance_minutes").updatedAt },
    actor: "المدير الأول", actorRole: "admin",
  });
  check("وبالطابع الصحيح تمرّ", good.ok === true);

  /* ═══ ٥ — الإعادة إلى الافتراضي ═══ */
  console.log("\n── ٥: الإعادة حدثٌ جديد لا محوٌ للتاريخ ──");
  const historyBeforeReset = (await db.listSettingHistory({ key: "ops.late_tolerance_minutes" })).length;
  const reset = await db.saveSettingsAudited({
    values: { "ops.late_tolerance_minutes": SETTING_DEFAULTS["ops.late_tolerance_minutes"] },
    mode: "reset", actor: "المدير", actorRole: "admin", reason: "رجوع للأصل",
  });
  check("الإعادة نجحت", reset.ok === true);
  check("والقيمة صارت الافتراضي",
    (await db.getSettings())["ops.late_tolerance_minutes"] === SETTING_DEFAULTS["ops.late_tolerance_minutes"]);
  const historyAfterReset = await db.listSettingHistory({ key: "ops.late_tolerance_minutes" });
  check("والتاريخ نما ولم ينقص", historyAfterReset.length === historyBeforeReset + 1,
    `${historyBeforeReset} ← ${historyAfterReset.length}`);
  check("وفعلها مسمّى", historyAfterReset[0].action === "clinic_settings.reset");

  /* ═══ ٦ — التراجع ═══ */
  console.log("\n── ٦: التراجع كتابةٌ جديدة بقيمةٍ قديمة ──");
  const oldValue = historyAfterReset.find((row) => row.after === "33")?.after ?? "33";
  await db.saveSettingsAudited({
    values: { "ops.late_tolerance_minutes": oldValue },
    actor: "المدير", actorRole: "admin", reason: "تراجع عن الإعادة",
  });
  const afterRollback = await db.listSettingHistory({ key: "ops.late_tolerance_minutes" });
  check("القيمة عادت", (await db.getSettings())["ops.late_tolerance_minutes"] === oldValue);
  check("والسجلّ يحتفظ بالمسار كلّه", afterRollback.length === historyAfterReset.length + 1);
  check("ولا صفَّ تدقيقٍ عُدّل أو حُذف",
    afterRollback.filter((row) => row.action === "clinic_settings.reset").length === 1);

  /* ═══ ٧ — المستهلك يقرأ الإعداد ═══ */
  console.log("\n── ٧: تغيير الإعداد يغيّر سلوك القائمتين فعلًا ──");
  const patient = await db.createPatient({
    fullName: "مريض الإعدادات", phone: "770009911", altPhone: null, gender: "male",
    birthYear: 1990, address: null, medicalAlert: null, note: null,
  });
  const { rows: today } = await pool.query(
    `SELECT (NOW() AT TIME ZONE $1)::date::text AS d`, [db.CLINIC_TIME_ZONE],
  );
  const shift = (days) => {
    const [y, m, d] = today[0].d.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
  };
  const old = await db.createAppointment({
    patientId: patient.id, date: shift(-20), time: "10:00",
    durationMinutes: 30, appointmentType: null, note: null,
  });
  const listed = async () => (await db.listOpenPastAppointments()).some((r) => r.id === old.id);
  check("الموعد عمره ٢٠ يومًا معلّقٌ بالمدى الافتراضي (٣٠)", await listed());

  await db.saveSettingsAudited({
    values: { "ops.follow_up_lookback_days": "10" }, actor: "المدير", actorRole: "admin",
  });
  check("وبعد تضييق المدى إلى ١٠ خرج من القائمة", (await listed()) === false);

  await db.saveSettingsAudited({
    values: { "ops.follow_up_lookback_days": "60" }, actor: "المدير", actorRole: "admin",
  });
  check("وبتوسيعه إلى ٦٠ عاد", await listed());

  console.log(failed
    ? "\n✗ سقطت رحلة الإعدادات — راجع البنود أعلاه"
    : "\n✓ منصّة الإعدادات: الكتابة والتدقيق والتمييز والتزامن والإعادة والاستهلاك صحيحة");
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error("خطأ غير متوقع:", error);
  process.exit(1);
});
