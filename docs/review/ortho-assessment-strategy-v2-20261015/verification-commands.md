# إعادة التحقق محليًا

جميع قواعد هذه الدفعة اصطناعية على PostgreSQL18.6 محلي، وعلى Node22.23.3. لا تستخدم ملف بيئة تطوير أو إنتاج. `TEST_DATABASE_URL` يجب أن يشير إلى قاعدة الخدمة المؤقتة `aqlan_p1_test`؛ fixtures تتحقق من الخادم والهوية وتنشئ قواعدها الخاصة وتزيلها. علامتا reset أدناه تخصان هذا الخادم المؤقت فقط، وهما نفس عقد CI القائم.

في البيئة المستخدمة هنا، Node22 موجود في `/workspace/.cloud-tools/node_modules/.bin`، والخادمان المملوكان للاختبار مربوطان بـloopback على55432 و55433. هذه بيانات اختبار محلية، وليست بيانات اتصال عيادة.

```bash
export PATH=/workspace/.cloud-tools/node_modules/.bin:$PATH
export TEST_DATABASE_URL='postgresql://ci:ci@127.0.0.1:55433/aqlan_p1_test?sslmode=disable'
export DATABASE_ENVIRONMENT=test
export SESSION_SECRET='ortho-local-test-synthetic-secret-at-least-32-characters'
export CATEGORY_HISTORY_CI_DISPOSABLE_FIXTURE=1
export MANUAL_CASH_CI_DISPOSABLE_FIXTURE=1
npm test
npm run test:postgres
npm run typecheck
npm run lint
npm run build
```

اختبار المتصفح بعد البناء، بتشغيل منفصل عن اختبارات HTTP أخرى تستخدم اسم قاعدة الاختبار نفسه:

```bash
export PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium
npm run test:security-http -- __tests__/security-http/ortho-assessment-strategy-v2-browser.test.ts __tests__/security-http/hr-temporal-history-ui.test.ts
```

المستعرض الحقيقي يتصل بالخادم المبني، ويستخدم تسجيل الدخول الفعلي وPostgreSQL. لا route mocks للحفظ؛ يُفقد رد POST بعد نجاح `route.fetch()` الحقيقي، ثم يعاد نفس الأمر ويُفحص عدم تكرار الصفوف. اختبار PostgreSQL يحاكي نقل cookies/headers فقط لتقديم توكن موقع؛ requireSession والحساب والصلاحيات وSQL حقيقية.

فحوص المخطط والرحلات التشغيلية تنشئ قواعد جديدة؛ لا تُشغّل مولد disclosure بالتزامن مع اختبارات schema-ownership على الخادم نفسه، لأن الاختبارات تتحقق من تنظيف جميع قواعدها المؤقتة:

```bash
export DATABASE_URL='postgresql://ci:ci@127.0.0.1:55432/postgres?sslmode=disable'
export TEST_DATABASE_URL='postgresql://ci:ci@127.0.0.1:55432/aqlan_p1_test?sslmode=disable'
npm run schema:ownership:verify -- --output /tmp/ortho-schema-ownership.json
npm run schema:contract:verify
npm run verify:ci
npm run build:preflight
npm run scan:money
npm run ci:scan:body
npm run ci:audit
```

التدقيق الأخير أحمر في التشغيل المحفوظ؛ لا تستبدله بتدقيق production-only أو بتوسيع الاستثناء. مرشح disclosure أُنتج بأداة `scripts/generate-preflight-disclosure.ts` من قواعد فارغة على خادم مستقل، وقورنت كل مجموعاته بالعقد السابق: إضافات فقط، دون إزالة بصمة أو تعلم من قاعدة حية. الاختبارات تعيد إنتاجه وتتحقق من إخفاء الأسماء والقيم غير المعروفة.
