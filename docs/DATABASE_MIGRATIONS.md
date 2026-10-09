# نظام هجرات قاعدة البيانات المُرقَّمة (P1.1 + P1-FIX)

> **الحالة:** P0 مُدمج في `main` (bd9a399). هذا المستند يصف نظام الهجرات كما وُضع في P1
> (فرع `hardening/production-readiness-p1`) — لم يُشغَّل أي migration على قاعدة الإنتاج بعد.

## الفكرة في سطر واحد

تطوير المخطط انتقل من «DDL تراكميّ داخل `ensureSchema()` بلا رقم ولا بصمة» إلى
**هجرات ملفات SQL مُرقَّمة بشهادة SHA-256 تُطبَّق داخل معاملات**، مع خط أساس
يُعتمد على قاعدة الإنتاج القائمة **بلا تنفيذ ولا فقد بيانات** — بعد إثبات توافقها
معه بمجسّ قوي (P1-FIX-1)، وتحت قفل advisory يمنع المهاجرين المتزامنين (P1-FIX-2).

## البنية

```
migrations/
  0001_baseline_schema.sql                 ← خط الأساس: DDL + مزامنة عدادات الأعمال عبر setval
  0002_confirmation_claim_ttl_index.sql     ← فهرس تنظيف إقرارات AI المنتهية
  0003_payment_idempotency_and_reversal.sql ← مفتاح الإعادة ببصمة الطلب + رابط الردّ الجزئي
  0004_material_rate_history.sql            ← سجل نسب المواد الفعّال (TIMESTAMPTZ, append-only)
  0005_financial_append_only.sql            ← حرّاس UPDATE + DELETE للسجل المالي + رابط إبطال المصروف
  0006_appointment_lifecycle.sql             ← دورة حياة المواعيد وسجل الحالات
  0007_appointment_services_and_capacity.sql ← خدمات المواعيد وحجب المزوّد والسعة
  0008_appointment_chair_and_new_patient_snapshots.sql ← لقطات الكرسي/المريض الجديد
  0009_waiting_list.sql                      ← قائمة الانتظار
  0010_waiting_list_completion.sql           ← تفضيلات/مطالبات/سجل اتصال قائمة الانتظار
  0011_appointment_waiting_link.sql          ← ربط الموعد بقائمة الانتظار
  0012_doctor_commission_history.sql         ← سجل نسب عمولة الطبيب بوقت الحدث (P0-1)
  0013_supplier_payment_settlement.sql       ← لقطة تسوية سند المورد/المختبر + منع الزيادة (P0-2)
  0014_shift_close_expected_difference.sql   ← إغلاق الوردية: المتوقَّع والفرق والسبب (P1-3)
  0015_saved_reports.sql                     ← التقارير المحفوظة والمفضلة والقوالب المشتركة
  0016_finance_controls.sql                  ← سجل الأرصدة الافتتاحية + قيود CHECK للمال (P2-5/P2-9)
  0017_stock_supplier_link.sql               ← ربط شراء المخزون بالمورد والالتزام (P2-10)
  0018_patient_demographics.sql              ← تاريخ الميلاد وولي الأمر والرقم الوطني (P2-8)
  0019_audit_source.sql                      ← عنوان الجهاز والمتصفح في سجل التدقيق (P3-5)
  0020_expense_attachments.sql               ← مرفقات سندات الصرف append-only (P3-6)
  0021_patient_referrals.sql                 ← الإحالات الصادرة إلى الأخصائيين ونتيجتها (P3-8)
  0022_patient_referral_source.sql           ← من أين جاء المريض ومن أحاله (P3-8ب)
  0023_opening_balance_currency.sql          ← الرصيد الافتتاحي بعملته، والدفعة التي تسدّده (P1-5ب)
  0024_legacy_archive.sql                    ← أرشيف معالجات النظام القديم ودفعاته للقراءة (P1-5ج)
  0025_messaging_channels.sql                ← قنوات المراسلة (واتساب، الرسائل النصية، البريد) وسجل الرسائل (MSG-1)
  0026_visit_currency.sql                    ← عملة الزيارة وأسعار الدليل بالسعودي والدولار (DAY1)
  0027_medical_history.sql                   ← التاريخ الطبي المنظَّم (نسخ لا تُعدَّل) والعلامات الحيوية (PAT-2)
  0028_patient_identity.sql                  ← بريد المريض وقناته المفضّلة وصورته وأعلامه، وسجل موافقات التواصل (PAT-3)
  0029_planned_visit_interval.sql            ← فاصل الزيارة المخطَّطة بالأيام من قالب التخصص — لاقتراح موعد الجلسة التالية (SPEC-T4)
  0030_party_opening_balances.sql            ← الأرصدة الافتتاحية للمعامل والموردين (التزامٌ افتتاحي لا مصروف) وتصحيحاتها الإلحاقية والأرصدة المقدَّمة (FIA-1)
  0031_journal_line_currency.sql             ← عملة سطر القيد اليدوي (التاريخي = YER، وحدة إدخاله) والقيد اليدوي إلحاقيّ لا يُعدَّل ولا يُحذف (TD-REG-028)
  0032_specialty_cases.sql                   ← الحالات التخصصية (clinical_cases) وقائمة المشاكل وربط بنود الخطة بالحالة وأولويتها واعتمادياتها وسياق الزيارة (CASE-MODEL-1)
  0033_internal_referrals.sql                ← الإحالة الداخلية: امتداد patient_referrals (النوع، الطبيب المستقبِل، حالة سير العمل مربوطة بالحالة القديمة بقيد، روابط الحالة والبند والخدمة المطلوبة، خلاصة الإكمال) وappointments.referral_id (REF-1)
  0034_ortho_legacy_baseline.sql             ← الحالة التقويمية السابقة (قبل النظام) على ortho_cases: نوع اللقطة ووقتها والمطاطات والطبيب المسؤول والنظام المالي السابق والأهداف المتبقية — أعمدة قابلة للفراغ بلا تعبئة (CASE-1)
  0035_commission_case_overrides.sql         ← النسبة الخاصة بالحالة/الخطة لعمولة الطبيب — سجلٌّ إلحاقيّ (set/void يخلف سابقه) بحارس يرفض التعديل والحذف (COMM-DETAIL-1)
  0036_visit_clearance.sql                   ← إقرار جاهزية الزيارة للكرسي: visits.cleared_at/cleared_by (عمودان قابلان للفراغ؛ القائمة مشتقة لا مخزَّنة) (CHAIR-1)
  0037_patient_families.sql                  ← العائلات والضامن: patient_families (اسم العائلة، ضامنٌ مريضٌ أو من خارج المرضى لا الاثنان) وpatients.family_id/family_role — معلومةٌ وكشفٌ لا مال (PAT-4)
  0038_legacy_balance_arrangements.sql       ← ترتيب تحصيل الرصيد السابق: جدولة قسط على opening balance قائم فقط، بلا فاتورة أو principal جديد (P0-C)
  0039_ortho_adjustment_billing_decision.sql ← قرار فوترة شدّة التقويم خارج العقد: لقطة التصنيف عند التوقيع + القرار (فوتِرت/بلا رسوم) ومن قرّر — أعمدة قابلة للفراغ بلا تعبئة (P1-C)
  0040_endodontics.sql ← سير عمل علاج العصب: نوبة لكل (مريض، سن) مرتبطة بحالة تخصصية، سجلّ مهيكل لكل زيارة، قنوات بأطوالها العاملة، ملاحق إلحاقية بمفتاح طلب مقيد وفريد لكل سجل لمنع تكرار إعادة المحاولة، محمية من UPDATE/DELETE مع السماح بمسار TRUNCATE المقصود؛ قيد FDI يطابق الأسنان الدائمة واللبنية — أربعة جداول جديدة بلا مال ولا تعديل لقائم (ENDO-1)
  0041_invoice_clinical_linkage.sql ← الربط السريري للفاتورة: مفتاح إعادة للفاتورة، رابط البند المالي الحي (billed_invoice_id)، نسب سطر الفاتورة إلى بنده عبر التصحيحات (invoice_items.plan_item_id)، ومصدر البند والحالة (origin) — أعمدة قابلة للفراغ بلا تعبئة (INV-LINK B)
  0042_legacy_treatment_agreements.sql ← العلاج السابق للنظام: جدول legacy_treatment_agreements للاتفاق التاريخي (المتفق والمدفوع قبل النظام والمتبقي عند البداية بعملته وتاريخه، وبنده وحالته، وصلته بصف تاريخ الرصيد الافتتاحي) — المتبقي وحده رصيد افتتاحي، بلا فاتورة أو إيصال؛ إلحاقي بحارس لا يسمح إلا بالإبطال، وفهارس تمنع اتفاقين حيّين لنفس (مريض، خدمة، سن) أو لنفس البند — جدول جديد بلا تعديل لقائم (INV-LINK LEGACY)
  0043_legacy_treatment_coverage.sql   ← لقطة التغطية الثابتة للعلاج التاريخي: legacy_treatment_coverage_snapshots (صف واحد لكل اتفاق: نمط الموقع، والأسنان، والنطاق، والأسطح) مع دالة التحقق aqlan_legacy_coverage_site_valid حسب فئة الخدمة، وحارس يطابق الخدمة والسن المرجعي للاتفاق ويرفض التعديل والحذف المستقل — إضافية، بلا تعبئة للصفوف القديمة ولا مال ولا موافقة (INV-LINK LEGACY)
  0044_invoice_admin_discount_lines.sql ← أسطر الخصم الإداري الموزَّع على بنود الفاتورة: invoice_admin_discount_lines (سطر لكل بند لكل قرار، بلحظته، ومصدر النقل عند التصحيح) مع حارس يمنع التعديل والحذف المستقل — إضافية، بلا تعبئة؛ أساس عمولة البند بعد الخصم الإداري (FIN-DISC، قرار المالك: الخيار 2)
```

المصدر الحي لهذه القائمة هو مجلد `migrations/` نفسه — إن اختلفت القائمة أعلاه
عنه فالمجلد هو الصحيح وهذه الوثيقة هي المتأخرة.

جدول التسجيل:

```sql
CREATE TABLE schema_migrations (
  version    TEXT PRIMARY KEY,   -- "0001"
  name       TEXT NOT NULL,
  checksum   TEXT NOT NULL,      -- SHA-256 لمحتوى الملف وقت التطبيق
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  adopted    BOOLEAN NOT NULL DEFAULT FALSE  -- خط الأساس المعتمد بلا تنفيذ؟
);
```

**القواعد:**
- اسم الملف: `NNNN_اسم_بالسنك_flatz_snake.sql` — غير المطابق يُتجاهل، والمكرر/الناقص
  الأول يوقف التحميل (fail closed).
- الترتيب حتمي برقم الإصدار، والبصمة تُحتسب من المحتوى؛ **تعديل ملف طُبِّق مسبقًا
  = انحراف يوقف كل شيء** — لا يُعدَّل الماضي أبدًا؛ الصحيح هجرة جديدة.
- كل هجرة تُطبَّق داخل `BEGIN … COMMIT` واحدة (PostgreSQL يدعم DDL المعاملات):
  فشلٌ في المنتصف يتراجع بكل شيء — بما فيه تسجيل الهجرة نفسها — فإعادة التشغيل
  تعيد المحاولة من نفس النقطة بأمان.
- الهجرات **إضافية** قدر الإمكان، ولا عملية هدمية إلا بموافقة مستقلة.

## استراتيجية اعتماد خط الأساس (P1-FIX-1 — مجسّ التوافق القوي)

قاعدة الإنتاج موجودة فعلًا — **ممنوع** كتابة هجرة تفترض قاعدة فارغة ثم تهدم أو
تعيد إنشاء الموجود. المسار:

| الحالة | السلوك |
|---|---|
| قاعدة **فارغة جديدة** | تُنفَّذ `0001` كاملًا (كل DDL فيه `IF NOT EXISTS`) ثم تُسجَّل. |
| قاعدة **قائمة من النظام الحالي** | **مجسّ توافق خط الأساس** (lib/baseline-probe.ts): معاملة تُتراجع دائمًا تنشئ مخططًا مؤقتًا فريدًا، تنفّذ فيه DDL 0001 حرفيًّا، ثم تستقرئ كتالوج PostgreSQL نفسه للمخططين **بنفس الاستعلامات ونفس الخادم** وتقارن. إن طابق: يُسجَّل `0001` بعلامة `adopted=TRUE` **دون إعادة تشغيل DDL خط الأساس على جداول `public` القائمة**. مجسّ التوافق نفسه ينشئ مخططًا مؤقتًا ويشغّل 0001 داخله ثم يتراجع؛ لذلك ليس «SELECT-only/zero-DDL» حرفيًا. |
| قاعدة غير فارغة **ولا تطابق** المخطط المعروف | `BASELINE_SCHEMA_MISMATCH` بقائمة الفروق الحقيقية، ولا يُسجَّل 0001 (fail closed). |

**ما يقارنه المجسّ (اتجاهًا واحدًا: المتوقَّع ⊆ الفعلي — الإضافات لا تكسر، الناقص/المغاير يكسر):**
- الجداول كاملة (55 جدولًا في 0001).
- الأعمدة: الوجود، النوع، الطول/الدقة، الإبطال (NOT NULL)، والقيمة الافتراضية حيث
  يعرّفها الأساس (بما فيها تسلسلات SERIAL مطبَّعة الأسماء).
- المفاتيح الأساسية، والمفاتيح الأجنبية بسلوك الحذف/التحديث، وقيود UNIQUE وCHECK.
- الفهارس بتعريفها الكامل بما فيها الفهارس الجزئية (شرط WHERE).
- الـtriggers الحرجة (الاسم/الجدول/التوقيت/الأحداث/الدالة).

الحتمية مضمونة بنيويًّا: الطرفان يُستقرآن من نفس الكتالوج بنفس نسخة الخادم داخل
نفس المعاملة — لا فرق عرض (rendering) ممكن. المخطط المؤقت يختفي بالتراجع فلا يبقى أثر على جداول `public`، لكن المجسّ ينفذ DDL مؤقتًا؛ لذلك لا يُستخدم كبديل عن preflight إنتاجي صارم بـSELECT فقط.

**فشل هجرة في المنتصف:** التراجع المعاملاتي يترك `schema_migrations` بلا صفٍّ لتلك
الهجرة — الحالة متسقة دائمًا، وإعادة `db:migrate` تُعيد المحاولة.

**بذور البيانات ليست هجرات:** حسابات الطاقم الافتراضية، دليل الخدمات، المخزون
المبدئي، مجموعة السيفالو المرجعية — كلها تبقى مسؤولية التطبيق عبر `ensureSchema`
(مع الانتباه أن `SKIP_SEED=true` لا يعني no-write كاملًا: توجد إصلاحات ومزامنة sequences قبل حارس البذر). لهذا **أُزيلت** عبارات
البذور/التصحيحات المضمّنة في نص `ensureSchema` الأصلي من ملف `0001` حين
استُخرج — وإلا اصطدمت الاستعادة بمفاتيح مكررة.

## قفل advisory للمهاجرين المتزامنين (P1-FIX-2)

`migrate()` يمسك `pg_advisory_lock` بمفتاح bigint ثابت مشتق حتميًّا من هوية
المشروع (SHA-256 لـ`aqlan-center-mini:schema-migrations:v1`، 48 بتًا) على **اتصال
مخصص واحد يبقى ممسكًا بالقفل طوال الrun**: قراءة الحالة → الاعتماد/التطبيق →
التحقق، ثم `pg_advisory_unlock` في `finally` دائمًا (وموت الاتصال يفكّ القفل
تلقائيًّا من الخادم).

التدفق:

```
connect (اتصال واحد مخصص)
→ pg_advisory_lock(مفتاح المشروع)
→ قراءة حالة الهجرات (بعد القفل — لا قبله)
→ اعتماد خط الأساس (بعد المجسّ القوي) أو تطبيقه
→ هجرات 0002+ بالترتيب داخل معاملات
→ تحقق نهائي
→ pg_advisory_unlock (finally)
→ release
```

النتيجة المُثبتة باختبار حقيقي (مهاجران متزامنان على PostgreSQL): الأول يمسك
ويطبّق، والثاني **ينتظر** ثم يقرأ الحالة محدَّثة فيرى up-to-date — وSQL الهجرة
يُنفَّذ مرة واحدة بالضبط. `ON CONFLICT DO NOTHING` وحده لم يكن ليكفي: هو يمنع
تكرار صف التسجيل، لا تنفيذ DDL الهجرة مرتين.

## القرارات المحاسبية في هجرات 0003–0005 (P1-FIX)

### 0003 — مفتاح الإعادة ببصمة الطلب + الردود الجزئية (P1-FIX-4/5)

- `idempotency_key` وحده ليس هو العملية: معه `idempotency_request_hash` —
  SHA-256 فوق الطلب الكانوني (الممثّل/المريض/الفاتورة/النوع/المبلغ/العملة/الأساس/
  سعر الصرف الفعلي/الطريقة/سند الأصل). نفس المفتاح بنفس البصمة ⇒ **replay** للسند
  نفسه؛ نفس المفتاح ببصمة مختلفة ⇒ `idempotency_conflict` (HTTP 409) — لا يُعاد
  سند عملية مختلفة أبدًا. الممثّل داخل البصمة (actor-scoped).
- **الردود الجزئية هي النموذج المعتمد** (قرار موثَّق): القيد الفريد الجزئي على
  `reversal_of_id` **أُزيل** — عدة ردود للسند نفسه مسموحة. الحارس: الأصل يجب أن
  يكون `kind='payment'` لنفس المريض، وبعملة الأصل نفسها (ردّ بعملة مختلفة مرفوض)،
  وبسعر صرف الأصل snapshot (المكافئ الأساسي يُحسب بسياق الأصل)، والمبلغ موجب،
  و**مجموع الردود ≤ مبلغ الأصل** — يُحسب داخل المعاملة مع `SELECT … FOR UPDATE`
  على صف الأصل فتتسلسل الردود المتزامنة.

### 0004 — سجل النسب بحسب وقت الحدث (P1-FIX-6)

- `effective_from` صار **TIMESTAMPTZ** (لا DATE): السريان لحظة كتابة، لا يومًا.
- السجل **append-only حقيقي**: لا `UNIQUE(category, effective_from)` ولا
  `ON CONFLICT DO UPDATE` — تغييران في اليوم نفسه صفّان والأحدث هو الساري.
- كتابة النسبة الحالية + سطر التاريخ في **معاملة واحدة** (`setMaterialRate`).
- **تقرير العمولة يحلّ النسبة لكل حدث تحصيل بترويخه** (وقت الدفعة نفسها) عبر
  إعادة تمثيل تغطية FIFO حدثًا حدثًا — لا النسبة السارية في نهاية مدى التقرير
  لكامل الفترة: حدث قبل تغيير النسبة يُحسب بنسبته القديمة، وحدث بعده بالجديدة،
  وتغيير النسبة لاحقًا لا يمسّهما. عند ثبات النسب تطابق النتيجة النموذج الكلي
  السابق تمامًا.

### 0005 — append-only كامل: UPDATE وDELETE (P1-FIX-3)

- حرّاس UPDATE كما كانت (الأعمدة المحاسبية).
- **حرّاس DELETE جديدة** على `payments` و`expenses` و`inventory_movements`:
  الأحداث المالية/المخزونية التاريخية لا تُحذف بDELETE عادي — من التطبيق أو من
  psql أو بتتالٍ. التصحيح أحداث صريحة: ردّ (payments)، **إبطال بقيد معاكس**
  (`voidExpense` — صف expenses سالب يشير للأصل عبر `reversal_of_id`)، حركة تسوية
  (inventory). حذف مريض له تاريخ مالي/مخزوني يُرفض مسبقًا برسالة واضحة
  (`has_financial_history`) — والحارس شبكة الأمان. أي purge قانوني/GDPR مستقبلًا:
  workflow منفصل مصرَّح ومدقَّق، ليس DELETE من النظام.

### فترة الانتقال المزدوجة (موثَّقة بوعي)

`ensureSchema()` لم يُحذف (تعليمات P1 صريحة) ولا يُقترب تقاعده قبل P2. خلال P1
يعمل المساران معًا: نفس تغييرات 0002–0005 مضافة إلى `ensureSchema` أيضًا، فالقاعدة
الجديدة من أي المسارين تتطابق، و`db:status` يتحقق. التقاعد الكامل لـ`ensureSchema`
قرار P2 بعد إثبات المسار في الإنتاج.

## الأوامر (CLI) — تصنيف بيئة الهدف (P1-FIX-8)

```bash
npm run db:migrate                 # dry-run: يعرض ما سيل فقط (الافتراضي الآمن)
npm run db:migrate -- --apply      # تطبيق (localhost فقط)
DATABASE_ENVIRONMENT=staging npm run db:migrate -- --apply --allow-remote
npm run db:status                  # تقرير حالة بلا أثر دائم؛ قد يشغّل DDL مؤقتًا متراجعًا عبر baseline probe
npm run db:verify                  # نفس الفحص — alias
```

**قواعد أمان CLI:**
- يطبع هوية الهدف (host/port/database/user) **بلا كلمات سر أبدًا**، مع تصنيف
  بيئته وأسبابه.
- الافتراضي dry-run؛ التنفيذ يتطلب `--apply`.
- **التصنيف على الهدف لا على جهاز التشغيل** (`lib/db-target.ts`):
  `DATABASE_ENVIRONMENT=test|development|staging|production` الصريح هو المصدر
  الأول؛ بدونه: المضيف المحلي ⇒ development، والبعيد داخل عملية Railway ⇒
  production، وما عدا ذلك ⇒ **unknown-remote**.
- `production` أو `unknown-remote` ⇒ **رفض بنيوي ل`--apply` و`restore:full` لا
  يتجاوزه علم في P1** — لا `--allow-remote` ولا `NODE_ENV=development` في الجهاز
  يفتحان قاعدة إنتاج. القراءة الآمنة (status/dry-run) مسموحة.
- قاعدة بعيدة مصنَّفة (staging/test) تتطلب `--allow-remote` إضافية.
- يرفض `USE_LOCAL_DB=true` (PGlite) — **لم يُنفَّذ أي أمر ضد الإنتاج في P1**.

## كشف الانحراف (P1.2 + P1-FIX-1 — db:status / db:verify)

التقرير يعرض، ويخرج بـ`exit 0` فقط إذا كان كل شيء متسقًا:

1. **الهجرات المطبَّقة** — نسخة، اسم، بصمة، وقت، وطريقة (تنفيذ أم اعتماد).
2. **الهجرات الناقصة** (pending).
3. **بصمات مخالفة** — ملف عُدِّل بعد التطبيق.
4. **صفوف مجهولة** (unknown future migration) — القاعدة هُجِّرت بإصدار كود أحدث.
5. **انحراف حرج** — جدول/عمود أساسي مفقود رغم تسجيل هجرته.
6. **مجسّ خط الأساس** (لقاعدة قائمة بلا تسجيل): نتيجة الفرق الحقيقي — جداول/
   أعمدة/أنواع/قيود/فهارس/triggers — مع بصمتي المتوقَّع والفعلي، أو قائمة الفروق
   نصًّا عند عدم المطابقة.

الـ**fail closed** مقصود: التطبيق لا «يصلح» اختلافًا مجهولًا تلقائيًا — القرار
البشري إلزامي، ولا يترك الأمر تغييرًا دائمًا في مسار الفحص؛ لكنه ليس SELECT-only حرفيًا عند تشغيل baseline probe.

## اختبارات الإثبات

`__tests__/migrations.test.ts` (PGlite — 14 اختبارًا): قاعدة فارغة ⇒ كل الهجرات؛
قاعدة قائمة ⇒ اعتماد بلا فقد؛ تشغيل ثانٍ ⇒ no-op؛ هجرة تفشل في المنتصف ⇒ تراجع
كامل وإعادة محاولة تنجح؛ بصمة مخالفة ⇒ مكتشفة وموقفة؛ صف مجهول ⇒ مُبلَّغ؛
انحراف حرج ⇒ مغلق؛ **انحرافات دقيقة (عمود محذوف/نوع مختلف/فهرس محذوف) ⇒
BASELINE_SCHEMA_MISMATCH ولا تسجيل**؛ dry-run لا يكتب شيئًا؛ أسماء غير صالحة
تُتجاهل؛ الترتيب حتمي.

`__tests__/postgres/` (PostgreSQL حقيقي): مجسّ التوافق على قاعدة حقيقية
(baseline-adoption — 10 اختبارات: اعتماد سليم + 7 حالات انحراف DENY + عرض الفروق)،
المهاجرون المتزامنون بقفل advisory (migration-advisory-lock — 4 اختبارات بينها
«SQL ينفَّذ مرة واحدة» وفكّ القفل بعد الفشل)، حرّاس DELETE (append-only-delete —
6 اختبارات)، الردود الجزئية المتزامنة (payment-concurrency — 9)، وتدريب
الاستعادة الكامل (restore-drill — 8).

## حدود معروفة (صراحة كاملة)

- لم يُطبَّق النظام على قاعدة الإنتاج بعد — أول تشغيل تشغيلي سيكون قرار P2.
- `ensureSchema` ما زال يركض عند أول طلب لكل عملية (بارد) — إبطاء أول طلب
  يُعالَج في P2 بتقاعد المسار القديم.
- أداة كتابة الهجرات يدوية (اكتب الملف بنفسك) — لا توليد آلي؛ هذا مقبول
  بمعدّل تغيّر المخطط الحالي وموثَّق.
- مجسّ خط الأساس يقارن الاتجاه الحرج فقط (المتوقَّع ⊆ الفعلي) — الكائنات
  الإضافية في القاعدة القائمة لا تُبلَّغ كفروق لأنها لا تكسر التشغيل/الهجرات.


## إضافة هجرة جديدة — القائمة الكاملة (0012 وما بعدها)

منذ 0012 تتبع كل هجرة النمط نفسه: المخطط يُعرَّف **مرة واحدة** ثابتًا نصيًّا في
TypeScript، ويُطبَّق من المسارين (الهجرة و`ensureSchema`) بالنص نفسه حرفيًّا.
الخطوات بالترتيب — نسيان أيٍّ منها يُسقط CI:

1. `lib/<الميزة>-schema.ts` يصدّر ثابتًا (مثل `EXPENSE_ATTACHMENTS_SQL`) — DDL
   إضافي فقط و`IF NOT EXISTS` حيث أمكن. قيد CHECK على جدولٍ فيه بيانات قديمة
   يُضاف `NOT VALID` حتى لا يفشل الإقلاع على صفٍّ قديم.
2. `migrations/NNNN_<الاسم>.sql`: أسطر تعليق `--` في الأعلى، ثم نصٌّ **مطابق بايتًا
   ببايت** للثابت.
3. `lib/db.ts` ← `ensureSchema()`: `await getPool().query(<الثابت>)` بعد آخر خطوةٍ مماثلة.
4. اختبار وحدة `__tests__/<الميزة>-schema.test.ts` يثبت تطابق جسم الملف مع الثابت.
5. `scripts/verify-schema-ownership.ts`: ارفع `Array.from({ length: N })` إلى رقم الهجرة الجديدة.
6. `__tests__/postgres/schema-ownership.test.ts`: أضف الإصدار إلى القائمة، وارفع طول
   السجل، وعدد الجداول إن أضفت جدولًا.
7. أعد توليد عقد المخطط على PostgreSQL 18: `npm run schema:contract`، والتزم
   `schema/current-schema-contract.pg18.json` مع التغيير.
8. شغّل `npm run verify:full` محليًّا على `docker compose up -d pg18` قبل فتح الطلب.

لا تُعدَّل هجرةٌ دُمجت أبدًا — التصحيح هجرة جديدة برقمٍ تالٍ.

## بوابة توصيف ملكية المخطط (تحضير TD-01A)

`npm run schema:ownership:verify` يبني مسارين مستقلين على PostgreSQL 18 محلي مؤقت:
سلسلة الهجرات كاملةً (0001 حتى آخر هجرة في `migrations/`) و`ensureSchema()`. يقارن الكتالوج تفصيليًا في الاتجاهين،
ويفصل `schema_migrations` عن مخطط التطبيق، ويرفع أثرًا sanitized في CI.
هذه البوابة تحضير فقط: `TD08A_COMPLETE=NO` و`TD01A_COMPLETE=NO` و
`PRODUCTION_WRITES_ALLOWED=NO`. لا اتصال staging/Production ولا adoption.


## Strict read-only preflight (`db:preflight`)

For TD-REG-001 evidence collection, use `npm run db:preflight` with an explicitly
provided `DATABASE_URL`; remote targets additionally require `DATABASE_ENVIRONMENT`.
First verify connection provenance from the running web service, not merely a
project/database service name. MINI’s existing `databaseUrlForProject` resolver
rewrites Railway’s raw default database to `aqlan_center_mini_v2`; this CLI reuses
that exact resolver and rejects a different Railway project. When running outside
Railway against Production, supply the verified effective database URI (the
Production guard rejects the old default database). A database name alone still
does not establish the host/service binding; never infer app adoption from another
service’s catalog. No credentials belong in the resulting artifact.
The command deliberately does not load `.env` files. Keep URLs/credentials in the
process environment, never in reports or committed files. The supported database
major is PostgreSQL 18. `--help` requires no connection.

This extends the existing `lib/schema-preflight.ts` owner and reuses the catalog
projector. A dedicated connection starts `REPEATABLE READ READ ONLY`, verifies the
server-enforced mode, pins catalog search path, and applies connection 5s, statement 5s,
lock 1s, idle-transaction 10s and whole-transaction 30s limits. A client watchdog
bounds connect/inspection to 40s even if the network stops responding. Cleanup
has a separate 2s limit and force-closes only its dedicated socket if needed.
No success JSON is published before cleanup completes. It performs no
application-row or sequence-value reads, DDL/DML, advisory locking, runtime
initialization, baseline probe, migration execution, adoption or repair.

JSON contains catalog section counts/hashes and registry existence, pending/unknown
versions and checksum/name mismatches. Registry relation/column/row shape must be
valid; inaccessible or malformed evidence fails closed with no partial report.
Connection identities, credentials, SQL bodies and raw server errors are omitted.
`exit 0` means evidence collection completed, even for an absent registry or recorded
mismatch; inspect `registry.matchesFiles`. `exit 1` means incomplete/failed collection.
Stable validation codes (for example `PG_VERSION_UNSUPPORTED`, `REGISTRY_ROWS_INVALID`)
and PostgreSQL SQLSTATEs identify the failure without raw server text.
Both `schemaEquivalence: NOT_ASSESSED` and `adoptionAssessment: NOT_PERFORMED` remain
explicit even when every checksum matches. Hashes alone are not adoption proof.

The existing `db:status` / `db:verify` path can run rollback-scoped baseline DDL on an
unregistered nonempty database. It is not a substitute for this strict preflight.
No Production connection is part of the test suite or command installation. Live
adoption, runtime-DDL retirement and seeds remain separately governed work in the
[canonical roadmap matrix](MASTER_ROADMAP_GAP_MATRIX.md).

### Packaged operator command

The source command above uses build/development tooling. Production images package
the same command explicitly, including its JavaScript PostgreSQL driver and exact
immutable migration assets. `npm run build:preflight` creates `.preflight/`; Docker
copies it to `/app/preflight`. Building uses the locked development dependencies
installed by `npm ci` (tsx and esbuild). The delivered artifact needs Node 22, with
no TypeScript runner or runtime `node_modules` install. Build/smoke steps do not
execute migrations or connect to a database. Build environment values are
not substituted into the bundle; CI checks a synthetic secret canary and copied SQL
checksums. The manifest records bundle/notices hashes, the exact migration inventory and
version/license provenance for every bundled dependency. Third-party notices are
included. Before loading the database driver, the packaged entry validates that
manifest and rejects missing, changed or extra migration files, a damaged bundle,
or missing notices. This detects incomplete/corrupt packaging relative to its
emitted inventory; it is not cryptographic attestation of a malicious build.
Native-driver environment overrides are explicitly rejected with a redacted error;
the native dependency is not loaded from any ambient runtime path.

For a connection-free smoke check inside an authorized service executor:

```sh
node /app/preflight/runner/run.mjs --help
```

After separately verifying that executor is the actual MINI web service with its
existing connection environment, an authorized metadata-only run is:

```sh
DATABASE_ENVIRONMENT=production node /app/preflight/runner/run.mjs
```

This sets a classification for that process only. It does not alter service
settings, credentials, startup, health checks, or schema. The existing project and
logical-database guard still applies. Do not paste a connection URI into commands,
logs or reports, and do not use a similarly named default database as evidence.
Packaging does not itself authorize or perform a live run; if no verified service
execution path is available, actual MINI catalog/registry evidence remains pending.

The normal image command remains `node server.js`; preflight is never automatic
startup work. The packaged workflow is exercised against isolated PostgreSQL 18,
from a directory outside the repository, with no developer dependency fallback.

### Optional bounded fingerprint drilldown

`--fingerprint-drilldown` is the only additional inspection flag, supported by
both the source CLI and packaged runner. It adds evidence for **columns,
constraints and internalTriggers only**, from the exact same enforced read-only
snapshot and canonical projector. No extra database query, normalization,
initialization, seed, migration executor or adoption path is added. All default
report fields and all eleven aggregate hashes remain unchanged when omitted.
Write flags and combined/duplicate flags are rejected. The only detail selector is
`--fingerprint-drilldown=SECTION:BUCKET`, where SECTION is one of the three names
and BUCKET is exactly two lowercase hex digits from `00` through `3f`.

The optional report includes exact numeric `server_version_num` (for example
180004), domain-separated identity/entry/property SHA-256 fingerprints, and the
disclosure-policy digest. CLI provenance records exact source-file and migration
inventory hashes. Packaged runs also record the verified bundle and manifest
hashes; source runs explicitly return null for those two packaged identities.
Artifact manifest v2 binds the source-file inventory, including the disclosure
policy, to constants embedded in its integrity-checked bundle. This is
reproducible inventory evidence, not signed build/deployment attestation.

Disclosure is deliberately asymmetric:

- Identities must match the committed source-known allowlist, including key,
  table and name. Unknown identities contribute **counts only**, never their
  names, identity hashes, value hashes or per-object records
- Only explicitly classified structural numeric/boolean properties or
  source-known textual values may receive fingerprints. Unknown SQL, defaults,
  identifiers or other text produce `WITHHELD`; no hash of that property is
  emitted, and the complete entry hash is null. Unexpected property/wrapper
  fields are count-only and likewise suppress the entry hash; missing fixed
  properties are marked `MISSING`
- Source-known identity and property values are not encryption secrets.
  SHA-256 is **not encryption**; low-entropy values can be inferred by dictionary
  comparison. The unchanged pre-existing aggregate hashes retain their existing
  evidence/privacy boundary, including when detailed evidence is withheld
- Arrays preserve duplicate multiplicity. Constraint renames and ordinal
  history remain differences; generated internal-trigger OID names are treated
  only by the existing projector. No new normalization or expansion of the
  sixteen open-convergence findings is performed

The internal optional projection refuses over 5,000 entries in any selected
section or over 4 MiB of compact filtered evidence. The operator CLI never emits
that full multi-megabyte projection. `--fingerprint-drilldown` emits a compact
64-bucket count/digest summary per section. An identity's first hash byte modulo
64 selects its bucket; bucket arrays retain multiplicity and contain only
already-filtered evidence. Unknown identities stay in global count-only totals.
A detail selector emits one bucket, its count/digest and complete filtered
entries, plus global count/withholding totals. Every response retains the full
original aggregate catalog and provenance/version evidence.

Optional CLI stdout is one complete JSON line, with a hard **48 KiB including
newline** limit. An oversized bucket fails closed with
`FINGERPRINT_RESPONSE_LIMIT`; it is never silently truncated. Current isolated
runtime evidence has 26 entries in its largest column bucket and 24 in its
largest constraint bucket (about 35 KiB of detail before provenance); full
three-section raw detail was 3.8 MB/50,570 lines and must not be pasted through
Console scrollback. Hashes can validate a fully captured JSON response; they
cannot prove that a terminal captured a missing/truncated response. Future
oversized buckets need a separately reviewed narrower capture route.
Failure gives no partial success report.
It contains no application rows, mutable sequence state, connection identity,
role identity, credential, raw SQL definition or raw default expression.
Withheld evidence is not evidence of equivalence or a known harmless difference.

`schema/preflight-disclosure.pg18.json` was generated against isolated PostgreSQL
18.4 from the numbered and runtime source schemas at the tree of main
`250aa99c07fed6575d3560c674e62222fb2b316c`. Reproduce a **review candidate** with
`node --import tsx scripts/generate-preflight-disclosure.ts` under the existing
ownership harness's clean test environment and loopback-only `aqlan_p1_test`
target. This offline-only script creates/drops generated disposable databases
from `template0` through the existing guarded harness and rejects a nonempty
initial public/user catalog or event triggers before either builder runs. A
private synthetic `template1` canary must not affect generated policy. Other
harness callers retain their existing template choice; it is not shipped in the operator bundle.
It never expands policy from live catalog content. Review source changes before
committing any regenerated policy; do not add Production unknowns automatically.
CI regenerates the policy from fresh source schemas and checks exact equality.

Each selector invocation has its own read-only snapshot. Combine captures only
when **all eleven aggregate hashes/counts, registry evidence, source/projector/
policy/bundle provenance and exact server version match** across every response.
A change invalidates cross-capture attribution; restart the comparison rather
than guessing or merging inconsistent snapshots. Node/ICU versions are recorded
for reproduction. Map identities locally by `fingerprintIdentity`
against those same source catalogs. A missing known identity plus withheld counts
may indicate a rename; it does not identify or authorize disclosure of the new
name. Property hashes localize reviewed structural differences; `WITHHELD`
localizes only the affected known object/property and requires a separately
reviewed next step. Neither outcome permits adoption or runtime-DDL retirement.
This implementation and its tests perform **no Production drilldown execution**.
