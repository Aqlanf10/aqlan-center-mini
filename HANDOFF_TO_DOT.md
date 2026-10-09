# HANDOFF_TO_DOT — ORTHO-ID: Ceph correction lineage + ortho bridge identity

**الحالة: Draft — غير جاهز للدمج.** لم تنتهِ CI على الـhead الحالي (انظر الجدول). المجموعة الكاملة PostgreSQL والبناء نجحا محليًا. لا دمج ولا نشر ولا Railway.

- الفرع: `claude/ortho-case-identity-lineage`
- base SHA: `e19aa30f4d67f65a5890d2db149abb86895b4187` (main، بعد دمج #294)
- head SHA: `c5259e203b850c2319780ce10cb63c3d395cfef2` (commit الشفرة؛ يليه commit يحدّث هذا الملف فقط)
- PR: https://github.com/Aqlanf10/aqlan-center-mini/pull/314 (Draft)

## ما أُنجز (مثبت بإخفاق على main قبل الإصلاح)
`__tests__/postgres/ortho-case-identity.test.ts` (11 اختبارًا؛ 9 فشلت على main النظيف، والباقيان ضابطان):
1. **تصحيح دراسة Ceph** (`duplicateCephAnalysis`، `lib/db.ts`): كان يُسقط `ortho_case_id` و`phase` و`xray_date` و`device` و`ref_set` و`study_kind` فتعود T2/T3 إلى `pretreatment` بلا حالة. الآن تُنسخ كلها (DATE يُقرأ نصًا لتفادي إزاحة اليوم). المعتمد الأصلي لم يتغير (مثبت).
2. **baseline بعد اتفاق تاريخي** (`recordOrthoBaseline`): كان يترك حالتين (shell الاتفاق + ortho غير مجسورة) ويقبل نطاق فك مختلفًا. الآن يستعمل دالة التجسير نفسها `bridgeOrthoShell` (استُخرجت من `createOrthoCase` دون تغيير سلوكه)، ويقفل صف المريض، ويرفض بـ`bridge_conflict` (409 عربي، يتراجع كل شيء) عند نطاق مختلف/أكثر من shell.
3. **نطاق الفك في الجسر العام**: `createClinicalCase` مع `orthoCaseId` يشتق `site` من `ortho_cases.arches` بدل `null`/نص حر.
- ضوابط خضراء: baseline ثم legacy، سباق baseline مزدوج، فاتورة تقويم بعد جسر (لا حالة ثانية على main أيضًا — لم يثبت عيب هناك).

## ما لم يُنجز / يحتاج قرارًا
- **مؤشر الأصل (supersedes) لدراسة Ceph**: لا عمود بنيوي اليوم (النص في `note` فقط). يحتاج هجرة → **رقم هجرة محجوز من dot**. لم أخمّن رقمًا. ملاحظة: **0044 محجوز مرتين** في PRs مفتوحة (#301 `0044_invoice_admin_discount_lines`، #308 `0044_hr_staff`).
- ربط T1 السابقة للحالة باختيار صريح (لا endpoint اليوم؛ المعتمد غير قابل للتعديل — يحتاج تصميمًا: عمود null→case مرة واحدة مع تدقيق أو جدول ربط).
- التحقق الخادمي من (الصورة/الدراسة/الزيارة) وقيود idempotency للنسخ (النسخ المزدوج محمي حاليًا بفهرس المسودة الواحدة).
- لم أبدأ: رحلة الحالة، المثبّت، snapshot/PPTX/PDF. لم أرسل خطة الملفات لـdot (لا جلسة dot متاحة من هذه الجلسة) — الملفات المشتركة التي لمستها: `lib/db.ts` (ثلاث مناطق ضيقة: `bridgeOrthoShell`/`createOrthoCase`، `recordOrthoBaseline`، `createClinicalCase`، `duplicateCephAnalysis`) و`app/api/ortho/baseline/route.ts` (سطر رسالة).
- PRs المفتوحة وقت الفحص: #311 #310 #309 #308 #302 #301 #291 #285 #278 #47 (كلها Draft عدا #285/#278). حالة التحقق منها: قرأتها من GitHub فقط، لم أفحص كودها. #294 مدمج (HEAD = e19aa30).

## الملفات
`lib/db.ts`، `app/api/ortho/baseline/route.ts`، `__tests__/postgres/ortho-case-identity.test.ts`، `__tests__/ortho-baseline-route.test.ts`، هذا الملف. **لا هجرات، لا تغيير مخطط، لا أثر مالي** (الاختبارات تتحقق أن فواتير/دفعات/رصيد افتتاحي لا تتغير بالتجسير).

## الاختبارات (محلي، PostgreSQL 18.4 اصطناعي معزول على 127.0.0.1:54329، لا Railway)
أُضيف بطلب dot: تصحيح من حالة قديمة مغلقة مع حالة نشطة أخرى؛ مرجع Ceph غير افتراضي؛ تعدد shells (الاختبار يقبل أن تمنعه القاعدة نفسها)؛ تراجع كامل عند فشل التدقيق بعد الربط (مُشغّل اصطناعي يُزال بعدها)؛ سباق baseline مع الاتفاق التاريخي (4 جولات)؛ واختبار المسار `__tests__/ortho-baseline-route.test.ts` (401/403/409/500/201، رسائل عربية بلا تسريب).

| الأمر | النتيجة |
|---|---|
| `tsc --noEmit` | نظيف |
| `eslint` للملفات المغيَّرة/الجديدة | 0 أخطاء (تحذيرات قديمة فقط) |
| `npx vitest run` (وحدات) على 2c99bc1 | 465 ملفًا / 8309 ناجحة. ثم أُضيف ملف المسار (8 ناجحة)؛ لم أعد تشغيل الوحدات كاملة بعد الإضافة |
| `test:postgres` كاملة على 2c99bc1 (بلا SESSION_SECRET) | 161 ملفًا ناجحة؛ فشل `messaging-channels` (2) لغياب `SESSION_SECRET` عندي فقط، و4 ملفات ترفض قاعدة فيها مخطط بحكم الحارس |
| `messaging-channels` + `ortho-case-identity` (الموسَّع، 24 اختبارًا) بـ`SESSION_SECRET`/`CLINIC_TIME_ZONE` كـCI | ناجحة |
| الملفات الأربعة (expense-category-history-containment 48، expense-void-close-race 8، manual-cash-containment 20، payment-shift-admission 18) كلٌّ على قاعدة `aqlan_p1_test` فارغة جديدة | ناجحة 94/94 |
| `scan:money`، `ci:scan:body` | ناجحان |
| `verify:ci` | 7/20 نجحت و13 تُخطّيت (تحتاج قاعدة فعلية) |
| `npm run build` | ناجح |
| `ortho-case-identity` على main قبل الإصلاح | 9 من 11 فشلت (إثبات) |
| **لم تُشغَّل:** `test:security-http`، `schema:ownership:verify`، `db:baseline:manifest*`، `ci:audit`، `build:preflight`، `verify-braces-runtime` | CI فقط |
| CI على 2c99bc1 | كان `in_progress` وقت الرفع؛ أُلغي بـ push هذا الـcommit (concurrency). نتيجته غير معلومة. CI على الـhead الجديد يجب أن يُنتظر |

## الخطوة التالية الدقيقة
1. شغّل CI على الـhead وPG الكاملة؛ راجع أن `ortho.plan_link` الجديد من baseline مقبول (يُدقَّق بنفس إجراء createOrthoCase).
2. احجز رقم هجرة ثم أضف `corrects_analysis_id` (إضافي، nullable) إلى `ceph_analyses` واملأه في `duplicateCephAnalysis` وأضف اختبار المؤشر.
3. قرّر تصميم ربط T1 السابقة.
4. إن أردت PR أصغر: افصل إصلاح Ceph (دالة واحدة + أول اختبار) عن التجسير.

## قيود البيئة
PG 18.4 من حزمة `@embedded-postgres/linux-x64` مثبّتة خارج المستودع (`/opt/pg18`)؛ لا شيء منها في الشجرة. لا أسرار ولا بيانات مرضى في الأدلة.
