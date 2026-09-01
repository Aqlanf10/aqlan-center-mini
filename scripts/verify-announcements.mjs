#!/usr/bin/env node
/**
 * هل إعلانات شاشة الصالة صارت قائمةً حيّة فعلًا؟ — رحلة كاملة على PGlite في الذاكرة.
 *
 * معايير القبول (كما طُلبت):
 *  ١) إضافة إعلان واحد، ثم عشرة، ثم خمسين — بلا «القيمة طويلة أكثر من اللازم».
 *  ٢) تعديل إعلان: النص يتغيّر ويُختم «آخر تعديل» و«من عدّله».
 *  ٣) تعطيل إعلان يُخفيه عن شاشة الصالة، وإعادة تفعيله تعيده.
 *  ٤) حذف إعلان يُزيله نهائيًا.
 *  ٥) تغيير الترتيب يعيد كتابة أرقام الترتيب كلها، والشاشة تتبعها.
 *  ٦) الترحيلة: الخانة القديمة «العنوان | النص» تصير سجلات، مرةً واحدة، والقيمة
 *     القديمة لا تُمسّ إلا بعد تحقق العدّ، والفشل يتركها سليمة.
 *  ٧) مصدر الشاشة يعيد المفعّل وحده بترتيبه، عنوانًا ونصًّا لا أكثر.
 *  ٨) الشاشة لا تتعطل: لا إعلاناتٍ → الافتراضي، وجدولٌ غائب → الصيغة القديمة.
 *  ٩) الصلاحية: المدير وحده — isAdmin ترى ما تراه مسارات الـ API.
 *
 * لا يحتاج خادم قاعدة: يُشغَّل على PGlite داخل العملية، فالجدول والاستعلامات
 * نفسها التي تُشغَّل على Postgres في الإنتاج.
 */
process.env.SESSION_SECRET = "f".repeat(48);
process.env.USE_LOCAL_DB = "true";
process.env.DATABASE_URL = "";

const db = await import("../lib/db.ts");
const { DEFAULT_ANNOUNCEMENTS, MAX_ANNOUNCEMENTS_COUNT } = await import("../lib/waiting-room.ts");
const { isAdmin } = await import("../lib/roles.ts");

let failed = false;
const check = (label, ok, extra = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failed = true;
};

const raw = (sql) => db.getPool().query(sql);

/** يعيد الجدول والإعدادات إلى ما قبل كل شيء: لا سجلات، لا علم، خانة قديمة فارغة. */
async function resetAnnouncementsState() {
  await raw(`DELETE FROM display_announcements`);
  await raw(`DELETE FROM settings WHERE key = 'display.announcements_migrated'`);
  await raw(
    `INSERT INTO settings (key, value) VALUES ('display.announcements', '')
     ON CONFLICT (key) DO UPDATE SET value = '', updated_at = NOW()`,
  );
  db.invalidateSettingsCache();
}

const setLegacyAnnouncements = async (value) => {
  await raw(
    `INSERT INTO settings (key, value) VALUES ('display.announcements', '${value.replace(/'/g, "''")}')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
  );
  db.invalidateSettingsCache();
};

const legacyValue = async () => {
  const { rows } = await raw(`SELECT value FROM settings WHERE key = 'display.announcements'`);
  return rows[0]?.value ?? "";
};

try {
  await db.ensureSchema();
  console.log("١) إضافة إعلان واحد");
  await resetAnnouncementsState();
  const first = await db.createDisplayAnnouncement({
    title: "العناية بعد التقويم",
    body: "الالتزام بالمطاط حسب تعليمات الطبيب يسرّع تقدم العلاج.",
    isActive: true,
    actor: "admin",
  });
  check("أُنشئ برقم وترتيب ومُنشِئ", first.id > 0 && first.sortOrder === 1 && first.createdBy === "admin");
  check("مفعّل افتراضيًا وظاهر للشاشة", first.isActive);
  let list = await db.listDisplayAnnouncements();
  check("القائمة تعرضه وحده", list.length === 1 && list[0].title === "العناية بعد التقويم");

  console.log("٢) إضافة عشرة إعلانات ثم خمسين — لا حدًّا صغيرًا في الطريق");
  for (let index = 0; index < 10; index += 1) {
    await db.createDisplayAnnouncement({
      title: `إعلان ${index + 1}`,
      body: `نص الإعلان رقم ${index + 1} — رسالة توعية للصالة.`,
      isActive: true,
      actor: "admin",
    });
  }
  list = await db.listDisplayAnnouncements();
  check("صار واحداً وعشرة", list.length === 11);
  check("الترتيب متتالٍ من ١ بلا تشابك", list.every((item, index) => item.sortOrder === index + 1));

  for (let index = 0; index < 50; index += 1) {
    await db.createDisplayAnnouncement({
      title: `إعلان كثافة ${index + 1}`,
      body: `نص الإعلان الكثيف رقم ${index + 1}.`,
      isActive: true,
      actor: "admin",
    });
  }
  list = await db.listDisplayAnnouncements();
  check(
    "واحد + عشرة + خمسون = ٦١ إعلانًا — «القيمة طويلة» لم تُقل كلمتها",
    list.length === 61,
    `العدد: ${list.length}`,
  );
  check("السقف الوقائي بعيد (لا يلمسه الاستخدام الصادق)", list.length < MAX_ANNOUNCEMENTS_COUNT);

  console.log("٣) تعديل إعلان — النص وحده والختم يكمل");
  const target = list[5];
  const beforeEdit = await db.listDisplayAnnouncements();
  const edited = await db.updateDisplayAnnouncement(
    target.id,
    { title: "عنوان معدّل", body: "نص معدّل بالكامل." },
    "admin",
  );
  check("النص والعنوان تغيّرا", edited.title === "عنوان معدّل" && edited.body === "نص معدّل بالكامل.");
  check("التفعيل والترتيب لم يُلمسا", edited.isActive === target.isActive && edited.sortOrder === target.sortOrder);
  check("«من عدّله» صار admin", edited.updatedBy === "admin");
  check(
    "«آخر تعديل» تحرّك عن لحظة الإنشاء",
    Date.parse(edited.updatedAt) > Date.parse(beforeEdit[5].createdAt),
  );
  const missing = await db.updateDisplayAnnouncement(999_999, { title: "لا شيء" }, "admin");
  check("إعلان غائب → null لا انهيار", missing === null);

  console.log("٤) تعطيل إعلان يُخفيه عن الشاشة وإعادة تفعيله تعيده");
  const screenBefore = await db.activeAnnouncementsForScreen();
  const hidden = screenBefore.length; // 61 مفعّلًا كلها
  const disabled = await db.updateDisplayAnnouncement(edited.id, { isActive: false }, "admin");
  check("أُطفئ بلا مسّ النص", disabled.isActive === false && disabled.title === "عنوان معدّل");
  const screenAfter = await db.activeAnnouncementsForScreen();
  check("اختفى من مصدر الشاشة", screenAfter.length === hidden - 1);
  check("لا يظهر نصه في جواب الشاشة", !screenAfter.some((item) => item.title === "عنوان معدّل"));
  await db.updateDisplayAnnouncement(edited.id, { isActive: true }, "admin");
  const screenRestored = await db.activeAnnouncementsForScreen();
  check("عاد بعد إعادة التفعيل", screenRestored.length === hidden);

  console.log("٥) حذف إعلان");
  const victim = list[60];
  const removed = await db.deleteDisplayAnnouncement(victim.id);
  check("حُذف فعلًا", removed === true);
  const afterDelete = await db.listDisplayAnnouncements();
  check("لم يعد في القائمة", !afterDelete.some((item) => item.id === victim.id));
  check("حذف الغائب يعيد false لا انهيارًا", (await db.deleteDisplayAnnouncement(victim.id)) === false);

  console.log("٦) تغيير الترتيب");
  const beforeOrder = await db.listDisplayAnnouncements();
  const ids = beforeOrder.map((item) => item.id);
  const reversed = [...ids].reverse();
  await db.reorderDisplayAnnouncements(reversed);
  const afterOrder = await db.listDisplayAnnouncements();
  check("الترتيب انقلب كما أُرسل", afterOrder.map((item) => item.id).join(",") === reversed.join(","));
  check("أرقام الترتيب أعيدت كتابتها متتالية", afterOrder.every((item, index) => item.sortOrder === index + 1));
  check(
    "«آخر تعديل» لا يمسّه الترتيب — تحريك القائمة ليس تحرير محتوى",
    afterOrder[0].updatedAt === beforeOrder.find((item) => item.id === reversed[0]).updatedAt,
  );
  const screenOrder = await db.activeAnnouncementsForScreen();
  check("الشاشة تتبع الترتيب الجديد", screenOrder[0].title === afterOrder[0].title);
  let reorderRejected = false;
  try {
    await db.reorderDisplayAnnouncements(reversed.slice(1)); // قائمة ناقصة
  } catch {
    reorderRejected = true;
  }
  check("القائمة الناقصة عن الجدول تُرفض", reorderRejected);

  console.log("٧) مصدر الشاشة: المفعّل وحده، عنوانًا ونصًّا لا أكثر");
  const sample = screenOrder[0];
  check("الجواب لا يحمل إدارةً ولا معرّفات", Object.keys(sample).sort().join(",") === "body,title");
  check("لا مُنشِئ ولا تاريخ في جواب الشاشة", !("createdBy" in sample) && !("updatedAt" in sample));

  console.log("٨) الترحيلة من الخانة القديمة");
  await resetAnnouncementsState();
  await setLegacyAnnouncements(
    "تذكير | يرجى إبلاغ الاستقبال بأي تغيير في رقم الهاتف.\n" +
      "خدمات المركز | تقويم الأسنان • زراعة • تجميل\n" +
      "سطر تالف بلا فاصل\n" +
      "العناية بعد التقويم | الالتزام بالمطاط يسرّع العلاج.",
  );
  const migratedCount = await db.migrateAnnouncementsFromLegacy();
  const migrated = await db.listDisplayAnnouncements();
  check("كل سطرٍ صالح هُجِّر — والتالف تُخطّاه الشاشة القديمة نفسها", migratedCount === 3 && migrated.length === 3);
  check("بترتيب أسطرها كما كُتبت", migrated[0].title === "تذكير" && migrated[2].title === "العناية بعد التقويم");
  check("مفعّلة كلها ومسجَّلة هجرةً", migrated.every((item) => item.isActive && item.createdBy === "migration"));
  check("القيمة القديمة أُفرغت بعد التحقق — حذفُ كل الإعلانات لا يُبعِثها", (await legacyValue()) === "");
  const again = await db.migrateAnnouncementsFromLegacy();
  const againList = await db.listDisplayAnnouncements();
  check("إعادة الترحيلة لا تكرّر شيئًا — مرةً واحدة", again === 0 && againList.length === 3);
  const marker = await raw(`SELECT key FROM settings WHERE key = 'display.announcements_migrated'`);
  check("علم الترحيلة مثبت في settings", marker.rows.length === 1);
  const screenMigrated = await db.activeAnnouncementsForScreen();
  check("الشاشة تقرأ من السجلات بعد الترحيلة", screenMigrated.length === 3 && screenMigrated[0].title === "تذكير");

  console.log("٩) الاحتياط: فشل الترحيلة لا يعطّل الشاشة");
  await resetAnnouncementsState();
  await setLegacyAnnouncements("احتياط | نصٌّ قديم يجب أن يبقى ظاهرًا");
  await raw(`DROP TABLE display_announcements`);
  const screenFallback = await db.activeAnnouncementsForScreen();
  check(
    "الجدول غائب والترحيلة فشلت → الصيغة القديمة تعمل",
    screenFallback.length === 1 && screenFallback[0].title === "احتياط" && screenFallback[0].body.includes("قديم"),
  );
  check("جواب الاحتياط بالحقول نفسها (عنوان ونص)", Object.keys(screenFallback[0]).sort().join(",") === "body,title");

  console.log("١٠) لا إعلانات مفعّلة → النصوص الافتراضية بلا خطأ");
  db.schemaReadyReset(); // الجدول أُسقط للفحص أعلاه — يُبنى من جديد كما يُبنى أول إقلاع.
  await db.ensureSchema();
  await resetAnnouncementsState();
  await setLegacyAnnouncements("");
  const screenEmpty = await db.activeAnnouncementsForScreen();
  check(
    "الشاشة تعرض الافتراضي كما كانت",
    JSON.stringify(screenEmpty) === JSON.stringify(DEFAULT_ANNOUNCEMENTS),
  );

  console.log("١١) الصلاحية — المدير وحده يكتب");
  check("isAdmin(admin) يرى، وreception وdoctor لا يكتبان", isAdmin("admin") === true && isAdmin("reception") === false && isAdmin("doctor") === false);
} catch (error) {
  console.error("✗ فشل غير متوقع:", error);
  failed = true;
} finally {
  await db.getPool().end?.().catch(() => {});
}

console.log(failed ? "\n✗ لم تنجح كل الفحوص." : "\n✓ نجحت كل الفحوص.");
process.exit(failed ? 1 : 0);
