# ORTHO INTEGRATION STATUS — حالة دمج وتصلب وحدة تقويم الأسنان

> **المرجع البصري والوظيفي المعتمد من المالك**: `feat/aqlan-advanced-ortho-workspace` (`9feac89c93a56971c82973e277db0cef2e3d8fc7`) بالتصميم الكامل وترتيب التبويبات العشرة لـ`OrthoCore` مع إبقاء شاشة الشدّات اليومية الأصيلة (`PatientOrtho.tsx`).

---

## 1. ما تم إنجازه واعتماده بصريًا ووظيفيًا (`9feac89c`)

1. **التبويبات العشرة المتسلسلة باستوديوهات `OrthoCore` الكاملة**:
   - `1. نظرة عامة` (`OverviewTab`) · `2. الاستبيان والتاريخ الطبي` (`QuestionnaireTab`) · `3. الفحص السريري ومخطط FDI` (`ExamTab` + `FdiToothChart`) · `4. الصور والأشعة والـ3D` (`MediaTab` + `PhotoEditorModal` + `CbctStudio` + `DicomViewerModal` + `Model3DViewer`) · `5. القياسات والسيفالومتري` (`AnalysisTab` + `CephTracingStudio` + `PhotoAnalysisStudio`) · `6. التشخيص وقائمة المشكلات` (`DiagnosisTab`) · `7. خطة العلاج والأجهزة` (`PlanTab`) · `8. الشدّات والجلسات والتصوير` (`PatientOrtho` الأصيلة + `TighteningCameraStudio` + `TighteningCompareModal`) · `9. التثبيت والمتابعة` (`RetentionTab`) · `10. التقارير وعروض الحالات` (`ReportsTab` + محرك `OOXML PPTX` الأكاديمي ذو الـ23 شريحة أساسية + شرائح جلسات الشدّات).

---

## 2. مصفوفة الإصلاحات الهندسية والسريرية الإلزامية (الأقسام 8، 9، 11، 12، 13)

| البند | المشكلة المكتشفة في `9feac89c` | الحل الهندسي المعتمد للتنفيذ | الحالة |
| :--- | :--- | :--- | :---: |
| **8 — توحيد محرك الحوكمة** | `lib/ortho-privacy.ts` يعمل بمعزل عن `lib/staff-capabilities.ts` و`lib/staff-operation-runtime.ts`. | توسيع كتالوج القدرات المركزي ليشمل قدرات التقويم التفصيلية مع محوّل ثنائي الاتجاه يحفظ واجهة إعدادات الخصوصية المتقدمة للمالك ويطبّق `Deny > Allow` والصلاحيات المؤقتة وفصل الرؤية/الإدخال/التعديل/الاعتماد خادميًا. | ⏳ قيد التنفيذ |
| **9.أ — تخزين السجلات وتعدد الحالات** | تخزين مساحة العمل داخل `settings` بمفتاح `ortho.workspace.v1.p.<patientId>` على مستوى المريض فقط. | نقل السجلات إلى جدول مطبّع ومؤرخ `ortho_clinical_workspaces` + `ortho_clinical_workspace_revisions` مرتبط بـ`(patient_id, ortho_case_id)` مع الحفاظ على مصدر الحقيقة الوحيد لكل من `ortho_cases` و`ortho_adjustments` و`patient_documents` و`ceph_analyses`. | ⏳ قيد التنفيذ |
| **9.ب — الكتابة المتزامنة (CAS)** | فحص `revision` يجري بقراءة منفصلة قبل الحفظ مما يسمح بضياع تعديلات متزامنة. | تنفيذ قفل صف `FOR UPDATE` + شرط `WHERE id = $1 AND revision = $2` داخل معاملة واحدة مع `insertAuditRow(client, ...)`، وإثباته باختبار PostgreSQL متزامن يفشل بالنمط القديم وينجح بالجديد. | ⏳ قيد التنفيذ |
| **9.ج — أوامر كتابة مجزأة وBlind Entry** | `PUT` يستبدل السجل الكامل، ويعيد السجل في استجابة الحفظ. | استبدال الحفظ الشامل بأوامر كتابة محددة (`command: "save_questionnaire" | "save_exam" | "approve_diagnosis" | ...`) تتحقق من صلاحية القسم والحقل والعملية، وإرجاع إيصال مختصر بلا بيانات سابقة عند `blind_create`، وتصفية حقول `orthoCoreCase` المتداخلة. | ⏳ قيد التنفيذ |
| **9.د — إزالة `activeNumericPatientId` العام** | `components/ortho/orthocore/services/api.ts` يعتمد متغيرًا عامًا قد يخلط الملفات عند التنقل السريع بين مريضين. | حذف `activeNumericPatientId` نهائيًا وتمرير `{ patientId, orthoCaseId }` صراحةً في كل استدعاء، والتحقق من مطابقتهما في الخادم، وإضافة اختبار تنقل متزامن بين مريضين. | ⏳ قيد التنفيذ |
| **9.هـ — ذرية التدقيق** | استخدام `.catch(() => {})` عند استدعاء `recordAudit` في مسارات التقويم والعروض. | استبدالها بـ`insertAuditRow(client, ...)` داخل المعاملة الذرية بحيث يؤدي فشل التدقيق إلى `ROLLBACK` كامل للعملية. | ⏳ قيد التنفيذ |
| **11 — منع تكرار الصور وعلاقة الأصل بالمشتق و`0132` و`#594`** | فحص تكرار الصورة بـ`SELECT` ثم `INSERT` منفصلين، وعلاقة النسخة المشتقة مكتوبة نصيًا في `note`. | قفل ذري `pg_advisory_xact_lock` على `(patient_id, sha256)` داخل المعاملة، وإضافة عمود `parent_document_id` رسمي على `patient_documents`، ودمج هجرة `0132` (ملحقات الشدّات الـ17) و`#594` (الطبيب المسؤول وحجز العودة). | ⏳ قيد التنفيذ |
| **12 — التحقق العلمي للسيفالومتري وMoyers** | جدول Moyers في `lib/ortho-scientific-analyses.ts` غير مقسّم حسب الجنس، و`updateCephLandmarks` يضع `confirmed_by` على المعالم المقترحة آليًا. | اعتماد جدول Proffit 7th Ed Table 11-4 ذي الـ`208` خلايا المقسّم حسب الجنس مع الرفض خارج `[19.5, 25.5]`، وإضافة `Little's Irregularity Index` و`Curve of Spee ALD` و`Huckaba` و`Ashley-Howe I/II`، واشتراط `source = 'manual'` لتأكيد الـ24 معلمًا، وربط `CephTracingStudio` بـ`/api/ceph/*`. | ⏳ قيد التنفيذ |
| **13 — شرط الموافقة التعليمية في `Case Presentation`** | وجود استثناء `!evalCreate.subject?.isOwner` يسمح للمالك بالتصدير التعليمي دون موافقة المريض الموثّقة. | إزالة الاستثناء كليًا فلا يتجاوز المالك أو الطبيب شرط موافقة المريض الخطية على الاستخدام التعليمي، وتطهير أسماء الملفات والمعرفات والبيانات الوصفية عند إخفاء الهوية. | ⏳ قيد التنفيذ |
