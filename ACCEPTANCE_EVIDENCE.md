# ACCEPTANCE EVIDENCE — سجل أدلة القبول والاختبارات الفعلية

> لا يُنسب أي نجاح اختباري لالتزام سابق إلى التزام أحدث؛ يُحدَّث هذا السجل بنتائج الفحوص الفعلية على رقم الالتزام (Commit SHA) لكل حزمة.

---

## 1. خط الأساس المستلم قبل الدمج (Baseline Evidence)

- **فرع التقويم المستقل (`feat/aqlan-advanced-ortho-workspace` @ `9feac89c`)**:
  - `vitest run` (اختبارات التقويم والخصوصية والعروض): ناجحة (`253+` اختبار).
  - `next build` + `tsc --noEmit`: رمز خروج `0`.
  - `ci:scan:body` (`256` مسارًا) + `scan:money`: ناجحان.
  - فحص فتح ملف `PPTX` الأكاديمي الفعلي عبر `PowerPoint.Application` COM: `25` شريحة، `32` صورة مدمجة، `4` جداول أصلية، رمز خروج `0`.
- **فرع حوكمة Claude (`feat/claude-governance-candidate-20261119` @ `e01d667f`)**:
  - خريطة التحويل `M2_ROUTE_CAPABILITY_MAP.json`: `189` `canonical-done`، `155` `existing`، `23` `owner-only`، `4` `entry`، `3` `self`، `12` `excluded` (`386` إجماليًا).

---

## 2. سجل اختبارات الحزم المدمجة على `feat/master-governance-ortho-integration`

*(يُملأ تباعًا فور إغلاق كل حزمة برمجية بأرقام الفحوص والالتزام الفعلي)*

| الحزمة | الالتزام (SHA) | TypeScript (`tsc`) | ESLint | Unit Tests | PostgreSQL Tests | Security / Body / Money / Schema Guards | Production Build | ملاحظات |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| **Foundation + P0-1..P0-3 + P1 + P2** | *قيد التنفيذ* | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | قيد البناء والاختبار |
