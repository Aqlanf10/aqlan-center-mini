# تدقيق الثوابت — ما رُحِّل، وما أُجِّل، وما لا يُرحَّل أبدًا

> نتيجة مسحٍ آليٍّ لكل ثابتٍ على مستوى الوحدة في `lib/` و`app/` و`components/`
> (**٢٤٧ ثابتًا** مُعرَّفًا بأحرفٍ كبيرة على المستوى الأعلى)،
> ثم فرزٍ يدويٍّ لكلٍّ منها إلى واحدٍ من ثلاثة تصنيفات.

## التصنيفات الثلاثة

| التصنيف | التعريف | المصير |
|---|---|---|
| **SYSTEM_INVARIANT** | قاعدة سلامةٍ لا قيمة تشغيلية. تُخطئ فلا يبقى ما يُصحَّح به. | **لا يُرحَّل أبدًا.** موثَّقٌ في `docs/SYSTEM_INVARIANTS.md`. |
| **TECHNICAL_CONSTANT** | تفصيلٌ هندسيّ لا معنى له عند المالك (حجم كتلة، طول مفتاح، نمط تاريخ). | **لا يُرحَّل.** تغييرُه عملُ مهندسٍ لا عملُ شاشة. |
| **OPERATIONAL_SETTING** | قرارٌ يخصّ إدارة العيادة. للمالك رأيٌ فيه، وتغييرُه لا يكسر شيئًا. | يُرحَّل — **إن كان له مستهلكٌ فعليّ اليوم**. |

القيد الحاكم (قرار المالك): **بُنيت المنصّة كاملةً، ولم يُرحَّل إليها إلا ما له مستهلكٌ
فعليّ.** فـ`OPERATIONAL_SETTING` بلا مستهلك يُسجَّل في قسم المؤجَّل، لا في المنصّة —
لأنّ رقمًا في شاشةٍ لا يقرؤه كودٌ كذبةٌ مهذَّبة.

---

## CURRENT SETTINGS MIGRATED IN PHASE 1A

ستّة مفاتيح. لكلٍّ منها مستهلكٌ يقرؤه اليوم، وافتراضيُّه **يساوي الثابت الذي حلّ
محلَّه** — فلا يتغيّر سلوك العيادة يوم النشر.

| المفتاح | كان | الملفّ الأصل | مَن يقرؤه اليوم |
|---|---|---|---|
| `ops.late_tolerance_minutes` | `LATE_MINUTES = 15` | `lib/arrivals.ts` | شاشة العمليات — وسم «متأخّر» في مواعيد اليوم |
| `ops.wait_warning_minutes` | `15` داخل `waitLevel` | `lib/flow.ts` | مُنتظَرو اليوم — العتبة الصفراء |
| `ops.wait_critical_minutes` | `30` داخل `waitLevel` | `lib/flow.ts` | مُنتظَرو اليوم — العتبة الحمراء |
| `ops.follow_up_lookback_days` | `FOLLOW_UP_LOOKBACK_DAYS = 30` | `lib/recall.ts` | نافذة المواعيد المعلّقة ومَن لم يحضر (`listOpenPastAppointments` و`listMissedAppointments` معًا) |
| `scheduling.max_days_ahead` | `MAX_DAYS_AHEAD = 60` | `lib/booking.ts` | التحقّق من طلب الحجز في `app/api/book/route.ts` |
| `inventory.expiry_soon_days` | `EXPIRY_SOON_DAYS = 30` | `lib/inventory.ts` | تنبيهات قرب انتهاء الصلاحية |

**الشكل المتَّبع في الترحيل:** الثابت لا يُحذف — يصير **مُعاملًا افتراضيًّا** في
الدالّة الصافية (`waitLevel(minutes, thresholds = DEFAULT_WAIT_THRESHOLDS)`،
`expiryState(date, today, days = EXPIRY_SOON_DAYS)`، `validateBookingRequest(raw,
today, max = MAX_DAYS_AHEAD)`). فمَن يستدعي بلا إعدادٍ يبقى على سلوكه، والمستدعي
الحيّ يمرّر قيمة الإعداد. وقيمةٌ فاسدة أو مقلوبة (تحذيرٌ أكبر من حرِج) ترتدّ إلى
الافتراضيّ بدل أن تُعطّل الشاشة.

**الإثبات:** `scripts/verify-settings.mjs` يضيّق `ops.follow_up_lookback_days` إلى ١٠
فيختفي موعدٌ عمرُه ٢٠ يومًا من القائمة، ويوسّعها إلى ٦٠ فيعود. الإعداد يغيّر السلوك
فعلًا، لا الشاشة وحدها.

---

## DEFERRED SETTINGS — NO CONSUMER YET

قيمٌ تشغيلية بحقّ، وليست في المنصّة اليوم لأنّ لا كودَ يقرؤها كإعداد. لكلٍّ سببٌ صريح.

| المُرشَّح | القيمة الحالية | لماذا أُجِّل |
|---|---|---|
| فترات التحديث التلقائي (`REFRESH_MS` ٢٠ث/٦٠ث، `POLL_MS` ٥ث) | `app/page.tsx`, `app/requests/page.tsx`, `app/messages/page.tsx` | ثلاث شاشاتٍ بثلاث قيم. توحيدُها قرارٌ تشغيليّ يسبق تهيئتها، ومكانه المرحلة ٢. |
| سقف الحجز اليوميّ للهاتف وللمصدر (`MAX_PER_PHONE_PER_DAY = 3`, `MAX_PER_SOURCE_PER_DAY = 60`) | `app/api/book/route.ts` | حدُّ إساءةٍ لا سياسةُ عيادة. رفعُه بلا فهمٍ يفتح البوابة؛ يُعاد النظر مع محرّك المواعيد. |
| نافذة تكرار التذكير (`REMINDER_REPEAT_WINDOW_MS = 12h`) | `lib/reminders.ts` | وحدة الرسائل المؤتمتة لم تُبنَ بعد؛ الفئة مخفيّة حتى أوّل مفتاحٍ حقيقيّ فيها. |
| مدّة الجلسة (`SESSION_DURATION_MS = 12h`) | `lib/sessionCookie.ts` | على الحدّ بين الأمان والتشغيل. تقصيرُها آمن، وإطالتُها ليست كذلك — فتحتاج سقفًا مفروضًا في الخادم قبل أن تصير مفتاحًا. |
| مهلة تأكيد أدوات الوكيل (`TOOL_CONFIRMATION_TTL_MS = 10د`) | `lib/ai-confirmation.ts` | حارسُ سلامةٍ للوكيل الذكي، أقرب إلى الثابت منه إلى الإعداد. |
| سقف حجم الرفع (`DEFAULT_MAX_BYTES = 20MB`) | `lib/storage.ts` | له بالفعل مفتاحٌ مُهيَّأ (`documents.max_megabytes`)؛ الثابت هو الحدّ الأدنى الصلب خلفه، لا نسخةٌ ثانية منه. |
| مدّة الجلسة الافتراضية للزيارة (`DEFAULT_VISIT_MINUTES = 30`) | `lib/workflow.ts` | مستهلكُه محرّك السعة، وهو مؤجَّلٌ إلى المرحلة ٢. |
| مهلة المختبر (`DEFAULT_LAB_DAYS = 7`) | `lib/lab.ts` | مُرحَّلٌ **أصلًا** كـ`lab.default_days`؛ الثابت بقي كخطّ رجعةٍ للاستدعاء بلا إعدادات. |

---

## TECHNICAL_CONSTANT — لا تُرحَّل

عيّنةٌ ممثِّلة؛ الباقي من الطراز نفسه.

| الثابت | الملفّ |
|---|---|
| `BLOCK = 512` (كتلة tar) | `lib/tar.ts` |
| `IV_BYTES = 12`, `KEY_BYTES = 32`, `MAGIC`, `FORMAT_VERSION` | `lib/backupEncryption.ts` |
| `SCRYPT_KEY_LENGTH = 64` | `lib/auth.ts` |
| `DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/` (٢٧ موضعًا) | مسارات `app/api/**` |
| `MONTH = 30.44`, `MONTH_DAYS = 30.44` | `lib/ortho.ts`, `lib/ortho-photos.ts` |
| `NOISE_FLOOR = 0.5` (أرضيّة ضجيج القياس السيفالوميّ) | `lib/cephCompare.ts` |
| `FULL_RATE_BP = 10_000` (نقطة الأساس) | `lib/materialRate.ts` |
| `BASELINE_VERSION`, `MIGRATION_ADVISORY_LOCK_KEY`, نمط اسم الهجرة | `lib/migrations.ts` |
| حدود الطول في الوصفة والتشخيص (`MAX_ITEMS`, `MAX_FIELD`, `MAX_TEXT`, `FIELD_LIMIT`) | `lib/prescription.ts`, `lib/diagnosis.ts` |
| `ADULT_FDI_TEETH`, `PRIMARY_FDI_TEETH` (ترقيم FDI) | `lib/lab.ts` |
| `SESSION_COOKIE`, `PORTAL_COOKIE_NAME` | `lib/sessionCookie.ts` |
| أسماء متغيّرات البيئة والمعرّفات (`*_ENV`, معرّف مشروع Railway) | `lib/productionBackup.ts`, `lib/database-scope.ts` |

`MONTH = 30.44` تحديدًا ليس رقمًا قابلًا للنقاش: هو متوسّط طول الشهر الشمسيّ،
وتغييرُه يفسد حساب مدّة العلاج التقويميّ لا «يُعدّل تفضيلًا».

---

## SYSTEM_INVARIANT — لا تُرحَّل أبدًا

| الثابت | الملفّ | القاعدة التي يحرسها |
|---|---|---|
| دليل الحسابات ورموزه (`AR_ACCOUNT`, `AP_ACCOUNT`, `REVENUE_ACCOUNT`, `FX_ACCOUNT`, …) | `lib/accounting.ts` | القيد المزدوج. حسابٌ يتغيّر رمزُه من شاشةٍ يفسد كل قائمةٍ ماليّة أُصدرت قبله. |
| `SECRET_KEYS = /pass|secret|token|hash|…/i` | `lib/audit.ts` | قناع الأسرار في سجلّ التدقيق. |
| `MINOR_UNITS` وقائمة العملات YER/SAR/USD | المالية | استقلال دفاتر العملات. |
| `SENSITIVE_ACTIONS` | `lib/audit.ts` | تدقيق الأفعال الحرجة لا يُعطَّل بمفتاح. |
| مُشغِّلات append-only (هجرة 0005) | القاعدة | السجلّ المالي لا يُعدَّل ولا يُحذف. |

الفرضُ ليس بالوثيقة وحدها: كل تعريفٍ في `lib/settings-definitions.ts` يحمل
`systemLocked`، والخادم يرفض الكتابة على المقفل **حتى للمدير**.

---

## ما تغيّر في هذا التدقيق عمّا سبقه

تدقيق المرحلة ٠ قال إنّ تغييرات الإعدادات **غير مُدقَّقة**، وكان خطأً — `settings.update`
موجودٌ في `app/api/settings/route.ts` منذ قبل هذه المرحلة، وعدد الأفعال المدقَّقة نحو
٧٤ لا ٢٠. صُحِّح في `12fa062`، وأُبقي أثر الخطأ ظاهرًا في وثيقة المرحلة ٠ بأمر المالك.
ما بقي صحيحًا من الملاحظة: الفعل القديم **مُثقَل** — تستعمله مسارات المختبرات
ومحاسبتها — فلا يصلح وحده للاستخراج، وهذا سبب التمييز المزدوج في المرحلة ١أ.

---

## مراجعة المرحلة ١ب النهائية

- كل عنصر قابل للتحرير في `/settings` مصدره `SETTING_DEFINITIONS` وله مستهلك حالي؛
  لا تعرف الواجهة المفاتيح الستة المرحّلة ولا افتراضياتها يدويًّا.
- الفئات المؤجلة بلا مستهلك تبقى مخفية عبر `visibleCategories()`، ولم يُرحّل أي بند من
  جدول `DEFERRED SETTINGS — NO CONSUMER YET` لمجرد وجود واجهة جديدة.
- لا يوجد محرر key/value أو JSON عام، ولا حذف إعداد، ولا مفاتيح لتعطيل التدقيق أو
  RBAC أو append-only أو قيود التكامل، ولا عرض لقيمة سر.
- `display.announcements` التاريخي ووجهة Google Drive غير الموصولة ظاهران كمقفلين بلا
  تحكم مضلل. إدارة الإعلانات الحقيقية تبقى في سجلاتها المتخصصة.
- `workflow.doctor_financial_view` عُرّف كـBOOLEAN مطابقًا لاستهلاك الخادم للقيمتين
  `true/false`، فتظهر له أداة منطقية بدل حقل نص حر.

*آخر تحديث: المرحلة ١ب — واجهة إدارة الإعدادات المركزية.*
