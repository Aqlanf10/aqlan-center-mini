# التطوير على Windows

المتطلبات هي Node.js 22 وnpm 10.9–11، وقاعدة PostgreSQL 18 للفحوص التي تحتاج قاعدة فعلية. لا تغيّر إصدار المشروع إلى إصدار Node الموجود على الجهاز؛ استخدم الإصدار المحدد في `.nvmrc`.

## اختيار بيئة التشغيل الصحيحة

من جذر المشروع في PowerShell:

```powershell
pwsh -File .\scripts\local.ps1 run verify:environment
pwsh -File .\scripts\local.ps1 run dev
```

يبحث المشغّل عن Node 22 المثبت، أو نسخة مساحة العمل في `../runtime/node_modules/node/bin/node.exe`. ويمكن اختيار نسخة محمولة صراحةً عبر `AQLAN_NODE_BINARY`. تُستخدم هذه النسخة أيضًا لتشغيل npm والعمليات التابعة، دون تغيير إعدادات الجهاز العامة.

تحافظ `.gitattributes` على تنسيق مصدر موحد بين Windows وLinux، وهو ضروري لاختبارات النصوص وبصمات الملفات المراجعة. يُستدعى npm من ملف JavaScript عبر Node، وتستخدم رحلات التحقق نسخة tsx المثبتة في المشروع؛ لا تعتمد على تشغيل ملفات `npm.cmd` و`npx.cmd` مباشرةً كملفات تنفيذية.

لا تقرأ فحوص Vitest إعدادات `.env.local` الخاصة بالتطوير، وتتجاهلها أدوات الطرفية في وضع `NODE_ENV=test`. تستخدم اختبارات الوحدة محركًا داخل العملية وسر جلسة اصطناعيًا، وتتطلب اختبارات PostgreSQL روابط اختبار صريحة.

## الفحص بقاعدة مستقلة

جهّز PostgreSQL 18 محليًا على المنفذ 54329 مع حساب `ci` وكلمة مرور `ci` وقاعدة `aqlan_p1_test`، أو استخدم خدمة `pg18` في `docker-compose.yml`. هذه قيم لقاعدة اختبار محلية فقط.

```powershell
$env:USE_LOCAL_DB = 'false'
$env:CLINIC_TIME_ZONE = 'Asia/Aden'
$env:DATABASE_URL = 'postgresql://ci:ci@127.0.0.1:54329/postgres?sslmode=disable'
$env:TEST_DATABASE_URL = 'postgresql://ci:ci@127.0.0.1:54329/aqlan_p1_test?sslmode=disable'
pwsh -File .\scripts\local.ps1 run typecheck
pwsh -File .\scripts\local.ps1 run lint
pwsh -File .\scripts\local.ps1 run test:windows
pwsh -File .\scripts\local.ps1 run test:postgres
```

تحتاج بوابات المتصفح Chromium الخاص بـPlaywright، وتحتاج فحوص الطباعة أدوات Poppler (`pdfinfo` و`pdftotext` و`pdftoppm`) في PATH. لا يُعدّ غياب هذه المتطلبات نجاحًا للفحوص.

تُشغّل البوابة الشاملة `npm run verify:full` في بيئة Linux المتوافقة مع النشر. يشغّل `test:windows` اختبارات التطبيق والوحدات وأدوات التطوير، ويستثني ست مجموعات لإثبات حزم نشر Linux تعتمد على Bash وروابط POSIX النسبية ومطابقة مسارات تتبع Next على Linux. تبقى المجموعات الست كاملة في `npm test` ومسار CI الأساسي، ويشغّل `windows-development.yml` مجموعة Windows بشكل مستقل. لا يعني استثناء إثبات نشر Linux من فحص Windows إلغاء إثباته قبل النشر.

على جهاز محدود الذاكرة، شغّل فحص الأنواع والاختبارات والبناء بالتتابع. لا تشغّل خادم التطوير أثناء هذه الفحوص. احتفظ بمساحة كافية للبناء وقاعدة الاختبار والملفات المؤقتة، ويمكن توجيه `TEMP` و`TMP` إلى قرص آخر. لا تستخدم `USE_LOCAL_DB=true` لبوابات PostgreSQL؛ فهو مخصص لتجربة مؤقتة في الذاكرة.
