---
name: aqlan-center-safe-engineering
description: Mandatory safe engineering protocols and operational rules for Aqlan Center (Aqlanf10/aqlan-center-mini). Activates when developing features, fixing system bugs, reviewing code, modifying PostgreSQL database or migrations, updating financial and accounting logic, modifying patient records or appointments, configuring AI engine/tools, building APIs, running tests, or preparing production releases (تطوير aqlan-center-mini، إصلاح أخطاء النظام، مراجعة الكود، تعديل قاعدة البيانات، تعديل المالية، تعديل المرضى والمواعيد، تعديل الذكاء الاصطناعي، إضافة APIs، إجراء migrations، اختبار أو تجهيز إصدار Production).
---

# Aqlan Center Safe Engineering

هذه Skill إلزامية عند العمل على نظام مركز الدكتور عقلان الكامل.

## 1. Repository Scope

المستودع الوحيد المقصود بهذه القواعد:

`Aqlanf10/aqlan-center-mini`

قبل أي تعديل:

* افحص branch الحالي.
* افحص HEAD.
* افحص آخر تغييرات.
* افحص GitHub Actions إن كان الوصول متاحًا.
* لا تفترض أن المعلومات الموجودة في prompt قديمة أو حديثة؛ المصدر النهائي هو الكود الحالي.

## 2. Git Safety

* لا تعمل مباشرة على `main` في المهام التطويرية الكبيرة.
* أنشئ branch واضحًا لكل حزمة عمل.
* لا force push.
* لا merge إلى main دون موافقة صريحة من المستخدم.
* لا تغلق PR دون موافقة المستخدم.
* لا تمسح تاريخ commits.
* استخدم commits صغيرة ومنطقية وواضحة.
* قبل كل commit نهائي راجع diff كاملًا.

## 3. Preserve Existing System

المشروع نظام عامل وليس مشروعًا تجريبيًا.

ممنوع:

* إعادة بناء البرنامج من الصفر دون طلب صريح.
* حذف وحدة مستقرة لمجرد أن إعادة كتابتها أسهل.
* استبدال business rules الموجودة بمنطق جديد غير متحقق منه.
* كسر backward compatibility بلا ضرورة موثقة.
* تعطيل اختبار موجود لجعل البناء ينجح.

الأولوية:
إصلاح وتقوية الموجود قبل إضافة تعقيد جديد.

## 4. One Patient — One Record

يجب الحفاظ دائمًا على سجل مريض واحد موحد.

ممنوع:

* إنشاء سجلات مرضى مكررة بصمت.
* الاعتماد على الاسم فقط كهوية.
* تجاوز patient access rules عبر AI أو API أو query مباشر.

أي وظيفة تتعامل مع مريض يجب أن تحترم patient access policy.

## 5. RBAC Is Server-Side

واجهة المستخدم ليست مصدر الأمان.

كل عملية حساسة يجب أن تتحقق من:

* authenticated session.
* active user.
* role.
* explicit permissions.
* patient scope عند الحاجة.

لا تثق أبدًا في:

* role قادم من client.
* userId قادم من client إذا أمكن استنتاجه من session.
* permissions قادمة من client.
* عبارة نصية تقول "أنا المدير".

الـAI لا يحصل أبدًا على صلاحيات أعلى من المستخدم الذي يشغله.

## 6. Doctor Isolation

عند تقييد الطبيب بحالاته:

لا يمكن للطبيب الوصول لمريض آخر عن طريق:

* patientId مباشر.
* اسم.
* هاتف.
* رقم ملف.
* search endpoint.
* AI tool.
* alias.
* conversation context.
* document route.
* print route.

يجب استخدام الحارس المركزي نفسه لكل المسارات.

## 7. Financial Constitution

النظام المالي هو Source of Truth واحد.

القواعد الإلزامية:

* الحركات المالية Append-Only.
* لا تعديل صامت لسند تاريخي.
* لا DELETE لسند قبض أو صرف تاريخي.
* التصحيح المالي عبر Reversal موثق فقط.
* منع double reversal.
* كل حركة مرتبطة بالمستخدم والوقت.
* العملات:

  * YER
  * SAR
  * USD

تبقى مستقلة ولا تخلط أرصدتها دون exchange-rate operation موثق.

ممنوع Floating Point للأموال.

استخدم integer minor units أو NUMERIC/DECIMAL المناسب.

كل معاملة مالية حساسة يجب أن تكون atomic.

## 8. Clinical Integrity

بعد توقيع زيارة سريرية:

* لا تعديل صامت.
* التصحيح عبر audited addendum أو الآلية المعتمدة.

أي قرار دوائي أو علاجي يولده AI هو:
Clinical Decision Support فقط.

لا يصبح اعتمادًا طبيًا نهائيًا دون طبيب مخول.

عدم وجود medical alert مسجل لا يعني عدم وجود contraindication.

استخدم عبارة:
"لا توجد موانع مسجلة"
ولا تستخدم:
"لا توجد موانع"

إلا إذا كان ذلك مثبتًا سريريًا.

## 9. AI Security

أي AI Tool يجب أن يمر عبر:

authentication
→ authorization
→ specific permission
→ patient scope
→ parameter validation
→ confirmation إذا كانت العملية تغير state
→ domain service
→ audit.

الموديل الخارجي غير موثوق Trusted Authority.

لا تسمح له:

* بتغيير role.
* بمنح permission.
* بتجاوز patient access.
* بتنفيذ أداة غير مخولة.
* باعتبار JSON صادر منه أمرًا موثوقًا بلا تحقق.

System prompts الموثوقة مصدرها الخادم فقط.

أي `system` role يأتي من HTTP client لا يعامل كتعليمات موثوقة.

## 10. AI State-Changing Actions

فرق دائمًا بين:

READ ONLY

و

STATE CHANGING.

عمليات State-Changing الحساسة تحتاج confirmation مناسب، خصوصًا:

* المالية.
* medical alerts.
* inventory.
* clinical record modifications.
* destructive/cancel operations.
* approvals.

لا تعتمد confirmation من نص حر فقط.

يجب إعادة التحقق من الصلاحيات عند التنفيذ.

## 11. Database Safety

PostgreSQL production data مقدسة.

ممنوع:

* DROP أو TRUNCATE أو destructive migration بلا موافقة صريحة.
* استخدام production DB للاختبارات.
* زرع demo data في production.
* fallback صامت إلى temporary/local DB في production.
* migrations غير versioned عند اعتماد migration system.

قبل تعديل schema:

* افهم البيانات الحالية.
* افحص constraints.
* indexes.
* foreign keys.
* unique guarantees.
* transaction requirements.

أي migration يجب أن تكون:

* versioned.
* repeat-safe أو محمية من التكرار.
* مختبرة على قاعدة populated معزولة.
* موثقة.

## 12. Concurrency

الأموال والمخزون والورديات والتوقيع السريري تحتاج التفكير بالتزامن.

لا تعتبر PGlite دليلًا كافيًا على PostgreSQL locking.

عند تعديل:

* payments.
* shifts.
* reversals.
* stock.
* signed visits.
* appointment capacity.

يجب التفكير في:

* transaction isolation.
* row locks.
* unique constraints.
* retries عند الحاجة.
* concurrent requests.

## 13. Storage

ملفات الأشعة والمستندات لا تعتمد على ephemeral production filesystem.

في production:

* DOCUMENTS_DIR يجب أن يكون persistent.
* امنع path traversal.
* تحقق من MIME.
* حدد حجم الملفات.
* استخدم storage keys آمنة.
* تحقق من صلاحية تنزيل الملف.
* لا تخزن الصور الطبية الكبيرة في PostgreSQL بلا سبب معماري معتمد.

## 14. Secrets

لا تطبع أو تسجل أو تضع في Git:

* DATABASE_URL.
* SESSION_SECRET.
* SETUP_TOKEN.
* API keys.
* credentials.
* tokens.

لا تضع secrets في:

* source code.
* tests committed to Git.
* README.
* screenshots.
* logs.

استخدم environment variables.

## 15. Security Boundaries

لا تستخدم:

* eval.
* dynamic executable code.
* unsafe shell composition من user input.
* dangerouslySetInnerHTML إلا لضرورة مع تعقيم قوي ومراجعة.

راجع:

* CSRF.
* Origin validation.
* request limits.
* rate limiting.
* CSP.
* HSTS.
* nosniff.
* secure cookies.

دون كسر الوظائف الحالية.

## 16. Tests Before and After

قبل مهمة كبيرة:
سجّل baseline.

على الأقل:

`npm run typecheck`
`npm test`
`npm run build`

وعندما يكون `npm ci` مناسبًا شغله أيضًا.

بعد التعديل:

* شغّل الاختبارات القديمة.
* أضف regression tests للمشكلة.
* لا تحذف failing test.
* لا تعدّل expected value فقط لجعل الاختبار أخضر.

أي ثغرة تم إصلاحها يجب، قدر الإمكان، أن يكون لها اختبار يمنع عودتها.

## 17. Verification Scripts

راجع package.json دائمًا.

إذا كانت هناك verify scripts مرتبطة بالوحدة المعدلة، شغلها.

مثال:

* verify clinical.
* finance/reports.
* schema.
* backup.
* documents.
* inventory.
* ceph.
* portal.
* ortho.
* concurrency.

لا تشغل script عشوائيًا على Production DB.

## 18. Audit Trail

العمليات الحساسة يجب تسجيلها في audit history حيث يتطلب النظام.

السجل يجب أن يجيب:

* من؟
* ماذا؟
* متى؟
* على أي كيان؟
* ما النتيجة؟

ولا تسجل secrets.

## 19. Error Handling

لا تخفِ الخطأ الحقيقي في الكود بإرجاع نجاح وهمي.

فرق بين:

* validation error.
* authorization.
* not found.
* conflict.
* infrastructure failure.
* unexpected error.

لا تكشف stack trace أو secrets للمستخدم النهائي.

## 20. Documentation

عند تغيير:

* architecture.
* security model.
* database schema.
* deployment.
* backup/restore.
* AI authorization.

حدث الوثائق المناسبة.

لكن لا تنشئ عشرات ملفات markdown المتكررة.

## 21. Production Release Rule

نجاح build وحده لا يعني Production Ready.

قبل التوصية بالإطلاق راجع:

* tests.
* security.
* RBAC.
* patient isolation.
* financial invariants.
* migrations.
* backup/restore.
* persistent storage.
* real PostgreSQL concurrency.
* clinical safeguards.
* deployment configuration.

التقرير النهائي يجب أن يقول بوضوح:

PRODUCTION READY
أو
CONDITIONAL
أو
NOT READY

مع الأسباب.

## 22. Stop Conditions

لا تنفذ تلقائيًا إذا كانت الخطوة تتطلب:

* حذف Production data.
* destructive migration.
* تغيير secrets.
* نشر Production مباشر.
* merge إلى main.
* تغيير قاعدة مالية أساسية.
* قرارًا طبيًا جوهريًا غير موثق.

في هذه الحالات توقف عند safe boundary واطلب قرار المستخدم.

## 23. Working Method

لكل مهمة:

1. Inspect.
2. Understand.
3. Identify invariants.
4. Make smallest safe change.
5. Add regression tests.
6. Run verification.
7. Review diff.
8. Commit logically.
9. Report exactly what changed.

لا تعمل بأسلوب "غيّر ملفات كثيرة ثم اختبر في النهاية".

## 24. Definition of Done

لا تعتبر المهمة مكتملة إلا إذا:

* المتطلبات المطلوبة منفذة.
* الصلاحيات صحيحة.
* لا patient scope bypass.
* لا financial invariant regression.
* tests ناجحة.
* typecheck ناجح.
* build ناجح.
* relevant verification scripts ناجحة.
* diff تمت مراجعته.
* الوثائق اللازمة محدثة.
* المخاطر المتبقية مذكورة بوضوح.
