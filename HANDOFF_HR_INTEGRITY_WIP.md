# HANDOFF (WIP) — HR payroll integrity on PR #308 — لكودكس / dot

**الحالة: عمل غير مكتمل (WIP). الفرع أحمر عمدًا عند هذا الرأس (اختبارات حمراء مثبتة + مخطط مضاف بلا منطق).** لا دمج ولا نشر.

- الفرع: `feat/hr-staff-tasks-phase1` (PR #308). القاعدة: رأس dot المراجَع `895500c9`، ودُمج `main` (1878cf92) بدمج عادي `f044a008` بلا تعارض.
- لا فروع مكررة ولا force-push. الكاتب السابق توقف (آخر دفع له 06:54 +03).

## ما أُنجز
1. اختبارات حمراء تثبت العيوب: `__tests__/postgres/hr-payroll-integrity.test.ts` (30 اختبارًا، 27 فاشلة على 895500c9، يجهّز كل اختبار حالته بنفسه).
2. هجرة إضافية مقترحة **0050** `migrations/0050_hr_payroll_integrity.sql` = `lib/hr-payroll-integrity-schema.ts` (HR_PAYROLL_INTEGRITY_SQL) ومنفَّذة في `ensureSchema`. الرقم **بانتظار تأكيد dot** (0044 خصم، 0047 سيفالو محجوزان). ملاحظة: يلزم إضافة عمود `hr_staff.payroll_party_id` (مقرَّر ولم يُكتب) إن اعتُمد التصميم.
3. `lib/hr-pay-terms.ts`: محلّل شروط الأجر النقي (`resolvePayTerms`) + قارئ العقود — غير موصول بالمسير بعد.
4. تحديث الحراس لسلسلة 0050: migrations.ts، verify-schema-ownership، _periodontal-fixture، legacy-treatment-coverage-schema، docs/DATABASE_MIGRATIONS.md.

## العيوب المثبتة على 895500c9
- `commissionReport` يُستدعى بكائنات Date فتقارن النصوص خطأً ⇒ **عمولة المسير صفر دائمًا** (وتواريخ الفترة في الواجهة نصوص Date خام). الحل: اختيار `start_date::text`.
- المسير يقرأ الأجر من hr_staff ويتجاهل العقد؛ لا مزامنة عند التفعيل؛ الدورية غير الشهرية تُحتسب شهرية؛ تاريخ سريان الأجر والالتحاق/الانتهاء منتصف الفترة مهمَلة.
- صرف المختلط كله category=salary ⇒ كشف الطبيب لا يرى المدفوع.
- مفتاح الطلب: نفس المفتاح بمحتوى مختلف يعيد الأصل بصمت؛ السباق ينفجر بقيد فريد؛ الصرف الجماعي `Date.now()`؛ API/PayrollPanel لا يرسلان المفتاح، والواجهة ترسل مبلغًا بوحدات بشرية يقرؤه الخادم minor.
- لا عكس لسند صرف المسير؛ إقفال فترة بمتبقٍ مسموح؛ `createPayrollPeriod` يعدّل تواريخ فترة قائمة؛ مسار الصرف يسرّب `error.message`.
- `hr-payroll-financial.test.ts` يستعمل `payables.balance_minor` (غير موجود) ورسالة وردية خاطئة، ويخفي التعارض بتطابق القيم.

## التصميم المقرَّر (يُنفَّذ)
- العقد الفعّال/المعتمد هو مصدر الأجر؛ الملف احتياطي حين لا عقد؛ تفعيل عقد ساريّ الآن يزامن الملف (سجل hr_staff_changes)؛ `updateStaff` يرفض ما يخالف العقد الحاكم (409). التعارض القديم/تغيّر الأجر أثناء الفترة/دورية غير شهرية/التحاق جزئي/سريان بعد البداية ⇒ `blocker_codes` على البند ويُرفض الاعتماد (لا تخمين تقسيم). لقطة `pay_terms_snapshot` تثبت المصدر والمبلغ ولا تتأثر بتعديل لاحق.
- اعتماد المسير ينشئ التزامين: راتب (category=salary) وعمولة (category=commission) لجهة الطبيب. الصرف = سند لكل جزء عبر `recordExpenseInTx` (category من الجزء، party_id الطبيب، payable_id الجزء) داخل معاملة واحدة، مع جدول `hr_payroll_disbursement_parts`. الدفعة الجزئية بلا `components` صريح لجزأين مفتوحين ⇒ مرفوضة (سياسة غير محددة).
- حارس ازدواج الصرف: سقف العمولة = المستحق − المصروف عبر المسير − سندات commission المباشرة بعد `commission_basis_at` (باستثناء أجزاء المسير)؛ ومصالحة عند الاعتماد.
- المفتاح: قفل استشاري `pg_advisory_xact_lock` على المفتاح، بصمة محتوى، نفس المحتوى ⇒ الأصل (`replayed`)، محتوى مختلف ⇒ 409؛ `findDisbursementByRequestId` + GET للتحقق بعد انقطاع الرد؛ المفتاح ثابت في PayrollPanel (sessionStorage) ولا يُولَّد جديد تلقائيًا؛ الصرف الجماعي معاملة واحدة بمفاتيح مشتقة ثابتة.
- العكس: `reversePayrollDisbursement` عبر استخراج `voidExpenseInTx` من `voidExpense` (lib/db.ts) داخل معاملة HR، يتطلب وردية مفتوحة، idempotent.
- أخطاء مطبوعة `HrPayrollError(code,status,message عربي)` وبلا تسريب استثناءات في المسارات.

## تنبيهات تقنية
- `lib/db.ts`, `lib/hr.ts`, `lib/audit.ts`, `lib/http-permissions.ts`, `lib/migrations.ts` ملفات **CRLF**: حافظ على النهايات.
- شغّل اختبارات PG فرديًا بـ: `SESSION_SECRET=ci-placeholder-secret-0123456789abcdef CLINIC_TIME_ZONE=Asia/Aden TEST_DATABASE_URL=... npx vitest run --config vitest.config.postgres.mts <file>` على قاعدة PG18 فارغة، وإلا يتوقف الاستيراد بلا رسالة.
- تواريخ الاختبارات يجب أن تسبق «الآن» (عمولة بتاريخ مستقبلي لا تظهر).

## المتبقي (كله)
تنفيذ المنطق أعلاه في lib/hr-payroll.ts و hr.ts و hr-contracts-attendance.ts؛ المسارات (disburse/runs/periods + GET التحقق)؛ PayrollPanel (مفتاح ثابت، parseAmount، توزيع المختلط، العكس، عرض الحاجب)؛ إصلاح hr-payroll-financial.test.ts دون إضعاف (الرصيد من partyStatement)؛ توليد عقدي المخطط والإفصاح رسميًا من PG18 نظيفة ومقارنة مستقلة وفحص SCHEMA_DIAGNOSTIC_METADATA_INVALID؛ اختبارات النسخ/الاستعادة (معرّفات أنواع الإجازات، تسلسلات، نسخ بلا HR)؛ رحلات موظف براتب/طبيب بنسبة/مختلط من العقد للسداد والتقرير والطباعة 390/1280؛ الفحوص الكاملة (npm ci، tsc، lint، unit، PG، build، security-http، متصفح) وCI على الرأس النهائي؛ تحديث وصف #308.

## لم يُشغَّل
أي فحص كامل بعد الدمج؛ CI على هذا الرأس.

---
## البروموت لكودكس
> تولَّ إكمال PR #308 (`Aqlanf10/aqlan-center-mini`، الفرع `feat/hr-staff-tasks-phase1`) من الرأس المرفوع. اقرأ `HANDOFF_HR_INTEGRITY_WIP.md` أولًا ثم نفّذ «التصميم المقرَّر» و«المتبقي» بالترتيب، بادئًا بتشغيل `hr-payroll-integrity.test.ts` لرؤية الاختبارات الحمراء ثم إصلاح كل عيب حتى تخضر دون إضعاف أي اختبار أو حارس. لا تغيّر 0048/0049، ورقم 0050 يُؤكَّد مع dot. استعمل دمجًا عاديًا لـmain، بلا force-push ولا فرع مكرر. لا تلمس ملف المريض/السيفالو/CI/النشر. لا تدمج ولا تنشر، ولا تعلن «مكتمل» قبل نجاح CI على الرأس النهائي، وسلّم HANDOFF_TO_DOT.md محدّثًا.
