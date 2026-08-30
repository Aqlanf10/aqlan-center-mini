import { Pool, type PoolClient } from "pg";
import {
  assertCorrectDatabaseProject,
  databaseUrlForProject,
} from "./database-scope";
import {
  computeAll, isCephLandmarkCode, isCephMeasurementCode, MEASUREMENTS, REQUIRED_LANDMARKS,
  summarize, type LandmarkCode, type LandmarkMap,
} from "./ceph";
import { toWhatsAppNumber } from "./reminders";
import { DEFAULT_SERVICES } from "./services-catalog";
import type { Visit, VisitStatus } from "./flow";
import {
  batchRemaining, deriveBalance, expiryState, stockStatus, validateMovement,
  type BatchResult, type MovementKind, type StockStatus,
} from "./inventory";

/**
 * قاعدة بيانات مستقلة عن النظام الأساسي — قرار المالك.
 *
 * الأداة لا تكتب في قاعدة النظام الأساسي إطلاقًا. قواعد المال ومسار الزيارة والأقفال
 * كلها في واجهة النظام الأساسي، وأي كتابة مباشرة من برنامج ثانٍ كانت ستُفسد أرقامه
 * بصمت. الثمن المقبول — وقد قرره المالك صراحة — أن بيانات هذه الأداة تُرحَّل لاحقًا
 * حين يدخل النظام الأساسي الخدمة.
 */

/**
 * يقرر تشفير الاتصال من الرابط نفسه بدل افتراضه.
 *
 * فرض SSL دائمًا بدا الخيار الآمن، وكان خطأً: خادم Postgres بلا TLS يرفض الاتصال من
 * أصله برسالة «does not support SSL»، فتفتح اللوحة على «تعذّر تحميل قائمة اليوم» ولا
 * يعرف أحد لماذا. ظهر هذا عند أول تشغيل حقيقي، لا في البناء.
 *
 * القاعدة: المزوّدون المُدارون (Neon / Railway / Supabase) يفرضون TLS بشهادة وسيطة،
 * فيُفعَّل التشفير ويُعطَّل التحقق من سلسلة الشهادة لهم وحدهم؛ أما `localhost` أو
 * `sslmode=disable` صراحةً فبلا تشفير — وهو الصحيح لقاعدة على الجهاز نفسه.
 */
export function sslFor(connectionString: string): { rejectUnauthorized: boolean } | false {
  const lowered = connectionString.toLowerCase();
  if (lowered.includes("sslmode=disable")) return false;
  if (/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(lowered)) return false;
  return { rejectUnauthorized: false };
}

let pool: Pool | null = null;

/**
 * أسماء رابط الاتصال التي قد يضبطها المزوّد.
 *
 * تكامل Neon مع Vercel يضبط `DATABASE_URL`، وتكاملات أخرى تضبط `POSTGRES_URL` أو
 * `POSTGRES_PRISMA_URL`. القراءة من اسم واحد كانت تعني أن يربط المالك القاعدة بنجاح
 * ثم تبقى اللوحة معطّلة بلا سبب ظاهر — فتُقرأ الأسماء المعروفة كلها بالترتيب.
 */
const CONNECTION_ENV_NAMES = [
  "DATABASE_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL_NON_POOLING",
] as const;

/** الرابط الخام من البيئة كما هو — تستخدمه أدوات التهيئة قبل توجيه اسم القاعدة. */
export function rawConnectionStringFromEnv(): string | null {
  for (const name of CONNECTION_ENV_NAMES) {
    const value = process.env[name];
    if (value && value.trim()) return value.trim();
  }
  return null;
}

export function connectionStringFromEnv(): string | null {
  const raw = rawConnectionStringFromEnv();
  if (!raw) return null;
  // حاجزُ عزل إلزامي: داخل Railway يُوجَّه الرابط إلى القاعدة المخصّصة
  // aqlan_center_mini_v2 في مشروع المركز حصراً، ويرفض الاتصال بمشروعٍ آخر —
  // وقاعدة `railway` القديمة تبقى دون لمس. محليًّا وCI يمرّ الرابط كما هو.
  return databaseUrlForProject(raw);
}

export function getPool(): Pool {
  if (pool) return pool;
  assertCorrectDatabaseProject();
  const connectionString = connectionStringFromEnv();
  if (!connectionString) {
    throw new Error("رابط قاعدة البيانات غير مضبوط — أضف DATABASE_URL في إعدادات النشر.");
  }
  pool = new Pool({ connectionString, ssl: sslFor(connectionString), max: 3 });
  return pool;
}

let schemaReady: Promise<void> | null = null;

/**
 * يُنسي البرنامج أنه أنشأ المخطط — لفحوص الإقلاع وحدها.
 *
 * `ensureSchema` تُنفَّذ مرة لكل عملية، وهذا هو الصحيح في التشغيل. لكن فحصَ «هل يُعاد
 * الإنشاء بسلامة فوق بيانات قائمة؟» يحتاج إقلاعًا ثانيًا في العملية نفسها — وهو
 * السؤال الذي فات فحصنا مرة، فمرّ خطأ لا يظهر إلا على قاعدة فيها صفوف.
 */
export function schemaReadyReset(): void {
  schemaReady = null;
}

/**
 * ينشئ الجدول عند أول طلب.
 *
 * أداة الطوارئ بلا نظام هجرات عمدًا: إضافة أداة هجرات هنا تعني خطوة نشر إضافية قبل أن
 * تعمل الشاشة، والهدف أن تعمل صباح الغد. الجدول واحد، وإنشاؤه IF NOT EXISTS آمن للتكرار.
 */
export function ensureSchema(): Promise<void> {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS visits (
        id            SERIAL PRIMARY KEY,
        patient_name  TEXT        NOT NULL,
        patient_phone TEXT,
        note          TEXT,
        status        TEXT        NOT NULL DEFAULT 'waiting',
        chair         INTEGER,
        arrived_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        seated_at     TIMESTAMPTZ,
        finished_at   TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS visits_arrived_at_idx ON visits (arrived_at);
      ALTER TABLE visits ADD COLUMN IF NOT EXISTS called_at TIMESTAMPTZ;

      -- المرضى والمواعيد بأسماء حقول تحاكي النظام الأساسي عمدًا، ليكون الترحيل لاحقًا
      -- نسخًا مباشرًا لا إعادة كتابة. حالات الموعد هي نفس مفردات AppointmentStatus هناك.
      CREATE TABLE IF NOT EXISTS patients (
        id             SERIAL PRIMARY KEY,
        patient_number TEXT        NOT NULL UNIQUE,
        full_name      TEXT        NOT NULL,
        phone          TEXT,
        note           TEXT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS patients_name_idx ON patients (full_name);
      -- بيانات المريض التي تحتاجها عيادة تعمل: رقم بديل، جنس، سنة ميلاد، عنوان،
      -- وتنبيه طبي يُقرأ قبل الإجراء لا بعده.
      ALTER TABLE patients ADD COLUMN IF NOT EXISTS alt_phone     TEXT;
      ALTER TABLE patients ADD COLUMN IF NOT EXISTS gender        TEXT NOT NULL DEFAULT 'unknown';
      ALTER TABLE patients ADD COLUMN IF NOT EXISTS birth_year    INTEGER;
      ALTER TABLE patients ADD COLUMN IF NOT EXISTS address       TEXT;
      ALTER TABLE patients ADD COLUMN IF NOT EXISTS medical_alert TEXT;
      CREATE INDEX IF NOT EXISTS patients_phone_idx ON patients (phone);

      CREATE TABLE IF NOT EXISTS appointments (
        id               SERIAL PRIMARY KEY,
        patient_id       INTEGER     NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
        scheduled_date   DATE        NOT NULL,
        scheduled_time   TIME        NOT NULL,
        duration_minutes INTEGER     NOT NULL DEFAULT 30,
        appointment_type TEXT,
        note             TEXT,
        status           TEXT        NOT NULL DEFAULT 'booked',
        arrived_at       TIMESTAMPTZ,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS appointments_date_idx ON appointments (scheduled_date);
      ALTER TABLE appointments ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;
      -- تأكيد الحضور من بوابة المريض: ختمٌ مستقل لا يغيّر حالة الموعد التشغيلية —
      -- المريض يؤكد أن قادم، والوصول الفعلي يبقى قرار الاستقبال وحده.
      ALTER TABLE appointments ADD COLUMN IF NOT EXISTS patient_confirmed_at TIMESTAMPTZ;

      -- الزيارة تعرف موعدها ومريضها حين يأتي من حجز، وتبقى مستقلة للمريض المشي.
      ALTER TABLE visits ADD COLUMN IF NOT EXISTS patient_id INTEGER REFERENCES patients(id);
      ALTER TABLE visits ADD COLUMN IF NOT EXISTS appointment_id INTEGER REFERENCES appointments(id);

      -- طلبات الحجز من المرضى. جدول منفصل عن المواعيد عمدًا: الطلب ليس موعدًا حتى
      -- تؤكّده الاستقبال، وخلطهما كان يعني يومًا ممتلئًا بأسماء غير مؤكّدة.
      CREATE TABLE IF NOT EXISTS booking_requests (
        id               SERIAL PRIMARY KEY,
        full_name        TEXT        NOT NULL,
        phone            TEXT        NOT NULL,
        reason           TEXT,
        preferred_date   DATE,
        preferred_period TEXT        NOT NULL DEFAULT 'any',
        status           TEXT        NOT NULL DEFAULT 'new',
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        handled_at       TIMESTAMPTZ,
        appointment_id   INTEGER REFERENCES appointments(id),
        -- بصمة مصدر الطلب لا عنوانه: تكفي لإيقاف من يرسل مئة طلب، ولا تُبقي عنوان
        -- مريض مخزّنًا في قاعدة عيادة.
        source_hash      TEXT
      );
      CREATE INDEX IF NOT EXISTS booking_requests_status_idx ON booking_requests (status, created_at);
      CREATE INDEX IF NOT EXISTS booking_requests_phone_idx ON booking_requests (phone, created_at);

      -- الاستمارات الرقمية من بوابة المريض. سجل يُضاف إليه فقط: كل إرسال نسخة
      -- جديدة بنقل الصحة لا تعديلها، والطاقم يقرأ الأخيرة ويرى ما قبلها.
      CREATE TABLE IF NOT EXISTS patient_intake_forms (
        id           SERIAL PRIMARY KEY,
        patient_id   INTEGER     NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
        answers      JSONB       NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS intake_forms_patient_idx
        ON patient_intake_forms (patient_id, created_at DESC);

      -- أعمال المختبر. المقياس الوحيد هنا تاريخ الاستحقاق: عملٌ بلا تاريخ يُنتظر إلى
      -- ما لا نهاية ولا يعرف أحد أنه تأخّر إلا حين يسأل المريض وهو على الكرسي.
      -- أثر المتابعة. القاعدة: لا يُتصل بأحد مرتين، ولا يُنسى أحد — وكلاهما مستحيل
      -- بلا تسجيل. المريض يعود إلى قائمة الاستدعاء إن بقي منقطعًا بعد مدة.
      ALTER TABLE patients ADD COLUMN IF NOT EXISTS recalled_at TIMESTAMPTZ;
      ALTER TABLE appointments ADD COLUMN IF NOT EXISTS follow_up_at TIMESTAMPTZ;

      CREATE TABLE IF NOT EXISTS lab_orders (
        id           SERIAL PRIMARY KEY,
        patient_id   INTEGER     NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
        lab_name     TEXT        NOT NULL,
        lab_phone    TEXT,
        work_type    TEXT        NOT NULL,
        details      TEXT,
        sent_date    DATE        NOT NULL DEFAULT CURRENT_DATE,
        due_date     DATE        NOT NULL,
        status       TEXT        NOT NULL DEFAULT 'sent',
        received_at  TIMESTAMPTZ,
        delivered_at TIMESTAMPTZ,
        note         TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS lab_orders_status_idx ON lab_orders (status, due_date);
      CREATE INDEX IF NOT EXISTS lab_orders_patient_idx ON lab_orders (patient_id);

      -- الإعدادات: مفتاح وقيمة. لا أعمدة لكل إعداد، لأن كل إعداد جديد كان سيعني
      -- تعديل جدول في قاعدة إنتاج تعمل عليها عيادة.
      -- ── المالية ────────────────────────────────────────────────────────────
      -- المبالغ كلها أعداد صحيحة بالوحدة الصغرى. الكسور العشرية في المال تتراكم:
      -- مئة دفعة بحساب عشري تعطي رصيدًا يخالف الورقة بريالات لا أحد يعرف مصدرها.

      -- قائمة الأسعار.
      CREATE TABLE IF NOT EXISTS services (
        id            SERIAL PRIMARY KEY,
        name          TEXT        NOT NULL,
        category      TEXT,
        price_minor   BIGINT      NOT NULL DEFAULT 0,
        is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
        sort_order    INTEGER     NOT NULL DEFAULT 100,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS services_active_idx ON services (is_active, sort_order);

      -- ورديات الصندوق. الدفع يتطلب وردية مفتوحة، والإغلاق يُقارن الجرد بالمتوقَّع.
      CREATE TABLE IF NOT EXISTS cashier_shifts (
        id            SERIAL PRIMARY KEY,
        opened_by     TEXT        NOT NULL,
        opened_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        opening_yer   BIGINT      NOT NULL DEFAULT 0,
        opening_sar   BIGINT      NOT NULL DEFAULT 0,
        opening_usd   BIGINT      NOT NULL DEFAULT 0,
        closed_by     TEXT,
        closed_at     TIMESTAMPTZ,
        counted_yer   BIGINT,
        counted_sar   BIGINT,
        counted_usd   BIGINT,
        note          TEXT,
        status        TEXT        NOT NULL DEFAULT 'open'
      );
      -- وردية مفتوحة واحدة لا أكثر: صندوقٌ واحد في العيادة، ووردّيتان مفتوحتان
      -- تعنيان دفعات موزّعة عشوائيًا بينهما فلا يُطابَق أيّهما.
      CREATE UNIQUE INDEX IF NOT EXISTS cashier_shifts_one_open
        ON cashier_shifts ((status)) WHERE status = 'open';

      CREATE TABLE IF NOT EXISTS invoices (
        id             SERIAL PRIMARY KEY,
        invoice_number TEXT        NOT NULL UNIQUE,
        patient_id     INTEGER     NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
        status         TEXT        NOT NULL DEFAULT 'open',
        total_minor    BIGINT      NOT NULL DEFAULT 0,
        discount_minor BIGINT      NOT NULL DEFAULT 0,
        base_currency  TEXT        NOT NULL DEFAULT 'YER',
        note           TEXT,
        created_by     TEXT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS invoices_patient_idx ON invoices (patient_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS invoices_created_idx ON invoices (created_at);

      CREATE TABLE IF NOT EXISTS invoice_items (
        id               SERIAL PRIMARY KEY,
        invoice_id       INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
        service_id       INTEGER REFERENCES services(id),
        description      TEXT    NOT NULL,
        quantity         INTEGER NOT NULL DEFAULT 1,
        unit_price_minor BIGINT  NOT NULL DEFAULT 0,
        total_minor      BIGINT  NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS invoice_items_invoice_idx ON invoice_items (invoice_id);
      -- ترتيب الإنشاء ليس تجميلًا: جدولٌ يُشار إليه بمفتاح أجنبي يجب أن يُنشأ قبل
      -- من يشير إليه. كان جدول الجهات يُنشأ بعد أول مرجع إليه، فلم يظهر الخلل أبدًا
      -- على قاعدة قائمة — الجدول موجود من قبل — وظهر أول ما بُنيت قاعدة من الصفر:
      -- «relation parties does not exist»، فسقط إنشاء المخطط كله ولم يُنشأ نظام جديد.
      -- جهات التعامل: مختبرات وموردون وأطباء. جدول واحد لأن ما يُسأل عنه واحد:
      -- كم لهذه الجهة عندنا، وكم دفعنا لها.
      CREATE TABLE IF NOT EXISTS parties (
        id         SERIAL PRIMARY KEY,
        name       TEXT        NOT NULL,
        kind       TEXT        NOT NULL DEFAULT 'supplier',
        phone      TEXT,
        note       TEXT,
        -- نسبة عمولة الطبيب من قيمة عمله. تُحفظ في الجهة لا في الكود.
        commission_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
        is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS parties_kind_idx ON parties (kind, is_active);

      -- الطبيب على مستوى البند لا الفاتورة: فاتورة واحدة قد تحمل عمل طبيبين — كشف
      -- من الأول وحشوة من الثانية — وعمولة كلٍّ على عمله وحده.
      ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS doctor_id INTEGER REFERENCES parties(id);
      CREATE INDEX IF NOT EXISTS invoice_items_doctor_idx ON invoice_items (doctor_id);

      -- الدفعة تحمل سعر صرفها لحظة الدفع. لو حُسبت بسعر اليوم لتغيّر رصيد كل مريض
      -- كلما حُدِّث السعر — وهو ما يجعل السجل كله بلا معنى.
      CREATE TABLE IF NOT EXISTS payments (
        id                SERIAL PRIMARY KEY,
        receipt_number    TEXT        NOT NULL UNIQUE,
        patient_id        INTEGER     NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
        invoice_id        INTEGER     REFERENCES invoices(id) ON DELETE SET NULL,
        shift_id          INTEGER     NOT NULL REFERENCES cashier_shifts(id),
        kind              TEXT        NOT NULL DEFAULT 'payment',
        amount_minor      BIGINT      NOT NULL,
        currency          TEXT        NOT NULL,
        exchange_rate     NUMERIC(18,6) NOT NULL DEFAULT 1,
        base_amount_minor BIGINT      NOT NULL,
        base_currency     TEXT        NOT NULL DEFAULT 'YER',
        method            TEXT        NOT NULL DEFAULT 'cash',
        note              TEXT,
        created_by        TEXT,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS payments_patient_idx ON payments (patient_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS payments_shift_idx ON payments (shift_id);
      CREATE INDEX IF NOT EXISTS payments_created_idx ON payments (created_at);

      -- المصروفات: سند صرف لكل مبلغ يخرج من الصندوق.
      CREATE TABLE IF NOT EXISTS expenses (
        id                SERIAL PRIMARY KEY,
        voucher_number    TEXT        NOT NULL UNIQUE,
        category          TEXT        NOT NULL,
        party_id          INTEGER     REFERENCES parties(id),
        payee_text        TEXT,
        shift_id          INTEGER     NOT NULL REFERENCES cashier_shifts(id),
        amount_minor      BIGINT      NOT NULL,
        currency          TEXT        NOT NULL,
        exchange_rate     NUMERIC(18,6) NOT NULL DEFAULT 1,
        base_amount_minor BIGINT      NOT NULL,
        base_currency     TEXT        NOT NULL DEFAULT 'YER',
        -- ما يربط الصرف بما يُسدَّده: أمر مختبر، أو التزام مورّد، أو عمولة طبيب.
        payable_id        INTEGER,
        note              TEXT,
        created_by        TEXT,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS expenses_shift_idx ON expenses (shift_id);
      CREATE INDEX IF NOT EXISTS expenses_created_idx ON expenses (created_at);
      CREATE INDEX IF NOT EXISTS expenses_party_idx ON expenses (party_id, created_at DESC);

      -- الالتزامات: ما على العيادة لجهةٍ ما. الوجه الآخر لمديونية المرضى — أن تعرف
      -- كم عليك كما تعرف كم لك. عيادة تعرف مديونية مرضاها ولا تعرف ما عليها
      -- للمختبرات تحسب نفسها رابحة وهي مدينة.
      CREATE TABLE IF NOT EXISTS payables (
        id                SERIAL PRIMARY KEY,
        party_id          INTEGER     NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
        category          TEXT        NOT NULL DEFAULT 'supplier',
        description       TEXT        NOT NULL,
        amount_minor      BIGINT      NOT NULL,
        currency          TEXT        NOT NULL,
        exchange_rate     NUMERIC(18,6) NOT NULL DEFAULT 1,
        base_amount_minor BIGINT      NOT NULL,
        base_currency     TEXT        NOT NULL DEFAULT 'YER',
        lab_order_id      INTEGER     REFERENCES lab_orders(id) ON DELETE SET NULL,
        due_date          DATE,
        created_by        TEXT,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS payables_party_idx ON payables (party_id, created_at DESC);
      -- التزام واحد لكل أمر مختبر: تسجيل التكلفة مرتين يضاعف ما على العيادة.
      CREATE UNIQUE INDEX IF NOT EXISTS payables_lab_order_uniq
        ON payables (lab_order_id) WHERE lab_order_id IS NOT NULL;

      -- ربط أمر المختبر بالمختبر المسجّل وتكلفته.
      ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS party_id   INTEGER REFERENCES parties(id);
      ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS cost_minor BIGINT;
      ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS cost_currency TEXT;

      -- القيود اليدوية: التسويات وإعادة تقييم العملات والأرصدة الافتتاحية. قيود
      -- المستندات تُشتقّ من المستندات نفسها ولا تُخزَّن — فلا مصدرين للحقيقة.
      CREATE TABLE IF NOT EXISTS journal_manual (
        id          SERIAL PRIMARY KEY,
        entry_date  DATE        NOT NULL,
        description TEXT        NOT NULL,
        created_by  TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS journal_manual_date_idx ON journal_manual (entry_date);

      CREATE TABLE IF NOT EXISTS journal_manual_lines (
        id           SERIAL PRIMARY KEY,
        entry_id     INTEGER NOT NULL REFERENCES journal_manual(id) ON DELETE CASCADE,
        account_code TEXT    NOT NULL,
        amount_minor BIGINT  NOT NULL,
        side         TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS journal_manual_lines_entry_idx ON journal_manual_lines (entry_id);

      -- خطط العلاج والأقساط: نموذج عمل عيادة التقويم. الخطة **اتفاق**، والقسط
      -- **استحقاق**، والدفعة **تحصيل** — ثلاثة أشياء مختلفة كان خلطها هو ما يجعل
      -- مرضى التقويم أصعب ملفات العيادة.
      CREATE TABLE IF NOT EXISTS treatment_plans (
        id            SERIAL PRIMARY KEY,
        patient_id    INTEGER     NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
        title         TEXT        NOT NULL,
        total_minor   BIGINT      NOT NULL,
        base_currency TEXT        NOT NULL DEFAULT 'YER',
        status        TEXT        NOT NULL DEFAULT 'active',
        start_date    DATE        NOT NULL DEFAULT CURRENT_DATE,
        note          TEXT,
        created_by    TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS treatment_plans_patient_idx ON treatment_plans (patient_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS treatment_plans_status_idx ON treatment_plans (status);

      CREATE TABLE IF NOT EXISTS plan_installments (
        id           SERIAL PRIMARY KEY,
        plan_id      INTEGER NOT NULL REFERENCES treatment_plans(id) ON DELETE CASCADE,
        number       INTEGER NOT NULL,
        due_date     DATE    NOT NULL,
        amount_minor BIGINT  NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS plan_installments_uniq ON plan_installments (plan_id, number);
      CREATE INDEX IF NOT EXISTS plan_installments_due_idx ON plan_installments (due_date);

      -- بنود الخطة السريرية: ما سيُعمل، على أيّ سن، وبكم. والإجمالي يُشتقّ منها لا
      -- يُكتب باليد — رقمان لعملٍ واحد هما بذرة كل خلافٍ لاحق مع المريض.
      -- واسم الخدمة وسعرها **منسوخان** لحظة الاتفاق: الدليل يتغيّر غدًا، والاتفاق لا.
      CREATE TABLE IF NOT EXISTS plan_items (
        id               SERIAL PRIMARY KEY,
        plan_id          INTEGER NOT NULL REFERENCES treatment_plans(id) ON DELETE CASCADE,
        service_id       INTEGER REFERENCES services(id),
        service_name     TEXT    NOT NULL,
        category         TEXT,
        tooth_code       SMALLINT,
        surfaces         TEXT,
        quantity         INTEGER NOT NULL DEFAULT 1,
        unit_price_minor BIGINT  NOT NULL DEFAULT 0,
        status           TEXT    NOT NULL DEFAULT 'planned',
        visit_id         INTEGER REFERENCES visits(id),
        done_at          TIMESTAMPTZ,
        note             TEXT,
        sort_order       INTEGER NOT NULL DEFAULT 100,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS plan_items_plan_idx ON plan_items (plan_id, sort_order, id);
      CREATE INDEX IF NOT EXISTS plan_items_open_idx ON plan_items (status, service_id, tooth_code);

      -- الموافقة: متى وُقّعت وبيد من سُجّلت وكيف وُثّقت. وخطةٌ بلا موافقة تبقى
      -- مسوّدةً لا اتفاقًا — وهذا فرقٌ يظهر يوم الخلاف لا قبله.
      ALTER TABLE treatment_plans ADD COLUMN IF NOT EXISTS consent_at   TIMESTAMPTZ;
      ALTER TABLE treatment_plans ADD COLUMN IF NOT EXISTS consent_by   TEXT;
      ALTER TABLE treatment_plans ADD COLUMN IF NOT EXISTS consent_note TEXT;
      -- خطةٌ إجماليّها من بنودها لا من لوحة المفاتيح. تُرفع مرةً عند أول بند ولا
      -- تُخفض: خفضها يعيد الإجمالي إلى رقمٍ يدويٍّ لا سند له.
      ALTER TABLE treatment_plans ADD COLUMN IF NOT EXISTS total_from_items BOOLEAN NOT NULL DEFAULT FALSE;

      -- الأشعة والمستندات: **الوصف هنا والملفّ على القرص** — الدستور، المحظور ٨.
      -- صورةٌ بانورامية تُقاس بالميغابايتات، ومئةُ مريضٍ شهريًّا تعني قاعدةً تنتفخ
      -- حتى تصير كل نسخةٍ احتياطية عمليةً تستغرق ساعة — فلا تُؤخذ.
      -- وبصمة المحتوى هي اسم الملف على القرص: لا تصادم، ولا تكرار، ولا مسارٌ يُخمَّن.
      CREATE TABLE IF NOT EXISTS patient_documents (
        id           SERIAL PRIMARY KEY,
        patient_id   INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
        visit_id     INTEGER REFERENCES visits(id),
        kind         TEXT    NOT NULL DEFAULT 'other',
        title        TEXT    NOT NULL,
        mime_type    TEXT    NOT NULL,
        size_bytes   BIGINT  NOT NULL,
        sha256       TEXT    NOT NULL,
        storage_key  TEXT    NOT NULL,
        note         TEXT,
        taken_on     DATE,
        uploaded_by  TEXT    NOT NULL,
        uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        -- الحذف **إخفاءٌ موثَّق** لا محو: السجل الطبي شهادة، ومن يمحو بصمت يمكن
        -- أن يمحو بعد شكوى. والملفّ نفسه يبقى على القرص لأن صفًّا آخر قد يشير إليه.
        removed_at   TIMESTAMPTZ,
        removed_by   TEXT,
        removed_note TEXT
      );
      CREATE INDEX IF NOT EXISTS patient_documents_patient_idx
        ON patient_documents (patient_id, uploaded_at DESC);
      CREATE INDEX IF NOT EXISTS patient_documents_visit_idx ON patient_documents (visit_id);

      -- حالة التقويم: علاجٌ يمتدّ سنتين لا زيارةً واحدة.
      -- والفرق الحاكم أن السؤال ليس «ماذا عُمل اليوم» بل «أين نحن من الخطة»: في أيّ
      -- مرحلة، وعلى أيّ سلك، وكم مضى وكم بقي.
      CREATE TABLE IF NOT EXISTS ortho_cases (
        id             SERIAL PRIMARY KEY,
        patient_id     INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
        appliance      TEXT    NOT NULL DEFAULT 'fixed_metal',
        arches         TEXT    NOT NULL DEFAULT 'both',
        slot           TEXT    NOT NULL DEFAULT '022',
        bracket_system TEXT,
        status         TEXT    NOT NULL DEFAULT 'active',
        phase          TEXT    NOT NULL DEFAULT 'aligning',
        start_date     DATE    NOT NULL DEFAULT CURRENT_DATE,
        planned_months INTEGER NOT NULL DEFAULT 18,
        -- السلك الحالي في كل فك: أول ما يحتاجه الطبيب على الكرسي، ويُقرأ بلا حساب
        -- من سجل الشدّات. ويُحدَّث مع كل شدّة في المعاملة نفسها.
        upper_wire     TEXT,
        lower_wire     TEXT,
        -- خطة الأقساط التي تموّل هذه الحالة — والاثنان وجهان لاتفاق واحد.
        plan_id        INTEGER REFERENCES treatment_plans(id),
        retainer       TEXT,
        retainer_on    DATE,
        note           TEXT,
        closed_at      TIMESTAMPTZ,
        closed_by      TEXT,
        closed_note    TEXT,
        created_by     TEXT    NOT NULL,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS ortho_cases_patient_idx ON ortho_cases (patient_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS ortho_cases_status_idx ON ortho_cases (status);
      -- حالةٌ جاريةٌ واحدة لكل مريض. وحالتان مفتوحتان تعنيان سجلَّي أسلاك لفمٍ
      -- واحد، فلا يُعرف أيّهما الحقيقي — والقاعدة تمنعه لا الشاشة.
      CREATE UNIQUE INDEX IF NOT EXISTS ortho_cases_one_open
        ON ortho_cases (patient_id) WHERE status IN ('active', 'retention');

      -- زيارات الشدّ: سجلّ العلاج نفسه، لا ملحقًا به.
      CREATE TABLE IF NOT EXISTS ortho_adjustments (
        id           SERIAL PRIMARY KEY,
        case_id      INTEGER NOT NULL REFERENCES ortho_cases(id) ON DELETE CASCADE,
        visit_id     INTEGER REFERENCES visits(id),
        done_on      DATE    NOT NULL DEFAULT CURRENT_DATE,
        phase        TEXT,
        upper_wire   TEXT,
        lower_wire   TEXT,
        elastics     TEXT    NOT NULL DEFAULT 'none',
        elastic_note TEXT,
        done         TEXT,
        next_weeks   INTEGER NOT NULL DEFAULT 4,
        note         TEXT,
        recorded_by  TEXT    NOT NULL,
        recorded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS ortho_adjustments_case_idx
        ON ortho_adjustments (case_id, done_on DESC, id DESC);
      CREATE INDEX IF NOT EXISTS ortho_adjustments_visit_idx ON ortho_adjustments (visit_id);

      -- التحليل السيفالومتري: دراسةٌ على شععة موجودة في المستندات — لا نسخةً منها.
      --
      -- الصورة تبقى في التخزين (المحظور الثامن) والتحليل يرشد إليها بمعرّفها. والتحليل
      -- المعتمد **لا يُعدَّل**: القياسات تُختم لقطةً واحدة في جدولها، والتصحيح يفتح
      -- نسخةً جديدة عنها — فتاريخ ما رآه الطبيب واعتمده يبقى كما هو.
      CREATE TABLE IF NOT EXISTS ceph_analyses (
        id           BIGSERIAL PRIMARY KEY,
        patient_id   INTEGER     NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
        document_id  INTEGER     NOT NULL REFERENCES patient_documents(id) ON DELETE RESTRICT,
        status       TEXT        NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','completed','discarded')),
        -- المعايرة: نقطتان بالبكسل والمسافة الحقيقية بينهما بالمليمتر.
        cal_x1 DOUBLE PRECISION, cal_y1 DOUBLE PRECISION,
        cal_x2 DOUBLE PRECISION, cal_y2 DOUBLE PRECISION,
        cal_mm  DOUBLE PRECISION,
        mm_per_pixel DOUBLE PRECISION,
        note         TEXT,
        created_by   TEXT        NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_by TEXT,
        completed_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS ceph_analyses_patient_idx
        ON ceph_analyses (patient_id, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS ceph_analyses_one_draft
        ON ceph_analyses (patient_id) WHERE status = 'draft';

      -- المعالم: نقطةٌ لكل رمز في التحليل الواحد، بمصدرها — يدٌ أم اقتراح.
      -- قاعدة ZONE_B: المقترح لا يصير قياسًا إلا بتأكيد الطبيب، وعمود confirmed_by
      -- يشهد من أقرّ به.
      CREATE TABLE IF NOT EXISTS ceph_landmarks (
        id           BIGSERIAL PRIMARY KEY,
        analysis_id  BIGINT      NOT NULL REFERENCES ceph_analyses(id) ON DELETE CASCADE,
        code         TEXT        NOT NULL,
        x            DOUBLE PRECISION NOT NULL,
        y            DOUBLE PRECISION NOT NULL,
        source       TEXT        NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','suggested')),
        confirmed_by TEXT        NOT NULL,
        confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (analysis_id, code)
      );

      -- لقطة القياسات عند الاعتماد: أرقامٌ مختومة تُقرأ حتى لو تغيّر كودُ الحساب لاحقًا.
      CREATE TABLE IF NOT EXISTS ceph_measurements (
        id          BIGSERIAL PRIMARY KEY,
        analysis_id BIGINT NOT NULL REFERENCES ceph_analyses(id) ON DELETE CASCADE,
        code        TEXT   NOT NULL,
        value       DOUBLE PRECISION NOT NULL,
        UNIQUE (analysis_id, code)
      );
      CREATE INDEX IF NOT EXISTS ceph_measurements_analysis_idx ON ceph_measurements (analysis_id);

      -- بيانات الدراسة السريرية: مراحلتها وشععتها وارتباطها بحالة التقويم.
      -- المرحلة تجيب «أين نحن من العلاج» ولا تكرّر قاعة الحالة في التقويم،
      -- وربط التقويم اختياري (دراسة على مريضٍ لا تقويم له جائزة).
      ALTER TABLE ceph_analyses ADD COLUMN IF NOT EXISTS ortho_case_id INTEGER REFERENCES ortho_cases(id);
      ALTER TABLE ceph_analyses ADD COLUMN IF NOT EXISTS phase TEXT NOT NULL DEFAULT 'pretreatment';
      ALTER TABLE ceph_analyses ADD COLUMN IF NOT EXISTS xray_date DATE;
      ALTER TABLE ceph_analyses ADD COLUMN IF NOT EXISTS device TEXT;
      ALTER TABLE ceph_analyses ADD COLUMN IF NOT EXISTS ref_set TEXT NOT NULL DEFAULT 'builtin_default';
      ALTER TABLE ceph_analyses ADD COLUMN IF NOT EXISTS study_kind TEXT NOT NULL DEFAULT 'lateral';
      ALTER TABLE ceph_analyses DROP CONSTRAINT IF EXISTS ceph_analyses_phase_check;
      ALTER TABLE ceph_analyses ADD CONSTRAINT ceph_analyses_phase_check
        CHECK (phase IN ('pretreatment','during','posttreatment','followup'));
      ALTER TABLE ceph_analyses DROP CONSTRAINT IF EXISTS ceph_analyses_kind_check;
      ALTER TABLE ceph_analyses ADD CONSTRAINT ceph_analyses_kind_check
        CHECK (study_kind IN ('lateral'));
      CREATE INDEX IF NOT EXISTS ceph_analyses_phase_idx ON ceph_analyses (patient_id, phase);

      -- الاستعداد لقاعدة ZONE_B كاملة: مصدر المعلم معلوم، وإن جاء اقتراحًا
      -- حاسوبيًا فثقته وطرازُ نموذجه يُسجّلان — ولا مسار AI مفعّل بعد.
      ALTER TABLE ceph_landmarks ADD COLUMN IF NOT EXISTS confidence DOUBLE PRECISION;
      ALTER TABLE ceph_landmarks ADD COLUMN IF NOT EXISTS ai_model TEXT;

      -- المجموعات المرجعية: معدّلات بعمرٍ وجنسٍ ومصدرٍ موثّق — لا قيمة واحدة
      -- صلبة في الكود لكل المرضى. المدمجة تُزرع من سجلّ التعريفات نفسه،
      -- والأدمن يضيف ما شاء من المجموعات المحلية لاحقًا دون لمس الكود.
      CREATE TABLE IF NOT EXISTS ceph_reference_sets (
        id         BIGSERIAL PRIMARY KEY,
        key        TEXT        NOT NULL UNIQUE,
        name       TEXT        NOT NULL,
        age_min    INTEGER,
        age_max    INTEGER,
        sex        TEXT        CHECK (sex IN ('male','female')),
        population TEXT,
        version    TEXT        NOT NULL DEFAULT 'v1',
        active     BOOLEAN     NOT NULL DEFAULT TRUE,
        created_by TEXT        NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS ceph_reference_values (
        id     BIGSERIAL PRIMARY KEY,
        set_id BIGINT NOT NULL REFERENCES ceph_reference_sets(id) ON DELETE CASCADE,
        code   TEXT   NOT NULL,
        mean   DOUBLE PRECISION NOT NULL,
        sd     DOUBLE PRECISION NOT NULL CHECK (sd > 0),
        UNIQUE (set_id, code)
      );

      -- التشخيص المنظم: أقسامه يقترحها النظام ويحرّرها الطبيب، ويُغلق مع
      -- الاعتماد كالقياسات — وما بعده نسخةٌ جديدة لا استبدال.
      CREATE TABLE IF NOT EXISTS ceph_diagnoses (
        analysis_id BIGINT      PRIMARY KEY REFERENCES ceph_analyses(id) ON DELETE CASCADE,
        skeletal    TEXT,
        dental      TEXT,
        soft_tissue TEXT,
        note        TEXT,
        final_dx    TEXT        NOT NULL,
        created_by  TEXT        NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- الدفعة قد تكون على خطة: عليها يقوم حساب ما سُدّد منها.
      ALTER TABLE payments ADD COLUMN IF NOT EXISTS plan_id INTEGER REFERENCES treatment_plans(id);
      CREATE INDEX IF NOT EXISTS payments_plan_idx ON payments (plan_id);
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS plan_id INTEGER REFERENCES treatment_plans(id);

      -- الأرصدة الافتتاحية للمرضى: ما كان على المريض **قبل** تشغيل النظام.
      -- صفٌّ واحد لكل مريض عمدًا: الرصيد الافتتاحي واقعة واحدة لا سجلّ حركات، وتعدّد
      -- الصفوف يجعل «كم كان عليه يوم البدء» سؤالًا بأكثر من جواب.
      CREATE TABLE IF NOT EXISTS patient_opening_balances (
        patient_id   INTEGER     PRIMARY KEY REFERENCES patients(id) ON DELETE CASCADE,
        amount_minor BIGINT      NOT NULL CHECK (amount_minor > 0),
        as_of_date   DATE        NOT NULL,
        note         TEXT,
        created_by   TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS opening_balances_date_idx ON patient_opening_balances (as_of_date);

      -- عدّادات أرقام المستندات.
      --
      -- كانت الأرقام تُولَّد بأكبر رقم زائد واحد داخل جملة الإدراج. والقيد الفريد يمنع
      -- التكرار، لكنه يمنعه **بإفشال الطلب الثاني**: موظفتان تقبضان في الثانية نفسها
      -- فترى إحداهما خطأً عامًّا وهي تمسك نقود مريض. والأسوأ في تسجيل قسط: الفاتورة
      -- والدفعة في معاملة واحدة، فيسقط القسط كله.
      --
      -- والعدّاد يحلّها من أصلها: nextval لا يتصادم ولا ينتظر قفلًا.
      CREATE SEQUENCE IF NOT EXISTS patient_number_seq;
      CREATE SEQUENCE IF NOT EXISTS invoice_number_seq;
      CREATE SEQUENCE IF NOT EXISTS receipt_number_seq;
      CREATE SEQUENCE IF NOT EXISTS voucher_number_seq;

      -- المواءمة مع ما هو موجود، **إلى الأمام فقط**: GREATEST مع قيمة العدّاد
      -- الحالية تمنع إرجاعه إلى الخلف عند إقلاع لاحق — وإرجاعه يعني إصدار رقم
      -- مستعمل، وهو ما يُفشل الإدراج بدل أن يُصلحه.
      SELECT setval('patient_number_seq', GREATEST(
        (SELECT last_value FROM patient_number_seq),
        (SELECT COALESCE(MAX(NULLIF(regexp_replace(patient_number, '\\D', '', 'g'), '')::bigint), 0) FROM patients)
      ), true);
      SELECT setval('invoice_number_seq', GREATEST(
        (SELECT last_value FROM invoice_number_seq),
        (SELECT COALESCE(MAX(NULLIF(regexp_replace(invoice_number, '\\D', '', 'g'), '')::bigint), 0) FROM invoices)
      ), true);
      SELECT setval('receipt_number_seq', GREATEST(
        (SELECT last_value FROM receipt_number_seq),
        (SELECT COALESCE(MAX(NULLIF(regexp_replace(receipt_number, '\\D', '', 'g'), '')::bigint), 0) FROM payments)
      ), true);
      SELECT setval('voucher_number_seq', GREATEST(
        (SELECT last_value FROM voucher_number_seq),
        (SELECT COALESCE(MAX(NULLIF(regexp_replace(voucher_number, '\\D', '', 'g'), '')::bigint), 0) FROM expenses)
      ), true);

      -- طبعات المستندات المالية.
      --
      -- سندٌ يُطبع مرتين ويُعطى مرتين يمكن أن يُقدَّم دليلًا على دفعتين. والعلامة على
      -- النسخة الثانية تحمي الطرفين: المريض من اتهامٍ باطل، والمركز من مطالبةٍ
      -- بمبلغ قُبض مرة واحدة.
      CREATE TABLE IF NOT EXISTS document_prints (
        id         BIGSERIAL   PRIMARY KEY,
        doc_type   TEXT        NOT NULL,
        doc_id     TEXT        NOT NULL,
        printed_by TEXT        NOT NULL,
        printed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS document_prints_doc_idx ON document_prints (doc_type, doc_id);

      -- الزيارة السريرية: **أعمدة على جدول الزيارات القائم لا جدول موازٍ**.
      --
      -- والدستور يمنع إنشاء وحدة جديدة قبل البحث في النواة: جدول الزيارات هو الزيارة
      -- فعلًا — وصولٌ وانتظارٌ وكرسي — وما ينقصه توثيقُ الطبيب. وجدولٌ ثانٍ اسمه
      -- clinical_visits كان سيعني مريضًا له زيارتان لحدثٍ واحد، وهو أول باب
      -- للازدواجية التي جاء الدستور ليمنعها.
      ALTER TABLE visits ADD COLUMN IF NOT EXISTS chief_complaint TEXT;
      ALTER TABLE visits ADD COLUMN IF NOT EXISTS examination     TEXT;
      ALTER TABLE visits ADD COLUMN IF NOT EXISTS diagnosis       TEXT;
      ALTER TABLE visits ADD COLUMN IF NOT EXISTS treatment_done  TEXT;
      ALTER TABLE visits ADD COLUMN IF NOT EXISTS next_plan       TEXT;
      ALTER TABLE visits ADD COLUMN IF NOT EXISTS addendum        TEXT;
      ALTER TABLE visits ADD COLUMN IF NOT EXISTS doctor_id       INTEGER REFERENCES parties(id);
      ALTER TABLE visits ADD COLUMN IF NOT EXISTS signed_at       TIMESTAMPTZ;
      ALTER TABLE visits ADD COLUMN IF NOT EXISTS signed_by       TEXT;
      -- الفاتورة المولَّدة من الزيارة: الرابط الذي يجعل «عملٌ بلا فاتورة» مستحيلًا.
      ALTER TABLE visits ADD COLUMN IF NOT EXISTS invoice_id      INTEGER REFERENCES invoices(id);

      -- الإجراءات المنفَّذة في الزيارة — كلٌّ منها **خدمة من الدليل** لا نصّ حرّ.
      CREATE TABLE IF NOT EXISTS visit_procedures (
        id               BIGSERIAL PRIMARY KEY,
        visit_id         INTEGER NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
        service_id       INTEGER NOT NULL REFERENCES services(id),
        doctor_id        INTEGER REFERENCES parties(id),
        tooth_code       SMALLINT,
        surfaces         TEXT,
        quantity         INTEGER NOT NULL DEFAULT 1,
        unit_price_minor BIGINT  NOT NULL DEFAULT 0,
        note             TEXT,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS visit_procedures_visit_idx ON visit_procedures (visit_id);

      -- حالات الأسنان — سجلٌّ زمني لا حالة واحدة لكل سن.
      --
      -- الجدول **يُضاف إليه ولا يُعدَّل**: حالةُ السن اليوم تُعرف من آخر سطر لا من
      -- حقلٍ يُكتب فوقه. والفرق أن تاريخ السن يبقى: متى وُجد التسوّس، ومتى حُشي،
      -- ومن سجّل كلًّا منهما. وحقلٌ واحد يُكتب فوقه يمحو التاريخ مع كل تحديث —
      -- والدستور يمنع التعديل الصامت على الحركات السريرية.
      CREATE TABLE IF NOT EXISTS tooth_conditions (
        id          BIGSERIAL   PRIMARY KEY,
        patient_id  INTEGER     NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
        tooth_code  SMALLINT    NOT NULL,
        condition   TEXT        NOT NULL,
        stage       TEXT        NOT NULL DEFAULT 'existing',
        surfaces    TEXT,
        note        TEXT,
        visit_id    INTEGER     REFERENCES visits(id),
        recorded_by TEXT        NOT NULL,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS tooth_conditions_patient_idx
        ON tooth_conditions (patient_id, tooth_code, recorded_at);

      -- سجل التدقيق — يُكتب ولا يُعدَّل ولا يُحذف.
      --
      -- لا عمود updated_at ولا حالة ولا حذف منطقي: كلها أبوابٌ للتعديل، وسجلٌّ
      -- يمكن تعديله يشهد لمن يملك تعديله وحده. والحماية هنا في **غياب المسار**
      -- لا في صلاحية تُمنح وتُمنع: لا دالة في البرنامج كله تحدّث هذا الجدول أو
      -- تحذف منه — والقيود أدناه تجعل المحاولة تفشل في القاعدة نفسها.
      CREATE TABLE IF NOT EXISTS audit_log (
        id         BIGSERIAL   PRIMARY KEY,
        action     TEXT        NOT NULL,
        entity     TEXT,
        entity_id  TEXT,
        summary    TEXT        NOT NULL,
        details    JSONB,
        actor      TEXT        NOT NULL,
        actor_role TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS audit_log_time_idx ON audit_log (created_at DESC);
      CREATE INDEX IF NOT EXISTS audit_log_action_idx ON audit_log (action, created_at DESC);
      CREATE INDEX IF NOT EXISTS audit_log_entity_idx ON audit_log (entity, entity_id);

      -- الحارس الأخير: قاعدة البيانات ترفض التعديل والحذف مهما كان مصدرهما — حتى
      -- من اتصال مباشر بالقاعدة. وهذا ما يجعل السجل شهادةً لا مجرّد جدول.
      CREATE OR REPLACE FUNCTION audit_log_is_append_only() RETURNS TRIGGER AS $audit$
      BEGIN
        RAISE EXCEPTION 'سجل التدقيق لا يُعدَّل ولا يُحذف منه.';
      END;
      $audit$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
      CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
        FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

      DROP TRIGGER IF EXISTS audit_log_no_delete ON audit_log;
      CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
        FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

      CREATE TABLE IF NOT EXISTS settings (
        key        TEXT PRIMARY KEY,
        value      TEXT        NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- إعدادات خدمة الذكاء الاصطناعي — صف واحد تفرضه قيود CHECK (id = 1).
      -- خارج جدول settings: مسارات الإعدادات العامة تُقرأ لكل جلسة، وهذه القيم
      -- فيها مفتاح خدمة مخفى ولا يقرأ مسارها إلا المدير. النص المشفّر لا الأصلي.
      -- آخر اختبار اتصال يُثبَّت هنا حتى يرى المالك متى عمل المفتاح آخر مرة.
      CREATE TABLE IF NOT EXISTS ai_settings (
        id                INTEGER     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        enabled           BOOLEAN     NOT NULL DEFAULT FALSE,
        provider          TEXT        NOT NULL DEFAULT 'zai',
        base_url          TEXT        NOT NULL DEFAULT 'https://api.z.ai/api/paas/v4',
        model             TEXT        NOT NULL DEFAULT 'glm-4.6',
        api_key_enc       TEXT,
        last_test_at      TIMESTAMPTZ,
        last_test_ok      BOOLEAN,
        last_test_message TEXT,
        updated_by        TEXT,
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS users (
        id            SERIAL PRIMARY KEY,
        username      TEXT        NOT NULL UNIQUE,
        display_name  TEXT        NOT NULL,
        password_hash TEXT        NOT NULL,
        role          TEXT        NOT NULL DEFAULT 'staff',
        is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- المخزون والمستهلكات السنية (المرحلة 9).
      --
      -- لا عمود رصيدٍ هنا عمدًا: الرصيد مجموع الحركات الموقَّع يُشتق بجملة SUM
      -- في كل قراءة وكل كتابة (معيار القبول: الاشتقاق الرياضي من الحركات). وحقل
      -- الرصيد القابل للتحرير محظور دستوريًا (ZONE_D) — وهو كيف تضيع المواد بلا أثر.
      CREATE TABLE IF NOT EXISTS inventory_items (
        id         SERIAL PRIMARY KEY,
        name       TEXT        NOT NULL,
        category   TEXT        NOT NULL DEFAULT 'other',
        unit       TEXT        NOT NULL DEFAULT 'وحدة',
        min_level  NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (min_level >= 0),
        note       TEXT,
        is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
        created_by TEXT        NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS inventory_items_active_idx ON inventory_items (is_active, name);

      -- الحركات: الإدخال يزيد والصرف ينقص والتسوية موقَّعة في القيمة نفسها —
      -- وسببُ التسوية NOT NULL عند قيدها في الكود لأن عمود السبب وحده لا يمنع
      -- تسوية بلا مبرر (القاعدة تحفظ، والفحص يحكم).
      CREATE TABLE IF NOT EXISTS inventory_movements (
        id          SERIAL PRIMARY KEY,
        item_id     INTEGER     NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
        kind        TEXT        NOT NULL CHECK (kind IN ('in','out','adjust')),
        qty         NUMERIC(12,3) NOT NULL CHECK (qty <> 0),
        expiry_date DATE,
        reason      TEXT,
        visit_id    INTEGER     REFERENCES visits(id) ON DELETE SET NULL,
        created_by  TEXT        NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS inventory_movements_item_idx ON inventory_movements (item_id, id);
      CREATE INDEX IF NOT EXISTS inventory_movements_expiry_idx ON inventory_movements (expiry_date)
        WHERE kind = 'in' AND expiry_date IS NOT NULL;
    `);

    // بذر المجموعة المرجعية المدمجة من سجل التعريفات نفسه — مصدرُ حقيقةٍ واحد:
    // المجموعة المدمجة إسقاطٌ لتعريفات الكود تُزامَن عند كل إقلاع (لا مسار
    // تعديلٍ لها من الواجهة)، وأي مجموعة محلية للأدمن لاحقًا صفٌّ مستقل لا يُمسّ.
    const seedSet = await getPool().query<{ id: number }>(
      `INSERT INTO ceph_reference_sets (key, name, population, version, created_by)
       VALUES ('builtin_default', 'المرجع العام المدمج',
               'متوسطات الأدبيات الكلاسيكية المدمجة في الكود — للعرض المرجعي لا للحكم',
               'seed-v2', 'system')
       ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name,
                                       population = EXCLUDED.population,
                                       version = EXCLUDED.version
       RETURNING id`,
    );
    if (seedSet.rows[0]) {
      await getPool().query(
        `INSERT INTO ceph_reference_values (set_id, code, mean, sd)
         SELECT $1, x.code, x.mean, x.sd
         FROM unnest($2::text[], $3::float8[], $4::float8[]) AS x(code, mean, sd)
         ON CONFLICT (set_id, code) DO UPDATE SET mean = EXCLUDED.mean, sd = EXCLUDED.sd`,
        [
          seedSet.rows[0].id,
          MEASUREMENTS.map((d) => d.code),
          MEASUREMENTS.map((d) => d.mean),
          MEASUREMENTS.map((d) => d.tol),
        ],
      );
    }

    /*
     * زرع دليل الخدمات الافتراضي — مرةً واحدة في عمر القاعدة.
     *
     * **هذه هي الحلقة التي كانت تبدأ من الصفر**: السلسلة المالية كلها موصولة
     * (زيارة ← إجراءات ← فاتورة ← حساب المريض ← وردية الصندوق) لكن الدليل يبدأ
     * فارغًا، وقائمة إجراءاتٍ خاوية تعني أن الطبيب لا يستطيع تسجيل نزع عصبٍ ولا
     * وتدًا بأسعارها — فيبدو المسار كله غير موجود وهو موجود.
     *
     * العلم `services.seeded` يحفظ القرار مع الزرع في معاملة واحدة: إن زُرع
     * الدليل ثم أفرغه المالك عمدًا (وأبقاه معطّلًا خيارًا أسلم) لا يعود من نفسه
     * عند إعادة التشغيل. وقفل الاستشار الذري يمنع سباقَ إقلاعين متوازيين.
     *
     * وفشلُه لا يهوي على الإقلاع: النظام يعمل بلا دليل، والمالك يضيف من الشاشة —
     * تعذّرُ الزرع لا يجعل كلّ مسارٍ عاطلًا.
     */
    try {
      await getPool().query(`BEGIN`);
      await getPool().query(`SELECT pg_advisory_xact_lock(7461)`);
      const marker = await getPool().query<{ key: string }>(
        `SELECT key FROM settings WHERE key = 'services.seeded' FOR UPDATE`,
      );
      if (!marker.rows[0]) {
        // الدليل لمسّه المالك قبل هذا الإقلاع لا يُزرع فوقه: نحكم على الفراغ
        // **قبل** الإدخال، ونختم العلم مهما كان الحكم — فلا يعاد السؤال كل إقلاع.
        const existing = await getPool().query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM services`,
        );
        if (Number(existing.rows[0]?.count ?? "0") === 0) {
          await getPool().query(
            `INSERT INTO services (name, category, price_minor, sort_order)
             SELECT x.name, x.category, x.price, x.sort_order
             FROM unnest($1::text[], $2::text[], $3::bigint[], $4::int[])
                  AS x(name, category, price, sort_order)`,
            [
              DEFAULT_SERVICES.map((s) => s.name),
              DEFAULT_SERVICES.map((s) => s.category),
              DEFAULT_SERVICES.map((s) => s.priceMinor),
              DEFAULT_SERVICES.map((s) => s.sortOrder),
            ],
          );
        }
        await getPool().query(
          `INSERT INTO settings (key, value) VALUES ('services.seeded', '1')
           ON CONFLICT (key) DO NOTHING`,
        );
      }
      await getPool().query(`COMMIT`);
    } catch (seedError) {
      await getPool().query(`ROLLBACK`).catch(() => {});
      console.error("[db] services seed skipped:", seedError);
    }
  })().catch((error) => {
    // لا نحتفظ بوعد فاشل، وإلا بقيت الأداة معطّلة إلى إعادة التشغيل بعد عطل شبكة عابر.
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

interface VisitRow {
  id: number;
  patient_name: string;
  patient_phone: string | null;
  note: string | null;
  status: string;
  chair: number | null;
  arrived_at: Date;
  seated_at: Date | null;
  called_at: Date | null;
  finished_at: Date | null;
  patient_id: number | null;
  appointment_id: number | null;
}

function toVisit(row: VisitRow): Visit {
  return {
    id: row.id,
    patientId: row.patient_id,
    patientName: row.patient_name,
    patientPhone: row.patient_phone,
    note: row.note,
    status: row.status as VisitStatus,
    chair: row.chair,
    arrivedAt: row.arrived_at.toISOString(),
    seatedAt: row.seated_at ? row.seated_at.toISOString() : null,
    calledAt: row.called_at ? row.called_at.toISOString() : null,
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
  };
}

/**
 * زيارات اليوم بتوقيت العيادة.
 *
 * «اليوم» يُحسب داخل Postgres بالمنطقة الزمنية للعيادة لا بـ UTC. الخادم يعمل بـ UTC،
 * وبعد التاسعة مساءً بتوقيت غرينتش يكون التاريخ في تعز قد انتقل لليوم التالي — فلو
 * قِيس اليوم بـ UTC لاختفت زيارات المساء من اللوحة أمام الاستقبال وهي جالسة معهم.
 */
export async function listTodayVisits(): Promise<Visit[]> {
  await ensureSchema();
  const { rows } = await getPool().query<VisitRow>(
    `SELECT * FROM visits
      WHERE (arrived_at AT TIME ZONE $1)::date = (NOW() AT TIME ZONE $1)::date
      ORDER BY arrived_at ASC`,
    [CLINIC_TIME_ZONE],
  );
  return rows.map(toVisit);
}

export const CLINIC_TIME_ZONE = process.env.CLINIC_TIME_ZONE || "Asia/Aden";

/**
 * زيارات يوم بعينه بتوقيت العيادة — للتقرير.
 *
 * نفس حساب اليوم الذي تستخدمه اللوحة: `AT TIME ZONE` لا مقارنة UTC. تقريرٌ يُحسب
 * بتوقيت الخادم كان سيُسقط زيارات المساء من تقرير اليوم ويضيفها إلى تقرير الغد،
 * فتظهر أيام «هادئة» ليست هادئة.
 */
export async function listVisitsByDate(date: string): Promise<Visit[]> {
  await ensureSchema();
  const { rows } = await getPool().query<VisitRow>(
    `SELECT * FROM visits
      WHERE (arrived_at AT TIME ZONE $1)::date = $2::date
      ORDER BY arrived_at ASC`,
    [CLINIC_TIME_ZONE, date],
  );
  return rows.map(toVisit);
}

/**
 * زيارات مدى تاريخي بتوقيت العيادة — لغرفة القيادة.
 *
 * نفس قاعدة «اليوم» التي تحكم اللوحة والتقرير: `AT TIME ZONE` لا UTC، فلا تنتقل
 * زيارات المساء إلى فترة لا تخصها.
 */
export async function listVisitsBetween(from: string, to: string): Promise<Visit[]> {
  await ensureSchema();
  const { rows } = await getPool().query<VisitRow>(
    `SELECT * FROM visits
      WHERE (arrived_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date
      ORDER BY arrived_at ASC`,
    [CLINIC_TIME_ZONE, from, to],
  );
  return rows.map(toVisit);
}

export async function addVisit(input: {
  patientName: string;
  patientPhone: string | null;
  note: string | null;
  /** ملفُّ المريض إن اختارته الاستقبال من القائمة — وهو ما يمنع الملف الثاني. */
  patientId?: number | null;
}): Promise<Visit> {
  await ensureSchema();
  const { rows } = await getPool().query<VisitRow>(
    `INSERT INTO visits (patient_name, patient_phone, note, patient_id)
     VALUES ($1, $2, $3, $4::int) RETURNING *`,
    [input.patientName, input.patientPhone, input.note, input.patientId ?? null],
  );
  return toVisit(rows[0]);
}

/**
 * يربط زيارةً بملفٍّ قائم.
 *
 * **العلّة التي يعالجها**: المريض المسجَّل الذي يصل بلا رقم جوال كان يُنشأ له ملفٌ
 * ثانٍ عند التوقيع، لأن حلّ الملف يطابق بالهاتف وحده. فتذهب فاتورته ومخططه إلى ملفٍ
 * غير ملفّه، ويصير له تاريخان — وهو نقيض المبدأ الأول: مريضٌ واحد بسجلٍّ واحد.
 *
 * ولا يطابق البرنامج بالاسم من تلقاء نفسه: «محمد أحمد» اسمُ رجلين، ودمجُ ملفَّي
 * شخصين أسوأ من تكرار ملفٍّ واحد — الأول يخلط تاريخين طبيّين، والثاني يُدمج لاحقًا.
 * فالربط **قرارٌ بشري**: البرنامج يعرض المرشّحين، والاستقبال تختار.
 *
 * ولا يُربط بعد التوقيع: الفاتورة صدرت لملفٍّ بعينه، وتحويلُ الزيارة بعدها يترك
 * فاتورةً في ملفٍ وعملًا في آخر.
 */
export async function linkVisitToPatient(visitId: number, patientId: number): Promise<
  { ok: true; patientName: string } | { ok: false; message: string }
> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows: visits } = await client.query<{ signed_at: Date | null; patient_id: number | null }>(
      `SELECT signed_at, patient_id FROM visits WHERE id = $1 FOR UPDATE`, [visitId],
    );
    if (!visits[0]) { await client.query("ROLLBACK"); return { ok: false, message: "الزيارة غير موجودة." }; }
    if (visits[0].signed_at) {
      await client.query("ROLLBACK");
      return { ok: false, message: "الزيارة موقَّعة — وفاتورتها صدرت لملفٍّ بعينه فلا تُحوَّل." };
    }

    const { rows: patients } = await client.query<{ full_name: string; phone: string | null }>(
      `SELECT full_name, phone FROM patients WHERE id = $1`, [patientId],
    );
    if (!patients[0]) { await client.query("ROLLBACK"); return { ok: false, message: "الملف غير موجود." }; }

    // الاسم والهاتف يتبعان الملف: ما يظهر على اللوحة يجب أن يوافق ما في السجل.
    await client.query(
      `UPDATE visits SET patient_id = $2, patient_name = $3,
              patient_phone = COALESCE(NULLIF(patient_phone, ''), $4::text)
        WHERE id = $1`,
      [visitId, patientId, patients[0].full_name, patients[0].phone],
    );
    await client.query("COMMIT");
    return { ok: true, patientName: patients[0].full_name };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * يُجلس المريض على كرسي، ويرفض إن كان الكرسي مشغولًا.
 *
 * الشرط `NOT EXISTS` داخل الاستعلام نفسه لا في الكود: الاستقبال قد تكون على شاشة
 * والطبيب على هاتفه، وضغطهما معًا على نفس الكرسي في نفس اللحظة كان سيُجلس مريضين
 * على كرسي واحد. الفحص هنا ذرّي، فيفوز واحد ويُخبَر الثاني.
 */
export async function seatVisit(id: number, chair: number): Promise<Visit | null> {
  // الحراسة محدودة بيوم العيادة عمدًا: زيارة أمس لم يضغط أحد «انتهى» عليها تبقى
  // `in_chair` في الجدول، وهي غير ظاهرة في لوحة اليوم — فلو شملها الفحص لظلّ الكرسي
  // مرفوضًا كل صباح برسالة «الكرسي شُغل للتو» بلا أحد عليه وبلا طريقة لتحريره.
  await ensureSchema();
  const { rows } = await getPool().query<VisitRow>(
    `UPDATE visits
        SET status = 'in_chair', chair = $2, seated_at = NOW()
      WHERE id = $1
        AND status IN ('waiting', 'called')
        AND NOT EXISTS (
          SELECT 1 FROM visits busy
           WHERE busy.status = 'in_chair' AND busy.chair = $2
             AND (busy.arrived_at AT TIME ZONE $3)::date = (NOW() AT TIME ZONE $3)::date
        )
      RETURNING *`,
    [id, chair, CLINIC_TIME_ZONE],
  );
  return rows[0] ? toVisit(rows[0]) : null;
}

/**
 * ينهي الزيارة، ويغلق معها موعدها إن جاءت من حجز.
 *
 * قبل هذا كان الموعد يبقى «وصل» إلى الأبد: لا شيء في النظام ينقله إلى «تم». فيفتح
 * الطبيب جدول الأمس فيرى مرضى يبدون كأنهم ما زالوا في العيادة، وتصير أرقام اليوم
 * السابق بلا معنى — وسجلٌّ لا يُصدَّق يُهجَر، وهو ما حدث للنظام الأساسي بالضبط.
 *
 * الاثنان في معاملة واحدة: زيارة منتهية وموعدها ما زال مفتوحًا حالةٌ لا يستطيع أحد
 * تصحيحها من الشاشة.
 */
export async function finishVisit(id: number): Promise<Visit | null> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<VisitRow>(
      `UPDATE visits SET status = 'done', finished_at = NOW(), chair = NULL
        WHERE id = $1 AND status <> 'done' RETURNING *`,
      [id],
    );
    if (!rows[0]) { await client.query("ROLLBACK"); return null; }
    if (rows[0].appointment_id) {
      await client.query(
        `UPDATE appointments SET status = 'done'
          WHERE id = $1 AND status IN ('booked', 'arrived')`,
        [rows[0].appointment_id],
      );
    }
    await client.query("COMMIT");
    return toVisit(rows[0]);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * يحجز جلسة قادمة للمريض الذي انتهت زيارته للتو.
 *
 * هذه هي اللحظة الوحيدة التي يكون فيها المريض واقفًا أمام الاستقبال ومعه قراره. تأجيلها
 * إلى «سنتصل بك» يعني — في عيادة تقويم تحتاج زيارة كل ثلاثة أو أربعة أسابيع — مريضًا
 * يختفي شهرين ثم يعود وقد تأخّر علاجه، ثم يشكو أن العيادة لم تتابعه.
 *
 * المريض يُحلّ من الزيارة: سجلّه إن كانت مرتبطة به، وإلا بحث بالرقم، وإلا سجلّ جديد.
 * البحث بالرقم لا بالاسم لأن «عبدالله محمد» و«عبد الله محمد» شخص واحد بسجلّين.
 * ويُثبَّت المريض في الزيارة بعدها، فلا تتكرر العملية إن حُجزت جلسة أخرى.
 */
/**
 * يحلّ ملف المريض من زيارة — ويُنشئه إن لم يوجد.
 *
 * **دالة واحدة يستعملها المساران**: حجزُ الجلسة القادمة، وتوقيعُ الزيارة الذي يُصدر
 * الفاتورة. وكانت محبوسة داخل حجز الجلسة، فكان توقيع زيارةِ مريضٍ مشي يفشل لأنه بلا
 * ملف — بينما نفس المريض يُنشأ له ملفٌ لو حُجزت له جلسة. سلوكان لحالة واحدة، وهو
 * أوّل ما يُنتج «مريضًا في وحدة ومريضًا آخر في وحدة».
 *
 * والبحث بالرقم لا بالاسم: «عبدالله محمد» و«عبد الله محمد» شخص واحد بسجلّين.
 * وتُستدعى **داخل معاملة الطرف المستدعي** فتسقط معه إن سقط.
 */
async function resolveVisitPatient(
  client: { query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  visit: { id: number; patient_name: string; patient_phone: string | null; patient_id: number | null },
  overridePhone?: string | null,
): Promise<number> {
  const rawPhone = overridePhone ?? visit.patient_phone;
  // الرقم يُوحَّد قبل أن يُكتب: المريض المشي يكتب رقمه محليًا، ولو حُفظ كما هو لصار
  // له سجلّ ثانٍ حين يحجز يومًا من صفحة الحجز بنفس الرقم.
  const phone = normalizePatientPhone(rawPhone);

  let patientId = visit.patient_id;
  if (!patientId && phone) {
    const { rows } = await client.query(
      `SELECT id FROM patients WHERE phone = ANY($1::text[]) ORDER BY id LIMIT 1`,
      [phoneLookupForms(rawPhone)],
    );
    patientId = (rows[0]?.id as number) ?? null;
  }
  if (!patientId) {
    const { rows } = await client.query(
      `INSERT INTO patients (patient_number, full_name, phone)
       VALUES ('P-' || LPAD(nextval('patient_number_seq')::text, 5, '0'), $1, $2)
       RETURNING id`,
      [visit.patient_name, phone],
    );
    patientId = rows[0].id as number;
  } else if (phone) {
    // رقم وصل ولم يكن في السجل: يُملأ ولا يُستبدل رقمٌ قائم.
    await client.query(
      `UPDATE patients SET phone = $2 WHERE id = $1 AND (phone IS NULL OR phone = '')`,
      [patientId, phone],
    );
  }
  // يُثبَّت في الزيارة فلا تتكرّر العملية، ويصير الرابط ظاهرًا في كل شاشة.
  await client.query(
    `UPDATE visits SET patient_id = $2 WHERE id = $1 AND patient_id IS NULL`,
    [visit.id, patientId],
  );
  return patientId;
}

/**
 * حجز الجلسة القادمة لزيارة انتهت — في معاملة واحدة مع ربط المريض إن كان غائبًا.
 *
 * بتمرير `runOn` يُنفَّذ على اتصال معاملة حارس اليوم ولا يدير معاملته بنفسه:
 * الجلسة القادمة حجزٌ كامل يُحسب في سعة اليوم كغيره من الحجوزات.
 */
export async function createNextSession(
  input: {
    visitId: number;
    date: string;
    time: string;
    durationMinutes: number;
    phone: string | null;
    note: string | null;
  },
  runOn?: PoolClient,
): Promise<{ appointmentId: number; patientId: number; patientName: string; phone: string | null } | null> {
  await ensureSchema();
  if (!runOn) {
    const outer = await getPool().connect();
    try {
      await outer.query("BEGIN");
      const done = await createNextSession(input, outer);
      if (done === null) { await outer.query("ROLLBACK"); return null; }
      await outer.query("COMMIT");
      return done;
    } catch (error) {
      await outer.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      outer.release();
    }
  }
  const client = runOn;
  const { rows: visits } = await client.query<{
    id: number; patient_name: string; patient_phone: string | null; patient_id: number | null;
  }>(
    `SELECT id, patient_name, patient_phone, patient_id FROM visits WHERE id = $1 FOR UPDATE`,
    [input.visitId],
  );
  if (!visits[0]) return null;
  const visit = visits[0];
  const phone = normalizePatientPhone(input.phone ?? visit.patient_phone);
  const patientId = await resolveVisitPatient(client, visit, input.phone ?? visit.patient_phone);

  const { rows: created } = await client.query<{ id: number }>(
    `INSERT INTO appointments (patient_id, scheduled_date, scheduled_time, duration_minutes, note)
     VALUES ($1, $2, $3, $4, $5::text) RETURNING id`,
    [patientId, input.date, input.time, input.durationMinutes, input.note],
  );

  await client.query(
    `UPDATE visits SET patient_id = $2 WHERE id = $1 AND patient_id IS NULL`,
    [input.visitId, patientId],
  );

  return {
    appointmentId: created[0].id,
    patientId,
    patientName: visit.patient_name,
    phone,
  };
}


export interface StaffUser {
  id: number;
  username: string;
  displayName: string;
  passwordHash: string;
  role: string;
  isActive: boolean;
}

interface UserRow {
  id: number;
  username: string;
  display_name: string;
  password_hash: string;
  role: string;
  is_active: boolean;
}

function toUser(row: UserRow): StaffUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    role: row.role,
    isActive: row.is_active,
  };
}

/**
 * يبحث عن المستخدم باسم دخول غير حسّاس لحالة الأحرف.
 *
 * موظفة الاستقبال ستكتب `Reception` أو `reception` حسب ما تفعله لوحة المفاتيح، ورفض
 * الدخول لهذا السبب يعني اتصالًا بك في أول صباح.
 */
export async function findUserByUsername(username: string): Promise<StaffUser | null> {
  await ensureSchema();
  const { rows } = await getPool().query<UserRow>(
    `SELECT * FROM users WHERE LOWER(username) = LOWER($1) AND is_active LIMIT 1`,
    [username],
  );
  return rows[0] ? toUser(rows[0]) : null;
}

export async function countUsers(): Promise<number> {
  await ensureSchema();
  const { rows } = await getPool().query<{ c: string }>(`SELECT count(*)::int AS c FROM users`);
  return Number(rows[0].c);
}

/**
 * ينشئ أول مدير، ويرفض إن وُجد مستخدم واحد سلفًا.
 *
 * الشرط `WHERE NOT EXISTS` داخل جملة `INSERT` نفسها لا في الكود: فحصٌ ثم إدراج في
 * خطوتين يترك نافذة يستطيع فيها طلبان متزامنان إنشاء مديرين اثنين، وأحدهما ليس أنت.
 */
export async function createFirstAdmin(input: {
  username: string;
  displayName: string;
  passwordHash: string;
}): Promise<StaffUser | null> {
  await ensureSchema();
  const { rows } = await getPool().query<UserRow>(
    `INSERT INTO users (username, display_name, password_hash, role)
     SELECT $1, $2, $3, 'admin'
      WHERE NOT EXISTS (SELECT 1 FROM users)
     RETURNING *`,
    [input.username, input.displayName, input.passwordHash],
  );
  return rows[0] ? toUser(rows[0]) : null;
}

export async function createStaffUser(input: {
  username: string;
  displayName: string;
  passwordHash: string;
  role: string;
}): Promise<StaffUser> {
  await ensureSchema();
  const { rows } = await getPool().query<UserRow>(
    `INSERT INTO users (username, display_name, password_hash, role)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [input.username, input.displayName, input.passwordHash, input.role],
  );
  return toUser(rows[0]);
}

// ─── المرضى والمواعيد ────────────────────────────────────────────────────────

import { clinicDateString } from "./schedule";
import type { Appointment, AppointmentStatus } from "./schedule";

import type { Gender, Patient, PatientInput } from "./patient";
import type { CandidatePatient } from "./duplicates";

/** ما يكفي لقائمة بحث: الحقول الثقيلة لا تُحمَّل لعشرين نتيجة لن تُقرأ. */
export interface PatientSummary {
  id: number;
  patientNumber: string;
  fullName: string;
  phone: string | null;
  medicalAlert: string | null;
}

interface PatientRow {
  id: number;
  patient_number: string;
  full_name: string;
  phone: string | null;
  alt_phone: string | null;
  gender: string;
  birth_year: number | null;
  address: string | null;
  medical_alert: string | null;
  note: string | null;
  created_at: Date;
}

const PATIENT_COLUMNS = `id, patient_number, full_name, phone, alt_phone, gender,
                         birth_year, address, medical_alert, note, created_at`;

const toPatient = (row: PatientRow): Patient => ({
  id: row.id,
  patientNumber: row.patient_number,
  fullName: row.full_name,
  phone: row.phone,
  altPhone: row.alt_phone,
  gender: (row.gender as Gender) ?? "unknown",
  birthYear: row.birth_year,
  address: row.address,
  medicalAlert: row.medical_alert,
  note: row.note,
  createdAt: row.created_at.toISOString(),
});

/**
 * صيغة موحّدة لرقم المريض في سجلّه.
 *
 * الرقم هو المُعرّف الوحيد الذي يكتبه المريض بنفسه، وعليه يعتمد منع تكرار السجلات.
 * ولأنه يصل من ثلاثة أبواب — طلب حجز من المريض، ومريض مشي تكتبه الاستقبال، وحجز
 * جلسة قادمة — كان يُخزَّن `770245745` من باب و`967770245745` من آخر، فيصير للشخص
 * الواحد سجلّان لا يعرف أحدهما الآخر. الصيغة الدولية هي المخزَّنة لأنها القاطعة.
 *
 * وما لا يصلح للجوال — رقم أرضي مثلًا — يُحفظ كما كُتب لا يُرمى: رقم أرضي يُتصل به.
 */
function normalizePatientPhone(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  return toWhatsAppNumber(trimmed) ?? trimmed;
}

/**
 * الصيغ التي قد يكون الرقم مخزّنًا بها.
 *
 * السجلات التي أُنشئت قبل توحيد الصيغة تحمل الرقم المحلي، والبحث بالصيغة الدولية
 * وحدها كان سيعتبرها مرضى جددًا وينشئ لهم سجلات ثانية.
 */
function phoneLookupForms(raw: string | null | undefined): string[] {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return [];
  const normalized = toWhatsAppNumber(trimmed);
  return normalized && normalized !== trimmed ? [normalized, trimmed] : [trimmed];
}

/**
 * يبحث بالاسم أو الهاتف.
 *
 * البحث بالجزء لا بالبداية: الاستقبال تتذكر «محمد» من «عبدالله محمد سالم»، والبحث
 * بالبداية وحده كان سيعيد لا شيء فتُنشئ سجلًا مكررًا لمريض موجود.
 */
export async function searchPatients(term: string, limit = 8): Promise<PatientSummary[]> {
  await ensureSchema();
  const trimmed = term.trim();
  if (!trimmed) return [];
  // الرقم يُبحث عنه بصيغتيه: من كتب `770…` يجب أن يجد سجلًا مخزّنًا `967770…`.
  const forms = phoneLookupForms(trimmed);
  const { rows } = await getPool().query<PatientRow>(
    `SELECT id, patient_number, full_name, phone, medical_alert FROM patients
      WHERE full_name ILIKE $1
         OR phone ILIKE $1 OR alt_phone ILIKE $1
         OR phone = ANY($3::text[]) OR alt_phone = ANY($3::text[])
         OR patient_number ILIKE $1
      ORDER BY full_name LIMIT $2`,
    [`%${trimmed}%`, limit, forms],
  );
  return rows.map((row) => ({
    id: row.id,
    patientNumber: row.patient_number,
    fullName: row.full_name,
    phone: row.phone,
    medicalAlert: row.medical_alert,
  }));
}

/** صفحة من كل المرضى — للتصفّح حين لا يعرف الباحث ما يكتب. */
export async function listPatients(offset: number, limit: number): Promise<{
  rows: PatientSummary[]; total: number;
}> {
  await ensureSchema();
  const pool = getPool();
  const [{ rows }, { rows: counted }] = await Promise.all([
    pool.query<PatientRow>(
      `SELECT id, patient_number, full_name, phone, medical_alert FROM patients
        ORDER BY created_at DESC, id DESC OFFSET $1 LIMIT $2`,
      [offset, limit],
    ),
    pool.query<{ c: string }>(`SELECT count(*)::int AS c FROM patients`),
  ]);
  return {
    rows: rows.map((row) => ({
      id: row.id,
      patientNumber: row.patient_number,
      fullName: row.full_name,
      phone: row.phone,
      medicalAlert: row.medical_alert,
    })),
    total: Number(counted[0].c),
  };
}

/**
 * ينشئ مريضًا برقم متسلسل.
 *
 * الرقم يُولَّد داخل الاستعلام من أكبر رقم موجود، لا من عدّ السجلات: العدّ يعيد استخدام
 * رقم مريض محذوف فيصير لمريضين الرقم نفسه في سجلات مطبوعة قديمة.
 */
/**
 * مرشّحو التكرار لمريض على وشك الإنشاء.
 *
 * الاستعلام واسعٌ عمدًا ثم يُصفّى في الذاكرة: القاعدة تُرجّح بالهاتف وبأول كلمة من
 * الاسم، والمنطق العربي (الهمزات، التاء المربوطة، «عبد الله») يُطبَّق في
 * `lib/duplicates` حيث يُختبر. ولو صُفّي في SQL وحده لاحتاج امتدادات وفهارس نصّية
 * لا يستحقّها حجم عيادة، ولصار المنطق غير قابل للاختبار بلا قاعدة.
 */
export async function duplicateCandidates(input: {
  fullName: string; phone: string | null; altPhone: string | null;
}): Promise<CandidatePatient[]> {
  await ensureSchema();
  const phones = [
    ...phoneLookupForms(input.phone),
    ...phoneLookupForms(input.altPhone),
  ];
  /*
   * **كل** كلمات الاسم لا أولاها.
   *
   * الأولى وحدها كانت تفوّت أشيع حالتين: «عبدالله محمد» ملتصقةً لا تطابق «عبد الله
   * محمد» مفصولةً، والاسم المختصر يبدأ بكلمة أخرى. والبحث بكل الكلمات يجد السجل من
   * أي كلمة مشتركة، ثم يفصل المنطقُ العربي في `lib/duplicates` أهو نفس الشخص.
   */
  const words = input.fullName.trim().split(/\s+/).filter((w) => w.length > 1).slice(0, 6);
  const patterns = words.map((word) => `%${word}%`);

  const { rows } = await getPool().query<{
    id: number; patient_number: string; full_name: string;
    phone: string | null; alt_phone: string | null; birth_year: number | null;
  }>(
    `SELECT id, patient_number, full_name, phone, alt_phone, birth_year
       FROM patients
      WHERE ($1::text[] <> '{}' AND (phone = ANY($1::text[]) OR alt_phone = ANY($1::text[])))
         OR ($2::text[] <> '{}' AND full_name ILIKE ANY($2::text[]))
      ORDER BY id DESC
      LIMIT 60`,
    [phones, patterns],
  );
  return rows.map((row) => ({
    id: row.id,
    patientNumber: row.patient_number,
    fullName: row.full_name,
    phone: row.phone,
    altPhone: row.alt_phone,
    birthYear: row.birth_year,
  }));
}

export async function createPatient(input: PatientInput): Promise<Patient> {
  await ensureSchema();
  const { rows } = await getPool().query<PatientRow>(
    `INSERT INTO patients (patient_number, full_name, phone, alt_phone, gender, birth_year, address, medical_alert, note)
     VALUES (
       'P-' || LPAD(nextval('patient_number_seq')::text, 5, '0'),
       $1, $2::text, $3::text, $4, $5::int, $6::text, $7::text, $8::text)
     RETURNING ${PATIENT_COLUMNS}`,
    [
      input.fullName,
      normalizePatientPhone(input.phone),
      normalizePatientPhone(input.altPhone),
      input.gender,
      input.birthYear,
      input.address,
      input.medicalAlert,
      input.note,
    ],
  );
  return toPatient(rows[0]);
}

/** مريض بعينه — لشاشة التعديل ولكشف الحساب. */
export async function getPatient(id: number): Promise<Patient | null> {
  await ensureSchema();
  const { rows } = await getPool().query<PatientRow>(
    `SELECT ${PATIENT_COLUMNS} FROM patients WHERE id = $1`, [id],
  );
  return rows[0] ? toPatient(rows[0]) : null;
}

interface AppointmentRow {
  id: number;
  patient_id: number;
  full_name: string;
  phone: string | null;
  scheduled_date: Date;
  scheduled_time: string;
  duration_minutes: number;
  appointment_type: string | null;
  note: string | null;
  status: string;
  reminder_sent_at: Date | null;
}

function toAppointment(row: AppointmentRow): Appointment {
  const date = row.scheduled_date;
  return {
    id: row.id,
    patientId: row.patient_id,
    patientName: row.full_name,
    patientPhone: row.phone,
    // التاريخ يُنسّق من مكوّناته المحلية لا بـ toISOString: الأخيرة تحوّل إلى UTC فتُرجع
    // اليوم السابق لكل موعد مسائي — وهو نفس الفخ الذي أسقط لوحة اليوم لولا الانتباه.
    scheduledDate: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
    scheduledTime: String(row.scheduled_time).slice(0, 5),
    durationMinutes: row.duration_minutes,
    note: row.note,
    status: row.status as AppointmentStatus,
    reminderSentAt: row.reminder_sent_at ? row.reminder_sent_at.toISOString() : null,
  };
}

const APPOINTMENT_SELECT = `
  SELECT a.id, a.patient_id, p.full_name, p.phone, a.scheduled_date, a.scheduled_time,
         a.duration_minutes, a.appointment_type, a.note, a.status, a.reminder_sent_at
    FROM appointments a JOIN patients p ON p.id = a.patient_id`;

export async function listAppointmentsByDate(date: string): Promise<Appointment[]> {
  await ensureSchema();
  const { rows } = await getPool().query<AppointmentRow>(
    `${APPOINTMENT_SELECT} WHERE a.scheduled_date = $1 ORDER BY a.scheduled_time`,
    [date],
  );
  return rows.map(toAppointment);
}

export async function createAppointment(input: {
  patientId: number;
  date: string;
  time: string;
  durationMinutes: number;
  note: string | null;
}): Promise<Appointment | null> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const created = await insertAppointmentOnClient(client, input);
    await client.query("COMMIT");
    return created;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** إدراج موعد على اتصال قائم — يُستدعى داخل معاملة حارس اليوم لا منفردًا. */
export async function insertAppointmentOnClient(
  client: PoolClient,
  input: { patientId: number; date: string; time: string; durationMinutes: number; note: string | null },
): Promise<Appointment | null> {
  const { rows } = await client.query<{ id: number }>(
    `INSERT INTO appointments (patient_id, scheduled_date, scheduled_time, duration_minutes, note)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [input.patientId, input.date, input.time, input.durationMinutes, input.note],
  );
  const { rows: full } = await client.query<AppointmentRow>(
    `${APPOINTMENT_SELECT} WHERE a.id = $1`, [rows[0].id],
  );
  return full[0] ? toAppointment(full[0]) : null;
}

/**
 * حارس اليوم الذرّي لكل كتابةٍ تضيف إشغالًا على كراسي يومٍ ما.
 *
 * الحجز يعاني سباقًا كلاسيكيًا إن اكتفى بفحص ثم كتابة: جهاز الاستقبال وهاتف الطبيب
 * يقرآن يومَ اليوم فارغًا في اللحظة نفسها فيحجزان فوق كرسيٍّ واحد، ولا يراهما
 * بعضهما لأن كل قراءة جرت قبل كتابة الآخر. فالقفل هنا **استشاري على مستوى اليوم
 * داخل معاملة**: كل من يريد الإضافة إلى يومٍ معيّن ينتظر القفل نفسه، فإذا نالَه
 * أعاد قراءة مواعيد اليوم على اتصال المعاملة نفسه — فيرى ما كتبه من سبقه — ثم
 * تُسلَّم المواعيد للحكم النقيّ (فحص السعة نفسه المُختبَر) ثم تُكتب على الاتصال
 * نفسه في نفس المعاملة. الرفض يُفشِل القفل دون كتابة، والقفل يموت بانتهاء
 * المعاملة ولو انهار الاتصال — فلا بقايا.
 *
 * `judge` نقيّ بلا شبكة (نمط checkSlot) و`commit` يكتب على اتصال المعاملة حصرًا.
 */
export async function writeAppointmentInDay<T>(input: {
  date: string;
  judge: (day: Appointment[]) => { ok: true } | { ok: false; conflict: unknown };
  commit: (client: PoolClient) => Promise<T>;
}): Promise<{ ok: true; value: T } | { ok: false; conflict: unknown }> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('appointments-day:' || $1))`,
      [input.date],
    );
    const { rows } = await client.query<AppointmentRow>(
      `${APPOINTMENT_SELECT} WHERE a.scheduled_date = $1 ORDER BY a.scheduled_time`,
      [input.date],
    );
    const verdict = input.judge(rows.map(toAppointment));
    if (!verdict.ok) {
      await client.query("COMMIT"); // لا كتابة — إفشاء القفل وحده
      return { ok: false, conflict: verdict.conflict };
    }
    const value = await input.commit(client);
    await client.query("COMMIT");
    return { ok: true, value };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function setAppointmentStatus(
  id: number,
  status: AppointmentStatus,
): Promise<Appointment | null> {
  await ensureSchema();
  await getPool().query(
    `UPDATE appointments SET status = $2,
            arrived_at = CASE WHEN $2 = 'arrived' THEN NOW() ELSE arrived_at END
      WHERE id = $1`,
    [id, status],
  );
  const { rows } = await getPool().query<AppointmentRow>(`${APPOINTMENT_SELECT} WHERE a.id = $1`, [id]);
  return rows[0] ? toAppointment(rows[0]) : null;
}

/**
 * وصول مريض محجوز: يصير الموعد «وصل» وتُفتح له زيارة في قائمة الانتظار — في معاملة
 * واحدة، فلا يبقى موعد معلّم كواصل بلا صفٍّ في اللوحة إن انقطع الاتصال بينهما.
 */
export async function arriveAppointment(id: number): Promise<boolean> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ patient_id: number; full_name: string; phone: string | null }>(
      `UPDATE appointments a SET status = 'arrived', arrived_at = NOW()
         FROM patients p
        WHERE a.id = $1 AND p.id = a.patient_id AND a.status = 'booked'
       RETURNING a.patient_id, p.full_name, p.phone`,
      [id],
    );
    if (!rows[0]) { await client.query("ROLLBACK"); return false; }
    await client.query(
      `INSERT INTO visits (patient_name, patient_phone, patient_id, appointment_id)
       VALUES ($1, $2, $3, $4)`,
      [rows[0].full_name, rows[0].phone, rows[0].patient_id, id],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** يسجّل أن التذكير أُرسل — حتى لا يُذكَّر مريض مرتين ويُنسى آخر. */
export async function markReminderSent(id: number): Promise<boolean> {
  await ensureSchema();
  const { rowCount } = await getPool().query(
    `UPDATE appointments SET reminder_sent_at = NOW() WHERE id = $1`, [id],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * يعيد مريضًا نُودي عليه إلى الانتظار.
 *
 * المريض لا يسمع النداء دائمًا: خرج إلى الصيدلية، أو لم ينتبه للشاشة. بلا هذا الإجراء
 * يبقى الكرسي محجوزًا له إلى آخر اليوم ولا سبيل لتحريره من الشاشة — وهو بالضبط نوع
 * «الميزة الناقصة» التي تجعل الاستقبال تترك النظام وتعود إلى الورقة.
 */
export async function returnVisitToWaiting(id: number): Promise<Visit | null> {
  await ensureSchema();
  const { rows } = await getPool().query<VisitRow>(
    `UPDATE visits SET status = 'waiting', chair = NULL, called_at = NULL
      WHERE id = $1 AND status = 'called' RETURNING *`,
    [id],
  );
  return rows[0] ? toVisit(rows[0]) : null;
}

/**
 * ينادي مريضًا إلى كرسي.
 *
 * نفس الحراسة الذرّية التي يستخدمها الإجلاس: الكرسي لا يُنادى إليه مريضان. الفرق أن
 * النداء يحجز الكرسي قبل أن يصل المريض إليه فعلًا — وهو المقصود: بين النداء والجلوس
 * دقيقة يمشي فيها المريض، ولو لم يُحجز الكرسي لنودي عليه مريض آخر في تلك الدقيقة.
 */
export async function callVisit(id: number, chair: number): Promise<Visit | null> {
  await ensureSchema();
  const { rows } = await getPool().query<VisitRow>(
    `UPDATE visits
        SET status = 'called', chair = $2, called_at = NOW()
      WHERE id = $1
        AND status = 'waiting'
        AND NOT EXISTS (
          SELECT 1 FROM visits busy
           WHERE busy.status IN ('called', 'in_chair') AND busy.chair = $2
             AND (busy.arrived_at AT TIME ZONE $3)::date = (NOW() AT TIME ZONE $3)::date
        )
      RETURNING *`,
    [id, chair, CLINIC_TIME_ZONE],
  );
  return rows[0] ? toVisit(rows[0]) : null;
}

// ─── طلبات الحجز ─────────────────────────────────────────────────────────────

import type { BookingRequest, BookingRequestInput, BookingRequestStatus, PreferredPeriod } from "./booking";

interface BookingRequestRow {
  id: number;
  full_name: string;
  phone: string;
  reason: string | null;
  preferred_date: Date | null;
  preferred_period: string;
  status: string;
  created_at: Date;
  handled_at: Date | null;
  appointment_id: number | null;
}

function toBookingRequest(row: BookingRequestRow): BookingRequest {
  const date = row.preferred_date;
  return {
    id: row.id,
    fullName: row.full_name,
    phone: row.phone,
    reason: row.reason,
    // من مكوّنات التاريخ المحلية لا بـ toISOString — نفس فخ اليوم السابق.
    preferredDate: date
      ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
      : null,
    preferredPeriod: row.preferred_period as PreferredPeriod,
    status: row.status as BookingRequestStatus,
    createdAt: row.created_at.toISOString(),
    handledAt: row.handled_at ? row.handled_at.toISOString() : null,
    appointmentId: row.appointment_id,
  };
}

/**
 * كم طلبًا أرسله هذا الرقم أو هذا المصدر في آخر أربع وعشرين ساعة.
 *
 * الصفحة عامة بلا تسجيل دخول، وبلا هذا العدّ يستطيع أي أحد أن يملأ قائمة الاستقبال
 * بألف طلب في دقيقة فتصير القائمة بلا فائدة. الحدّ يُطبَّق على الخادم لا في الواجهة:
 * الواجهة يمكن تجاوزها بطلب مباشر.
 */
export async function countRecentRequests(phone: string, sourceHash: string | null): Promise<{ byPhone: number; bySource: number }> {
  await ensureSchema();
  const { rows } = await getPool().query<{ by_phone: string; by_source: string }>(
    // النوع مُصرّح على المعامل (`$2::text`): بلا التصريح يرفض Postgres الاستعلام حين
    // تصل البصمة فارغة — «could not determine data type» — فيتحوّل طلب مريض سليم إلى
    // 503 لا سبب ظاهر له. ظهر في أول تشغيل حقيقي لا في البناء.
    `SELECT
       count(*) FILTER (WHERE phone = $1)::int AS by_phone,
       count(*) FILTER (WHERE $2::text IS NOT NULL AND source_hash = $2::text)::int AS by_source
       FROM booking_requests
      WHERE created_at > NOW() - INTERVAL '24 hours'`,
    [phone, sourceHash],
  );
  return { byPhone: Number(rows[0].by_phone), bySource: Number(rows[0].by_source) };
}

export async function createBookingRequest(
  input: BookingRequestInput,
  sourceHash: string | null,
): Promise<BookingRequest> {
  await ensureSchema();
  const { rows } = await getPool().query<BookingRequestRow>(
    `INSERT INTO booking_requests (full_name, phone, reason, preferred_date, preferred_period, source_hash)
     VALUES ($1, $2, $3::text, $4::date, $5, $6::text) RETURNING *`,
    [input.fullName, input.phone, input.reason, input.preferredDate, input.preferredPeriod, sourceHash],
  );
  return toBookingRequest(rows[0]);
}

export async function listBookingRequests(status: BookingRequestStatus): Promise<BookingRequest[]> {
  await ensureSchema();
  const { rows } = await getPool().query<BookingRequestRow>(
    // الأقدم أولًا: الطلب الذي مضى عليه يومان هو من ينتظر رده، لا الذي وصل قبل دقيقة.
    `SELECT * FROM booking_requests WHERE status = $1 ORDER BY created_at ASC LIMIT 200`,
    [status],
  );
  return rows.map(toBookingRequest);
}

export async function rejectBookingRequest(id: number): Promise<BookingRequest | null> {
  await ensureSchema();
  const { rows } = await getPool().query<BookingRequestRow>(
    `UPDATE booking_requests SET status = 'rejected', handled_at = NOW()
      WHERE id = $1 AND status = 'new' RETURNING *`,
    [id],
  );
  return rows[0] ? toBookingRequest(rows[0]) : null;
}

/**
 * يحوّل طلبًا إلى موعد مؤكّد في معاملة واحدة.
 *
 * ثلاث كتابات مرتبطة: مريض (إن كان جديدًا)، وموعد، وإغلاق الطلب. تنفيذها متتابعة بلا
 * معاملة يترك — عند انقطاع بين الثانية والثالثة — موعدًا محجوزًا وطلبًا ما زال يبدو
 * معلّقًا، فتؤكّده الاستقبال مرة ثانية ويصير للمريض موعدان.
 *
 * البحث عن المريض بالرقم لا بالاسم: «عبدالله محمد» و«عبد الله محمد» شخص واحد بسجلّين،
 * والرقم هو المُعرّف الوحيد الذي يكتبه المريض بنفسه.
 */
/**
 * تأكيد طلب حجز: يتحوّل إلى مريض (أو يُربط بموجده) وموعد كامل — في معاملة واحدة.
 *
 * بتمرير `runOn` يُنفَّذ على اتصال معاملة حارس اليوم ولا يدير معاملته بنفسه:
 * فتأكيد الطلب حجزٌ كامل، ولا يجوز أن يفلت من فحص السعة الذي يُلزم الحجز اليدوي.
 */
export async function confirmBookingRequest(
  input: {
    id: number;
    date: string;
    time: string;
    durationMinutes: number;
  },
  runOn?: PoolClient,
): Promise<{ appointmentId: number; patientId: number } | null> {
  await ensureSchema();
  if (!runOn) {
    const outer = await getPool().connect();
    try {
      await outer.query("BEGIN");
      const done = await confirmBookingRequest(input, outer);
      if (done === null) { await outer.query("ROLLBACK"); return null; }
      await outer.query("COMMIT");
      return done;
    } catch (error) {
      await outer.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      outer.release();
    }
  }
  const client = runOn;
  const { rows: requests } = await client.query<{ full_name: string; phone: string; reason: string | null }>(
    `SELECT full_name, phone, reason FROM booking_requests
      WHERE id = $1 AND status = 'new' FOR UPDATE`,
    [input.id],
  );
  if (!requests[0]) return null;
  const request = requests[0];

  const { rows: existing } = await client.query<{ id: number }>(
    `SELECT id FROM patients WHERE phone = ANY($1::text[]) ORDER BY id LIMIT 1`,
    [phoneLookupForms(request.phone)],
  );
  let patientId = existing[0]?.id;
  if (!patientId) {
    const { rows: created } = await client.query<{ id: number }>(
      `INSERT INTO patients (patient_number, full_name, phone)
       VALUES (
         'P-' || LPAD(nextval('patient_number_seq')::text, 5, '0'),
         $1, $2)
       RETURNING id`,
      [request.full_name, request.phone],
    );
    patientId = created[0].id;
  }

  const { rows: appointments } = await client.query<{ id: number }>(
    `INSERT INTO appointments (patient_id, scheduled_date, scheduled_time, duration_minutes, note)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [patientId, input.date, input.time, input.durationMinutes, request.reason],
  );

  await client.query(
    `UPDATE booking_requests SET status = 'confirmed', handled_at = NOW(), appointment_id = $2
      WHERE id = $1`,
    [input.id, appointments[0].id],
  );
  return { appointmentId: appointments[0].id, patientId };
}

// ─── ملف المريض ──────────────────────────────────────────────────────────────

export interface PatientFile {
  patient: Patient;
  visits: Visit[];
  appointments: Appointment[];
}

/**
 * ملف المريض: بياناته وتاريخه في استعلام واحد لكل جزء.
 *
 * الاستقبال تُسأل عشر مرات في اليوم «متى كانت آخر زيارة له؟» و«هل عنده موعد؟»،
 * وبلا هذه الصفحة تُجاب من الذاكرة أو لا تُجاب. وهي أيضًا ما يجعل بقية الوحدات
 * ذات معنى: موعد بلا تاريخ مريض هو سطر في جدول، لا متابعة علاج.
 *
 * التاريخ محدود بعدد معقول لكل جزء: ملف مريض تقويم بعد عامين فيه عشرات الزيارات،
 * وتحميلها كلها في هاتف الاستقبال يبطئ الصفحة بلا أن يقرأها أحد.
 */
export async function getPatientFile(id: number): Promise<PatientFile | null> {
  await ensureSchema();
  const pool = getPool();
  const { rows: patients } = await pool.query<PatientRow>(
    `SELECT ${PATIENT_COLUMNS} FROM patients WHERE id = $1`, [id],
  );
  if (!patients[0]) return null;

  const [{ rows: visitRows }, { rows: appointmentRows }] = await Promise.all([
    pool.query<VisitRow>(
      `SELECT * FROM visits WHERE patient_id = $1 ORDER BY arrived_at DESC LIMIT 50`,
      [id],
    ),
    pool.query<AppointmentRow>(
      `${APPOINTMENT_SELECT} WHERE a.patient_id = $1
        ORDER BY a.scheduled_date DESC, a.scheduled_time DESC LIMIT 50`,
      [id],
    ),
  ]);

  return {
    patient: toPatient(patients[0]),
    visits: visitRows.map(toVisit),
    appointments: appointmentRows.map(toAppointment),
  };
}

/**
 * يحدّث بيانات المريض القابلة للتصحيح.
 *
 * الاسم والرقم يُكتبان على عجل في يوم مزدحم، وبلا تصحيح يبقى الخطأ إلى الأبد ويُنشأ
 * سجل ثانٍ بدلًا منه. الرقم يُوحَّد كما في كل مكان آخر يكتب سجل مريض.
 */
export async function updatePatient(
  id: number,
  input: Partial<PatientInput>,
): Promise<Patient | null> {
  await ensureSchema();
  // التحديث الجزئي بعلَم لكل حقل: `COALESCE` وحده لا يفرّق بين «لم يُرسَل» و«أُرسل
  // فارغًا عمدًا»، فمسحُ رقم بديل خاطئ كان مستحيلًا — يبقى إلى الأبد.
  const has = (key: keyof PatientInput) => input[key] !== undefined;
  const { rows } = await getPool().query<PatientRow>(
    `UPDATE patients SET
       full_name     = COALESCE($2::text, full_name),
       phone         = CASE WHEN $3::boolean  THEN $4::text  ELSE phone         END,
       alt_phone     = CASE WHEN $5::boolean  THEN $6::text  ELSE alt_phone     END,
       gender        = COALESCE($7::text, gender),
       birth_year    = CASE WHEN $8::boolean  THEN $9::int   ELSE birth_year    END,
       address       = CASE WHEN $10::boolean THEN $11::text ELSE address       END,
       medical_alert = CASE WHEN $12::boolean THEN $13::text ELSE medical_alert END,
       note          = CASE WHEN $14::boolean THEN $15::text ELSE note          END
     WHERE id = $1
     RETURNING ${PATIENT_COLUMNS}`,
    [
      id,
      input.fullName ?? null,
      has("phone"), has("phone") ? normalizePatientPhone(input.phone) : null,
      has("altPhone"), has("altPhone") ? normalizePatientPhone(input.altPhone) : null,
      input.gender ?? null,
      has("birthYear"), has("birthYear") ? input.birthYear : null,
      has("address"), has("address") ? input.address : null,
      has("medicalAlert"), has("medicalAlert") ? input.medicalAlert : null,
      has("note"), has("note") ? input.note : null,
    ],
  );
  return rows[0] ? toPatient(rows[0]) : null;
}

// ─── أعمال المختبر ───────────────────────────────────────────────────────────

import type { LabOrder, LabOrderStatus } from "./lab";

interface LabOrderRow {
  id: number;
  patient_id: number;
  full_name: string;
  phone: string | null;
  lab_name: string;
  lab_phone: string | null;
  work_type: string;
  details: string | null;
  sent_date: Date;
  due_date: Date;
  status: string;
  received_at: Date | null;
  delivered_at: Date | null;
  note: string | null;
}

/** التاريخ من مكوّناته المحلية لا بـ toISOString — نفس فخ اليوم السابق. */
function dateText(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function toLabOrder(row: LabOrderRow): LabOrder {
  return {
    id: row.id,
    patientId: row.patient_id,
    patientName: row.full_name,
    patientPhone: row.phone,
    labName: row.lab_name,
    labPhone: row.lab_phone,
    workType: row.work_type,
    details: row.details,
    sentDate: dateText(row.sent_date),
    dueDate: dateText(row.due_date),
    status: row.status as LabOrderStatus,
    receivedAt: row.received_at ? row.received_at.toISOString() : null,
    deliveredAt: row.delivered_at ? row.delivered_at.toISOString() : null,
    note: row.note,
  };
}

const LAB_SELECT = `
  SELECT l.id, l.patient_id, p.full_name, p.phone, l.lab_name, l.lab_phone, l.work_type,
         l.details, l.sent_date, l.due_date, l.status, l.received_at, l.delivered_at, l.note
    FROM lab_orders l JOIN patients p ON p.id = l.patient_id`;

/**
 * الأعمال المفتوحة وما أُنجز حديثًا.
 *
 * ما سُلّم قبل شهور لا يُحمَّل: القائمة أداة عمل يومية لا أرشيفًا، وصفحة تُحمّل مئات
 * الصفوف على هاتف الاستقبال تُفتح مرة ثم تُهجَر. الأرشيف الكامل يظهر في ملف المريض.
 */
export async function listLabOrders(): Promise<LabOrder[]> {
  await ensureSchema();
  const { rows } = await getPool().query<LabOrderRow>(
    `${LAB_SELECT}
      WHERE l.status IN ('sent', 'received')
         OR l.delivered_at > NOW() - INTERVAL '30 days'
      ORDER BY l.due_date ASC
      LIMIT 300`,
  );
  return rows.map(toLabOrder);
}

/**
 * ينشئ أمر مختبر، ويسجّل تكلفته التزامًا على العيادة في نفس المعاملة.
 *
 * التكلفة والالتزام معًا أو لا شيء: أمرٌ سُجّل وتكلفته ضاعت يعني عملًا يُنتظر بلا
 * أثر مالي، ثم يأتي المختبر بحسابه آخر الشهر فلا يُقابَل بشيء يُراجَع.
 */
export async function createLabOrder(input: {
  patientId: number;
  labName: string;
  labPhone: string | null;
  workType: string;
  details: string | null;
  sentDate: string;
  dueDate: string;
  note: string | null;
  partyId: number | null;
  costMinor: number | null;
  costCurrency: Currency | null;
  baseCurrency: Currency;
  exchangeRate: number;
  createdBy: string;
}): Promise<LabOrder | null> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO lab_orders (patient_id, lab_name, lab_phone, work_type, details, sent_date,
                               due_date, note, party_id, cost_minor, cost_currency)
       VALUES ($1, $2, $3::text, $4, $5::text, $6::date, $7::date, $8::text, $9::int, $10::bigint, $11::text)
       RETURNING id`,
      [
        input.patientId, input.labName, input.labPhone, input.workType,
        input.details, input.sentDate, input.dueDate, input.note,
        input.partyId, input.costMinor, input.costCurrency,
      ],
    );
    const orderId = rows[0].id;

    if (input.partyId && input.costMinor && input.costCurrency) {
      const baseAmount = toBaseAmount(
        input.costMinor, input.costCurrency, input.baseCurrency, input.exchangeRate,
      );
      await client.query(
        `INSERT INTO payables (party_id, category, description, amount_minor, currency,
                               exchange_rate, base_amount_minor, base_currency, lab_order_id, due_date, created_by)
         VALUES ($1, 'lab', $2, $3, $4, $5, $6, $7, $8, $9::date, $10)
         ON CONFLICT (lab_order_id) WHERE lab_order_id IS NOT NULL DO NOTHING`,
        [
          input.partyId,
          `${input.workType}${input.details ? ` — ${input.details}` : ""}`,
          input.costMinor, input.costCurrency, input.exchangeRate, baseAmount,
          input.baseCurrency, orderId, input.dueDate, input.createdBy,
        ],
      );
    }

    await client.query("COMMIT");
    const { rows: full } = await getPool().query<LabOrderRow>(`${LAB_SELECT} WHERE l.id = $1`, [orderId]);
    return full[0] ? toLabOrder(full[0]) : null;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * ينقل العمل بين حالاته، ولا يسمح بقفزة إلى الوراء.
 *
 * الشرط على الحالة الحالية داخل الاستعلام: ضغطتان على «وصل» من جهازين — الاستقبال
 * على الشاشة والطبيب على هاتفه — كانتا ستكتبان تاريخ وصول ثانيًا يمحو الأول، فيبدو
 * العمل كأنه وصل اليوم وهو واصل منذ ثلاثة أيام.
 */
export async function setLabOrderStatus(id: number, status: LabOrderStatus): Promise<LabOrder | null> {
  await ensureSchema();
  const allowedFrom: Record<LabOrderStatus, string[]> = {
    sent: ["received"],
    received: ["sent"],
    delivered: ["received"],
    cancelled: ["sent", "received"],
  };
  const { rows } = await getPool().query<{ id: number }>(
    `UPDATE lab_orders SET
       status = $2,
       received_at  = CASE WHEN $2 = 'received'  THEN NOW() ELSE received_at  END,
       delivered_at = CASE WHEN $2 = 'delivered' THEN NOW() ELSE delivered_at END
     WHERE id = $1 AND status = ANY($3::text[])
     RETURNING id`,
    [id, status, allowedFrom[status]],
  );
  if (!rows[0]) return null;
  const { rows: full } = await getPool().query<LabOrderRow>(`${LAB_SELECT} WHERE l.id = $1`, [id]);
  return full[0] ? toLabOrder(full[0]) : null;
}

/** يؤجّل موعد التسليم حين يعد المختبر بموعد جديد — بلا هذا يبقى «متأخرًا» بلا معنى. */
export async function setLabOrderDueDate(id: number, dueDate: string): Promise<LabOrder | null> {
  await ensureSchema();
  const { rows } = await getPool().query<{ id: number }>(
    `UPDATE lab_orders SET due_date = $2::date WHERE id = $1 AND status = 'sent' RETURNING id`,
    [id, dueDate],
  );
  if (!rows[0]) return null;
  const { rows: full } = await getPool().query<LabOrderRow>(`${LAB_SELECT} WHERE l.id = $1`, [id]);
  return full[0] ? toLabOrder(full[0]) : null;
}

/**
 * أرقام المختبر معدودة في Postgres لا في الذاكرة.
 *
 * اللوحة تسأل عنها كل عشرين ثانية. جلبُ الصفوف كلها ثم عدّها في الخادم يعمل اليوم
 * وثلاثون صفًّا في الجدول، ويصير حِملًا بلا سبب بعد سنة — والعدّ هنا لا يحتاج صفًّا
 * واحدًا في الذاكرة. «اليوم» بتوقيت العيادة لا بـUTC، وإلا حُسب عمل يستحق غدًا متأخرًا.
 */
export async function labCounts(): Promise<{
  outstanding: number; late: number; dueToday: number; waitingFitting: number;
}> {
  await ensureSchema();
  const { rows } = await getPool().query<{
    outstanding: string; late: string; due_today: string; waiting_fitting: string;
  }>(
    `SELECT
       count(*) FILTER (WHERE status = 'sent')::int AS outstanding,
       count(*) FILTER (WHERE status = 'sent' AND due_date < (NOW() AT TIME ZONE $1)::date)::int AS late,
       count(*) FILTER (WHERE status = 'sent' AND due_date = (NOW() AT TIME ZONE $1)::date)::int AS due_today,
       count(*) FILTER (WHERE status = 'received')::int AS waiting_fitting
     FROM lab_orders`,
    [CLINIC_TIME_ZONE],
  );
  return {
    outstanding: Number(rows[0].outstanding),
    late: Number(rows[0].late),
    dueToday: Number(rows[0].due_today),
    waitingFitting: Number(rows[0].waiting_fitting),
  };
}

/** أسماء المختبرات المستخدمة سابقًا — تُختصر الكتابة وتمنع «النور» و«مختبر النور». */
export async function listLabNames(): Promise<{ labName: string; labPhone: string | null }[]> {
  await ensureSchema();
  const { rows } = await getPool().query<{ lab_name: string; lab_phone: string | null }>(
    `SELECT lab_name, MAX(lab_phone) AS lab_phone FROM lab_orders
      GROUP BY lab_name ORDER BY MAX(created_at) DESC LIMIT 10`,
  );
  return rows.map((row) => ({ labName: row.lab_name, labPhone: row.lab_phone }));
}

// ─── الاستدعاء ومتابعة المتغيّبين ────────────────────────────────────────────

import type { RecallRow } from "./recall";

/**
 * المتغيّبون الذين لم يُتابَعوا بعد.
 *
 * موعد فائت بلا مكالمة هو المريض الذي يفهم أن العيادة لم تلاحظ غيابه. والمدى محدود
 * بشهر: الاتصال بمن تغيّب قبل ثلاثة أشهر ليس متابعة غياب — إنه استدعاء، وله قائمته.
 */
export async function listMissedAppointments(): Promise<RecallRow[]> {
  await ensureSchema();
  const { rows } = await getPool().query<{
    id: number; patient_id: number; full_name: string; phone: string | null;
    scheduled_date: Date; note: string | null;
  }>(
    `SELECT a.id, a.patient_id, p.full_name, p.phone, a.scheduled_date, a.note
       FROM appointments a JOIN patients p ON p.id = a.patient_id
      WHERE a.status = 'no_show'
        AND a.follow_up_at IS NULL
        AND a.scheduled_date > CURRENT_DATE - INTERVAL '30 days'
      ORDER BY a.scheduled_date ASC
      LIMIT 100`,
  );
  return rows.map((row) => ({
    kind: "missed" as const,
    id: row.id,
    patientId: row.patient_id,
    patientName: row.full_name,
    patientPhone: row.phone,
    referenceDate: dateText(row.scheduled_date),
    note: row.note,
  }));
}

/**
 * المنقطعون: مرضى مضى على آخر نشاط لهم أكثر من المدة، ولا موعد قادم لهم.
 *
 * شرط «لا موعد قادم» هو الذي يجعل القائمة صالحة: من انقطع شهرين ولكنه حاجز الأسبوع
 * القادم ليس منقطعًا، والاتصال به يقول له إن العيادة لا تعرف مواعيدها.
 *
 * «آخر نشاط» أكبر التاريخين — آخر زيارة وآخر موعد — لأن المريض قد يكون له موعد
 * مسجّل بلا زيارة (سُجّل يدويًا) أو زيارة بلا موعد (مريض مشي).
 *
 * ومن استُدعي في آخر ثلاثين يومًا يخرج مؤقتًا: مكالمتان في أسبوع إلحاحٌ لا اهتمام.
 */
export async function listLapsedPatients(weeks: number): Promise<RecallRow[]> {
  await ensureSchema();
  const days = Math.max(1, Math.round(weeks * 7));
  const { rows } = await getPool().query<{
    id: number; full_name: string; phone: string | null; last_activity: Date; note: string | null;
  }>(
    `WITH activity AS (
       SELECT p.id, p.full_name, p.phone, p.note, p.recalled_at,
              GREATEST(
                COALESCE((SELECT MAX(v.arrived_at)::date FROM visits v WHERE v.patient_id = p.id), p.created_at::date),
                COALESCE((SELECT MAX(a.scheduled_date) FROM appointments a
                           WHERE a.patient_id = p.id AND a.status IN ('done', 'arrived')), p.created_at::date)
              ) AS last_activity
         FROM patients p
        WHERE NOT EXISTS (
                SELECT 1 FROM appointments f
                 WHERE f.patient_id = p.id
                   AND f.scheduled_date >= CURRENT_DATE
                   AND f.status IN ('booked', 'arrived')
              )
     )
     SELECT id, full_name, phone, note, last_activity
       FROM activity
      WHERE last_activity < CURRENT_DATE - ($1::int * INTERVAL '1 day')
        AND (recalled_at IS NULL OR recalled_at < NOW() - INTERVAL '30 days')
      ORDER BY last_activity ASC
      LIMIT 100`,
    [days],
  );
  return rows.map((row) => ({
    kind: "lapsed" as const,
    id: row.id,
    patientId: row.id,
    patientName: row.full_name,
    patientPhone: row.phone,
    referenceDate: dateText(row.last_activity),
    note: row.note,
  }));
}

/**
 * يُسجَّل بعد فتح واتساب لا قبله: التسجيل قبل الفتح يزعم متابعةً لم تحدث.
 *
 * `COALESCE` يُبقي أول وقت متابعة: ضغطة ثانية على الزر — أو فتح واتساب مرتين —
 * كانت ستكتب وقتًا جديدًا فيبدو أننا تابعنا المتغيّب اليوم وقد تابعناه قبل أسبوع.
 * التاريخ الأول هو الحقيقة، وهو ما يُقاس به أثر المتابعة.
 */
export async function markAppointmentFollowedUp(id: number): Promise<boolean> {
  await ensureSchema();
  const { rowCount } = await getPool().query(
    `UPDATE appointments SET follow_up_at = COALESCE(follow_up_at, NOW())
      WHERE id = $1 AND status = 'no_show'`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * آخر استدعاء — لا أوّله: عليه يقوم إخفاء المريض ثلاثين يومًا عن القائمة. لو حُفظ
 * الأول لعاد المريض إلى القائمة كل يوم بعد شهر من أول اتصال مهما اتُّصل به بعده.
 */
export async function markPatientRecalled(id: number): Promise<boolean> {
  await ensureSchema();
  const { rowCount } = await getPool().query(
    `UPDATE patients SET recalled_at = NOW() WHERE id = $1`, [id],
  );
  return (rowCount ?? 0) > 0;
}

// ─── الإعدادات ───────────────────────────────────────────────────────────────

import {
  ALL_SETTING_KEYS,
  SETTING_DEFAULTS,
  chairCount,
  rateFromSettings,
  withDefaults,
  type SettingKey,
  type SettingsMap,
} from "./settings";

/**
 * ذاكرة قصيرة للإعدادات.
 *
 * الإعدادات تُقرأ في كل طلب تقريبًا — كل صفحة تحتاج اسم المركز، وكل حساب يحتاج عدد
 * الكراسي أو سعر الصرف — وقراءتها من القاعدة في كل مرة استعلامٌ زائد على كل نقرة.
 * وخمس ثوانٍ من التقادم مقبولة هنا: أسوأ ما يحدث أن يرى من غيّر السعر قيمته القديمة
 * لثوانٍ. والحفظ يُبطل الذاكرة فورًا فلا ينتظر حتى ذلك.
 */
const SETTINGS_TTL_MS = 5_000;
let settingsCache: { value: SettingsMap; at: number } | null = null;

export function invalidateSettingsCache(): void {
  settingsCache = null;
}

export async function getSettings(): Promise<SettingsMap> {
  const now = Date.now();
  if (settingsCache && now - settingsCache.at < SETTINGS_TTL_MS) return settingsCache.value;

  await ensureSchema();
  const { rows } = await getPool().query<{ key: string; value: string }>(
    `SELECT key, value FROM settings`,
  );
  const stored: Record<string, string> = {};
  for (const row of rows) stored[row.key] = row.value;
  const value = withDefaults(stored);
  settingsCache = { value, at: now };
  return value;
}

/**
 * الإعدادات بلا انهيار.
 *
 * تُستدعى من التخطيط الجذري الذي يُصيّر **كل** صفحة، بما فيها صفحة تسجيل الدخول.
 * ولو رمت عند انقطاع القاعدة لصارت شاشة بيضاء في كل مسار بلا رسالة — بينما البرنامج
 * يستطيع أن يعمل بالافتراضيات حتى تعود القاعدة.
 */
export async function getSettingsSafe(): Promise<SettingsMap> {
  try {
    return await getSettings();
  } catch {
    return withDefaults({});
  }
}

/**
 * يحفظ المفاتيح المُرسَلة وحدها.
 *
 * `ON CONFLICT` بدل حذف وإدراج: الحفظ الجزئي من شاشة مفتوحة على قسم واحد يجب ألا
 * يمسح أقسامًا أخرى. والمفاتيح المجهولة تُرفض قبل الوصول إلى هنا.
 */
export async function saveSettings(values: Partial<Record<SettingKey, string>>): Promise<SettingsMap> {
  await ensureSchema();
  const entries = ALL_SETTING_KEYS
    .filter((key) => values[key] !== undefined)
    .map((key) => [key, String(values[key] ?? SETTING_DEFAULTS[key]).trim()] as const);

  if (entries.length > 0) {
    await getPool().query(
      `INSERT INTO settings (key, value)
       SELECT key, value FROM UNNEST($1::text[], $2::text[]) AS t(key, value)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [entries.map(([key]) => key), entries.map(([, value]) => value)],
    );
  }
  invalidateSettingsCache();
  return getSettings();
}

// ─── المالية ─────────────────────────────────────────────────────────────────

import {
  MINOR_UNITS,
  isCurrency,
  toBaseAmount,
  type Currency,
  type PaymentLike,
} from "./money";

export interface Service {
  id: number;
  name: string;
  category: string | null;
  priceMinor: number;
  isActive: boolean;
  sortOrder: number;
}

interface ServiceRow {
  id: number; name: string; category: string | null;
  price_minor: string; is_active: boolean; sort_order: number;
}

// `BIGINT` يصل من pg نصًّا لا رقمًا — وهو الصحيح لأنه قد يتجاوز حدّ العدد الآمن.
// مبالغ العيادة أصغر من ذلك بكثير، فالتحويل آمن، لكن نسيانَه يعطي «"12500" + 1»
// = «"125001"» — وهو نوع الخطأ الذي لا يُكتشف إلا في رصيد مريض.
const toMinor = (value: string | number | null): number => Number(value ?? 0);

const toService = (row: ServiceRow): Service => ({
  id: row.id,
  name: row.name,
  category: row.category,
  priceMinor: toMinor(row.price_minor),
  isActive: row.is_active,
  sortOrder: row.sort_order,
});

export async function listServices(includeInactive = false): Promise<Service[]> {
  await ensureSchema();
  const { rows } = await getPool().query<ServiceRow>(
    `SELECT id, name, category, price_minor, is_active, sort_order FROM services
      ${includeInactive ? "" : "WHERE is_active"}
      ORDER BY sort_order, name`,
  );
  return rows.map(toService);
}

/** خدمةٌ واحدة من الدليل — لأن سعرًا يأتي من المتصفّح سعرٌ يمكن تغييره في المتصفّح. */
export async function getService(id: number): Promise<Service | null> {
  await ensureSchema();
  const { rows } = await getPool().query<ServiceRow>(
    `SELECT id, name, category, price_minor, is_active, sort_order FROM services WHERE id = $1`,
    [id],
  );
  return rows[0] ? toService(rows[0]) : null;
}

export async function createService(input: {
  name: string; category: string | null; priceMinor: number;
}): Promise<Service> {
  await ensureSchema();
  const { rows } = await getPool().query<ServiceRow>(
    `INSERT INTO services (name, category, price_minor)
     VALUES ($1, $2::text, $3) RETURNING id, name, category, price_minor, is_active, sort_order`,
    [input.name, input.category, input.priceMinor],
  );
  return toService(rows[0]);
}

export async function updateService(id: number, input: {
  name?: string; category?: string | null; priceMinor?: number; isActive?: boolean;
}): Promise<Service | null> {
  await ensureSchema();
  const { rows } = await getPool().query<ServiceRow>(
    `UPDATE services SET
       name        = COALESCE($2::text, name),
       category    = CASE WHEN $3::boolean THEN $4::text ELSE category END,
       price_minor = COALESCE($5::bigint, price_minor),
       is_active   = COALESCE($6::boolean, is_active)
     WHERE id = $1
     RETURNING id, name, category, price_minor, is_active, sort_order`,
    [
      id, input.name ?? null,
      input.category !== undefined, input.category ?? null,
      input.priceMinor ?? null, input.isActive ?? null,
    ],
  );
  return rows[0] ? toService(rows[0]) : null;
}

// ── الورديات ────────────────────────────────────────────────────────────────

export interface CashierShift {
  id: number;
  openedBy: string;
  openedAt: string;
  opening: Record<Currency, number>;
  closedBy: string | null;
  closedAt: string | null;
  counted: Record<Currency, number> | null;
  note: string | null;
  status: "open" | "closed";
}

interface ShiftRow {
  id: number; opened_by: string; opened_at: Date;
  opening_yer: string; opening_sar: string; opening_usd: string;
  closed_by: string | null; closed_at: Date | null;
  counted_yer: string | null; counted_sar: string | null; counted_usd: string | null;
  note: string | null; status: string;
}

const toShift = (row: ShiftRow): CashierShift => ({
  id: row.id,
  openedBy: row.opened_by,
  openedAt: row.opened_at.toISOString(),
  opening: { YER: toMinor(row.opening_yer), SAR: toMinor(row.opening_sar), USD: toMinor(row.opening_usd) },
  closedBy: row.closed_by,
  closedAt: row.closed_at ? row.closed_at.toISOString() : null,
  counted: row.counted_yer === null ? null : {
    YER: toMinor(row.counted_yer), SAR: toMinor(row.counted_sar), USD: toMinor(row.counted_usd),
  },
  note: row.note,
  status: row.status === "closed" ? "closed" : "open",
});

export async function getOpenShift(): Promise<CashierShift | null> {
  await ensureSchema();
  const { rows } = await getPool().query<ShiftRow>(
    `SELECT * FROM cashier_shifts WHERE status = 'open' LIMIT 1`,
  );
  return rows[0] ? toShift(rows[0]) : null;
}

/**
 * يفتح وردية، ويرفض إن كانت هناك واحدة مفتوحة.
 *
 * الشرط `WHERE NOT EXISTS` داخل `INSERT` نفسه لا في الكود: ضغطتان على «افتح الوردية»
 * من جهازين في اللحظة نفسها كانتا ستفتحان ورديتين، فتتوزّع دفعات اليوم بينهما ولا
 * يُطابَق أيّهما. والفهرس الفريد على الحالة يمنعها حتى لو فشل هذا الشرط.
 */
export async function openShift(input: {
  openedBy: string; opening: Record<Currency, number>;
}): Promise<CashierShift | null> {
  await ensureSchema();
  const { rows } = await getPool().query<ShiftRow>(
    `INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd)
     SELECT $1, $2, $3, $4
      WHERE NOT EXISTS (SELECT 1 FROM cashier_shifts WHERE status = 'open')
     RETURNING *`,
    [input.openedBy, input.opening.YER, input.opening.SAR, input.opening.USD],
  );
  return rows[0] ? toShift(rows[0]) : null;
}

export async function closeShift(input: {
  id: number; closedBy: string; counted: Record<Currency, number>; note: string | null;
}): Promise<CashierShift | null> {
  await ensureSchema();
  const { rows } = await getPool().query<ShiftRow>(
    `UPDATE cashier_shifts SET
       status = 'closed', closed_by = $2, closed_at = NOW(),
       counted_yer = $3, counted_sar = $4, counted_usd = $5, note = $6::text
     WHERE id = $1 AND status = 'open'
     RETURNING *`,
    [input.id, input.closedBy, input.counted.YER, input.counted.SAR, input.counted.USD, input.note],
  );
  return rows[0] ? toShift(rows[0]) : null;
}

export async function listShifts(limit = 30): Promise<CashierShift[]> {
  await ensureSchema();
  const { rows } = await getPool().query<ShiftRow>(
    `SELECT * FROM cashier_shifts ORDER BY opened_at DESC LIMIT $1`, [limit],
  );
  return rows.map(toShift);
}

// ── الفواتير والدفعات ───────────────────────────────────────────────────────

export interface InvoiceItem {
  id: number;
  serviceId: number | null;
  doctorId: number | null;
  description: string;
  quantity: number;
  unitPriceMinor: number;
  totalMinor: number;
}

export interface Invoice {
  id: number;
  invoiceNumber: string;
  patientId: number;
  patientName: string;
  status: "open" | "paid" | "cancelled";
  totalMinor: number;
  discountMinor: number;
  baseCurrency: Currency;
  note: string | null;
  createdAt: string;
  items: InvoiceItem[];
}

export interface Payment {
  id: number;
  receiptNumber: string;
  patientId: number;
  patientName: string;
  invoiceId: number | null;
  shiftId: number;
  kind: "payment" | "refund";
  amountMinor: number;
  currency: Currency;
  exchangeRate: number;
  baseAmountMinor: number;
  baseCurrency: Currency;
  method: string;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
}

interface InvoiceRow {
  id: number; invoice_number: string; patient_id: number; full_name: string;
  status: string; total_minor: string; discount_minor: string; base_currency: string;
  note: string | null; created_at: Date;
}

interface PaymentRow {
  id: number; receipt_number: string; patient_id: number; full_name: string;
  invoice_id: number | null; shift_id: number; kind: string;
  amount_minor: string; currency: string; exchange_rate: string;
  base_amount_minor: string; base_currency: string; method: string;
  note: string | null; created_by: string | null; created_at: Date;
}

const toInvoice = (row: InvoiceRow, items: InvoiceItem[]): Invoice => ({
  id: row.id,
  invoiceNumber: row.invoice_number,
  patientId: row.patient_id,
  patientName: row.full_name,
  status: row.status as Invoice["status"],
  totalMinor: toMinor(row.total_minor),
  discountMinor: toMinor(row.discount_minor),
  baseCurrency: row.base_currency as Currency,
  note: row.note,
  createdAt: row.created_at.toISOString(),
  items,
});

const toPayment = (row: PaymentRow): Payment => ({
  id: row.id,
  receiptNumber: row.receipt_number,
  patientId: row.patient_id,
  patientName: row.full_name,
  invoiceId: row.invoice_id,
  shiftId: row.shift_id,
  kind: row.kind === "refund" ? "refund" : "payment",
  amountMinor: toMinor(row.amount_minor),
  currency: row.currency as Currency,
  exchangeRate: Number(row.exchange_rate),
  baseAmountMinor: toMinor(row.base_amount_minor),
  baseCurrency: row.base_currency as Currency,
  method: row.method,
  note: row.note,
  createdBy: row.created_by,
  createdAt: row.created_at.toISOString(),
});

const INVOICE_SELECT = `
  SELECT i.id, i.invoice_number, i.patient_id, p.full_name, i.status, i.total_minor,
         i.discount_minor, i.base_currency, i.note, i.created_at
    FROM invoices i JOIN patients p ON p.id = i.patient_id`;

const PAYMENT_SELECT = `
  SELECT y.id, y.receipt_number, y.patient_id, p.full_name, y.invoice_id, y.shift_id, y.kind,
         y.amount_minor, y.currency, y.exchange_rate, y.base_amount_minor, y.base_currency,
         y.method, y.note, y.created_by, y.created_at
    FROM payments y JOIN patients p ON p.id = y.patient_id`;

async function itemsFor(invoiceIds: number[]): Promise<Map<number, InvoiceItem[]>> {
  const map = new Map<number, InvoiceItem[]>();
  if (invoiceIds.length === 0) return map;
  const { rows } = await getPool().query<{
    id: number; invoice_id: number; service_id: number | null; doctor_id: number | null;
    description: string; quantity: number; unit_price_minor: string; total_minor: string;
  }>(
    `SELECT id, invoice_id, service_id, doctor_id, description, quantity, unit_price_minor, total_minor
       FROM invoice_items WHERE invoice_id = ANY($1::int[]) ORDER BY id`,
    [invoiceIds],
  );
  for (const row of rows) {
    const list = map.get(row.invoice_id) ?? [];
    list.push({
      id: row.id,
      serviceId: row.service_id,
      doctorId: row.doctor_id,
      description: row.description,
      quantity: row.quantity,
      unitPriceMinor: toMinor(row.unit_price_minor),
      totalMinor: toMinor(row.total_minor),
    });
    map.set(row.invoice_id, list);
  }
  return map;
}

/**
 * ينشئ فاتورة ببنودها في معاملة واحدة، ويحسب الإجمالي على الخادم.
 *
 * الإجمالي **لا يُقرأ من الطلب** مهما أرسله المتصفّح: قيمة الفاتورة هي مجموع بنودها،
 * وقبولُ رقم من الواجهة يعني أن أي أحد يستطيع إنشاء فاتورة بمليون وبنودٍ بألف.
 */
export async function createInvoice(input: {
  patientId: number;
  baseCurrency: Currency;
  discountMinor: number;
  note: string | null;
  createdBy: string;
  items: {
    serviceId: number | null; doctorId: number | null;
    description: string; quantity: number; unitPriceMinor: number;
  }[];
}): Promise<Invoice | null> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const total = input.items.reduce(
      (sum, item) => sum + Math.max(0, item.quantity) * Math.max(0, item.unitPriceMinor), 0,
    );
    const discount = Math.min(Math.max(0, input.discountMinor), total);

    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, note, created_by)
       VALUES (
         'INV-' || LPAD(nextval('invoice_number_seq')::text, 5, '0'),
         $1, $2, $3, $4, $5::text, $6)
       RETURNING id`,
      [input.patientId, total, discount, input.baseCurrency, input.note, input.createdBy],
    );
    const invoiceId = rows[0].id;

    for (const item of input.items) {
      const quantity = Math.max(1, Math.round(item.quantity));
      const unit = Math.max(0, Math.round(item.unitPriceMinor));
      await client.query(
        `INSERT INTO invoice_items (invoice_id, service_id, doctor_id, description, quantity, unit_price_minor, total_minor)
         VALUES ($1, $2::int, $3::int, $4, $5, $6, $7)`,
        [invoiceId, item.serviceId, item.doctorId, item.description, quantity, unit, quantity * unit],
      );
    }
    await client.query("COMMIT");
    return getInvoice(invoiceId);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function getInvoice(id: number): Promise<Invoice | null> {
  await ensureSchema();
  const { rows } = await getPool().query<InvoiceRow>(`${INVOICE_SELECT} WHERE i.id = $1`, [id]);
  if (!rows[0]) return null;
  const items = await itemsFor([id]);
  return toInvoice(rows[0], items.get(id) ?? []);
}

export async function listPatientInvoices(patientId: number): Promise<Invoice[]> {
  await ensureSchema();
  const { rows } = await getPool().query<InvoiceRow>(
    `${INVOICE_SELECT} WHERE i.patient_id = $1 ORDER BY i.created_at DESC LIMIT 100`, [patientId],
  );
  const items = await itemsFor(rows.map((row) => row.id));
  return rows.map((row) => toInvoice(row, items.get(row.id) ?? []));
}

export async function setInvoiceStatus(
  id: number, status: "open" | "paid" | "cancelled",
): Promise<Invoice | null> {
  await ensureSchema();
  // الفاتورة الملغاة لا تعود: إلغاءٌ ثم فتحٌ يعيد مبلغًا أُسقط من رصيد المريض بعد
  // أن رآه مسدّدًا. التصحيح يكون بفاتورة جديدة لا بإحياء ملغاة.
  const { rowCount } = await getPool().query(
    `UPDATE invoices SET status = $2 WHERE id = $1 AND status <> 'cancelled'`, [id, status],
  );
  return (rowCount ?? 0) > 0 ? getInvoice(id) : null;
}

export async function listPatientPayments(patientId: number): Promise<Payment[]> {
  await ensureSchema();
  const { rows } = await getPool().query<PaymentRow>(
    `${PAYMENT_SELECT} WHERE y.patient_id = $1 ORDER BY y.created_at DESC LIMIT 200`, [patientId],
  );
  return rows.map(toPayment);
}

export async function getPayment(id: number): Promise<Payment | null> {
  await ensureSchema();
  const { rows } = await getPool().query<PaymentRow>(`${PAYMENT_SELECT} WHERE y.id = $1`, [id]);
  return rows[0] ? toPayment(rows[0]) : null;
}

export async function listShiftPayments(shiftId: number): Promise<Payment[]> {
  await ensureSchema();
  const { rows } = await getPool().query<PaymentRow>(
    `${PAYMENT_SELECT} WHERE y.shift_id = $1 ORDER BY y.created_at DESC`, [shiftId],
  );
  return rows.map(toPayment);
}

export async function listPaymentsByDate(date: string): Promise<Payment[]> {
  await ensureSchema();
  const { rows } = await getPool().query<PaymentRow>(
    `${PAYMENT_SELECT}
      WHERE (y.created_at AT TIME ZONE $1)::date = $2::date
      ORDER BY y.created_at DESC`,
    [CLINIC_TIME_ZONE, date],
  );
  return rows.map(toPayment);
}

/**
 * يسجّل دفعة أو استردادًا داخل الوردية المفتوحة.
 *
 * ثلاثة أشياء مقصودة:
 *
 * ١) **الوردية شرطٌ داخل الاستعلام** لا فحصٌ قبله: بين الفحص والإدراج ثانيةٌ قد
 *    تُغلق فيها الوردية من جهاز آخر، فتُسجَّل الدفعة في وردية مقفلة ولا تظهر في
 *    جردها ولا في جرد التالية — مالٌ دخل ولا يظهر في أي إغلاق.
 *
 * ٢) **سعر الصرف يُنسخ في الصف** ولا يُقرأ من الإعدادات بعدها. هذا ما يجعل رصيد
 *    المريض ثابتًا حين يتغيّر السعر غدًا.
 *
 * ٣) **المكافئ الأساسي يُحسب على الخادم** من المبلغ والسعر: قبولُه من الواجهة يعني
 *    دفعة بدولار واحد تُسجَّل بمليون ريال.
 */
export async function recordPayment(input: {
  patientId: number;
  invoiceId: number | null;
  kind: "payment" | "refund";
  amountMinor: number;
  currency: Currency;
  baseCurrency: Currency;
  exchangeRate: number;
  method: string;
  note: string | null;
  createdBy: string;
}): Promise<{ payment: Payment | null; reason: "no_shift" | null }> {
  await ensureSchema();
  const baseAmount = toBaseAmount(
    input.amountMinor, input.currency, input.baseCurrency, input.exchangeRate,
  );

  const { rows } = await getPool().query<{ id: number }>(
    `INSERT INTO payments (
       receipt_number, patient_id, invoice_id, shift_id, kind, amount_minor, currency,
       exchange_rate, base_amount_minor, base_currency, method, note, created_by)
     SELECT
       'R-' || LPAD(nextval('receipt_number_seq')::text, 5, '0'),
       $1, $2::int, s.id, $3, $4, $5, $6, $7, $8, $9, $10::text, $11
       FROM cashier_shifts s
      WHERE s.status = 'open'
      LIMIT 1
     RETURNING id`,
    [
      input.patientId, input.invoiceId, input.kind, input.amountMinor, input.currency,
      input.exchangeRate, baseAmount, input.baseCurrency, input.method, input.note, input.createdBy,
    ],
  );

  if (!rows[0]) return { payment: null, reason: "no_shift" };
  return { payment: await getPayment(rows[0].id), reason: null };
}

/** رصيد المريض: الفواتير والدفعات معًا، لأن الرقم لا يُقرأ من أحدهما وحده. */
export async function patientLedger(patientId: number): Promise<{
  invoices: Invoice[]; payments: Payment[]; opening: OpeningBalance | null;
}> {
  const [invoices, payments, opening] = await Promise.all([
    listPatientInvoices(patientId),
    listPatientPayments(patientId),
    getPatientOpeningBalance(patientId),
  ]);
  return { invoices, payments, opening };
}

/** يحوّل صفوف الدفعات إلى الشكل الذي تفهمه حسابات `lib/money`. */
export function asPaymentLikes(payments: Payment[]): PaymentLike[] {
  return payments.map((payment) => ({
    amountMinor: payment.amountMinor,
    currency: payment.currency,
    exchangeRate: payment.exchangeRate,
    baseAmountMinor: payment.baseAmountMinor,
    kind: payment.kind,
  }));
}

/** الوحدات الصغرى — تُصدَّر لتستعملها المسارات في التحقق. */
export { MINOR_UNITS };

// ─── الجهات والمصروفات ───────────────────────────────────────────────────────

import type { ExpenseCategory, PartyKind } from "./expenses";

export interface Party {
  id: number;
  name: string;
  kind: PartyKind;
  phone: string | null;
  note: string | null;
  commissionPercent: number;
  isActive: boolean;
}

interface PartyRow {
  id: number; name: string; kind: string; phone: string | null;
  note: string | null; commission_percent: string; is_active: boolean;
}

const toParty = (row: PartyRow): Party => ({
  id: row.id,
  name: row.name,
  kind: row.kind as PartyKind,
  phone: row.phone,
  note: row.note,
  commissionPercent: Number(row.commission_percent),
  isActive: row.is_active,
});

export async function listParties(kind?: PartyKind): Promise<Party[]> {
  await ensureSchema();
  const { rows } = await getPool().query<PartyRow>(
    `SELECT id, name, kind, phone, note, commission_percent, is_active FROM parties
      WHERE ($1::text IS NULL OR kind = $1::text)
      ORDER BY is_active DESC, name`,
    [kind ?? null],
  );
  return rows.map(toParty);
}

export async function createParty(input: {
  name: string; kind: PartyKind; phone: string | null;
  commissionPercent: number; note: string | null;
}): Promise<Party> {
  await ensureSchema();
  const { rows } = await getPool().query<PartyRow>(
    `INSERT INTO parties (name, kind, phone, commission_percent, note)
     VALUES ($1, $2, $3::text, $4, $5::text)
     RETURNING id, name, kind, phone, note, commission_percent, is_active`,
    [input.name, input.kind, input.phone, input.commissionPercent, input.note],
  );
  return toParty(rows[0]);
}

export async function updateParty(id: number, input: {
  name?: string; phone?: string | null; commissionPercent?: number;
  note?: string | null; isActive?: boolean;
}): Promise<Party | null> {
  await ensureSchema();
  const { rows } = await getPool().query<PartyRow>(
    `UPDATE parties SET
       name               = COALESCE($2::text, name),
       phone              = CASE WHEN $3::boolean THEN $4::text ELSE phone END,
       commission_percent = COALESCE($5::numeric, commission_percent),
       note               = CASE WHEN $6::boolean THEN $7::text ELSE note END,
       is_active          = COALESCE($8::boolean, is_active)
     WHERE id = $1
     RETURNING id, name, kind, phone, note, commission_percent, is_active`,
    [
      id, input.name ?? null,
      input.phone !== undefined, input.phone ?? null,
      input.commissionPercent ?? null,
      input.note !== undefined, input.note ?? null,
      input.isActive ?? null,
    ],
  );
  return rows[0] ? toParty(rows[0]) : null;
}

export interface Expense {
  id: number;
  voucherNumber: string;
  category: ExpenseCategory;
  partyId: number | null;
  partyName: string | null;
  payeeText: string | null;
  shiftId: number;
  amountMinor: number;
  currency: Currency;
  exchangeRate: number;
  baseAmountMinor: number;
  baseCurrency: Currency;
  payableId: number | null;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
}

interface ExpenseRow {
  id: number; voucher_number: string; category: string; party_id: number | null;
  party_name: string | null; payee_text: string | null; shift_id: number;
  amount_minor: string; currency: string; exchange_rate: string;
  base_amount_minor: string; base_currency: string; payable_id: number | null;
  note: string | null; created_by: string | null; created_at: Date;
}

const toExpense = (row: ExpenseRow): Expense => ({
  id: row.id,
  voucherNumber: row.voucher_number,
  category: row.category as ExpenseCategory,
  partyId: row.party_id,
  partyName: row.party_name,
  payeeText: row.payee_text,
  shiftId: row.shift_id,
  amountMinor: toMinor(row.amount_minor),
  currency: row.currency as Currency,
  exchangeRate: Number(row.exchange_rate),
  baseAmountMinor: toMinor(row.base_amount_minor),
  baseCurrency: row.base_currency as Currency,
  payableId: row.payable_id,
  note: row.note,
  createdBy: row.created_by,
  createdAt: row.created_at.toISOString(),
});

const EXPENSE_SELECT = `
  SELECT e.id, e.voucher_number, e.category, e.party_id, t.name AS party_name, e.payee_text,
         e.shift_id, e.amount_minor, e.currency, e.exchange_rate, e.base_amount_minor,
         e.base_currency, e.payable_id, e.note, e.created_by, e.created_at
    FROM expenses e LEFT JOIN parties t ON t.id = e.party_id`;

export async function getExpense(id: number): Promise<Expense | null> {
  await ensureSchema();
  const { rows } = await getPool().query<ExpenseRow>(`${EXPENSE_SELECT} WHERE e.id = $1`, [id]);
  return rows[0] ? toExpense(rows[0]) : null;
}

export async function listShiftExpenses(shiftId: number): Promise<Expense[]> {
  await ensureSchema();
  const { rows } = await getPool().query<ExpenseRow>(
    `${EXPENSE_SELECT} WHERE e.shift_id = $1 ORDER BY e.created_at DESC`, [shiftId],
  );
  return rows.map(toExpense);
}

export async function listExpensesBetween(from: string, to: string): Promise<Expense[]> {
  await ensureSchema();
  const { rows } = await getPool().query<ExpenseRow>(
    `${EXPENSE_SELECT}
      WHERE (e.created_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date
      ORDER BY e.created_at DESC LIMIT 1000`,
    [CLINIC_TIME_ZONE, from, to],
  );
  return rows.map(toExpense);
}

export async function listPartyExpenses(partyId: number): Promise<Expense[]> {
  await ensureSchema();
  const { rows } = await getPool().query<ExpenseRow>(
    `${EXPENSE_SELECT} WHERE e.party_id = $1 ORDER BY e.created_at DESC LIMIT 200`, [partyId],
  );
  return rows.map(toExpense);
}

/**
 * يسجّل سند صرف داخل الوردية المفتوحة.
 *
 * نفس حراسة القبض: الوردية شرطٌ داخل الاستعلام لا فحصٌ قبله. والمال الخارج أخطر من
 * الداخل — مبلغٌ يخرج بلا سند ولا وردية لا يظهر في أي جرد، وهو بالضبط كيف تضيع
 * أموال العيادات.
 */
export async function recordExpense(input: {
  category: ExpenseCategory;
  partyId: number | null;
  payeeText: string | null;
  amountMinor: number;
  currency: Currency;
  baseCurrency: Currency;
  exchangeRate: number;
  payableId: number | null;
  note: string | null;
  createdBy: string;
}): Promise<{ expense: Expense | null; reason: "no_shift" | null }> {
  await ensureSchema();
  const baseAmount = toBaseAmount(
    input.amountMinor, input.currency, input.baseCurrency, input.exchangeRate,
  );

  const { rows } = await getPool().query<{ id: number }>(
    `INSERT INTO expenses (
       voucher_number, category, party_id, payee_text, shift_id, amount_minor, currency,
       exchange_rate, base_amount_minor, base_currency, payable_id, note, created_by)
     SELECT
       'V-' || LPAD(nextval('voucher_number_seq')::text, 5, '0'),
       $1, $2::int, $3::text, s.id, $4, $5, $6, $7, $8, $9::int, $10::text, $11
       FROM cashier_shifts s
      WHERE s.status = 'open'
      LIMIT 1
     RETURNING id`,
    [
      input.category, input.partyId, input.payeeText, input.amountMinor, input.currency,
      input.exchangeRate, baseAmount, input.baseCurrency, input.payableId, input.note, input.createdBy,
    ],
  );

  if (!rows[0]) return { expense: null, reason: "no_shift" };
  return { expense: await getExpense(rows[0].id), reason: null };
}

// ─── تقرير العمولات ──────────────────────────────────────────────────────────

import { commissionForPatient, summarizeCommissions, type CommissionInvoice } from "./commission";
import { invoiceNet } from "./money";

export interface CommissionRow {
  doctorId: number;
  doctorName: string;
  commissionPercent: number;
  accruedMinor: number;
  earnedMinor: number;
  paidMinor: number;
  dueMinor: number;
}

/**
 * عمولات الأطباء عن مدى تاريخي.
 *
 * التوزيع يجري على **كل** فواتير المريض ودفعاته — لا على المدى وحده — ثم تُحسب
 * فواتير المدى. لو قُصر التوزيع على المدى لبدت دفعةٌ قديمة كأنها تغطّي فاتورة الشهر
 * الحالي، فتُصرف عمولة مرتين على مالٍ واحد.
 */
export async function commissionReport(from: string, to: string): Promise<CommissionRow[]> {
  await ensureSchema();
  const pool = getPool();

  const [{ rows: doctorRows }, { rows: invoiceRows }, { rows: paidRows }] = await Promise.all([
    pool.query<{ id: number; name: string; commission_percent: string }>(
      `SELECT id, name, commission_percent FROM parties WHERE kind = 'doctor'`,
    ),
    pool.query<{
      patient_id: number; invoice_id: number; net_minor: string; created_at: Date;
      clinic_date: Date; doctor_id: number | null; share_minor: string;
    }>(
      `SELECT i.patient_id,
              i.id AS invoice_id,
              GREATEST(0, i.total_minor - i.discount_minor) AS net_minor,
              i.created_at,
              (i.created_at AT TIME ZONE $1)::date AS clinic_date,
              it.doctor_id,
              COALESCE(SUM(it.total_minor), 0) AS share_minor
         FROM invoices i
         LEFT JOIN invoice_items it ON it.invoice_id = i.id
        WHERE i.status <> 'cancelled'
          AND i.patient_id IN (
                SELECT patient_id FROM invoices
                 WHERE status <> 'cancelled'
                   AND (created_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date
              )
        GROUP BY i.patient_id, i.id, i.total_minor, i.discount_minor, i.created_at, clinic_date, it.doctor_id`,
      [CLINIC_TIME_ZONE, from, to],
    ),
    pool.query<{ party_id: number; paid: string }>(
      `SELECT party_id, COALESCE(SUM(base_amount_minor), 0) AS paid
         FROM expenses
        WHERE category = 'commission' AND party_id IS NOT NULL
          AND (created_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date
        GROUP BY party_id`,
      [CLINIC_TIME_ZONE, from, to],
    ),
  ]);

  const percentByDoctor = new Map(doctorRows.map((row) => [row.id, Number(row.commission_percent)]));
  const nameByDoctor = new Map(doctorRows.map((row) => [row.id, row.name]));

  // تجميع الفواتير لكل مريض مع حصص الأطباء فيها.
  const byPatient = new Map<number, Map<number, CommissionInvoice>>();
  const clinicDateOfInvoice = new Map<number, string>();
  for (const row of invoiceRows) {
    clinicDateOfInvoice.set(row.invoice_id, dateText(row.clinic_date));
    const patientInvoices = byPatient.get(row.patient_id) ?? new Map<number, CommissionInvoice>();
    const invoice = patientInvoices.get(row.invoice_id) ?? {
      id: row.invoice_id,
      netMinor: toMinor(row.net_minor),
      createdAt: row.created_at.toISOString(),
      doctorShares: [],
    };
    if (row.doctor_id) {
      invoice.doctorShares.push({ doctorId: row.doctor_id, amountMinor: toMinor(row.share_minor) });
    }
    patientInvoices.set(row.invoice_id, invoice);
    byPatient.set(row.patient_id, patientInvoices);
  }

  const patientIds = [...byPatient.keys()];
  const collectedByPatient = new Map<number, number>();
  if (patientIds.length > 0) {
    const { rows } = await pool.query<{ patient_id: number; collected: string }>(
      `SELECT patient_id,
              COALESCE(SUM(CASE WHEN kind = 'refund' THEN -base_amount_minor ELSE base_amount_minor END), 0) AS collected
         FROM payments WHERE patient_id = ANY($1::int[]) GROUP BY patient_id`,
      [patientIds],
    );
    for (const row of rows) collectedByPatient.set(row.patient_id, toMinor(row.collected));
  }

  // التحصيل يُغطّي الأقدم أولًا، والرصيد الافتتاحي أقدم من كل فاتورة في هذا النظام.
  // فما دخل منه على دَينٍ سابق **لا عمولة عليه**: عمله تمّ قبل النظام وعمولته صُرفت
  // في حينها، وصرفها ثانية دفعٌ مرتين عن عمل واحد.
  const openingByPatient = await openingBalanceAmounts(patientIds);
  for (const [patientId, collected] of collectedByPatient) {
    const opening = openingByPatient.get(patientId) ?? 0;
    if (opening > 0) collectedByPatient.set(patientId, Math.max(0, collected - opening));
  }

  // فواتير المدى تُنتقى **بيوم العيادة** لا بيوم التوقيت العالمي.
  //
  // كان الانتقاء بمقارنة الطابع الزمني بـ`YYYY-MM-DDT00:00Z`، واليمن UTC+3: فحالةٌ
  // سُجّلت الواحدة ليلًا يومها العيادي هو اليوم نفسه لكن طابعها العالمي في اليوم
  // السابق، فتسقط من عمولة الطبيب بلا أثر — والفرق بين استعلام SQL يصفّي بيوم
  // العيادة وفلترٍ في الذاكرة يصفّي بيوم UTC هو بالضبط ما يجعل الخلل صامتًا.
  const inRange = (invoiceId: number): boolean => {
    const day = clinicDateOfInvoice.get(invoiceId);
    return day !== undefined && day >= from && day <= to;
  };
  const perPatient = patientIds.map((patientId) =>
    commissionForPatient(
      [...(byPatient.get(patientId) ?? new Map()).values()],
      collectedByPatient.get(patientId) ?? 0,
      percentByDoctor,
      (invoice) => inRange(invoice.id),
    ),
  );

  const paidByDoctor = new Map(paidRows.map((row) => [row.party_id, toMinor(row.paid)]));

  return summarizeCommissions(perPatient, paidByDoctor).map((row) => ({
    doctorId: row.doctorId,
    doctorName: nameByDoctor.get(row.doctorId) ?? "—",
    commissionPercent: percentByDoctor.get(row.doctorId) ?? 0,
    accruedMinor: row.accruedMinor,
    earnedMinor: row.earnedMinor,
    paidMinor: row.paidMinor,
    dueMinor: row.dueMinor,
  }));
}

/** يُبقي `invoiceNet` مستعملًا في هذا الملف — يُستخدم في تقرير المديونية أدناه. */
export const netOfInvoice = invoiceNet;

// ─── تقارير مالية ────────────────────────────────────────────────────────────

export interface DebtRow {
  patientId: number;
  patientName: string;
  phone: string | null;
  billedMinor: number;
  /** ما كان عليه قبل تشغيل النظام — دَينٌ حقيقي وإن لم تكن له فاتورة هنا. */
  openingMinor: number;
  collectedMinor: number;
  dueMinor: number;
  /** أقدم فاتورة غير مغطّاة — عليها يقوم عمر الدين. */
  oldestUnpaidDate: string | null;
  ageDays: number;
}

/**
 * مديونية المرضى.
 *
 * الرقم الذي يعرف به صاحب العيادة كم من ماله عند الناس. ومعه **عمر الدين**: مئة ألف
 * عمرها أسبوع شيء، ومئة ألف عمرها سنة شيء آخر تمامًا — الأولى تُحصَّل بمكالمة،
 * والثانية غالبًا لن تعود. وبلا العمر تبدو المديونية رقمًا واحدًا لا يُتصرَّف فيه.
 */
export async function patientDebtReport(minDueMinor = 1): Promise<DebtRow[]> {
  await ensureSchema();
  const { rows } = await getPool().query<{
    patient_id: number; full_name: string; phone: string | null;
    billed: string; opening: string; collected: string; oldest: Date | null;
  }>(
    `WITH billed AS (
       SELECT patient_id,
              COALESCE(SUM(GREATEST(0, total_minor - discount_minor)), 0) AS amount,
              MIN(created_at) AS oldest
         FROM invoices WHERE status <> 'cancelled' GROUP BY patient_id
     ), collected AS (
       SELECT patient_id,
              COALESCE(SUM(CASE WHEN kind = 'refund' THEN -base_amount_minor ELSE base_amount_minor END), 0) AS amount
         FROM payments GROUP BY patient_id
     )
     SELECT p.id AS patient_id, p.full_name, p.phone,
            COALESCE(b.amount, 0) AS billed,
            COALESCE(o.amount_minor, 0) AS opening,
            COALESCE(c.amount, 0) AS collected,
            -- عمر الدين من أقدم ما عليه: والرصيد الافتتاحي أقدم من أي فاتورة هنا.
            -- LEAST في بوستجرس يتجاهل القيم الفارغة، فمن لا افتتاحي له لا يتأثر.
            LEAST(b.oldest, o.as_of_date::timestamptz) AS oldest
       FROM patients p
       LEFT JOIN billed b ON b.patient_id = p.id
       LEFT JOIN collected c ON c.patient_id = p.id
       LEFT JOIN patient_opening_balances o ON o.patient_id = p.id
      WHERE COALESCE(b.amount, 0) + COALESCE(o.amount_minor, 0) - COALESCE(c.amount, 0) >= $1
      ORDER BY (COALESCE(b.amount, 0) + COALESCE(o.amount_minor, 0) - COALESCE(c.amount, 0)) DESC
      LIMIT 500`,
    [minDueMinor],
  );

  const now = Date.now();
  return rows.map((row) => {
    const oldest = row.oldest ? row.oldest.toISOString() : null;
    return {
      patientId: row.patient_id,
      patientName: row.full_name,
      phone: row.phone,
      billedMinor: toMinor(row.billed),
      openingMinor: toMinor(row.opening),
      collectedMinor: toMinor(row.collected),
      dueMinor: toMinor(row.billed) + toMinor(row.opening) - toMinor(row.collected),
      oldestUnpaidDate: oldest,
      ageDays: oldest ? Math.max(0, Math.floor((now - Date.parse(oldest)) / 86_400_000)) : 0,
    };
  });
}

export interface FinanceSummary {
  from: string;
  to: string;
  income: { byCurrency: Record<Currency, number>; baseTotalMinor: number; count: number };
  refunds: { baseTotalMinor: number; count: number };
  expenses: { byCategory: Record<string, number>; baseTotalMinor: number; count: number };
  netMinor: number;
  invoicedMinor: number;
  invoiceCount: number;
  patientCount: number;
  topServices: { name: string; count: number; totalMinor: number }[];
}

/**
 * ملخص مالي لمدى تاريخي — يخدم التقرير اليومي والشهري معًا.
 *
 * الفرق بينهما تاريخان لا منطقان، وبناء تقريرين منفصلين كان يعني رقمين مختلفين
 * لنفس اليوم حين يختلف الحسابان بسطر.
 */
export async function financeSummary(from: string, to: string): Promise<FinanceSummary> {
  await ensureSchema();
  const pool = getPool();

  const [payments, expenses, invoices, services] = await Promise.all([
    pool.query<{ currency: string; kind: string; amount: string; base: string; count: string }>(
      `SELECT currency, kind,
              COALESCE(SUM(amount_minor), 0) AS amount,
              COALESCE(SUM(base_amount_minor), 0) AS base,
              COUNT(*)::int AS count
         FROM payments
        WHERE (created_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date
        GROUP BY currency, kind`,
      [CLINIC_TIME_ZONE, from, to],
    ),
    pool.query<{ category: string; base: string; count: string }>(
      `SELECT category, COALESCE(SUM(base_amount_minor), 0) AS base, COUNT(*)::int AS count
         FROM expenses
        WHERE (created_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date
        GROUP BY category`,
      [CLINIC_TIME_ZONE, from, to],
    ),
    pool.query<{ invoiced: string; count: string; patients: string }>(
      `SELECT COALESCE(SUM(GREATEST(0, total_minor - discount_minor)), 0) AS invoiced,
              COUNT(*)::int AS count,
              COUNT(DISTINCT patient_id)::int AS patients
         FROM invoices
        WHERE status <> 'cancelled'
          AND (created_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date`,
      [CLINIC_TIME_ZONE, from, to],
    ),
    pool.query<{ description: string; count: string; total: string }>(
      `SELECT it.description, COUNT(*)::int AS count, COALESCE(SUM(it.total_minor), 0) AS total
         FROM invoice_items it JOIN invoices i ON i.id = it.invoice_id
        WHERE i.status <> 'cancelled'
          AND (i.created_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date
        GROUP BY it.description
        ORDER BY total DESC
        LIMIT 10`,
      [CLINIC_TIME_ZONE, from, to],
    ),
  ]);

  const byCurrency: Record<Currency, number> = { YER: 0, SAR: 0, USD: 0 };
  let incomeBase = 0;
  let incomeCount = 0;
  let refundBase = 0;
  let refundCount = 0;
  for (const row of payments.rows) {
    const currency = row.currency as Currency;
    const sign = row.kind === "refund" ? -1 : 1;
    byCurrency[currency] += sign * toMinor(row.amount);
    if (row.kind === "refund") {
      refundBase += toMinor(row.base);
      refundCount += Number(row.count);
    } else {
      incomeBase += toMinor(row.base);
      incomeCount += Number(row.count);
    }
  }

  const byCategory: Record<string, number> = {};
  let expenseBase = 0;
  let expenseCount = 0;
  for (const row of expenses.rows) {
    byCategory[row.category] = toMinor(row.base);
    expenseBase += toMinor(row.base);
    expenseCount += Number(row.count);
  }

  const invoiceRow = invoices.rows[0];

  return {
    from,
    to,
    income: { byCurrency, baseTotalMinor: incomeBase, count: incomeCount },
    refunds: { baseTotalMinor: refundBase, count: refundCount },
    expenses: { byCategory, baseTotalMinor: expenseBase, count: expenseCount },
    // الصافي = المقبوض − المسترد − المصروف. هذا ما بقي في الصندوق فعلًا، لا
    // «الدخل» الذي يظنّه من يقرأ المقبوض وحده.
    netMinor: incomeBase - refundBase - expenseBase,
    invoicedMinor: toMinor(invoiceRow?.invoiced ?? 0),
    invoiceCount: Number(invoiceRow?.count ?? 0),
    patientCount: Number(invoiceRow?.patients ?? 0),
    topServices: services.rows.map((row) => ({
      name: row.description,
      count: Number(row.count),
      totalMinor: toMinor(row.total),
    })),
  };
}

// ─── الالتزامات وحسابات الجهات ───────────────────────────────────────────────

export interface Payable {
  id: number;
  partyId: number;
  partyName: string;
  category: string;
  description: string;
  amountMinor: number;
  currency: Currency;
  exchangeRate: number;
  baseAmountMinor: number;
  labOrderId: number | null;
  dueDate: string | null;
  createdAt: string;
}

interface PayableRow {
  id: number; party_id: number; party_name: string; category: string; description: string;
  amount_minor: string; currency: string; exchange_rate: string; base_amount_minor: string;
  lab_order_id: number | null; due_date: Date | null; created_at: Date;
}

const toPayable = (row: PayableRow): Payable => ({
  id: row.id,
  partyId: row.party_id,
  partyName: row.party_name,
  category: row.category,
  description: row.description,
  amountMinor: toMinor(row.amount_minor),
  currency: row.currency as Currency,
  exchangeRate: Number(row.exchange_rate),
  baseAmountMinor: toMinor(row.base_amount_minor),
  labOrderId: row.lab_order_id,
  dueDate: row.due_date ? dateText(row.due_date) : null,
  createdAt: row.created_at.toISOString(),
});

const PAYABLE_SELECT = `
  SELECT b.id, b.party_id, t.name AS party_name, b.category, b.description, b.amount_minor,
         b.currency, b.exchange_rate, b.base_amount_minor, b.lab_order_id, b.due_date, b.created_at
    FROM payables b JOIN parties t ON t.id = b.party_id`;

export async function createPayable(input: {
  partyId: number;
  category: string;
  description: string;
  amountMinor: number;
  currency: Currency;
  baseCurrency: Currency;
  exchangeRate: number;
  labOrderId: number | null;
  dueDate: string | null;
  createdBy: string;
}): Promise<Payable | null> {
  await ensureSchema();
  const baseAmount = toBaseAmount(
    input.amountMinor, input.currency, input.baseCurrency, input.exchangeRate,
  );
  const { rows } = await getPool().query<{ id: number }>(
    `INSERT INTO payables (party_id, category, description, amount_minor, currency,
                           exchange_rate, base_amount_minor, base_currency, lab_order_id, due_date, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::int, $10::date, $11)
     ON CONFLICT (lab_order_id) WHERE lab_order_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      input.partyId, input.category, input.description, input.amountMinor, input.currency,
      input.exchangeRate, baseAmount, input.baseCurrency, input.labOrderId, input.dueDate, input.createdBy,
    ],
  );
  if (!rows[0]) return null;
  const { rows: full } = await getPool().query<PayableRow>(`${PAYABLE_SELECT} WHERE b.id = $1`, [rows[0].id]);
  return full[0] ? toPayable(full[0]) : null;
}

export interface PartyBalance {
  partyId: number;
  partyName: string;
  kind: string;
  owedMinor: number;
  paidMinor: number;
  dueMinor: number;
}

/**
 * ما على العيادة لكل جهة.
 *
 * الوجه الآخر لمديونية المرضى: أن تعرف كم عليك كما تعرف كم لك. عيادة تعرف مديونية
 * مرضاها ولا تعرف ما عليها للمختبرات تحسب نفسها رابحة وهي مدينة.
 *
 * والمقارنة بالعملة الأساسية: الالتزام قد يكون بالدولار والسداد بالريال، وكلاهما
 * محفوظ بسعر يومه — فالطرح بالمكافئ الأساسي هو الوحيد الذي يعطي رقمًا صحيحًا.
 */
export async function partyBalances(): Promise<PartyBalance[]> {
  await ensureSchema();
  // الأطباء مستثنون: مستحقهم لا يأتي من التزامات مسجّلة بل يُحسب من نسبتهم على
  // المحصّل، وهو حسابٌ بمدى تاريخي مكانه تقرير العمولات. إدراجهم هنا كان يُظهر
  // «دُفع زيادة» لطبيب مستحقُّه محسوب في مكان آخر — رقمٌ صحيح حسابيًا وكاذب معنى.
  const { rows } = await getPool().query<{
    id: number; name: string; kind: string; owed: string; paid: string;
  }>(
    `SELECT t.id, t.name, t.kind,
            COALESCE((SELECT SUM(base_amount_minor) FROM payables WHERE party_id = t.id), 0) AS owed,
            COALESCE((SELECT SUM(base_amount_minor) FROM expenses WHERE party_id = t.id), 0) AS paid
       FROM parties t
      WHERE t.kind <> 'doctor'
      ORDER BY t.kind, t.name`,
  );
  return rows.map((row) => ({
    partyId: row.id,
    partyName: row.name,
    kind: row.kind,
    owedMinor: toMinor(row.owed),
    paidMinor: toMinor(row.paid),
    dueMinor: toMinor(row.owed) - toMinor(row.paid),
  }));
}

/** كشف حساب جهة: التزاماتها وما دُفع لها. */
export async function partyStatement(partyId: number): Promise<{
  payables: Payable[]; expenses: Expense[];
}> {
  await ensureSchema();
  const [{ rows }, expenses] = await Promise.all([
    getPool().query<PayableRow>(
      `${PAYABLE_SELECT} WHERE b.party_id = $1 ORDER BY b.created_at DESC LIMIT 200`, [partyId],
    ),
    listPartyExpenses(partyId),
  ]);
  return { payables: rows.map(toPayable), expenses };
}

// ─── المستخدمون ──────────────────────────────────────────────────────────────

export interface StaffAccount {
  id: number;
  username: string;
  displayName: string;
  role: string;
  isActive: boolean;
  createdAt: string;
}

export async function listUsers(): Promise<StaffAccount[]> {
  await ensureSchema();
  // كلمة المرور المجزّأة لا تخرج من هذه الدالة إطلاقًا: قائمة المستخدمين تُعرض في
  // شاشة، وما يُرسَل إلى المتصفّح يُقرأ.
  const { rows } = await getPool().query<{
    id: number; username: string; display_name: string;
    role: string; is_active: boolean; created_at: Date;
  }>(
    `SELECT id, username, display_name, role, is_active, created_at
       FROM users ORDER BY is_active DESC, created_at`,
  );
  return rows.map((row) => ({
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
  }));
}

export async function updateUser(id: number, input: {
  displayName?: string; role?: string; isActive?: boolean; passwordHash?: string;
}): Promise<StaffAccount | null> {
  await ensureSchema();
  const { rows } = await getPool().query<{
    id: number; username: string; display_name: string;
    role: string; is_active: boolean; created_at: Date;
  }>(
    `UPDATE users SET
       display_name  = COALESCE($2::text, display_name),
       role          = COALESCE($3::text, role),
       is_active     = COALESCE($4::boolean, is_active),
       password_hash = COALESCE($5::text, password_hash)
     WHERE id = $1
     RETURNING id, username, display_name, role, is_active, created_at`,
    [id, input.displayName ?? null, input.role ?? null, input.isActive ?? null, input.passwordHash ?? null],
  );
  if (!rows[0]) return null;
  return {
    id: rows[0].id,
    username: rows[0].username,
    displayName: rows[0].display_name,
    role: rows[0].role,
    isActive: rows[0].is_active,
    createdAt: rows[0].created_at.toISOString(),
  };
}

/**
 * عدد المديرين الفاعلين.
 *
 * يُفحص قبل إيقاف مدير أو تغيير دوره: عيادة بلا مدير فاعل لا يستطيع أحد فيها فتح
 * الإعدادات ولا رؤية التقارير — ولا إعادة تعيين مدير، لأن ذلك نفسه يحتاج مديرًا.
 */
export async function countActiveAdmins(): Promise<number> {
  await ensureSchema();
  const { rows } = await getPool().query<{ c: string }>(
    `SELECT count(*)::int AS c FROM users WHERE role = 'admin' AND is_active`,
  );
  return Number(rows[0].c);
}

// ─── الدفاتر المحاسبية ───────────────────────────────────────────────────────

import {
  chairOccupancy,
  executiveKpis as assembleExecutiveKpis,
  splitPeriod,
  type ExecutiveKpis,
  type PartyDueRow,
} from "./executive";
import {
  effectiveRate,
  foreignCurrencies,
  isWorthPosting,
  revaluationDescription,
  revaluePosition,
  type FxPosition,
} from "./fx";
import {
  CASH_ACCOUNT,
  cashDifferenceEntry,
  expenseEntry,
  invoiceEntry,
  isBalanced,
  openingBalanceEntry,
  payableEntry,
  paymentEntry,
  revaluationEntry,
  trialBalance,
  type JournalEntry,
} from "./accounting";

/** التاريخ المحلي لطابع زمني بتوقيت العيادة — كل القيود تُؤرَّخ به. */
function clinicDayOf(iso: string): string {
  const local = new Date(new Date(iso).toLocaleString("en-US", { timeZone: CLINIC_TIME_ZONE }));
  return `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}`;
}

/**
 * دفتر اليومية عن مدى تاريخي — مشتقًّا من المستندات.
 *
 * لا جدول قيود للمستندات: الفاتورة تُنتج قيدها كلما قُرئت، فلا تعارض ممكن بين
 * الدفاتر والمستندات، ولا ترحيل خلفي للبيانات القائمة، ولا قيد يتيم. وما لا يُشتقّ
 * من مستند — التسويات وإعادة التقييم — يأتي من `journal_manual` ويُدمج هنا.
 */
export async function journalEntries(from: string, to: string): Promise<JournalEntry[]> {
  await ensureSchema();
  const pool = getPool();

  const [invoices, payments, expenses, payables, shifts, manual, openings] = await Promise.all([
    pool.query<{
      invoice_number: string; created_at: Date; full_name: string;
      total_minor: string; discount_minor: string; status: string;
    }>(
      `SELECT i.invoice_number, i.created_at, p.full_name, i.total_minor, i.discount_minor, i.status
         FROM invoices i JOIN patients p ON p.id = i.patient_id
        WHERE (i.created_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date`,
      [CLINIC_TIME_ZONE, from, to],
    ),
    pool.query<{
      receipt_number: string; created_at: Date; full_name: string;
      currency: string; base_amount_minor: string; kind: string;
    }>(
      `SELECT y.receipt_number, y.created_at, p.full_name, y.currency, y.base_amount_minor, y.kind
         FROM payments y JOIN patients p ON p.id = y.patient_id
        WHERE (y.created_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date`,
      [CLINIC_TIME_ZONE, from, to],
    ),
    pool.query<{
      voucher_number: string; created_at: Date; category: string; currency: string;
      base_amount_minor: string; party_id: number | null; party_kind: string | null;
      party_name: string | null; payee_text: string | null;
    }>(
      `SELECT e.voucher_number, e.created_at, e.category, e.currency, e.base_amount_minor,
              e.party_id, t.kind AS party_kind, t.name AS party_name, e.payee_text
         FROM expenses e LEFT JOIN parties t ON t.id = e.party_id
        WHERE (e.created_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date`,
      [CLINIC_TIME_ZONE, from, to],
    ),
    pool.query<{
      id: number; created_at: Date; category: string; base_amount_minor: string; party_name: string;
    }>(
      `SELECT b.id, b.created_at, b.category, b.base_amount_minor, t.name AS party_name
         FROM payables b JOIN parties t ON t.id = b.party_id
        WHERE (b.created_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date`,
      [CLINIC_TIME_ZONE, from, to],
    ),
    pool.query<ShiftRow>(
      `SELECT * FROM cashier_shifts
        WHERE status = 'closed'
          AND (closed_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date`,
      [CLINIC_TIME_ZONE, from, to],
    ),
    pool.query<{
      id: number; entry_date: Date; description: string;
      account_code: string; amount_minor: string; side: string;
    }>(
      `SELECT m.id, m.entry_date, m.description, l.account_code, l.amount_minor, l.side
         FROM journal_manual m JOIN journal_manual_lines l ON l.entry_id = m.id
        WHERE m.entry_date BETWEEN $1::date AND $2::date
        ORDER BY m.id, l.id`,
      [from, to],
    ),
    pool.query<{ patient_id: number; full_name: string; amount_minor: string; as_of_date: Date }>(
      `SELECT o.patient_id, p.full_name, o.amount_minor, o.as_of_date
         FROM patient_opening_balances o JOIN patients p ON p.id = o.patient_id
        WHERE o.as_of_date BETWEEN $1::date AND $2::date`,
      [from, to],
    ),
  ]);

  const entries: (JournalEntry | null)[] = [];

  for (const row of invoices.rows) {
    entries.push(invoiceEntry({
      invoiceNumber: row.invoice_number,
      date: clinicDayOf(row.created_at.toISOString()),
      patientName: row.full_name,
      totalMinor: toMinor(row.total_minor),
      discountMinor: toMinor(row.discount_minor),
      cancelled: row.status === "cancelled",
    }));
  }

  for (const row of payments.rows) {
    entries.push(paymentEntry({
      receiptNumber: row.receipt_number,
      date: clinicDayOf(row.created_at.toISOString()),
      patientName: row.full_name,
      currency: row.currency as Currency,
      baseAmountMinor: toMinor(row.base_amount_minor),
      kind: row.kind === "refund" ? "refund" : "payment",
    }));
  }

  for (const row of payables.rows) {
    entries.push(payableEntry({
      reference: `PB-${row.id}`,
      date: clinicDayOf(row.created_at.toISOString()),
      partyName: row.party_name,
      category: row.category,
      baseAmountMinor: toMinor(row.base_amount_minor),
    }));
  }

  for (const row of expenses.rows) {
    entries.push(expenseEntry({
      voucherNumber: row.voucher_number,
      date: clinicDayOf(row.created_at.toISOString()),
      payeeName: row.party_name ?? row.payee_text ?? "—",
      category: row.category,
      currency: row.currency as Currency,
      baseAmountMinor: toMinor(row.base_amount_minor),
      // السداد لجهة مسجّلة (مختبر أو مورّد) يُنقص الذمم؛ وغيره مصروف مباشر.
      settlesPayable: row.party_kind === "lab" || row.party_kind === "supplier",
    }));
  }

  // فروق جرد الورديات المغلقة: المعدود ناقص (الافتتاحي + المقبوض − المصروف).
  //
  // والفرق يُعدّ **بورق العملة** ثم يُقيَّد **بالمكافئ الأساسي**: الدفاتر كلها بعملة
  // واحدة، فعجزُ عشرة دولارات ليس عشرة ريالات. وسعرُه سعرُ ما مرّ من تلك العملة في
  // الوردية نفسها — لا سعر اليوم — فالوردية أُغلقت يومها لا اليوم؛ وإن لم يمرّ منها
  // شيء (فرقٌ في افتتاحيّها) فسعر الإعدادات هو أقرب ما يُتاح.
  const settingsNow = await getSettings();
  const baseCurrency: Currency = isCurrency(settingsNow["finance.base_currency"])
    ? settingsNow["finance.base_currency"] : "YER";
  for (const row of shifts.rows) {
    const shift = toShift(row);
    if (!shift.counted || !shift.closedAt) continue;
    const [shiftPayments, shiftExpenses] = await Promise.all([
      listShiftPayments(shift.id),
      listShiftExpenses(shift.id),
    ]);
    for (const currency of ["YER", "SAR", "USD"] as Currency[]) {
      const collected = shiftPayments.reduce(
        (sum, payment) => payment.currency === currency
          ? sum + (payment.kind === "refund" ? -payment.amountMinor : payment.amountMinor)
          : sum, 0);
      const spent = shiftExpenses.reduce(
        (sum, expense) => expense.currency === currency ? sum + expense.amountMinor : sum, 0);
      const expected = shift.opening[currency] + collected - spent;
      const rate = effectiveRate(
        shiftPayments.filter((payment) => payment.currency === currency),
        currency,
        baseCurrency,
        rateFromSettings(settingsNow, currency, baseCurrency) ?? 1,
      );
      entries.push(cashDifferenceEntry({
        shiftId: shift.id,
        date: clinicDayOf(shift.closedAt),
        currency,
        differenceMinor: toBaseAmount(
          shift.counted[currency] - expected, currency, baseCurrency, rate,
        ),
      }));
    }
  }

  // الأرصدة الافتتاحية للمرضى — أصلٌ جاء مع افتتاح الدفاتر لا إيراد الفترة.
  for (const row of openings.rows) {
    entries.push(openingBalanceEntry({
      patientId: row.patient_id,
      date: dateText(row.as_of_date),
      patientName: row.full_name,
      amountMinor: toMinor(row.amount_minor),
    }));
  }

  // القيود اليدوية.
  const manualById = new Map<number, JournalEntry>();
  for (const row of manual.rows) {
    const entry = manualById.get(row.id) ?? {
      source: "manual",
      reference: `JM-${row.id}`,
      date: dateText(row.entry_date),
      description: row.description,
      lines: [],
    };
    entry.lines.push({
      accountCode: row.account_code,
      amountMinor: toMinor(row.amount_minor),
      side: row.side === "credit" ? "credit" : "debit",
    });
    manualById.set(row.id, entry);
  }
  entries.push(...manualById.values());

  // قيدٌ لا يتوازن لا يدخل الدفاتر: وجوده يُفسد ميزان المراجعة كله ويجعل تتبّع
  // الخلل مستحيلًا بعد شهور. وهو مستحيل من قواعد الترحيل، لكنه ممكن من قيد يدوي.
  return entries.filter((entry): entry is JournalEntry => entry !== null && isBalanced(entry));
}

/** عدّ مرضى الدخول الجديد — للنمو التشغيلي في غرفة القيادة. */
async function countStats(from: string, to: string) {
  const pool = getPool();
  const [visits, appointments, newPatients, totalPatients, ortho] = await Promise.all([
    pool.query<{ d: number }>(
      `SELECT COUNT(DISTINCT (arrived_at AT TIME ZONE $1)::date)::int AS d FROM visits
        WHERE (arrived_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date`,
      [CLINIC_TIME_ZONE, from, to],
    ),
    pool.query<{ no_show: number; cancelled: number }>(
      `SELECT COUNT(*) FILTER (WHERE status = 'no_show')::int AS no_show,
              COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled
         FROM appointments
        WHERE scheduled_date BETWEEN $1::date AND $2::date`,
      [from, to],
    ),
    pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM patients
        WHERE (created_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date`,
      [CLINIC_TIME_ZONE, from, to],
    ),
    pool.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM patients`),
    pool.query<{ active: number; total: number }>(
      `SELECT COUNT(*) FILTER (WHERE status = 'active')::int AS active,
              COUNT(*)::int AS total FROM ortho_cases`,
    ),
  ]);
  return {
    activeDays: visits.rows[0]?.d ?? 0,
    noShow: appointments.rows[0]?.no_show ?? 0,
    cancelled: appointments.rows[0]?.cancelled ?? 0,
    newPatients: newPatients.rows[0]?.c ?? 0,
    totalPatients: totalPatients.rows[0]?.c ?? 0,
    orthoActive: ortho.rows[0]?.active ?? 0,
    orthoTotal: ortho.rows[0]?.total ?? 0,
  };
}

/**
 * مؤشرات غرفة القيادة عن فترة.
 *
 * القاعدة الحاكمة للمنطقة E: المؤشرات من حركات مدقَّقة في دفتر الأستاذ حصرًا.
 * فالمال كله هنا من الدفاتر: الدفاتر تُقرأ تراكميًا حتى نهاية الفترة مرة واحدة،
 * ثم تُفصل قيودُ الفترة منها — بلا استعلام ثانٍ يوازيها، فلا يظهر تعارض بين
 * الرقم التراكمي ورقم الفترة وإن غيّر أحدهما المستندات أثناء القراءة.
 *
 * قائمة الدخل وحركة الصندوق من ميزان الفترة، والذمم من الميزان التراكمي —
 * لأن رصيد الذمم «الآن» ليس رقم فترة بل رصيد دفتر حتى يوم الفترة الأخير.
 *
 * والاستدعاءات التشغيلية (الزيارات، المرضى، التقويم، تنبيهات المخزون، أرصدة
 * الجهات) هي نفس الدوال التي تخدم شاشاتها — فلا يمكنها المخالفة أيضًا.
 */
export async function executiveKpis(from: string, to: string): Promise<ExecutiveKpis> {
  await ensureSchema();

  const allEntries = await journalEntries("0001-01-01", to);
  const periodEntries = splitPeriod(allEntries, from);
  const cumulativeBalances = trialBalance(allEntries);
  const periodBalances = trialBalance(periodEntries);

  const [visits, stats, alerts, partyRows, settingsMap] = await Promise.all([
    listVisitsBetween(from, to),
    countStats(from, to),
    inventoryAlerts(clinicDateString(new Date(), CLINIC_TIME_ZONE)),
    partyBalances(),
    getSettings(),
  ]);

  const parties: PartyDueRow[] = partyRows.map((row) => ({
    kind: row.kind,
    label: row.partyName,
    dueMinor: row.dueMinor,
  }));

  const occupancy = chairOccupancy(visits, {
    chairs: chairCount(settingsMap),
    dayStart: settingsMap["clinic.day_start"],
    dayEnd: settingsMap["clinic.day_end"],
    activeDays: stats.activeDays,
  });

  return assembleExecutiveKpis({
    from,
    to,
    baseCurrency: isCurrency(settingsMap["finance.base_currency"])
      ? (settingsMap["finance.base_currency"] as Currency)
      : "YER",
    periodBalances,
    cumulativeBalances,
    parties,
    occupancy,
    operational: {
      arrived: visits.length,
      done: visits.filter((visit) => visit.status === "done").length,
      stillOpen: visits.filter((visit) => visit.status !== "done").length,
      noShow: stats.noShow,
      cancelled: stats.cancelled,
      newPatients: stats.newPatients,
      totalPatients: stats.totalPatients,
      orthoActive: stats.orthoActive,
      orthoTotal: stats.orthoTotal,
      inventoryAlerts: alerts.lowItems.length + alerts.expired.length + alerts.soon.length,
    },
  });
}

export async function createManualEntry(input: {
  date: string;
  description: string;
  lines: { accountCode: string; amountMinor: number; side: "debit" | "credit" }[];
  createdBy: string;
}): Promise<number | null> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO journal_manual (entry_date, description, created_by)
       VALUES ($1::date, $2, $3) RETURNING id`,
      [input.date, input.description, input.createdBy],
    );
    for (const line of input.lines) {
      await client.query(
        `INSERT INTO journal_manual_lines (entry_id, account_code, amount_minor, side)
         VALUES ($1, $2, $3, $4)`,
        [rows[0].id, line.accountCode, line.amountMinor, line.side],
      );
    }
    await client.query("COMMIT");
    return rows[0].id;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * هل الفترة مقفلة عند هذا التاريخ؟
 *
 * الإقفال هو ما يجعل التقارير الشهرية قابلة للاعتماد: شهرٌ أُقفل لا يتغيّر رقمه بعد
 * أن قُرئ وصُدّق. وبلا قفل يستطيع قيدٌ يُكتب اليوم أن يغيّر ربح مارس الذي بُنيت عليه
 * قرارات — وهو ما يجعل أي محاسب يرفض النظام كله.
 */
export async function isPeriodLocked(date: string): Promise<boolean> {
  const settings = await getSettings();
  const lockedBefore = (settings["finance.locked_before"] ?? "").trim();
  if (!lockedBefore) return false;
  return date < lockedBefore;
}

// ─── النسخة الاحتياطية الكاملة ───────────────────────────────────────────────

import { insertStatement, insertionOrder, sequenceResets } from "./backup";

/**
 * يبني ملف النسخة الاحتياطية سطرًا سطرًا.
 *
 * بيانات فقط بلا مخطط: البرنامج ينشئ جداوله بنفسه عند أول تشغيل، فالاستعادة قاعدةٌ
 * فارغة يفتحها البرنامج ثم يُشغَّل عليها هذا الملف.
 *
 * وليس فيه `TRUNCATE` ولا `DROP` عمدًا. ملفٌّ يمسح قبل أن يكتب يبدو أذكى، لكنه يعني
 * أن نقرة خاطئة على قاعدة تعمل تمحو يوم عمل كامل. فالاستعادة فوق بيانات موجودة
 * **تفشل** باصطدام المفاتيح — وهو الفشل الصحيح.
 */
export interface Queryable {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

export async function* backupSqlLines(source?: Queryable): AsyncGenerator<string> {
  // مصدرٌ مُمرَّر يعني قاعدةً غير قاعدة التطبيق — وهو ما يجعل فحص «هل تُستعاد النسخة؟»
  // ممكنًا أصلًا: قراءةٌ من قاعدة وكتابةٌ في أخرى داخل عملية واحدة.
  let pool: Queryable;
  if (source) {
    pool = source;
  } else {
    await ensureSchema();
    pool = getPool();
  }

  const { rows: tableRows } = (await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
  )) as { rows: { table_name: string }[] };
  const tables = tableRows.map((row) => row.table_name);

  // الترتيب من مفاتيح القاعدة نفسها لا من قائمة مكتوبة بيد: قائمةٌ يدوية تنسى جدولًا
  // يُضاف غدًا، فتفشل الاستعادة بخطأ مفتاح أجنبي في أسوأ لحظة.
  const { rows: fkRows } = (await pool.query(
    `SELECT tc.table_name AS child, ccu.table_name AS parent
       FROM information_schema.table_constraints tc
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'`,
  )) as { rows: { child: string; parent: string }[] };
  const dependsOn = new Map(tables.map((table) => [table, new Set<string>()]));
  for (const row of fkRows) dependsOn.get(row.child)?.add(row.parent);
  const ordered = insertionOrder(
    tables.map((table) => ({ table, dependsOn: [...(dependsOn.get(table) ?? [])] })),
  );

  yield `-- نسخة احتياطية — انسياب العيادة\n`;
  yield `-- أُخذت: ${new Date().toISOString()}\n`;
  yield `-- الاستعادة: على قاعدة فارغة فتحها البرنامج مرة واحدة فأنشأ جداولها.\n`;
  yield `BEGIN;\n`;

  // العدّادات تُعاد فقط لجداول لها عمود `id`. الجداول ذات المفتاح الطبيعي —
  // الإعدادات بمفتاحها النصّي، والأرصدة الافتتاحية برقم المريض — لا عدّاد لها،
  // وتوليد جملة تشير إلى `id` فيها يُفشل ملف النسخة كله عند أول سطر استعادة.
  const withSerialId: string[] = [];

  for (const table of ordered) {
    const { rows: columnRows } = (await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position`,
      [table],
    )) as { rows: { column_name: string }[] };
    const columns = columnRows.map((row) => row.column_name);
    if (columns.length === 0) continue;
    if (columns.includes("id")) withSerialId.push(table);

    const { rows } = await pool.query(`SELECT * FROM "${table}"`);
    yield `\n-- ${table} (${rows.length})\n`;
    for (const row of rows) yield `${insertStatement(table, columns, row)}\n`;
  }

  yield `\n`;
  for (const reset of sequenceResets(withSerialId)) yield `${reset}\n`;
  yield `COMMIT;\n`;
}

// ─── إعادة تقييم العملات الأجنبية ────────────────────────────────────────────

export interface FxReport {
  asOf: string;
  baseCurrency: Currency;
  positions: FxPosition[];
  totalDifferenceMinor: number;
}

/**
 * مركز كل عملة أجنبية اليوم: كم منها في الصندوق، وبكم هي في الدفاتر، وكم تساوي.
 *
 * الوحدات المحتفظ بها تُحسب من المستندات — سندات القبض ناقص سندات الصرف بتلك
 * العملة — لا من جرد الوردية. والفرق مقصود: **الجرد يعالج الفرق بين الدرج
 * والدفاتر، وإعادة التقييم تعالج تغيّر السعر**، وخلطهما يجعل الحسابين بلا معنى فلا
 * يُعرف أضاع الصندوق مالًا أم تحرّك السعر.
 *
 * والقيمة الدفترية تُقرأ من رصيد حساب صندوق العملة في ميزان المراجعة — بكل مصادره،
 * ومنها إعادات التقييم السابقة. فترحيلُ الفرق يجعل الفرق التالي صفرًا: لا ازدواج
 * ولو رُحّل مرتين في اليوم نفسه.
 */
export async function fxReport(asOf: string): Promise<FxReport> {
  await ensureSchema();
  const settings = await getSettings();
  const baseCurrency: Currency = isCurrency(settings["finance.base_currency"])
    ? settings["finance.base_currency"] : "YER";

  const [entries, { rows: flows }] = await Promise.all([
    journalEntries(FX_EPOCH, asOf),
    getPool().query<{ currency: string; held: string }>(
      `SELECT currency, COALESCE(SUM(held), 0) AS held FROM (
         SELECT currency,
                SUM(CASE WHEN kind = 'refund' THEN -amount_minor ELSE amount_minor END) AS held
           FROM payments
          WHERE (created_at AT TIME ZONE $1)::date <= $2::date
          GROUP BY currency
         UNION ALL
         SELECT currency, -SUM(amount_minor) AS held
           FROM expenses
          WHERE (created_at AT TIME ZONE $1)::date <= $2::date
          GROUP BY currency
       ) AS movements GROUP BY currency`,
      [CLINIC_TIME_ZONE, asOf],
    ),
  ]);

  const balances = trialBalance(entries);
  const heldByCurrency = new Map<string, number>(
    flows.map((row) => [row.currency, toMinor(row.held)]),
  );

  const positions = foreignCurrencies(baseCurrency).map((currency) => {
    const account = balances.find((row) => row.code === CASH_ACCOUNT[currency]);
    return revaluePosition({
      currency,
      base: baseCurrency,
      heldMinor: heldByCurrency.get(currency) ?? 0,
      bookValueMinor: account?.balanceMinor ?? 0,
      rate: rateFromSettings(settings, currency, baseCurrency) ?? 0,
    });
  });

  return {
    asOf,
    baseCurrency,
    positions,
    totalDifferenceMinor: positions.reduce((sum, row) => sum + row.differenceMinor, 0),
  };
}

/** أول يوم تُقرأ منه الدفاتر لحساب رصيد الصندوق — قبل أي حركة ممكنة. */
const FX_EPOCH = "2000-01-01";

/**
 * ترحيل فرق إعادة التقييم قيدًا.
 *
 * يُعاد الحساب على الخادم ولا يُقبل الفرق من الواجهة: رقمٌ يأتي من المتصفّح يعني أن
 * يستطيع من يفتح الشاشة أن يكتب في الدفاتر ما يشاء.
 */
export async function postRevaluation(input: {
  currency: Currency;
  asOf: string;
  createdBy: string;
}): Promise<{ entryId: number | null; reason: "locked" | "nothing" | "no_rate" | null }> {
  if (await isPeriodLocked(input.asOf)) return { entryId: null, reason: "locked" };

  const report = await fxReport(input.asOf);
  const position = report.positions.find((row) => row.currency === input.currency);
  if (!position || position.rate <= 0) return { entryId: null, reason: "no_rate" };
  if (!isWorthPosting(position.differenceMinor)) return { entryId: null, reason: "nothing" };

  const entry = revaluationEntry({
    date: input.asOf,
    currency: input.currency,
    differenceMinor: position.differenceMinor,
  });
  if (!entry) return { entryId: null, reason: "nothing" };

  const entryId = await createManualEntry({
    date: input.asOf,
    description: revaluationDescription(input.currency, position.rate, input.asOf),
    lines: entry.lines,
    createdBy: input.createdBy,
  });
  return { entryId, reason: null };
}

// ─── سجل التدقيق ─────────────────────────────────────────────────────────────

import {
  describeAudit,
  sanitizeDetails,
  type AuditAction,
  type AuditEntry,
} from "./audit";

/**
 * يكتب سطرًا في سجل التدقيق.
 *
 * **لا يرمي أبدًا.** وهذا قرارٌ مقصود: فشلُ الكتابة في السجل يجب ألّا يُسقط قبضَ
 * مبلغ من مريض واقف. سجلٌّ ناقص سطرًا أهون من صندوق لا يقبض — والعكس يجعل التدقيق
 * نفسه سببًا لتعطيل العيادة.
 *
 * ويُستدعى **بعد** نجاح العملية لا قبلها: تسجيلُ ما لم يقع أسوأ من عدم تسجيل ما وقع.
 */
export async function recordAudit(input: {
  action: AuditAction;
  entity?: string | null;
  entityId?: string | number | null;
  entityLabel?: string | null;
  details?: Record<string, unknown> | null;
  actor: string;
  actorRole?: string | null;
}): Promise<void> {
  try {
    await ensureSchema();
    await getPool().query(
      `INSERT INTO audit_log (action, entity, entity_id, summary, details, actor, actor_role)
       VALUES ($1, $2::text, $3::text, $4, $5::jsonb, $6, $7::text)`,
      [
        input.action,
        input.entity ?? null,
        input.entityId === null || input.entityId === undefined ? null : String(input.entityId),
        describeAudit(input.action, input.entityLabel),
        JSON.stringify(sanitizeDetails(input.details)),
        input.actor,
        input.actorRole ?? null,
      ],
    );
  } catch {
    // يُبتلع عمدًا — انظر التعليق أعلاه.
  }
}

interface AuditRow {
  id: string; action: string; entity: string | null; entity_id: string | null;
  summary: string; details: Record<string, unknown> | null;
  actor: string; actor_role: string | null; created_at: Date;
}

const toAuditEntry = (row: AuditRow): AuditEntry => ({
  id: Number(row.id),
  action: row.action as AuditAction,
  entity: row.entity,
  entityId: row.entity_id,
  summary: row.summary,
  details: row.details,
  actor: row.actor,
  actorRole: row.actor_role,
  createdAt: row.created_at.toISOString(),
});

/**
 * قراءة السجل — بتصفية تجعله مقروءًا.
 *
 * سجلٌّ يُعرض بألف سطر بلا تصفية لا يُقرأ، فلا يُراجَع، فلا يشهد. والمالك يفتحه
 * بسؤال محدّد: ماذا فعل فلان؟ من ألغى هذه الفاتورة؟ ماذا جرى أمس؟
 */
export async function listAudit(input: {
  from?: string | null;
  to?: string | null;
  action?: string | null;
  actor?: string | null;
  entity?: string | null;
  entityId?: string | null;
  limit?: number;
} = {}): Promise<AuditEntry[]> {
  await ensureSchema();
  const { rows } = await getPool().query<AuditRow>(
    `SELECT id, action, entity, entity_id, summary, details, actor, actor_role, created_at
       FROM audit_log
      WHERE ($1::date IS NULL OR (created_at AT TIME ZONE $7)::date >= $1::date)
        AND ($2::date IS NULL OR (created_at AT TIME ZONE $7)::date <= $2::date)
        AND ($3::text IS NULL OR action = $3::text)
        AND ($4::text IS NULL OR actor = $4::text)
        AND ($5::text IS NULL OR (entity = $5::text AND ($6::text IS NULL OR entity_id = $6::text)))
      ORDER BY id DESC
      LIMIT $8`,
    [
      input.from ?? null, input.to ?? null, input.action ?? null, input.actor ?? null,
      input.entity ?? null, input.entityId ?? null, CLINIC_TIME_ZONE,
      Math.min(Math.max(1, input.limit ?? 200), 500),
    ],
  );
  return rows.map(toAuditEntry);
}

/** من عمل في هذه الفترة — لقائمة التصفية. */
export async function auditActors(): Promise<string[]> {
  await ensureSchema();
  const { rows } = await getPool().query<{ actor: string }>(
    `SELECT DISTINCT actor FROM audit_log ORDER BY actor LIMIT 50`,
  );
  return rows.map((row) => row.actor);
}

// ─── الزيارة السريرية — الحلقة بين السريري والمالي ──────────────────────────

import {
  canSign, conditionForCategory, formatAddendum, visitTotal,
  type ClinicalStatus, type ProcedureLine, type VisitProcedureInput,
} from "./clinical";

export interface ClinicalVisit {
  id: number;
  patientId: number | null;
  patientName: string;
  chiefComplaint: string | null;
  examination: string | null;
  diagnosis: string | null;
  treatmentDone: string | null;
  nextPlan: string | null;
  addendum: string | null;
  doctorId: number | null;
  status: ClinicalStatus;
  signedAt: string | null;
  signedBy: string | null;
  invoiceId: number | null;
  arrivedAt: string;
  procedures: ProcedureLine[];
  totalMinor: number;
  /** بنود خطةٍ موافَقٍ عليها تشطبها هذه الزيارة. */
  planItemsMatched: number;
  planTitle: string | null;
  /** تحذير فوترةٍ مزدوجة إن كانت البنود المطابِقة على خطة أقساط. */
  planWarning: string | null;
  /** حالة التقويم المفتوحة إن كان المريض مريض تقويم. */
  ortho: VisitOrtho | null;
}

export interface VisitOrtho {
  caseId: number;
  appliance: string;
  phase: string;
  slot: string;
  upperWire: string | null;
  lowerWire: string | null;
  lastAdjustment: string | null;
  daysSinceLast: number | null;
  lastDone: string | null;
  elastics: string | null;
  elasticNote: string | null;
  suggestedUpper: string | null;
  suggestedLower: string | null;
}

interface ClinicalRow {
  id: number; patient_id: number | null; patient_name: string; patient_phone: string | null;
  chief_complaint: string | null; examination: string | null; diagnosis: string | null;
  treatment_done: string | null; next_plan: string | null; addendum: string | null;
  doctor_id: number | null; signed_at: Date | null; signed_by: string | null;
  invoice_id: number | null; arrived_at: Date;
}

interface ProcedureRow {
  service_id: number; service_name: string; category: string | null;
  doctor_id: number | null; tooth_code: number | null; surfaces: string | null;
  quantity: number; unit_price_minor: string;
}

const toProcedureLine = (row: ProcedureRow): ProcedureLine => ({
  serviceId: row.service_id,
  serviceName: row.service_name,
  category: row.category,
  toothCode: row.tooth_code,
  surfaces: row.surfaces,
  quantity: row.quantity,
  unitPriceMinor: toMinor(row.unit_price_minor),
  totalMinor: row.quantity * toMinor(row.unit_price_minor),
  doctorId: row.doctor_id,
});

export async function getClinicalVisit(visitId: number): Promise<ClinicalVisit | null> {
  await ensureSchema();
  const pool = getPool();
  const { rows } = await pool.query<ClinicalRow>(
    `SELECT id, patient_id, patient_name, patient_phone, chief_complaint, examination, diagnosis,
            treatment_done, next_plan, addendum, doctor_id, signed_at, signed_by,
            invoice_id, arrived_at
       FROM visits WHERE id = $1`,
    [visitId],
  );
  if (!rows[0]) return null;

  const { rows: procedureRows } = await pool.query<ProcedureRow>(
    `SELECT p.service_id, s.name AS service_name, s.category, p.doctor_id,
            p.tooth_code, p.surfaces, p.quantity, p.unit_price_minor
       FROM visit_procedures p JOIN services s ON s.id = p.service_id
      WHERE p.visit_id = $1 ORDER BY p.id`,
    [visitId],
  );
  const procedures = procedureRows.map(toProcedureLine);
  const row = rows[0];
  const patientId = await previewPatientId(pool, row);
  const plan = await visitPlanContext(pool, patientId, procedures);
  const ortho = await visitOrthoContext(patientId);
  return {
    id: row.id,
    patientId: row.patient_id,
    patientName: row.patient_name,
    chiefComplaint: row.chief_complaint,
    examination: row.examination,
    diagnosis: row.diagnosis,
    treatmentDone: row.treatment_done,
    nextPlan: row.next_plan,
    addendum: row.addendum,
    doctorId: row.doctor_id,
    status: row.signed_at ? "signed" : "open",
    signedAt: row.signed_at?.toISOString() ?? null,
    signedBy: row.signed_by,
    invoiceId: row.invoice_id,
    arrivedAt: row.arrived_at.toISOString(),
    procedures,
    totalMinor: visitTotal(procedures),
    planItemsMatched: plan.matched,
    planTitle: plan.title,
    planWarning: plan.warning,
    ortho,
  };
}

/**
 * حالة التقويم كما تُقرأ على الكرسي.
 *
 * مريض التقويم لا يأتي في زيارةٍ مستقلّة — يأتي في **الشدّة الحادية عشرة** من علاجٍ
 * بدأ قبل سنة. والطبيب يحتاج قبل أن يفتح فمه: على أيّ سلكٍ هو، وماذا عُمل آخر مرة،
 * وكم مضى منذاك. وبلا ذلك يُفتح تبويبٌ آخر ويُبحث ويُقرأ — أو، وهو الأسوأ، يُخمَّن.
 */
async function visitOrthoContext(patientId: number | null): Promise<VisitOrtho | null> {
  if (!patientId) return null;
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const open = await openOrthoCaseFor(patientId, today);
  if (!open) return null;
  const last = open.adjustments[0] ?? null;
  return {
    caseId: open.id,
    appliance: open.appliance,
    phase: open.phase,
    slot: open.slot,
    upperWire: open.upperWire,
    lowerWire: open.lowerWire,
    lastAdjustment: last?.doneOn ?? null,
    daysSinceLast: open.progress.daysSinceLast,
    lastDone: last?.done ?? null,
    elastics: last?.elastics ?? null,
    elasticNote: last?.elasticNote ?? null,
    suggestedUpper: nextWire(open.slot, open.upperWire)?.code ?? null,
    suggestedLower: nextWire(open.slot, open.lowerWire)?.code ?? null,
  };
}

/**
 * أيّ ملفٍّ **سيؤول إليه** هذا المريض عند التوقيع؟
 *
 * زيارة المريض المشي بلا `patient_id` حتى تُوقَّع، وحينها يُحلّ ملفّها بالهاتف.
 * والعرض قبل التوقيع يحتاج الجواب نفسه — بلا أن يكتب شيئًا: قراءةٌ فقط، فلا يُنشئ
 * ملفًّا ولا يربط زيارة. وبلا هذا يبقى تحذير الفوترة المزدوجة مخفيًّا عن أكثر من
 * يحتاجه: المريض الذي وصل من الباب لا من الموعد.
 */
async function previewPatientId(
  pool: Pool,
  visit: { patient_id: number | null; patient_phone?: string | null },
): Promise<number | null> {
  if (visit.patient_id) return visit.patient_id;
  const phone = visit.patient_phone ?? null;
  if (!normalizePatientPhone(phone)) return null;
  const { rows } = await pool.query<{ id: number }>(
    `SELECT id FROM patients WHERE phone = ANY($1::text[]) ORDER BY id LIMIT 1`,
    [phoneLookupForms(phone)],
  );
  return rows[0]?.id ?? null;
}

/**
 * ما علاقة هذه الزيارة بخطة علاج المريض؟
 *
 * جوابان مطلوبان قبل الضغط على زر التوقيع:
 *
 * ١) **أيّ بنود الخطة تشطبها هذه الزيارة** — ليرى الطبيب أن ما يعمله محسوبٌ من
 *    الاتفاق لا خارجه.
 *
 * ٢) **تحذير الفوترة المزدوجة**، وهو الأهم. خطةٌ لها جدول أقساط تُفوتَر بأقساطها؛
 *    فإن وُقّعت زيارةٌ بإجراءاتٍ من بنودها صدرت فاتورةٌ ثانية للعمل نفسه — ويُطالَب
 *    المريض بالمبلغ مرتين. ولا يُمنع هنا بالقوة: قد يكون الإجراء خارج الاتفاق فعلًا
 *    ويستحقّ فاتورته. لكنه لا يمرّ صامتًا — والصمت هو ما يُنتج مطالبةً مكرّرة يكتشفها
 *    المريض قبل المحاسب.
 */
async function visitPlanContext(
  pool: Pool,
  patientId: number | null,
  procedures: ProcedureLine[],
): Promise<{ matched: number; title: string | null; warning: string | null }> {
  if (!patientId || procedures.length === 0) return { matched: 0, title: null, warning: null };

  const { rows } = await pool.query<{
    id: number; plan_id: number; title: string; service_id: number | null;
    tooth_code: number | null; quantity: number; unit_price_minor: string;
    status: string; installments: string;
  }>(
    `SELECT i.id, i.plan_id, t.title, i.service_id, i.tooth_code, i.quantity,
            i.unit_price_minor, i.status,
            (SELECT COUNT(*) FROM plan_installments n WHERE n.plan_id = t.id)::text AS installments
       FROM plan_items i JOIN treatment_plans t ON t.id = i.plan_id
      WHERE t.patient_id = $1 AND t.status = 'active' AND t.consent_at IS NOT NULL
        AND i.status = 'planned'
      ORDER BY i.id`,
    [patientId],
  );
  if (rows.length === 0) return { matched: 0, title: null, warning: null };

  const matchedIds = matchPlanItems(
    rows.map((row) => ({
      id: row.id, serviceId: row.service_id, toothCode: row.tooth_code,
      quantity: row.quantity, unitPriceMinor: toMinor(row.unit_price_minor),
      status: row.status as PlanItemStatus,
    })),
    procedures.map((line) => ({
      serviceId: line.serviceId, toothCode: line.toothCode, quantity: line.quantity,
    })),
  );
  if (matchedIds.length === 0) return { matched: 0, title: null, warning: null };

  const matchedSet = new Set(matchedIds);
  const hit = rows.find((row) => matchedSet.has(row.id));
  const onInstalments = rows.some((row) => matchedSet.has(row.id) && Number(row.installments) > 0);

  return {
    matched: matchedIds.length,
    title: hit?.title ?? null,
    warning: onInstalments
      ? "هذه الإجراءات ضمن خطة لها جدول أقساط — والتوقيع سيصدر فاتورة إضافية عليها. إن كان العمل داخل الاتفاق فحصّله بقسط لا بفاتورة."
      : null,
  };
}

/** حفظ التوثيق السريري قبل التوقيع — يُرفض بعده، والتصحيح بملحق. */
export async function saveClinicalNotes(input: {
  visitId: number;
  chiefComplaint: string | null;
  examination: string | null;
  diagnosis: string | null;
  treatmentDone: string | null;
  nextPlan: string | null;
  doctorId: number | null;
}): Promise<boolean> {
  await ensureSchema();
  const { rowCount } = await getPool().query(
    `UPDATE visits SET chief_complaint = $2::text, examination = $3::text,
            diagnosis = $4::text, treatment_done = $5::text, next_plan = $6::text,
            doctor_id = COALESCE($7::int, doctor_id)
      WHERE id = $1 AND signed_at IS NULL`,
    [input.visitId, input.chiefComplaint, input.examination, input.diagnosis,
     input.treatmentDone, input.nextPlan, input.doctorId],
  );
  return (rowCount ?? 0) > 0;
}

export async function setVisitProcedures(input: {
  visitId: number;
  procedures: VisitProcedureInput[];
}): Promise<boolean> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // الحارس داخل الجملة: زيارةٌ وُقّعت بين القراءة والكتابة لا تُغيَّر إجراءاتها.
    const { rows } = await client.query<{ id: number }>(
      `SELECT id FROM visits WHERE id = $1 AND signed_at IS NULL FOR UPDATE`,
      [input.visitId],
    );
    if (!rows[0]) { await client.query("ROLLBACK"); return false; }

    await client.query(`DELETE FROM visit_procedures WHERE visit_id = $1`, [input.visitId]);
    for (const procedure of input.procedures) {
      await client.query(
        `INSERT INTO visit_procedures
           (visit_id, service_id, doctor_id, tooth_code, surfaces, quantity, unit_price_minor, note)
         VALUES ($1, $2, $3::int, $4::int, $5::text, $6, $7, $8::text)`,
        [input.visitId, procedure.serviceId, procedure.doctorId, procedure.toothCode,
         normalizeSurfaces(procedure.surfaces), Math.max(1, Math.round(procedure.quantity)),
         Math.max(0, Math.round(procedure.unitPriceMinor)), procedure.note],
      );
    }
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * توقيع الزيارة — **الحلقة التي كانت مقطوعة**.
 *
 * عملٌ واحد يُنتج ثلاثة آثار في **معاملة واحدة**: توقيع الزيارة، وفاتورةٌ من دليل
 * الخدمات، وتحديث المخطط السني بما أُنجز. إمّا كلها أو لا شيء — والدستور §٤٠.
 *
 * ولماذا معاملة واحدة لا ثلاث خطوات: لأن الفشل بين الخطوتين هو الكارثة نفسها التي
 * جاء الترابط ليمنعها — زيارةٌ موقَّعة بلا فاتورة (عملٌ ضاع)، أو فاتورةٌ بلا زيارة
 * (مطالبةٌ بلا سند)، أو مخططٌ يقول إن التاج رُكّب والفاتورة لا تعرف.
 */
export async function signClinicalVisit(input: {
  visitId: number;
  baseCurrency: Currency;
  signedBy: string;
}): Promise<{
  visit: ClinicalVisit | null;
  invoiceId: number | null;
  chartUpdates: number;
  /** بنود خطة العلاج التي شطبتها هذه الزيارة. */
  planItemsDone: number;
  reason: "not_found" | "already_signed" | "empty" | "no_patient" | null;
}> {
  const existing = await getClinicalVisit(input.visitId);
  if (!existing) return { visit: null, invoiceId: null, chartUpdates: 0, planItemsDone: 0, reason: "not_found" };
  if (existing.status === "signed") {
    return { visit: existing, invoiceId: existing.invoiceId, chartUpdates: 0, planItemsDone: 0, reason: "already_signed" };
  }
  const check = canSign({
    status: existing.status,
    procedures: existing.procedures,
    diagnosis: existing.diagnosis,
    treatmentDone: existing.treatmentDone,
  });
  if (!check.ok) return { visit: existing, invoiceId: null, chartUpdates: 0, planItemsDone: 0, reason: "empty" };

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const { rows: locked } = await client.query<{
      id: number; patient_name: string; patient_phone: string | null; patient_id: number | null;
    }>(
      `SELECT id, patient_name, patient_phone, patient_id FROM visits
        WHERE id = $1 AND signed_at IS NULL FOR UPDATE`,
      [input.visitId],
    );
    if (!locked[0]) {
      await client.query("ROLLBACK");
      return { visit: existing, invoiceId: null, chartUpdates: 0, planItemsDone: 0, reason: "already_signed" };
    }

    /*
     * ملفُّ المريض يُحلّ هنا لا يُشترط قبلها.
     *
     * المريض المشي يصل باسمه فقط، والطبيب يعالجه ويوقّع — ورفضُ التوقيع لأنه بلا ملف
     * يعني أن يتوقّف الطبيب ليملأ نموذجًا، أو أن يخرج المريض بلا فاتورة. وكلاهما ما
     * جاء الترابط ليمنعه. فيُنشأ الملف هنا **داخل المعاملة نفسها**: إن سقط التوقيع
     * سقط الملف معه، فلا يبقى مريضٌ بلا زيارة.
     */
    const patientId = await resolveVisitPatient(client, locked[0]);

    let invoiceId: number | null = null;
    if (existing.procedures.length > 0) {
      const { rows: invoiceRows } = await client.query<{ id: number }>(
        `INSERT INTO invoices (invoice_number, patient_id, base_currency, total_minor, discount_minor, note, created_by)
         VALUES ('INV-' || LPAD(nextval('invoice_number_seq')::text, 5, '0'),
                 $1, $2, $3, 0, $4::text, $5)
         RETURNING id`,
        [patientId, input.baseCurrency, existing.totalMinor,
         `من الزيارة رقم ${existing.id}`, input.signedBy],
      );
      invoiceId = invoiceRows[0].id;

      for (const line of existing.procedures) {
        await client.query(
          `INSERT INTO invoice_items
             (invoice_id, service_id, doctor_id, description, quantity, unit_price_minor, total_minor)
           VALUES ($1, $2, $3::int, $4, $5, $6, $7)`,
          [invoiceId, line.serviceId, line.doctorId,
           line.toothCode ? `${line.serviceName} — سن ${line.toothCode}` : line.serviceName,
           line.quantity, line.unitPriceMinor, line.totalMinor],
        );
      }
    }

    // المخطط السني: ما أُنجز على سن يصير حالةً منجَزة عليه — بلا تسجيل ثانٍ.
    let chartUpdates = 0;
    {
      for (const line of existing.procedures) {
        const condition = conditionForCategory(line.category);
        if (!condition || !line.toothCode) continue;
        await client.query(
          `INSERT INTO tooth_conditions
             (patient_id, tooth_code, condition, stage, surfaces, note, visit_id, recorded_by)
           VALUES ($1, $2, $3, 'completed', $4::text, $5::text, $6, $7)`,
          [patientId, line.toothCode, condition, line.surfaces,
           `من الزيارة رقم ${existing.id}`, existing.id, input.signedBy],
        );
        chartUpdates += 1;
      }
    }

    /*
     * بنود خطة العلاج تُشطب من نفسها.
     *
     * وهذا ما يفرّق بين خطةٍ حيّة وورقةٍ تُكتب وتُنسى: الطبيب يعمل في الزيارة كما
     * يعمل دائمًا، فتُعلَّم بنود الخطة التي نفّذها هذه الزيارة **منفَّذةً** ومربوطةً
     * بها. وبلا هذا يبقى على أحدٍ أن يتذكّر تحديث الخطة يدويًّا — فلا يتذكّر، فتُظهر
     * الخطة بعد سنةٍ عملًا أُنجز كأنه لم يبدأ، ويُشرح للمريض تقدّمٌ يخالف ملفّه.
     *
     * ولا يُشطب إلا من خطةٍ **موافَقٍ عليها**: المسوّدة ليست اتفاقًا بعد.
     */
    let planItemsDone = 0;
    if (existing.procedures.length > 0) {
      const { rows: openItems } = await client.query<{
        id: number; service_id: number | null; tooth_code: number | null;
        quantity: number; unit_price_minor: string; status: string;
      }>(
        `SELECT i.id, i.service_id, i.tooth_code, i.quantity, i.unit_price_minor, i.status
           FROM plan_items i JOIN treatment_plans t ON t.id = i.plan_id
          WHERE t.patient_id = $1 AND t.status = 'active' AND t.consent_at IS NOT NULL
            AND i.status = 'planned'
          ORDER BY i.id
            FOR UPDATE OF i`,
        [patientId],
      );

      const matched = matchPlanItems(
        openItems.map((row) => ({
          id: row.id,
          serviceId: row.service_id,
          toothCode: row.tooth_code,
          quantity: row.quantity,
          unitPriceMinor: toMinor(row.unit_price_minor),
          status: row.status as PlanItemStatus,
        })),
        existing.procedures.map((line) => ({
          serviceId: line.serviceId, toothCode: line.toothCode, quantity: line.quantity,
        })),
      );

      if (matched.length > 0) {
        const { rowCount } = await client.query(
          `UPDATE plan_items SET status = 'done', visit_id = $2, done_at = NOW()
            WHERE id = ANY($1::int[]) AND status = 'planned'`,
          [matched, input.visitId],
        );
        planItemsDone = rowCount ?? 0;
      }
    }

    await client.query(
      `UPDATE visits SET signed_at = NOW(), signed_by = $2, invoice_id = $3::int,
              status = 'done', finished_at = COALESCE(finished_at, NOW())
        WHERE id = $1`,
      [input.visitId, input.signedBy, invoiceId],
    );

    await client.query("COMMIT");
    return {
      visit: await getClinicalVisit(input.visitId),
      invoiceId, chartUpdates, planItemsDone, reason: null,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** ملحق على زيارة موقَّعة — يُضاف ولا يمحو ما قبله. */
export async function addVisitAddendum(input: {
  visitId: number; text: string; author: string;
}): Promise<boolean> {
  await ensureSchema();
  const entry = formatAddendum({ text: input.text, author: input.author, at: new Date().toISOString() });
  const { rowCount } = await getPool().query(
    `UPDATE visits
        SET addendum = CASE WHEN addendum IS NULL OR addendum = '' THEN $2::text
                            ELSE addendum || E'\n' || $2::text END
      WHERE id = $1 AND signed_at IS NOT NULL`,
    [input.visitId, entry],
  );
  return (rowCount ?? 0) > 0;
}

// ─── مخطط الأسنان ────────────────────────────────────────────────────────────

import {
  buildChart, chartSummary, isValidTooth, normalizeSurfaces,
  type ChartSummary, type ConditionStage, type ToothCondition,
  type ToothRecord, type ToothState,
} from "./dental";

interface ToothRow {
  id: string; tooth_code: number; condition: string; stage: string;
  surfaces: string | null; note: string | null; visit_id: number | null;
  recorded_by: string; recorded_at: Date;
}

const toToothRecord = (row: ToothRow): ToothRecord => ({
  id: Number(row.id),
  toothCode: row.tooth_code,
  condition: row.condition as ToothCondition,
  stage: row.stage as ConditionStage,
  surfaces: row.surfaces,
  note: row.note,
  visitId: row.visit_id,
  recordedBy: row.recorded_by,
  recordedAt: row.recorded_at.toISOString(),
});

export async function patientChart(patientId: number): Promise<{
  records: ToothRecord[];
  chart: [number, ToothState][];
  summary: ChartSummary;
}> {
  await ensureSchema();
  const { rows } = await getPool().query<ToothRow>(
    `SELECT id, tooth_code, condition, stage, surfaces, note, visit_id, recorded_by, recorded_at
       FROM tooth_conditions WHERE patient_id = $1 ORDER BY recorded_at, id`,
    [patientId],
  );
  const records = rows.map(toToothRecord);
  const chart = buildChart(records);
  return { records, chart: [...chart.entries()], summary: chartSummary(chart) };
}

/**
 * يثبّت حالة سن.
 *
 * إضافة لا تعديل: لا دالة في البرنامج تحدّث سطرًا في هذا الجدول أو تحذف منه. وتصحيح
 * خطأ يكون بتثبيت الحالة الصحيحة فوقه — فيبقى الخطأ وتصحيحه ظاهرين، وهو ما يجعل
 * السجل السريري قابلًا للتدقيق.
 */
export async function recordToothCondition(input: {
  patientId: number;
  toothCode: number;
  condition: ToothCondition;
  stage: ConditionStage;
  surfaces?: string | null;
  note?: string | null;
  visitId?: number | null;
  recordedBy: string;
}): Promise<ToothRecord | null> {
  if (!isValidTooth(input.toothCode)) return null;
  await ensureSchema();
  const { rows } = await getPool().query<ToothRow>(
    `INSERT INTO tooth_conditions
       (patient_id, tooth_code, condition, stage, surfaces, note, visit_id, recorded_by)
     SELECT $1, $2, $3, $4, $5::text, $6::text, $7::int, $8
      WHERE EXISTS (SELECT 1 FROM patients WHERE id = $1)
     RETURNING id, tooth_code, condition, stage, surfaces, note, visit_id, recorded_by, recorded_at`,
    [
      input.patientId, input.toothCode, input.condition, input.stage,
      normalizeSurfaces(input.surfaces), input.note?.trim() || null,
      input.visitId ?? null, input.recordedBy,
    ],
  );
  return rows[0] ? toToothRecord(rows[0]) : null;
}

// ─── طبعات المستندات ─────────────────────────────────────────────────────────

/** كم مرة طُبع هذا المستند قبل الآن. */
export async function printCount(docType: string, docId: string | number): Promise<number> {
  await ensureSchema();
  const { rows } = await getPool().query<{ n: string }>(
    `SELECT COUNT(*)::int AS n FROM document_prints WHERE doc_type = $1 AND doc_id = $2::text`,
    [docType, String(docId)],
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * يسجّل طبعة ويعيد **عدد الطبعات السابقة**.
 *
 * السابقة لا الحالية: الجواب المطلوب هو «هل هذه إعادة طباعة؟»، وهو ما يُعرف من
 * وجود طبعةٍ قبلها لا من وجود هذه.
 */
export async function recordPrint(input: {
  docType: string; docId: string | number; printedBy: string;
}): Promise<number> {
  await ensureSchema();
  const previous = await printCount(input.docType, input.docId);
  await getPool().query(
    `INSERT INTO document_prints (doc_type, doc_id, printed_by) VALUES ($1, $2::text, $3)`,
    [input.docType, String(input.docId), input.printedBy],
  );
  return previous;
}

// ─── الأرصدة الافتتاحية للمرضى ───────────────────────────────────────────────

/**
 * الرصيد الافتتاحي: ما كان على المريض **قبل** تشغيل النظام.
 *
 * بلا هذا يبدأ كل مريض من صفر يوم التشغيل، فتضيع مديونية سنوات كاملة في يوم واحد —
 * وهو أسوأ ما يمكن أن يفعله نظام جديد بعيادة قائمة. والبديل الشائع — فتح «فاتورة
 * سابقة» بقيمة الدَّين — أسوأ: يدخل دينٌ قديم في إيراد هذا الشهر، فتظهر أرباح لم
 * تتحقق وتُحسب عمولات عن عمل قديم دُفعت عمولته أصلًا.
 *
 * فهو هنا **بندٌ مستقل**: يدخل حساب المريض ومديونيته، ويُقيَّد أصلًا افتتاحيًا مقابل
 * حقوق الملكية، ولا يمسّ الإيراد ولا العمولات بشيء.
 */
export interface OpeningBalance {
  patientId: number;
  patientName: string;
  phone: string | null;
  amountMinor: number;
  asOfDate: string;
  note: string | null;
  createdBy: string | null;
  updatedAt: string;
}

interface OpeningRow {
  patient_id: number; full_name: string; phone: string | null;
  amount_minor: string; as_of_date: Date; note: string | null;
  created_by: string | null; updated_at: Date;
}

const toOpeningBalance = (row: OpeningRow): OpeningBalance => ({
  patientId: row.patient_id,
  patientName: row.full_name,
  phone: row.phone,
  amountMinor: toMinor(row.amount_minor),
  asOfDate: dateText(row.as_of_date),
  note: row.note,
  createdBy: row.created_by,
  updatedAt: row.updated_at.toISOString(),
});

const OPENING_SELECT = `SELECT o.patient_id, p.full_name, p.phone, o.amount_minor,
                               o.as_of_date, o.note, o.created_by, o.updated_at
                          FROM patient_opening_balances o
                          JOIN patients p ON p.id = o.patient_id`;

export async function getPatientOpeningBalance(patientId: number): Promise<OpeningBalance | null> {
  await ensureSchema();
  const { rows } = await getPool().query<OpeningRow>(
    `${OPENING_SELECT} WHERE o.patient_id = $1`,
    [patientId],
  );
  return rows[0] ? toOpeningBalance(rows[0]) : null;
}

export async function listOpeningBalances(): Promise<OpeningBalance[]> {
  await ensureSchema();
  const { rows } = await getPool().query<OpeningRow>(
    `${OPENING_SELECT} ORDER BY o.amount_minor DESC LIMIT 500`,
  );
  return rows.map(toOpeningBalance);
}

/** أرصدة افتتاحية لمجموعة مرضى — للتقارير التي تقرأ مئات الصفوف بلا استعلام لكل صف. */
export async function openingBalanceAmounts(patientIds: number[]): Promise<Map<number, number>> {
  if (patientIds.length === 0) return new Map();
  await ensureSchema();
  const { rows } = await getPool().query<{ patient_id: number; amount_minor: string }>(
    `SELECT patient_id, amount_minor FROM patient_opening_balances WHERE patient_id = ANY($1::int[])`,
    [patientIds],
  );
  return new Map(rows.map((row) => [row.patient_id, toMinor(row.amount_minor)]));
}

/**
 * إثبات الرصيد الافتتاحي أو تصحيحه.
 *
 * صفٌّ واحد لكل مريض: إعادة الإدخال **تصحيح** لا إضافة، لأن رصيدًا افتتاحيًا يُدخل
 * مرتين بالخطأ يضاعف دَين المريض بصمت — وهو خطأ يقع كثيرًا يوم إدخال البيانات
 * القديمة حين يعمل أكثر من شخص على الملفات نفسها.
 */
export async function setPatientOpeningBalance(input: {
  patientId: number;
  amountMinor: number;
  asOfDate: string;
  note: string | null;
  createdBy: string;
}): Promise<OpeningBalance | null> {
  await ensureSchema();
  const { rows } = await getPool().query<{ patient_id: number }>(
    `INSERT INTO patient_opening_balances
       (patient_id, amount_minor, as_of_date, note, created_by)
     SELECT $1, $2, $3::date, $4, $5
      WHERE EXISTS (SELECT 1 FROM patients WHERE id = $1)
     ON CONFLICT (patient_id) DO UPDATE
        SET amount_minor = EXCLUDED.amount_minor,
            as_of_date   = EXCLUDED.as_of_date,
            note         = EXCLUDED.note,
            created_by   = EXCLUDED.created_by,
            updated_at   = NOW()
     RETURNING patient_id`,
    [input.patientId, input.amountMinor, input.asOfDate, input.note, input.createdBy],
  );
  return rows[0] ? getPatientOpeningBalance(rows[0].patient_id) : null;
}

export async function clearPatientOpeningBalance(patientId: number): Promise<boolean> {
  await ensureSchema();
  const { rowCount } = await getPool().query(
    `DELETE FROM patient_opening_balances WHERE patient_id = $1`,
    [patientId],
  );
  return (rowCount ?? 0) > 0;
}

// ─── خطط العلاج والأقساط ─────────────────────────────────────────────────────

import {
  canConsent, canEditItems, itemsTotal, matchPlanItems, planItemsProgress, planProgress,
  splitInstallments,
  type PlanItemLike, type PlanItemStatus, type PlanItemsProgress, type PlanStatus, type PlanProgress,
} from "./plans";

export interface TreatmentPlan {
  id: number;
  patientId: number;
  patientName: string;
  patientPhone: string | null;
  title: string;
  totalMinor: number;
  baseCurrency: Currency;
  status: PlanStatus;
  startDate: string;
  note: string | null;
  createdAt: string;
  installments: { id: number; number: number; dueDate: string; amountMinor: number }[];
  paidMinor: number;
  progress: PlanProgress;
  items: PlanItem[];
  itemsProgress: PlanItemsProgress;
  totalFromItems: boolean;
  consentAt: string | null;
  consentBy: string | null;
  consentNote: string | null;
}

/** بندٌ في الخطة: خدمةٌ على سنّ بسعرٍ منسوخ لحظة الاتفاق. */
export interface PlanItem {
  id: number;
  serviceId: number | null;
  serviceName: string;
  category: string | null;
  toothCode: number | null;
  surfaces: string | null;
  quantity: number;
  unitPriceMinor: number;
  totalMinor: number;
  status: PlanItemStatus;
  visitId: number | null;
  doneAt: string | null;
  note: string | null;
}

interface PlanRow {
  id: number; patient_id: number; full_name: string; phone: string | null;
  title: string; total_minor: string; base_currency: string; status: string;
  start_date: Date; note: string | null; created_at: Date; paid_minor: string;
  total_from_items: boolean; consent_at: Date | null; consent_by: string | null;
  consent_note: string | null;
}

const PLAN_SELECT = `
  SELECT t.id, t.patient_id, p.full_name, p.phone, t.title, t.total_minor, t.base_currency,
         t.status, t.start_date, t.note, t.created_at,
         t.total_from_items, t.consent_at, t.consent_by, t.consent_note,
         COALESCE((SELECT SUM(CASE WHEN y.kind = 'refund' THEN -y.base_amount_minor ELSE y.base_amount_minor END)
                     FROM payments y WHERE y.plan_id = t.id), 0) AS paid_minor
    FROM treatment_plans t JOIN patients p ON p.id = t.patient_id`;

async function hydratePlans(rows: PlanRow[], today: string): Promise<TreatmentPlan[]> {
  if (rows.length === 0) return [];
  const { rows: installmentRows } = await getPool().query<{
    id: number; plan_id: number; number: number; due_date: Date; amount_minor: string;
  }>(
    `SELECT id, plan_id, number, due_date, amount_minor FROM plan_installments
      WHERE plan_id = ANY($1::int[]) ORDER BY plan_id, number`,
    [rows.map((row) => row.id)],
  );

  const { rows: itemRows } = await getPool().query<PlanItemRow & { plan_id: number }>(
    `${PLAN_ITEM_SELECT} WHERE plan_id = ANY($1::int[]) ORDER BY plan_id, sort_order, id`,
    [rows.map((row) => row.id)],
  );
  const itemsByPlan = new Map<number, PlanItem[]>();
  for (const row of itemRows) {
    const list = itemsByPlan.get(row.plan_id) ?? [];
    list.push(toPlanItem(row));
    itemsByPlan.set(row.plan_id, list);
  }

  const byPlan = new Map<number, { id: number; number: number; dueDate: string; amountMinor: number }[]>();
  for (const row of installmentRows) {
    const list = byPlan.get(row.plan_id) ?? [];
    list.push({
      id: row.id, number: row.number,
      dueDate: dateText(row.due_date), amountMinor: toMinor(row.amount_minor),
    });
    byPlan.set(row.plan_id, list);
  }

  return rows.map((row) => {
    const installments = byPlan.get(row.id) ?? [];
    const items = itemsByPlan.get(row.id) ?? [];
    const paidMinor = toMinor(row.paid_minor);
    return {
      id: row.id,
      patientId: row.patient_id,
      patientName: row.full_name,
      patientPhone: row.phone,
      title: row.title,
      totalMinor: toMinor(row.total_minor),
      baseCurrency: row.base_currency as Currency,
      status: row.status as PlanStatus,
      startDate: dateText(row.start_date),
      note: row.note,
      createdAt: row.created_at.toISOString(),
      installments,
      paidMinor,
      progress: planProgress(
        { totalMinor: toMinor(row.total_minor), status: row.status as PlanStatus, installments },
        paidMinor,
        today,
      ),
      items,
      itemsProgress: planItemsProgress(items),
      totalFromItems: row.total_from_items,
      consentAt: row.consent_at ? row.consent_at.toISOString() : null,
      consentBy: row.consent_by,
      consentNote: row.consent_note,
    };
  });
}

interface PlanItemRow {
  id: number; service_id: number | null; service_name: string; category: string | null;
  tooth_code: number | null; surfaces: string | null; quantity: number;
  unit_price_minor: string; status: string; visit_id: number | null;
  done_at: Date | null; note: string | null;
}

const PLAN_ITEM_SELECT = `
  SELECT id, plan_id, service_id, service_name, category, tooth_code, surfaces, quantity,
         unit_price_minor, status, visit_id, done_at, note, sort_order
    FROM plan_items`;

function toPlanItem(row: PlanItemRow): PlanItem {
  const quantity = Math.max(1, row.quantity);
  const unitPriceMinor = toMinor(row.unit_price_minor);
  return {
    id: row.id,
    serviceId: row.service_id,
    serviceName: row.service_name,
    category: row.category,
    toothCode: row.tooth_code,
    surfaces: row.surfaces,
    quantity,
    unitPriceMinor,
    totalMinor: quantity * unitPriceMinor,
    status: row.status as PlanItemStatus,
    visitId: row.visit_id,
    doneAt: row.done_at ? row.done_at.toISOString() : null,
    note: row.note,
  };
}

export async function listPatientPlans(patientId: number, today: string): Promise<TreatmentPlan[]> {
  await ensureSchema();
  const { rows } = await getPool().query<PlanRow>(
    `${PLAN_SELECT} WHERE t.patient_id = $1 ORDER BY t.created_at DESC`, [patientId],
  );
  return hydratePlans(rows, today);
}

export async function getPlan(id: number, today: string): Promise<TreatmentPlan | null> {
  await ensureSchema();
  const { rows } = await getPool().query<PlanRow>(`${PLAN_SELECT} WHERE t.id = $1`, [id]);
  const plans = await hydratePlans(rows, today);
  return plans[0] ?? null;
}

/** الخطط الجارية — لقائمة الأقساط المستحقة والمتأخرة. */
export async function listActivePlans(today: string): Promise<TreatmentPlan[]> {
  await ensureSchema();
  const { rows } = await getPool().query<PlanRow>(
    `${PLAN_SELECT} WHERE t.status = 'active' ORDER BY t.created_at DESC LIMIT 300`,
  );
  return hydratePlans(rows, today);
}

/**
 * ينشئ خطة بجدول أقساطها في معاملة واحدة.
 *
 * الخطة بلا أقساط اتفاقٌ بلا مواعيد — وهو ما كان يحدث على الورق: سعرٌ متفق عليه ولا
 * أحد يعرف متى يُدفع، فيُسأل المريض في كل زيارة «كم تدفع اليوم؟».
 */
export async function createPlan(input: {
  patientId: number;
  title: string;
  totalMinor: number;
  baseCurrency: Currency;
  startDate: string;
  note: string | null;
  createdBy: string;
  installments: { number: number; dueDate: string; amountMinor: number }[];
}): Promise<number | null> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency, start_date, note, created_by)
       VALUES ($1, $2, $3, $4, $5::date, $6::text, $7) RETURNING id`,
      [input.patientId, input.title, input.totalMinor, input.baseCurrency,
       input.startDate, input.note, input.createdBy],
    );
    for (const installment of input.installments) {
      await client.query(
        `INSERT INTO plan_installments (plan_id, number, due_date, amount_minor)
         VALUES ($1, $2, $3::date, $4)`,
        [rows[0].id, installment.number, installment.dueDate, installment.amountMinor],
      );
    }
    await client.query("COMMIT");
    return rows[0].id;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function setPlanStatus(id: number, status: PlanStatus): Promise<boolean> {
  await ensureSchema();
  const { rowCount } = await getPool().query(
    `UPDATE treatment_plans SET status = $2 WHERE id = $1`, [id, status],
  );
  return (rowCount ?? 0) > 0;
}

/* ────────────────── بنود الخطة السريرية وموافقتها ────────────────── */

type PlanGuard = { ok: true } | { ok: false; message: string };

/** حالة الخطة كما تحتاجها الحُرّاس — تُقرأ مع قفلٍ كي لا تتغيّر بين الفحص والتنفيذ. */
async function lockPlan(client: PoolClient, planId: number): Promise<{
  id: number; patientId: number; status: PlanStatus; consentAt: Date | null;
  baseCurrency: Currency; totalFromItems: boolean;
} | null> {
  const { rows } = await client.query<{
    id: number; patient_id: number; status: string; consent_at: Date | null;
    base_currency: string; total_from_items: boolean;
  }>(
    `SELECT id, patient_id, status, consent_at, base_currency, total_from_items
       FROM treatment_plans WHERE id = $1 FOR UPDATE`,
    [planId],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    id: row.id, patientId: row.patient_id, status: row.status as PlanStatus,
    consentAt: row.consent_at, baseCurrency: row.base_currency as Currency,
    totalFromItems: row.total_from_items,
  };
}

/**
 * يعيد حساب إجمالي الخطة من بنودها.
 *
 * يُستدعى بعد كل تغيّر في البنود — وهو ما يجعل «الإجمالي» و«مجموع البنود» رقمًا
 * واحدًا لا رقمين يفترقان بعد أول تعديل يُنسى.
 */
async function recomputePlanTotal(client: PoolClient, planId: number): Promise<number> {
  const { rows } = await client.query<{ id: number; quantity: number; unit_price_minor: string; status: string }>(
    `SELECT id, quantity, unit_price_minor, status FROM plan_items WHERE plan_id = $1`, [planId],
  );
  const total = itemsTotal(rows.map((row): PlanItemLike => ({
    serviceId: null, toothCode: null,
    quantity: row.quantity, unitPriceMinor: toMinor(row.unit_price_minor),
    status: row.status as PlanItemStatus,
  })));
  await client.query(
    `UPDATE treatment_plans SET total_minor = $2, total_from_items = TRUE WHERE id = $1`,
    [planId, total],
  );
  return total;
}

export async function addPlanItem(input: {
  planId: number;
  serviceId: number | null;
  serviceName: string;
  category: string | null;
  toothCode: number | null;
  surfaces: string | null;
  quantity: number;
  unitPriceMinor: number;
  note: string | null;
}): Promise<PlanGuard & { totalMinor?: number }> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const plan = await lockPlan(client, input.planId);
    if (!plan) { await client.query("ROLLBACK"); return { ok: false, message: "الخطة غير موجودة." }; }

    const allowed = canEditItems({ status: plan.status, consentAt: plan.consentAt?.toISOString() ?? null });
    if (!allowed.ok) { await client.query("ROLLBACK"); return allowed; }

    if (input.toothCode !== null && !isValidTooth(input.toothCode)) {
      await client.query("ROLLBACK");
      return { ok: false, message: "رقم سنّ غير صحيح بالترقيم الدولي." };
    }

    await client.query(
      `INSERT INTO plan_items
         (plan_id, service_id, service_name, category, tooth_code, surfaces,
          quantity, unit_price_minor, note, sort_order)
       VALUES ($1, $2, $3, $4::text, $5, $6::text, $7, $8, $9::text,
               COALESCE((SELECT MAX(sort_order) + 1 FROM plan_items WHERE plan_id = $1), 100))`,
      [
        input.planId, input.serviceId, input.serviceName.trim(), input.category,
        input.toothCode, normalizeSurfaces(input.surfaces),
        Math.max(1, Math.round(input.quantity)), Math.max(0, Math.round(input.unitPriceMinor)),
        input.note?.trim() || null,
      ],
    );
    const totalMinor = await recomputePlanTotal(client, input.planId);
    await client.query("COMMIT");
    return { ok: true, totalMinor };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * يحذف بندًا **قبل** الموافقة فقط.
 *
 * ما قبل الموافقة مسوّدة يُصحَّح فيها بحرّية، وما بعدها وثيقةٌ وقّعها المريض. ولذلك
 * لا يوجد «حذف بند» بعد الموافقة أصلًا — لا إلغاء ولا شطب: الوثيقة تبقى كما وُقّعت،
 * والمستجدّ يُوثَّق بخطةٍ جديدة.
 */
export async function removePlanItem(planId: number, itemId: number): Promise<PlanGuard> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const plan = await lockPlan(client, planId);
    if (!plan) { await client.query("ROLLBACK"); return { ok: false, message: "الخطة غير موجودة." }; }

    const allowed = canEditItems({ status: plan.status, consentAt: plan.consentAt?.toISOString() ?? null });
    if (!allowed.ok) { await client.query("ROLLBACK"); return allowed; }

    const { rowCount } = await client.query(
      `DELETE FROM plan_items WHERE id = $1 AND plan_id = $2`, [itemId, planId],
    );
    if ((rowCount ?? 0) === 0) { await client.query("ROLLBACK"); return { ok: false, message: "البند غير موجود." }; }

    await recomputePlanTotal(client, planId);
    await client.query("COMMIT");
    return { ok: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * يسجّل موافقة المريض — وهي اللحظة التي تصير فيها المسوّدة اتفاقًا.
 *
 * وفيها تنتقل بنود الخطة إلى **المخطط السني** بوصفها حالاتٍ مخطَّطة: قبل الموافقة
 * كانت نيّةً في رأس الطبيب، وبعدها صارت عملًا متفَقًا عليه يجب أن يراه كل من يفتح
 * ملف المريض — بما فيهم طبيبٌ آخر يستلم الحالة غدًا.
 */
export async function recordPlanConsent(input: {
  planId: number;
  actor: string;
  note: string | null;
}): Promise<PlanGuard & { itemCount?: number; totalMinor?: number }> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const plan = await lockPlan(client, input.planId);
    if (!plan) { await client.query("ROLLBACK"); return { ok: false, message: "الخطة غير موجودة." }; }

    const { rows: itemRows } = await client.query<{
      id: number; category: string | null; tooth_code: number | null;
      surfaces: string | null; quantity: number; unit_price_minor: string; status: string;
    }>(
      `SELECT id, category, tooth_code, surfaces, quantity, unit_price_minor, status
         FROM plan_items WHERE plan_id = $1 ORDER BY sort_order, id`,
      [input.planId],
    );

    const guard = canConsent({
      status: plan.status,
      consentAt: plan.consentAt?.toISOString() ?? null,
      items: itemRows.map((row) => ({
        serviceId: null, toothCode: row.tooth_code,
        quantity: row.quantity, unitPriceMinor: toMinor(row.unit_price_minor),
        status: row.status as PlanItemStatus,
      })),
    });
    if (!guard.ok) { await client.query("ROLLBACK"); return guard; }

    const totalMinor = await recomputePlanTotal(client, input.planId);
    await client.query(
      `UPDATE treatment_plans SET consent_at = NOW(), consent_by = $2, consent_note = $3::text
         WHERE id = $1`,
      [input.planId, input.actor, input.note?.trim() || null],
    );

    // البنود على المخطط: حالاتٌ مخطَّطة لا منجَزة — والفرق بينهما نصف قيمة المخطط.
    let charted = 0;
    for (const row of itemRows) {
      const condition = conditionForCategory(row.category);
      if (!condition || row.tooth_code === null) continue;
      await client.query(
        `INSERT INTO tooth_conditions
           (patient_id, tooth_code, condition, stage, surfaces, note, recorded_by)
         VALUES ($1, $2, $3, 'planned', $4::text, $5::text, $6)`,
        [
          plan.patientId, row.tooth_code, condition, normalizeSurfaces(row.surfaces),
          `من خطة العلاج رقم ${input.planId}`, input.actor,
        ],
      );
      charted += 1;
    }

    await client.query("COMMIT");
    void recordAudit({
      action: "plan.consent",
      entity: "treatment_plans",
      entityId: input.planId,
      entityLabel: `خطة رقم ${input.planId}`,
      details: { البنود: itemRows.length, "على المخطط": charted },
      actor: input.actor,
    });
    return { ok: true, itemCount: itemRows.length, totalMinor };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * يبني جدول الأقساط لخطةٍ موافَقٍ عليها.
 *
 * ولا يُبنى قبل الموافقة عمدًا: الأقساط تُشتقّ من الإجمالي، والإجمالي لا يستقرّ إلا
 * بالموافقة. وجدولٌ يُبنى على رقمٍ ما زال يتغيّر جدولٌ يُعاد بناؤه — وكل إعادةٍ فرصةٌ
 * لأن يبقى قسطٌ قديمٌ معلّقًا في مكانٍ ما.
 */
export async function schedulePlanInstallments(input: {
  planId: number;
  count: number;
  everyDays: number;
  firstDueDate: string;
}): Promise<PlanGuard & { count?: number }> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const plan = await lockPlan(client, input.planId);
    if (!plan) { await client.query("ROLLBACK"); return { ok: false, message: "الخطة غير موجودة." }; }
    if (!plan.consentAt) {
      await client.query("ROLLBACK");
      return { ok: false, message: "سجّل موافقة المريض قبل جدولة الأقساط." };
    }

    const { rows: existing } = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM plan_installments WHERE plan_id = $1`, [input.planId],
    );
    if (Number(existing[0].count) > 0) {
      await client.query("ROLLBACK");
      return { ok: false, message: "للخطة جدول أقساط سلفًا." };
    }

    const { rows: totals } = await client.query<{ total_minor: string }>(
      `SELECT total_minor FROM treatment_plans WHERE id = $1`, [input.planId],
    );
    const totalMinor = toMinor(totals[0].total_minor);
    if (totalMinor <= 0) {
      await client.query("ROLLBACK");
      return { ok: false, message: "لا يمكن جدولة أقساط لخطة بلا مبلغ." };
    }

    const parts = splitInstallments(totalMinor, input.count, input.firstDueDate, input.everyDays);
    for (const part of parts) {
      await client.query(
        `INSERT INTO plan_installments (plan_id, number, due_date, amount_minor)
         VALUES ($1, $2, $3::date, $4)`,
        [input.planId, part.number, part.dueDate, part.amountMinor],
      );
    }
    await client.query("COMMIT");
    return { ok: true, count: parts.length };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * يسجّل قسطًا: فاتورة بقيمته ودفعة عليها، في معاملة واحدة داخل الوردية المفتوحة.
 *
 * **الإيراد يُثبت مع القسط لا مع الاتفاق.** فوترةُ الخطة كاملة يوم توقيعها تجعل
 * المريض «مدينًا بمليون» من أول يوم وتُثبت إيرادًا لعلاج لم يُقدَّم بعد — وهو مخالف
 * لمعيار إثبات الإيراد على مدى تقديم الخدمة. فكل قسط فاتورته يوم يُقبض.
 *
 * والاثنان في معاملة واحدة: فاتورةٌ بلا دفعتها تجعل المريض مدينًا بمبلغ دفعه للتو،
 * ودفعةٌ بلا فاتورتها تجعل له رصيدًا عندنا بلا سبب.
 */
export async function recordPlanInstallment(input: {
  planId: number;
  patientId: number;
  installmentNumber: number;
  planTitle: string;
  amountMinor: number;
  currency: Currency;
  baseCurrency: Currency;
  exchangeRate: number;
  method: string;
  note: string | null;
  createdBy: string;
}): Promise<{ invoiceId: number; paymentId: number } | { reason: "no_shift" }> {
  await ensureSchema();
  const baseAmount = toBaseAmount(
    input.amountMinor, input.currency, input.baseCurrency, input.exchangeRate,
  );

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const { rows: shifts } = await client.query<{ id: number }>(
      `SELECT id FROM cashier_shifts WHERE status = 'open' LIMIT 1 FOR UPDATE`,
    );
    if (!shifts[0]) { await client.query("ROLLBACK"); return { reason: "no_shift" }; }

    const description = `${input.planTitle} — قسط ${input.installmentNumber}`;
    const { rows: invoices } = await client.query<{ id: number }>(
      `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, note, created_by, plan_id)
       VALUES (
         'INV-' || LPAD(nextval('invoice_number_seq')::text, 5, '0'),
         $1, $2, 0, $3, $4::text, $5, $6)
       RETURNING id`,
      [input.patientId, baseAmount, input.baseCurrency, input.note, input.createdBy, input.planId],
    );
    const invoiceId = invoices[0].id;

    await client.query(
      `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price_minor, total_minor)
       VALUES ($1, $2, 1, $3, $3)`,
      [invoiceId, description, baseAmount],
    );

    const { rows: payments } = await client.query<{ id: number }>(
      `INSERT INTO payments (
         receipt_number, patient_id, invoice_id, shift_id, kind, amount_minor, currency,
         exchange_rate, base_amount_minor, base_currency, method, note, created_by, plan_id)
       VALUES (
         'R-' || LPAD(nextval('receipt_number_seq')::text, 5, '0'),
         $1, $2, $3, 'payment', $4, $5, $6, $7, $8, $9, $10::text, $11, $12)
       RETURNING id`,
      [
        input.patientId, invoiceId, shifts[0].id, input.amountMinor, input.currency,
        input.exchangeRate, baseAmount, input.baseCurrency, input.method, input.note,
        input.createdBy, input.planId,
      ],
    );

    await client.query(
      `UPDATE invoices SET status = 'paid' WHERE id = $1`, [invoiceId],
    );

    await client.query("COMMIT");
    return { invoiceId, paymentId: payments[0].id };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// ─── الأشعة والمستندات ───────────────────────────────────────────────────────

import { type DocumentKind } from "./storage";

/**
 * وصفُ ملفٍّ في سجل المريض — والملفّ نفسه على القرص لا هنا.
 */
export interface PatientDocument {
  id: number;
  patientId: number;
  visitId: number | null;
  kind: DocumentKind;
  title: string;
  mimeType: string;
  sizeBytes: number;
  isImage: boolean;
  note: string | null;
  takenOn: string | null;
  uploadedBy: string;
  uploadedAt: string;
  removedAt: string | null;
  removedBy: string | null;
  removedNote: string | null;
}

interface DocumentRow {
  id: number; patient_id: number; visit_id: number | null; kind: string; title: string;
  mime_type: string; size_bytes: string; note: string | null; taken_on: Date | null;
  uploaded_by: string; uploaded_at: Date; removed_at: Date | null;
  removed_by: string | null; removed_note: string | null;
}

const toDocument = (row: DocumentRow): PatientDocument => ({
  id: row.id,
  patientId: row.patient_id,
  visitId: row.visit_id,
  kind: row.kind as DocumentKind,
  title: row.title,
  mimeType: row.mime_type,
  sizeBytes: toMinor(row.size_bytes),
  isImage: row.mime_type.startsWith("image/"),
  note: row.note,
  takenOn: row.taken_on ? dateText(row.taken_on) : null,
  uploadedBy: row.uploaded_by,
  uploadedAt: row.uploaded_at.toISOString(),
  removedAt: row.removed_at ? row.removed_at.toISOString() : null,
  removedBy: row.removed_by,
  removedNote: row.removed_note,
});

const DOCUMENT_COLUMNS = `id, patient_id, visit_id, kind, title, mime_type, size_bytes,
       note, taken_on, uploaded_by, uploaded_at, removed_at, removed_by, removed_note`;

/**
 * ملفّات المريض.
 *
 * المخفيّة تُعرض للمدير وحده ومعلَّمةً بذلك: إخفاءُ صورةٍ قرارٌ يُراجَع، وإخفاؤها
 * عن المراجِع نفسه يجعل الإخفاء محوًا.
 */
export async function listPatientDocuments(
  patientId: number,
  includeRemoved = false,
): Promise<PatientDocument[]> {
  await ensureSchema();
  const { rows } = await getPool().query<DocumentRow>(
    `SELECT ${DOCUMENT_COLUMNS} FROM patient_documents
      WHERE patient_id = $1 ${includeRemoved ? "" : "AND removed_at IS NULL"}
      ORDER BY COALESCE(taken_on, uploaded_at::date) DESC, id DESC`,
    [patientId],
  );
  return rows.map(toDocument);
}

/** الوصف مع مفتاح التخزين — للتنزيل وحده، ولا يخرج المفتاح إلى المتصفّح أبدًا. */
export async function getDocumentForDownload(id: number): Promise<
  { document: PatientDocument; storageKey: string } | null
> {
  await ensureSchema();
  const { rows } = await getPool().query<DocumentRow & { storage_key: string }>(
    `SELECT ${DOCUMENT_COLUMNS}, storage_key FROM patient_documents WHERE id = $1`,
    [id],
  );
  if (!rows[0]) return null;
  return { document: toDocument(rows[0]), storageKey: rows[0].storage_key };
}

export async function recordDocument(input: {
  patientId: number;
  visitId: number | null;
  kind: DocumentKind;
  title: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  storageKey: string;
  note: string | null;
  takenOn: string | null;
  uploadedBy: string;
}): Promise<PatientDocument> {
  await ensureSchema();
  const { rows } = await getPool().query<DocumentRow>(
    `INSERT INTO patient_documents
       (patient_id, visit_id, kind, title, mime_type, size_bytes, sha256, storage_key,
        note, taken_on, uploaded_by)
     VALUES ($1, $2::int, $3, $4, $5, $6, $7, $8, $9::text, $10::date, $11)
     RETURNING ${DOCUMENT_COLUMNS}`,
    [
      input.patientId, input.visitId, input.kind, input.title.trim(), input.mimeType,
      input.sizeBytes, input.sha256, input.storageKey,
      input.note?.trim() || null, input.takenOn, input.uploadedBy,
    ],
  );
  return toDocument(rows[0]);
}

/**
 * إخفاء مستند — لا محوه.
 *
 * السجل الطبي شهادة، ومن يمحو بصمت يمكن أن يمحو بعد شكوى. فيبقى الصف ويبقى
 * الملف، ويُسجَّل من أخفاه ومتى **ولماذا** — والسبب إلزامي: «أُخفي بلا سبب» ليس
 * تفسيرًا يُقرأ بعد سنة.
 */
export async function removeDocument(input: {
  id: number; actor: string; note: string;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  await ensureSchema();
  const reason = input.note.trim();
  if (reason.length < 3) return { ok: false, message: "اكتب سبب الإخفاء." };
  const { rowCount } = await getPool().query(
    `UPDATE patient_documents SET removed_at = NOW(), removed_by = $2, removed_note = $3
      WHERE id = $1 AND removed_at IS NULL`,
    [input.id, input.actor, reason],
  );
  if ((rowCount ?? 0) === 0) return { ok: false, message: "المستند غير موجود أو مخفيٌّ سلفًا." };
  return { ok: true };
}

/** كل المستندات القائمة مع ما يكفي لتسميتها في الأرشيف بلا البرنامج. */
export async function documentsForArchive(): Promise<{
  id: number; patientNumber: string; patientName: string; kind: string;
  title: string; takenOn: string | null; uploadedAt: Date; storageKey: string;
}[]> {
  await ensureSchema();
  const { rows } = await getPool().query<{
    id: number; patient_number: string; full_name: string; kind: string;
    title: string; taken_on: Date | null; uploaded_at: Date; storage_key: string;
  }>(
    `SELECT d.id, p.patient_number, p.full_name, d.kind, d.title, d.taken_on,
            d.uploaded_at, d.storage_key
       FROM patient_documents d JOIN patients p ON p.id = d.patient_id
      WHERE d.removed_at IS NULL
      ORDER BY p.patient_number, d.id`,
  );
  return rows.map((row) => ({
    id: row.id,
    patientNumber: row.patient_number,
    patientName: row.full_name,
    kind: row.kind,
    title: row.title,
    takenOn: row.taken_on ? dateText(row.taken_on) : null,
    uploadedAt: row.uploaded_at,
    storageKey: row.storage_key,
  }));
}

// ─── التقويم ─────────────────────────────────────────────────────────────────

import {
  canComplete, caseProgress, nextWire,
  type Appliance, type Arches, type CaseProgress, type CaseStatus,
  type ElasticClass, type OrthoPhase, type RetainerType, type SlotSize,
} from "./ortho";

export interface OrthoCase {
  id: number;
  patientId: number;
  patientName: string;
  appliance: Appliance;
  arches: Arches;
  slot: SlotSize;
  bracketSystem: string | null;
  status: CaseStatus;
  phase: OrthoPhase;
  startDate: string;
  plannedMonths: number;
  upperWire: string | null;
  lowerWire: string | null;
  planId: number | null;
  retainer: RetainerType | null;
  retainerOn: string | null;
  note: string | null;
  closedAt: string | null;
  closedBy: string | null;
  closedNote: string | null;
  adjustments: OrthoAdjustment[];
  progress: CaseProgress;
}

export interface OrthoAdjustment {
  id: number;
  visitId: number | null;
  doneOn: string;
  phase: OrthoPhase | null;
  upperWire: string | null;
  lowerWire: string | null;
  elastics: ElasticClass;
  elasticNote: string | null;
  done: string | null;
  nextWeeks: number;
  note: string | null;
  recordedBy: string;
}

interface CaseRow {
  id: number; patient_id: number; full_name: string; appliance: string; arches: string;
  slot: string; bracket_system: string | null; status: string; phase: string;
  start_date: Date; planned_months: number; upper_wire: string | null;
  lower_wire: string | null; plan_id: number | null; retainer: string | null;
  retainer_on: Date | null; note: string | null; closed_at: Date | null;
  closed_by: string | null; closed_note: string | null;
}

interface AdjustmentRow {
  id: number; case_id: number; visit_id: number | null; done_on: Date; phase: string | null;
  upper_wire: string | null; lower_wire: string | null; elastics: string;
  elastic_note: string | null; done: string | null; next_weeks: number;
  note: string | null; recorded_by: string;
}

const CASE_SELECT = `
  SELECT c.id, c.patient_id, p.full_name, c.appliance, c.arches, c.slot, c.bracket_system,
         c.status, c.phase, c.start_date, c.planned_months, c.upper_wire, c.lower_wire,
         c.plan_id, c.retainer, c.retainer_on, c.note, c.closed_at, c.closed_by, c.closed_note
    FROM ortho_cases c JOIN patients p ON p.id = c.patient_id`;

const toAdjustment = (row: AdjustmentRow): OrthoAdjustment => ({
  id: row.id,
  visitId: row.visit_id,
  doneOn: dateText(row.done_on),
  phase: (row.phase as OrthoPhase) ?? null,
  upperWire: row.upper_wire,
  lowerWire: row.lower_wire,
  elastics: row.elastics as ElasticClass,
  elasticNote: row.elastic_note,
  done: row.done,
  nextWeeks: row.next_weeks,
  note: row.note,
  recordedBy: row.recorded_by,
});

async function hydrateCases(rows: CaseRow[], today: string): Promise<OrthoCase[]> {
  if (rows.length === 0) return [];
  const { rows: adjustmentRows } = await getPool().query<AdjustmentRow>(
    `SELECT id, case_id, visit_id, done_on, phase, upper_wire, lower_wire, elastics,
            elastic_note, done, next_weeks, note, recorded_by
       FROM ortho_adjustments WHERE case_id = ANY($1::int[])
      ORDER BY case_id, done_on DESC, id DESC`,
    [rows.map((row) => row.id)],
  );
  const byCase = new Map<number, OrthoAdjustment[]>();
  for (const row of adjustmentRows) {
    const list = byCase.get(row.case_id) ?? [];
    list.push(toAdjustment(row));
    byCase.set(row.case_id, list);
  }

  return rows.map((row) => {
    const adjustments = byCase.get(row.id) ?? [];
    return {
      id: row.id,
      patientId: row.patient_id,
      patientName: row.full_name,
      appliance: row.appliance as Appliance,
      arches: row.arches as Arches,
      slot: row.slot as SlotSize,
      bracketSystem: row.bracket_system,
      status: row.status as CaseStatus,
      phase: row.phase as OrthoPhase,
      startDate: dateText(row.start_date),
      plannedMonths: row.planned_months,
      upperWire: row.upper_wire,
      lowerWire: row.lower_wire,
      planId: row.plan_id,
      retainer: (row.retainer as RetainerType) ?? null,
      retainerOn: row.retainer_on ? dateText(row.retainer_on) : null,
      note: row.note,
      closedAt: row.closed_at ? row.closed_at.toISOString() : null,
      closedBy: row.closed_by,
      closedNote: row.closed_note,
      adjustments,
      progress: caseProgress({
        startDate: dateText(row.start_date),
        plannedMonths: row.planned_months,
        adjustments: adjustments.length,
        lastAdjustmentDate: adjustments[0]?.doneOn ?? null,
        today,
      }),
    };
  });
}

export async function listPatientOrthoCases(patientId: number, today: string): Promise<OrthoCase[]> {
  await ensureSchema();
  const { rows } = await getPool().query<CaseRow>(
    `${CASE_SELECT} WHERE c.patient_id = $1 ORDER BY c.created_at DESC`, [patientId],
  );
  return hydrateCases(rows, today);
}

export async function getOrthoCase(id: number, today: string): Promise<OrthoCase | null> {
  await ensureSchema();
  const { rows } = await getPool().query<CaseRow>(`${CASE_SELECT} WHERE c.id = $1`, [id]);
  return (await hydrateCases(rows, today))[0] ?? null;
}

/** الحالة المفتوحة لمريض — لشاشة الزيارة، فيرى الطبيب السلك قبل أن يبدأ. */
export async function openOrthoCaseFor(patientId: number, today: string): Promise<OrthoCase | null> {
  await ensureSchema();
  const { rows } = await getPool().query<CaseRow>(
    `${CASE_SELECT} WHERE c.patient_id = $1 AND c.status IN ('active','retention')
      ORDER BY c.created_at DESC LIMIT 1`,
    [patientId],
  );
  return (await hydrateCases(rows, today))[0] ?? null;
}

export async function listOrthoCases(today: string, status?: CaseStatus): Promise<OrthoCase[]> {
  await ensureSchema();
  const { rows } = await getPool().query<CaseRow>(
    status
      ? `${CASE_SELECT} WHERE c.status = $1 ORDER BY c.start_date DESC LIMIT 300`
      : `${CASE_SELECT} WHERE c.status IN ('active','retention') ORDER BY c.start_date DESC LIMIT 300`,
    status ? [status] : [],
  );
  return hydrateCases(rows, today);
}

export async function createOrthoCase(input: {
  patientId: number;
  appliance: Appliance;
  arches: Arches;
  slot: SlotSize;
  bracketSystem: string | null;
  startDate: string;
  plannedMonths: number;
  planId: number | null;
  note: string | null;
  createdBy: string;
}): Promise<{ ok: true; id: number } | { ok: false; message: string }> {
  await ensureSchema();
  try {
    const { rows } = await getPool().query<{ id: number }>(
      `INSERT INTO ortho_cases
         (patient_id, appliance, arches, slot, bracket_system, start_date,
          planned_months, plan_id, note, created_by)
       VALUES ($1, $2, $3, $4, $5::text, $6::date, $7, $8::int, $9::text, $10)
       RETURNING id`,
      [
        input.patientId, input.appliance, input.arches, input.slot,
        input.bracketSystem?.trim() || null, input.startDate,
        Math.max(1, Math.min(120, Math.round(input.plannedMonths))),
        input.planId, input.note?.trim() || null, input.createdBy,
      ],
    );
    return { ok: true, id: rows[0].id };
  } catch (error) {
    // الفهرس الفريد يمنع حالتين مفتوحتين — والرسالة تقول السبب لا رقم الخطأ.
    if ((error as { code?: string }).code === "23505") {
      return { ok: false, message: "للمريض حالة تقويم مفتوحة سلفًا. أغلقها قبل فتح حالة جديدة." };
    }
    throw error;
  }
}

/**
 * يسجّل شدّةً، ويحدّث سلك الحالة في المعاملة نفسها.
 *
 * السلك الحالي يُقرأ من صفّ الحالة لا يُحسب من السجل — فيُعرض على شاشة الزيارة بلا
 * استعلامٍ ثانٍ. وثمن ذلك أن يبقى الاثنان متّفقين، ولذلك يُكتبان معًا: شدّةٌ تُسجَّل
 * بلا تحديث السلك تجعل الشاشة تقول سلكًا والسجل يقول آخر.
 */
export async function recordAdjustment(input: {
  caseId: number;
  visitId: number | null;
  doneOn: string;
  phase: OrthoPhase | null;
  upperWire: string | null;
  lowerWire: string | null;
  elastics: ElasticClass;
  elasticNote: string | null;
  done: string | null;
  nextWeeks: number;
  note: string | null;
  recordedBy: string;
}): Promise<{ ok: true; id: number } | { ok: false; message: string }> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows: cases } = await client.query<{ status: string; upper_wire: string | null; lower_wire: string | null }>(
      `SELECT status, upper_wire, lower_wire FROM ortho_cases WHERE id = $1 FOR UPDATE`,
      [input.caseId],
    );
    if (!cases[0]) { await client.query("ROLLBACK"); return { ok: false, message: "الحالة غير موجودة." }; }
    if (cases[0].status === "completed" || cases[0].status === "discontinued") {
      await client.query("ROLLBACK");
      return { ok: false, message: "الحالة مغلقة — لا تُسجَّل عليها شدّات." };
    }

    // سلكٌ لم يُغيَّر يبقى كما هو: الطبيب يترك الحقل فارغًا حين لا يبدّل السلك،
    // وتفسيرُ الفراغ «أُزيل السلك» يمحو الحقيقة بصمت.
    const upper = input.upperWire?.trim() || cases[0].upper_wire;
    const lower = input.lowerWire?.trim() || cases[0].lower_wire;

    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO ortho_adjustments
         (case_id, visit_id, done_on, phase, upper_wire, lower_wire, elastics,
          elastic_note, done, next_weeks, note, recorded_by)
       VALUES ($1, $2::int, $3::date, $4::text, $5::text, $6::text, $7, $8::text,
               $9::text, $10, $11::text, $12)
       RETURNING id`,
      [
        input.caseId, input.visitId, input.doneOn, input.phase, upper, lower,
        input.elastics, input.elasticNote?.trim() || null, input.done?.trim() || null,
        Math.max(1, Math.min(52, Math.round(input.nextWeeks))),
        input.note?.trim() || null, input.recordedBy,
      ],
    );

    await client.query(
      `UPDATE ortho_cases SET upper_wire = $2::text, lower_wire = $3::text,
              phase = COALESCE($4::text, phase)
        WHERE id = $1`,
      [input.caseId, upper, lower, input.phase],
    );
    await client.query("COMMIT");
    return { ok: true, id: rows[0].id };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function setOrthoPhase(id: number, phase: OrthoPhase): Promise<boolean> {
  await ensureSchema();
  const { rowCount } = await getPool().query(
    `UPDATE ortho_cases SET phase = $2 WHERE id = $1 AND status IN ('active','retention')`,
    [id, phase],
  );
  return (rowCount ?? 0) > 0;
}

/** يسجّل المثبّت — وهو شرط إغلاق الحالة. */
export async function setRetainer(input: {
  id: number; retainer: RetainerType; deliveredOn: string | null;
}): Promise<boolean> {
  await ensureSchema();
  const { rowCount } = await getPool().query(
    `UPDATE ortho_cases SET retainer = $2, retainer_on = $3::date,
            status = CASE WHEN status = 'active' THEN 'retention' ELSE status END
      WHERE id = $1 AND status IN ('active','retention')`,
    [input.id, input.retainer, input.deliveredOn],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * يُغلق الحالة.
 *
 * ويشترط المثبّت: حالةٌ تُغلق بلا مثبّت هي أكثر ما يُفسد نتيجة سنتين — الأسنان
 * ترتدّ، ويعود المريض بعد عامٍ فيجد النتيجة ضاعت فيلوم المركز بحق.
 */
export async function closeOrthoCase(input: {
  id: number; status: "completed" | "discontinued"; actor: string; note: string | null;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ status: string; retainer: string | null }>(
      `SELECT status, retainer FROM ortho_cases WHERE id = $1 FOR UPDATE`, [input.id],
    );
    if (!rows[0]) { await client.query("ROLLBACK"); return { ok: false, message: "الحالة غير موجودة." }; }

    // التوقّف غير الإكمال: مريضٌ سافر أو انقطع تُغلق حالته بلا مثبّت — والشرط
    // على الإكمال وحده، لأنه الادّعاء بأن العلاج انتهى كما يجب.
    if (input.status === "completed") {
      const guard = canComplete({
        status: rows[0].status as CaseStatus,
        retainer: (rows[0].retainer as RetainerType) ?? null,
      });
      if (!guard.ok) { await client.query("ROLLBACK"); return guard; }
    } else if (rows[0].status === "completed" || rows[0].status === "discontinued") {
      await client.query("ROLLBACK");
      return { ok: false, message: "الحالة مغلقة سلفًا." };
    }

    await client.query(
      `UPDATE ortho_cases SET status = $2, closed_at = NOW(), closed_by = $3, closed_note = $4::text
        WHERE id = $1`,
      [input.id, input.status, input.actor, input.note?.trim() || null],
    );
    await client.query("COMMIT");
    return { ok: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/* ═══════════════════════════════ السيفالومتري ═══════════════════════════════
 *
 * التحليل السيفالومتري دراسةٌ على شععة موجودة في المستندات — لا نسخةً منها. ودورة
 * حياته: مسودة تُوضَع فيها المعالم وتُعايَر الشععة، ثم اعتمادٌ يختم القياسات لقطةً
 * واحدة ويقفل التحليل. والتصحيح بعده لا يلمس المعتمد: يُفتَح عنه نسخة جديدة.
 *
 * والاعتماد عملُ الطبيب وحده — هنا لا زرَّ «اقتراح» يُنفِّذ شيئًا. والقياسات تُحسَب
 * من دوالّ `lib/ceph.ts` الخالصة نفسها التي تُظهرها الشاشة حيًّا، فلا يُعتمَد
 * رقمٌ على الشاشة ويُختم في القاعدة غيره.
 */

export type CephPhase = "pretreatment" | "during" | "posttreatment" | "followup";

export const CEPH_PHASES: { value: CephPhase; label: string }[] = [
  { value: "pretreatment", label: "قبل العلاج" },
  { value: "during", label: "أثناء العلاج" },
  { value: "posttreatment", label: "بعد العلاج" },
  { value: "followup", label: "متابعة" },
];

export interface CephAnalysisRow {
  id: number;
  patientId: number;
  documentId: number;
  status: "draft" | "completed" | "discarded";
  orthoCaseId: number | null;
  phase: CephPhase;
  xrayDate: string | null;
  device: string | null;
  refSet: string;
  calibration: { x1: number; y1: number; x2: number; y2: number; mm: number } | null;
  mmPerPixel: number | null;
  note: string | null;
  createdBy: string;
  createdAt: string;
  completedBy: string | null;
  completedAt: string | null;
  /** أهم نتائج اللقطة للمعتمد — تُقرأ من ceph_measurements لا حسابًا. */
  findings: { anb: number | null; fma: number | null; wits: number | null } | null;
}

interface CephAnalysisDbRow {
  id: number;
  patient_id: number;
  document_id: number;
  status: string;
  ortho_case_id: number | null;
  phase: string | null;
  xray_date: Date | string | null;
  device: string | null;
  ref_set: string | null;
  cal_x1: number | null; cal_y1: number | null;
  cal_x2: number | null; cal_y2: number | null;
  cal_mm: number | null;
  mm_per_pixel: number | null;
  note: string | null;
  created_by: string;
  created_at: Date;
  completed_by: string | null;
  completed_at: Date | null;
}

const asDateString = (v: Date | string | null): string | null => {
  if (v == null) return null;
  return (typeof v === "string" ? v : v.toISOString()).slice(0, 10);
};

function mapCephAnalysis(row: CephAnalysisDbRow): CephAnalysisRow {
  const calibrated = row.cal_x1 != null && row.cal_y1 != null && row.cal_x2 != null
    && row.cal_y2 != null && row.cal_mm != null;
  return {
    id: row.id,
    patientId: row.patient_id,
    documentId: row.document_id,
    status: row.status as CephAnalysisRow["status"],
    orthoCaseId: row.ortho_case_id,
    phase: (row.phase ?? "pretreatment") as CephPhase,
    xrayDate: asDateString(row.xray_date),
    device: row.device,
    refSet: row.ref_set ?? "builtin_default",
    calibration: calibrated ? {
      x1: row.cal_x1 as number, y1: row.cal_y1 as number,
      x2: row.cal_x2 as number, y2: row.cal_y2 as number,
      mm: row.cal_mm as number,
    } : null,
    mmPerPixel: row.mm_per_pixel,
    note: row.note,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    completedBy: row.completed_by,
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
    findings: null,
  };
}

/** يفتح مسودة تحليل على شععة موجودة للمريض نفسه — الصورة مرجعٌ لا نسخة. */
export async function createCephAnalysis(input: {
  patientId: number;
  documentId: number;
  createdBy: string;
  orthoCaseId?: number | null;
  phase?: CephPhase;
  xrayDate?: string | null;
  device?: string | null;
  refSet?: string | null;
}): Promise<{ ok: true; id: number } | { ok: false; message: string }> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // الشععة تُنتمي للمريض نفسه: تحليلٌ على شععة غيره يضع قياسات مريضٍ في ملف آخر.
    const { rows: docs } = await client.query<{ id: number; mime_type: string; removed_at: Date | null }>(
      `SELECT id, mime_type, removed_at FROM patient_documents WHERE id = $1 AND patient_id = $2`,
      [input.documentId, input.patientId],
    );
    const doc = docs[0];
    if (!doc) {
      await client.query("ROLLBACK");
      return { ok: false, message: "المستند غير موجود لهذا المريض." };
    }
    if (doc.removed_at) {
      await client.query("ROLLBACK");
      return { ok: false, message: "المستند مخفيّ — أظهره أولًا أو اختر شععة أخرى." };
    }
    if (!doc.mime_type.startsWith("image/")) {
      await client.query("ROLLBACK");
      return { ok: false, message: "التحليل السيفالومتري على صورة — اختر شععة أو صورة من المستندات." };
    }
    // حالة التقويم المرتبطة إن ذُكرت — لا يصل دراسةٌ لحالة تقويم مريضٍ آخر.
    if (input.orthoCaseId != null) {
      const { rows: cases } = await client.query<{ id: number }>(
        `SELECT id FROM ortho_cases WHERE id = $1 AND patient_id = $2`,
        [input.orthoCaseId, input.patientId],
      );
      if (!cases[0]) {
        await client.query("ROLLBACK");
        return { ok: false, message: "حالة التقويم غير موجودة لهذا المريض." };
      }
    }
    try {
      const { rows } = await client.query<{ id: number }>(
        `INSERT INTO ceph_analyses
           (patient_id, document_id, created_by, ortho_case_id, phase, xray_date, device, ref_set)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          input.patientId, input.documentId, input.createdBy,
          input.orthoCaseId ?? null,
          input.phase ?? "pretreatment",
          input.xrayDate ?? null,
          input.device?.trim() || null,
          input.refSet?.trim() || "builtin_default",
        ],
      );
      await client.query("COMMIT");
      await recordAudit({
        action: "ceph.create", entity: "ceph_analysis", entityId: String(rows[0].id),
        entityLabel: `على المستند #${input.documentId} — مرحلة ${input.phase ?? "pretreatment"}`,
        actor: input.createdBy,
      });
      return { ok: true, id: rows[0].id };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      // مسودة واحدة لكل مريض: فتحَ ثانية يعني وضعين لنفس المعالم بأيدي مختلفة.
      if ((error as { code?: string }).code === "23505") {
        return { ok: false, message: "للمريض مسودة تحليل مفتوحة — أكملها أو أرفضها قبل فتح أخرى." };
      }
      throw error;
    }
  } finally {
    client.release();
  }
}

/** تحليلات المريض بترتيبها — الأحدث أولًا، والمسودة أولى من ذلك، ومعتمدها بأهم نتائجه. */
export async function listPatientCephAnalyses(patientId: number): Promise<CephAnalysisRow[]> {
  await ensureSchema();
  const { rows } = await getPool().query<CephAnalysisDbRow>(
    `SELECT * FROM ceph_analyses
     WHERE patient_id = $1 AND status <> 'discarded'
     ORDER BY (status = 'draft') DESC, created_at DESC`,
    [patientId],
  );
  const analyses = rows.map(mapCephAnalysis);
  const stampedIds = analyses.filter((a) => a.status === "completed").map((a) => a.id);
  if (stampedIds.length > 0) {
    // لقطةٌ لا حساب: ANB وFMA وWITS كما خُتمت يوم الاعتماد.
    const { rows: ms } = await getPool().query<{ analysis_id: number; code: string; value: number }>(
      `SELECT analysis_id, code, value FROM ceph_measurements
       WHERE analysis_id = ANY($1) AND code IN ('ANB','FMA','WITS')`,
      [stampedIds],
    );
    for (const a of analyses) {
      if (a.status !== "completed") continue;
      const own = ms.filter((m) => m.analysis_id === a.id);
      if (own.length === 0) continue;
      const pick = (code: string) => own.find((m) => m.code === code)?.value ?? null;
      a.findings = { anb: pick("ANB"), fma: pick("FMA"), wits: pick("WITS") };
    }
  }
  return analyses;
}

export interface CephLandmarkRow {
  code: LandmarkCode;
  x: number;
  y: number;
  source: "manual" | "suggested";
  confirmedBy: string;
}

export interface CephDiagnosisRow {
  skeletal: string | null;
  dental: string | null;
  softTissue: string | null;
  note: string | null;
  finalDx: string;
  createdBy: string;
  updatedAt: string;
}

/** التحليل ومعالمه ولقطته وتشخيصه — قراءة الشاشة والمسار معًا من المكان نفسه. */
export async function getCephStudy(id: number): Promise<{
  analysis: CephAnalysisRow;
  landmarks: CephLandmarkRow[];
  measurements: { code: string; value: number }[];
  diagnosis: CephDiagnosisRow | null;
} | null> {
  await ensureSchema();
  const { rows } = await getPool().query<CephAnalysisDbRow>(
    `SELECT * FROM ceph_analyses WHERE id = $1 AND status <> 'discarded'`, [id],
  );
  if (!rows[0]) return null;
  const analysis = mapCephAnalysis(rows[0]);

  const { rows: lm } = await getPool().query<{
    code: string; x: number; y: number; source: string; confirmed_by: string;
  }>(
    `SELECT code, x, y, source, confirmed_by FROM ceph_landmarks
     WHERE analysis_id = $1 ORDER BY confirmed_at`,
    [id],
  );
  const landmarks: CephLandmarkRow[] = lm
    .filter((r) => isCephLandmarkCode(r.code))
    .map((r) => ({
      code: r.code as LandmarkCode,
      x: r.x, y: r.y,
      source: r.source as "manual" | "suggested",
      confirmedBy: r.confirmed_by,
    }));

  const { rows: ms } = await getPool().query<{ code: string; value: number }>(
    `SELECT code, value FROM ceph_measurements WHERE analysis_id = $1 ORDER BY id`,
    [id],
  );

  const { rows: dx } = await getPool().query<{
    skeletal: string | null; dental: string | null; soft_tissue: string | null;
    note: string | null; final_dx: string; created_by: string; updated_at: Date;
  }>(
    `SELECT skeletal, dental, soft_tissue, note, final_dx, created_by, updated_at
     FROM ceph_diagnoses WHERE analysis_id = $1`,
    [id],
  );
  const diagnosis: CephDiagnosisRow | null = dx[0] ? {
    skeletal: dx[0].skeletal,
    dental: dx[0].dental,
    softTissue: dx[0].soft_tissue,
    note: dx[0].note,
    finalDx: dx[0].final_dx,
    createdBy: dx[0].created_by,
    updatedAt: dx[0].updated_at.toISOString(),
  } : null;

  return { analysis, landmarks, measurements: ms, diagnosis };
}

export interface CephCalibrationInput {
  x1: number; y1: number; x2: number; y2: number; mm: number;
}

/**
 * يكتب المعايرة (أو يصحّحها) على مسودة، والمقياس يُحسَب هنا لا في المتصفّح.
 *
 * المتصفّح يعرض الأرقام من دوالّ الوحدة نفسها، لكن القيمة المختومة تُحسَب على
 * الخادم من نقطتي المعايرة — فلا يقنَع أحد المقياس في الطلب ويُختم مقياسٌ زوّار.
 */
export async function updateCephCalibration(
  id: number, cal: CephCalibrationInput, by: string,
): Promise<{ ok: true; mmPerPixel: number } | { ok: false; message: string }> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ status: string }>(
      `SELECT status FROM ceph_analyses WHERE id = $1 FOR UPDATE`, [id],
    );
    if (!rows[0]) { await client.query("ROLLBACK"); return { ok: false, message: "التحليل غير موجود." }; }
    if (rows[0].status !== "draft") {
      await client.query("ROLLBACK");
      return { ok: false, message: "التحليل المعتمد لا يُعدَّل — افتح نسخة جديدة عنه." };
    }
    const px = Math.hypot(cal.x2 - cal.x1, cal.y2 - cal.y1);
    if (!Number.isFinite(px) || px <= 0 || !Number.isFinite(cal.mm) || cal.mm <= 0) {
      await client.query("ROLLBACK");
      return { ok: false, message: "نقطتا المعايرة متطابقتان أو المسافة غير صالحة." };
    }
    const scale = cal.mm / px;
    await client.query(
      `UPDATE ceph_analyses
       SET cal_x1=$2, cal_y1=$3, cal_x2=$4, cal_y2=$5, cal_mm=$6, mm_per_pixel=$7
       WHERE id=$1`,
      [id, cal.x1, cal.y1, cal.x2, cal.y2, cal.mm, scale],
    );
    await client.query("COMMIT");
    await recordAudit({
      action: "ceph.update", entity: "ceph_analysis", entityId: String(id),
      entityLabel: `معايرة ${cal.mm} مم على ${px.toFixed(1)} بكسل`,
      actor: by,
    });
    return { ok: true, mmPerPixel: scale };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * يكتب دفعة معالم على مسودة — كتابةٌ فوقية برمز المعلم لا إضافةً متراكمة.
 *
 * المصدر يُسجَّل كما جاء: يدُ الطبيب `manual`، أو اقتراحٌ `suggested` أقرّ به
 * بتأكيده — فالمقترح لا يصير معلمًا إلا بمصادقةٍ تُختم باسمه.
 */
export async function updateCephLandmarks(
  id: number,
  points: { code: LandmarkCode; x: number; y: number; source?: "manual" | "suggested" }[],
  by: string,
): Promise<{ ok: true; count: number } | { ok: false; message: string }> {
  await ensureSchema();
  if (points.length === 0) return { ok: true, count: 0 };
  const clean = points.filter(
    (pt) => isCephLandmarkCode(pt.code)
      && Number.isFinite(pt.x) && Number.isFinite(pt.y),
  );
  if (clean.length === 0) return { ok: false, message: "لا معلم صالح في الطلب." };

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ status: string }>(
      `SELECT status FROM ceph_analyses WHERE id = $1 FOR UPDATE`, [id],
    );
    if (!rows[0]) { await client.query("ROLLBACK"); return { ok: false, message: "التحليل غير موجود." }; }
    if (rows[0].status !== "draft") {
      await client.query("ROLLBACK");
      return { ok: false, message: "التحليل المعتمد لا يُعدَّل — افتح نسخة جديدة عنه." };
    }
    for (const pt of clean) {
      await client.query(
        `INSERT INTO ceph_landmarks (analysis_id, code, x, y, source, confirmed_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (analysis_id, code)
         DO UPDATE SET x = EXCLUDED.x, y = EXCLUDED.y,
            source = EXCLUDED.source, confirmed_by = EXCLUDED.confirmed_by,
            confirmed_at = NOW()`,
        [id, pt.code, pt.x, pt.y, pt.source === "suggested" ? "suggested" : "manual", by],
      );
    }
    await client.query("COMMIT");
    await recordAudit({
      action: "ceph.update", entity: "ceph_analysis", entityId: String(id),
      entityLabel: `كتابة ${clean.length} معلمًا (${clean.map((p) => p.code).join("، ")})`,
      actor: by,
    });
    return { ok: true, count: clean.length };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export interface CephCompleteResult {
  ok: boolean;
  message?: string;
  summary?: string;
  measurements?: { code: string; value: number }[];
}

/**
 * يكتب التشخيص المنظم على مسودة — اقتراحُ النظام يقفز في الحقول والمُحرِّر
 * فوقها بيد الطبيب. المعتمد لا يُكتب عليه: تعديلُه طريقه نسخةٌ جديدة.
 */
export async function updateCephDiagnosis(
  id: number,
  dx: { skeletal?: string | null; dental?: string | null; softTissue?: string | null; note?: string | null; finalDx: string },
  by: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  await ensureSchema();
  const finalDx = dx.finalDx.trim();
  if (!finalDx) return { ok: false, message: "الاستنتاج السيفالومتري لا يُترك فارغًا." };
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ status: string }>(
      `SELECT status FROM ceph_analyses WHERE id = $1 FOR UPDATE`, [id],
    );
    if (!rows[0]) { await client.query("ROLLBACK"); return { ok: false, message: "التحليل غير موجود." }; }
    if (rows[0].status !== "draft") {
      await client.query("ROLLBACK");
      return { ok: false, message: "التحليل المعتمد لا يُعدَّل — افتح نسخة جديدة عنه." };
    }
    const clean = (v: string | null | undefined, cap: number): string | null => {
      const t = v?.trim();
      return t ? t.slice(0, cap) : null;
    };
    await client.query(
      `INSERT INTO ceph_diagnoses
         (analysis_id, skeletal, dental, soft_tissue, note, final_dx, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (analysis_id) DO UPDATE SET
         skeletal = EXCLUDED.skeletal, dental = EXCLUDED.dental,
         soft_tissue = EXCLUDED.soft_tissue, note = EXCLUDED.note,
         final_dx = EXCLUDED.final_dx, updated_at = NOW()`,
      [
        id,
        clean(dx.skeletal, 2000), clean(dx.dental, 2000), clean(dx.softTissue, 2000),
        clean(dx.note, 2000), finalDx.slice(0, 2000), by,
      ],
    );
    await client.query("COMMIT");
    await recordAudit({
      action: "ceph.update", entity: "ceph_analysis", entityId: String(id),
      entityLabel: `تشخيص منظّم: ${finalDx.slice(0, 80)}`,
      actor: by,
    });
    return { ok: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export interface CephReferenceSetRow {
  key: string;
  name: string;
  population: string | null;
  ageMin: number | null;
  ageMax: number | null;
  sex: "male" | "female" | null;
  version: string;
  values: Record<string, { mean: number; sd: number }>;
}

/** المجموعات المرجعية المفعلة بقيمها — تُعرض للدراسة حسب اختيارها. */
export async function listCephReferenceSets(): Promise<CephReferenceSetRow[]> {
  await ensureSchema();
  const { rows: sets } = await getPool().query<{
    id: number; key: string; name: string; population: string | null;
    age_min: number | null; age_max: number | null; sex: string | null; version: string;
  }>(
    `SELECT id, key, name, population, age_min, age_max, sex, version
     FROM ceph_reference_sets WHERE active = TRUE ORDER BY id`,
  );
  if (sets.length === 0) return [];
  const { rows: vals } = await getPool().query<{ set_id: number; code: string; mean: number; sd: number }>(
    `SELECT v.set_id, v.code, v.mean, v.sd FROM ceph_reference_values v
     JOIN ceph_reference_sets s ON s.id = v.set_id WHERE s.active = TRUE`,
  );
  return sets.map((s) => ({
    key: s.key,
    name: s.name,
    population: s.population,
    ageMin: s.age_min,
    ageMax: s.age_max,
    sex: (s.sex as "male" | "female" | null) ?? null,
    version: s.version,
    values: Object.fromEntries(
      vals.filter((v) => v.set_id === s.id).map((v) => [v.code, { mean: v.mean, sd: v.sd }]),
    ),
  }));
}

/** مجموعة واحدة بمفتاحها — للدراسة التي تحمل مفتاحها. */
export async function getCephReferenceSet(key: string): Promise<CephReferenceSetRow | null> {
  const sets = await listCephReferenceSets();
  return sets.find((s) => s.key === key) ?? null;
}

/**
 * اعتماد التحليل: تحقّق، ثم ختم القياسات لقطةً، ثم قفلٌ لا يفتح.
 *
 * التحقّق يمنع الاعتماد بلا معايرة (القياسات الطولية بلا مقياس تخمينٌ لا قياس)
 * وبلا معالم كاملة. والختم يجري في معاملة القفل نفسها: لا فجوةٌ تُقرأ فيها
 * مسودةٌ معتمدة بلا أرقام، ولا أرقامٌ لتحليلٍ ما زال مسودة.
 */
export async function completeCephAnalysis(
  id: number, by: string,
): Promise<CephCompleteResult> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<CephAnalysisDbRow>(
      `SELECT * FROM ceph_analyses WHERE id = $1 FOR UPDATE`, [id],
    );
    const analysis = rows[0];
    if (!analysis) { await client.query("ROLLBACK"); return { ok: false, message: "التحليل غير موجود." }; }
    if (analysis.status === "completed") {
      await client.query("ROLLBACK");
      return { ok: false, message: "التحليل معتمد سلفًا." };
    }
    if (analysis.status !== "draft") {
      await client.query("ROLLBACK");
      return { ok: false, message: "التحليل مرفوض — لا يُعتمد." };
    }
    if (analysis.mm_per_pixel == null) {
      await client.query("ROLLBACK");
      return { ok: false, message: "اعتمد بلا معايرة ممنوع: عاير الشععة أولًا حتى تكون الأطوال بالمليمتر." };
    }

    const { rows: lm } = await client.query<{ code: string; x: number; y: number }>(
      `SELECT code, x, y FROM ceph_landmarks WHERE analysis_id = $1`, [id],
    );
    const map: LandmarkMap = {};
    for (const r of lm) if (isCephLandmarkCode(r.code)) map[r.code as LandmarkCode] = { x: r.x, y: r.y };
    const missing = REQUIRED_LANDMARKS.filter((c) => map[c] == null);
    if (missing.length > 0) {
      await client.query("ROLLBACK");
      return { ok: false, message: `المعالم ناقصة: ${missing.join("، ")}` };
    }

    const results = computeAll(map, analysis.mm_per_pixel);
    const stamped = results.filter((r) => r.value != null) as { code: string; value: number }[];
    for (const r of stamped) {
      await client.query(
        `INSERT INTO ceph_measurements (analysis_id, code, value) VALUES ($1, $2, $3)
         ON CONFLICT (analysis_id, code) DO UPDATE SET value = EXCLUDED.value`,
        [id, r.code, r.value],
      );
    }
    await client.query(
      `UPDATE ceph_analyses SET status='completed', completed_by=$2, completed_at=NOW() WHERE id=$1`,
      [id, by],
    );
    await client.query("COMMIT");

    const summary = summarize(results);
    await recordAudit({
      action: "ceph.complete", entity: "ceph_analysis", entityId: String(id),
      entityLabel: `ANB=${stamped.find((r) => r.code === "ANB")?.value ?? "—"} · FMA=${stamped.find((r) => r.code === "FMA")?.value ?? "—"} · ${summary.skeletal}`,
      actor: by,
    });
    return {
      ok: true,
      measurements: stamped.map((r) => ({ code: r.code, value: r.value })),
      summary: `${summary.skeletal} · ${summary.vertical}`,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** رفض مسودة — بدل حذفٍ صامت: الرفض يُوثَّق باسم رافضه. */
export async function discardCephAnalysis(
  id: number, by: string, note: string | null,
): Promise<{ ok: true } | { ok: false; message: string }> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ status: string }>(
      `SELECT status FROM ceph_analyses WHERE id = $1 FOR UPDATE`, [id],
    );
    if (!rows[0]) { await client.query("ROLLBACK"); return { ok: false, message: "التحليل غير موجود." }; }
    if (rows[0].status !== "draft") {
      await client.query("ROLLBACK");
      return { ok: false, message: "المعتمد لا يُرفض — تاريخُ ما قُرئ لا يُمحى. افتح نسخةً للتصحيح." };
    }
    await client.query(
      `UPDATE ceph_analyses SET status='discarded', note=$2 WHERE id=$1`,
      [id, note?.trim() || null],
    );
    await client.query("COMMIT");
    await recordAudit({
      action: "ceph.discard", entity: "ceph_analysis", entityId: String(id),
      entityLabel: note?.trim() ? note.trim().slice(0, 120) : null,
      actor: by,
    });
    return { ok: true };
  } finally {
    client.release();
  }
}

/**
 * نسخةٌ جديدة عن تحليل معتمد — طريقُ التصحيح الوحيد بعده.
 *
 * المعالم والمعايرة تُنسخ كما هي إلى مسودة جديدة على الشععة نفسها: الطبيب يعدّل
 * ما غيّره لا يبدأ من الصفر، والمعتمد يبقى شهادةً على ما كان.
 */
export async function duplicateCephAnalysis(
  id: number, by: string,
): Promise<{ ok: true; id: number } | { ok: false; message: string }> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<CephAnalysisDbRow>(
      `SELECT * FROM ceph_analyses WHERE id = $1 FOR UPDATE`, [id],
    );
    const source = rows[0];
    if (!source) { await client.query("ROLLBACK"); return { ok: false, message: "التحليل غير موجود." }; }
    if (source.status !== "completed") {
      await client.query("ROLLBACK");
      return { ok: false, message: "النسخ من المعتمد فقط — المسودة تُعدَّل كما هي." };
    }
    // مسودة أخرى قائمة؟ النسخة ستكون مسودة — فيحكمها القيد ذاته.
    const { rows: open } = await client.query<{ n: string }>(
      `SELECT 1 AS n FROM ceph_analyses WHERE patient_id = $1 AND status = 'draft'`,
      [source.patient_id],
    );
    if (open[0]) {
      await client.query("ROLLBACK");
      return { ok: false, message: "للمريض مسودة مفتوحة — أكملها أو أرفضها أولًا." };
    }
    const { rows: created } = await client.query<{ id: number }>(
      `INSERT INTO ceph_analyses
         (patient_id, document_id, status, cal_x1, cal_y1, cal_x2, cal_y2, cal_mm,
          mm_per_pixel, note, created_by)
       VALUES ($1, $2, 'draft', $3, $4, $5, $6, $7, $8,
         $9::text, $10) RETURNING id`,
      [
        source.patient_id, source.document_id,
        source.cal_x1, source.cal_y1, source.cal_x2, source.cal_y2, source.cal_mm,
        source.mm_per_pixel,
        `نسخة تصحيح عن التحليل #${id} (المعتمد ${source.completed_at ? new Date(source.completed_at).toISOString().slice(0, 10) : ""})`,
        by,
      ],
    );
    const newId = created[0].id;
    await client.query(
      `INSERT INTO ceph_landmarks (analysis_id, code, x, y, source, confirmed_by)
       SELECT $2, code, x, y, source, $3 FROM ceph_landmarks WHERE analysis_id = $1`,
      [id, newId, by],
    );
    await client.query("COMMIT");
    await recordAudit({
      action: "ceph.create", entity: "ceph_analysis", entityId: String(newId),
      entityLabel: `نسخة تصحيح عن #${id}`,
      actor: by,
    });
    return { ok: true, id: newId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if ((error as { code?: string }).code === "23505") {
      return { ok: false, message: "للمريض مسودة مفتوحة — أكملها أو أرفضها أولًا." };
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * قياس واحد على تحليل معتمد — يقرأ لقطة القاعدة لا حسابًا حيًّا.
 *
 * للشاشات التي تعرض تحليلًا معتمدًا: ما خُتم هو ما يُعرض. الحيّ يجري من
 * `computeAll` على معالم المسودة، والمعتمد يقرأ من `ceph_measurements`.
 */
export async function getCephStampedValues(
  id: number,
): Promise<{ code: string; value: number }[] | null> {
  await ensureSchema();
  const { rows: a } = await getPool().query<{ status: string }>(
    `SELECT status FROM ceph_analyses WHERE id = $1 AND status <> 'discarded'`, [id],
  );
  if (!a[0]) return null;
  const { rows } = await getPool().query<{ code: string; value: number }>(
    `SELECT code, value FROM ceph_measurements WHERE analysis_id = $1 ORDER BY id`, [id],
  );
  return rows;
}

// ─── المخزون والمستهلكات السنية (المرحلة 9) ──────────────────────────────────
//
// الرصيد هنا ليس عمودًا بل صيغة: مجموع الحركات الموقَّع تُشتقه كل القراءات من
// الحركات نفسها، وتُحسب داخل المعاملة بعد قفل صفّ البند عند الكتابة — فلا يصرف
// آخر علبتين لموظفين ضغطا في اللحظة نفسها. والتسوية بلا سبب مرفوضة في الكود
// والفحص معًا، لأن دستور الوحدة (ZONE_D) يحظر تعديل الرصيد كحقل رقمي.

export interface InventoryItem {
  id: number;
  name: string;
  category: string;
  unit: string;
  minLevel: number;
  note: string | null;
  isActive: boolean;
  createdBy: string;
  createdAt: Date;
  balance: number;
  status: StockStatus;
}

export interface InventoryMovement {
  id: number;
  itemId: number;
  kind: MovementKind;
  qty: number;
  expiryDate: string | null;
  reason: string | null;
  visitId: number | null;
  createdBy: string;
  createdAt: Date;
}

interface InventoryItemRow {
  id: number;
  name: string;
  category: string;
  unit: string;
  min_level: string;
  note: string | null;
  is_active: boolean;
  created_by: string;
  created_at: Date;
  balance?: string;
}

function toItem(row: InventoryItemRow): InventoryItem {
  const balance = Number(row.balance ?? 0);
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    unit: row.unit,
    minLevel: Number(row.min_level),
    note: row.note,
    isActive: row.is_active,
    createdBy: row.created_by,
    createdAt: row.created_at,
    balance,
    status: stockStatus(balance, Number(row.min_level)),
  };
}

interface InventoryMovementRow {
  id: number;
  item_id: number;
  kind: string;
  qty: string;
  expiry_date: Date | string | null;
  reason: string | null;
  visit_id: number | null;
  created_by: string;
  created_at: Date;
}

function toMovement(row: InventoryMovementRow): InventoryMovement {
  return {
    id: row.id,
    itemId: row.item_id,
    kind: row.kind as MovementKind,
    qty: Number(row.qty),
    expiryDate: row.expiry_date
      ? new Date(row.expiry_date).toISOString().slice(0, 10)
      : null,
    reason: row.reason,
    visitId: row.visit_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/** الرصيد المشتق في SQL نفسها — الاشتقاق الرياضي نصًّا لا نسخةُ حالة. */
const INVENTORY_BALANCE_SELECT = `
  COALESCE(SUM(CASE m.kind WHEN 'in' THEN m.qty WHEN 'out' THEN -m.qty ELSE m.qty END), 0)`;

/** كل بنود المخزون بأرصدتها المشتقة وحالتها من حد الطلب. */
export async function listInventoryItems(): Promise<InventoryItem[]> {
  await ensureSchema();
  const { rows } = await getPool().query<InventoryItemRow>(
    `SELECT i.id, i.name, i.category, i.unit, i.min_level, i.note, i.is_active,
            i.created_by, i.created_at, ${INVENTORY_BALANCE_SELECT} AS balance
       FROM inventory_items i
       LEFT JOIN inventory_movements m ON m.item_id = i.id
      GROUP BY i.id
      ORDER BY i.is_active DESC, i.name`,
  );
  return rows.map(toItem);
}

/** بند جديد — بلا رصيد ابتدائي عمدًا: البداية بحركة إدخال موثَّقة لا برقمٍ مفتعل. */
export async function createInventoryItem(input: {
  name: string;
  category: string;
  unit: string;
  minLevel: number;
  note: string | null;
  createdBy: string;
}): Promise<InventoryItem> {
  await ensureSchema();
  const { rows } = await getPool().query<InventoryItemRow>(
    `INSERT INTO inventory_items (name, category, unit, min_level, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING
       id, name, category, unit, min_level, note, is_active, created_by, created_at`,
    [input.name, input.category, input.unit, input.minLevel, input.note, input.createdBy],
  );
  const item = toItem({ ...rows[0], balance: "0" });
  void recordAudit({
    action: "inventory.item", entity: "inventory_item", entityId: item.id,
    entityLabel: item.name,
    details: { العملية: "إنشاء", التصنيف: item.category, الوحدة: item.unit, حد_الطلب: item.minLevel },
    actor: input.createdBy,
  });
  return item;
}

/**
 * تعديل بيانات بند — الاسم والوحدة والحدّ والتصنيف والتفعيل فقط.
 * لا مسارًا هنا ولا في أي مكان يكتب «رصيدًا»: الرصيد حصيلة حركات أو مرفوض الدستور.
 */
export async function updateInventoryItem(
  id: number,
  patch: { name?: string; category?: string; unit?: string; minLevel?: number; note?: string | null; isActive?: boolean },
  actor: string,
): Promise<InventoryItem | null> {
  await ensureSchema();
  const { rows } = await getPool().query<InventoryItemRow>(
    `UPDATE inventory_items SET
       name       = COALESCE($2, name),
       category   = COALESCE($3, category),
       unit       = COALESCE($4, unit),
       min_level  = COALESCE($5, min_level),
       note       = CASE WHEN $6::text IS NULL THEN note ELSE $6 END,
       is_active  = COALESCE($7, is_active)
     WHERE id = $1 RETURNING
       id, name, category, unit, min_level, note, is_active, created_by, created_at`,
    [
      id, patch.name ?? null, patch.category ?? null, patch.unit ?? null,
      patch.minLevel ?? null, patch.note === undefined ? null : patch.note,
      patch.isActive ?? null,
    ],
  );
  if (!rows[0]) return null;
  const item = await inventoryBalanceFor(id, rows[0]);
  void recordAudit({
    action: "inventory.item", entity: "inventory_item", entityId: id,
    entityLabel: item.name,
    details: {
      العملية: "تعديل",
      التغييرات: Object.entries(patch)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}: ${String(v)}`).join("، "),
    },
    actor,
  });
  return item;
}

async function inventoryBalanceFor(id: number, row: InventoryItemRow): Promise<InventoryItem> {
  const { rows } = await getPool().query<{ balance: string }>(
    `SELECT ${INVENTORY_BALANCE_SELECT} AS balance
       FROM inventory_items i LEFT JOIN inventory_movements m ON m.item_id = i.id
      WHERE i.id = $1 GROUP BY i.id`, [id],
  );
  return toItem({ ...row, balance: rows[0]?.balance ?? "0" });
}

/**
 * حركة مخزون — القلب الدستوري للوحدة.
 *
 * قفلُ صفّ البند ثم اشتقاق الرصيد داخل المعاملة ثم الفحص ثم الكتابة: تسلسل
 * واحد ذرّي. الصرف الذي يجاوز الرصيد يُرفض، والتسوية بلا سبب مكتوب تُرفض،
 * وتاريخ الصلاحية لا يُقبل إلا على الإدخال — فالدفعة واقعةُ شراء لا رأي.
 */
export async function createInventoryMovement(input: {
  itemId: number;
  kind: MovementKind;
  qty: number;
  expiryDate?: string | null;
  reason?: string | null;
  visitId?: number | null;
  createdBy: string;
}): Promise<{ ok: true; movement: InventoryMovement; balance: number } | { ok: false; message: string }> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows: items } = await client.query<{ id: number; is_active: boolean; name: string }>(
      `SELECT id, is_active, name FROM inventory_items WHERE id = $1 FOR UPDATE`, [input.itemId],
    );
    if (!items[0]) {
      await client.query("ROLLBACK");
      return { ok: false, message: "بند المخزون غير موجود." };
    }
    if (!items[0].is_active) {
      await client.query("ROLLBACK");
      return { ok: false, message: "البند موقوف — أعد تفعيله قبل أي حركة عليه." };
    }
    const { rows: bal } = await client.query<{ balance: string }>(
      `SELECT ${INVENTORY_BALANCE_SELECT} AS balance
         FROM inventory_items i LEFT JOIN inventory_movements m ON m.item_id = i.id
        WHERE i.id = $1 GROUP BY i.id`, [input.itemId],
    );
    const balance = Number(bal[0]?.balance ?? 0);
    const check = validateMovement(input.kind, input.qty, input.reason ?? null, balance);
    if (!check.ok) {
      await client.query("ROLLBACK");
      return { ok: false, message: check.message ?? "حركة غير مقبولة." };
    }
    const expiry = input.kind === "in" && input.expiryDate ? input.expiryDate : null;
    const { rows: inserted } = await client.query<InventoryMovementRow>(
      `INSERT INTO inventory_movements (item_id, kind, qty, expiry_date, reason, visit_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING
         id, item_id, kind, qty, expiry_date, reason, visit_id, created_by, created_at`,
      [
        input.itemId, input.kind,
        input.kind === "adjust" ? input.qty : Math.abs(input.qty),
        expiry, input.reason ?? null, input.visitId ?? null, input.createdBy,
      ],
    );
    await client.query("COMMIT");
    const movement = toMovement(inserted[0]);
    const balanceAfter = deriveBalance([{ kind: movement.kind, qty: movement.qty }]) + balance;
    void recordAudit({
      action: "inventory.move", entity: "inventory_movement", entityId: movement.id,
      entityLabel: items[0].name,
      details: {
        النوع: movement.kind, الكمية: movement.qty,
        الرصيد_قبل: balance, الرصيد_بعد: balanceAfter,
        ...(movement.kind === "adjust" ? { السبب: movement.reason } : {}),
        ...(expiry ? { الصلاحية: expiry } : {}),
      },
      actor: input.createdBy,
    });
    return { ok: true, movement, balance: balanceAfter };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** سجل حركات بند — الأحدث أولًا، بلا حدٍّ يخفي. */
export async function listInventoryMovements(itemId: number, limit = 200): Promise<InventoryMovement[]> {
  await ensureSchema();
  const { rows } = await getPool().query<InventoryMovementRow>(
    `SELECT id, item_id, kind, qty, expiry_date, reason, visit_id, created_by, created_at
       FROM inventory_movements WHERE item_id = $1 ORDER BY id DESC LIMIT $2`,
    [itemId, limit],
  );
  return rows.map(toMovement);
}

/** بند بأرشيفه: الرصيد المشتق، وسجل الحركات، ودفعات الصلاحية بما بقي فيها (FEFO). */
export async function getInventoryItemDetail(id: number): Promise<{
  item: InventoryItem;
  movements: InventoryMovement[];
  batches: BatchResult;
} | null> {
  await ensureSchema();
  const { rows } = await getPool().query<InventoryItemRow>(
    `SELECT i.id, i.name, i.category, i.unit, i.min_level, i.note, i.is_active,
            i.created_by, i.created_at, ${INVENTORY_BALANCE_SELECT} AS balance
       FROM inventory_items i LEFT JOIN inventory_movements m ON m.item_id = i.id
      WHERE i.id = $1 GROUP BY i.id`, [id],
  );
  if (!rows[0]) return null;
  const movements = await listInventoryMovements(id);
  const batches = batchRemaining(
    [...movements].reverse().map((m) => ({
      id: m.id, kind: m.kind, qty: m.qty,
      expiryDate: m.expiryDate, createdAt: m.createdAt.toISOString(),
    })),
  );
  return { item: toItem(rows[0]), movements, batches };
}

export interface InventoryBatchAlert {
  itemId: number;
  itemName: string;
  batchId: number;
  expiryDate: string;
  remaining: number;
}

export interface InventoryAlerts {
  lowItems: { id: number; name: string; balance: number; minLevel: number; status: StockStatus }[];
  expired: InventoryBatchAlert[];
  soon: InventoryBatchAlert[];
}

/**
 * ما يستحق انتباهًا اليوم: بنود تحت حد الطلب أو منتهية، ودفعات انتهت وما زال
 * فيها بقيّة، ودفعات تقارب انتهاءها خلال ثلاثين يومًا. البقايا تُشتق FEFO على
 * الحركات نفسها — فلا يُنذر النظام عن دفعة استُهلكت أصلًا.
 */
export async function inventoryAlerts(today: string): Promise<InventoryAlerts> {
  await ensureSchema();
  const items = await listInventoryItems();
  const lowItems = items
    .filter((i) => i.isActive && i.status !== "ok")
    .map((i) => ({ id: i.id, name: i.name, balance: i.balance, minLevel: i.minLevel, status: i.status }));

  const withExpiry = await getPool().query<{ item_id: number }>(
    `SELECT DISTINCT item_id FROM inventory_movements
      WHERE kind = 'in' AND expiry_date IS NOT NULL AND expiry_date <= ($1::date + INTERVAL '30 days')`,
    [today],
  );
  const expired: InventoryBatchAlert[] = [];
  const soon: InventoryBatchAlert[] = [];
  for (const { item_id } of withExpiry.rows) {
    const detail = await getInventoryItemDetail(item_id);
    if (!detail || !detail.item.isActive) continue;
    for (const batch of detail.batches.batches) {
      if (!batch.expiryDate || batch.remaining <= 0.001) continue;
      const state = expiryState(batch.expiryDate, today);
      if (state === "expired") {
        expired.push({ itemId: item_id, itemName: detail.item.name, batchId: batch.id, expiryDate: batch.expiryDate, remaining: batch.remaining });
      } else if (state === "soon") {
        soon.push({ itemId: item_id, itemName: detail.item.name, batchId: batch.id, expiryDate: batch.expiryDate, remaining: batch.remaining });
      }
    }
  }
  return { lowItems, expired, soon };
}

// ─── بوابة المريض ────────────────────────────────────────────────────────────

import {
  confirmVerdict,
  portalCredentialsMatch,
  toPortalAppointment,
  type IntakeAnswers,
  type PortalAppointmentView,
} from "./portal";

/**
 * تسجيل دخول مريض إلى البوابة.
 *
 * العاملان: هاتفٌ يطابق هاتف الملف بالمنطق نفسه الذي يُدر به تكرار المرضى
 * (`samePhone`)، ورقم ملفٍ يطابق حرفيًا. المطابقة هنا لا تُنشئ جلسة — الجلسة
 * يوقّع المسار بعد هذا النداء — فالقاعدة تُجيب «من أنت؟» لا «ادخل».
 */
export async function portalLogin(
  phone: string,
  patientNumber: string,
): Promise<{ patient: { id: number; patientNumber: string; fullName: string } } | null> {
  await ensureSchema();
  const { rows } = await getPool().query<{
    id: number; patient_number: string; full_name: string; phone: string | null; alt_phone: string | null;
  }>(
    `SELECT id, patient_number, full_name, phone, alt_phone FROM patients
      WHERE UPPER(TRIM(patient_number)) = UPPER(TRIM($1))
      LIMIT 1`,
    [patientNumber],
  );
  const row = rows[0];
  if (!row) return null;
  const patient = { patientNumber: row.patient_number, phone: row.phone, altPhone: row.alt_phone };
  if (!portalCredentialsMatch(patient, phone, patientNumber)) return null;
  return { patient: { id: row.id, patientNumber: row.patient_number, fullName: row.full_name } };
}

/**
 * محاولات دخول البوابة الخاطئة على هاتفٍ ما خلال نافذة الحد.
 *
 * تُقرأ من سجل التدقيق نفسه — فالرقم لا يُخزَّن مرة ثانية ولا يظهر كاملًا في
 * أي سطر، ويُقاس ببصمة sha256 لآخر تسع خانات فقط. ومع العدد أقدمُ محاولة:
 * من تتجاوز محاولاته الحد لا يُفَك قفلُه إلا بانقضاء النافذة عن أقدمها.
 */
export async function portalLoginFailures(
  phoneHash: string,
  sinceIso: string,
): Promise<{ count: number; oldestIso: string | null }> {
  await ensureSchema();
  const { rows } = await getPool().query<{ c: string; oldest: Date | null }>(
    `SELECT count(*)::text AS c, min(created_at) AS oldest FROM audit_log
      WHERE action = 'portal.login'
        AND details ->> 'ok' = 'false'
        AND details ->> 'phone_hash' = $1
        AND created_at >= $2::timestamptz`,
    [phoneHash, sinceIso],
  );
  return {
    count: Number(rows[0]?.c ?? 0),
    oldestIso: rows[0]?.oldest ? rows[0].oldest.toISOString() : null,
  };
}

/**
 * مواعيد المريض القادمة كما تراها البوابة.
 *
 * الاستعلام نفسه يُقيَّد بـ patient_id — لا معرّف مريض من العميل أصلًا، فلا مجال
 * لمرضى غير. المحلّي بالتوقيت الخاص بالعيادة لا الخادم.
 */
export async function portalUpcomingAppointments(
  patientId: number,
  today: string,
  limit = 10,
): Promise<PortalAppointmentView[]> {
  await ensureSchema();
  const { rows } = await getPool().query<{
    id: number; scheduled_date: Date; scheduled_time: string; duration_minutes: number;
    appointment_type: string | null; note: string | null; status: string;
    patient_confirmed_at: Date | null;
  }>(
    `SELECT id, scheduled_date, scheduled_time, duration_minutes, appointment_type, note,
            status, patient_confirmed_at
       FROM appointments
      WHERE patient_id = $1
        AND scheduled_date >= $2::date
        AND status = 'booked'
      ORDER BY scheduled_date, scheduled_time
      LIMIT $3`,
    [patientId, today, limit],
  );
  return rows.map((row) => toPortalAppointment(
    {
      id: row.id,
      scheduledDate: `${row.scheduled_date.getFullYear()}-${String(row.scheduled_date.getMonth() + 1).padStart(2, "0")}-${String(row.scheduled_date.getDate()).padStart(2, "0")}`,
      scheduledTime: String(row.scheduled_time).slice(0, 5),
      durationMinutes: row.duration_minutes,
      appointmentType: row.appointment_type,
      note: row.note,
      status: row.status,
    },
    row.patient_confirmed_at ? row.patient_confirmed_at.toISOString() : null,
    today,
  ));
}

/**
 * تأكيد حضور موعد — من جلسة المريض حصرًا.
 *
 * الملكية والحالة والتاريخ كلها داخل SQL نفسه: موعدُ غيره، أو موعدُ ملغى، أو
 * موعدٌ ماضٍ لا يُلمس ولو حُرّف المعرّف. ولا يُغيَّر status: التأكيد إشارة «سأأتي»
 * للطاقم، والوصول الفعلي يبقى بقرار الاستقبال.
 */
export async function portalConfirmAttendance(
  appointmentId: number,
  patientId: number,
  today: string,
): Promise<{ ok: true; confirmedAt: string } | { ok: false; reason: "not_found" | "not_booked" | "past" | "too_far" }> {
  await ensureSchema();
  const { rows } = await getPool().query<{
    id: number; status: string; scheduled_date: Date; patient_confirmed_at: Date | null;
  }>(
    `SELECT id, status, scheduled_date, patient_confirmed_at FROM appointments
      WHERE id = $1 AND patient_id = $2`,
    [appointmentId, patientId],
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: "not_found" };
  const date = row.scheduled_date;
  const scheduledDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const verdict = confirmVerdict({ status: row.status, scheduledDate }, today);
  if (!verdict.ok) return { ok: false, reason: verdict.reason };

  if (row.patient_confirmed_at) {
    return { ok: true, confirmedAt: row.patient_confirmed_at.toISOString() };
  }
  const updated = await getPool().query<{ confirmed: Date }>(
    `UPDATE appointments SET patient_confirmed_at = NOW()
      WHERE id = $1 AND patient_id = $2 AND status = 'booked' AND patient_confirmed_at IS NULL
      RETURNING patient_confirmed_at`,
    [appointmentId, patientId],
  );
  if (!updated.rows[0]) return { ok: false, reason: "not_found" };
  return { ok: true, confirmedAt: updated.rows[0].confirmed.toISOString() };
}

/**
 * كشف حساب المريض في البوابة — مصدر الحقيقة نفسه.
 *
 * هذه الدالة لا تُحسِب ولا تُجمع: تستدعي `patientLedger()` حصرًا، وهي نفسها التي
 * تخدم شاشة الحساب الداخلية والكشف المطبوع. معيار القبول الثاني للمرحلة هنا بالبناء.
 */
export async function portalStatement(patientId: number) {
  return patientLedger(patientId);
}

/** إرسال استمارة صحية — نسخة جديدة تُضاف إلى سجل الصحة. */
export async function createIntakeForm(
  patientId: number,
  answers: IntakeAnswers,
): Promise<{ id: number; createdAt: string }> {
  await ensureSchema();
  const { rows } = await getPool().query<{ id: number; created_at: Date }>(
    `INSERT INTO patient_intake_forms (patient_id, answers) VALUES ($1, $2::jsonb)
      RETURNING id, created_at`,
    [patientId, JSON.stringify(answers)],
  );
  await recordAudit({
    action: "portal.intake",
    entity: "patient",
    entityId: patientId,
    details: { conditions: answers.conditions.length, hasNote: Boolean(answers.note) },
    actor: "بوابة المريض",
  });
  return { id: rows[0].id, createdAt: rows[0].created_at.toISOString() };
}

/** آخر استمارة صحية للمريض — تُقرأ فيها الحالة الحالية. */
export async function latestIntakeForm(
  patientId: number,
): Promise<{ id: number; createdAt: string; answers: IntakeAnswers } | null> {
  await ensureSchema();
  const { rows } = await getPool().query<{ id: number; created_at: Date; answers: IntakeAnswers }>(
    `SELECT id, created_at, answers FROM patient_intake_forms
      WHERE patient_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
    [patientId],
  );
  const row = rows[0];
  return row
    ? { id: row.id, createdAt: row.created_at.toISOString(), answers: row.answers }
    : null;
}
