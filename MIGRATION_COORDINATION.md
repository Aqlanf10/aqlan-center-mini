# MIGRATION COORDINATION LEDGER — سجل تنسيق وحجز الهجرات مع DOT

> يوثّق هذا الملف جميع أرقام الهجرات المفحوصة عبر كافة فروع `Aqlanf10/aqlan-center-mini` و`Aqlanf10/aqlan-center` لضمان **صفر تعارض** في أرقام الهجرات، وعدم تعديل أي هجرة منشورة، وعدم تنفيذ أي `CREATE TABLE` أثناء طلبات API.

---

## 1. خريطة الهجرات الكاملة المفحوصة (`0074` – `0137`)

| النطاق | الملفات الفعليّة | الحالة والملكية | قرار التكامل |
| :--- | :--- | :--- | :--- |
| **`0074`, `0078`, `0080–0082`, `0087`, `0089`** | `lab_work_intents`, `agreement_reconciliation`, `patient_numbering`, `invoice_archive`, `invoice_service_additions`, `agreement_reminder_metadata`, `lab_shade_specification` | معتمدة وموجودة في `e01d667f` (`0087` و`0089` في `main`) | **محفوظة بايتًا ببايت دون أي تعديل.** |
| **`0076`** | `frozen-0076.sql` (نواة الهوية الموحدة وحماية المالك) | محجوزة لـ Claude / M4 | تبقى بصمتها مجمّدة (`f31ddf14...`) وتُدرج ضمن بروفة M4. |
| **`0079`** | `0079_ortho_followup_coverage.sql` | موقوفة على القواعد الجديدة في `e01d667f` (`7876c15e`) | يُحفظ الملف للتحقق التاريخي فقط دون تشغيله تلقائيًا على القواعد الجديدة. |
| **`0083–0086`** | مقترحات المخزون والمشتريات والعهد (`inventory_procurement`, `custody`, `supplier_finance`, `command_lifecycle`) | محجوزة لـ M3b / M4 | تبقى في مقترحات `lib/inventory-domain/*` حتى بروفة التسجيل المنسقة في M4. |
| **`0090–0096`** | `booking_request_preferences`, `prescribing_doctor_*`, `radiology_requests`, `appointment_*` | محجوزة لـ DOT وفروع الوصفات والمواعيد | **ممنوع استخدام هذه الأرقام نهائيًا.** |
| **`0100–0125`** | هجرات التقويم والسيفالومتري القديمة في `#530/#541` | مستبعدة بقرار المالك (`#483` `6930581808`) | **لا تُستورد.** |
| **`0126`** | `0126_commission_case_participations.sql` | مشاركة الأطباء في الحالات والعمولات (`#539`) | **تُدمج بحرفيتها** مع سياسة عدم تعليق `pending` (`06071ef8`). |
| **`0127`, `0135`** | `patient_portal_*` | فروع أمان بوابة المرضى | محجوزة لفروع البوابة. |
| **`0128`, `0129`, `0133`** | `expense_commands`, `shift_opening_reviews`, `expense_request_retirements` | أوامر المصروفات وحساب المالك `2108` والورديات (`#541`) | **تُدمج بحرفيتها** مع تحديث بيان ملكية المخطط وبصمات الهجرات. |
| **`0130–0131`** | محجوزة في `#541` لإعفاءات المعامل وتصحيح طبيب الفاتورة | محجوزة لـ Claude / DOT | **لا تُستخدم.** |
| **`0132`** | `0132_ortho_adjustment_auxiliaries.sql` | ملحقات جلسة الشدّ (`17` ملحقًا قياسيًا) | **تُدمج بحرفيتها** فوق `ortho_adjustments` دون الحاجة إلى `0109`. |
| **`0134`** | `0134_commission_lab_cost_allocation.sql` | توزيع تكلفة المختبر في الحالات المشتركة | يُستكمل تسجيلها في فحوص المخطط والملكية والواجهة بعد توثيق الحالات الحدية. |
| **`0136`** | `0136_grouped_lab_orders.sql` | طلبات المختبر المجمّعة لعدة أسنان في الفكين | **تُدمج بحرفيتها** مع إصلاحات توافق عملات التقسيم (`32febf7d`). |
| **`0137`** | `0137_ceph_completion_provenance.sql` | فرع إثبات مصدر السيفالومتري | محجوزة — لا نستخدم `0137`. |

---

## 2. طلب حجز أرقام الهجرات الجديدة للتنسيق مع DOT (`0140–0142` — مقترحة في `migrations/proposals/`)

التزامًا بعدم حجز أرقام هجرات إنتاجية من طرف واحد قبل تأكيد DOT، تُجهَّز الهجرات الجديدة في `migrations/proposals/` مع دوال تثبيت اختبارية معزولة لبروفة PostgreSQL (M4)، ويُطلب من DOT اعتماد أرقامها النهائية (`0140–0142`):

1. **`proposals/0140_ortho_clinical_workspaces.sql`**:
   - جدول `ortho_clinical_workspaces` مرتبط بـ`(patient_id, ortho_case_id)` مع `revision BIGINT` للـCAS الذري.
   - جدول `ortho_clinical_workspace_revisions` غير قابل للتعديل (`append-only` trigger) لحفظ لقطات الاعتماد والتدقيق وإعادة الفتح الموثّقة.
   - إضافة `parent_document_id INTEGER REFERENCES patient_documents(id)` على `patient_documents` لحفظ علاقة الصورة الأصلية بالنسخة المشتقة رسميًا مع فهرس منع تكرار ذري.
2. **`proposals/0141_service_consumption_exemption.sql`**:
   - إضافة عمود `material_consumption_exempt BOOLEAN NOT NULL DEFAULT FALSE` على جدول `services` لدعم إعفاء الخدمة الفردية من خصم نسبة الاستهلاك في حساب عمولة الطبيب (البند 17).
3. **`proposals/0142_ai_governance_budget_and_ledger.sql`**:
   - جدول `ai_budget_policies` (حدود الميزانية الشهرية/اليومية والإيقاف التلقائي).
   - جدول `ai_usage_ledger` غير القابل للتعديل (`append-only` trigger) لتسجيل الاستهلاك وبصمة قالب `Zero-PHI`.
   - صلاحيات المساعد التفصيلية لكل موظف (`can_use_internal_ai`, `can_use_external_ai`, `ai_allowed_tool_groups`).
