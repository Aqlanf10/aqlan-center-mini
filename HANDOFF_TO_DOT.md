# HANDOFF TO DOT — تقرير التسليم والتنسيق الهندسي مع DOT

## 1. ملخص حالة التسليم

- **المستودع الأساسي**: `https://github.com/Aqlanf10/aqlan-center-mini`
- **فرع التكامل الشامل المرفوع للمراجعة**: `feat/master-governance-ortho-integration` (شامل إغلاق ملاحظات `ESLint 10` واختبارات تكامل PostgreSQL 18 على GitHub Actions CI).
- **فرع التقويم المستقل المحدّث**: `feat/aqlan-advanced-ortho-workspace` (شامل معيار ECMA-376 الكامل لملفات `PPTX` وتوافق `ESLint` واختبارات التكامل على CI).
- **حالة الإنتاج وStaging**:
  - **لم يتم الدمج في `main`**.
  - **لم يتم النشر على Production أو لمس بيانات أو أسرار العيادة الفعلية**.
  - شارة `AQLAN CENTER — EXPERIMENTAL` مدمجة وجاهزة في `components/AppShell.tsx` عند تفعيل `NEXT_PUBLIC_EXPERIMENTAL_BANNER=true` للنشر التجريبي على مشروع Railway التجريبي بعد مراجعة DOT.

---

## 2. ملخص ما أُنجز وتوحّد هندسيًا لمراجعة DOT

1. **مصالحة أعمال الحوكمة والمالية والمختبر والترقيم مع `origin/main` (`ed72883a`)**:
   - دمج الشرائح `95a–95d` وخصم الفاتورة التناسبي (`#536`)، مشاركة الحالات `0126` (`#539`) مع عدم تعليق العمولة عند `pending`، أوامر المصروفات وحساب المالك `2108` (`0128`، `0133`)، مراجعات افتتاح الوردية والعدّ الأعمى (`0129`)، وطلبات المختبر المجمّعة (`0136`) — مع إبقاء `0079` موقوفة واستبعاد الهجرات الملغاة `0106–0125`.
2. **إغلاق ثغرة مصروفات الاستقبال وخصوصية القراءة (`TD-01`)**:
   - حظر دور `reception` خادميًا وواجهةً من `/api/expenses*` و`/api/expense-attachments/*` و`/print/voucher/[id]` و`/print/shift/[id]`، وإسقاط القراءة الآمن في `/api/patients/[id]` وحصر الرفع بالأشعة والتقارير الخارجية.
3. **الترقيم متعدد الأحرف (`BRW-07429`) وشاهد الاستعادة وإعادة التسجيل (`TD-02`, `TD-03`)**:
   - توسيع `PATIENT_PREFIX_PATTERN` إلى `/^[A-Z]{1,6}$/` عبر المولّد وسياسة الاستعادة وحجز العلامة المائية (`#602`)، وتمرير `Idempotency-Key` والرصيد الافتتاحي الذري (`#584/#585`) في المسارين القديم والقانوني.
4. **تصلب وحدة التقويم المتقدمة وعروض المؤتمرات (`TD-04..TD-09`, `TD-11`)**:
   - ربط الصلاحيات بمحرك الوصول المركزي بقاعدة `Deny > Allow` والصلاحيات المؤقتة، وفصل مساحة العمل بنطاق `(patient_id, ortho_case_id)` بـCAS ذري (`409 REVISION_CONFLICT`) وتدقيق ذري داخل المعاملة، وإزالة `activeNumericPatientId`، واعتماد جدول Moyers ذي الـ`208` خلايا من Proffit 7th Ed وبوابة الـ`24` معلمًا معايرًا للسيفالومتري، وإصلاح حزمة `OOXML PPTX` وفق ECMA-376 (`DEFLATE` + `core-properties` + `theme1.xml`).
5. **إصلاح معادلة العمولات (`2,400` ريال يمني) وتكاليف المختبر المشتركة (`TD-10`)**:
   - خصم نسبة الاستهلاك التخصصي من أساس العمولة قبل ضرب نسبة الطبيب، ربط `netEarnedMinor` في `commissionDueForPayroll`، وإضافة مقترحي `0134` (توزيع مختبر الحالات المشتركة) و`0141` (`services.material_consumption_exempt`).
6. **توحيد حوكمة المساعد الذكي (`Zero-PHI` والميزانية و`#604` — `TD-12`)**:
   - جعل `ai.external_assistant = "false"` افتراضيًا، قفل الإرسال السريري الخارجي، منع أي استدعاء خارجي عند وجود سياق مريض نشط، دمج محول `OpenAiResponsesAdapter` وفحوص الاتصال من `#604`، وإضافة مقترح `0142` (`ai_budget_policies` + `ai_usage_ledger` غير القابل للتعديل).

---

## 3. نقاط القرار والتنسيق المفتوحة لـ DOT

1. **تأكيد أرقام الهجرات المقترحة في `migrations/proposals/`**:
   - `0132_ortho_adjustment_auxiliaries.sql`
   - `0134_commission_lab_cost_allocation.sql`
   - `0140_ortho_clinical_workspaces.sql`
   - `0141_service_consumption_exemption.sql`
   - `0142_ai_governance_budget_and_ledger.sql`
   *(تعمل المسارات حاليًا بأمان تام عبر فحص `to_regclass` / `to_jsonb` دون أي DDL وقت الطلب، وجاهزة للنقل إلى `migrations/` وتوليد بيان الملكية على خادم PostgreSQL 18 فور اعتماد DOT للأرقام).*
2. **تشغيل بوابة PostgreSQL 18 في CI / Staging**:
   - تشغيل `npm run schema:contract:verify` و`npm run schema:ownership:verify` واختبارات `vitest.config.postgres.mts` على حاوية PostgreSQL 18 في CI قبل اعتماد النشر على مشروع Railway التجريبي.
3. **إرشاد تشغيلي مهم لويندوز عند تجربة تنزيل `PPTX` محليًا**:
   - يجب فتح الخادم المحلي عبر `http://localhost:3000` وليس `http://127.0.0.1:3000`؛ لأن نظام Windows يصنّف العنوان المنقّط `127.0.0.1` ضمن `URLZONE_INTERNET` (`ZoneId=3`) مما يفعّل وضع `Protected View` في Office (`0x86421005`)، بينما يصنّف `localhost` ضمن `Local Intranet` (`ZoneId=1`) فيفتح الملف في PowerPoint مباشرة بنقرة مزدوجة.
