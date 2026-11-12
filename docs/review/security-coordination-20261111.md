# تنسيق هجرات الأمان وبوابة المريض وحزم التكامل الجزئي لـ `lib/db.ts` — 2026-11-12

## 1. الهجرة المحجوزة رسميًا (`0127_patient_portal_security.sql`)

- **إصلاحات عزل المرضى (الأولوية 1) والتقوية الأمنية (الأولوية 3)**:
  - **عدد الهجرات المطلوبة**: **0** (لا تضيف ولا تعدّل أي ملف قديم في `migrations/`).
- **تأمين بوابة المريض الشامل (الأولوية 2 — منفّذ ومُختبر على PostgreSQL 18.6 المعزول)**:
  - **الملف المحجوز والمثبّت**: `migrations/0127_patient_portal_security.sql`
  - **بصمة SHA-256 النهائية**: `f8771647e3a149536af80bc54439fef7cd6bb1bc750707a87c51f9d336de535f` (مطابقة بايت ببايت لـ `PATIENT_PORTAL_SECURITY_SQL` في `lib/patient-portal-security-schema.ts`).
  - **سند حجز الرقم `0127` والتنسيق مع كلاود ودوت**:
    - الاستيجنج الحالي (`origin/feat/staging-candidate-rx-20261105` @ `779bf35b`): يصل إلى `0093_prescription_issuance_commands.sql`.
    - الأشعة (`origin/feat/mini-complete-staging-20261105`): `0094_radiology_requests.sql`.
    - فروع التقويم لدوت (`#535` و`origin/hardening/ortho-value-first-20261112` @ `d61254fa`): تصل إلى `0125_ortho_case_reopen.sql`.
    - فرع العمولات لكلاود (`origin/feat/claude-commission-case-participation-20261111` @ `297f83cd`): حجز `0126_commission_case_participations.sql`.
    - بتأكيد المالك وإبلاغ كلاود، حُجز الرقم **`0127`** رسميًا لـ `0127_patient_portal_security.sql`، بحيث يستخدم كلاود **`0128+`** لهجرة المصروفات دون تصادم.
  - **نطاق الـ DDL**: إنشاء 3 جداول إضافية مستقلة (`patient_portal_accounts`, `patient_portal_tokens`, `patient_portal_staff_grants`) **بلا أي عمود ملكية محلي (`is_owner`)** ودون تعديل أي جدول قائم أو أي هجرة سابقة أو بصمتها.
  - **التسجيل الكامل وعقود المخطط**: مسجّلة في `ensureSchema()` داخل `lib/db.ts`، وفي `lib/clinic-reset.ts` (`patient_portal_tokens` و`patient_portal_accounts` في `RESET_WIPE_TABLES` قبل `patients`، و`patient_portal_staff_grants` في `RESET_KEEP_TABLES`)، وفي `scripts/verify-schema-ownership.ts`، و`__tests__/postgres/schema-ownership.test.ts`، وعقدَي `schema/current-schema-contract.pg18.json` و`schema/preflight-disclosure.pg18.json`، ومُختبرة بالترقية الفعلية من الاستيجنج `779bf35b` وبالتطبيق المشترك الكامل `0001..0127` على PostgreSQL 18.6 معزول.

## 2. الحفاظ على حماية توافق هجرة السيفالومتري `0124` والتعايش مع الحراس الموحدة

- لم يلمس هذا الفرع ملف `lib/migrations.ts` ولا `lib/ceph-lineage-migration-compat.ts` ولا `migrations/0124_ceph_correction_lineage.sql` (بصمة `0d1d94a2003db6599dee120be75c3ff092ad4a19f4e1c911cbde1aa9fc845355`).
- لم يلمس هذا الفرع ملفات الحراس الموحدة لكلاود (`lib/staff-capabilities.ts`, `lib/staff-capability-catalogue.ts`, `lib/staff-permission-envelope.ts`, `lib/staff-capabilities-legacy.ts`, `lib/doctor-permissions.ts`):
  - يقرأ `lib/staff-owner-authority.ts` هوية المالك حصريًا من المصدر القانوني المعتمد (`staff_authority_control` + `staff_identity_state` + سلسلة `staff_identity_generations` / `staff_identity_subjects` / `staff_identity_binding_events` / `staff_identity_current` + `users.authorization_mode = 'canonical'`) ويفشل مغلقًا (`isOwner = false`) في الوضع القديم (`legacy`) أو عند تعليق السلطة (`held`).
  - تتوافق دالة الفحص تلقائيًا مع `STAFF_CAPABILITY_SCHEMA_VERSION = 1` (على `main`) ومع `STAFF_CAPABILITY_SCHEMA_VERSION = 2` (`confirmation: "owner" | "pending"` على فرع تكامل كلاود `33175cbe`) لأن التحليل يمر حصريًا عبر `./staff-capabilities`.
  - يحتفظ المسار بحراس نطاق المريض (`actorSession` / `canAccessPatient` / `doctorOwnedPatientSql`) وحراس كلاود الموحدة معًا دون إلغاء أي طبقة.

## 3. خريطة التعديلات المحددة (`Bounded Hunks`) في الملفات المشتركة للتكامل مع كلاود ودوت

> **تنبيه تكامل إلزامي**: ملف `lib/db.ts` مشترك مع أعمال كلاود (`33175cbe`) وأعمال دوت (`#535`). **يُحظر استبدال `lib/db.ts` كاملًا**؛ تُنقل فقط المقاطع المحددة التالية وتُراجع موضعيًا:

1. **نطاق زيارات اليوم والربط السريري والهاتف العائلي المشترك (`lib/db.ts`)**:
   - `DoctorPatientScopeFilter` و`doctorOwnedPatientSql` و`listTodayVisits(scope?)` و`listVisitsByDate(date, scope?)`.
   - `SharedPhonePatientCandidate` و`AmbiguousSharedPhonePatientError` و`queryPatientsSharingPhone`: منع تحديد هوية المريض بالهاتف وحده عبر `addVisit`، و`resolveVisitPatientDetailed`، و`previewPatientId`، و`lockVisitPatientFirst`، و`existingPatientForBookingRequest` / `confirmBookingRequest`، مع تصفية المرشحين للطبيب المقيّد بحيث يُرمى `PatientOutOfScopeError` (`403`) دون كشف أي اسم أو معرّف خارج نطاقه.
   - `openVisitPatientFile` و`linkVisitToPatient` و`createNextSession` و`signClinicalVisit` و`startVisitFromPlannedVisit`: تمرير `actorSession` والتحقق الذرّي قبل إنشاء شاهد ملكية.
2. **إنشاء المريض الأولي للطبيب المقيّد (`lib/db.ts`)**:
   - `createPatient(input, options?: { primaryDoctorId?: number | null })`: إسناد `primary_doctor_id` عند إنشاء الطبيب المقيّد لمريض جديد مشروع.
3. **إبطال جلسات ورموز البوابة عند دمج مريض أو تغيّر هاتفه (`lib/db.ts` و`lib/audit.ts`)**:
   - `mergeDuplicatePatient`: إبطال رموز المصدر وحذف حساب البوابة للمصدر قبل نقل المفاتيح الأجنبية، **ورفع `credential_version` وتحديث `sessions_revoked_at = NOW()` و`phone_fingerprint` وإبطال الرموز المفتوحة للملف الهدف أيضًا**، وتسجيل الإجراء `"portal.account.patient_merged"` المضاف في `lib/audit.ts`.
   - `updatePatient`: رفع `credential_version` وتحديث `sessions_revoked_at = NOW()` و`phone_fingerprint` وإبطال جميع الرموز المفتوحة فور تغيّر `phone` أو `altPhone`.
4. **نطاق المختبر والاستدعاء والمحادثات وتنقيح الرسائل (`lib/db.ts`)**:
   - `listLabOrders(filters?, scope?)`، `labCounts(options?, scope?)`، وفحص `actorSession` في `createLabOrder` و`setLabOrderStatus` و`createLabOrderRemake` و`setLabOrderDueDate`.
   - `listOpenPastAppointments(scope?)` و`listLapsedPatients(weeks, scope?)`.
   - `staffConversationList(userId, scope?)`، `unreadMessageCount(userId, scope?)`، `urgentUnreadMessageCount(userId, scope?)`، ودعم `redactedBody` في `recordMessageDelivery`.
5. **نقاط التماس المحددة خارج `lib/db.ts`**:
   - `lib/portal.ts` و`lib/portal-security.ts`: دُمج بالفعل قيد فرع كلاود `33175cbe` لإبطال كوكي البوابة فور تعديل `patient_number` (`row.patient_number !== payload.patientNumber`) وسقف `patientNumber.length > 21`. وعند الدمج مع فرع التقويم `d61254fa` يُحتفظ بسطرَي إعادة التصدير `export { INTAKE_CONDITIONS, type IntakeAnswers } from "./portal-intake-fields"` في `lib/portal.ts`.
   - المقارنة مع أعمال دوت في الصيانة: لم نلمس `lib/money.ts` (تقريب المبالغ) ولا `lib/restore/` أو `scripts/restore-full.ts`؛ وفي `/api/book` جمعنا بين الفحص المبدئي المتزامن قبل لمس القاعدة، وحد الهاتف المطبّع (`6 / 15m`)، وحد المصدر الموثوق لـ CGNAT (`30 / 15m` مع `TRUST_PROXY=true`)، والسقف الاحتياطي العام (`120 / 15m` بدون `TRUST_PROXY`)؛ وفي `lib/xlsx-reader.ts` أضفنا القطع التدفقي المباشر داخل `browserInflateRaw` (`16 MB` لكل ملف و`32 MB` إجماليًا و`100,000` صف).

## 4. ضوابط البوابة والسياسات المعروضة لتأكيد المالك قبل التفعيل الإنتاجي

- **إيقاف الدخول القديم بالهاتف ورقم الملف قطعيًا (`403`)**: بلا أي مفتاح طوارئ؛ ولا تُرسل أي كلمات مرور عبر واتساب أو SMS أبدًا (روابط مؤقتة أحادية الاستخدام فقط بعد التحقق من الهوية والملف).
- **إبطال رابط واحد مقابل جميع الروابط المفتوحة**: إصدار رابط جديد أو استهلاكه أو تغيير الهاتف أو التعطيل أو الدمج يبطل **جميع** الروابط المفتوحة للمريض؛ بينما يبطل فشل الإرسال عبر المزود ذلك الرابط الفاشل وحده (`delivery_failed`).
- **السياسات المحافظة التي يُطلب تأكيد المالك لها قبل فتح البوابة في الإنتاج**:
  1. اشتراط إتمام تفعيل السلطة القانونية الموحدة (`canonical`) في الإنتاج قبل استخدام منح `can_preview_portal` (لأن الوضع القديم يفشل مغلقًا `isOwner = false`).
  2. بقاء صلاحية تحديث وسيلة التواصل أثناء الاستعادة الحضورية (`inPersonVerified + updatedPhone` مع ملاحظة `>= 8` أحرف) متاحة للاستقبال المخوّل بـ`can_manage_portal` + `patients.edit` أو قصرها على الإدارة فقط.
  3. مدد صلاحية الروابط (`60m` تفعيل / `30m` استعادة عبر الرسائل / `15m` عرض حضوري مباشر) ومدة الجلسة (`7d` محكومة بفحص القاعدة الحي).
  4. الاكتفاء بإبطال جلسات وروابط الملف الهدف عند `mergeDuplicatePatient` أو تحويل حساب الهدف إلى `pending_activation`.
