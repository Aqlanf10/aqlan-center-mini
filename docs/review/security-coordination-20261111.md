# تنسيق هجرات الأمان وبوابة المريض وحزم التكامل الجزئي لـ `lib/db.ts` — 2026-11-12

## 1. الهجرة المحجوزة رسميًا (`0127_patient_portal_security.sql`)

- **إصلاحات عزل المرضى (الأولوية 1) والتقوية الأمنية (الأولوية 3)**:
  - **عدد الهجرات المطلوبة**: **0** (لا تضيف ولا تعدّل أي ملف قديم في `migrations/`).
- **تأمين بوابة المريض الشامل (الأولوية 2 — منفّذ ومُختبر على PostgreSQL 18.6 المعزول)**:
  - **الملف المحجوز والمثبّت**: `migrations/0127_patient_portal_security.sql`
  - **بصمة SHA-256 النهائية**: `f8771647e3a149536af80bc54439fef7cd6bb1bc750707a87c51f9d336de535f` (مطابقة بايت ببايت لـ `PATIENT_PORTAL_SECURITY_SQL` في `lib/patient-portal-security-schema.ts`).
  - **سند حجز الرقم `0127` والتنسيق مع كلاود ودوت**:
    - **الاستيجنج المنشور حاليًا على Railway (`staging-web`)**: `4d85fb6943b889d5b343c8467be1adccece9e327` (`hardening/ceph-legacy-constraint-spelling-20261111`، PR `#537`، منشور في `2026-11-11T19:54:24Z`) ويضم **89 هجرة تصل إلى `0125_ortho_case_reopen.sql`** شاملةً هجرات الوصفات والتقويم والسيفالومتري (`0090..0093`، `0106`، `0108..0125`) غير المدمجة في `main` بعد *(تصحيح لمرجع سابق كان يذكر النشرة الأقدم `779bf35b` عند `0093`)*. ولهذا يفشل تشغيل فرعنا وحده ضد الاستيجنج `4d85fb69` مغلقًا (`unknownApplied` على الهجرات الـ23 غير الموجودة في `main`)، ويلزم دمجه ضمن فرع التكامل الموحد المنطلق من الاستيجنج.
    - الأشعة (`origin/feat/mini-complete-staging-20261105`): `0094_radiology_requests.sql`.
    - فروع التقويم لدوت (`#535` و`origin/hardening/ortho-value-first-20261112` @ `d61254fa`): تصل إلى `0125_ortho_case_reopen.sql`.
    - فرع تكامل كلاود الحالي (`#541` — `origin/feat/claude-integration-finance-ortho-20261112` @ `d6d6c71d` المنطلق من الاستيجنج `4d85fb69`): يضيف `0074`، `0079..0082`، و`0126_commission_case_participations.sql` (`95` هجرة إجمالًا).
    - بتأكيد المالك وإبلاغ كلاود، حُجز الرقم **`0127`** رسميًا لـ `0127_patient_portal_security.sql`، بحيث يستخدم كلاود **`0128+`** لأي هجرة مصروفات لاحقة دون تصادم.
    - **تحديثات الجولات اللاحقة (`F-05` + `F-07` + `DEF-02` + الاحتفاظ غير المدمّر بالرسائل المحذوفة)**: **0 هجرات إضافية مطلوبة**؛ جميع إصلاحات حجب الرسائل المحذوفة من الواجهة والتنزيل مع الاحتفاظ الكامل بالتخزين وتدقيق العملية، وربط تعليمات ما بعد الإجراء بالزيارة المحفوظة، وعزل أدوات المساعد الذكي تعمل على الأعمدة القائمة دون لمس `0127_patient_portal_security.sql` أو بصمتها.
  - **نطاق الـ DDL**: إنشاء 3 جداول إضافية مستقلة (`patient_portal_accounts`, `patient_portal_tokens`, `patient_portal_staff_grants`) **بلا أي عمود ملكية محلي (`is_owner`)** ودون تعديل أي جدول قائم أو أي هجرة سابقة أو بصمتها.
  - **التسجيل الكامل وعقود المخطط**: مسجّلة في `ensureSchema()` داخل `lib/db.ts`، وفي `lib/clinic-reset.ts` (`patient_portal_tokens` و`patient_portal_accounts` في `RESET_WIPE_TABLES` قبل `patients`، و`patient_portal_staff_grants` في `RESET_KEEP_TABLES`)، وفي `scripts/verify-schema-ownership.ts`، و`__tests__/postgres/schema-ownership.test.ts`، وعقدَي `schema/current-schema-contract.pg18.json` و`schema/preflight-disclosure.pg18.json`، ومُختبرة بالترقية الفعلية ببيانات اصطناعية من الاستيجنج الحالي `4d85fb69` (`89` هجرة حتى `0125` -> `90` هجرة بإضافة `0127`) وبالتسلسل المشترك مع فرع تكامل كلاود `#541` (`89 -> 95 -> 96` هجرة) على PostgreSQL 18.6 معزول.

## 2. الحفاظ على حماية توافق هجرة السيفالومتري `0124` والتعايش مع الحراس الموحدة

- لم يلمس هذا الفرع ملف `lib/migrations.ts` ولا `lib/ceph-lineage-migration-compat.ts` ولا `migrations/0124_ceph_correction_lineage.sql` (بصمة `0d1d94a2003db6599dee120be75c3ff092ad4a19f4e1c911cbde1aa9fc845355`).
- لم يلمس هذا الفرع ملفات الحراس الموحدة لكلاود (`lib/staff-capabilities.ts`, `lib/staff-capability-catalogue.ts`, `lib/staff-permission-envelope.ts`, `lib/staff-capabilities-legacy.ts`, `lib/doctor-permissions.ts`):
  - يحافظ الفرع حرفيًا على `lib/staff-owner-authority.ts` الخاص بنظام الوصفات الطبية في الاستيجنج (`4d85fb69`) دون تعديل، ويضع قارئ سلطة البوابة القانونية في `lib/portal-staff-authority.ts` ليقرأ هوية المالك حصريًا من المصدر القانوني المعتمد (`staff_authority_control` + `staff_identity_state` + سلسلة `staff_identity_generations` / `staff_identity_subjects` / `staff_identity_binding_events` / `staff_identity_current` + `users.authorization_mode = 'canonical'`) ويفشل مغلقًا (`isOwner = false`) في الوضع القديم (`legacy`) أو عند تعليق السلطة (`held`).
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
3. **تعليق/إبطال جلسات ورموز البوابة عند دمج مريض أو تغيّر هاتفه (`lib/db.ts` و`lib/audit.ts`)**:
   - `mergeDuplicatePatient`: إبطال رموز المصدر وحذف حساب البوابة للمصدر قبل نقل المفاتيح الأجنبية، وفي السلوك الافتراضي المحافظ (`PORTAL_POST_MERGE_TARGET_POLICY = 'suspend_target'`) **تعليق حساب البوابة على الملف الهدف (`status = 'disabled'`، `disabled_reason = 'patient_merged_pending_identity_review'`) ورفع `credential_version` وتحديث `sessions_revoked_at = NOW()` و`phone_fingerprint` وإبطال الرموز المفتوحة للملف الهدف** ريثما يتحقق الموظف من هوية الملف المدموج، مع تسجيل الإجراء `"portal.account.patient_merged"` في `audit_log`.
   - `updatePatient`: رفع `credential_version` وتحديث `sessions_revoked_at = NOW()` و`phone_fingerprint` وإبطال جميع الرموز المفتوحة فور تغيّر `phone` أو `altPhone`.
4. **نطاق المختبر والاستدعاء والمحادثات وتنقيح الرسائل وسياق طباعة ما بعد الإجراء (`lib/db.ts`)**:
   - `VisitPostOpContext` و`getVisitPostOpContext(visitId)`: قراءة سياق الزيارة المحفوظة (`patientId`, `visitDate`, `doctorName`, `nextPlan`, `addendum`) لصفحة `/print/post-op/[id]` بدل تمرير ملاحظات غير موثوقة في الرابط.
   - `listLabOrders(filters?, scope?)`، `labCounts(options?, scope?)`، وفحص `actorSession` في `createLabOrder` و`setLabOrderStatus` و`createLabOrderRemake` و`setLabOrderDueDate`.
   - `listOpenPastAppointments(scope?)` و`listLapsedPatients(weeks, scope?)`.
   - `staffConversationList(userId, scope?)`، `unreadMessageCount(userId, scope?)`، `urgentUnreadMessageCount(userId, scope?)`، ودعم `redactedBody` في `recordMessageDelivery`.
   - `getMessageAttachmentMeta(id, kind)` (مع إرجاع `isDeleted` لحجب التنزيل بـ `404` للمخوّلين بعد فحص الصلاحية `403` لغير المخوّلين)، وتصفية `deleted_at IS NULL` في `fileMessagePayload` و`voiceMessagePayload`، والحذف اللطيف الآمن غير المدمّر في `deleteStaffMessage` و`deletePatientMessage` بحيث يختفي النص والصوت والمرفق من واجهة المستخدم (`toMessageView` و`staffConversationList` و`MESSAGE_COLUMNS`) ومن روابط التنزيل **دون إتلاف أو مسح البيانات من التخزين (`messages`) قبل اعتماد سياسة الاحتفاظ**، مع تسجيل `message.delete` / `portal.message.delete` في `audit_log` داخل المعاملة نفسها، ورفض الحذف المتكرر (`already-deleted` / `409`)، وقصر معاينة العهدة المحتفظ بها (`inspectRetainedDeletedMessage`) على الإدارة النشطة ذات النطاق الكامل بسبب مكتوب وتدقيق `message.retained.inspect`.
5. **نقاط التماس المحددة خارج `lib/db.ts`**:
   - **طباعة `F-07` وسجل الطباعة المشترك مع كلاود**: في `app/print/post-op/[id]/page.tsx` و`components/PostOpModal.tsx` و`components/ClinicalVisit.tsx` أُلغي قبول `?notes=` و`?date=` و`?doctor=` من الرابط، ورُبطت الملاحظات السريرية حصرًا بسجل الزيارة المحفوظ (`?visitId=`) مع فصل «الطبيب المعالج» عن «طُبعت بواسطة» دون بادئة `د.` الثابتة؛ وفي `app/print/card/[id]/page.tsx` صُحّح `<PrintButton docType="statement" ... />` إلى `<PrintButton />` دون لمس `app/api/print-log/route.ts` أو إنشاء سجل طباعة موازٍ للروشتات؛ وفي `app/print/patient-card/[id]/page.tsx` فُرض `canAccessPatient` قبل `getPatient` وحُدّث نص البوابة إلى الحساب المفعّل.
   - **مرفقات `F-05` وتنسيق النسخ الاحتياطي مع كلاود**: في `app/api/messages/file/[id]/route.ts` و`app/api/messages/voice/[id]/route.ts` يُفحص `getMessageAttachmentMeta` والصلاحية قبل تحميل البايتات، وتُفرض قائمة بيضاء صارمة لـ `Content-Type` و`Content-Disposition` فيها وفي `app/api/documents/[id]/route.ts` و`app/api/expense-attachments/[id]/route.ts`. **تنبيه تكامل عند دمج مصروفات كلاود (`0128+`)**: إذا أُضيف جدول مستقل لمرفقات مصروفات المركز (`clinic_expense_attachments`) على القرص نفسه، يجب إلحاقه بـ `UNION ALL` في `lib/fullBackup.ts` (`readDocumentMetadata`) و`lib/db.ts` (`resetClinicData`).
   - **عزل أدوات المساعد الذكي (`lib/ai-tools/*`)**: إغلاق آمن (`Fail-Closed`) للأطباء المقيدين غير المربوطين بجهة طبيب نشطة (`doctorPartyId = null`)، ومنع استبدال `doctorPartyId` بـ `userId` في تقارير العمولات، وفرض `canAccessPatient` قبل `getPatient` في أدوات صياغة النماذج والرعاية، وفرض `canViewXrays` في ملخص السيفالومتري.
   - `lib/portal.ts` و`lib/portal-security.ts`: دُمج بالفعل قيد فرع كلاود `33175cbe` لإبطال كوكي البوابة فور تعديل `patient_number` (`row.patient_number !== payload.patientNumber`) وسقف `patientNumber.length > 21`. وعند الدمج مع فرع التقويم `d61254fa` يُحتفظ بسطرَي إعادة التصدير `export { INTAKE_CONDITIONS, type IntakeAnswers } from "./portal-intake-fields"` في `lib/portal.ts`.
   - المقارنة مع أعمال دوت في الصيانة: لم نلمس `lib/money.ts` (تقريب المبالغ) ولا `lib/restore/` أو `scripts/restore-full.ts`؛ وفي `/api/book` جمعنا بين الفحص المبدئي المتزامن قبل لمس القاعدة، وحد الهاتف المطبّع (`6 / 15m`)، وحد المصدر الموثوق لـ CGNAT (`30 / 15m` مع `TRUST_PROXY=true`)، والسقف الاحتياطي العام (`120 / 15m` بدون `TRUST_PROXY`)؛ وفي `lib/xlsx-reader.ts` أضفنا القطع التدفقي المباشر داخل `browserInflateRaw` (`16 MB` لكل ملف و`32 MB` إجماليًا و`100,000` صف).

## 4. تعطيل تفعيل البوابة افتراضيًا والقرارات المعروضة لاعتماد المالك (2026-11-14)

- **التفعيل معطّل افتراضيًا (`PATIENT_PORTAL_ACTIVATION_ENABLED` غير مفعّل -> `503 Fail-Closed`)**:
  - يرفض النظام افتراضيًا إصدار روابط التفعيل (`issuePortalActivation`)، وروابط الاستعادة (`issuePortalPasswordReset`)، واستهلاكها (`inspectPortalActionToken` / `redeemPortalActionToken`)، وإعادة تمكين الحسابات (`action: 'enable'`) بـ `503` (`portal_activation_disabled_pending_policy`) حتى يعتمد المالك السياسات أدناه صراحةً.
  - يبقى إيقاف الدخول القديم بالهاتف ورقم الملف (`403`)، وتعطيل الحساب الطارئ (`disable`)، وإبطال الجلسات الفوري (`revoke_sessions`) فعّالًا في كل الأوقات.
- **إبطال رابط واحد مقابل جميع الروابط المفتوحة**: إصدار رابط جديد أو استهلاكه أو تغيير الهاتف أو التعطيل أو الدمج يبطل **جميع** الروابط المفتوحة للمريض؛ بينما يبطل فشل الإرسال عبر المزود ذلك الرابط الفاشل وحده (`delivery_failed`).
- **السياسات غير المحسومة بعد — الخيارات والتوصية الهندسية لكلٍّ منها**:
  1. **سياسة تغيير رقم الهاتف عند استعادة الحساب (`PORTAL_RECOVERY_PHONE_POLICY`)**:
     - *الخيار أ1 (`disallow_inline` — الوضع الافتراضي الحالي)*: منع تعديل رقم الهاتف ضمن عملية استعادة البوابة (`409 phone_change_policy_pending`)؛ يُعدَّل الهاتف عبر مسار ملف المريض المستقل، أو يُسلَّم رابط الاستعادة حضوريًا.
     - *الخيار أ2 (`admin_or_owner_only` — **التوصية الهندسية**)*: السماح بتحديث الهاتف أثناء الاستعادة الحضورية للمالك أو الإدارة (`admin`) فقط بعد التحقق الحضوري من الوثيقة الرسمية وملاحظة تدقيق `>= 8` أحرف، ومنع الاستقبال من تعديل الهاتف ضمن الاستعادة (`403`). يجمع هذا الخيار بين منع اختطاف الحساب عبر شريحة جديدة على شباك الاستقبال وبين حل حالة فقدان المريض لهاتفه القديم.
     - *الخيار أ3 (`portal_manager_in_person`)*: السماح لأي موظف مفوّض بـ `canManagePortal` + `patients.edit` بتحديث الهاتف حضوريًا مع ملاحظة تحقق موثّقة.
  2. **سياسة مدد صلاحية الروابط المؤقتة أحادية الاستخدام (`PORTAL_ACTIVATION_TTL_MINUTES` / `PORTAL_RESET_TTL_MINUTES` / `PORTAL_IN_PERSON_RESET_TTL_MINUTES`)**:
     - *الخيار ب1 (نافذة قصيرة متشددة)*: `30` دقيقة للتفعيل، و`15` دقيقة للاستعادة عبر الرسائل، و`10` دقائق للتسليم الحضوري المباشر.
     - *الخيار ب2 (نافذة متوازنة — **التوصية الهندسية**)*: `60` دقيقة للتفعيل، و`30` دقيقة للاستعادة عبر الرسائل، و`15` دقيقة للتسليم الحضوري المباشر (تمنح المريض وقتًا كافيًا لإتمام تعيين كلمة المرور بعد مغادرة الشباك دون إبقاء الرابط حيًّا لساعات).
     - *الخيار ب3 (نافذة ممتدة)*: `240` دقيقة (4 ساعات) للتفعيل، و`60` دقيقة للاستعادة عبر الرسائل، و`15` دقيقة للتسليم الحضوري المباشر.
  3. **سياسة مصير حساب البوابة بعد دمج ملفات المرضى (`PORTAL_POST_MERGE_TARGET_POLICY`)**:
     - *الخيار ج1 (`suspend_target` — الوضع الافتراضي الحالي و**التوصية الهندسية**)*: حذف حساب ورموز الملف المصدر، و**تعليق حساب الملف الهدف (`status = 'disabled'`)** مع إبطال جميع جلساته وروابطه المفتوحة ريثما يتحقق الموظف من أن الدمج تم لنفس الشخص الفعلي (وليس لفردي عائلة اشتركا في الهاتف سابقًا) ثم يعيد تمكينه بوعي.
     - *الخيار ج2 (`keep_target_revoke_sessions`)*: حذف حساب ورموز المصدر، وإبطال جلسات وروابط الهدف مع إبقاء حساب الهدف `active` ليتمكن من إعادة تسجيل الدخول مباشرةً بكلمة مروره الحالية.
  4. **سياسة الاحتفاظ بسجلات ومرفقات الرسائل المحذوفة**:
     - الوضع الحالي المطبّق: الاحتفاظ الكامل بالنص والصوت والمرفق في جدول `messages` بلا أي إتلاف تلقائي، مع حجبها عن الواجهة وعن روابط التنزيل وقصر معاينة العهدة على الإدارة النشطة ذات النطاق الكامل بسبب مكتوب مسجّل في `audit_log`، ريثما يعتمد المالك مدة الاحتفاظ القانونية/الطبية وآلية الأرشفة أو الإتلاف النهائي.
