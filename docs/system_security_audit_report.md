# تقرير التدقيق الأمني والهيكلي السريري الشامل
**نظام عقلان لإدارة مراكز طب وجراحة الأسنان والتقويم**  
**المشروع:** `aqlan-center-mini`  
**الصفة:** كبير مدققي الأمان والجودة السريرية والهندسية لبرمجيات طب الأسنان (Chief Medical QA & Security Auditor)  
**تاريخ التدقيق:** سبتمبر 2026  
**حالة الحزمة البرمجية:** Vitest: 57/57 Passed (644/644 الاختبارات ناجحة) | TypeScript: 0 Errors (Clean)

---

## 1. الملخص التنفيذي (Executive Summary)

تم إجراء تدقيق أمني وهندسي وسريري شامل وعميق لكافة مسارات النظام (`app/api/*`)، ومكونات الواجهة الأمامية (`components/*`)، ونظام الجلسات والصلاحيات (`lib/session.ts`, `lib/auth.ts`, `lib/roles.ts`, `proxy.ts`)، وقاعدة البيانات السريرية والمالية (`lib/db.ts`).

أظهر التدقيق أن النظام يتمتع بأساس سريري وقواعدي متين جداً (سلامة القفل الذري، وتناسق الجداول، وتغطية اختبارات شاملة بنسبة 100%)، إلا أنه يعاني من **ثغرات أمنية حرجة جداً في طبقة التوثيق وإدارة الجلسات تسمح بتصعيد الصلاحيات إلى مدير عام فوراً**، بالإضافة إلى **انقطاع جوهري في دورة حياة الموعد والعمولات** ينتج عنه تصفير عمولات الأطباء وتداخل حساباتهم المالية.

---

## 2. مصفوفة تصنيف المخاطر (Risk Classification Matrix)

| المعرّف | الفئة | مستوى الخطورة | الوصف الموجز | الأثر السريري / المالي |
| :--- | :--- | :---: | :--- | :--- |
| **SEC-01** | أمان الجلسات | **حرجة جداً (Critical)** | قبول ترويسة `x-session-user` غير الموقعة وافتراض جلسة مدير عام تلقائياً عند غياب التوثيق | يستطيع أي مستخدم أو فاحص منح نفسه صلاحية `admin` والاطلاع على أرباح المركز والتحكم الكامل. |
| **SEC-02** | مصادقة الدخول | **حرجة جداً (Critical)** | وجود كلمات مرور خلفية ثابتة (Hardcoded Passwords) صالحة على مسار `/api/auth/login` | اختراق مباشر لأي حساب (`admin`, `doctor`, `reception`) باستخدام كلمات سهلة متجاوزة الهاش الفعلي في جميع البيئات. |
| **SEC-03** | سرية المالية | **عالية (High)** | تسريب كشف الصندوق والمختبرات وعمولات الزملاء للأطباء عبر مسارات مالية غير محمية | يرى الطبيب إيرادات الصندوق، وأرباح 30 وردية سابقة، وعمولات زملائه عبر `reconciliation` و `lab-accounting` و `parties`. |
| **SEC-04** | ضبط العمليات | **عالية (High)** | إمكانية وسم الفواتير كـ `paid` وإصدار استرداد نقدي من الاستقبال دون سند مالي أو إذن مدير | تلاعب مالي محتمل عبر إقفال الفواتير دون دفع، أو تسجيل استرداد نقدي دون موافقة المدير. |
| **SEC-05** | حماية المرضى | **متوسطة (Medium)** | ثغرة IDOR في ملفات المرضى عند عدم ربط حساب الطبيب بجهة (`partyId == null`) | إذا أنشئ حساب طبيب دون ربطه بجهة في الدليل، يتم تعطيل العزل السريري ويتمكن من فتح كل ملفات المرضى. |
| **ARCH-01** | هندسة سريرية | **عالية (High)** | غياب اختيار الطبيب في `QuickAppointmentModal` وشاشة المواعيد، وعدم توريثه للزيارة | تصفير تلقائي لعمولات الأطباء؛ تسجيل المواعيد والزيارات دون `doctorId` يؤدي لضياع أتعاب الكادر الطبي. |
| **ARCH-02** | هندسة سريرية | **متوسطة (Medium)** | تكديس مفرط للمكونات في تبويب "العلاج" داخل ملف المريض | إجهاد بصري وتشغيلي للطبيب العام؛ تحميل متزامن للتقويم، السيفالو، المخطط، الخطط، المعمل، والمستهلكات في آن واحد. |
| **ARCH-03** | إدارة الموارد | **تحسين سريري** | تفكك إدارة الأطباء والمستخدمين وعدم التوليد التلقائي لجهة الطبيب (`parties`) | صعوبة وصول المدير لشاشة المستخدمين؛ وتشتت إدارة الطبيب بين جدول `users` وجدول `parties`. |

---

## 3. التدقيق الأمني المعمق (Detailed Security Audit)

### 3.1 [SEC-01] ثغرة انتحال الهوية وتصعيد الصلاحيات التلقائي للمدير
- **الموقع:** [`lib/session.ts`](file:///C:/Users/Aqlan%20Alkamel/.gemini/antigravity/scratch/aqlan-center-mini/lib/session.ts#L28-L55) و [`components/SessionProvider.tsx`](file:///C:/Users/Aqlan%20Alkamel/.gemini/antigravity/scratch/aqlan-center-mini/components/SessionProvider.tsx#L69-L73)
- **الآلية:**
  1. يقوم ملف `lib/session.ts` بقراءة ترويسة `x-session-user` واعتماد كائن JSON المرسل من العميل دون أي فحص لتوقيع HMAC الرقمي:
     ```typescript
     const sessionHeader = headerList.get("x-session-user");
     if (sessionHeader) {
       const parsed = JSON.parse(sessionHeader);
       if (parsed.username) {
         return {
           userId: parsed.username === "doctor" ? 2 : parsed.username === "reception" ? 3 : 1,
           username: parsed.username,
           role: parsed.role || "admin",
           expiresAt: Date.now() + 86400000,
         };
       }
     }
     ```
  2. والأخطر من ذلك، إذا لم يقدم الطلب أي كوكي أو ترويسة، يقوم التابع بإرجاع جلسة مدير كاملة الصلاحيات تلقائياً:
     ```typescript
     return {
       userId: 1,
       username: "admin",
       role: "admin",
       expiresAt: Date.now() + 86400000 * 30,
     };
     ```
  3. في الواجهة الأمامية، يقوم `SessionProvider.tsx` بتخزين بيانات المستخدم في `localStorage` مع ميزة `switchRole` الجاهزة، ويحقن ترويسة `x-session-user` في كل استدعاء `fetch`.
- **التقييم:** ثغرة مصادقة حرجة تكسر مبدأ الدفاع في العمق وتلغي نموذج الصلاحيات (RBAC) برمته.

### 3.2 [SEC-02] كلمات المرور الخلفية المبرمجة صراحةً (Hardcoded Passwords)
- **الموقع:** [`app/api/auth/login/route.ts`](file:///C:/Users/Aqlan%20Alkamel/.gemini/antigravity/scratch/aqlan-center-mini/app/api/auth/login/route.ts#L68-L74)
- **الآلية:**
  يحتوي مسار تسجيل الدخول على استثناء صريح تحت مسمى `isDevPreviewMatch`:
  ```typescript
  const isDevPreviewMatch = !isStandardMatch && (
    (user.username === "admin" && ["admin", "admin123", "admin123456", "123456", "aqlan2026", "password", "aqlan"].includes(password)) ||
    (user.username === "doctor" && ["doctor", "doctor123", "doctor123456", "123456"].includes(password)) ||
    (user.username === "reception" && ["reception", "reception123", "reception123456", "123456"].includes(password)) ||
    (user.username === "shots" && password === "shots-only-local-1234")
  );
  ```
  هذا الفحص غير مقيد بـ `process.env.NODE_ENV !== "production"`. مما يتيح لأي شخص تخمين كلمات المرور البديهية واختراق حساب الإدارة أو الاستقبال مباشرة حتى لو قام المدير بتغيير كلمة المرور في قاعدة البيانات.

### 3.3 [SEC-03] تسريب بيانات مالية حساسة ومؤشرات المركز للأطباء
- **المواقع:**
  - [`app/api/finance/reconciliation/route.ts`](file:///C:/Users/Aqlan%20Alkamel/.gemini/antigravity/scratch/aqlan-center-mini/app/api/finance/reconciliation/route.ts#L7-L10): يتم استيراد `isAdmin` في السطر 4 ولكنه **لا يُستدعى مطلقاً في دالة GET**! يستطيع أي طبيب أو موظف استقبال استدعاء المسار ورؤية رصيد الصندوق الافتتاحي، وحركات الدخل والمصروفات لكافة العملات، وسجل الـ 30 وردية السابقة بأرقامها الكاملة.
  - [`app/api/finance/lab-accounting/route.ts`](file:///C:/Users/Aqlan%20Alkamel/.gemini/antigravity/scratch/aqlan-center-mini/app/api/finance/lab-accounting/route.ts#L22-L30): دالة `GET` تكتفي بفحص الجلسة دون أي فحص للأدوار، مسربةً إجمالي ديون المركز للمختبرات (`totalOwedMinor`, `totalDueMinor`).
  - [`app/api/finance/lab-reconciliation/route.ts`](file:///C:/Users/Aqlan%20Alkamel/.gemini/antigravity/scratch/aqlan-center-mini/app/api/finance/lab-reconciliation/route.ts#L30-L33): دالة `GET` تكشف أسعار التكلفة الحقيقية لأعمال المعامل (`systemCostMinor`)، متجاوزة صراحةً سياسة "المالية المخفية" (`canViewCostPrices = false`).
  - [`app/api/parties/route.ts`](file:///C:/Users/Aqlan%20Alkamel/.gemini/antigravity/scratch/aqlan-center-mini/app/api/parties/route.ts#L12-L19): مسار `GET /api/parties?kind=doctor` يعيد قائمة الأطباء مع نسبة عمولة كل طبيب (`commission_percent`) لأي حساب مسجل، منتهكاً سرية عقود العمل بين المركز وأطبائه.

### 3.4 [SEC-04] تلاعب الفواتير والاستردادات النقدية
- **الموقع:** [`app/api/invoices/[id]/route.ts`](file:///C:/Users/Aqlan%20Alkamel/.gemini/antigravity/scratch/aqlan-center-mini/app/api/invoices/%5Bid%5D/route.ts#L48-L56) و [`app/api/payments/route.ts`](file:///C:/Users/Aqlan%20Alkamel/.gemini/antigravity/scratch/aqlan-center-mini/app/api/payments/route.ts#L61)
- **الآلية:**
  1. في مسار الفواتير، يُشترط دور المدير فقط عند `status === 'cancelled'`، بينما يُسمح للاستقبال (`canHandleMoney`) بإرسال `status: 'paid'`. هذا الإجراء يقوم بتعديل حالة الفاتورة في قاعدة البيانات مباشرة إلى "مسددة" دون إنشاء سند قبض مالي أو قيد في الصندوق!
  2. في مسار المدفوعات، تستطيع الاستقبال إنشاء استرداد مالي (`kind: 'refund'`) وإخراج مبالغ نقدية من الصندوق دون اشتراط موافقة مسبقة أو مصادقة ثنائية من المدير العام.

### 3.5 [SEC-05] قصور عزل بيانات المرضى في حال غياب ربط الطبيب بجهته (IDOR)
- **الموقع:** [`app/api/patients/[id]/route.ts`](file:///C:/Users/Aqlan%20Alkamel/.gemini/antigravity/scratch/aqlan-center-mini/app/api/patients/%5Bid%5D/route.ts#L27-L37)
- **الآلية:**
  الدالة `doctorBlocked` تفحص:
  ```typescript
  if (session.role === "doctor" && typeof session.partyId === "number" && session.partyId) {
    // التحقق من ملكية الطبيب للمريض
  }
  return null; // فك الحظر تلقائياً إذا لم يكن partyId رقماً صالحاً!
  ```
  إذا تم تسجيل الطبيب دون تعيين `partyId` في سجله، فإن الشرط يتخطى الفحص بالكامل ويُسمح للطبيب بالوصول إلى كافة ملفات المرضى وتعديلها دون قيد.

---

## 4. التدقيق الهيكلي والتشغيلي والسريري للعيادة (Clinical & Architectural Audit)

### 4.1 [ARCH-01] انقطاع حلقة الحجز والعمولات (The Broken Commission Loop)
**وصف المشكلة السريرية والمالية:**
تم تتبع مسار حجز المريض من لحظة الاستقبال وحتى الفاتورة، ووُجد انقطاع ثلاثي المراحل:
1. **نافذة الحجز السريع [`QuickAppointmentModal.tsx`](file:///C:/Users/Aqlan%20Alkamel/.gemini/antigravity/scratch/aqlan-center-mini/components/QuickAppointmentModal.tsx#L112-L123):** لا تحتوي على أي حقل لاختيار الطبيب المعالج (`doctorId`). كما أن شاشة المواعيد العامة [`app/appointments/page.tsx`](file:///C:/Users/Aqlan%20Alkamel/.gemini/antigravity/scratch/aqlan-center-mini/app/appointments/page.tsx) تخلو تماماً من كلمة "طبيب" ولا تتيح التصفية أو الإسناد لطبيب معين.
2. **تسجيل وصول المريض [`arriveAppointment` في `lib/db.ts`](file:///C:/Users/Aqlan%20Alkamel/.gemini/antigravity/scratch/aqlan-center-mini/lib/db.ts#L2741-L2760):**
   عندما يصل المريض ويتم نقله لقائمة الانتظار، يتم استعلام جدول `appointments` وإدراج سجل في `visits` دون نسخ حقل `doctor_id`، حتى لو كان الموعد مسنداً لطبيب:
   ```sql
   INSERT INTO visits (patient_name, patient_phone, patient_id, appointment_id)
   VALUES ($1, $2, $3, $4)
   ```
   وبذلك تُسجل الزيارة السريرية بدون طبيب (`visits.doctor_id = NULL`).
3. **توليد الفاتورة واحتساب العمولة [`commissionReport`](file:///C:/Users/Aqlan%20Alkamel/.gemini/antigravity/scratch/aqlan-center-mini/lib/db.ts#L6882):**
   يعتمد تقرير العمولات حصرياً على `invoice_items.doctor_id`. وبسبب عدم توريث الطبيب من الموعد للزيارة، تبقى بنود الفاتورة بدون `doctorId`، مما يؤدي إلى ظهور عمولة الطبيب بنسبة **صفر (0.00)** في تقارير الاستحقاقات وتكدس الإيرادات كدخل غير مخصص للعيادة.

**الحل الجذري الموصى به:**
- إضافة حقل منسدل إلزامي/تلقائي لاختيار الطبيب في `QuickAppointmentModal.tsx` و `app/appointments/page.tsx`.
- تحديث دالة `arriveAppointment` في `lib/db.ts` لتقوم بنسخ `a.doctor_id` من الموعد إلى `visits.doctor_id`.
- عند إنشاء فاتورة جديدة من زيارة سريرية، يتم تعيين `it.doctor_id` تلقائياً لطبيب الزيارة.

---

### 4.2 [ARCH-02] تكديس وهيكلة تبويب العلاج في ملف المريض
- **الموقع:** [`app/patients/[id]/page.tsx`](file:///C:/Users/Aqlan%20Alkamel/.gemini/antigravity/scratch/aqlan-center-mini/app/patients/%5Bid%5D/page.tsx#L756-L800)
- **الملاحظات:**
  عند فتح تبويب `treatment`، يتم تحميل ورسم خمس وحدات عملاقة معاً في شاشة واحدة متراصة عمودياً:
  1. خطة العلاج والتسعير (`PatientPlans`).
  2. المخطط السني التشريحي بـ 32 سناً وتفاصيله الدقيقة (`DentalChart`).
  3. كابينة تقويم الأسنان والسيفالومتري الكاملة (`PatientOrtho` متضمنة WebCeph ومراحل T1-T4 والأسلاك).
  4. سجل طلبات المختبر النشطة (`PatientLabOrders`).
  5. المستهلكات المصروفة للمريض (`PatientMaterials`).
- **الأثر السريري:**
  - إجهاد بصري شديد (Cognitive Overload) للطبيب عند الرغبة في معاينة الأسنان فقط.
  - إبطاء الاستجابة على الأجهزة اللوحية (iPads/Tablets) في العيادة بسبب تحميل عشرات عناصر الـ Canvas والـ SVG دفعة واحدة.
  - عدم ملاءمة واجهة التقويم المعقدة للمرضى الذين يتلقون علاجات أسنان عامة فقط (حشوات، جذور).
- **التوصية:** تقسيم تبويب العلاج إلى تبويبات فرعية مرنة (Sub-Tabs):
  - `[ مخطط الأسنان والخطة العلاجية ]`
  - `[ كابينة التقويم والسيفالومتري ]` (تُعرض كقسم مخصص أو عند تفعيل حالة تقويم)
  - `[ سجل المعامل والمواد ]`

---

### 4.3 [ARCH-03] سهولة إدارة الأطباء والموظفين وتكامل الهوية السريرية
- **الموقع:** [`app/settings/users/page.tsx`](file:///C:/Users/Aqlan%20Alkamel/.gemini/antigravity/scratch/aqlan-center-mini/app/settings/users/page.tsx) و [`app/settings/page.tsx`](file:///C:/Users/Aqlan%20Alkamel/.gemini/antigravity/scratch/aqlan-center-mini/app/settings/page.tsx#L126-L198)
- **الملاحظات:**
  1. شاشة المستخدمين والأطباء معزولة وغير بارزة في بطاقات الإعدادات الرئيسية، حيث تم إبراز المعامل والمصروفات والأسعار وتجاهل بطاقة "المستخدمين والأطباء".
  2. عند إنشاء مستخدم جديد بدور "طبيب" عبر `createStaffUser` في `users`، لا يتم إنشاء سجل مناظر له في جدول الجهات `parties` (الذي تعتمد عليه كشوفات العمولات والفواتير). يجب على المدير إنشاء الحساب ثم الذهاب لجدول آخر لربطه، مما يسبب أخطاء عدم توافق وتداخل في البيانات.
- **التوصية:**
  - أتمتة إنشاء جهة الطبيب (`parties`) عند إنشاء حساب مستخدم بدور `doctor` وربط `party_id` تلقائياً.
  - إضافة بطاقة بارزة ومباشرة في شاشة الإعدادات الرئيسية لإدارة الكادر الطبي والصلاحيات.

---

## 5. خطة المعالجة الفورية الموصى بها (Immediate Remediation Plan)

### المرحلة 1: الإغلاق الأمني الفوري (خلال 24 ساعة)
1. **تطهير `lib/session.ts`:**
   - إلغاء قراءة `x-session-user` نهائياً من الطلبات الحية، والاعتماد الحصري على التوقيع الرقمي الصارم للكوكي الموقعة `aqlan_session` أو ترويسة `Authorization: Bearer <signed_token>`.
   - إزالة السلوك الافتراضي الذي يعيد جلسة مدير عند فشل التوثيق، وإرجاع `null` ورفض الطلب فوراً بـ `401 Unauthorized`.
2. **إزالة الباب الخلفي لكلمات المرور في `app/api/auth/login/route.ts`:**
   - حذف مصفوفة `isDevPreviewMatch` وحظر الدخول بغير كلمة المرور المجزأة بـ `scrypt` في قاعدة البيانات.
3. **تحصين مسارات المالية:**
   - إضافة فحص `if (!isAdmin(session.role)) return forbidden();` في `GET /api/finance/reconciliation` و `GET /api/finance/lab-accounting` و `GET /api/finance/lab-reconciliation`.
   - تنقية مسار `GET /api/parties?kind=doctor` لحجب حقل `commission_percent` عن غير المدراء.
4. **تقييد صلاحيات الاستقبال في الفواتير:**
   - قصر تعديل حالة الفاتورة إلى `paid` على الدفع الفعلي فقط المرتبط برقم سند مقبوضات مسجل، وحظر تعديلها يدويًا عبر `PATCH /api/invoices/[id]`.

### المرحلة 2: ضبط المسار السريري والعمولات (خلال 48 ساعة)
1. **تحديث حجز المواعيد:**
   - تعديل `components/QuickAppointmentModal.tsx` لإضافة قائمة منسدلة تسحب قائمة الأطباء النشطين وتلزم باختيار الطبيب أو تحدد الطبيب الحالي تلقائياً.
   - تعديل `app/appointments/page.tsx` لعرض اسم الطبيب في بطاقة الموعد مع مرشح علوي (Filter by Doctor).
2. **توريث الطبيب في دورة الزيارة السريرية:**
   - تعديل استعلام `arriveAppointment` في `lib/db.ts` لنسخ `doctor_id` من الموعد إلى الزيارة.
   - ربط فواتير العيادة تلقائياً بطبيب الزيارة لضمان احتساب العمولات بدقة 100%.

### المرحلة 3: إعادة هيكلة الواجهة السريرية (خلال أسبوع)
1. **تنظيم تبويب العلاج:**
   - تفعيل تبويبات داخلية فرعية (Sub-tabs) لملف المريض تفصل بين (مخطط الأسنان والخطة العامة) و (كابينة تقويم الأسنان والسيفالو) و (المعمل والمستهلكات).
2. **أتمتة إدارة الطاقم:**
   - ربط إنشاء الطبيب في شاشة المستخدمين بتوليد سجل جهة فوري في `parties` لضمان عدم وجود أي طبيب بلا `partyId`.

---

## 6. خاتمة وتوصية الاعتماد

النظام يمتلك إمكانات سريرية متقدمة وفريدة (مثل كابينة تقويم الأسنان WebCeph، ونظام حجز الكراسي الذري، والتوافق المالي المزدوج)، لكن الثغرات الأمنية وانقطاع دورة العمولات الحالية تشكل خطراً تشغيلياً على بيانات المركز واستحقاقات أطبائه.  
**يوصى بالشروع الفوري في تطبيق حزمة المعالجات الأمنية والسريرية المذكورة أعلاه لرفع مستوى النظام إلى معايير الاعتماد الطبي والسيبراني الاحترافي.**
