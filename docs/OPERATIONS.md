# OPERATIONS — Aqlan Center Mini

التشغيل اليومي والطوارئ لنظام مركز عقلان على Railway.
Daily operations and emergency runbooks for the Aqlan Center system on Railway.

- **Production URL**: https://web-production-23f82.up.railway.app
- **Railway project**: `aqlan-center-mini` (environment: `production`)
- **Services**: `web` (Next.js) + `Postgres` (PostgreSQL 16+)
- **Health check**: `GET /api/health` → `200 {"status":"ok","database":"connected"}`
- **Migrations**: applied automatically on every deploy by the pre-deploy
  command `npm run db:release` (migrate → verify → seed-if-missing)

---

## Daily Operation — التشغيل اليومي

### تسجيل الدخول (الاستقبال/الطبيب/المدير)

1. افتح رابط النظام (احتفظ به محفوظًا في المتصفح).
2. سجّل الدخول باسم المستخدم وكلمة المرور الخاصة بك.
3. نسيت كلمة المرور؟ مدير النظام فقط يستطيع إعادة تعيينها:
   **الإعدادات ← فريق العمل ← إعادة تعيين كلمة المرور**.
4. الجلسة تنتهي تلقائيًا — إن ظهرت صفحة الدخول أثناء العمل سجّل من جديد.

### فحص الصحة اليومي (قبل بدء العمل — دقيقة واحدة)

```bash
curl -s https://web-production-23f82.up.railway.app/api/health
# المتوقع: {"status":"ok","database":"connected",...}
```

- `ok` ← النظام جاهز.
- أي شيء آخر ← راجع قسم «Emergency DB recovery» أدناه ولا تبدأ التسجيل حتى يعود `ok`.

### صلاحيات الوصول (مَن يدخل أين)

| الدور | يستطيع | لا يستطيع |
|-------|---------|------------|
| ADMIN | كل شيء + التقارير + سجل العمليات + الإعدادات + إدارة الفريق | — |
| DOCTOR | المرضى، المواعيد، الزيارات، المتابعة، المالية | إدارة الفريق، التقارير، سجل العمليات |
| RECEPTION | المرضى، المواعيد، اليوم، المتابعة/التواصل | المالية، التقارير، سجل العمليات، إدارة الفريق |

- إن ترك موظف العمل: **إعدادات ← فريق العمل ← تعطيل** فورًا (يُنهي جلساته فورًا).

---

## Backup

### الحالة الحالية / Current status (تحديث 2026-08-27)

| ماذا | الحالة |
|------|--------|
| Railway automated backups | ❌ غير مفعّلة — خطة HOBBY + صلاحيات الـ API مرفوضة (تم الاختبار فعليًا) |
| Point-in-Time Recovery (PITR) | ❌ معطّل (يتطلب خطة أعلى + Bucket) |
| Public TCP للقاعدة | ❌ معطّل (لذا يحتاج pg_dump نفقًا — الخطوات أدناه) |
| **النسخ الاحتياطي اليدوي أدناه** | ✅ **المسار المعتمد — نفّذه يوميًا — تم التحقق من صحته عمليًا** |

> **نتيجة فحص API الفعلي (2026-08-27):** استدعاءات
> `volumeInstanceBackupCreate` / `volumeInstanceBackupScheduleUpdate`
> عبر توكن المشروع ترجع `Not Authorized` — أي أن التفعيل يحتاج
> تدخلًا يدويًا من مالك الحساب من الـ Dashboard.

> **لتفعيل النسخ التلقائي مستقبلًا (قرار المالك):**
> Railway Dashboard ← مشروع `aqlan-center-mini` ← خدمة `Postgres` ←
> تبويب **Data/Backups** ← تفعيل **Daily Backup**.
> على خطة HOBBY يُحتسب مقابل تخزين النسخ (قاعدة بالغة الصغر الآن ≈ أقل من سنت).
> لا تُفعّل أي ترقية خطة دون موافقة المالك.

> **إثبات صحة الـ runbook (2026-08-27):** تم تنفيذ الدورة الكاملة
> pg_dump ← إنشاء قاعدة مؤقتة ← pg_restore ← فحص عدد الصفوف ← حذف
> القاعدة المؤقتة، على بيئة اختبار محلية ببيانات وهمية — النتيجة PASS.

### النسخ الاحتياطي اليدوي (pg_dump) — يوميًا

من أي جهاز فيه Railway CLI + Docker (أو psql client tools):

```bash
# 1) سجّل الدخول مرة واحدة
railway login

# 2) افتح نفقًا إلى قاعدة الإنتاج وحدّد المنفذ
railway connect Postgres --environment production --tunnel-only -P 15432
# يطبع: postgresql://postgres:PASSWORD@localhost:15432/railway

# 3) في نافذة ثانية، صدّر نسخة كاملة (نفس الأمر يعمل مع psql client فقط)
pg_dump "postgresql://postgres:PASSWORD@localhost:15432/railway" \
  --format=custom \
  --file="aqlan-backup-$(date +%F-%H%M).dump"

# 4) اضغط Ctrl+C لإغلاق النفق، ثم انقل الملف إلى تخزين خارجي
#    (قرص خارجي / Google Drive / أي مكان ليس على نفس الجهاز)
```

**بدون Docker/psql — عبر حاوية Postgres نفسها داخل Railway:**
من Railway Dashboard → خدمة `Postgres` → Deployments → آخر deployment →
**Settings → Command** شغّل مؤقتًا:
`pg_dump -U postgres -Fc railway > /data/backup.dump` مع توصيل Volume،
ثم أعد الأمر الافتراضي فورًا. (للاستخدام النادر فقط.)

### ماذا يشمل النسخ

- كل الجداول: المرضى، المواعيد، الزيارات، المالية، المستخدمون، سجل التدقيق.
- صيغة `custom` تسمح باستعادة انتقائية لاحقًا (`-t table`).

### جدول مقترح

| التكرار | متى | الاحتفاظ |
|---------|-----|----------|
| يومي | نهاية يوم العمل | 14 نسخة |
| أسبوعي | الخميس | 8 نسخ |
| شهري | آخر يوم بالشهر | 12 نسخة |

---

## Restore — الاستعادة

### استعادة كاملة (فقدان كامل للبيانات)

```bash
# 1) نفق إلى قاعدة الإنتاج
railway connect Postgres --environment production --tunnel-only -P 15432

# 2) استعد النسخة (احذر: يمسح البيانات الحالية)
pg_restore "postgresql://postgres:PASSWORD@localhost:15432/railway" \
  --clean --if-exists \
  --no-owner --no-privileges \
  "aqlan-backup-YYYY-MM-DD-HHMM.dump"
```

### استعادة جدول واحد (مثال: جدول المرضى فقط)

```bash
pg_restore "postgresql://postgres:PASSWORD@localhost:15432/railway" \
  --clean --if-exists --no-owner --no-privileges \
  --table=patients \
  "aqlan-backup-YYYY-MM-DD-HHMM.dump"
```

> ⚠️ استعادة `users`/`sessions` تُسقط كلمات المرور الحالية إن كانت النسخة
> أقدم من آخر تغيير كلمة مرور — بعد الاستعادة، أعد تعيين كلمات المرور
> من Settings → Staff.

### اختبار الاستعادة (موصى به شهريًا)

أنشئ environment مؤقتة في Railway (أو DB محلية عبر Docker) واستعد فيها
النسخة — لا تختبر الاستعادة على الإنتاج أبدًا إلا أثناء كارثة فعلية:

```bash
docker run -d --name aqlan-restore-test -e POSTGRES_PASSWORD=test -p 15433:5432 postgres:16
pg_restore "postgresql://postgres:test@localhost:15433/postgres" \
  --no-owner --no-privileges "aqlan-backup-XXXX.dump"
docker exec -it aqlan-restore-test psql -U postgres -c "select count(*) from patients;"
docker rm -f aqlan-restore-test
```

---

## Emergency DB recovery — التعامل مع طوارئ القاعدة

### 1. القاعدة لا تقبل اتصالات / تطبيق يرجع 503

```bash
curl -s https://web-production-23f82.up.railway.app/api/health
# {"status":"error","database":...} أو 503
```

- Railway Dashboard → `Postgres` → **Metrics**: هل الذاكرة/التخزين ممتلئة؟
- **Deployments**: هل آخر redeploy للقاعدة أعاد تشغيلها؟ انتظر ~60 ثانية.
- إذا استمر: Railway Dashboard → `Postgres` → Settings → **Restart**.

### 2. حذف بيانات بالخطأ (DROP/DELETE)

1. **أوقف استخدام النظام فورًا** (أبلغ الموظفين).
2. خذ نسخة فورية من الحالة الحالية قبل أي استعادة (pg_dump فوق).
3. استعد الجدول المتأثر من آخر نسخة سليمة (أعلاه).
4. تحقق من التطابق: افتح ملفات عدة مرضى وقارن مع الورق.

### 3. نشر migration خاطئ

- `web` deployments في Railway: اضغط **Redeploy** على آخر deployment سليم
  (لا يرجع الـ schema تلقائيًا — استخدم نسخة pg_dump للاستعادة schema-level).

---

## What to do if deployment fails — فشل النشر

### التعرف على الفشل

- Railway Dashboard → `web` → Deployments: حالة **FAILED**.
- أو من CLI: `railway deployment --service web --environment production`

### الأخطاء الشائعة

| الخطأ في build logs | السبب | الحل |
|---------------------|-------|------|
| `Missing: @esbuild/...` | npm 9 مع node 24 | ثبّت أن البناء يستخدم Dockerfile الموجود (لا تحذفه) |
| `expected tables missing` في [release] | migrations لم تُطبق | تحقق من متغير `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` |
| `ADMIN_PASSWORD must be at least 8` | كلمة مرور bootstrap قصيرة | حدّث `ADMIN_PASSWORD` في Variables ثم Redeploy |
| Health check فشل بعد النشر | التطبيق لم يبدأ | Logs → Deployments؛ غالبًا `DATABASE_URL` مفقود |

### التراجع الآمن (Rollback)

1. Railway → `web` → Deployments → آخر deployment **SUCCESS** سابق.
2. اضغط **Redeploy** على ذلك الـ deployment (يعيد نفس الـ commit).
3. لا تُطبّق migrations يدويًا — الـ pre-deploy يتكفل بها.

> الكود دائمًا في GitHub (`feat/mvp-v1`) — لا يوجد مسار نشر خارج Git.

---

## الصيانة الدورية

| المهمة | التكرار |
|--------|---------|
| نسخة احتياطية (أعلاه) | يوميًا |
| التحقق من `/api/health` | أسبوعيًا |
| مراجعة حسابات Staff (deactivate من ترك العمل) | شهريًا |
| تغيير كلمات مرور الموظفين | كل 3 أشهر |
| اختبار استعادة نسخة | شهريًا |
| مراجعة Railway usage/الفاتورة | شهريًا |

---

## Emergency — إيقاف الكتابة عند الطوارئ

**متى تستخدم هذا القسم؟** اكتشاف تسجيل بيانات خاطئة على نطاق واسع،
اختراق مشتبه به، أو أي حالة يقرر فيها المالك تجميد العمل.

### المستوى 1 — إيقاف الوصول (الأسرع، دقيقة واحدة)

1. Railway Dashboard ← خدمة `web` ← **Settings** ← **Pause/Stop**.
2. النتيجة: التطبيق لا يستجيب للعامة، والقاعدة تظل سليمة للقراءة عبر النفق.
3. لعكس الحالة: اضغط **Resume/Deploy** — لا فقدان بيانات.

### المستوى 2 — إنهاء جلسات المستخدمين دون إيقاف النظام

من حساب ADMIN: **الإعدادات ← فريق العمل ← تعطيل** أي حساب مشتبه به —
تُسقط جلساته فورًا ويرفض النظام دخوله من جديد.

### المستوى 3 — منع الكتابة على مستوى القاعدة (الحجر الأخير)

```bash
railway connect Postgres --environment production --tunnel-only -P 15432
psql "postgresql://postgres:PASSWORD@localhost:15432/railway" \
  -c "REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public FROM postgres;"
# للتراجع:
# GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO postgres;
```

> نفّذ المستوى 3 فقط بإشراف المالك، ووثّق الوقت والسبب — بعده لا يمكن
> لأحد (حتى التطبيق) تعديل البيانات حتى التراجع يدويًا.

### بعد أي طوارئ

1. خذ نسخة pg_dump فورية (توثيقًا للحالة).
2. راجع **سجل العمليات (Audit Log)** داخل النظام لمعرفة ما جرى.
3. سجّل ملخص الحادث + الإجراء + الوقت في ملف المتابعة الوردي للمركز.
