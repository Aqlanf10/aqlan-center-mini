# Reports Center Master Plan — Aqlan Center Mini

> الهدف: مركز تقارير واحد مترابط، بأرقام من مصادرها الكانونية نفسها، مع Drill-down، صلاحيات خادمية، تصدير، ومستندات رسمية. لا يُسمح بإنشاء صيغة مالية أو سريرية موازية داخل صفحة تقرير.

## مبادئ حاكمة

1. **Single Source of Truth** — التقرير يقرأ من نفس المحرك الذي يخدم العملية الأصلية.
2. **No cross-currency aggregation** — YER / SAR / USD دفاتر مستقلة ما لم توجد عملية تحويل مسجلة صراحة.
3. **Actionable reporting** — الصفوف تقود إلى المريض/الموعد/المورد/العملية ذات الصلة.
4. **Server-side RBAC** — إخفاء زر لا يُعد صلاحية.
5. **Official document output** — الطباعة من مستند مستقل، لا من شاشة التطبيق.
6. **One report contract** — `ReportResult` هو عقد الشاشة والطباعة والتصدير.
7. **No silent historical rewrite** — التقارير التاريخية تعتمد اللقطات والحركات الفعلية وقت الحدث.

## R0 — سلامة الأساس — مكتمل

- محرك `lib/reports.ts`.
- عقود `lib/reports-types.ts`.
- فلاتر موحدة.
- Drill-down إلى كشف المريض.
- فصل العملات.
- FIFO للمديونية.
- محرك العمولات الكانوني.
- `verify-reports` + اختبارات PostgreSQL.
- بوابة صلاحيات التقارير على الخادم.

## R1 — مكتبة التقارير — منفذ/قيد الدمج في PR #62

### تشغيلية
- سجل الزيارات.
- المواعيد.
- المتابعة والاستدعاء.
- المخزون.
- اليومي.
- المرضى الجدد.

### مالية
- الشهري.
- السنوي.
- التحصيل.
- الخدمات والإجراءات.
- الموردون والذمم الدائنة.

### المديونية
- الرصيد المستحق.
- المديونية الناشئة.
- تحصيل المديونية.
- حركة المديونية.
- أعمار الديون.

### سريرية
- التخصصات.
- خطط العلاج.
- المختبر.

### أطباء
- إنتاجية الطبيب.
- كشف عمولة الطبيب من `commissionReport()`.

### مستندات مرتبطة
- Shift Z موجود في `/print/shift/[id]`.
- كشف حساب المريض الرسمي موجود.
- المورد/المعمل مرتبط بمصدر payables نفسه.
- المستند الرسمي العام للتقارير: `/print/report`.

## R2 — Official Reporting Documents — قيد الإغلاق

- مستند A4 مستقل لكل تقرير.
- Portrait/Landscape تلقائي.
- ترويسة وهوية المركز من Settings.
- الفترة والفلاتر والمستخدم ووقت الإنشاء.
- KPI + مقارنة + تفاصيل + إجماليات + ملاحظات.
- Excel + CSV.
- المطلوب لاحقًا: snapshot/hash للتقارير التي تصبح مستند اعتماد مالي ثابت.

## R3 — Power Reporting — منفذ في PR #63

- حفظ تقرير باسم المستخدم (`saved_reports`، الهجرة 0015): التقرير، القسم، الفلاتر، الأعمدة وترتيبها، ترتيب الصفوف، التجميع.
- المفضلة لكل مستخدم، إعادة التسمية، الحذف (يحذف العرض المحفوظ فقط لا أي بيانات)، النسخ للتعديل، وتحديث العرض المحفوظ بالعرض الحالي.
- روابط داخلية قابلة للمشاركة تحفظ الفلاتر والعرض (`columns`، `sort`، `group`).
- قوالب المدير المشتركة (`is_shared`) + قوالب جاهزة في الكود (`lib/report-templates.ts`): مرضى اليوم، مواعيد الأسبوع حسب الحالة، مرضى جدد هذا الشهر، متأخرات المختبر، إنتاجية الأطباء، المديونية القائمة.
- طبقة عرض واحدة `lib/report-view.ts` (`applyReportView`) تخدم الشاشة والمستند الرسمي وExcel وCSV — لا تعيد حساب أي رقم، والمجاميع الفرعية للمجموعات لكل عملة على حدة.
- الصلاحيات خادمية: القالب المشترك لا يُعرض ولا يُنسخ لمن لا يملك صلاحية تقريره، وغير المالك لا يعدّل ولا يحذف، والمشاركة للمدير وحده، وفتح الرابط يمر بمسار التقارير والمستند الرسمي اللذين يفرضان الصلاحية.
- اختبار يمنع إضافة تقرير إلى المحرك دون إدراجه في قائمة الصلاحيات (`UNIFIED_REPORT_IDS`).

## R4 — Practice Intelligence

- Practice Overview dashboard.
- Provider utilization.
- Chair utilization.
- Appointment cancellation/no-show analysis.
- Treatment acceptance / unscheduled treatment.
- Lab turnaround & on-time rate by lab.
- Provider/lab/service trends.
- New-patient conversion.
- Recall conversion.
- Targets vs actual.
- Period and year-over-year trends.

## R5 — يعتمد على توسيع بيانات الوحدات الأخرى

هذه التقارير لا ينبغي اختراع أرقامها قبل وجود حقولها الكانونية:

- Referral analytics ← يحتاج `patient.referral_source` / referring provider.
- Cancellation reasons ← يحتاج سبب إلغاء/إعادة جدولة versioned.
- Patient lifecycle cohorts ← يحتاج Patient Status/Archive مضبوط.
- Structured medical-risk analytics ← يحتاج structured allergies/conditions/vitals.
- Multi-branch analytics ← يحتاج Branch ownership في الكيانات التشغيلية.
- Insurance/payer analytics ← مؤجل حتى وجود payer domain فعلي.

## R6 — Enterprise / Multi-location

- Branch filters and side-by-side comparison.
- Saved report subscriptions.
- Scheduled delivery.
- Role/location scoped dashboards.
- Report execution history.
- Approved immutable snapshots for accounting/commission settlement.
- KPI targets by location/provider.

## شرط إغلاق وحدة التقارير

لا تُعتبر الوحدة مكتملة لأن عدد التقارير كبير فقط. الإغلاق يتطلب:

1. كل تقرير يطابق مصدره الكانوني باختبار regression.
2. لا رقم مالي يجمع العملات الخام.
3. كل تقرير حساس محمي خادميًا.
4. الطباعة لا تطبع شاشة التطبيق.
5. التصدير يأخذ نفس `ReportResult` المعروض.
6. التقارير التشغيلية المهمة قابلة للوصول من Reports Center.
7. كل gap يعتمد على بيانات غير موجودة موثق كـ dependency، لا يعالج بتخمين.
8. CI كامل أخضر قبل الدمج إلى `main`.
