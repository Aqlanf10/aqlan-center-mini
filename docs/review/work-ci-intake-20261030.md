# إصلاح فشلي CI في استلام WORK — 2026-10-30

الأساس المثبت: `1ccb30c2ee443ad8b0c5af0c9b0f5b261ba78ec2`. جُهز الإصلاح في الفرع المؤقت `feat/work-ci-intake-20261030`، ثم طلب المالك صراحة الاستكمال على فرع كلاود نفسه `feat/work-recovery-followup-20261027`. الانتقال إليه يكون بتقديم المؤشر إلى التزامات الإصلاح بدفع عادي بعد التحقق من بقاء الرأس المتوقع؛ لا إعادة كتابة للتاريخ أو استبدال لتحديثات أخرى. لم يتغير أي workflow. هذه جولة إصلاح الأدلة والجرد فقط، وليست قبول تحويل الصلاحيات أو الشريحة 26. لم يتغير مصدر التطبيق أو المخطط أو الاعتماديات.

## الفشلان المثبتان والإصلاح

في [تشغيل WORK 40967894483](https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/40967894483): فشل اختبارا الجرد بسبب `sourceDigest` القديم؛ وفشل إعداد اختبار أداء السندات بسبب بصمة قارئ سابقة لا تطابق استخراج المساعدات في `f40cd1fb961f0d1c38cff8242c8ec38225a9993c`. لم يصل ذلك التشغيل إلى HTTP/المتصفح. آخر نجاح كامل مثبت قبل الإصلاح هو [40945424802](https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/40945424802) عند `81472602285b929da6bd92513a7062e067b5fa82`.

- أعيد إنتاج الفشلين على الأساس نفسه قبل التعديل؛ سجلاهما محفوظان مع الأدلة أدناه.
- تحقق الانحدار الأصلي للسندات: 9 اختبارات PostgreSQL ناجحة قبل تغيير البصمة. ثم نجحت نسخة مؤقتة من اختبار الأداء مع البصمة الحالية قبل تعديل الحارس الملتزم؛ حذفت النسخة المؤقتة بعد الإثبات.
- أضيف اختباران حقيقيان لـ `readReceiptProvenanceWith`: تطابق سلسلة التصحيح مع القارئ القديم وثبات اتصال/لقطة `REPEATABLE READ READ ONLY`؛ وخطأ PostgreSQL فعلي في قراءة التدقيق مع التعافي بنقطة الحفظ واستمرار اللقطة والقراءة والالتزام. مقارنة الجداول تثبت عدم تغيير السندات والفواتير والتدقيق والقيود والطباعة.
- ثبتت البصمة الحالية للقارئ حرفيًا: `2a508954ec1267340d5a7f27b76c172b15c0a328314b943f935f45d869c0a2ee`. بقي الحارس وحدود الطلب والسياق وعتبات الاختبار كما هي. بصمة دالة الإسقاط لم تتغير. نقلت بيانات القبول الأقدم إلى `historicalAcceptance` حتى لا تنسب موافقة قديمة إلى المصدر الحالي.
- أعيد توليد inventory بأداة المستودع؛ التغيير الوحيد فيه `sourceDigest` إلى `6807340f1b69474cde1f4a1529ee50891a5912a42f08a6ba8602bd8d56da93f6`. بقي `NOT_READY`، واختبار `--require-ready` ما زال يتوقع الرفض.

## أعداد التسليم الصحيحة

من JSON الفعلي: خريطة M2 تضم **383** مدخل route/method: `existing=303`، `canonical-done=41`، `owner-only=20`، `excluded=12`، `entry=4`، `self=3`. نطاق السجل: `patient=149`، `appointment=13`، والباقي `221` دون نطاق سجل. الجرد الأوسع: **416 method و97 صفحة**. صححت أعداد HANDOFF والخريطة؛ هذه أعداد مصدر وليست نسبة جاهزية أو قبول.

## تحقق محلي معزول

Node **22.23.3**، PostgreSQL **18.4** (`server_version_num=180004`)، قاعدة جديدة صناعية `aqlan_p1_test` على loopback بمنفذ `55437`. لا اتصال ببيانات العيادة. حواجز الهدف الآمن بقيت كما هي.

| الفحص | النتيجة المؤكدة |
|---|---|
| receipt units + evidence + query evidence + inventory + map | **104/104**، 6 ملفات، 14.61 ثانية |
| receipt provenance + performance على PostgreSQL | **12/12**، ملفان، 30.74 ثانية |
| `tsc --noEmit --incremental false` | exit 0 |
| ESLint لملفي الاختبار المعدلين | exit 0 |
| `git diff --check` | exit 0 |

تعرض تشغيل الوحدات المركز الأول بعد الإصلاح لمهلة العملية الفرعية ذات 8 ثوان أثناء تشغيل فحص الأنواع وPostgreSQL بالتزامن (`status=null`، 103 نجاح و1 فشل). نجح التشغيل نفسه منفردًا: 104/104. لم تتغير المهلة أو الاختبار، وحفظ سجل المحاولة أيضًا. ارتباط المهلة بالتنافس على الموارد تفسير مرجح، وليس إثباتًا لسبب داخلي.

أعيد تشغيل الأداء وحده مع `--silent=false --disableConsoleIntercept` لاستخراج إطارات الدليل. تحققت مطابقة BEGIN/END وتسلسل الأجزاء والطول وSHA-256 للملف المستعاد. الدليل [receipt-query-plan.pg18.json](evidence/work-ci-intake-20261030/receipt-query-plan.pg18.json) حجمه **107057** بايت وبصمته `6afcb32a29438499f856c5310cbb01d746c552fe33a0c61267e244e34c2e7d6e`. يثبت بصمات المصدر وSQL الفعلي ومعاملاته الصناعية وخطط EXPLAIN المنقحة. حقول GitHub run محليًا `null` عمدًا.

| الحالة | السياق | SELECTs | زمن القارئ المرصود |
|---|---:|---:|---:|
| سلسلة التصحيح عند الحد، 5 معرفات | 5000 | 2 | 99.12 ms |
| تجاوز الحد وإرجاع محايد | 5001 | 1 | 29.77 ms |
| 1000 معرف، 1000 مريض | 5000 | 2 | 101.94 ms |

لكل حالة اتصال واحد وتحرير واحد، ونجاح صحة النتيجة وعدم الكتابة بعد القارئ وEXPLAIN. البيانات الصناعية: 1002 مريض ضمن النطاق، و15001 حركة ضمنه، إضافة إلى 8000 حركة و8000 سجل تدقيق غير مرتبط. لم تفرض إعدادات مخطط الاستعلام. هذه قياسات محلية مفردة قد تستفيد من الذاكرة المؤقتة؛ ليست ضمان زمن إنتاج أو قبول واجهة.

## إعادة الفحص والأدلة

بواسطة Node 22 واعتماديات `npm ci` المقفلة:

```sh
npx vitest run __tests__/receipt-provenance.test.ts __tests__/receipt-provenance-reader.test.ts __tests__/receipt-provenance-evidence-log.test.ts __tests__/receipt-query-evidence.test.ts scripts/audits/staff-cutover-readiness.test.mjs scripts/audits/m2-route-capability-map.test.mjs
npx vitest run --config vitest.config.postgres.mts __tests__/postgres/receipt-provenance.test.ts __tests__/postgres/receipt-provenance-performance.test.ts
npx vitest run --config vitest.config.postgres.mts __tests__/postgres/receipt-provenance-performance.test.ts --silent=false --disableConsoleIntercept
npx tsc --noEmit --incremental false
npx eslint __tests__/postgres/receipt-provenance.test.ts __tests__/postgres/receipt-provenance-performance.test.ts
```

أوامر PostgreSQL تتطلب `NODE_ENV=test` و`DATABASE_ENVIRONMENT=test` و`CLINIC_TIME_ZONE=Asia/Aden` و`DATABASE_URL`/`TEST_DATABASE_URL` للقاعدة الصناعية المحلية؛ لا تستخدم عنوان نشر. [manifest.json](evidence/work-ci-intake-20261030/manifest.json) يسرد السجلات المحفوظة وأحجامها وبصماتها.

لم تشغل محليًا الحزمة الكاملة أو البناء أو تدقيق الاعتماديات أو رحلات HTTP/المتصفح. نتيجة CI الكاملة تؤخذ من التشغيل الخاص بالرأس المرفوع على WORK، ولا يستبدلها النجاح المركز أعلاه. لا دمج إلى main أو نشر أو تفعيل أو تعديل بيانات حقيقية ضمن هذه الجولة. بعد CI ترسل النتيجة للمراجع؛ تبقى الشريحة التالية بتكليف مستقل.
