# تنسيق هجرات الأمان وبوابة المريض وحزم التكامل الجزئي لـ `lib/db.ts` — 2026-11-11

## 1. هجرة أمان بوابة المريض المحجوزة (`0127_patient_portal_security.sql`)

- **إصلاحات عزل المرضى (الأولوية 1) والتقوية الأمنية (الأولوية 3)**:
  - **عدد الهجرات المطلوبة**: **0** (لا تضيف ولا تعدّل أي ملف في `migrations/`).
- **تأمين بوابة المريض الشامل (الأولوية 2 — منفّذ ومُختبر بالكامل على هذا الفرع)**:
  - **الهجرة المحجوزة والمثبّتة**: `migrations/0127_patient_portal_security.sql` (مُطابِقة بايت ببايت لـ `PATIENT_PORTAL_SECURITY_SQL` في `lib/patient-portal-security-schema.ts`).
  - **سند حجز الرقم `0127` (محدّث بتاريخ 2026-11-12)**:
    - تصل فروع التقويم لدوت (`#535` و`origin/hardening/ortho-value-first-20261112` @ `d61254fa`) إلى `0125_ortho_case_reopen.sql`.
    - حجز فرع كلاود (`origin/feat/claude-commission-case-participation-20261111` @ `297f83cd`) الرقم `0126_commission_case_participations.sql`.
    - الرقم **`0127`** شاغر عبر جميع الفروع المرفوعة على `origin/*`، وقد حُجز رسميًا للهجرة **`0127_patient_portal_security.sql`** بتفويض صريح من المالك.
  - **نطاق الـ DDL**: إنشاء 3 جداول إضافية مستقلة (`patient_portal_accounts`, `patient_portal_tokens`, `patient_portal_staff_grants`) دون تعديل أي جدول قائم أو أي هجرة قديمة أو بصماتها.
  - **التسجيل الكامل**: مسجّلة في `ensureSchema()` داخل `lib/db.ts`، وفي `lib/clinic-reset.ts` (`patient_portal_tokens` و`patient_portal_accounts` في `RESET_WIPE_TABLES` قبل `patients`، و`patient_portal_staff_grants` في `RESET_KEEP_TABLES`)، وفي `scripts/verify-schema-ownership.ts`، وعقدَي `schema/current-schema-contract.pg18.json` و`schema/preflight-disclosure.pg18.json`.

## 2. الحفاظ على حماية توافق هجرة السيفالومتري `0124` في `#535`

- لم يلمس هذا الفرع ملف `lib/migrations.ts` ولا `lib/ceph-lineage-migration-compat.ts` ولا `migrations/0124_ceph_correction_lineage.sql` (بصمة `0d1d94a2003db6599dee120be75c3ff092ad4a19f4e1c911cbde1aa9fc845355`) ولا أي هجرة سابقة (`0001..0125`).
- عند الدمج مع `#535` تبقى طبقة `validateCephLineageMigration` و`cephLineageMigrationSql` في `lib/migrations.ts` سليمة بالكامل دون أي تعارض.

## 3. خريطة التعديلات المحددة (Bounded Hunks) في `lib/db.ts` للتكامل مع دوت وكلاود

> **تنبيه تكامل إلزامي**: ملف `lib/db.ts` مشترك مع أعمال كلاود (`#536` — الشرائح `94d-2..95d` وإصلاح نطاق `removePlanItemOn`) وأعمال دوت (`#535`). **يُحظر استبدال `lib/db.ts` كاملًا**؛ تُنقل فقط المقاطع المحددة التالية وتُراجع موضعيًا:

1. **نطاق زيارات اليوم والتاريخ والربط السريري (`lib/db.ts`)**:
   - `DoctorPatientScopeFilter` و`doctorOwnedPatientSql`
   - `listTodayVisits(scope?)` و`listVisitsByDate(date, scope?)`
   - `addVisit`: فحص `resolveRestrictedDoctorScope` ومنع الاستحواذ عبر `patientId` أو تطابق رقم الهاتف داخل المعاملة قبل إنشاء الصف.
   - `openVisitPatientFile` و`linkVisitToPatient` و`resolveVisitPatient` / `resolveVisitPatientDetailed` و`createNextSession`: تمرير `actorSession` والتحقق الذرّي قبل ربط الزيارة بملف قائم.
2. **إنشاء المريض الأولي للطبيب المقيّد (`lib/db.ts`)**:
   - `createPatient(input, options?: { primaryDoctorId?: number | null })`: إسناد `primary_doctor_id` عند إنشاء الطبيب المقيّد لمريض جديد مشروع.
3. **إبطال جلسات ورموز البوابة عند دمج مريض أو تغيّر هاتفه (`lib/db.ts`)**:
   - `mergeDuplicatePatient`: إبطال رموز المصدر وحذف حساب البوابة المدموج قبل نقل المفاتيح الأجنبية (محمي بفحص `to_regclass('public.patient_portal_accounts')` للتوافق قبل وبعد تشغيل هجرة البوابة).
   - `updatePatient`: رفع `credential_version` وتحديث `sessions_revoked_at = NOW()` و`phone_fingerprint` وإبطال الرموز المفتوحة فور تغيّر `phone` أو `altPhone`، مع استيراد `portalPhoneFingerprint` من `./portal`.
4. **نطاق أوامر المختبر (`lib/db.ts`)**:
   - `listLabOrders(filters?, scope?)` و`labCounts(options?, scope?)`
   - `createLabOrder`, `setLabOrderStatus`, `createLabOrderRemake`, `setLabOrderDueDate`: فحص `actorSession` داخل المعاملة قبل الكتابة.
5. **نطاق الاستدعاء والتوقيع السريري والجلسات المخططة (`lib/db.ts`)**:
   - `listOpenPastAppointments(scope?)` و`listLapsedPatients(weeks, scope?)`
   - `signClinicalVisit` و`startVisitFromPlannedVisit`: فحص `actorSession` قبل إنشاء شاهد ملكية أو زيارة.
6. **نطاق قائمة المحادثات والعدادات وتنقيح سجل الرسائل (`lib/db.ts`)**:
   - `staffConversationList(userId, scope?)`, `unreadMessageCount(userId, scope?)`, `urgentUnreadMessageCount(userId, scope?)`, ودعم `redactedBody` في `recordMessageDelivery`.

## 4. ضوابط البوابة النهائية بعد مراجعة دوت

- **حذف الدخول القديم بالهاتف ورقم الملف نهائيًا**: لا يوجد أي مفتاح طوارئ (`allow_legacy_phone_login`) أو استثناء تشغيلي قد يعيد الثغرة؛ أي طلب دخول قديم يُرفض بـ `403` قطعيًا.
- **الاستعادة الآمنة بعد التحقق الحضوري**: عند فقدان الهاتف أو تغيّر وسيلة التواصل، يوثّق الموظف المخوّل التحقق الحضوري من هوية المريض (`>= 8` أحرف)، ويحدّث رقم التواصل في الملف (مما يبطل الجلسات والروابط السابقة فورًا)، ثم يصدر رابط استعادة مؤقتًا أحادي الاستخدام (عبر واتساب/SMS للرقم المحدّث أو عرضًا لمرة واحدة في الاستقبال).
- **معاينة البوابة للإدارة المخوّلة فقط (`can_preview_portal`)**: للقراءة فقط بهوية الموظف نفسه (`aqlan_portal_preview` مستقل لـ 30 دقيقة)، مع تسجيل الموظف والوقت والسبب في `audit_log` عند البدء وعند الخروج، ورفض `403` لأي عملية كتابة باسم المريض، وعدم تخزين أو عرض أي كلمات مرور أو رموز خام.
