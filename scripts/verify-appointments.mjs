#!/usr/bin/env node
/**
 * تراكم المواعيد — الرحلة التشغيلية.
 *
 * الموعد المحجوز الذي مضى تاريخه لم يكن يظهر في أي شاشة: ليس في قائمة اليوم لأن
 * تاريخه مضى، ولا في قائمة المتغيّبين لأنها تشترط الحالة `no_show` ولا أحد يضعها
 * لأن أحدًا لم يكن يراه. فيبقى محجوزًا إلى الأبد: المريض لم يحضر ولم يتصل به أحد.
 *
 * ما يُثبَت هنا — وكلّه عن حال القاعدة لا عن دالّة:
 *   ١) الموعد الذي مضى وبقي محجوزًا يظهر في القائمة المعلّقة، والمغلقُ لا يظهر.
 *   ٢) موعد اليوم والغد ليسا معلّقين — «معلّق» تعني «مضى»، لا «قريب».
 *   ٣) «لم يحضر» ينقله إلى قائمة المتغيّبين — **ولا يُخفيه**. وهذا هو البند الذي
 *      يحرس أخطر عطبٍ ممكن هنا: لو اختلف مدى القائمتين بيومٍ واحد لخرج المريض من
 *      الأولى ولم يدخل الثانية، فيكون الإغلاق محوًا لا متابعة. ويُختبر عند الحدّ
 *      نفسه — اليوم الأخير داخل المدى — لأن الخطأ لا يظهر إلا هناك.
 *   ٤) «تمّت» تُغلقه بلا إدراجه في المتابعة — من حضر ولم يُسجَّل ليس متغيّبًا.
 *   ٥) الحرّاس: لا إغلاق لموعدٍ لم يمضِ، ولا إغلاق مرّتين، ولا «لم يحضر» على من
 *      سُجّل وصوله من شاشةٍ أخرى بين القراءة والضغط.
 *
 *   node --import tsx scripts/verify-appointments.mjs
 */
import "./use-pglite.mjs";

const db = await import("../lib/db.ts");
const { FOLLOW_UP_LOOKBACK_DAYS } = await import("../lib/recall.ts");
const { CLINIC_TIME_ZONE } = db;

const pool = db.getPool();
let failed = false;
const check = (label, ok, extra = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failed = true;
};

const number = () => "AP-" + Date.now().toString().slice(-8) + Math.floor(Math.random() * 97);

/** يوم العيادة من القاعدة نفسها — لا من ساعة هذه العملية. */
async function clinicToday() {
  const { rows } = await pool.query(
    `SELECT (NOW() AT TIME ZONE $1)::date::text AS today`, [CLINIC_TIME_ZONE],
  );
  return rows[0].today;
}
const shift = (date, days) => {
  const [y, m, d] = date.split("-").map(Number);
  const moved = new Date(Date.UTC(y, m - 1, d + days));
  return moved.toISOString().slice(0, 10);
};

async function makePatient(label) {
  return db.createPatient({
    fullName: `${label} ${number()}`, phone: "77" + number(), altPhone: null,
    gender: "male", birthYear: 1990, address: null, medicalAlert: null, note: null,
  });
}
async function bookOn(patientId, date, time = "10:00") {
  return db.createAppointment({
    patientId, date, time, durationMinutes: 30, appointmentType: null, note: null,
  });
}
const openIds = async () => (await db.listOpenPastAppointments()).map((row) => row.id);
const missedIds = async () => (await db.listMissedAppointments()).map((row) => row.id);

async function main() {
  console.log("تراكم المواعيد — التحقق التشغيلي");
  await db.ensureSchema();
  const today = await clinicToday();

  /* ═══ ١ — ما يظهر في القائمة المعلّقة وما لا يظهر ═══ */
  console.log("\n── ١: المعلّق هو المحجوز الذي مضى، لا سواه ──");
  const past = await makePatient("موعد مضى");
  const pastAppointment = await bookOn(past.id, shift(today, -3));
  const todayPatient = await makePatient("موعد اليوم");
  const todayAppointment = await bookOn(todayPatient.id, today);
  const future = await makePatient("موعد الغد");
  const futureAppointment = await bookOn(future.id, shift(today, 1));

  let open = await openIds();
  check("المحجوز الذي مضى معلّق", open.includes(pastAppointment.id));
  check("وموعد اليوم ليس معلّقًا — «معلّق» تعني مضى لا قريب", !open.includes(todayAppointment.id));
  check("وموعد الغد ليس معلّقًا", !open.includes(futureAppointment.id));

  /* الحالات المغلقة لا تُعدّ معلّقة مهما مضى عليها. */
  for (const status of ["arrived", "done", "cancelled", "no_show"]) {
    const patient = await makePatient(`مضى بحالة ${status}`);
    const appointment = await bookOn(patient.id, shift(today, -4));
    await pool.query(`UPDATE appointments SET status = $2 WHERE id = $1`, [appointment.id, status]);
    const list = await openIds();
    check(`المضى بحالة ${status} ليس معلّقًا`, !list.includes(appointment.id));
  }

  /* خارج المدى: ليس متابعةَ غياب بل استدعاءً، وله قائمته. */
  const old = await makePatient("أقدم من المدى");
  const oldAppointment = await bookOn(old.id, shift(today, -(FOLLOW_UP_LOOKBACK_DAYS + 5)));
  open = await openIds();
  check(`الأقدم من ${FOLLOW_UP_LOOKBACK_DAYS} يومًا ليس معلّقًا`, !open.includes(oldAppointment.id));

  /* ═══ ٢ — «لم يحضر» متابعةٌ لا محو — والحدّ هو موضع الخطر ═══ */
  console.log("\n── ٢: كل موعدٍ يظهر في المعلّقة يصل إلى المتغيّبين بعد إغلاقه ──");
  /*
   * المُثبَت هنا علاقةٌ بين قائمتين لا سلوكُ واحدة: **ما دخل المعلّقة يجب أن يصل
   * المتغيّبين**. فلو اختلف حدّا مدَيهما بيومٍ واحد لخرج المريض من الأولى ولم يدخل
   * الثانية — إغلاقٌ هو محوٌ في الحقيقة.
   *
   * ويُجرَّب حول الحدّ بالذات: اختبارُ يومٍ في وسط المدى يمرّ ولو اختلف الحدّان،
   * لأن الاختلاف لا يظهر إلا عند اليوم الفاصل. وهذا ما وقعتُ فيه أوّلًا: فحصٌ عند
   * المدى ناقص واحد مرّ سالمًا تحت العطب نفسه.
   */
  for (const age of [FOLLOW_UP_LOOKBACK_DAYS + 1, FOLLOW_UP_LOOKBACK_DAYS, FOLLOW_UP_LOOKBACK_DAYS - 1, 1]) {
    const patient = await makePatient(`عمره ${age} يومًا`);
    const appointment = await bookOn(patient.id, shift(today, -age));
    const listedOpen = (await openIds()).includes(appointment.id);
    await db.resolvePastBooking(appointment.id, "no_show");
    const listedMissed = (await missedIds()).includes(appointment.id);
    check(`عمره ${age} يومًا: ${listedOpen ? "معلّق" : "خارج المدى"} — ${listedOpen ? "ويصل المتغيّبين" : "ولا يُعرض أصلًا"}`,
      listedOpen === listedMissed,
      listedOpen === listedMissed ? "" : `معلّق=${listedOpen} متغيّب=${listedMissed} — مريضٌ ضاع بين القائمتين`);
  }

  /* والإغلاق نفسه يعمل ويُخرجه من المعلّقة. */
  const edge = await makePatient("إغلاق صريح");
  const edgeAppointment = await bookOn(edge.id, shift(today, -3));
  check("أُغلق بـ«لم يحضر»", (await db.resolvePastBooking(edgeAppointment.id, "no_show")) === true);
  check("وخرج من قائمة المعلّقة", !(await openIds()).includes(edgeAppointment.id));
  check("ودخل قائمة المتغيّبين", (await missedIds()).includes(edgeAppointment.id));

  /* ═══ ٣ — «تمّت» تُغلق بلا متابعة ═══ */
  console.log("\n── ٣: «تمّت» — من حضر ولم يُسجَّل ليس متغيّبًا ──");
  const attended = await makePatient("حضر ولم يُسجَّل");
  const attendedAppointment = await bookOn(attended.id, shift(today, -2));
  check("أُغلق بـ«تمّت»", (await db.resolvePastBooking(attendedAppointment.id, "done")) === true);
  check("خرج من المعلّقة", !(await openIds()).includes(attendedAppointment.id));
  check("ولم يدخل المتغيّبين", !(await missedIds()).includes(attendedAppointment.id));

  /* ═══ ٤ — الحرّاس ═══ */
  console.log("\n── ٤: الحرّاس في جملة التحديث نفسها ──");
  check("لا إغلاق مرّتين", (await db.resolvePastBooking(attendedAppointment.id, "no_show")) === false);
  check("ولا إغلاق لموعدٍ لم يمضِ", (await db.resolvePastBooking(futureAppointment.id, "no_show")) === false);
  const { rows: futureStill } = await pool.query(
    `SELECT status FROM appointments WHERE id = $1`, [futureAppointment.id],
  );
  check("وموعد الغد لم تُمسّ حالته", futureStill[0].status === "booked");

  /* السباق الحقيقي: الاستقبال تسجّل وصوله بينما الشاشة الأخرى تضغط «لم يحضر». */
  const racing = await makePatient("سباق الوصول");
  const racingAppointment = await bookOn(racing.id, today);
  await db.arriveAppointment(racingAppointment.id);
  check("من سُجّل وصوله لا يُكتب عليه «لم يحضر»",
    (await db.closeBookedAppointment(racingAppointment.id, "no_show")) === false);
  const { rows: racingRow } = await pool.query(
    `SELECT status FROM appointments WHERE id = $1`, [racingAppointment.id],
  );
  check("وحالته باقية «وصل» — لا زيارةَ حيّةً بموعدٍ يقول إن صاحبه غاب",
    racingRow[0].status === "arrived", racingRow[0].status);

  check("والمحجوز يُلغى بلا اعتراض", (await db.closeBookedAppointment(todayAppointment.id, "cancelled")) === true);
  check("ولا يُلغى مرّتين", (await db.closeBookedAppointment(todayAppointment.id, "cancelled")) === false);

  console.log(failed ? "\n✗ سقطت رحلة المواعيد — راجع البنود أعلاه" : "\n✓ تراكم المواعيد: القائمة والإغلاق والحرّاس صحيحة");
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error("خطأ غير متوقع:", error);
  process.exit(1);
});
