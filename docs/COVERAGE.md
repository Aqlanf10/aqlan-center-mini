# مصفوفة تغطية التنفيذ — خريطة الدستور إلى الكود

> هذه المصفوفة تربط بنود [`CONSTITUTION.md`](./CONSTITUTION.md) (الدستور الرسمي)
> بمواضعها الفعلية في الكود، وتُحدَّث مع كل مرحلة. الحالة: 🟢 منفَّذ · 🟡 جزئي ·
> 🔴 لم يبدأ · ⚪ لا ينطبق بعد. آخر فحص: فرع `feat/ceph-phase2-foundation` — الأساس
> السريري الموسّع (٣٣ قياسًا + مجموعات مرجعية Z + تشخيص منظم + بيانات دراسة) —
> typecheck ✅ · 275/275 اختبار ✅ · build ✅. **في انتظار المراجعة قبل الدمج.**

## 1. المناطق التشغيلية الست → الكود

| المنطقة | الوحدة | موضع الكود | الحالة |
|---|---|---|---|
| **A — التشغيل اليومي** | لوحة القيادة | `app/page.tsx` | 🟢 |
| | شاشة اليوم (Flow Board) | `lib/flow.ts` · `app/display/` (شاشة العرض الحية) | 🟢 |
| | جدول المواعيد + منع التضارب | `lib/schedule.ts` · `lib/booking.ts` · `app/appointments/` | 🟢 |
| | الكراسي والانتظار | `lib/flow.ts` (تسكين، عدّاد انتظار) | 🟢 |
| | الاستدعاء والمتابعة | `lib/recall.ts` · `lib/reminders.ts` · `app/recall/` | 🟢 |
| | الاتصالات/منع التكرار ١٢ ساعة | `lib/reminders.ts` · `__tests__/reminders.test.ts` | 🟢 |
| **B — المرضى والسريري** | سجل المرضى + كشف التكرار | `lib/patient.ts` · `lib/duplicates.ts` (هاتف مطبَّع + مطابقة أسماء عربية) | 🟢 |
| | ملف المريض الموحد بتبويباته | `app/patients/[id]/` (نظرة عامة، مخطط، خطة، حساب، مواعيد، زيارات، مستندات، تقويم) + حارس الهوية `verify:identity` | 🟢 |
| | مخطط FDI التفاعلي | `lib/dental.ts` · `components/DentalChart.tsx` · `app/api/patients/[id]/chart/` | 🟢 |
| | خطط العلاج السريرية | `lib/plans.ts` + `plan_items` + `app/api/plans/[id]/items/` (السعر من الدليل لحظة الاتفاق، الإجمالي مشتق) + `app/api/plans/[id]/consent/` (الموافقة تقفل الاتفاق) + شطب البنود بالزيارة | 🟢 |
| | الزيارات + التوقيع + Addendum | `lib/clinical.ts` · `components/ClinicalVisit.tsx` · `app/visits/[id]/` | 🟢 |
| | ملف التقويم المتخصص | `lib/ortho.ts` + `ortho_cases` + `ortho_adjustments` · `components/PatientOrtho.tsx` · `app/api/ortho/` (الأسلاك والشدّ والمثبّت) | 🟢 |
| | التحليل السيفالومتري | `lib/ceph.ts` (معايرة مليمترية + ٢٠ معلمًا إلزاميها ١٦ + ٣٣ قياسًا: Steiner/Downs/Tweed/Wits/McNamara — زاويتا التحدب وA-B موقّعتان كما نشرها Downs وL1-OP مقدارًا عن العمود ومعايير McNamara ١٩٨٤ المنشورة + نظام مجموعات مرجعية بدرجة Z + تشخيص منظم يقترح ويُعتمد) + `ceph_analyses/landmarks/measurements/reference_sets/reference_values/diagnoses` · `components/CephTracer.tsx` · `app/ceph/[id]/` — معتمد يقفل، وتصحيحه نسخة جديدة، و`verify:ceph` | 🟢 |
| | الأشعة والمستندات السريرية | `lib/files.ts` + `lib/storage.ts` + `lib/tar.ts` + `patient_documents` · `components/PatientDocuments.tsx` · `app/api/documents/` — ملفات على القرص بعنونة محتوى sha256، والقاعدة وصف حصراً | 🟢 |
| | بوابة المريض (المرحلة ١١) | `lib/portal.ts` (جلسة موقّعة بمجال توقيع منفصل عن الطاقم + دخول هاتف×ملف بحدّ محاولات يُقرأ من التدقيق ببصمة الهاتف لا هاتفه + قواعد تأكيد حضور) · `patient_intake_forms` سجل يُضاف إليه · `appointments.patient_confirmed_at` · `app/portal/` + 7 مسارات API كلها تفحص الجلسة ولا تقبل معرّف مريض من العميل · كشف الحساب من `patientLedger()` حصرًا · `verify:portal` إثبات العزل ومصدر الحقيقة | 🟢 |
| **C — المالية والخزينة** | ورديات الكاشير | `app/api/shifts/` · جدول الورديات | 🟢 |
| | سندات القبض (Append-Only) | `app/api/payments/` · `app/print/receipt/` | 🟢 |
| | سندات الصرف | `lib/expenses.ts` · `app/print/voucher/` | 🟢 |
| | دفتر أستاذ المريض (مصدر وحيد) | `patientLedger()` في `lib/db.ts` — تستدعيه الشاشة والكشف المطبوع والتحقق | 🟢 |
| | عمولات الأطباء | `lib/commission.ts` · `app/finance/commissions/` | 🟢 |
| | دليل الخدمات الموحد | `app/finance/services/` · `app/api/services/` | 🟢 |
| **D — المعامل والموردون** | طلبيات المعامل + استحقاق آلي | `lib/lab.ts` · `app/lab/` | 🟢 |
| | الموردون والذمم | `app/finance/parties/` · `app/api/parties/` · `app/api/payables/` | 🟢 |
| | المخزون وحركات المواد | `lib/inventory.ts` + `inventory_items/movements` · `app/inventory/` · `app/api/inventory/` — الرصيد اشتقاق رياضي من الحركات (لا عمود رصيد)، لا صرف يتجاوز بقفل صف البند داخل المعاملة، تسوية بلا سبب موثق مرفوضة، دفعات صلاحية تُستهلك FEFO وتنبيهات حد الطلب والانتهاء، و`verify:inventory` | 🟢 |
| **E — الإدارة والرقابة** | التقارير الموحدة | `lib/report.ts` · `app/report/` · `app/finance/reports/` | 🟢 |
| | سجل التدقيق غير القابل للحذف | `lib/audit.ts` · `app/settings/audit/` · مشغّلات القاعدة في `lib/db.ts` | 🟢 |
| | النسخ الاحتياطي + فحص السلامة | `lib/backup.ts` · `scripts/backup.mjs` · `scripts/verify-backup.mjs` · `app/api/backup/` | 🟢 |
| | غرفة قيادة المالك (KPIs) | `lib/executive.ts` (ExecutiveKPIAggregation — المال من ميزان المراجعة وقائمة الدخل حصرًا: إيراد/خصم/مصروفات/ربح + حركة الصندوق بالعملة + ذمم الدفاتر + إشغال كراسي على أيام عمل فعلية) + `executiveKpis()` في `lib/db.ts` · `app/executive/` · `app/api/executive/` (للمدير وحده) · تصدير CSV من الكائن نفسه (DomainReportingService) · `verify:executive` إثبات المطابقة ١٠٠٪ مقابل مستندات خام | 🟢 |
| **F — الإعدادات والتهيئة** | المستخدمون والأدوار | `lib/auth.ts` · `lib/roles.ts` · `app/settings/users/` | 🟢 |
| | الترقيم التسلسلي الذري | سلاسل `patient/invoice/receipt/voucher_number_seq` في `lib/db.ts` | 🟢 |
| | قوالب الطباعة + علامة إعادة الطباعة | `app/print/*` · جدول `document_prints` · `app/api/print-log/` | 🟢 |

## 2. النطاقات الاثنا عشر → الجداول والمكتبات

| # | النطاق | التنفيذ الفعلي | الحالة |
|---|---|---|---|
| 1 | Patient | `patients` + `patient_opening_balances` · `lib/patient.ts` · `lib/duplicates.ts` | 🟢 |
| 2 | Scheduling | `appointments` · `lib/schedule.ts` · `lib/booking.ts` · `lib/flow.ts` · طلبات الحجز `app/api/booking-requests/` | 🟢 |
| 3 | Clinical | `visits` (أعمدة سريرية + توقيع + ملحق) · `visit_procedures` · `tooth_conditions` (سجل زمني يُضاف إليه) | 🟢 |
| 4 | Treatment Planning | `treatment_plans` + `plan_items` (بنود مسعّرة من الدليل، موافقة تقفل، شطب بالزيارة) + `plan_installments` (أقساط) · `lib/plans.ts` | 🟢 |
| 5 | Ortho | `ortho_cases` + `ortho_adjustments` · `lib/ortho.ts` · `components/PatientOrtho.tsx` · `app/api/ortho/` | 🟢 |
| 6 | Imaging | `patient_documents` + `ceph_analyses`/`ceph_landmarks`/`ceph_measurements` · `lib/files.ts`/`storage.ts`/`tar.ts`/`ceph.ts` | 🟢 |
| 7 | Billing | `invoices` (تولَّد من توقيع الزيارة في معاملة واحدة) · `patientLedger()` | 🟢 |
| 8 | Treasury | ورديات + `payments` + `expenses` + عزل عملات `lib/fx.ts` | 🟢 |
| 9 | Accounting | `lib/accounting.ts` (قيد مزدوج + إقفال فترات) · `app/finance/accounting/` | 🟢 |
| 10 | Payables | `parties` (معامل وموردون) + `app/api/payables/` | 🟢 |
| 11 | Inventory | `lib/inventory.ts` + `inventory_items/inventory_movements` (رصيد اشتقاقي بلا عمود، قفل صف البند، تسوية موثقة، FEFO) · `app/inventory/` · `app/api/inventory/` · `verify:inventory` | 🟢 |
| 12 | Identity & Governance | `users` + جلسات scrypt موقّعة · `lib/roles.ts` · `audit_log` بمشغّلات عدم مساس | 🟢 |

## 3. المراحل الأربع عشرة

| المرحلة | الحالة | ملاحظة |
|---|---|---|
| 0 · الأساس | 🟢 | أمان + صلاحيات + تدقيق + نسخ + فحوص تحقق |
| 1 · النواة التشغيلية | 🟢 | الرحلة من الحجز إلى الكرسي تعمل |
| 2 · السجل السريري | 🟢 | مخطط FDI + الزيارة الموقَّعة + «خطة ← موافقة ← زيارة ← استحقاق» في معاملة واحدة + ملف موحّد بتبويباته |
| 3 · المالية الصارمة | 🟢 | دفتر وحيد، عكس لا حذف، عزل عملات، وردية إلزامية |
| 4 · المعامل والموردون | 🟢 | استلام المعمل يولّد استحقاقاً آلياً |
| 5 · العمولات | 🟢 | من قواعد الطبيب + دليل الخدمات، بصرف سندات |
| 6 · المحاسبة | 🟢 | قيد مزدوج + إقفال فترات |
| 7 · التقويم | 🟢 | الحالة والأسلاك وزيارات الشدّ والمثبّت |
| 8 · السيفالو والأشعة | 🟢 | معايرة مليمترية مثبتة بالاختبار، قياسات من معالم معتمدة، الاعتماد يقفل والتصحيح بنسخة |
| 9 · المخزون | 🟢 | الاشتقاق الرياضي من الحركات + توثيق سبب كل تسوية — بمعياري القبول نصًّا |
| 10 · التحليلات وغرفة القيادة | 🟢 | المؤشرات المالية من دفاتر الأستاذ حصرًا (ميزان + قائمة دخل — لا إعادة جمع) · ذمم الدفاتر · إشغال كراسي على أيام العمل الفعلية · تصدير CSV من الكائن نفسه · `verify:executive` يُثبت المطابقة ١٠٠٪ بالحساب المستقل — بمعيار القبول نصًّا |
| 11 · بوابة المريض | 🟢 | عزل توقيعي كامل (مجال منفصل، كوكي آخر، لا توكن يعبر الاتجاهين) · دخول هاتف×ملف بحدّ محاولات · كشف الحساب من `patientLedger()` حصرًا (مصدر الحقيقة نفسه) · مواعيد وتأكيد حضور وملكيته في SQL · استمارة صحية سجل يُضاف إليه وتُدقَّق — بمعياري القبول نصًّا |
| 12 · PWA والجوال | 🟢 | لا مستودع ثانٍ ولا API مكرر — النظام نفسه قابل للتثبيت: `app/manifest.ts` (standalone بلا شريط روابط، اسم المركز من الإعدادات) + أيقونات مشتقة من `app/icon.svg` بـ sharp (`scripts/gen-pwa-icons.mjs`) + عامل خدمة لا يخزّن استجابة API أبدًا (الأرقام حيّة أو غائبة) + صفحة انقطاع صادقة + زر تثبيت في الإعدادات — معيار القبول نصًّا |
| 13 · الخدمات الذكية | 🟡 | الأساس مبني بلا وظائف وهمية: شاشة إعدادات (`/settings/ai`) يُدخل فيها المالك مفتاح خدمته فيُخزَّن مشفَّراً AES-256-GCM (`lib/secretbox.ts` مشتق من SESSION_SECRET) ولا يعود من أي قراءة إلا بصمة مُقنَّعة · اختبار اتصال حقيقي قبل الحفظ وبعده يُثبَّت نتيجته · حارس خصوصية (`sanitizeForPrivacy`) يمنع هوية المرضى الصريحة من الخروج · `lib/ai.ts` صاحب المجال الوحيد ببروتوكول OpenAI-compatible (Z.ai/OpenAI/مخصص) · تدقيق `ai.settings.update`/`ai.test`/`ai.suggest` · الوحدات الذكية فوق هذا الأساس تُبنى بعد المعايرة الأولى من المالك — **يقترح ولا يعتمد** نصاً |

> **انحراف مسجَّل ومبرَّر:** نُفِّذت ٣ و٤ و٥ و٦ قبل إكمال ٢ (بُنيت قبل اعتماد الدستور؛
> إعادة ترتيبها = هدم ما يعمل ويُختبر). اكتملت لاحقاً ٢ و٧ مع تحديثات المالك — والتالي ٨ بحسب الترتيب.

## 4. الرحلة الذهبية — ١٤ محطة → مواضع التنفيذ

| المحطة | الموضع | الحالة |
|---|---|---|
| 1 استفسار وكشف تكرار | `lib/duplicates.ts` (بحث هاتف مطبَّع + أسماء متشابهة) | 🟢 |
| 2 تسجيل برقم دائم | `lib/patient.ts` + سلسلة `patient_number_seq` (P-000001) | 🟢 |
| 3 حجز بلا تضارب | `lib/schedule.ts` · `lib/booking.ts` | 🟢 |
| 4 تأكيد وتذكير | `lib/reminders.ts` (+ منع تكرار الرسالة ١٢ ساعة) | 🟢 |
| 5 وصول بنقرة | `lib/flow.ts` (شاشة اليوم) | 🟢 |
| 6 تسكين كرسي | `lib/flow.ts` (كرسي شاغر حصراً + عدّاد انتظار) | 🟢 |
| 7-8 زيارة وتشخيص ومخطط | `app/visits/[id]/` · `lib/dental.ts` · `lib/clinical.ts` | 🟢 |
| 9 خطة وموافقة | `app/api/plans/[id]/items/` + `consent/` — بنود من الدليل، موافقة تقفل الاتفاق وتنقل البنود للمخطط مخطّطة | 🟢 |
| 10 تنفيذ وإغلاق موقّع | `lib/clinical.ts` (توقيع يقفل الزيارة؛ التعديل ملحق) | 🟢 |
| 11 استحقاق تلقائي | التوقيع يولّد الفاتورة ويحدّث المخطط **في معاملة واحدة** — يثبتها `scripts/verify-clinical.mjs` | 🟢 |
| 12 قبض وسند | `app/api/payments/` (وردية إلزامية) · `app/print/receipt/` | 🟢 |
| 13 موعد قادم/استدعاء | `lib/recall.ts` | 🟢 |
| 14 متابعة | `lib/reminders.ts` · `app/recall/` | 🟢 |

## 5. المحظورات العشرة → الدليل

| # | المحظور | الدليل في الكود | الحالة |
|---|---|---|---|
| 1 | Module قبل البحث في النواة | الزيارة السريرية أعمدة على `visits` لا جدول موازٍ (تعليق `lib/db.ts` يوثق القرار) | 🟢 |
| 2 | تكرار حساب الأرصدة | `patientLedger()` واحدة: `app/api/patients/[id]/ledger/` + `app/print/statement/` + `verify-clinical` | 🟢 |
| 3 | دمج العملات | `lib/fx.ts` (سعر منسوخ لحظة الحركة، للمقارنة التقاريرية فقط) · `lib/money.ts` | 🟢 |
| 4 | تعديل سريري صامت | `visits.signed_at/signed_by` + عمود `addendum`؛ الموقَّعة لا تُعدَّل إلا بملحق | 🟢 |
| 5 | تعديل حركة مالية | لا `DELETE FROM invoices/payments/expenses` في الكود؛ `UPDATE invoices` للحالة فقط مع حارس `status <> 'cancelled'` | 🟢 |
| 6 | فاصلة عائمة | كل المبالغ `BIGINT` بوحدات صغرى (`*_minor`) — العائمة في العرض فقط | 🟢 |
| 7 | `MAX(id)+1` | سلاسل `*_number_seq` + مواءمة للأمام فقط (`GREATEST`) + `scripts/verify-concurrency.mjs` يثبتها | 🟢 |
| 8 | Blobs صور في PostgreSQL | `lib/storage.ts`: ملف على القرص بعنونة محتوى sha256 + وصف في القاعدة — `verify:documents` يشترط لا `bytea` في أعمدة الجدول | 🟢 |
| 9 | اعتماد آلي للذكاء | لا اعتماد آلي بأي شكل: الخدمة تُضبط من `/settings/ai` بيد المدير وحده، مخرجها «اقتراح» يعرض على الطبيب ويُسجَّل بـ `ai.suggest`، والاعتماد بيد الطبيب حصراً — حارس الخصوصية يمنع هوية المرضى من الخروج | 🟢 |
| 10 | منطق أعمال في React | المنطق في `lib/` مُختبَراً (269 اختباراً)؛ بقايا تجميع عرضي في أربع شاشات قيد التنظيف | 🟡 |

**ضمانات إضافية فوق النص:**
- `audit_log` محمي بمشغّلي `BEFORE UPDATE/DELETE` في القاعدة نفسها ترفض أي اتصال مباشر — `scripts/verify-audit.mjs` يحاول الكتابة ويشترط الفشل.
- `tooth_conditions` سجل زمني يُضاف إليه لا حقل يُكتب فوقه — تاريخ السن كامل (متى تسوّس، متى حُشي، من سجّل).
- `document_prints` يسجّل كل طباعة؛ الطبعة الثانية تحمل «نسخة معاد طباعتها».
- `scripts/verify-schema.mjs` يفحص مصدر الحقيقة للمخطط، و`scripts/verify-backup.mjs` يفحص سلامة النسخة لا وجودها.
- **من تحديثات المالك:** `verify:plans` (قفل الموافقة بعد التوقيع) · `verify:identity` (لا ملف ثانٍ ولا دمج بالاسم) · `verify:documents` (لا bytea) · `verify:ortho` (حالة مفتوحة واحدة، سلك لا يفارق سجله) — ورحلات Playwright يدوية `scripts/journeys/` تثبت أن الشاشة توصل المنطق.
- **السيفالومتري:** `verify:ceph` على قاعدة مؤقتة — يثبت رفض الاعتماد ناقصًا، ومطابقة اللقطة للقيم المشتقة يدويًا، وقفل المعتمد، والنسخة للتصحيح، وشهادة التدقيق للدورة كاملة.
- **Volume إلزامي للأشعة:** `DOCUMENTS_DIR` على قرص دائم (Railway Volume على `/data`) — الرفع يُرفض بلا تخزين دائم عمداً.

## 6. الانحرافات المسجّلة عن النص الرسمي

| البند | النص | المنفَّذ | السبب |
|---|---|---|---|
| مقاس سند القبض | A5 | A6 | قرار صريح من المالك («ما نخسر ورق كثير») — يُغيَّر بكلمة منه |
| ترتيب المراحل | 2 قبل 3-6 | 3-6 قبل إكمال 2، ثم اكتملت ٢ و٧ و٨ | بُنيت قبل اعتماد الدستور؛ الهدم أضرّ من الانحراف — والترتيب من هنا ملتزم |
| التقنية | لا يفرض إطاراً | Next.js + pg مباشرة + scrypt موقّعة | يخدم المحظور ٧ وأرقام مستندات ذات معنى للمراجع |
