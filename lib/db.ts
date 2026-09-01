import { Pool, type PoolClient } from "pg";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";
import {
  assertCorrectDatabaseProject,
  databaseUrlForProject,
} from "./database-scope";
import {
  computeAll, isCephLandmarkCode, isCephMeasurementCode, MEASUREMENTS, REQUIRED_LANDMARKS,
  summarize, type LandmarkCode, type LandmarkMap,
} from "./ceph";
import { toWhatsAppNumber } from "./reminders";
import type { Visit, VisitStatus } from "./flow";
import {
  batchRemaining, deriveBalance, expiryState, stockStatus, validateMovement,
  type BatchResult, type MovementKind, type StockStatus,
} from "./inventory";
import { hashPassword } from "./auth";
import { DEFAULT_SERVICES } from "./services-catalog";
import {
  type DoctorPermissions,
  type DoctorCommissionConfig,
  parseDoctorPermissions,
  parseDoctorCommissionConfig,
} from "./doctor-permissions";

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

export interface QueryResult<T = any> {
  rows: T[];
  rowCount?: number | null;
}

export interface DbClient {
  query<T = any>(sql: string, values?: any[]): Promise<QueryResult<T>>;
  release(): void;
}

export interface DbPool {
  query<T = any>(sql: string, values?: any[]): Promise<QueryResult<T>>;
  connect(): Promise<DbClient>;
  end?(): Promise<void>;
}

let pool: DbPool | null = null;
let pgliteInstance: PGlite | null = null;

function getPgliteInstance(): PGlite {
  if (!pgliteInstance) {
    pgliteInstance = new PGlite();
  }
  return pgliteInstance;
}

function adaptSqlForPglite(sql: string, values?: any[]): { sql: string; values?: any[] } {
  if (!/at\s+time\s+zone/i.test(sql)) {
    return { sql, values };
  }

  let finalValues = values ? [...values] : [];
  let finalSql = sql;

  // If AT TIME ZONE $n is used:
  const matches = [...finalSql.matchAll(/AT\s+TIME\s+ZONE\s+\$(\d+)/gi)];
  if (matches.length > 0 && finalValues.length > 0) {
    const indicesToRemove = new Set<number>();
    for (const match of matches) {
      indicesToRemove.add(parseInt(match[1], 10));
    }

    finalSql = finalSql.replace(/\s*AT\s+TIME\s+ZONE\s+\$\d+/gi, "");

    const newValues: any[] = [];
    const paramMap = new Map<number, number>();
    let nextIndex = 1;

    for (let i = 1; i <= finalValues.length; i++) {
      if (!indicesToRemove.has(i)) {
        paramMap.set(i, nextIndex++);
        newValues.push(finalValues[i - 1]);
      }
    }

    finalSql = finalSql.replace(/\$(\d+)/g, (full, numStr) => {
      const oldNum = parseInt(numStr, 10);
      const newNum = paramMap.get(oldNum);
      return newNum !== undefined ? `$${newNum}` : full;
    });

    finalValues = newValues;
  } else {
    finalSql = finalSql.replace(/\s*AT\s+TIME\s+ZONE\s+'[^']+'/gi, "");
  }

  return { sql: finalSql, values: finalValues };
}

function createPglitePool(): DbPool {
  const pglite = getPgliteInstance();
  const executeQuery = async <T = any>(sql: string, values?: any[]): Promise<QueryResult<T>> => {
    const adapted = adaptSqlForPglite(sql, values);
    if ((!adapted.values || adapted.values.length === 0) && (adapted.sql.includes(";\n") || adapted.sql.includes(";\r\n") || (adapted.sql.match(/;/g) || []).length > 1)) {
      const execRes = await pglite.exec(adapted.sql);
      const lastRes = execRes[execRes.length - 1];
      return {
        rows: (lastRes?.rows ?? []) as T[],
        rowCount: lastRes?.affectedRows ?? 0,
      };
    }
    const res = await pglite.query(adapted.sql, adapted.values);
    return {
      rows: res.rows as T[],
      rowCount: (res as any).affectedRows ?? res.rows.length,
    };
  };

  return {
    query: executeQuery,
    connect: async (): Promise<DbClient> => {
      return {
        query: executeQuery,
        release: () => {},
      };
    },
  };
}

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

export function getPool(): DbPool {
  if (pool) return pool;

  const raw = rawConnectionStringFromEnv();
  // داخل Railway يتم الربط بالـ Postgres المباشر.
  // خارج Railway (في المحاكي / بيئة التطوير والـ Sandbox)، رابط .railway.internal غير متاح
  // عبر شبكة الإنترنت الخارجية، فيتم تلقائياً الانتقال إلى محرك PGlite المدمج ليعمل المحاكي بسلاسة.
  const isRailwayInternalOutside = Boolean(
    raw && raw.includes("postgres.railway.internal") && !process.env.RAILWAY_PROJECT_ID
  );
  const forceLocal = process.env.USE_LOCAL_DB === "true" || !raw || isRailwayInternalOutside;

  if (forceLocal) {
    pool = createPglitePool();
    return pool;
  }

  try {
    assertCorrectDatabaseProject();
    const connectionString = connectionStringFromEnv();
    if (!connectionString) {
      pool = createPglitePool();
      return pool;
    }
    const realPool = new Pool({ connectionString, ssl: sslFor(connectionString), max: 3 });
    pool = realPool as unknown as DbPool;
    return pool;
  } catch {
    pool = createPglitePool();
    return pool;
  }
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
      -- عدّاد «لم يستجب»: نداءٌ لم يجده المريض يُعاد ضربه من الشاشة، وعدّه يبقى
      -- للإدارة لاحقًا — كم نداءً ضاع يوميًا بسبب صالةٍ لا تُسمع.
      ALTER TABLE visits ADD COLUMN IF NOT EXISTS no_response_count INTEGER NOT NULL DEFAULT 0;

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
      -- (عمود الطبيب الأساسي primary_doctor_id يُضاف بعد إنشاء parties أدناه
      -- — المفتاح الأجنبي يشترط وجود الجدول الأصل أولًا.)

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
      ALTER TABLE appointments ADD COLUMN IF NOT EXISTS appointment_type TEXT;
      ALTER TABLE appointments ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;
      -- تأكيد الحضور من بوابة المريض: ختمٌ مستقل لا يغيّر حالة الموعد التشغيلية —
      -- المريض يؤكد أن قادم، والوصول الفعلي يبقى قرار الاستقبال وحده.
      ALTER TABLE appointments ADD COLUMN IF NOT EXISTS patient_confirmed_at TIMESTAMPTZ;
      -- (عمود موعد الطبيب doctor_id يُضاف بعد إنشاء parties أدناه — المفتاح
      -- الأجنبي يشترط وجود الجدول الأصل أولًا.)

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

      -- ── المختبرات السنية V2 (من عمل الوكيل المساعد) ─────────────────────────
      -- دليل خدمات المعمل: مفردات موحّدة للطلب والتسعير بدل نصوص حرّة تتفرّع
      -- («تاج زيركون» و«زيركون كامل» عملٌ واحد باسمين).
      CREATE TABLE IF NOT EXISTS lab_services (
        id           SERIAL PRIMARY KEY,
        name         TEXT        NOT NULL,
        code         TEXT        UNIQUE,
        category     TEXT        NOT NULL DEFAULT 'prostho',
        default_days INTEGER     NOT NULL DEFAULT 7,
        description  TEXT,
        is_active    BOOLEAN     NOT NULL DEFAULT TRUE,
        sort_order   INTEGER     NOT NULL DEFAULT 100,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS lab_services_active_idx ON lab_services (is_active, sort_order);

      -- توسيع أعمال المختبر: الربط السريري (الأسنان واللون والطبع والأولوية)
      -- والجودة والإعادات والفني — بلا سعرٍ واحد هنا: التكلفة تعيش في payables
      -- وقواعد التسعير، والفصل مقصود (DTO سريري / مالي).
      -- (الأعمدة التي تشير إلى parties — الطبيب وقواعد التسعير — تُضاف بعد إنشاء
      -- parties أدناه: ترتيب الإنشاء حرج، الجدول الأصل قبل من يشير إليه.)
      ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS lab_service_id      INTEGER REFERENCES lab_services(id) ON DELETE SET NULL;
      ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS tooth_numbers       TEXT;
      ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS shade               TEXT;
      ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS stump_shade         TEXT;
      ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS priority            TEXT NOT NULL DEFAULT 'normal';
      ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS impression_type     TEXT NOT NULL DEFAULT 'physical';
      ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS quality_check       TEXT NOT NULL DEFAULT 'pending';
      ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS quality_notes       TEXT;
      ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS remake_original_id  INTEGER REFERENCES lab_orders(id) ON DELETE SET NULL;
      ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS remake_reason       TEXT;
      ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS technician_name     TEXT;
      CREATE INDEX IF NOT EXISTS lab_orders_service_idx ON lab_orders (lab_service_id);

      -- سجل تتبع أحداث كل أمر: من حرّك الحالة ومتى وبأي ملاحظة — الإعادة والجودة
      -- بلا أثر مكتوب قصةٌ تُروى ولا تُراجَع.
      CREATE TABLE IF NOT EXISTS lab_order_tracking (
        id           BIGSERIAL   PRIMARY KEY,
        lab_order_id INTEGER     NOT NULL REFERENCES lab_orders(id) ON DELETE CASCADE,
        action       TEXT        NOT NULL,
        from_status  TEXT,
        to_status    TEXT,
        notes        TEXT,
        actor        TEXT        NOT NULL,
        actor_role   TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS lab_order_tracking_order_idx ON lab_order_tracking (lab_order_id, created_at ASC);

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

      -- ── صلاحيات الأطباء (من عمل الوكيل المساعد) ────────────────────────────
      -- الطبيب الأساسي للمريض عمودٌ صريح يوسّع عزل الخادم: من ربطه الاستقبال
      -- بجهته يرى ملفه حتى لو لم تُسجّل له زيارة بعد. وموعد الطبيب يعرف جهته
      -- صراحةً فيرى مواعيده وحدها في جدول اليوم ما لم يُمنح رؤية الجميع.
      ALTER TABLE patients ADD COLUMN IF NOT EXISTS primary_doctor_id INTEGER REFERENCES parties(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS patients_primary_doctor_idx ON patients (primary_doctor_id);
      ALTER TABLE appointments ADD COLUMN IF NOT EXISTS doctor_id INTEGER REFERENCES parties(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS appointments_doctor_idx ON appointments (doctor_id);

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

      -- ── المختبرات السنية V2 (تكملة): ما يشير إلى parties يأتي بعدها ────────
      -- الطبيب صاحب الطلب: يعرف العمل من طلبه فيُعرض له في «أعمال معاملي».
      ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS doctor_id INTEGER REFERENCES parties(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS lab_orders_doctor_idx ON lab_orders (doctor_id);

      -- قواعد تسعير خدمات المعمل لكل مختبر بتواريخ سريان: التكلفة تتغير والقديم
      -- يبقى محفوظًا لمراجعة ما دُفع في حينه.
      CREATE TABLE IF NOT EXISTS lab_pricing_rules (
        id             SERIAL PRIMARY KEY,
        party_id       INTEGER     NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
        lab_service_id INTEGER     NOT NULL REFERENCES lab_services(id) ON DELETE RESTRICT,
        cost_minor     BIGINT      NOT NULL,
        cost_currency  TEXT        NOT NULL DEFAULT 'YER',
        effective_from DATE        NOT NULL,
        effective_to   DATE,
        note           TEXT,
        created_by     TEXT        NOT NULL,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS lab_pricing_rules_lookup_idx
        ON lab_pricing_rules (party_id, lab_service_id, effective_from DESC);

      -- ── رحلة المريض V2 (§١٩): طلب المختبر من الإجراء ───────────────────────
      -- الطلب التلقائي يعرف زيارته وسنَّه: تاجٌ نُفِّذ في زيارةٍ يولّد طلبًا مربوطًا
      -- بتلك الزيارة وذلك السن — فلا يُطلب مرّتين للسنّ نفسه، ويُفتح مصدره من الزيارة.
      ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS visit_id INTEGER REFERENCES visits(id) ON DELETE SET NULL;
      ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS tooth_code SMALLINT;
      -- كيف وُلد الطلب: auto من توقيع الزيارة، أو manual من شاشةٍ ما. الطلبات
      -- التلقائية بلا مختبر بعد (needed) — تُرسل من لوحة الأعمال.
      ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';
      -- سنٌّ واحد في الزيارة = طلب واحد مهما أُعيد التوقيع أو ضُغط الزر مرتين.
      CREATE UNIQUE INDEX IF NOT EXISTS lab_orders_visit_tooth_uniq
        ON lab_orders (visit_id, tooth_code) WHERE visit_id IS NOT NULL AND status <> 'cancelled';

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

      -- ─── رحلة المريض V2: الجلسات والزيارات المخطَّطة ────────────────────────
      --
      -- المبدأ: الخطة تُوزَّع على جلسات، والجلسة تُنجَز في زيارة، والزيارة تولّد
      -- الاستحقاق. هذه الجداول هي التي تجعل «ماذا سنعمل اليوم؟» و«ماذا في الزيارة
      -- القادمة؟» سؤالين يجيب عنهما النظام لا الذاكرة.
      --
      -- قاعدة الفوترة لكل بند: متى يصبح المبلغ مستحقًا — عند البدء أم الإكمال أم
      -- لكل جلسة؟ (راجع lib/workflow.ts). منفصلة عن الحالة المالية عمدًا: بندٌ بدأ
      -- ولم يكتمل «مستحقٌّ» بموجب on_start و«قيد التنفيذ» سريريًّا في آنٍ واحد.
      ALTER TABLE plan_items ADD COLUMN IF NOT EXISTS billing_rule  TEXT NOT NULL DEFAULT 'on_completion';
      ALTER TABLE plan_items ADD COLUMN IF NOT EXISTS session_count INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE plan_items ADD COLUMN IF NOT EXISTS started_at    TIMESTAMPTZ;
      -- طريقة استحقاق الخطة كلها: بالخدمات المنفَّذة (الافتراضي) أو بأقساطٍ متفق
      -- عليها (التقويم والباقات). الخطة ببنودٍ وأقساطٍ معًا مسموحة: بنودٌ تُبنى
      -- ويُوزَّع ثمنها أقساطًا — اتفاقٌ واحد بوجهين.
      ALTER TABLE treatment_plans ADD COLUMN IF NOT EXISTS billing_mode TEXT NOT NULL DEFAULT 'per_procedure';
      ALTER TABLE treatment_plans ADD COLUMN IF NOT EXISTS specialty TEXT;
      ALTER TABLE treatment_plans ADD COLUMN IF NOT EXISTS primary_doctor_id INTEGER REFERENCES parties(id);

      -- الزيارة المخطَّطة: «ماذا سنعمل في الزيارة القادمة» قبل «متى بالضبط».
      -- الاستقبال يحوّلها موعدًا بتاريخٍ ووقت فقط — لا يُعاد إدخال العلاج، لأن
      -- الاتفاق المكتوب مرتين يصير لكل كتابةٍ رأيٌ عند الخلاف.
      -- (تُنشأ قبل جلساتها: جدولٌ يُشار إليه بمفتاح أجنبي يجب أن يسبق من يشير إليه.)
      CREATE TABLE IF NOT EXISTS planned_visits (
        id               SERIAL PRIMARY KEY,
        patient_id       INTEGER     NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
        plan_id          INTEGER     REFERENCES treatment_plans(id) ON DELETE CASCADE,
        sequence         INTEGER     NOT NULL,
        title            TEXT        NOT NULL,
        doctor_id        INTEGER     REFERENCES parties(id),
        duration_minutes INTEGER     NOT NULL DEFAULT 30,
        status           TEXT        NOT NULL DEFAULT 'planned',
        appointment_id   INTEGER     REFERENCES appointments(id),
        visit_id         INTEGER     REFERENCES visits(id),
        note             TEXT,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS planned_visits_patient_idx ON planned_visits (patient_id, status, sequence);
      CREATE INDEX IF NOT EXISTS planned_visits_plan_idx ON planned_visits (plan_id, sequence);
      CREATE INDEX IF NOT EXISTS planned_visits_status_idx ON planned_visits (status);

      -- جلسات بند العلاج: عصبٌ ثلاث جلسات ليس ثلاثة عصاب. الجلسة تُنجَز في زيارة
      -- فتُختم بها؛ وترتيبها داخل البند وحيد — لا جلسة رابعة لعصبٍ ثلاث جلسات.
      CREATE TABLE IF NOT EXISTS treatment_sessions (
        id               BIGSERIAL   PRIMARY KEY,
        plan_item_id     INTEGER     NOT NULL REFERENCES plan_items(id) ON DELETE CASCADE,
        sequence         INTEGER     NOT NULL,
        title            TEXT,
        status           TEXT        NOT NULL DEFAULT 'planned',
        visit_id         INTEGER     REFERENCES visits(id),
        planned_visit_id INTEGER     REFERENCES planned_visits(id),
        planned_duration INTEGER,
        completed_at     TIMESTAMPTZ,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT treatment_sessions_seq_uniq UNIQUE (plan_item_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS treatment_sessions_item_idx ON treatment_sessions (plan_item_id, sequence);
      CREATE INDEX IF NOT EXISTS treatment_sessions_visit_idx ON treatment_sessions (visit_id);
      CREATE INDEX IF NOT EXISTS treatment_sessions_planned_idx ON treatment_sessions (planned_visit_id);

      -- الروابط العكسية: الزيارة تعرف خطتها، والموعد يعرف زيارته المخطَّطة — فيكون
      -- التحويل بينها قراءةً لا بحثًا بالاسم في جدولين.
      ALTER TABLE visits ADD COLUMN IF NOT EXISTS planned_visit_id INTEGER REFERENCES planned_visits(id);
      ALTER TABLE appointments ADD COLUMN IF NOT EXISTS planned_visit_id INTEGER REFERENCES planned_visits(id);

      -- مصدر كل سطر فاتورة — الحارس الإلزامي ضد الفوترة المزدوجة (المواصفة §٢٣):
      -- لا يُفوتَر المصدر نفسه مرتين مهما اختلف الباب الذي دخلت منه الفاتورة.
      -- الفهرس جزئيّ كي تبقى البنود اليدوية القديمة والاستثنائية خارج الحارس.
      ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS source_type TEXT;
      ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS source_id   BIGINT;
      CREATE UNIQUE INDEX IF NOT EXISTS invoice_items_source_uniq
        ON invoice_items (source_type, source_id) WHERE source_type IS NOT NULL;

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

      -- صور الجلسة: المستند يُربط بشدّة التقويم التي صُوِّرت فيها — وألبوم الجلسة
      -- هو صورها لا مجلّدها. والفكّ الصريح عمدًا: ortho_cases تُنشأ بعد
      -- patient_documents في المخطط، فالمفاتيح تُضاف هنا بعد وجود الجدولين.
      ALTER TABLE patient_documents ADD COLUMN IF NOT EXISTS ortho_case_id INTEGER REFERENCES ortho_cases(id);
      ALTER TABLE patient_documents ADD COLUMN IF NOT EXISTS adjustment_id INTEGER REFERENCES ortho_adjustments(id);
      -- دور الصورة الزمني (بداية/متابعة/فكّ/تثبيت) ووجهها المعياري — هما ما يجعلان
      -- مقارنة Before/Progress/After بعد سنوات استعلامًا لا بحثًا.
      ALTER TABLE patient_documents ADD COLUMN IF NOT EXISTS photo_stage TEXT;
      ALTER TABLE patient_documents ADD COLUMN IF NOT EXISTS photo_view TEXT;
      CREATE INDEX IF NOT EXISTS patient_documents_adjustment_idx ON patient_documents (adjustment_id);
      CREATE INDEX IF NOT EXISTS patient_documents_ortho_idx ON patient_documents (ortho_case_id);

      -- التشخيص النسخي: **يُضاف إليه فقط**. التحديث نسخةٌ جديدة تشير إلى سابقتها،
      -- وما رآه الطبيب يوم بدء العلاج يبقى كما هو — فالقيمة أن تُقرأ النسختان معًا
      -- فتُرى قصة الحالة، لا أن يُستبدل الأخير بالأول بصمت.
      CREATE TABLE IF NOT EXISTS patient_diagnoses (
        id            SERIAL PRIMARY KEY,
        patient_id    INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
        version       INTEGER NOT NULL DEFAULT 1,
        content       JSONB   NOT NULL,
        label         TEXT,
        visit_id      INTEGER REFERENCES visits(id),
        ortho_case_id INTEGER REFERENCES ortho_cases(id),
        supersedes    INTEGER REFERENCES patient_diagnoses(id),
        created_by    TEXT    NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS patient_diagnoses_patient_idx
        ON patient_diagnoses (patient_id, created_at DESC);

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

      -- وإجراء الزيارة يعرف بند الخطة الذي جاء منه (رحلة V2) — وهو ما يجعل السعر
      -- يأتي من الخطة وفق قاعدة الفوترة لا من لوحة المفاتيح، والفوترة تتبع البند.
      ALTER TABLE visit_procedures ADD COLUMN IF NOT EXISTS plan_item_id INTEGER REFERENCES plan_items(id);
      CREATE INDEX IF NOT EXISTS visit_procedures_plan_item_idx ON visit_procedures (plan_item_id);

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

      -- ── رحلة المريض V2 (§٣٥/٣٧/٣٩): ربط المستخدم بطبيبه ────────────────────
      -- حسابُ الطبيب يُربط بجهة «طبيب» واحدة: بها يعرف النظام مرضاه (خططهم
      -- الأساسية وزياراتهم وزياراتهم المخطَّطة) فيحجب عنه ما ليس له — فصلٌ يُنفَّذ
      -- في الخادم لا في الشاشة. ومن لم يُربط يبقى على السلوك القديم حتى يربطه المدير.
      ALTER TABLE users ADD COLUMN IF NOT EXISTS party_id INTEGER REFERENCES parties(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS users_party_idx ON users (party_id) WHERE party_id IS NOT NULL;

      -- صلاحيات الأطباء التفصيلية + «المالية المخفية» (من عمل الوكيل المساعد):
      -- التخصص والفرع تعريفان يُعرضان، والصلاحيات وإعدادات العمولة مستندان JSON
      -- يقرأهما الخادم عند كل طلب ويُعدّلانهما من شاشة المستخدمين للمدير وحده.
      -- ربط الطبيب بجهته يبقى عبر party_id أعلاه — لا عمود ثانٍ ولا ازدواجية.
      ALTER TABLE users ADD COLUMN IF NOT EXISTS specialty         TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS branch            TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions       TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS commission_config TEXT;

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
        patient_id  INTEGER     REFERENCES patients(id) ON DELETE SET NULL,
        created_by  TEXT        NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS patient_id INTEGER REFERENCES patients(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS inventory_movements_item_idx ON inventory_movements (item_id, id);
      CREATE INDEX IF NOT EXISTS inventory_movements_patient_idx ON inventory_movements (patient_id);
      CREATE INDEX IF NOT EXISTS inventory_movements_expiry_idx ON inventory_movements (expiry_date)
        WHERE kind = 'in' AND expiry_date IS NOT NULL;

      -- ── رحلة المريض V2 (§٢٠): ربط الإجراء بالمستهلكات ──────────────────────
      -- كل خدمة تستهلك موادّ معلومة: حشوةٌ تستهلك أمالغم ومخدّرًا وقفازين. الربط
      -- يُعرَّف مرة، وخصمُه يقع تلقائيًا عند توقيع الزيارة — فلا يُنسي أحدٌ قفازًا،
      -- ولا يُخصم مرّتين لأن الحركة تحمل الزيارة نفسها.
      -- (تُنشأ بعد بنود المخزون: جدولٌ يُشار إليه بمفتاح أجنبي يسبق من يشير إليه —
      -- نفس درس parties الموثّق أعلاه.)
      CREATE TABLE IF NOT EXISTS service_materials (
        id           SERIAL PRIMARY KEY,
        service_id   INTEGER  NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        item_id      INTEGER  NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
        qty_per_unit NUMERIC(12,3) NOT NULL CHECK (qty_per_unit > 0),
        note         TEXT,
        created_by   TEXT     NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT service_materials_uniq UNIQUE (service_id, item_id)
      );
      CREATE INDEX IF NOT EXISTS service_materials_service_idx ON service_materials (service_id);

      -- المراسلة الداخلية: رسائل نصية وصوتية ومرفقات بين الطاقم، ورسائل بين
      -- الطاقم والمرضى من بوابة المريض. الجدول واحد والفصل في أعمدة الجهة:
      -- رسالة الطاقم إلى زميله تحمل sender_type=user وrecipient_type=user،
      -- ورسالة المريض إلى العيادة تحمل recipient_type=staff_all فيراها الطاقم
      -- كلهم (صندوق مشترك لا حاجة فيه لاختيار مرسل بعينه)، وردّ الطاقم على
      -- المريض recipient_type=patient، والرسالة الجماعية بين الطاقم تُخزن
      -- صفاً واحداً بrecipient_type=staff_all وsender_type=user فيراها الفريق
      -- كله في خيط جماعي واحد بلا تكرار للمرفقات. جسم الصوت والمرفق يُخزن
      -- Base64: ملاحظة عيادة قصيرة لا تستحق نظام ملفات، وتنقل مع النسخ
      -- الاحتياطي.
      CREATE TABLE IF NOT EXISTS messages (
        id                   SERIAL PRIMARY KEY,
        sender_type          TEXT        NOT NULL CHECK (sender_type IN ('user','patient')),
        sender_user_id       INTEGER     REFERENCES users(id) ON DELETE SET NULL,
        sender_patient_id    INTEGER     REFERENCES patients(id) ON DELETE CASCADE,
        recipient_type       TEXT        NOT NULL CHECK (recipient_type IN ('user','patient','staff_all')),
        recipient_user_id    INTEGER     REFERENCES users(id) ON DELETE SET NULL,
        recipient_patient_id INTEGER     REFERENCES patients(id) ON DELETE CASCADE,
        body                 TEXT,
        kind                 TEXT        NOT NULL DEFAULT 'text' CHECK (kind IN ('text','voice','file')),
        voice_mime           TEXT,
        voice_data           TEXT,
        voice_ms             INTEGER,
        file_name            TEXT,
        file_mime            TEXT,
        file_size            INTEGER,
        file_data            TEXT,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      -- قيود قاعدة قائمة زُرعت قبل المرفقات بنسخة kind النصية والصوتية وحدها:
      -- الترحيلة تفتح القيد وتعيد بناءه بالأنواع الثلاثة، وتعمل على الجديدة
      -- والقديمة بالسواء لأن DROP IF EXISTS لا يخطئ في الحالتين.
      ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_kind_check;
      ALTER TABLE messages ADD CONSTRAINT messages_kind_check CHECK (kind IN ('text','voice','file'));
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS file_name TEXT;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS file_mime TEXT;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS file_size INTEGER;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS file_data TEXT;
      CREATE INDEX IF NOT EXISTS messages_id_idx ON messages (id);
      CREATE INDEX IF NOT EXISTS messages_dm_idx ON messages (sender_user_id, recipient_user_id);
      CREATE INDEX IF NOT EXISTS messages_to_user_idx ON messages (recipient_type, recipient_user_id);
      CREATE INDEX IF NOT EXISTS messages_from_patient_idx ON messages (sender_patient_id)
        WHERE sender_type = 'patient';
      CREATE INDEX IF NOT EXISTS messages_to_patient_idx ON messages (recipient_patient_id)
        WHERE recipient_type = 'patient';
      CREATE INDEX IF NOT EXISTS messages_broadcast_idx ON messages (id)
        WHERE recipient_type = 'staff_all' AND sender_type = 'user';
      CREATE INDEX IF NOT EXISTS messages_patient_rate_idx ON messages (sender_patient_id, created_at)
        WHERE sender_type = 'patient';

      -- حالة القراءة لكل مستخدم على حدة: رسالة المريض إلى العيادة يقرؤها الطبيب
      -- وتظل غير مقروءة عند الاستقبال حتى يفتحها هو أيضًا — فالصندوق مشترك
      -- والقراءة شخصية، ولو شاركناها لضاع إشعار الاستقبال بمرضى ينتظرون ردًّا.
      CREATE TABLE IF NOT EXISTS message_reads (
        message_id INTEGER     NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        read_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (message_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS message_reads_user_idx ON message_reads (user_id);

      -- طبقة المحادثة الحية: عاجلة يحرقها المريض فترتفع صوت العيادة، وردٌّ يقتبس
      -- رسالة، وتعديل وحذف لطيفان يحفظان خيط الكلام للطرف الآخر (حذف من الطرف
      -- لا يعني نسيان سجل المحادثة عند من استلمها)، وقراءة المريض لردّ الطاقم
      -- عمودٌ على الرسالة نفسها لا سطر في message_reads — فالمريض ليس مستخدمًا.
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_urgent      BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at      TIMESTAMPTZ;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at     TIMESTAMPTZ;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id    INTEGER REFERENCES messages(id) ON DELETE SET NULL;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS patient_read_at TIMESTAMPTZ;
      CREATE INDEX IF NOT EXISTS messages_urgent_idx ON messages (id)
        WHERE is_urgent AND sender_type = 'patient' AND deleted_at IS NULL;
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

    // بذر حسابات الطاقم الافتراضية والخدمات الأساسية إن كانت القاعدة فارغة (لتشغيل المحاكي وبيئات التطوير فوراً)
    try {
      const userCountRes = await getPool().query<{ count: string }>("SELECT COUNT(*) as count FROM users");
      const userCount = Number(userCountRes.rows[0]?.count ?? 0);
      if (userCount === 0) {
        const adminPass = await hashPassword("admin123456");
        const doctorPass = await hashPassword("doctor123456");
        const receptionPass = await hashPassword("reception123456");
        const shotsPass = await hashPassword("shots-only-local-1234");
        await getPool().query(
          `INSERT INTO users (username, display_name, password_hash, role)
           VALUES 
             ('admin', 'المدير العام (د. عقلان)', $1, 'admin'),
             ('doctor', 'د. أروى (أخصائي التقويم)', $2, 'doctor'),
             ('reception', 'استقبال المركز', $3, 'reception'),
             ('shots', 'حساب الاختبارات والمحاكاة', $4, 'admin')
           ON CONFLICT (username) DO NOTHING`,
          [adminPass, doctorPass, receptionPass, shotsPass],
        );
      }

      // توحيد مفردة الدور: حساب الاستقبال زُرع في نسخٍ سابقة بالاسم receptionist
      // بينما صلاحيات النظام كلها تقارن reception — فتُقصى الصلاحية بصمت. الترحيلة
      // تصحّح القواعد القائمة، والزرع أعلاه يكتب الاسم الصحيح في الجديدة.
      await getPool().query(
        `UPDATE users SET role = 'reception' WHERE role = 'receptionist'`,
      );

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

      // بذر المواد والمستهلكات السنية الأساسية إن كان المخزن فارغًا
      const invCount = await getPool().query<{ count: string }>("SELECT COUNT(*) as count FROM inventory_items");
      if (Number(invCount.rows[0]?.count ?? 0) === 0) {
        const itemsToSeed = [
          { name: "بنج ليدوكائين 2% مع أدرينالين", category: "anesthesia", unit: "علبة", min: 5, inQty: 15, expiry: "2027-12-31" },
          { name: "بنج سيبتوكائين 4% (Septanest)", category: "anesthesia", unit: "علبة", min: 3, inQty: 10, expiry: "2027-08-30" },
          { name: "حشوة كمبوزيت 3M Filtek Z250 لون A2", category: "filling", unit: "سرنجة", min: 4, inQty: 12, expiry: "2028-06-30" },
          { name: "حشوة كمبوزيت 3M Filtek Z250 لون A3", category: "filling", unit: "سرنجة", min: 4, inQty: 10, expiry: "2028-06-30" },
          { name: "مادة بوندينج لاصقة Single Bond", category: "filling", unit: "علبة", min: 2, inQty: 6, expiry: "2027-11-30" },
          { name: "حمض تخريش فوسفوريك Etchant Gel", category: "filling", unit: "سرنجة", min: 5, inQty: 15, expiry: "2028-01-31" },
          { name: "مبارد علاج عصب آلية Rotary ProTaper", category: "filling", unit: "طقم", min: 3, inQty: 8, expiry: null },
          { name: "جوتا بيركا أقماع حشو عصب قياسات منوعة", category: "filling", unit: "علبة", min: 4, inQty: 10, expiry: "2029-01-01" },
          { name: "سيلر حشو جذور AH Plus", category: "filling", unit: "طقم", min: 2, inQty: 5, expiry: "2027-10-15" },
          { name: "بودرة طبعات ألجينات كروماتيك", category: "impression", unit: "كيس", min: 6, inQty: 18, expiry: "2027-05-30" },
          { name: "سيليكون مطاطي كوندنسيشن للطبعات", category: "impression", unit: "طقم", min: 2, inQty: 6, expiry: "2027-09-30" },
          { name: "خيوط جراحية سيلك Silk 3/0 مع إبرة", category: "surgical", unit: "علبة", min: 3, inQty: 8, expiry: "2028-04-30" },
          { name: "شفرات جراحة رقم 15 معقمة", category: "surgical", unit: "علبة", min: 2, inQty: 6, expiry: "2029-12-31" },
          { name: "قفازات فحص طبية لاتكس قياس M", category: "hygiene", unit: "علبة", min: 10, inQty: 30, expiry: "2029-01-01" },
          { name: "كمامات جراحية 3 طبقات", category: "hygiene", unit: "علبة", min: 10, inQty: 25, expiry: "2029-01-01" },
          { name: "قطن رول لفة أسنان", category: "hygiene", unit: "كيس", min: 5, inQty: 15, expiry: null },
          { name: "براكيتات تقويم معدنية MBT قياس 022", category: "ortho", unit: "طقم", min: 5, inQty: 14, expiry: null },
          { name: "أسلاك تقويم نيتينول Niti مقاس 014", category: "ortho", unit: "باكيت", min: 8, inQty: 20, expiry: null },
          { name: "مطاط تقويم ملون لربط البراكيتات", category: "ortho", unit: "حلقات", min: 10, inQty: 40, expiry: null },
        ];

        for (const item of itemsToSeed) {
          const inserted = await getPool().query<{ id: number }>(
            `INSERT INTO inventory_items (name, category, unit, min_level, created_by)
             VALUES ($1, $2, $3, $4, 'system') RETURNING id`,
            [item.name, item.category, item.unit, item.min],
          );
          if (inserted.rows[0]) {
            await getPool().query(
              `INSERT INTO inventory_movements (item_id, kind, qty, expiry_date, reason, created_by)
               VALUES ($1, 'in', $2, $3, 'رصيد افتتاحي لبدء التشغيل', 'system')`,
              [inserted.rows[0].id, item.inQty, item.expiry],
            );
          }
        }
      }

      await getPool().query(`
        INSERT INTO settings (key, value)
        VALUES 
          ('clinic.name', 'مركز عقلان لطب وجراحة الفم والأسنان'),
          ('clinic.lead_doctor', 'د. عقلان الكامل'),
          ('clinic.lead_doctor_title', 'استشاري جراحة وزراعة وتقويم الأسنان')
        ON CONFLICT (key) DO NOTHING
      `);

      // بذر دليل خدمات المعمل الافتراضية (المختبرات السنية V2) — إن كان الدليل
      // فارغًا فقط: مفردات جاهزة من يومٍ أول، والمالك يعدّلها من شاشة المعمل.
      const labSvcCount = await getPool().query<{ count: string }>("SELECT COUNT(*) as count FROM lab_services");
      if (Number(labSvcCount.rows[0]?.count ?? 0) === 0) {
        for (const item of DEFAULT_LAB_SERVICES) {
          await getPool().query(
            `INSERT INTO lab_services (name, code, category, default_days, sort_order)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (code) DO NOTHING`,
            [item.name, item.code, item.category, item.defaultDays, item.sortOrder],
          );
        }
      }
    } catch {
      // لا نوقف تشغيل المخطط إذا حدث استثناء ثانوي في البذر
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
  no_response_count: number | null;
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
    appointmentId: row.appointment_id,
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

export async function createNextSession(
  input: {
    visitId: number;
    date: string;
    time: string;
    durationMinutes: number;
    phone: string | null;
    note: string | null;
  },
  runOn?: DbClient,
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
  /** جهة «طبيب» المرتبطة (§٣٥): بها يعرف الخادم مرضى هذا الحساب. */
  partyId: number | null;
  /** التخصص والفرع (صلاحيات الوكيل المساعد): تعريفان يُعرضان في الواجهة. */
  specialty?: string;
  branch?: string;
  /** الصلاحيات التفصيلية — مُحلّلة من عمود JSON مع قيم افتراضية آمنة. */
  permissions?: DoctorPermissions;
  /** إعدادات العمولة — مُحلّلة من عمود JSON مع قيم افتراضية آمنة. */
  commissionConfig?: DoctorCommissionConfig;
}

interface UserRow {
  id: number;
  username: string;
  display_name: string;
  password_hash: string;
  role: string;
  is_active: boolean;
  party_id: number | null;
  specialty?: string | null;
  branch?: string | null;
  permissions?: string | null;
  commission_config?: string | null;
}

function toUser(row: UserRow): StaffUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    role: row.role,
    isActive: row.is_active,
    partyId: row.party_id ?? null,
    specialty: row.specialty ?? undefined,
    branch: row.branch ?? undefined,
    permissions: parseDoctorPermissions(row.permissions, row.role),
    commissionConfig: parseDoctorCommissionConfig(row.commission_config),
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
  /** التخصص والفرع والصلاحيات والعمولة (اختيارية — الأعمدة الجديدة). */
  specialty?: string;
  branch?: string;
  permissions?: DoctorPermissions;
  commissionConfig?: DoctorCommissionConfig;
}): Promise<StaffUser> {
  await ensureSchema();
  const { rows } = await getPool().query<UserRow>(
    `INSERT INTO users (username, display_name, password_hash, role,
                        specialty, branch, permissions, commission_config)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [
      input.username, input.displayName, input.passwordHash, input.role,
      input.specialty ?? null, input.branch ?? null,
      input.permissions ? JSON.stringify(input.permissions) : null,
      input.commissionConfig ? JSON.stringify(input.commissionConfig) : null,
    ],
  );
  return toUser(rows[0]);
}

// ─── المرضى والمواعيد ────────────────────────────────────────────────────────

import { addDays, checkSlot, clinicDateString, nextFreeTime } from "./schedule";
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
 * شرط «مريض هذا الطبيب» (§٣٩) — سطرٌ واحد يُلصق في استعلامات المرضى.
 *
 * الطبيب يرى مرضاه: من كان طبيب خطته النشطة الأساسيّ، أو نفّذ له زيارةً، أو
 * له زيارةٌ مخططة له، أو هو طبيبه الأساسي المسجّل (صلاحيات الوكيل المساعد)،
 * أو له موعدٌ معه. ومن عالج مريضًا مرّةً لا يفقده تغيّير الاستقبال له.
 */
const DOCTOR_PATIENT_CONDITION = `EXISTS (
  SELECT 1 FROM treatment_plans t
   WHERE t.patient_id = patients.id AND t.primary_doctor_id = :doc AND t.status = 'active'
  UNION ALL
  SELECT 1 FROM visits v WHERE v.patient_id = patients.id AND v.doctor_id = :doc
  UNION ALL
  SELECT 1 FROM planned_visits pv WHERE pv.patient_id = patients.id AND pv.doctor_id = :doc
  UNION ALL
  SELECT 1 FROM patients pd WHERE pd.id = patients.id AND pd.primary_doctor_id = :doc
  UNION ALL
  SELECT 1 FROM appointments a WHERE a.patient_id = patients.id AND a.doctor_id = :doc
)`;

/**
 * يبحث بالاسم أو الهاتف.
 *
 * البحث بالجزء لا بالبداية: الاستقبال تتذكر «محمد» من «عبدالله محمد سالم»، والبحث
 * بالبداية وحده كان سيعيد لا شيء فتُنشئ سجلًا مكررًا لمريض موجود.
 */

export async function searchPatients(
  term: string,
  limit = 8,
  doctorPartyId?: number | null,
): Promise<PatientSummary[]> {
  await ensureSchema();
  const trimmed = term.trim();
  if (!trimmed) return [];
  // الرقم يُبحث عنه بصيغتيه: من كتب `770…` يجب أن يجد سجلًا مخزّنًا `967770…`.
  const forms = phoneLookupForms(trimmed);
  const scoped = typeof doctorPartyId === "number" && doctorPartyId > 0;
  const doctorFilter = scoped
    ? ` AND ${DOCTOR_PATIENT_CONDITION.replaceAll(":doc", "$4")}`
    : "";
  const { rows } = await getPool().query<PatientRow>(
    `SELECT id, patient_number, full_name, phone, medical_alert FROM patients
      WHERE (full_name ILIKE $1
         OR phone ILIKE $1 OR alt_phone ILIKE $1
         OR phone = ANY($3::text[]) OR alt_phone = ANY($3::text[])
         OR patient_number ILIKE $1)
      ${doctorFilter}
      ORDER BY full_name LIMIT $2`,
    [`%${trimmed}%`, limit, forms, ...(scoped ? [doctorPartyId] : [])],
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
export async function listPatients(
  offset: number,
  limit: number,
  doctorPartyId?: number | null,
): Promise<{
  rows: PatientSummary[]; total: number;
}> {
  await ensureSchema();
  const pool = getPool();
  const scoped = typeof doctorPartyId === "number" && doctorPartyId > 0;
  const doctorFilter = scoped
    ? ` WHERE ${DOCTOR_PATIENT_CONDITION.replaceAll(":doc", "$3")}`
    : "";
  const countFilter = scoped
    ? ` WHERE ${DOCTOR_PATIENT_CONDITION.replaceAll(":doc", "$1")}`
    : "";
  const [list, counted] = await Promise.all([
    pool.query<PatientRow>(
      `SELECT id, patient_number, full_name, phone, medical_alert FROM patients
        ${doctorFilter}
        ORDER BY created_at DESC, id DESC OFFSET $1 LIMIT $2`,
      scoped ? [offset, limit, doctorPartyId] : [offset, limit],
    ),
    pool.query<{ c: string }>(
      `SELECT count(*)::int AS c FROM patients${countFilter}`,
      scoped ? [doctorPartyId] : [],
    ),
  ]);
  return {
    rows: list.rows.map((row) => ({
      id: row.id,
      patientNumber: row.patient_number,
      fullName: row.full_name,
      phone: row.phone,
      medicalAlert: row.medical_alert,
    })),
    total: Number(counted.rows[0]?.c ?? 0),
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
  /** جهة الطبيب الموعود لديه (صلاحيات الوكيل المساعد) — null لغير المسند. */
  doctor_id?: number | null;
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
    appointmentType: row.appointment_type ?? null,
    note: row.note,
    status: row.status as AppointmentStatus,
    reminderSentAt: row.reminder_sent_at ? row.reminder_sent_at.toISOString() : null,
    doctorId: row.doctor_id ?? null,
  };
}

const APPOINTMENT_SELECT = `
  SELECT a.id, a.patient_id, p.full_name, p.phone, a.scheduled_date, a.scheduled_time,
         a.duration_minutes, a.appointment_type, a.note, a.status, a.reminder_sent_at,
         a.doctor_id
    FROM appointments a JOIN patients p ON p.id = a.patient_id`;

export async function listAppointmentsByDate(date: string): Promise<Appointment[]> {
  await ensureSchema();
  const { rows } = await getPool().query<AppointmentRow>(
    `${APPOINTMENT_SELECT} WHERE a.scheduled_date = $1 ORDER BY a.scheduled_time`,
    [date],
  );
  return rows.map(toAppointment);
}

export async function getAppointment(id: number): Promise<Appointment | null> {
  await ensureSchema();
  const { rows } = await getPool().query<AppointmentRow>(
    `${APPOINTMENT_SELECT} WHERE a.id = $1`,
    [id],
  );
  return rows[0] ? toAppointment(rows[0]) : null;
}

export async function createAppointment(input: {
  patientId: number;
  date: string;
  time: string;
  durationMinutes: number;
  appointmentType?: string | null;
  note: string | null;
}): Promise<Appointment | null> {
  await ensureSchema();
  const { rows } = await getPool().query<{ id: number }>(
    `INSERT INTO appointments (patient_id, scheduled_date, scheduled_time, duration_minutes, appointment_type, note)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      input.patientId,
      input.date,
      input.time,
      input.durationMinutes,
      input.appointmentType ?? null,
      input.note,
    ],
  );
  const { rows: full } = await getPool().query<AppointmentRow>(
    `${APPOINTMENT_SELECT} WHERE a.id = $1`, [rows[0].id],
  );
  return full[0] ? toAppointment(full[0]) : null;
}

/** إدراج موعد على اتصال معاملة قائم — تُستدعى من داخل قفل اليوم الذرّي حصرًا. */
export async function insertAppointmentOnClient(
  client: DbClient,
  input: { patientId: number; date: string; time: string; durationMinutes: number; appointmentType?: string | null; note: string | null;
           /** جهة الطبيب الموعود لديه — يُسجّله الطبيب لنفسه عند الحجز. */
           doctorId?: number | null },
): Promise<Appointment | null> {
  const { rows } = await client.query<{ id: number }>(
    `INSERT INTO appointments (patient_id, scheduled_date, scheduled_time, duration_minutes, appointment_type, note, doctor_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [input.patientId, input.date, input.time, input.durationMinutes, input.appointmentType ?? null, input.note, input.doctorId ?? null],
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
  commit: (client: DbClient) => Promise<T>;
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
    const day = rows.map(toAppointment);
    const verdict = input.judge(day);
    if (!verdict.ok) {
      await client.query("ROLLBACK");
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
    `UPDATE visits SET status = 'waiting', chair = NULL, called_at = NULL,
            no_response_count = COALESCE(no_response_count, 0) + 1
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

/**
 * إعادة النداء على من هو في حالة نداء بالفعل.
 *
 * المريض لم ينتبه للشاشة أو خرج دقيقةً — الاستقبال تضغط «إعادة النداء» فتُحدَّث
 * ختمة النداء نفسها، فيرى التلفاز نداءً جديدًا: وميضٌ ونغمة ونطق من جديد، بلا
 * تحرير الكرسي ولا إعادة المريض إلى قائمة الانتظار فتضيع ترتيبته.
 */
export async function callVisitAgain(id: number): Promise<Visit | null> {
  await ensureSchema();
  const { rows } = await getPool().query<VisitRow>(
    `UPDATE visits SET called_at = NOW()
      WHERE id = $1 AND status = 'called' AND chair IS NOT NULL RETURNING *`,
    [id],
  );
  return rows[0] ? toVisit(rows[0]) : null;
}

/**
 * مرضى لديهم حالة تقويم قائمة — لبطاقة «جلسات التقويم اليوم» على شاشة الصالة.
 *
 * موعد «متابعة دورية» قد يكون لمريض تركيبات لا تقويم، ومريض تقويم قد يأتي لموعد
 * طوارئ. الفلتر بالاثنين معًا يعطي الرقم الذي يقصده المالك: كم مريض تقويم في
 * اليوم، بلا مبالغة ولا نقصان.
 */
export async function listOrthoActivePatientIds(): Promise<number[]> {
  await ensureSchema();
  const { rows } = await getPool().query<{ patient_id: number }>(
    `SELECT DISTINCT patient_id FROM ortho_cases WHERE status = 'active'`,
  );
  return rows.map((row) => row.patient_id);
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
export async function confirmBookingRequest(
  input: {
    id: number;
    date: string;
    time: string;
    durationMinutes: number;
  },
  runOn?: DbClient,
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

import {
  DEFAULT_LAB_DAYS,
  DEFAULT_LAB_SERVICES,
  PENDING_LAB_NAME,
  type LabOrder,
  type LabOrderStatus,
  type LabOrderTrackingEvent,
  type LabService,
} from "./lab";

interface LabOrderRow {
  id: number;
  patient_id: number;
  full_name: string;
  patient_number: string | null;
  phone: string | null;
  lab_name: string;
  lab_phone: string | null;
  party_id: number | null;
  lab_service_id: number | null;
  lab_service_name: string | null;
  work_type: string;
  details: string | null;
  tooth_numbers: string | null;
  shade: string | null;
  stump_shade: string | null;
  priority: string | null;
  impression_type: string | null;
  sent_date: Date;
  due_date: Date;
  status: string;
  received_at: Date | null;
  delivered_at: Date | null;
  doctor_id: number | null;
  doctor_name: string | null;
  visit_id: number | null;
  tooth_code: number | null;
  source: string | null;
  quality_check: string | null;
  quality_notes: string | null;
  remake_original_id: number | null;
  remake_reason: string | null;
  technician_name: string | null;
  note: string | null;
  cost_minor: string | null;
  cost_currency: string | null;
  created_at: Date;
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
    patientNumber: row.patient_number ?? null,
    patientPhone: row.phone,
    labName: row.lab_name,
    labPhone: row.lab_phone,
    partyId: row.party_id ?? null,
    labServiceId: row.lab_service_id ?? null,
    serviceName: row.lab_service_name ?? null,
    workType: row.work_type,
    details: row.details,
    toothNumbers: row.tooth_numbers ?? null,
    shade: row.shade ?? null,
    stumpShade: row.stump_shade ?? null,
    priority: row.priority === "urgent" || row.priority === "rush" ? row.priority : "normal",
    impressionType: (['"physical"', 'digital_scan', 'alginate', 'silicone', 'other'].includes(String(row.impression_type))
      ? row.impression_type
      : "physical") as LabOrder["impressionType"],
    sentDate: dateText(row.sent_date),
    dueDate: dateText(row.due_date),
    status: row.status as LabOrderStatus,
    receivedAt: row.received_at ? row.received_at.toISOString() : null,
    deliveredAt: row.delivered_at ? row.delivered_at.toISOString() : null,
    doctorId: row.doctor_id ?? null,
    doctorName: row.doctor_name ?? null,
    visitId: row.visit_id ?? null,
    toothCode: row.tooth_code ?? null,
    source: row.source === "auto" ? "auto" : row.source === "manual" ? "manual" : null,
    qualityCheck: (row.quality_check === "passed" || row.quality_check === "rejected"
      ? row.quality_check
      : "pending") as LabOrder["qualityCheck"],
    qualityNotes: row.quality_notes ?? null,
    remakeOriginalId: row.remake_original_id ?? null,
    remakeReason: row.remake_reason ?? null,
    technicianName: row.technician_name ?? null,
    note: row.note,
    createdAt: row.created_at.toISOString(),
    costMinor: row.cost_minor !== null ? Number(row.cost_minor) : null,
    costCurrency: (row.cost_currency as LabOrder["costCurrency"]) ?? null,
  };
}

const LAB_SELECT = `
  SELECT l.id, l.patient_id, p.full_name, p.patient_number, p.phone,
         l.lab_name, l.lab_phone, l.party_id,
         l.lab_service_id, ls.name AS lab_service_name,
         l.work_type, l.details,
         l.tooth_numbers, l.shade, l.stump_shade, l.priority, l.impression_type,
         l.sent_date, l.due_date, l.status, l.received_at, l.delivered_at,
         d.id AS doctor_id, d.name AS doctor_name,
         l.visit_id, l.tooth_code, l.source,
         l.quality_check, l.quality_notes, l.remake_original_id, l.remake_reason,
         l.technician_name, l.note, l.cost_minor, l.cost_currency, l.created_at
    FROM lab_orders l
    JOIN patients p ON p.id = l.patient_id
    LEFT JOIN lab_services ls ON ls.id = l.lab_service_id
    LEFT JOIN parties d ON d.id = l.doctor_id`;

/**
 * الأعمال المفتوحة وما أُنجز حديثًا.
 *
 * ما سُلّم قبل شهور لا يُحمَّل: القائمة أداة عمل يومية لا أرشيفًا، وصفحة تُحمّل مئات
 * الصفوف على هاتف الاستقبال تُفتح مرة ثم تُهجَر. الأرشيف الكامل يظهر في ملف المريض.
 * الفلاتر (المختبرات V2) اختيارية — بلاها سلوك الشاشة اليومية كما كان.
 */
export async function listLabOrders(filters?: {
  status?: string;
  patientId?: number;
  doctorId?: number;
  partyId?: number;
  limit?: number;
}): Promise<LabOrder[]> {
  await ensureSchema();
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (filters?.patientId) {
    conditions.push(`l.patient_id = $${idx++}`);
    params.push(filters.patientId);
  }
  if (filters?.doctorId) {
    conditions.push(`l.doctor_id = $${idx++}`);
    params.push(filters.doctorId);
  }
  if (filters?.partyId) {
    conditions.push(`l.party_id = $${idx++}`);
    params.push(filters.partyId);
  }
  if (filters?.status === "active") {
    conditions.push(`l.status IN ('needed', 'sent', 'in_progress', 'received', 'remake')`);
  } else if (filters?.status) {
    conditions.push(`l.status = $${idx++}`);
    params.push(filters.status);
  }

  const hasFilters = conditions.length > 0;
  const whereClause = hasFilters ? `WHERE ${conditions.join(" AND ")}` : "";
  // النافذة اليومية (بلا فلاتر): المفتوح + ما رُكّب خلال شهر — أداة عمل لا أرشيف.
  const openWindow = !hasFilters
    ? `AND (l.status IN ('needed', 'sent', 'in_progress', 'received')
            OR l.delivered_at > NOW() - INTERVAL '30 days')`
    : "";
  const limitClause = `LIMIT ${filters?.limit ? Math.min(filters.limit, 500) : 300}`;

  const { rows } = await getPool().query<LabOrderRow>(
    `${LAB_SELECT}
      ${whereClause} ${openWindow}
      ORDER BY l.due_date ASC, l.id DESC
      ${limitClause}`,
    params,
  );
  return rows.map(toLabOrder);
}

/** أمر مختبر واحد بالمعرف — لشاشة التتبع وتاريخ الأحداث (المختبرات V2). */
export async function getLabOrderById(id: number): Promise<LabOrder | null> {
  await ensureSchema();
  const { rows } = await getPool().query<LabOrderRow>(`${LAB_SELECT} WHERE l.id = $1`, [id]);
  return rows[0] ? toLabOrder(rows[0]) : null;
}

/** سجل أحداث أمر المختبر (المختبرات V2) — من حرّك الحالة ومتى وبأي ملاحظة. */
export async function labOrderEvents(id: number): Promise<LabOrderTrackingEvent[]> {
  await ensureSchema();
  const { rows } = await getPool().query<{
    id: number; lab_order_id: number; action: string; from_status: string | null;
    to_status: string | null; notes: string | null; actor: string; actor_role: string | null;
    created_at: Date;
  }>(
    `SELECT id, lab_order_id, action, from_status, to_status, notes, actor, actor_role, created_at
       FROM lab_order_tracking WHERE lab_order_id = $1 ORDER BY created_at ASC, id ASC LIMIT 100`,
    [id],
  );
  return rows.map((row) => ({
    id: row.id,
    labOrderId: row.lab_order_id,
    action: row.action,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    notes: row.notes,
    actor: row.actor,
    actorRole: row.actor_role,
    createdAt: row.created_at.toISOString(),
  }));
}

/** دليل خدمات المعمل (المختبرات V2). */
export async function listLabServices(activeOnly = true): Promise<LabService[]> {
  await ensureSchema();
  const { rows } = await getPool().query<{
    id: number; name: string; code: string | null; category: string;
    default_days: number; description: string | null; is_active: boolean;
    sort_order: number; created_at: Date;
  }>(
    `SELECT id, name, code, category, default_days, description, is_active, sort_order, created_at
       FROM lab_services ${activeOnly ? "WHERE is_active" : ""}
      ORDER BY sort_order, name`,
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    code: row.code,
    category: row.category as LabService["category"],
    defaultDays: row.default_days,
    description: row.description,
    isActive: row.is_active,
    sortOrder: row.sort_order,
    createdAt: row.created_at.toISOString(),
  }));
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
  /** رحلة المريض V2 (§١٩): زيارة مصدر الطلب وسنّه — الطلب السياقي من الإجراء. */
  visitId?: number | null;
  toothCode?: number | null;
  source?: "auto" | "manual";
  /** needed: طلبٌ من إجراءٍ لم يُرسل بعد — الزر السياقي قبل الإرسال الفعلي. */
  status?: "needed" | "sent";
  /** المختبرات السنية V2: الحقول السريرية الموسّعة — كلها اختيارية. */
  labServiceId?: number | null;
  doctorId?: number | null;
  toothNumbers?: string | null;
  shade?: string | null;
  stumpShade?: string | null;
  priority?: "normal" | "urgent" | "rush";
  impressionType?: "physical" | "digital_scan" | "alginate" | "silicone" | "other";
  technicianName?: string | null;
  actorRole?: string | null;
}): Promise<LabOrder | null> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // سنّ واحد في الزيارة طلبٌ واحد: الفهرس الفريد حارس التكرار، والطلب المتكرر
    // يُلغى بصمت لا يفشل الطلب — الزر مضغوط مرتين لا يعني عملًا اثنين للمختبر.
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO lab_orders (patient_id, lab_name, lab_phone, work_type, details, sent_date,
                               due_date, status, note, party_id, cost_minor, cost_currency,
                               visit_id, tooth_code, source,
                               lab_service_id, doctor_id, tooth_numbers, shade, stump_shade,
                               priority, impression_type, technician_name)
       VALUES ($1, $2, $3::text, $4, $5::text, $6::date, $7::date, $16, $8::text, $9::int, $10::bigint, $11::text,
               $12::int, $13::int, $14,
               $17::int, $18::int, $19::text, $20::text, $21::text,
               $22::text, $23::text, $24::text)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        input.patientId, input.labName, input.labPhone, input.workType,
        input.details, input.sentDate, input.dueDate, input.note,
        input.partyId, input.costMinor, input.costCurrency,
        input.visitId ?? null, input.toothCode ?? null, input.source === "auto" ? "auto" : "manual",
        input.status === "needed" ? "needed" : "sent",
        input.labServiceId ?? null, input.doctorId ?? null,
        input.toothNumbers ?? null, input.shade ?? null, input.stumpShade ?? null,
        input.priority ?? "normal", input.impressionType ?? "physical",
        input.technicianName ?? null,
      ],
    );
    if (!rows[0]) {
      await client.query("COMMIT");
      return null;
    }
    const orderId = rows[0].id;

    // سجل التتبع: الطلب يُولد بأثره الأول (المختبرات V2).
    await client.query(
      `INSERT INTO lab_order_tracking (lab_order_id, action, from_status, to_status, notes, actor, actor_role)
       VALUES ($1, 'create', NULL, $2, $3, $4, $5)`,
      [orderId, input.status === "needed" ? "needed" : "sent", input.workType,
       input.createdBy, input.actorRole ?? null],
    );

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
export async function setLabOrderStatus(
  id: number,
  status: LabOrderStatus,
  context?: { actor?: string; actorRole?: string | null; notes?: string | null },
): Promise<LabOrder | null> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // خريطة "إلى أين يحقّ الانتقال" — مصدرها الحالات نفسها:
    // - `sent` يُحقّ من `needed` (أُرسل فعلًا) ومن `received` (عاد للمعمل للتعديل).
    // - `needed` لا يُصار إليه يدويًا: يولّده توقيع الزيارة فقط.
    // - `in_progress` (المختبرات V2): المختبر بدأ العمل — من المرسَل فقط.
    // - `remake` (المختبرات V2): إعادة تصنيع — من المستلَم/المركّب، والسبب يُكتب.
    const allowedFrom: Record<LabOrderStatus, string[]> = {
      needed: [],
      sent: ["needed", "received", "in_progress"],
      in_progress: ["sent"],
      received: ["sent", "in_progress", "remake"],
      delivered: ["received"],
      remake: ["received", "delivered"],
      cancelled: ["needed", "sent", "in_progress", "received"],
    };
    const { rows } = await client.query<{ id: number; from_status: string }>(
      `UPDATE lab_orders SET
         status = $2,
         -- حين يُرسل الطلب فعلًا يبدأ عدّ مهلته من يوم إرساله لا يوم الزيارة.
         sent_date = CASE WHEN $2 = 'sent' AND status = 'needed' THEN CURRENT_DATE ELSE sent_date END,
         received_at  = CASE WHEN $2 = 'received'  THEN NOW() ELSE received_at  END,
         delivered_at = CASE WHEN $2 = 'delivered' THEN NOW() ELSE delivered_at END
       WHERE id = $1 AND status = ANY($3::text[])
       RETURNING id, status AS from_status`,
      [id, status, allowedFrom[status]],
    );
    if (!rows[0]) {
      await client.query("ROLLBACK");
      return null;
    }
    // سجل التتبع: كل انتقال يترك أثرًا بفاعله وتاريخه وملاحظته (المختبرات V2).
    await client.query(
      `INSERT INTO lab_order_tracking (lab_order_id, action, from_status, to_status, notes, actor, actor_role)
       VALUES ($1, 'status_change', $2, $3, $4, $5, $6)`,
      [id, rows[0].from_status, status, context?.notes ?? null,
       context?.actor ?? "system", context?.actorRole ?? null],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  const { rows: full } = await getPool().query<LabOrderRow>(`${LAB_SELECT} WHERE l.id = $1`, [id]);
  return full[0] ? toLabOrder(full[0]) : null;
}

/** يؤجّل موعد التسليم حين يعد المختبر بموعد جديد — بلا هذا يبقى «متأخرًا» بلا معنى. */
export async function setLabOrderDueDate(id: number, dueDate: string): Promise<LabOrder | null> {
  await ensureSchema();
  const { rows } = await getPool().query<{ id: number }>(
    `UPDATE lab_orders SET due_date = $2::date
      WHERE id = $1 AND status IN ('sent', 'needed') RETURNING id`,
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
  formatMoney,
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
      service_id: number | null; category: string | null; service_name: string | null;
    }>(
      `SELECT i.patient_id,
              i.id AS invoice_id,
              GREATEST(0, i.total_minor - i.discount_minor) AS net_minor,
              i.created_at,
              (i.created_at AT TIME ZONE $1)::date AS clinic_date,
              it.doctor_id,
              it.service_id,
              s.category,
              COALESCE(s.name, it.description) AS service_name,
              COALESCE(SUM(it.total_minor), 0) AS share_minor
         FROM invoices i
         LEFT JOIN invoice_items it ON it.invoice_id = i.id
         LEFT JOIN services s ON s.id = it.service_id
        WHERE i.status <> 'cancelled'
          AND i.patient_id IN (
                SELECT patient_id FROM invoices
                 WHERE status <> 'cancelled'
                   AND (created_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date
              )
        GROUP BY i.patient_id, i.id, i.total_minor, i.discount_minor, i.created_at, clinic_date, it.doctor_id, it.service_id, s.category, service_name`,
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
      /* حصة الطبيب تحمل هوية الخدمة وفئتها (محرك الوكيل المساعد): بها يجد
         النسبة الخاصة إن وُجدت — تقويم ٣٥٪ وزراعة ٣٠٪ على الطبيب نفسه. */
      invoice.doctorShares.push({
        doctorId: row.doctor_id,
        amountMinor: toMinor(row.share_minor),
        serviceId: row.service_id ?? undefined,
        serviceName: row.service_name ?? undefined,
        category: row.category ?? undefined,
      });
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

  /* إعدادات النسب المتقدمة للأطباء (محرك الوكيل المساعد) — من عمود JSON في
     حساباتهم المرتبطة بجهاتهم عبر party_id (V2 §٣٥). من لا إعداد له يبقى على
     نسبة جهته كما كان. */
  const userConfigRows = await pool.query<{ party_id: number; commission_config: string | null }>(
    `SELECT party_id, commission_config FROM users WHERE party_id IS NOT NULL AND commission_config IS NOT NULL`,
  );
  const configByDoctor = new Map<number, DoctorCommissionConfig>();
  for (const uRow of userConfigRows.rows) {
    if (uRow.commission_config) {
      configByDoctor.set(uRow.party_id, parseDoctorCommissionConfig(uRow.commission_config));
    }
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
      configByDoctor.size > 0 ? configByDoctor : percentByDoctor,
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
  /** جهة «طبيب» المرتبطة (§٣٥) — null لغير الأطباء أو غير المربوطين. */
  partyId: number | null;
  /** اسم الطبيب المربوط — يُعرَض في شاشة المستخدمين لا رقمُ جهةٍ لا يعني أحدًا. */
  partyName: string | null;
  /** التخصص والفرع والصلاحيات والعمولة (صلاحيات الوكيل المساعد). */
  specialty?: string | null;
  branch?: string | null;
  permissions?: DoctorPermissions | null;
  commissionConfig?: DoctorCommissionConfig | null;
}

export async function listUsers(): Promise<StaffAccount[]> {
  await ensureSchema();
  // كلمة المرور المجزّأة لا تخرج من هذه الدالة إطلاقًا: قائمة المستخدمين تُعرض في
  // شاشة، وما يُرسَل إلى المتصفّح يُقرأ.
  const { rows } = await getPool().query<{
    id: number; username: string; display_name: string;
    role: string; is_active: boolean; created_at: Date;
    party_id: number | null; party_name: string | null;
    specialty: string | null; branch: string | null;
    permissions: string | null; commission_config: string | null;
  }>(
    `SELECT u.id, u.username, u.display_name, u.role, u.is_active, u.created_at,
            u.party_id, p.name AS party_name,
            u.specialty, u.branch, u.permissions, u.commission_config
       FROM users u LEFT JOIN parties p ON p.id = u.party_id
      ORDER BY u.is_active DESC, u.created_at`,
  );
  return rows.map((row) => ({
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
    partyId: row.party_id ?? null,
    partyName: row.party_name ?? null,
    specialty: row.specialty ?? null,
    branch: row.branch ?? null,
    permissions: parseDoctorPermissions(row.permissions, row.role),
    commissionConfig: parseDoctorCommissionConfig(row.commission_config),
  }));
}

/**
 * يربط حساب مستخدمٍ بجهة «طبيب» — أو يفكّ الربط بـ null (§٣٥/٣٧).
 *
 * الجهة يجب أن تكون طبيبًا فاعلًا: ربطُ حسابٍ بمختبرٍ لا يعني شيئًا في عزل
 * المرضى، وهو خطأ إدخالٍ لا سياسة. والربط يُنفّذ من المدير فقط في المسار.
 */
export async function linkUserDoctor(userId: number, partyId: number | null): Promise<StaffAccount | null> {
  await ensureSchema();
  if (partyId !== null) {
    const { rows: doctor } = await getPool().query<{ id: number; name: string }>(
      `SELECT id, name FROM parties WHERE id = $1 AND kind = 'doctor' AND is_active LIMIT 1`,
      [partyId],
    );
    if (!doctor[0]) return null;
  }
  const { rows } = await getPool().query<{
    id: number; username: string; display_name: string;
    role: string; is_active: boolean; created_at: Date;
    party_id: number | null; party_name: string | null;
  }>(
    `UPDATE users SET party_id = $2 WHERE id = $1
     RETURNING id, username, display_name, role, is_active, created_at, party_id`,
    [userId, partyId],
  );
  if (!rows[0]) return null;
  let partyName: string | null = null;
  if (rows[0].party_id) {
    const { rows: nameRow } = await getPool().query<{ name: string }>(
      `SELECT name FROM parties WHERE id = $1`, [rows[0].party_id],
    );
    partyName = nameRow[0]?.name ?? null;
  }
  return {
    id: rows[0].id, username: rows[0].username, displayName: rows[0].display_name,
    role: rows[0].role, isActive: rows[0].is_active,
    createdAt: rows[0].created_at.toISOString(),
    partyId: rows[0].party_id ?? null, partyName,
  };
}

/**
 * هل هذا المريض من مرضى هذا الطبيب؟ (§٣٩)
 *
 * «مريضه» من كان في واحدةٍ من خمس: خطةٌ نشطة هو طبيبها الأساسي، أو زيارةٌ له
 * (منفَّذة أو قائمة)، أو زيارةٌ مخططة له، أو هو طبيبه الأساسي المسجّل، أو له
 * موعدٌ معه. الطبيب الذي عالج مريضًا مرّةً لا يفقد رؤيته بتغيّر الاستقبال.
 */
export async function doctorOwnsPatient(partyId: number, patientId: number): Promise<boolean> {
  await ensureSchema();
  const { rows } = await getPool().query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM treatment_plans t
        WHERE t.patient_id = $2 AND t.primary_doctor_id = $1 AND t.status = 'active'
       UNION ALL
       SELECT 1 FROM visits v WHERE v.patient_id = $2 AND v.doctor_id = $1
       UNION ALL
       SELECT 1 FROM planned_visits pv WHERE pv.patient_id = $2 AND pv.doctor_id = $1
       UNION ALL
       SELECT 1 FROM patients pd WHERE pd.id = $2 AND pd.primary_doctor_id = $1
       UNION ALL
       SELECT 1 FROM appointments a WHERE a.patient_id = $2 AND a.doctor_id = $1
     ) AS ok`,
    [partyId, patientId],
  );
  return Boolean(rows[0]?.ok);
}

/**
 * مرضى الطبيب من بين قائمة مرشّحين (صلاحيات الوكيل المساعد).
 *
 * للفلترة على يوم مواعيد: استعلامٌ واحد يعيد أرقام المرضى المملوكين من بين
 * المعروضين بدل استعلام لكل صف.
 */
export async function doctorOwnedPatientIds(
  partyId: number,
  patientIds: number[],
): Promise<Set<number>> {
  if (patientIds.length === 0) return new Set();
  await ensureSchema();
  const { rows } = await getPool().query<{ patient_id: number }>(
    `SELECT DISTINCT patient_id FROM (
       SELECT t.patient_id FROM treatment_plans t
        WHERE t.primary_doctor_id = $1 AND t.status = 'active'
       UNION ALL
       SELECT v.patient_id FROM visits v WHERE v.doctor_id = $1
       UNION ALL
       SELECT pv.patient_id FROM planned_visits pv WHERE pv.doctor_id = $1
       UNION ALL
       SELECT pd.id FROM patients pd WHERE pd.primary_doctor_id = $1
       UNION ALL
       SELECT ap.patient_id FROM appointments ap WHERE ap.doctor_id = $1
     ) owned WHERE patient_id = ANY($2::int[])`,
    [partyId, patientIds],
  );
  return new Set(rows.map((row) => Number(row.patient_id)));
}

/** مريض خطةٍ ما (صلاحيات الوكيل المساعد) — لربط حارس العزل بباب بنود الخطة. */
export async function getPlanPatientId(planId: number): Promise<number | null> {
  await ensureSchema();
  const { rows } = await getPool().query<{ patient_id: number }>(
    `SELECT patient_id FROM treatment_plans WHERE id = $1 LIMIT 1`,
    [planId],
  );
  return rows[0] ? Number(rows[0].patient_id) : null;
}

export async function updateUser(id: number, input: {
  displayName?: string; role?: string; isActive?: boolean; passwordHash?: string;
  specialty?: string; branch?: string;
  permissions?: DoctorPermissions; commissionConfig?: DoctorCommissionConfig;
}): Promise<StaffAccount | null> {
  await ensureSchema();
  const { rows } = await getPool().query<{
    id: number; username: string; display_name: string;
    role: string; is_active: boolean; created_at: Date;
    party_id: number | null; party_name: string | null;
    specialty: string | null; branch: string | null;
    permissions: string | null; commission_config: string | null;
  }>(
    `UPDATE users SET
       display_name     = COALESCE($2::text, display_name),
       role             = COALESCE($3::text, role),
       is_active        = COALESCE($4::boolean, is_active),
       password_hash    = COALESCE($5::text, password_hash),
       specialty        = COALESCE($6::text, specialty),
       branch           = COALESCE($7::text, branch),
       permissions      = COALESCE($8::text, permissions),
       commission_config = COALESCE($9::text, commission_config)
     WHERE id = $1
     RETURNING id, username, display_name, role, is_active, created_at, party_id,
               specialty, branch, permissions, commission_config`,
    [
      id, input.displayName ?? null, input.role ?? null, input.isActive ?? null,
      input.passwordHash ?? null, input.specialty ?? null, input.branch ?? null,
      input.permissions ? JSON.stringify(input.permissions) : null,
      input.commissionConfig ? JSON.stringify(input.commissionConfig) : null,
    ],
  );
  if (!rows[0]) return null;
  let partyName: string | null = null;
  if (rows[0].party_id) {
    const { rows: nameRow } = await getPool().query<{ name: string }>(
      `SELECT name FROM parties WHERE id = $1`, [rows[0].party_id],
    );
    partyName = nameRow[0]?.name ?? null;
  }
  return {
    id: rows[0].id,
    username: rows[0].username,
    displayName: rows[0].display_name,
    role: rows[0].role,
    isActive: rows[0].is_active,
    createdAt: rows[0].created_at.toISOString(),
    partyId: rows[0].party_id ?? null,
    partyName,
    specialty: rows[0].specialty ?? null,
    branch: rows[0].branch ?? null,
    permissions: parseDoctorPermissions(rows[0].permissions, rows[0].role),
    commissionConfig: parseDoctorCommissionConfig(rows[0].commission_config),
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
import {
  DEFAULT_VISIT_MINUTES, normalizeBillingRule, normalizeSessionCount, plannedVisitTitle,
  priceForSession, sessionPriceNote, suggestVisitMinutes,
  treatmentFinancialSeparation, labWorkForCategory, sortTimeline,
  type BillingRule, type PlannedVisitStatus, type TimelineEvent,
} from "./workflow";

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
  /** ── الرحلة V2 ── */
  /** الزيارة المخطَّطة التي جاءت منها هذه الزيارة إن بدأت من الجلسة القادمة. */
  plannedVisit: {
    id: number; title: string; sequence: number;
    planTitle: string | null; doctorId: number | null; durationMinutes: number;
  } | null;
  /** آخر زيارة موقَّعة قبل هذه — «ما عُمل آخر مرة» يُقرأ لا يُخمَّن. */
  previousVisit: {
    id: number; date: string; treatmentDone: string | null;
    nextPlan: string | null; proceduresSummary: string | null;
  } | null;
  /** الجلسات المفتوحة المتبقّية من الخطط الجارية — «العلاج المتبقّي». */
  outstanding: {
    planItemId: number; serviceId: number | null; planTitle: string; serviceName: string;
    toothCode: number | null; billingRule: BillingRule;
    sessionCount: number; doneSessions: number; unitPriceMinor: number;
    quantity: number; status: string;
  }[];
  /** بنود الجلسات المرتبطة بالزيارة الحالية — أسعارها من الخطة لا من الشاشة. */
  sessionPricing: {
    planItemId: number; procedureId: number;
    sessionIndex: number; sessionCount: number;
    priceMinor: number; note: string;
  }[];
  /** طلبات المختبر المرتبطة بهذه الزيارة (§١٩) — الموجود لا يُطلب مرتين. */
  labOrders: {
    id: number; workType: string; toothCode: number | null;
    status: string; labName: string;
  }[];
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
  id: number; service_id: number; service_name: string; category: string | null;
  doctor_id: number | null; tooth_code: number | null; surfaces: string | null;
  quantity: number; unit_price_minor: string; plan_item_id: number | null; note: string | null;
}

const toProcedureLine = (row: ProcedureRow): ProcedureLine => ({
  id: row.id,
  serviceId: row.service_id,
  serviceName: row.service_name,
  category: row.category,
  toothCode: row.tooth_code,
  surfaces: row.surfaces,
  quantity: row.quantity,
  unitPriceMinor: toMinor(row.unit_price_minor),
  totalMinor: row.quantity * toMinor(row.unit_price_minor),
  doctorId: row.doctor_id,
  planItemId: row.plan_item_id,
  note: row.note,
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
    `SELECT p.id, p.service_id, s.name AS service_name, s.category, p.doctor_id,
            p.tooth_code, p.surfaces, p.quantity, p.unit_price_minor, p.plan_item_id, p.note
       FROM visit_procedures p JOIN services s ON s.id = p.service_id
      WHERE p.visit_id = $1 ORDER BY p.id`,
    [visitId],
  );
  const procedures = procedureRows.map(toProcedureLine);
  const row = rows[0];
  const patientId = await previewPatientId(pool, row);
  const plan = await visitPlanContext(pool, patientId, procedures);
  const ortho = await visitOrthoContext(patientId);
  const workflow = await visitWorkflowContext(pool, visitId, patientId, procedures);
  // طلبات المختبر المرتبطة بالزيارة — ليعرف الزر السياقي ما هو موجود سلفًا (§١٩).
  const { rows: visitLabRows } = await pool.query<{
    id: number; work_type: string; tooth_code: number | null; status: string; lab_name: string;
  }>(
    `SELECT id, work_type, tooth_code, status, lab_name
       FROM lab_orders WHERE visit_id = $1 AND status <> 'cancelled' ORDER BY id`,
    [visitId],
  );
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
    plannedVisit: workflow.plannedVisit,
    previousVisit: workflow.previousVisit,
    outstanding: workflow.outstanding,
    sessionPricing: workflow.sessionPricing,
    labOrders: visitLabRows.map((labRow) => ({
      id: labRow.id, workType: labRow.work_type,
      toothCode: labRow.tooth_code ?? null, status: labRow.status, labName: labRow.lab_name,
    })),
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
  pool: DbPool,
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
  pool: DbPool,
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

/**
 * سياق رحلة المريض كما يحتاجه الطبيب على الكرسي — الرحلة V2.
 *
 * الزيارة لا تُفتح صفحةً فارغة: يظهر للطبيب **ما عُمل آخر مرة** (تُقرأ لا تُخمَّن)،
 * و**الجلسات المخطَّطة لهذه الزيارة** إن بدأت من زيارةٍ مخطَّطة، و**العلاج المتبقّي**
 * من خطط المريض، و**سعر كل جلسة من الخطة** وفق قاعدة الفوترة — لا من ذاكرة أحد.
 */
async function visitWorkflowContext(
  pool: DbPool,
  visitId: number,
  patientId: number | null,
  procedures: ProcedureLine[],
): Promise<{
  plannedVisit: ClinicalVisit["plannedVisit"];
  previousVisit: ClinicalVisit["previousVisit"];
  outstanding: ClinicalVisit["outstanding"];
  sessionPricing: ClinicalVisit["sessionPricing"];
}> {
  const empty = {
    plannedVisit: null, previousVisit: null,
    outstanding: [] as ClinicalVisit["outstanding"],
    sessionPricing: [] as ClinicalVisit["sessionPricing"],
  };
  if (!patientId) return empty;

  // ١) الزيارة المخطَّطة التي بدأت منها هذه الزيارة
  const { rows: plannedRows } = await pool.query<{
    id: number; title: string; sequence: number; doctor_id: number | null;
    duration_minutes: number; plan_title: string | null;
  }>(
    `SELECT v.id, v.title, v.sequence, v.doctor_id, v.duration_minutes, t.title AS plan_title
       FROM visits cur
       JOIN planned_visits v ON v.id = cur.planned_visit_id
       LEFT JOIN treatment_plans t ON t.id = v.plan_id
      WHERE cur.id = $1`,
    [visitId],
  );
  const plannedVisit = plannedRows[0]
    ? {
        id: plannedRows[0].id, title: plannedRows[0].title,
        sequence: plannedRows[0].sequence, planTitle: plannedRows[0].plan_title,
        doctorId: plannedRows[0].doctor_id,
        durationMinutes: plannedRows[0].duration_minutes,
      }
    : null;

  // ٢) آخر زيارة موقَّعة قبل هذه — تاريخها وما نُفّذ فيها
  const { rows: previousRows } = await pool.query<{
    id: number; arrived_at: Date; treatment_done: string | null; next_plan: string | null;
    procedures: string | null;
  }>(
    `SELECT v.id, v.arrived_at, v.treatment_done, v.next_plan,
            (SELECT string_agg(s.name || COALESCE(' — سن ' || p.tooth_code::text, ''),
                               ' · ' ORDER BY p.id)
               FROM visit_procedures p JOIN services s ON s.id = p.service_id
              WHERE p.visit_id = v.id) AS procedures
       FROM visits v
      WHERE v.patient_id = $1 AND v.signed_at IS NOT NULL AND v.id <> $2
      ORDER BY v.signed_at DESC LIMIT 1`,
    [patientId, visitId],
  );
  const previousVisit = previousRows[0]
    ? {
        id: previousRows[0].id,
        date: previousRows[0].arrived_at.toISOString().slice(0, 10),
        treatmentDone: previousRows[0].treatment_done,
        nextPlan: previousRows[0].next_plan,
        proceduresSummary: previousRows[0].procedures,
      }
    : null;

  // ٣) العلاج المتبقّي: بنود الخطط الجارية ولم تكتمل، مع تقدّم جلساتها
  const { rows: itemRows } = await pool.query<{
    id: number; service_id: number | null; plan_title: string; service_name: string;
    tooth_code: number | null; billing_rule: string; session_count: number;
    unit_price_minor: string; quantity: number; status: string; done_sessions: string;
  }>(
    `SELECT i.id, i.service_id, i.service_name, i.tooth_code, i.billing_rule, i.session_count,
            i.unit_price_minor, i.quantity, i.status, t.title AS plan_title,
            (SELECT COUNT(*) FROM treatment_sessions s
              WHERE s.plan_item_id = i.id AND s.status = 'done')::text AS done_sessions
       FROM plan_items i JOIN treatment_plans t ON t.id = i.plan_id
      WHERE t.patient_id = $1 AND t.status = 'active'
        AND i.status IN ('planned', 'in_progress')
      ORDER BY i.sort_order, i.id`,
    [patientId],
  );
  const outstanding = itemRows.map((item) => ({
    planItemId: item.id,
    serviceId: item.service_id,
    planTitle: item.plan_title,
    serviceName: item.service_name,
    toothCode: item.tooth_code,
    billingRule: item.billing_rule as BillingRule,
    sessionCount: item.session_count,
    doneSessions: Number(item.done_sessions),
    unitPriceMinor: toMinor(item.unit_price_minor),
    quantity: item.quantity,
    status: item.status,
  }));

  // ٤) أسعار الجلسات المرتبطة بإجراءات هذه الزيارة — من الخطة وفق قاعدة الفوترة.
  //    سطران لنفس البند في زيارةٍ واحدة = جلستان متتاليتان، لا جلسةٌ مكرَّرة.
  const linked = procedures.filter((line) => line.planItemId !== null);
  const doneByItem = new Map<number, number>(
    itemRows.map((item) => [item.id, Number(item.done_sessions)]),
  );
  const seenInVisit = new Map<number, number>();
  const sessionPricing: ClinicalVisit["sessionPricing"] = [];
  for (const line of linked) {
    const planItemId = line.planItemId as number;
    const item = itemRows.find((row) => row.id === planItemId);
    const sessionCount = item ? item.session_count : 1;
    const rule = (item?.billing_rule ?? "on_completion") as BillingRule;
    const done = doneByItem.get(planItemId) ?? 0;
    const occurrence = (seenInVisit.get(planItemId) ?? 0) + 1;
    seenInVisit.set(planItemId, occurrence);
    const sessionIndex = done + occurrence;
    const lineTotal = item ? toMinor(item.unit_price_minor) * item.quantity : line.totalMinor;
    sessionPricing.push({
      planItemId,
      procedureId: line.id,
      sessionIndex,
      sessionCount,
      priceMinor: item
        ? priceForSession(rule, lineTotal, sessionCount, sessionIndex)
        : line.unitPriceMinor,
      note: sessionPriceNote(rule, sessionIndex, sessionCount),
    });
  }

  return { plannedVisit, previousVisit, outstanding, sessionPricing };
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

    /*
     * سعر الإجراء المرتبط ببند خطة يأتي من الخطة لا من الطلب — الرحلة V2.
     *
     * الواجهة تقترح والخادم يقرّ: ما دام الإجراء من «مخطَّط لليوم» فسعرُه قاعدةُ
     * فوترة البند (عند البدء/الإكمال/لكل جلسة)، وكل محاولة لتغييره من الطلب تُتجاهل.
     * وبهذا لا يُعاد إدخال السعر في الزيارة الطبيعية أبدًا — ومن غيّر سعر الخطة غيّره
     * في الخطة حيث يُوثَّق ويُدقَّق، لا على الكرسي.
     */
    const linkedItems = await loadPlanItemsForPricing(
      client, input.procedures.map((p) => p.planItemId).filter((id): id is number => id !== null && id !== undefined),
    );

    await client.query(`DELETE FROM visit_procedures WHERE visit_id = $1`, [input.visitId]);
    const seenInVisit = new Map<number, number>();
    for (const procedure of input.procedures) {
      let quantity = Math.max(1, Math.round(procedure.quantity));
      let unitPriceMinor = Math.max(0, Math.round(procedure.unitPriceMinor));

      const item = procedure.planItemId ? linkedItems.get(procedure.planItemId) : undefined;
      if (item) {
        const lineTotal = item.quantity * toMinor(item.unit_price_minor);
        const occurrence = (seenInVisit.get(item.id) ?? 0) + 1;
        seenInVisit.set(item.id, occurrence);
        // الجلسة تُسعَّر سطرًا واحدًا: نصيبها من إجمالي البند وفق قاعدة الفوترة.
        quantity = 1;
        unitPriceMinor = priceForSession(
          item.billing_rule as BillingRule, lineTotal, item.session_count,
          item.done_sessions + occurrence,
        );
      }

      await client.query(
        `INSERT INTO visit_procedures
           (visit_id, service_id, doctor_id, tooth_code, surfaces, quantity, unit_price_minor, note, plan_item_id)
         VALUES ($1, $2, $3::int, $4::int, $5::text, $6, $7, $8::text, $9::int)`,
        [input.visitId, procedure.serviceId, procedure.doctorId, procedure.toothCode,
         normalizeSurfaces(procedure.surfaces), quantity, unitPriceMinor, procedure.note,
         procedure.planItemId ?? null],
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
 * بنود الخطة المقفلة للتسعير — مع جلساتها المنجزة قبل هذه الزيارة.
 *
 * يُقرأ **داخل معاملة الحفظ** فيتسقّ مع التوقيع: بندٌ أُنجزت جلسةٌ منه في زيارةٍ
 * موازية تُقرأ هنا بجلسةٍ أقلّ، فيزيد سعر جلسته القادمة بمقدار ما تقدّم.
 */
async function loadPlanItemsForPricing(
  client: DbClient,
  planItemIds: number[],
): Promise<Map<number, {
  id: number; quantity: number; unit_price_minor: string;
  billing_rule: string; session_count: number; done_sessions: number;
}>> {
  const map = new Map<number, {
    id: number; quantity: number; unit_price_minor: string;
    billing_rule: string; session_count: number; done_sessions: number;
  }>();
  if (planItemIds.length === 0) return map;
  const { rows } = await client.query<{
    id: number; quantity: number; unit_price_minor: string;
    billing_rule: string; session_count: number; done_sessions: string;
  }>(
    `SELECT i.id, i.quantity, i.unit_price_minor, i.billing_rule, i.session_count,
            (SELECT COUNT(*) FROM treatment_sessions s
              WHERE s.plan_item_id = i.id AND s.status = 'done')::text AS done_sessions
       FROM plan_items i JOIN treatment_plans t ON t.id = i.plan_id
      WHERE i.id = ANY($1::int[]) AND t.status = 'active'
        FOR UPDATE OF i`,
    [planItemIds],
  );
  for (const row of rows) {
    map.set(row.id, { ...row, done_sessions: Number(row.done_sessions) });
  }
  return map;
}

/**
 * توقيع الزيارة — **الحلقة الأساسية للنظام كله**.
 *
 * عملٌ واحد في **معاملة واحدة** يُنتج آثار الزيارة كلها: توقيعها، وفاتورةٌ من
 * الإجراءات بأسعار الخطة وفق قواعد الفوترة، وتحديث المخطط السني، وتقدّم جلسات
 * البنود، وإغلاق الزيارة المخطَّطة، واقتراح الزيارة المخطَّطة التالية، وتحديث
 * الموعد. إمّا كلها أو لا شيء — والدستور §٤٠.
 *
 * ولماذا معاملة واحدة لا خطوات: لأن الفشل بين الخطوتين هو الكارثة نفسها التي جاء
 * الترابط ليمنعها — زيارةٌ موقَّعة بلا فاتورة (عملٌ ضاع)، أو فاتورةٌ بلا زيارة
 * (مطالبةٌ بلا سند)، أو جلسةٌ منجَزة والبند يقول إنها لم تبدأ.
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
  /** ── الرحلة V2 ── */
  /** استحقاق هذه الزيارة وفق قواعد الفوترة. */
  duesMinor: number;
  /** الجلسات التي أُنجزت في هذه الزيارة. */
  sessionsCompleted: number;
  /** الزيارة المخطَّطة المقترحة التالية — تُحوَّل موعدًا بتاريخٍ ووقت فقط. */
  nextPlannedVisit: { id: number; title: string; sequence: number; durationMinutes: number } | null;
  /** طلبات مختبر تولّدت تلقائيًا من إجراءات هذه الزيارة (§١٩). */
  labOrdersCreated: number;
  /** حركات مستهلكات خُصمت تلقائيًا وفق ربط الخدمات بالمواد (§٢٠). */
  materialsDeducted: number;
  reason: "not_found" | "already_signed" | "empty" | "no_patient" | null;
}> {
  const existing = await getClinicalVisit(input.visitId);
  const emptyResult = (reason: "not_found" | "already_signed" | "empty" | "no_patient" | null, extra?: {
    visit?: ClinicalVisit; invoiceId?: number | null;
  }) => ({
    visit: extra?.visit ?? null, invoiceId: extra?.invoiceId ?? null,
    chartUpdates: 0, planItemsDone: 0, duesMinor: 0, sessionsCompleted: 0,
    nextPlannedVisit: null, labOrdersCreated: 0, materialsDeducted: 0, reason,
  });

  if (!existing) return emptyResult("not_found");
  if (existing.status === "signed") {
    return emptyResult("already_signed", { visit: existing, invoiceId: existing.invoiceId });
  }
  const check = canSign({
    status: existing.status,
    procedures: existing.procedures,
    diagnosis: existing.diagnosis,
    treatmentDone: existing.treatmentDone,
  });
  if (!check.ok) return emptyResult("empty", { visit: existing });

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const { rows: locked } = await client.query<{
      id: number; patient_name: string; patient_phone: string | null; patient_id: number | null;
      planned_visit_id: number | null; doctor_id: number | null; appointment_id: number | null;
    }>(
      `SELECT id, patient_name, patient_phone, patient_id, planned_visit_id, doctor_id, appointment_id
         FROM visits WHERE id = $1 AND signed_at IS NULL FOR UPDATE`,
      [input.visitId],
    );
    if (!locked[0]) {
      return emptyResult("already_signed", { visit: existing });
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

    /*
     * الجلسات أولًا — لأن الفوترة تتبعها.
     *
     * كل إجراء مربوط ببند خطة يُنجز جلسةً من ذلك البند (بالترتيب)، وسعره في الفاتورة
     * هو نصيب جلسته وفق قاعدة الفوترة — وقد حُسب عند الحفظ وأُعيد التأكد منه هنا.
     * والبند يصير «مكتملًا» فقط حين تكتمل جلساته كلها؛ وإلا فهو «قيد التنفيذ».
     */
    const linkedProcedures = existing.procedures.filter((line) => line.planItemId !== null);
    const unlinkedProcedures = existing.procedures.filter((line) => line.planItemId === null);

    const sessionOutcome = await progressTreatmentSessions({
      client, patientId, visitId: input.visitId, linkedProcedures, signedBy: input.signedBy,
    });

    /*
     * الفاتورة من الإجراءات — وكل سطر يعرف مصدره.
     *
     * `source_type = 'visit_procedure'` + `source_id` على كل بند: الفهرس الفريد في
     * القاعدة يرفض فوترة المصدر نفسه مرتين مهما اختلف الباب الذي دخلت منه — وهو
     * الضمانة البنيوية لقاعدة «لا فوترة مزدوجة».
     */
    let invoiceId: number | null = null;
    const duesMinor = existing.totalMinor;
    if (existing.procedures.length > 0) {
      const { rows: invoiceRows } = await client.query<{ id: number }>(
        `INSERT INTO invoices (invoice_number, patient_id, base_currency, total_minor, discount_minor, note, created_by)
         VALUES ('INV-' || LPAD(nextval('invoice_number_seq')::text, 5, '0'),
                 $1, $2, $3, 0, $4::text, $5)
         RETURNING id`,
        [patientId, input.baseCurrency, duesMinor,
         `من الزيارة رقم ${existing.id}`, input.signedBy],
      );
      invoiceId = invoiceRows[0].id;

      for (const line of existing.procedures) {
        const session = sessionOutcome.byProcedure.get(line.id);
        const description = session
          ? `${line.serviceName}${line.toothCode ? ` — سن ${line.toothCode}` : ""} (جلسة ${session.sessionIndex} من ${session.sessionCount})`
          : line.toothCode ? `${line.serviceName} — سن ${line.toothCode}` : line.serviceName;
        await client.query(
          `INSERT INTO invoice_items
             (invoice_id, service_id, doctor_id, description, quantity, unit_price_minor, total_minor,
              source_type, source_id)
           VALUES ($1, $2, $3::int, $4, $5, $6, $7, 'visit_procedure', $8)`,
          [invoiceId, line.serviceId, line.doctorId, description,
           line.quantity, line.unitPriceMinor, line.totalMinor, line.id],
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
     * بنود الخطة غير المرتبطة تُشطب بالطريقة القديمة — مطابقة الخدمة والسن.
     *
     * مسار الترابط أعلاه يخص الإجراءات التي أُضيفت من «مخطَّط لليوم»؛ وهذا يخص ما
     * أُضيف يدويًا ثم صادف بندًا مفتوحًا للخدمة والسن نفسهما. والبندان المتقاطعان
     * محجوبان: ما استهلكته الجلسات لا تدخله المطابقة، فلا يُشطب بندٌ مرتين.
     */
    let planItemsDone = sessionOutcome.itemsDone;
    if (unlinkedProcedures.length > 0) {
      const { rows: openItems } = await client.query<{
        id: number; service_id: number | null; tooth_code: number | null;
        quantity: number; unit_price_minor: string; status: string;
      }>(
        `SELECT i.id, i.service_id, i.tooth_code, i.quantity, i.unit_price_minor, i.status
           FROM plan_items i JOIN treatment_plans t ON t.id = i.plan_id
          WHERE t.patient_id = $1 AND t.status = 'active' AND t.consent_at IS NOT NULL
            AND i.status = 'planned'
            AND i.id <> ALL($2::bigint[])
          ORDER BY i.id
            FOR UPDATE OF i`,
        [patientId, sessionOutcome.touchedItemIds],
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
        unlinkedProcedures.map((line) => ({
          serviceId: line.serviceId, toothCode: line.toothCode, quantity: line.quantity,
        })),
      );

      if (matched.length > 0) {
        const { rowCount } = await client.query(
          `UPDATE plan_items SET status = 'done', visit_id = $2, done_at = NOW()
            WHERE id = ANY($1::int[]) AND status = 'planned'`,
          [matched, input.visitId],
        );
        planItemsDone += rowCount ?? 0;
        // جلسةٌ ضمنية لكل بندٍ شُطب بالطريقة القديمة — ليظل عدّ الجلسات موحّدًا.
        for (const itemId of matched) {
          await client.query(
            `INSERT INTO treatment_sessions (plan_item_id, sequence, status, visit_id, completed_at, title)
             SELECT $1, 1, 'done', $2, NOW(), 'تنفيذ'
              WHERE NOT EXISTS (SELECT 1 FROM treatment_sessions WHERE plan_item_id = $1)`,
            [itemId, input.visitId],
          );
        }
      }
    }

    /*
     * إغلاق الزيارة المخطَّطة ومواعيدها، ثم اقتراح الزيارة التالية.
     *
     * الزيارة المخطَّطة التي بدأت منها هذه الزيارة تُختم «منجَزة»، وموعدُها إن كان
     * ما زال مفتوحًا يُختم معها — لا يبقى «وصل» إلى الأبد. ثم يشتقّ النظام الجلسة
     * القادمة من الجلسات المتبقّية: زيارةٌ مخطَّطة جديدة يحوّلها الاستقبال موعدًا
     * بتاريخٍ ووقت فقط — لا يُعاد كتابة العلاج.
     */
    const nextPlannedVisit = await closePlannedVisitAndSuggestNext({
      client, patientId, visitId: input.visitId,
      plannedVisitId: locked[0].planned_visit_id,
      appointmentId: locked[0].appointment_id,
      visitDoctorId: locked[0].doctor_id ?? existing.doctorId,
    });

    /*
     * طلب المختبر من الإجراء (§١٩): التاج والجسر والقشرة تُؤخذ طبعتها اليوم.
     *
     * يُنشأ الطلب تلقائيًا في المعاملة نفسه بحالة «لم يُرسل بعد» — فالمختبرُ لم
     * يستلم شيئًا بعد، ومن يعمل مع المختبر يكمله ببيانات المختبر من لوحة الأعمال.
     * والفهرس الفريد على (الزيارة، السن) يمنع تكرار الطلب مهما أُعيد التوقيع.
     */
    const labOrdersCreated = await createAutoLabOrders({
      client, patientId, visitId: input.visitId, procedures: existing.procedures,
    });

    /*
     * خصم المستهلكات (§٢٠): ما يستهلكه الإجراء يُعرّف مرّة في ربط الخدمات بالمواد،
     * ويُخصم هنا تلقائيًا — فيصبح العدّ حقيقيًا بلا اعتماد على ذاكرة أحد.
     * والحركة تحمل الزيارة والمريض، فتظهر في سجل مستهلكات المريض مرتبطة بزيارته.
     */
    const materialsDeducted = await deductServiceMaterials({
      client, patientId, visitId: input.visitId, procedures: existing.procedures,
      signedBy: input.signedBy,
    });

    await client.query(
      `UPDATE visits SET signed_at = NOW(), signed_by = $2, invoice_id = $3::int,
              status = 'done', finished_at = COALESCE(finished_at, NOW())
        WHERE id = $1`,
      [input.visitId, input.signedBy, invoiceId],
    );

    await client.query("COMMIT");
    return {
      visit: await getClinicalVisit(input.visitId),
      invoiceId, chartUpdates, planItemsDone,
      duesMinor, sessionsCompleted: sessionOutcome.sessionsCompleted,
      nextPlannedVisit, labOrdersCreated, materialsDeducted, reason: null,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * تقدّم جلسات البنود المنجزة في هذه الزيارة — قلب الرحلة V2.
 *
 * لكل إجراءٍ مربوطٍ ببند: تُنجَز **الجلسة المفتوحة التالية** لذلك البند (بالترتيب)،
 * وتُحدَّث حالة البند من جلساته: كلها منجَزة → «مكتمل»، وبعضها → «قيد التنفيذ» مع
 * ختم بدئه. والبنود التي تكتمل كلها تُكمل خطتها تلقائيًا.
 */
async function progressTreatmentSessions(input: {
  client: DbClient;
  patientId: number;
  visitId: number;
  linkedProcedures: ProcedureLine[];
  signedBy: string;
}): Promise<{
  sessionsCompleted: number;
  itemsDone: number;
  touchedItemIds: number[];
  byProcedure: Map<number, { sessionIndex: number; sessionCount: number }>;
}> {
  const byProcedure = new Map<number, { sessionIndex: number; sessionCount: number }>();
  const touchedItemIds: number[] = [];
  let sessionsCompleted = 0;
  let itemsDone = 0;

  if (input.linkedProcedures.length === 0) {
    return { sessionsCompleted, itemsDone, touchedItemIds, byProcedure };
  }

  // البنود المرتبطة مقفلةً بقصدها: جلسةٌ تُنجَز مرتين لأن أحدهم أعاد الحفظ مستحيلة.
  const ids = input.linkedProcedures.map((line) => line.planItemId as number);
  const { rows: itemRows } = await input.client.query<{
    id: number; plan_id: number; service_name: string; tooth_code: number | null;
    session_count: number; status: string;
  }>(
    `SELECT i.id, i.plan_id, i.service_name, i.tooth_code, i.session_count, i.status
       FROM plan_items i JOIN treatment_plans t ON t.id = i.plan_id
      WHERE i.id = ANY($1::int[]) AND t.status = 'active'
        FOR UPDATE OF i`,
    [ids],
  );
  const itemsById = new Map(itemRows.map((row) => [row.id, row]));

  for (const line of input.linkedProcedures) {
    const item = itemsById.get(line.planItemId as number);
    if (!item) continue;

    // الجلسة المفتوحة التالية — أو تُنشأ ضمنيةً لبندٍ بُني بلا جلسات (مسار قديم).
    const { rows: sessionRows } = await input.client.query<{ id: number; sequence: number }>(
      `SELECT id, sequence FROM treatment_sessions
        WHERE plan_item_id = $1 AND status IN ('planned', 'in_progress')
        ORDER BY sequence LIMIT 1 FOR UPDATE`,
      [item.id],
    );
    let sessionIndex: number;
    if (sessionRows[0]) {
      sessionIndex = sessionRows[0].sequence;
      await input.client.query(
        `UPDATE treatment_sessions
            SET status = 'done', visit_id = $2, completed_at = NOW()
          WHERE id = $1`,
        [sessionRows[0].id, input.visitId],
      );
    } else {
      const { rows: doneCount } = await input.client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM treatment_sessions
          WHERE plan_item_id = $1 AND status = 'done'`,
        [item.id],
      );
      sessionIndex = Number(doneCount[0]?.n ?? 0) + 1;
      if (sessionIndex > item.session_count) continue; // جلسة زائدة عن العدّد: لا تُنجَز.
      await input.client.query(
        `INSERT INTO treatment_sessions (plan_item_id, sequence, status, visit_id, completed_at, title)
         VALUES ($1, $2, 'done', $3, NOW(), NULL)`,
        [item.id, sessionIndex, input.visitId],
      );
    }
    sessionsCompleted += 1;
    touchedItemIds.push(item.id);
    byProcedure.set(line.id, { sessionIndex, sessionCount: item.session_count });

    // حالة البند من جلساته — لا رقمٌ يُكتب فوقه.
    const { rows: counts } = await input.client.query<{
      done: string; live: string;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'done')::text AS done,
         COUNT(*) FILTER (WHERE status <> 'skipped')::text AS live
       FROM treatment_sessions WHERE plan_item_id = $1`,
      [item.id],
    );
    const done = Number(counts[0]?.done ?? 0);
    const live = Number(counts[0]?.live ?? 0);
    if (live > 0 && done >= live) {
      await input.client.query(
        `UPDATE plan_items SET status = 'done', visit_id = $2, done_at = NOW()
          WHERE id = $1 AND status <> 'done'`,
        [item.id, input.visitId],
      );
      itemsDone += 1;
    } else {
      await input.client.query(
        `UPDATE plan_items SET status = 'in_progress',
                started_at = COALESCE(started_at, NOW())
          WHERE id = $1 AND status = 'planned'`,
        [item.id],
      );
    }
  }

  // خطةٌ اكتملت بنودها كلها تُكمل هي نفسها — لا يبقى «جارية» بلا عمل.
  const planIds = [...new Set(itemRows.map((row) => row.plan_id))];
  for (const planId of planIds) {
    await input.client.query(
      `UPDATE treatment_plans t SET status = 'completed'
        WHERE t.id = $1 AND t.status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM plan_items i
             WHERE i.plan_id = t.id AND i.status NOT IN ('done', 'cancelled')
          )`,
      [planId],
    );
  }

  return { sessionsCompleted, itemsDone, touchedItemIds, byProcedure };
}

/**
 * يختم الزيارة المخطَّطة، ويقترح التالية من الجلسات المتبقّية.
 *
 * الاقتراح: الجلسة المفتوحة التالية لكل بندٍ «قيد التنفيذ» — استمرارٌ لما بدأ لا
 * قفزةٌ إلى بندٍ آخر — مجموعةً في زيارةٍ واحدة بعنوان أوّلها ومدة مجموع جلساتها.
 * وإن لم يبقَ شيءٌ قيد التنفيذ فلا اقتراح: العلاج انتهى أو لم يبدأ، والقرار بشري.
 */
async function closePlannedVisitAndSuggestNext(input: {
  client: DbClient;
  patientId: number;
  visitId: number;
  plannedVisitId: number | null;
  appointmentId: number | null;
  visitDoctorId: number | null;
}): Promise<{ id: number; title: string; sequence: number; durationMinutes: number } | null> {
  if (input.plannedVisitId) {
    await input.client.query(
      `UPDATE planned_visits SET status = 'completed', visit_id = $2 WHERE id = $1`,
      [input.plannedVisitId, input.visitId],
    );
  }
  // موعد الزيارة يُختم معها — زيارةٌ منتهية وموعدُها «وصل» حالةٌ لا يصحّحها أحد.
  if (input.appointmentId) {
    await input.client.query(
      `UPDATE appointments SET status = 'done' WHERE id = $1 AND status IN ('booked', 'arrived')`,
      [input.appointmentId],
    );
  }

  // الجلسات المتبقّية من البنود قيد التنفيذ، ثم من البنود المخطَّطة إن لم يكن الأولى.
  const { rows: remaining } = await input.client.query<{
    session_id: number; sequence: number; plan_item_id: number; plan_id: number;
    service_name: string; tooth_code: number | null; session_count: number;
    done_sessions: string; item_status: string; planned_duration: number | null;
  }>(
    `SELECT s.id AS session_id, s.sequence, s.plan_item_id, i.plan_id,
            i.service_name, i.tooth_code, i.session_count, i.status AS item_status,
            s.planned_duration,
            (SELECT COUNT(*) FROM treatment_sessions d
              WHERE d.plan_item_id = i.id AND d.status = 'done')::text AS done_sessions
       FROM treatment_sessions s
       JOIN plan_items i ON i.id = s.plan_item_id
       JOIN treatment_plans t ON t.id = i.plan_id
      WHERE t.patient_id = $1 AND t.status = 'active' AND s.status = 'planned'
      ORDER BY CASE WHEN i.status = 'in_progress' THEN 0 ELSE 1 END, i.sort_order, i.id, s.sequence
      LIMIT 12`,
    [input.patientId],
  );
  if (remaining.length === 0) return null;

  // زيارةٌ واحدة: جلسات البنود قيد التنفيذ (أو أول بندٍ مخطَّط إن لم يكن قائمٌ شيء).
  const first = remaining[0];
  const wantInProgress = first.item_status === "in_progress";
  const group = remaining.filter((row) =>
    wantInProgress ? row.item_status === "in_progress" : true,
  );

  const title = plannedVisitTitle(group.map((row) => ({
    serviceName: row.service_name,
    toothCode: row.tooth_code,
    sessionIndex: Number(row.done_sessions) + 1,
    sessionCount: row.session_count,
  })));
  const durationMinutes = Math.max(
    15,
    group.reduce((sum, row) => sum + (row.planned_duration ?? DEFAULT_VISIT_MINUTES), 0),
  );

  const { rows: seqRow } = await input.client.query<{ next: number }>(
    `SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM planned_visits
      WHERE plan_id = $1`,
    [first.plan_id],
  );

  const { rows: created } = await input.client.query<{
    id: number; title: string; sequence: number; duration_minutes: number;
  }>(
    `INSERT INTO planned_visits
         (patient_id, plan_id, sequence, title, doctor_id, duration_minutes, status, note)
       VALUES ($1, $2, $3, $4, $5::int, $6, 'planned', $7::text)
       RETURNING id, title, sequence, duration_minutes`,
    [input.patientId, first.plan_id, seqRow[0].next, title,
     input.visitDoctorId, durationMinutes, "مقترحة تلقائيًا بعد إنهاء الزيارة"],
  );

  // الجلسات المقترحة تُربط بالزيارة المخطَّطة — فيعرف الاستقبال ماذا سيعمل بالضبط.
  await input.client.query(
    `UPDATE treatment_sessions SET planned_visit_id = $1 WHERE id = ANY($2::bigint[])`,
    [created[0].id, group.map((row) => row.session_id)],
  );

  return {
    id: created[0].id,
    title: created[0].title,
    sequence: created[0].sequence,
    durationMinutes: created[0].duration_minutes,
  };
}

/**
 * طلبات المختبر التلقائية من إجراءات الزيارة (§١٩).
 *
 * لكل إجراءٍ فئته من فئات المختبر (تاج/جسر/قشرة): طلبٌ واحد لذلك السن من تلك
 * الزيارة، بحالة «لم يُرسل بعد» ومهلة افتراضية أسبوعًا. الفهرس الفريد على
 * (الزيارة، السن) والحالة غير الملغاة هو الحارس: إعادة التوقيع أو ازدواج الضغط
 * لا يولّد طلبًا ثانيًا للسنّ نفسه.
 */
async function createAutoLabOrders(input: {
  client: DbClient;
  patientId: number;
  visitId: number;
  procedures: ProcedureLine[];
}): Promise<number> {
  const wanted = input.procedures
    .map((line) => ({
      workType: labWorkForCategory(line.category),
      toothCode: line.toothCode,
      serviceName: line.serviceName,
    }))
    .filter((line) => line.workType !== null);

  if (wanted.length === 0) return 0;

  // «اليوم» من قاعدة البيانات نفسها لا من ساعة الخادم — داخل المعاملة قيد القراءة.
  const { rows: todayRows } = await input.client.query<{ d: string }>(
    `SELECT CURRENT_DATE::text AS d`,
  );
  const today = todayRows[0]?.d ?? new Date().toISOString().slice(0, 10);
  const dueDate = addDays(today, DEFAULT_LAB_DAYS);
  let created = 0;

  for (const line of wanted) {
    if (line.toothCode === null) {
      // إجراء بلا سنّ (طقم كامل مثلًا) لا يُخصم فهرسُه الحارس — يُنشأ ما لم يوجد
      // طلبٌ تلقائي سابق لهذه الزيارة بنوع العمل نفسه.
      const { rows } = await input.client.query<{ id: number }>(
        `INSERT INTO lab_orders (patient_id, lab_name, work_type, details, sent_date,
                                 due_date, status, visit_id, tooth_code, source, note)
         SELECT $1, $2, $3, $4, $5::date, $6::date, 'needed', $7, NULL, 'auto', $8
          WHERE NOT EXISTS (
            SELECT 1 FROM lab_orders
             WHERE visit_id = $7 AND source = 'auto' AND work_type = $3
               AND tooth_code IS NULL AND status <> 'cancelled'
          )
         RETURNING id`,
        [input.patientId, PENDING_LAB_NAME, line.workType,
         `من ${line.serviceName} — زيارة رقم ${input.visitId}`,
         today, dueDate, input.visitId,
         "طلب تلقائي من توقيع الزيارة — أكمل بيانات المختبر ثم أرسله"],
      );
      created += rows.length;
      continue;
    }

    const { rows } = await input.client.query<{ id: number }>(
      `INSERT INTO lab_orders (patient_id, lab_name, work_type, details, sent_date,
                               due_date, status, visit_id, tooth_code, source, note)
       VALUES ($1, $2, $3, $4, $5::date, $6::date, 'needed', $7, $8, 'auto', $9)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [input.patientId, PENDING_LAB_NAME, line.workType,
       `من ${line.serviceName} — سن ${line.toothCode} — زيارة رقم ${input.visitId}`,
       today, dueDate, input.visitId, line.toothCode,
       "طلب تلقائي من توقيع الزيارة — أكمل بيانات المختبر ثم أرسله"],
    );
    created += rows.length;
  }
  return created;
}

/**
 * خصم المستهلكات التلقائي (§٢٠) — داخل معاملة التوقيع.
 *
 * لكل إجراء: موادّه المربوطة في `service_materials` تُخصم بكمية (الكمية المنفَّذة ×
 * نصيب الوحدة). والحركة تحمل الزيارة والمريض مع سببٍ يذكر الخدمة، فتُقرأ في سجل
 * مستهلكات المريض جملةً واحدة مع الحركات اليدوية القديمة.
 *
 * والحارس من الخصم المزدوج بنيويّ: الحركة تُنشأ مرة واحدة لأن التوقيع نفسه يقع مرة
 * واحدة (الزيارة الموقَّعة تُرفض سلفًا)، ولأن تكرار التوقيع مستحيل بالقفل الصفّي.
 */
async function deductServiceMaterials(input: {
  client: DbClient;
  patientId: number;
  visitId: number;
  procedures: ProcedureLine[];
  signedBy: string;
}): Promise<number> {
  if (input.procedures.length === 0) return 0;

  const serviceIds = [...new Set(input.procedures.map((line) => line.serviceId))];
  const { rows: mappings } = await input.client.query<{
    service_id: number; item_id: number; qty_per_unit: string; item_name: string; unit: string;
  }>(
    `SELECT m.service_id, m.item_id, m.qty_per_unit, i.name AS item_name, i.unit
       FROM service_materials m
       JOIN inventory_items i ON i.id = m.item_id AND i.is_active
      WHERE m.service_id = ANY($1::int[])`,
    [serviceIds],
  );
  if (mappings.length === 0) return 0;

  const qtyByService = new Map<number, number>();
  for (const line of input.procedures) {
    qtyByService.set(line.serviceId, (qtyByService.get(line.serviceId) ?? 0) + line.quantity);
  }

  let movements = 0;
  for (const mapping of mappings) {
    const executed = qtyByService.get(mapping.service_id) ?? 0;
    if (executed <= 0) continue;
    const qty = Number(mapping.qty_per_unit) * executed;
    if (!Number.isFinite(qty) || qty <= 0) continue;

    const { rowCount } = await input.client.query(
      `INSERT INTO inventory_movements (item_id, kind, qty, reason, visit_id, patient_id, created_by)
       VALUES ($1, 'out', $2, $3, $4, $5, $6)`,
      [mapping.item_id, qty,
       `خصم تلقائي — ${mapping.item_name} (${mapping.unit})`,
       input.visitId, input.patientId, input.signedBy],
    );
    movements += rowCount ?? 0;
  }
  return movements;
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
async function lockPlan(client: DbClient, planId: number): Promise<{
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
async function recomputePlanTotal(client: DbClient, planId: number): Promise<number> {
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

// ─── رحلة المريض V2: الخطة الموحَّدة، الزيارات المخطَّطة، وملخص «ماذا الآن؟» ───

/**
 * خطة العلاج كما تُنشأ في الرحلة V2 — بزرٍّ واحد.
 *
 * زرٌّ واحد «+ إنشاء خطة علاج»، والتعقيد القديم (سريرية؟ مالية؟) يصير اختيارًا
 * **داخل** النموذج: طريقة التسعير (بنودٌ مسعَّرة أو مبلغٌ متفق عليه)، وطريقة الدفع
 * (حسب المنفَّذ، أو أقساط، أو جدول مخصص). والكائن في القاعدة واحد في الحالتين —
 * لأن المريض قد يبدأ ببنودٍ ثم يُقسَّط ما اتفق عليه.
 */
export interface PlanItemDraft {
  serviceId: number | null;
  serviceName: string;
  category: string | null;
  toothCode: number | null;
  surfaces: string | null;
  quantity: number;
  unitPriceMinor: number;
  billingRule: BillingRule;
  sessionCount: number;
  note: string | null;
}

export type PlanBillingMode = "per_procedure" | "installments" | "custom_schedule";

export async function createPlanV2(input: {
  patientId: number;
  title: string;
  specialty: string | null;
  primaryDoctorId: number | null;
  billingMode: PlanBillingMode;
  baseCurrency: Currency;
  startDate: string;
  note: string | null;
  items: PlanItemDraft[];
  installments: { dueDate: string; amountMinor: number }[];
  createdBy: string;
}): Promise<{ ok: true; planId: number } | { ok: false; message: string }> {
  await ensureSchema();
  if (input.items.length === 0 && input.installments.length === 0) {
    return { ok: false, message: "أضف بنود الخطة أو المبلغ المتفق عليه." };
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const itemsTotalMinor = input.items
      .filter((item) => item.sessionCount >= 0)
      .reduce((sum, item) =>
        sum + Math.max(0, Math.round(item.quantity)) * Math.max(0, Math.round(item.unitPriceMinor)), 0);
    // خطةُ البنود: الإجمالي مشتقّ منها. خطة المبلغ المتفق عليه: الإجمالي هو الاتفاق.
    const installmentsTotalMinor = input.installments.reduce(
      (sum, part) => sum + Math.max(0, Math.round(part.amountMinor)), 0,
    );
    const totalMinor = input.items.length > 0 ? itemsTotalMinor : installmentsTotalMinor;
    if (totalMinor <= 0) {
      await client.query("ROLLBACK");
      return { ok: false, message: "إجمالي الخطة يجب أن يكون أكبر من صفر." };
    }

    const { rows: planRows } = await client.query<{ id: number }>(
      `INSERT INTO treatment_plans
         (patient_id, title, total_minor, base_currency, status, start_date, note, created_by,
          billing_mode, specialty, primary_doctor_id, total_from_items)
       VALUES ($1, $2, $3, $4, 'active', $5::date, $6::text, $7, $8, $9::text, $10::int, $11)
       RETURNING id`,
      [input.patientId, input.title, totalMinor, input.baseCurrency, input.startDate,
       input.note, input.createdBy, input.billingMode, input.specialty,
       input.primaryDoctorId, input.items.length > 0],
    );
    const planId = planRows[0].id;

    /*
     * البنود وجلساتها والزيارات المخطَّطة — كلها هنا في المعاملة نفسها.
     *
     * الزيارات المخطَّطة تُبنى من تجميع الجلسات: كل «دورة زيارة» تجمع جلسات البنود
     * التي تُنفَّذ معًا (كالكشف والأشعة في الزيارة الأولى). التجميع الافتراضي هنا
     * بسيط وعقلاني: زيارةٌ لكل بند — والطبيب يعيد ترتيبها من واجهة الخطة إن شاء.
     */
    let visitSequence = 0;
    for (const draft of input.items) {
      if (!draft.serviceName.trim()) {
        await client.query("ROLLBACK");
        return { ok: false, message: "لكل بندٍ خدمةٌ من الدليل." };
      }
      if (draft.toothCode !== null && !isValidTooth(draft.toothCode)) {
        await client.query("ROLLBACK");
        return { ok: false, message: "رقم سنّ غير صحيح بالترقيم الدولي." };
      }

      const { rows: itemRows } = await client.query<{ id: number }>(
        `INSERT INTO plan_items
           (plan_id, service_id, service_name, category, tooth_code, surfaces, quantity,
            unit_price_minor, note, sort_order, billing_rule, session_count)
         VALUES ($1, $2, $3, $4::text, $5, $6::text, $7, $8, $9::text,
                 COALESCE((SELECT MAX(sort_order) + 1 FROM plan_items WHERE plan_id = $1), 100),
                 $10, $11)
         RETURNING id`,
        [planId, draft.serviceId, draft.serviceName.trim(), draft.category,
         draft.toothCode, normalizeSurfaces(draft.surfaces),
         Math.max(1, Math.round(draft.quantity)), Math.max(0, Math.round(draft.unitPriceMinor)),
         draft.note?.trim() || null, draft.billingRule, draft.sessionCount],
      );
      const itemId = itemRows[0].id;

      // زيارةٌ مخطَّطة لهذا البند تحمل جلساته كلها — نقطة بدايةٍ يعيد ترتيبها الطبيب.
      visitSequence += 1;
      const title = plannedVisitTitle([{
        serviceName: draft.serviceName,
        toothCode: draft.toothCode,
        sessionIndex: draft.sessionCount > 1 ? 1 : null,
        sessionCount: draft.sessionCount,
      }]);
      const { rows: visitRows } = await client.query<{ id: number }>(
        `INSERT INTO planned_visits
           (patient_id, plan_id, sequence, title, doctor_id, duration_minutes, status, note)
         VALUES ($1, $2, $3, $4, $5::int, $6, 'planned', $7::text)
         RETURNING id`,
        [input.patientId, planId, visitSequence, title, input.primaryDoctorId,
         draft.sessionCount * DEFAULT_VISIT_MINUTES, draft.note?.trim() || null],
      );

      for (let sequence = 1; sequence <= draft.sessionCount; sequence += 1) {
        await client.query(
          `INSERT INTO treatment_sessions
             (plan_item_id, sequence, title, status, planned_visit_id, planned_duration)
           VALUES ($1, $2, $3, 'planned', $4, $5)`,
          [itemId, sequence,
           draft.sessionCount > 1 ? `جلسة ${sequence}` : null,
           visitRows[0].id, DEFAULT_VISIT_MINUTES],
        );
      }
    }

    // الأقساط إن كانت طريقة الدفع كذلك — ويُبنى جدولها من الاتفاق كما هو قائم.
    if (input.installments.length > 0) {
      for (let index = 0; index < input.installments.length; index += 1) {
        await client.query(
          `INSERT INTO plan_installments (plan_id, number, due_date, amount_minor)
           VALUES ($1, $2, $3::date, $4)`,
          [planId, index + 1, input.installments[index].dueDate,
           Math.max(0, Math.round(input.installments[index].amountMinor))],
        );
      }
    }

    await client.query("COMMIT");
    return { ok: true, planId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** الزيارة المخطَّطة كما تُقرأ في واجهات الرحلة. */
export interface PlannedVisitView {
  id: number;
  planId: number | null;
  planTitle: string | null;
  sequence: number;
  title: string;
  doctorId: number | null;
  doctorName: string | null;
  durationMinutes: number;
  status: PlannedVisitStatus;
  appointmentId: number | null;
  appointmentDate: string | null;
  appointmentTime: string | null;
  visitId: number | null;
  note: string | null;
  createdAt: string;
}

interface PlannedVisitRow {
  id: number; patient_id: number; plan_id: number | null; plan_title: string | null; sequence: number;
  title: string; doctor_id: number | null; doctor_name: string | null;
  duration_minutes: number; status: string; appointment_id: number | null;
  scheduled_date: string | null; scheduled_time: string | null;
  visit_id: number | null; note: string | null; created_at: Date;
}

const PLANNED_VISIT_SELECT = `
  SELECT v.id, v.patient_id, v.plan_id, t.title AS plan_title, v.sequence, v.title, v.doctor_id,
         d.name AS doctor_name, v.duration_minutes, v.status, v.appointment_id,
         a.scheduled_date::text AS scheduled_date, a.scheduled_time::text AS scheduled_time,
         v.visit_id, v.note, v.created_at
    FROM planned_visits v
    LEFT JOIN treatment_plans t ON t.id = v.plan_id
    LEFT JOIN parties d ON d.id = v.doctor_id
    LEFT JOIN appointments a ON a.id = v.appointment_id`;

function toPlannedVisit(row: PlannedVisitRow): PlannedVisitView {
  return {
    id: row.id, planId: row.plan_id, planTitle: row.plan_title, sequence: row.sequence,
    title: row.title, doctorId: row.doctor_id, doctorName: row.doctor_name,
    durationMinutes: row.duration_minutes, status: row.status as PlannedVisitStatus,
    appointmentId: row.appointment_id,
    appointmentDate: row.scheduled_date,
    appointmentTime: row.scheduled_time?.slice(0, 5) ?? null,
    visitId: row.visit_id, note: row.note, createdAt: row.created_at.toISOString(),
  };
}

export async function listPatientPlannedVisits(patientId: number): Promise<PlannedVisitView[]> {
  await ensureSchema();
  const { rows } = await getPool().query<PlannedVisitRow>(
    `${PLANNED_VISIT_SELECT}
      WHERE v.patient_id = $1 AND v.status NOT IN ('completed', 'cancelled')
      ORDER BY v.status = 'in_progress' DESC, v.sequence, v.id`,
    [patientId],
  );
  return rows.map(toPlannedVisit);
}

/**
 * لوحة اليوم (§٢٦): زيارات اليوم المخطَّطة — من له موعدٌ اليوم من مرضى الرحلة،
 * وبأيّ عنوان جاء، ومع من من الأطباء. والطبيبُ المربوط يرى لوحته وحدها (§٣٩).
 */
export async function todayPlannedVisits(date: string, doctorPartyId?: number | null): Promise<{
  id: number; patientId: number; patientName: string; patientNumber: string;
  title: string; doctorName: string | null; time: string | null;
  durationMinutes: number; status: string; appointmentId: number | null;
}[]> {
  await ensureSchema();
  const scoped = typeof doctorPartyId === "number" && doctorPartyId > 0;
  const { rows } = await getPool().query<{
    id: number; patient_id: number; patient_name: string; patient_number: string;
    title: string; doctor_name: string | null; time: string | null;
    duration_minutes: number; status: string; appointment_id: number | null;
  }>(
    `SELECT pv.id, pv.patient_id, p.full_name AS patient_name, p.patient_number,
            pv.title, d.name AS doctor_name, a.scheduled_time::text AS time,
            pv.duration_minutes, pv.status, pv.appointment_id
       FROM planned_visits pv
       JOIN patients p ON p.id = pv.patient_id
       JOIN appointments a ON a.id = pv.appointment_id
       LEFT JOIN parties d ON d.id = pv.doctor_id
      WHERE a.scheduled_date = $1::date
        AND a.status IN ('booked', 'arrived')
        AND pv.status IN ('scheduled', 'in_progress')
        ${scoped ? "AND (pv.doctor_id = $2 OR pv.doctor_id IS NULL)" : ""}
      ORDER BY a.scheduled_time, pv.id`,
    scoped ? [date, doctorPartyId] : [date],
  );
  return rows.map((row) => ({
    id: row.id, patientId: row.patient_id, patientName: row.patient_name,
    patientNumber: row.patient_number, title: row.title, doctorName: row.doctor_name,
    time: row.time?.slice(0, 5) ?? null, durationMinutes: row.duration_minutes,
    status: row.status, appointmentId: row.appointment_id,
  }));
}

/**
 * يحوّل الزيارة المخطَّطة موعدًا — بتاريخٍ ووقت فقط.
 *
 * لا يُعاد إدخال سبب الموعد ولا العلاج ولا المدة ولا الطبيب: كلها في الزيارة
 * المخطَّطة أصلًا. والكتابة تمرّ من **قفل اليوم الذرّي** نفسه الذي يمرّ عليه كل حجز
 * (المواعيد المتزامنة على كرسيٍّ واحد)، مع إعادة التحقق من الزيارة المخطَّطة داخل
 * المعاملة — فلا تُحوَّل مرتين ولو ضغط الاثنان معًا.
 */
export async function schedulePlannedVisit(input: {
  plannedVisitId: number;
  date: string;
  time: string;
  chairs: number;
  dayEnd?: string;
}): Promise<
  | { ok: true; appointmentId: number; title: string }
  | { ok: false; reason: "not_found" | "not_schedulable" | "already_scheduled" }
  | { ok: false; reason: "conflict"; conflict: { message: string; suggestion?: string; suggestionMessage?: string } }
> {
  await ensureSchema();

  // قراءة أولية: المدة والحالة والمريض — ليعرف الحكم مدةً صحيحة.
  const { rows: previewRows } = await getPool().query<PlannedVisitRow>(
    `${PLANNED_VISIT_SELECT} WHERE v.id = $1`,
    [input.plannedVisitId],
  );
  const preview = previewRows[0];
  if (!preview) return { ok: false, reason: "not_found" };
  if (preview.status === "completed" || preview.status === "cancelled") {
    return { ok: false, reason: "not_schedulable" };
  }
  if (preview.appointment_id) {
    return { ok: false, reason: "already_scheduled" };
  }

  try {
    const result = await writeAppointmentInDay({
      date: input.date,
      judge: (day) => {
        const verdict = checkSlot(day, input.date, input.time, preview.duration_minutes, input.chairs);
        if (verdict.allowed) return { ok: true as const };
        const suggestion = nextFreeTime(
          day, input.date, input.time, preview.duration_minutes, input.chairs, input.dayEnd,
        );
        return {
          ok: false as const,
          conflict: {
            message: verdict.reason,
            suggestion,
            suggestionMessage: suggestion ? `أقرب وقت متاح: ${suggestion}` : "لا يوجد وقت متاح في هذا اليوم.",
          },
        };
      },
      commit: async (client) => {
        // إعادة التحقق تحت القفل: لا تحويل مرتين مهما تزامنت الطلبات.
        const { rows: locked } = await client.query<{ id: number; status: string; appointment_id: number | null }>(
          `SELECT id, status, appointment_id FROM planned_visits WHERE id = $1 FOR UPDATE`,
          [input.plannedVisitId],
        );
        const current = locked[0];
        if (!current || current.status === "completed" || current.status === "cancelled") {
          throw new PlannedVisitRejected("not_schedulable");
        }
        if (current.appointment_id) {
          throw new PlannedVisitRejected("already_scheduled");
        }

        const { rows: created } = await client.query<{ id: number }>(
          `INSERT INTO appointments
             (patient_id, scheduled_date, scheduled_time, duration_minutes, note, planned_visit_id)
           VALUES ($1, $2::date, $3::time, $4, $5::text, $6::int)
           RETURNING id`,
          [preview.patient_id, input.date, input.time, preview.duration_minutes,
           `من خطة العلاج: ${preview.title}`, input.plannedVisitId],
        );
        await client.query(
          `UPDATE planned_visits SET status = 'scheduled', appointment_id = $2 WHERE id = $1`,
          [input.plannedVisitId, created[0].id],
        );
        return { appointmentId: created[0].id, title: preview.title };
      },
    });

    if (result.ok) return { ok: true, ...result.value };
    return { ok: false, reason: "conflict", conflict: result.conflict as {
      message: string; suggestion?: string; suggestionMessage?: string;
    } };
  } catch (error) {
    if (error instanceof PlannedVisitRejected) {
      return { ok: false, reason: error.reason };
    }
    throw error;
  }
}

/** رفضٌ داخلي يعبر المعاملة إلى الاستجابة — لا يُفشل السجل كله. */
class PlannedVisitRejected extends Error {
  constructor(readonly reason: "not_schedulable" | "already_scheduled") {
    super(reason);
  }
}

/**
 * يبدأ زيارة اليوم من زيارةٍ مخطَّطة.
 *
 * الزيارة تُنشأ مرتبطةً بالمريض والزيارة المخطَّطة، وملاحظتها عنوانها — فيعرف
 * الطبيب في «مخطَّط لليوم» ماذا سيعمل قبل أن يفتح الزيارة. والزيارة المخطَّطة
 * تصير «زيارة قائمة» لا «منجَزة»: المنجز ما وُقِّع، لا ما بدأ.
 */
export async function startVisitFromPlannedVisit(input: {
  plannedVisitId: number;
  actor: string;
}): Promise<Visit | null | { alreadyActive: true; visitId: number }> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const { rows: plannedRows } = await client.query<{
      id: number; patient_id: number; full_name: string; phone: string | null;
      title: string; doctor_id: number | null; status: string; visit_id: number | null;
    }>(
      `SELECT v.id, v.patient_id, p.full_name, p.phone, v.title, v.doctor_id, v.status, v.visit_id
         FROM planned_visits v JOIN patients p ON p.id = v.patient_id
        WHERE v.id = $1 FOR UPDATE OF v`,
      [input.plannedVisitId],
    );
    const planned = plannedRows[0];
    if (!planned) { await client.query("ROLLBACK"); return null; }

    // زيارةٌ قائمة لهذه الزيارة المخطَّطة: لا ثانية — المريض على الكرسي مرةً واحدة.
    if (planned.visit_id) {
      const { rows: active } = await client.query<{ id: number; signed_at: Date | null }>(
        `SELECT id, signed_at FROM visits WHERE id = $1`,
        [planned.visit_id],
      );
      if (active[0] && !active[0].signed_at) {
        await client.query("ROLLBACK");
        return { alreadyActive: true, visitId: active[0].id };
      }
    }
    if (planned.status === "completed" || planned.status === "cancelled") {
      await client.query("ROLLBACK");
      return null;
    }

    const { rows: created } = await client.query<VisitRow>(
      `INSERT INTO visits (patient_name, patient_phone, note, patient_id, doctor_id, planned_visit_id)
       VALUES ($1, $2, $3, $4, $5::int, $6) RETURNING *`,
      [planned.full_name, planned.phone, `مخطَّط: ${planned.title}`,
       planned.patient_id, planned.doctor_id, input.plannedVisitId],
    );

    await client.query(
      `UPDATE planned_visits SET status = 'in_progress', visit_id = $2 WHERE id = $1`,
      [input.plannedVisitId, created[0].id],
    );

    await client.query("COMMIT");
    return toVisit(created[0]);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * ملخص رحلة المريض — «ما وضع هذا المريض، وما المطلوب مني الآن؟»
 *
 * استعلامٌ واحدٌ يجيب عن رأس ملف المريض كله: الموعد القادم، وآخر زيارة، والخطة
 * النشطة وتقدّمها، والجلسة التالية، والرصيد **لمن يملك رؤيته فقط**، والتنبيهات.
 * والمال يُحسب هنا لا في الواجهة: فصل الصلاحيات يجب أن يكون في الخادم — إخفاء
 * الزر في الشاشة ليس منعًا.
 */
export async function patientWorkflow(patientId: number, today: string): Promise<{
  patient: {
    id: number; patientNumber: string; fullName: string; phone: string | null;
    gender: string; birthYear: number | null; medicalAlert: string | null;
  } | null;
  openVisit: { id: number; status: string; chair: number | null; arrivedAt: string; plannedTitle: string | null } | null;
  lastVisit: { id: number; date: string; treatmentDone: string | null; proceduresSummary: string | null; nextPlan: string | null } | null;
  nextAppointment: { id: number; date: string; time: string; durationMinutes: number; appointmentType: string | null; note: string | null; status: string } | null;
  activePlans: {
    id: number; title: string; specialty: string | null; primaryDoctorName: string | null;
    consentAt: string | null; itemsCount: number; doneItems: number;
    totalMinor: number; doneMinor: number; remainingMinor: number;
    nextDueDate: string | null; overdueMinor: number;
  }[];
  plannedVisits: PlannedVisitView[];
  counts: { visits: number; openLabOrders: number; documents: number; orthoCase: boolean };
  financial: {
    balanceMinor: number; invoicedMinor: number; paidMinor: number; openingMinor: number;
    agreedMinor: number; treatmentDoneMinor: number; remainingTreatmentMinor: number;
  } | null;
  alerts: { kind: string; severity: "info" | "warning" | "danger"; text: string }[];
}> {
  await ensureSchema();
  const pool = getPool();

  const { rows: patientRows } = await pool.query<{
    id: number; patient_number: string; full_name: string; phone: string | null;
    gender: string; birth_year: number | null; medical_alert: string | null;
  }>(
    `SELECT id, patient_number, full_name, phone, gender, birth_year, medical_alert
       FROM patients WHERE id = $1`,
    [patientId],
  );
  const patient = patientRows[0]
    ? {
        id: patientRows[0].id, patientNumber: patientRows[0].patient_number,
        fullName: patientRows[0].full_name, phone: patientRows[0].phone,
        gender: patientRows[0].gender, birthYear: patientRows[0].birth_year,
        medicalAlert: patientRows[0].medical_alert,
      }
    : null;

  const [openVisit, lastVisit, nextAppointment, plans, plannedVisits, counts, financial] =
    await Promise.all([
      (async () => {
        const { rows } = await pool.query<{
          id: number; status: string; chair: number | null; arrived_at: Date;
          planned_title: string | null;
        }>(
          `SELECT v.id, v.status, v.chair, v.arrived_at, pv.title AS planned_title
             FROM visits v LEFT JOIN planned_visits pv ON pv.id = v.planned_visit_id
            WHERE v.patient_id = $1 AND v.signed_at IS NULL AND v.status <> 'done'
            ORDER BY v.arrived_at DESC LIMIT 1`,
          [patientId],
        );
        return rows[0]
          ? {
              id: rows[0].id, status: rows[0].status, chair: rows[0].chair,
              arrivedAt: rows[0].arrived_at.toISOString(), plannedTitle: rows[0].planned_title,
            }
          : null;
      })(),
      (async () => {
        const { rows } = await pool.query<{
          id: number; arrived_at: Date; treatment_done: string | null; next_plan: string | null;
          procedures: string | null;
        }>(
          `SELECT v.id, v.arrived_at, v.treatment_done, v.next_plan,
                  (SELECT string_agg(s.name, ' · ' ORDER BY p.id)
                     FROM visit_procedures p JOIN services s ON s.id = p.service_id
                    WHERE p.visit_id = v.id) AS procedures
             FROM visits v WHERE v.patient_id = $1 AND v.signed_at IS NOT NULL
            ORDER BY v.signed_at DESC LIMIT 1`,
          [patientId],
        );
        return rows[0]
          ? {
              id: rows[0].id, date: rows[0].arrived_at.toISOString().slice(0, 10),
              treatmentDone: rows[0].treatment_done,
              proceduresSummary: rows[0].procedures, nextPlan: rows[0].next_plan,
            }
          : null;
      })(),
      (async () => {
        const { rows } = await pool.query<{
          id: number; scheduled_date: string; scheduled_time: string;
          duration_minutes: number; appointment_type: string | null; note: string | null; status: string;
        }>(
          `SELECT id, scheduled_date::text, scheduled_time::text, duration_minutes,
                  appointment_type, note, status
             FROM appointments
            WHERE patient_id = $1 AND scheduled_date >= $2::date
              AND status IN ('booked', 'arrived')
            ORDER BY scheduled_date, scheduled_time LIMIT 1`,
          [patientId, today],
        );
        return rows[0]
          ? {
              id: rows[0].id, date: rows[0].scheduled_date,
              time: rows[0].scheduled_time.slice(0, 5),
              durationMinutes: rows[0].duration_minutes,
              appointmentType: rows[0].appointment_type, note: rows[0].note,
              status: rows[0].status,
            }
          : null;
      })(),
      listPatientPlans(patientId, today),
      listPatientPlannedVisits(patientId),
      (async () => {
        const { rows } = await pool.query<{
          visits: string; open_lab: string; documents: string; ortho: string;
        }>(
          `SELECT
             (SELECT COUNT(*) FROM visits WHERE patient_id = $1 AND signed_at IS NOT NULL)::text AS visits,
             (SELECT COUNT(*) FROM lab_orders WHERE patient_id = $1 AND status IN ('sent', 'received'))::text AS open_lab,
             (SELECT COUNT(*) FROM patient_documents WHERE patient_id = $1 AND removed_at IS NULL)::text AS documents,
             (SELECT COUNT(*) FROM ortho_cases WHERE patient_id = $1 AND status IN ('active', 'retention'))::text AS ortho`,
          [patientId],
        );
        return {
          visits: Number(rows[0]?.visits ?? 0),
          openLabOrders: Number(rows[0]?.open_lab ?? 0),
          documents: Number(rows[0]?.documents ?? 0),
          orthoCase: Number(rows[0]?.ortho ?? 0) > 0,
        };
      })(),
      patientLedger(patientId),
    ]);

  const livePlans = plans.filter((plan) => plan.status === "active");
  const activePlanViews = livePlans.map((plan) => ({
    id: plan.id, title: plan.title, specialty: null, primaryDoctorName: null,
    consentAt: plan.consentAt, itemsCount: plan.itemsProgress.count,
    doneItems: plan.itemsProgress.doneCount, totalMinor: plan.totalMinor,
    doneMinor: plan.itemsProgress.doneMinor, remainingMinor: plan.itemsProgress.remainingMinor,
    nextDueDate: plan.progress.nextDueDate, overdueMinor: plan.progress.overdueMinor,
  }));

  const separation = treatmentFinancialSeparation({
    livePlans: livePlans.map((plan) => ({
      totalMinor: plan.totalMinor, itemsDoneMinor: plan.itemsProgress.doneMinor,
    })),
    invoicedMinor: financial.invoices
      .filter((invoice) => invoice.status !== "cancelled")
      .reduce((sum, invoice) => sum + invoice.totalMinor - invoice.discountMinor, 0),
    paidMinor: financial.payments
      .filter((payment) => payment.kind === "payment")
      .reduce((sum, payment) => sum + payment.baseAmountMinor, 0),
    openingMinor: financial.opening?.amountMinor ?? 0,
  });
  const refundedMinor = financial.payments
    .filter((payment) => payment.kind === "refund")
    .reduce((sum, payment) => sum + payment.baseAmountMinor, 0);
  const financialView = {
    balanceMinor: separation.debtMinor - refundedMinor,
    invoicedMinor: separation.invoicedMinor,
    paidMinor: separation.paidMinor - refundedMinor,
    openingMinor: financial.opening?.amountMinor ?? 0,
    agreedMinor: separation.agreedMinor,
    treatmentDoneMinor: separation.treatmentDoneMinor,
    remainingTreatmentMinor: separation.remainingTreatmentMinor,
  };

  // التنبيهات: ما يجب أن يُقال لا ما يمكن أن يُعرض.
  const alerts: { kind: string; severity: "info" | "warning" | "danger"; text: string }[] = [];
  for (const plan of activePlanViews) {
    if (plan.overdueMinor > 0) {
      alerts.push({
        kind: "overdue_installment", severity: "danger",
        text: `قسط متأخر في «${plan.title}»: ${formatMoney(plan.overdueMinor, "YER")}`,
      });
    }
  }
  const unscheduled = plannedVisits.find(
    (visit) => visit.status === "planned" && !visit.appointmentId,
  );
  if (unscheduled && livePlans.length > 0) {
    alerts.push({
      kind: "unscheduled_visit", severity: "warning",
      text: `الجلسة التالية «${unscheduled.title}» لم تُجدول بعد.`,
    });
  }
  const overdueLab = counts.openLabOrders > 0;
  if (overdueLab) {
    alerts.push({
      kind: "lab_open", severity: "info",
      text: `طلبات معمل جارية: ${counts.openLabOrders}.`,
    });
  }

  return {
    patient,
    openVisit, lastVisit, nextAppointment,
    activePlans: activePlanViews,
    plannedVisits,
    counts,
    financial: financialView,
    alerts,
  };
}

// ─── الخط الزمني الموحَّد (§٢٩-٣٠) ──────────────────────────────────────────

/**
 * خطُّ مريض الزمني من كل مصادر الرحلة: الزيارات والخطط والمواعيد، والفواتير
 * والدفعات، وطلبات المختبر، والمستندات، وشدّات التقويم — أحداثٌ بلونٍ واحد
 * ونقرةٍ تفتح مصدرها.
 *
 * الاستعلامات مستقلة لا UNION واحدة: كل مصدر شكله مختلف، والتوحيف في SQL كان
 * سيشوّه الأنواع ويصعّب قراءة كل سطر. والتجميع والفرز في الخادم على مئة صفٍّ
 * الأكثر رخيص.
 */
export async function patientTimeline(
  patientId: number,
  limit = 60,
): Promise<TimelineEvent[]> {
  await ensureSchema();
  const pool = getPool();
  const cap = Math.max(10, Math.min(200, Math.round(limit)));

  const [visits, plans, invoices, payments, labOrders, documents, orthoAdjustments, diagnoses, appointments] =
    await Promise.all([
      pool.query<{
        id: number; signed_at: Date; treatment_done: string | null; procedures: string | null;
      }>(
        `SELECT v.id, v.signed_at, v.treatment_done,
                (SELECT string_agg(s.name || COALESCE(' — سن ' || p.tooth_code::text, ''), ' · ' ORDER BY p.id)
                   FROM visit_procedures p JOIN services s ON s.id = p.service_id
                  WHERE p.visit_id = v.id) AS procedures
           FROM visits v
          WHERE v.patient_id = $1 AND v.signed_at IS NOT NULL
          ORDER BY v.signed_at DESC LIMIT $2`,
        [patientId, cap],
      ),
      pool.query<{ id: number; title: string; created_at: Date; consent_at: Date | null; status: string }>(
        `SELECT id, title, created_at, consent_at, status
           FROM treatment_plans WHERE patient_id = $1
          ORDER BY created_at DESC LIMIT $2`,
        [patientId, cap],
      ),
      pool.query<{ id: string; invoice_number: string; total_minor: string; discount_minor: string; status: string; created_at: Date }>(
        `SELECT id::text, invoice_number, total_minor, discount_minor, status, created_at
           FROM invoices WHERE patient_id = $1
          ORDER BY created_at DESC LIMIT $2`,
        [patientId, cap],
      ),
      pool.query<{ id: string; kind: string; amount_minor: string; currency: string; created_at: Date; method: string | null }>(
        `SELECT id::text, kind, amount_minor, currency, created_at, method
           FROM payments WHERE patient_id = $1
          ORDER BY created_at DESC LIMIT $2`,
        [patientId, cap],
      ),
      pool.query<{ id: string; work_type: string; status: string; created_at: Date; tooth_code: number | null }>(
        `SELECT id::text, work_type, status, created_at, tooth_code
           FROM lab_orders WHERE patient_id = $1
          ORDER BY created_at DESC LIMIT $2`,
        [patientId, cap],
      ),
      pool.query<{ id: string; title: string; kind: string; uploaded_at: Date }>(
        `SELECT id::text, title, kind, uploaded_at
           FROM patient_documents WHERE patient_id = $1 AND removed_at IS NULL
          ORDER BY uploaded_at DESC LIMIT $2`,
        [patientId, cap],
      ),
      pool.query<{ id: string; upper_wire: string | null; lower_wire: string | null; done: string | null; done_on: string; recorded_at: Date }>(
        `SELECT a.id::text, a.upper_wire, a.lower_wire, a.done, a.done_on::text, a.recorded_at
           FROM ortho_adjustments a JOIN ortho_cases c ON c.id = a.case_id
          WHERE c.patient_id = $1
          ORDER BY a.recorded_at DESC LIMIT $2`,
        [patientId, cap],
      ),
      // التشخيص النسخي (من عمل الوكيل الآخر): كل نسخةٍ حدثٌ في القصة — التشخيص
      // الأول والتحديثات كلها تظهر في الخط، فيُرى ما رآه الطبيب ومتى.
      pool.query<{ id: string; version: number; label: string | null; created_at: Date }>(
        `SELECT id::text, version, label, created_at
           FROM patient_diagnoses WHERE patient_id = $1
          ORDER BY created_at DESC LIMIT $2`,
        [patientId, cap],
      ),
      // المواعيد الماضية وحدها (من عمل الوكيل الآخر): المستقبل يُقرأ في الملخص
      // وتبويب المواعيد، والخطّ الزمني أرشيفٌ يُروى — والفائت فيه درسٌ لا جدول.
      pool.query<{ id: string; scheduled_date: string; scheduled_time: string; status: string }>(
        `SELECT id::text, scheduled_date::text, to_char(scheduled_time, 'HH24:MI') AS scheduled_time, status
           FROM appointments
          WHERE patient_id = $1
            AND (status IN ('done', 'no_show', 'cancelled')
                 OR (status = 'booked' AND scheduled_date < (NOW() AT TIME ZONE $2)::date))
          ORDER BY scheduled_date DESC, id DESC LIMIT $2`,
        [patientId, CLINIC_TIME_ZONE, cap],
      ),
    ]);

  const events: TimelineEvent[] = [];

  for (const row of visits.rows) {
    const procedures = row.procedures?.trim() ?? "";
    events.push({
      key: `visit:${row.id}`,
      kind: "visit",
      at: row.signed_at.toISOString(),
      title: procedures ? `زيارة: ${procedures}` : "زيارة سريرية",
      detail: row.treatment_done?.trim() || null,
      amountMinor: null, currency: null,
      href: `/visits/${row.id}/clinical`,
    });
  }

  for (const row of plans.rows) {
    const statusText =
      row.status === "completed" ? "اكتملت" :
      row.status === "cancelled" ? "أُلغيت" :
      row.consent_at ? "بعد الموافقة" : "مسوّدة";
    events.push({
      key: `plan:${row.id}`,
      kind: "plan",
      at: (row.consent_at ?? row.created_at).toISOString(),
      title: `خطة علاج: ${row.title}`,
      detail: statusText,
      amountMinor: null, currency: null,
      href: `/patients/${patientId}?tab=treatment`,
    });
  }

  for (const row of invoices.rows) {
    events.push({
      key: `invoice:${row.id}`,
      kind: "invoice",
      at: row.created_at.toISOString(),
      title: `فاتورة ${row.invoice_number}`,
      detail: row.status === "cancelled" ? "ملغاة" : null,
      amountMinor: Number(row.total_minor) - Number(row.discount_minor),
      currency: null,
      href: `/patients/${patientId}?tab=account`,
    });
  }

  for (const row of payments.rows) {
    events.push({
      key: `payment:${row.id}`,
      kind: "payment",
      at: row.created_at.toISOString(),
      title: row.kind === "refund" ? "استرداد دفعة" : "دفعة",
      detail: row.method ?? null,
      amountMinor: Number(row.amount_minor),
      currency: row.currency,
      href: `/patients/${patientId}?tab=account`,
    });
  }

  for (const row of labOrders.rows) {
    events.push({
      key: `lab:${row.id}`,
      kind: "lab",
      at: row.created_at.toISOString(),
      title: `طلب مختبر: ${row.work_type}${row.tooth_code ? ` — سن ${row.tooth_code}` : ""}`,
      detail: row.status === "needed" ? "لم يُرسل بعد" : null,
      amountMinor: null, currency: null,
      href: `/lab`,
    });
  }

  for (const row of documents.rows) {
    events.push({
      key: `document:${row.id}`,
      kind: "document",
      at: row.uploaded_at.toISOString(),
      title: `مستند: ${row.title}`,
      detail: null,
      amountMinor: null, currency: null,
      href: `/patients/${patientId}?tab=files`,
    });
  }

  for (const row of orthoAdjustments.rows) {
    const wires = [row.upper_wire, row.lower_wire].filter(Boolean).join(" / ");
    events.push({
      key: `ortho:${row.id}`,
      kind: "ortho",
      at: row.recorded_at.toISOString(),
      title: "شدّة تقويم",
      detail: [wires ? `سلك: ${wires}` : null, row.done].filter(Boolean).join(" · ") || null,
      amountMinor: null, currency: null,
      href: `/patients/${patientId}?tab=treatment`,
    });
  }

  for (const row of diagnoses.rows) {
    events.push({
      key: `diagnosis:${row.id}`,
      kind: "diagnosis",
      at: row.created_at.toISOString(),
      title: row.version === 1 ? "تشخيص البداية" : `تحديث التشخيص — نسخة ${row.version}`,
      detail: row.label ?? null,
      amountMinor: null, currency: null,
      href: `/patients/${patientId}?tab=treatment`,
    });
  }

  for (const row of appointments.rows) {
    const at = `${row.scheduled_date}T${row.scheduled_time}:00`;
    const title =
      row.status === "no_show" ? "موعد فائت — لم يحضر" :
      row.status === "cancelled" ? "موعد ملغى" :
      row.status === "done" ? "موعد منجز" : "موعد";
    events.push({
      key: `appointment:${row.id}`,
      kind: "appointment",
      at,
      title,
      detail: null,
      amountMinor: null, currency: null,
      href: `/patients/${patientId}?tab=summary`,
    });
  }

  return sortTimeline(events).slice(0, cap);
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
  /** ربط صور التقويم: الحالة والشدّة التي صُوِّرت فيها — وألبوم الجلسة صورُها. */
  orthoCaseId: number | null;
  adjustmentId: number | null;
  photoStage: string | null;
  photoView: string | null;
}

interface DocumentRow {
  id: number; patient_id: number; visit_id: number | null; kind: string; title: string;
  mime_type: string; size_bytes: string; note: string | null; taken_on: Date | null;
  uploaded_by: string; uploaded_at: Date; removed_at: Date | null;
  removed_by: string | null; removed_note: string | null;
  ortho_case_id: number | null; adjustment_id: number | null;
  photo_stage: string | null; photo_view: string | null;
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
  orthoCaseId: row.ortho_case_id,
  adjustmentId: row.adjustment_id,
  photoStage: row.photo_stage,
  photoView: row.photo_view,
});

const DOCUMENT_COLUMNS = `id, patient_id, visit_id, kind, title, mime_type, size_bytes,
       note, taken_on, uploaded_by, uploaded_at, removed_at, removed_by, removed_note,
       ortho_case_id, adjustment_id, photo_stage, photo_view`;

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
  orthoCaseId?: number | null;
  adjustmentId?: number | null;
  photoStage?: string | null;
  photoView?: string | null;
}): Promise<PatientDocument> {
  await ensureSchema();
  const { rows } = await getPool().query<DocumentRow>(
    `INSERT INTO patient_documents
       (patient_id, visit_id, kind, title, mime_type, size_bytes, sha256, storage_key,
        note, taken_on, uploaded_by, ortho_case_id, adjustment_id, photo_stage, photo_view)
     VALUES ($1, $2::int, $3, $4, $5, $6, $7, $8, $9::text, $10::date, $11,
             $12::int, $13::int, $14::text, $15::text)
     RETURNING ${DOCUMENT_COLUMNS}`,
    [
      input.patientId, input.visitId, input.kind, input.title.trim(), input.mimeType,
      input.sizeBytes, input.sha256, input.storageKey,
      input.note?.trim() || null, input.takenOn, input.uploadedBy,
      input.orthoCaseId ?? null, input.adjustmentId ?? null,
      input.photoStage ?? null, input.photoView ?? null,
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
  /** ألبوم الجلسة: صور صُوّرت فيها وارتبطت بالشدّة — السجلّ والصورة في المكان نفسه. */
  photos: PatientDocument[];
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

const toAdjustment = (row: AdjustmentRow, photos: PatientDocument[] = []): OrthoAdjustment => ({
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
  photos,
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
  const photos = await photosForAdjustments(adjustmentRows.map((row) => row.id));
  for (const row of adjustmentRows) {
    const list = byCase.get(row.case_id) ?? [];
    list.push(toAdjustment(row, photos.get(row.id) ?? []));
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

/* ═════════════════ متابعة التقويم والصور والتشخيص والخطّ الزمني ═════════════════
 *
 * السلسلة التي وصفها المالك: جلسة → توثيق → كاميرا → رفعٌ دائم → موعدٌ قادم →
 * تذكير → متابعة. الدوالّ هنا حلقاتها البينية: لوحةُ المتابعة تُبقي الحلقة
 * مغلقةً بمطاردة من بلا موعد، وصورُ الجلسة تلتصق بالشدّة نفسها، والتشخيص
 * يبقى تاريخًا يُقرأ، والخطّ الزمني يعرض القصة كلّها في صفحةٍ واحدة.
 */

export interface OrthoFollowupRow {
  caseId: number;
  patientId: number;
  patientName: string;
  patientPhone: string | null;
  status: "active" | "retention";
  phase: string;
  startDate: string;
  lastAdjustmentDate: string | null;
  nextWeeks: number;
  upperWire: string | null;
  lowerWire: string | null;
  nextAppointment: { id: number; date: string; time: string; status: string } | null;
  lastWasNoShow: boolean;
}

/**
 * لوحة متابعة التقويم — صفٌّ لكل حالةٍ جارية بكل ما يلزم لتصنيفها.
 *
 * أقربُ موعدٍ يُختار بقاعدةٍ واحدة: المستقبل الأقرب أولًا فإن لم يوجد فأحدث ماضٍ
 * محجوز (تجاوزوه ولم يُنفَّذ). وقاعدةُ «لم يحضروا» تُقرأ من آخر موعدٍ غيابيّ
 * للمريض — فيرى الاستقبال الغياب حتى لو حُجز موعدٌ جديد بعده، لأن الحجز الجديد
 * لا يمحو الغياب ولا الدرس فيه.
 */
export async function orthoFollowupBoard(today: string): Promise<OrthoFollowupRow[]> {
  await ensureSchema();
  const { rows } = await getPool().query<{
    case_id: number; patient_id: number; full_name: string; phone: string | null;
    status: string; phase: string; start_date: Date; last_adjustment_date: string | null;
    next_weeks: number | null; upper_wire: string | null; lower_wire: string | null;
    appt_id: number | null; appt_date: string | null; appt_time: string | null;
    appt_status: string | null; last_no_show: boolean;
  }>(
    `WITH nearest AS (
       SELECT ap.id, ap.patient_id, ap.scheduled_date::text AS date,
              to_char(ap.scheduled_time, 'HH24:MI') AS time, ap.status,
              ROW_NUMBER() OVER (
                PARTITION BY ap.patient_id
                ORDER BY (ap.scheduled_date < $1::date),
                        CASE WHEN ap.scheduled_date >= $1::date THEN ap.scheduled_date END ASC,
                        CASE WHEN ap.scheduled_date <  $1::date THEN ap.scheduled_date END DESC
              ) AS rn
         FROM appointments ap
        WHERE ap.status IN ('booked', 'arrived')
     ),
     noshow AS (
       SELECT patient_id, TRUE AS was
         FROM appointments a
        WHERE a.status = 'no_show'
          AND a.id = (SELECT a2.id FROM appointments a2
                       WHERE a2.patient_id = a.patient_id AND a2.status = 'no_show'
                       ORDER BY a2.scheduled_date DESC, a2.id DESC LIMIT 1)
     )
     SELECT c.id AS case_id, c.patient_id, p.full_name, p.phone, c.status, c.phase,
            c.start_date, a.last_adjustment_date, a.next_weeks,
            a.upper_wire, a.lower_wire,
            n.id AS appt_id, n.date AS appt_date, n.time AS appt_time, n.status AS appt_status,
            COALESCE(ns.was, FALSE) AS last_no_show
       FROM ortho_cases c
       JOIN patients p ON p.id = c.patient_id
       LEFT JOIN LATERAL (
         SELECT oa.done_on::text AS last_adjustment_date, oa.next_weeks,
                oa.upper_wire, oa.lower_wire
           FROM ortho_adjustments oa
          WHERE oa.case_id = c.id
          ORDER BY oa.done_on DESC, oa.id DESC LIMIT 1
       ) a ON TRUE
       LEFT JOIN LATERAL (
         SELECT id, date, time, status FROM nearest
          WHERE nearest.patient_id = c.patient_id AND nearest.rn = 1
       ) n ON TRUE
       LEFT JOIN noshow ns ON ns.patient_id = c.patient_id
      WHERE c.status IN ('active', 'retention')`,
    [today],
  );
  return rows.map((row) => ({
    caseId: row.case_id,
    patientId: row.patient_id,
    patientName: row.full_name,
    patientPhone: row.phone,
    status: row.status as "active" | "retention",
    phase: row.phase,
    startDate: dateText(row.start_date),
    lastAdjustmentDate: row.last_adjustment_date,
    nextWeeks: row.next_weeks ?? 4,
    upperWire: row.upper_wire,
    lowerWire: row.lower_wire,
    nextAppointment: row.appt_id && row.appt_date && row.appt_time && row.appt_status
      ? { id: row.appt_id, date: row.appt_date, time: row.appt_time, status: row.appt_status }
      : null,
    lastWasNoShow: row.last_no_show,
  }));
}

/** صور شدّاتٍ — ألبوم الجلسة هو صورُها، تُحضَّر دفعةً واحدة لا استعلامًا لكل جلسة. */
async function photosForAdjustments(adjustmentIds: number[]): Promise<Map<number, PatientDocument[]>> {
  if (adjustmentIds.length === 0) return new Map();
  const { rows } = await getPool().query<DocumentRow>(
    `SELECT ${DOCUMENT_COLUMNS} FROM patient_documents
      WHERE adjustment_id = ANY($1::int[]) AND removed_at IS NULL
      ORDER BY COALESCE(taken_on, uploaded_at::date), id`,
    [adjustmentIds],
  );
  const byAdjustment = new Map<number, PatientDocument[]>();
  for (const row of rows) {
    const document = toDocument(row);
    if (document.adjustmentId === null) continue;
    const list = byAdjustment.get(document.adjustmentId) ?? [];
    list.push(document);
    byAdjustment.set(document.adjustmentId, list);
  }
  return byAdjustment;
}

/** كل صور حالة التقويم — لمقارنة Before/Progress/After والعرض المجمع. */
export async function listOrthoCasePhotos(orthoCaseId: number): Promise<PatientDocument[]> {
  await ensureSchema();
  const { rows } = await getPool().query<DocumentRow>(
    `SELECT ${DOCUMENT_COLUMNS} FROM patient_documents
      WHERE ortho_case_id = $1 AND removed_at IS NULL
      ORDER BY COALESCE(taken_on, uploaded_at::date), id`,
    [orthoCaseId],
  );
  return rows.map(toDocument);
}

export interface DiagnosisRecord {
  id: number;
  version: number;
  content: Record<string, unknown>;
  label: string | null;
  orthoCaseId: number | null;
  supersedes: number | null;
  createdBy: string;
  createdAt: string;
}

/** تاريخ التشخيص — الأحدث أولًا، فالقارئ يبدأ من اليوم ويرجع إلى البداية. */
export async function listPatientDiagnoses(patientId: number): Promise<DiagnosisRecord[]> {
  await ensureSchema();
  const { rows } = await getPool().query<{
    id: number; version: number; content: Record<string, unknown>;
    label: string | null; ortho_case_id: number | null; supersedes: number | null;
    created_by: string; created_at: Date;
  }>(
    `SELECT id, version, content, label, ortho_case_id, supersedes, created_by, created_at
       FROM patient_diagnoses WHERE patient_id = $1
      ORDER BY created_at DESC, id DESC`,
    [patientId],
  );
  return rows.map((row) => ({
    id: row.id,
    version: row.version,
    content: row.content,
    label: row.label,
    orthoCaseId: row.ortho_case_id,
    supersedes: row.supersedes,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  }));
}

/**
 * يفتح نسخة تشخيصٍ جديدة — لا يعدّل سلفًا.
 *
 * رقم النسخة وسلسلتها يُحسَبان داخل القفل الاستشاري على آخر نسخة: جهازان
 * يحدّثان في اللحظة نفسها فتترتب النسختان لا تصطدمان في الرقم نفسه.
 */
export async function recordPatientDiagnosis(input: {
  patientId: number;
  content: Record<string, unknown>;
  label: string | null;
  orthoCaseId: number | null;
  visitId: number | null;
  createdBy: string;
}): Promise<{ id: number; version: number }> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows: latest } = await client.query<{ id: number; version: number }>(
      `SELECT id, version FROM patient_diagnoses WHERE patient_id = $1
        ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [input.patientId],
    );
    const nextVersion = (latest[0]?.version ?? 0) + 1;
    const { rows } = await client.query<{ id: number; version: number }>(
      `INSERT INTO patient_diagnoses
         (patient_id, version, content, label, ortho_case_id, visit_id, supersedes, created_by)
       VALUES ($1, $2, $3::jsonb, $4::text, $5::int, $6::int, $7::int, $8)
       RETURNING id, version`,
      [
        input.patientId, nextVersion, JSON.stringify(input.content), input.label,
        input.orthoCaseId, input.visitId, latest[0]?.id ?? null, input.createdBy,
      ],
    );
    await client.query("COMMIT");
    return { id: rows[0].id, version: rows[0].version };
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
  patientId?: number | null;
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
      `INSERT INTO inventory_movements (item_id, kind, qty, expiry_date, reason, visit_id, patient_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING
         id, item_id, kind, qty, expiry_date, reason, visit_id, created_by, created_at`,
      [
        input.itemId, input.kind,
        input.kind === "adjust" ? input.qty : Math.abs(input.qty),
        expiry, input.reason ?? null, input.visitId ?? null, input.patientId ?? null, input.createdBy,
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

// ─── المراسلة الداخلية ───────────────────────────────────────────────────────

/** صف رسالة كما يُعرض في المحادثة — جسم الصوت والمرفق لا يُحمّلان في القوائم أبدًا. */
export interface MessageReplyView {
  id: number;
  senderName: string | null;
  kind: "text" | "voice" | "file";
  body: string | null;
  voiceMs: number | null;
  fileName: string | null;
  deleted: boolean;
}

export interface MessageView {
  id: number;
  senderType: "user" | "patient";
  senderUserId: number | null;
  senderPatientId: number | null;
  senderName: string | null;
  recipientType: "user" | "patient" | "staff_all";
  recipientUserId: number | null;
  recipientPatientId: number | null;
  body: string | null;
  kind: "text" | "voice" | "file";
  voiceMime: string | null;
  voiceMs: number | null;
  fileName: string | null;
  fileMime: string | null;
  fileSize: number | null;
  createdAt: string;
  isUrgent: boolean;
  editedAt: string | null;
  deletedAt: string | null;
  replyToId: number | null;
  replyTo: MessageReplyView | null;
  /** وقت قراءة الطرف الآخر لرسالتي — صحّان عند العرض لمرسِلها فقط. */
  readAt: string | null;
}

interface MessageRow {
  id: number;
  sender_type: "user" | "patient";
  sender_user_id: number | null;
  sender_patient_id: number | null;
  sender_name: string | null;
  recipient_type: "user" | "patient" | "staff_all";
  recipient_user_id: number | null;
  recipient_patient_id: number | null;
  body: string | null;
  kind: "text" | "voice" | "file";
  voice_mime: string | null;
  voice_ms: number | null;
  file_name: string | null;
  file_mime: string | null;
  file_size: number | null;
  created_at: Date;
  is_urgent: boolean;
  edited_at: Date | null;
  deleted_at: Date | null;
  reply_to_id: number | null;
  reply_kind: "text" | "voice" | "file" | null;
  reply_body: string | null;
  reply_voice_ms: number | null;
  reply_file_name: string | null;
  reply_deleted_at: Date | null;
  reply_sender_name: string | null;
  read_at: Date | null;
}

const MESSAGE_COLUMNS = `
  m.id, m.sender_type, m.sender_user_id, m.sender_patient_id, m.recipient_type,
  m.recipient_user_id, m.recipient_patient_id, m.body, m.kind, m.voice_mime, m.voice_ms,
  m.file_name, m.file_mime, m.file_size, m.created_at,
  m.is_urgent, m.edited_at, m.deleted_at, m.reply_to_id,
  rm.kind AS reply_kind, rm.body AS reply_body, rm.voice_ms AS reply_voice_ms,
  rm.file_name AS reply_file_name, rm.deleted_at AS reply_deleted_at,
  CASE WHEN rm.sender_type = 'user' THEN ru.display_name ELSE rp.full_name END AS reply_sender_name,
  CASE WHEN m.sender_type = 'user' THEN u.display_name ELSE p.full_name END AS sender_name,
  CASE
    WHEN m.sender_type = 'user' AND m.recipient_type = 'user'
      THEN (SELECT MIN(mr.read_at) FROM message_reads mr
             WHERE mr.message_id = m.id AND mr.user_id = m.recipient_user_id)
    WHEN m.sender_type = 'patient'
      THEN (SELECT MIN(mr.read_at) FROM message_reads mr WHERE mr.message_id = m.id)
    ELSE m.patient_read_at
  END AS read_at
  FROM messages m
  LEFT JOIN users u ON m.sender_type = 'user' AND u.id = m.sender_user_id
  LEFT JOIN patients p ON m.sender_type = 'patient' AND p.id = m.sender_patient_id
  LEFT JOIN messages rm ON rm.id = m.reply_to_id
  LEFT JOIN users ru ON rm.sender_type = 'user' AND ru.id = rm.sender_user_id
  LEFT JOIN patients rp ON rm.sender_type = 'patient' AND rp.id = rm.sender_patient_id`;

function toMessageView(row: MessageRow): MessageView {
  const reply: MessageReplyView | null = row.reply_to_id && row.reply_kind
    ? {
        id: row.reply_to_id,
        senderName: row.reply_sender_name,
        kind: row.reply_kind,
        body: row.reply_body,
        voiceMs: row.reply_voice_ms,
        fileName: row.reply_file_name,
        deleted: Boolean(row.reply_deleted_at),
      }
    : null;
  return {
    id: row.id,
    senderType: row.sender_type,
    senderUserId: row.sender_user_id,
    senderPatientId: row.sender_patient_id,
    senderName: row.sender_name,
    recipientType: row.recipient_type,
    recipientUserId: row.recipient_user_id,
    recipientPatientId: row.recipient_patient_id,
    body: row.body,
    kind: row.kind,
    voiceMime: row.voice_mime,
    voiceMs: row.voice_ms,
    fileName: row.file_name,
    fileMime: row.file_mime,
    fileSize: row.file_size,
    createdAt: row.created_at.toISOString(),
    isUrgent: Boolean(row.is_urgent),
    editedAt: row.edited_at ? row.edited_at.toISOString() : null,
    deletedAt: row.deleted_at ? row.deleted_at.toISOString() : null,
    replyToId: row.reply_to_id,
    replyTo: reply,
    readAt: row.read_at ? row.read_at.toISOString() : null,
  };
}

export interface SendMessageInput {
  senderType: "user" | "patient";
  senderUserId: number | null;
  senderPatientId: number | null;
  recipientType: "user" | "patient" | "staff_all";
  recipientUserId: number | null;
  recipientPatientId: number | null;
  body: string | null;
  kind: "text" | "voice" | "file";
  voiceMime: string | null;
  voiceData: string | null;
  voiceMs: number | null;
  fileName: string | null;
  fileMime: string | null;
  fileSize: number | null;
  fileData: string | null;
  /** عاجلة — من بوابة المريض حصرًا؛ الإرسال من الطاقم يتجاهلها. */
  isUrgent?: boolean;
  /** ردّ على رسالة سابقة في الخيط نفسه — يُتحقق منها قبل الإدراج. */
  replyToId?: number | null;
}

/**
 * هل تقع الرسالة المردود عليها في الخيط نفسه الذي يُرسل إليه؟
 *
 * الردّ اقتباس فقرة من المحادثة، والاقتباس من خيطٍ آخر تحويلٌ خفي للسياق:
 * من يفتح خيط المريض يرى اقتباسًا من محادثة زميلين ما كان له أن يراها.
 * الفحص هنا يطابق مفاتيح الخيط (طرفي المحادثة المباشرة، أو خيط المريض، أو
 * الخيط الجماعي) فلا يعبر ردٌّ جدارًا بين المحادثات.
 */
async function replyFitsThread(replyToId: number, input: {
  senderType: "user" | "patient";
  senderUserId: number | null;
  senderPatientId: number | null;
  recipientType: "user" | "patient" | "staff_all";
  recipientUserId: number | null;
  recipientPatientId: number | null;
}): Promise<boolean> {
  const { rows } = await getPool().query<{
    sender_type: string; sender_user_id: number | null; sender_patient_id: number | null;
    recipient_type: string; recipient_user_id: number | null; recipient_patient_id: number | null;
  }>(
    `SELECT sender_type, sender_user_id, sender_patient_id,
       recipient_type, recipient_user_id, recipient_patient_id
     FROM messages WHERE id = $1 AND deleted_at IS NULL`,
    [replyToId],
  );
  const reply = rows[0];
  if (!reply) return false;

  // محادثة مباشرة بين عضوين: الردّ يجب أن يكون من رسائل هذا الثنائي بالذات.
  if (input.recipientType === "user" && input.senderType === "user") {
    const pair = new Set([input.senderUserId, input.recipientUserId]);
    return reply.sender_type === "user" && reply.recipient_type === "user"
      && pair.has(reply.sender_user_id) && pair.has(reply.recipient_user_id);
  }

  // خيط مريض: الردّ من رسائل هذا المريض أو إليه.
  const threadPatientId = input.senderType === "patient"
    ? input.senderPatientId
    : input.recipientType === "patient" ? input.recipientPatientId : null;
  if (threadPatientId !== null) {
    return (reply.sender_type === "patient" && reply.sender_patient_id === threadPatientId)
      || (reply.recipient_type === "patient" && reply.recipient_patient_id === threadPatientId);
  }

  // الخيط الجماعي للطاقم.
  if (input.recipientType === "staff_all" && input.senderType === "user") {
    return reply.sender_type === "user" && reply.recipient_type === "staff_all";
  }
  return false;
}

/**
 * إدراج رسالة واحدة — كل مرسِل يمرّ من هنا: الطاقم والبوابة على السواء.
 *
 * المرسِل يقرأ رسالته مقروءةً من لحظتها (سطر قراءةٍ له) فلا تظهر له غير مقروءة
 * في محادثته هو، بينما تبقى عند الطرف الآخر حتى يفتحها.
 */
export async function insertMessage(input: SendMessageInput): Promise<MessageView> {
  await ensureSchema();
  const urgent = input.isUrgent === true && input.senderType === "patient";
  let replyToId: number | null = null;
  if (input.replyToId) {
    const fits = await replyFitsThread(input.replyToId, input);
    if (!fits) throw new Error("reply-out-of-thread");
    replyToId = input.replyToId;
  }
  const { rows } = await getPool().query<MessageRow>(
    `INSERT INTO messages (
       sender_type, sender_user_id, sender_patient_id,
       recipient_type, recipient_user_id, recipient_patient_id,
       body, kind, voice_mime, voice_data, voice_ms,
       file_name, file_mime, file_size, file_data, is_urgent, reply_to_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING id, sender_type, sender_user_id, sender_patient_id,
       recipient_type, recipient_user_id, recipient_patient_id,
       body, kind, voice_mime, voice_ms,
       file_name, file_mime, file_size, created_at,
       is_urgent, edited_at, deleted_at, reply_to_id`,
    [
      input.senderType, input.senderUserId, input.senderPatientId,
      input.recipientType, input.recipientUserId, input.recipientPatientId,
      input.body, input.kind, input.voiceMime, input.voiceData, input.voiceMs,
      input.fileName, input.fileMime, input.fileSize, input.fileData,
      urgent, replyToId,
    ],
  );
  const row = rows[0];
  let senderName: string | null = null;
  if (input.senderType === "user" && input.senderUserId) {
    const nameRes = await getPool().query<{ display_name: string }>(
      `SELECT display_name FROM users WHERE id = $1`, [input.senderUserId],
    );
    senderName = nameRes.rows[0]?.display_name ?? null;
  } else if (input.senderType === "patient" && input.senderPatientId) {
    const nameRes = await getPool().query<{ full_name: string }>(
      `SELECT full_name FROM patients WHERE id = $1`, [input.senderPatientId],
    );
    senderName = nameRes.rows[0]?.full_name ?? null;
  }
  if (input.senderType === "user" && input.senderUserId) {
    await getPool().query(
      `INSERT INTO message_reads (message_id, user_id) VALUES ($1, $2)
       ON CONFLICT (message_id, user_id) DO NOTHING`,
      [row.id, input.senderUserId],
    );
  }
  return toMessageView({
    ...row,
    sender_name: senderName,
    reply_kind: null, reply_body: null, reply_voice_ms: null,
    reply_file_name: null, reply_deleted_at: null, reply_sender_name: null,
    read_at: null,
  });
}

/**
 * رسائل محادثة مباشرة بين عضوين من الطاقم — بالترتيب، وبلا جسم الصوت.
 *
 * القراءة هنا شخصية: صحّا التعليم لرسالتي يظهران عندما فتحها زميلي، والفحص
 * داخل الاستعلام على سطر قراءة الطرف الآخر بالذات لا أي سطر.
 */
export async function directMessages(userId: number, otherUserId: number): Promise<MessageView[]> {
  await ensureSchema();
  const { rows } = await getPool().query<MessageRow>(
    `SELECT ${MESSAGE_COLUMNS}
     WHERE m.sender_type = 'user' AND m.recipient_type = 'user'
       AND ((m.sender_user_id = $1 AND m.recipient_user_id = $2)
         OR (m.sender_user_id = $2 AND m.recipient_user_id = $1))
     ORDER BY m.id ASC LIMIT 500`,
    [userId, otherUserId],
  );
  return rows.map(toMessageView);
}

/**
 * رسائل خيط المريض — كل ما قيل بين المريض والعيادة، من أيّ طرف كان.
 *
 * رسائل المريض موجّهة إلى الطاقم كلهم (staff_all) فردّ الطاقم موجّه إلى المريض،
 * والخيط يجمعهما في شاشة واحدة يقرؤها الطاقم جميعًا. وصحّا القراءة لكل رسالة:
 * رسالة المريض قرأها أول طاقم فتحها (أقرب قراءة من message_reads)، ورسالة
 * الطاقم قرأها المريض لحظة فتحه البوابة (عمود patient_read_at).
 */
export async function patientThreadMessages(patientId: number): Promise<MessageView[]> {
  await ensureSchema();
  const { rows } = await getPool().query<MessageRow>(
    `SELECT ${MESSAGE_COLUMNS}
     WHERE (m.sender_type = 'patient' AND m.sender_patient_id = $1)
        OR (m.recipient_type = 'patient' AND m.recipient_patient_id = $1)
     ORDER BY m.id ASC LIMIT 500`,
    [patientId],
  );
  return rows.map(toMessageView);
}

/**
 * فتح المريض خيطه قراءةٌ لردّ الطاقم — علامة صحّين عند المرسِل.
 *
 * التحديث شرطيّ على patient_read_at IS NULL فلا يمسّ الطابع الزمني الأول للقراءة
 * مهما أعاد المريض فتح البوابة — الصحّان يحكيان «وصلت عيناه» لا «فتح التبويب».
 */
export async function markPatientThreadReadByPatient(patientId: number): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `UPDATE messages SET patient_read_at = NOW()
     WHERE recipient_type = 'patient' AND recipient_patient_id = $1
       AND patient_read_at IS NULL AND deleted_at IS NULL`,
    [patientId],
  );
}

/**
 * تعليم محادثة مقروءة لمستخدم واحد.
 *
 * تشمل الرسائل الموجهة إليه شخصيًا (direct) والواردة من المرضى (staff_all) في
 * هذه المحادثة وحدها — فتحُ المحادثة قراءةٌ لها، ولا يُمسّ ما لم يُفتح.
 */
export async function markConversationRead(userId: number, scope: {
  withUserId?: number; withPatientId?: number; broadcast?: boolean;
}): Promise<void> {
  await ensureSchema();
  const params: unknown[] = [userId];
  let scopeSql = "";
  if (scope.broadcast) {
    scopeSql = `m.recipient_type = 'staff_all' AND m.sender_type = 'user'`;
  } else if (scope.withUserId) {
    params.push(scope.withUserId);
    const other = params.length;
    scopeSql = `
      ((m.sender_user_id = $${other} AND m.recipient_type = 'user' AND m.recipient_user_id = $1)
        OR (m.recipient_user_id = $${other} AND m.sender_type = 'user' AND m.sender_user_id = $1))`;
  } else if (scope.withPatientId) {
    params.push(scope.withPatientId);
    const patient = params.length;
    scopeSql = `
      ((m.sender_type = 'patient' AND m.sender_patient_id = $${patient})
        OR (m.recipient_type = 'patient' AND m.recipient_patient_id = $${patient}))`;
  } else {
    return;
  }
  await getPool().query(
    `INSERT INTO message_reads (message_id, user_id)
     SELECT m.id, $1 FROM messages m
     WHERE ${scopeSql}
       AND NOT EXISTS (
         SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.user_id = $1
       )`,
    params,
  );
}

/**
 * الخيط الجماعي للطاقم: كل رسالة بثّها عضوٌ للفريق كله — صفٌّ واحدٌ يراه
 * الجميع، وقراءةٌ شخصية لكل عضو على حدة.
 */
export async function broadcastMessages(): Promise<MessageView[]> {
  await ensureSchema();
  const { rows } = await getPool().query<MessageRow>(
    `SELECT ${MESSAGE_COLUMNS}
     WHERE m.recipient_type = 'staff_all' AND m.sender_type = 'user'
     ORDER BY m.id ASC LIMIT 500`,
  );
  return rows.map(toMessageView);
}

/** رسالة بمعرفها بصيغة العرض — لاستجابات التعديل والحذف. */
async function getMessageViewById(id: number): Promise<MessageView | null> {
  const { rows } = await getPool().query<MessageRow>(
    `SELECT ${MESSAGE_COLUMNS} WHERE m.id = $1`,
    [id],
  );
  const row = rows[0];
  return row ? toMessageView(row) : null;
}

export type MessageMutationResult =
  | { ok: true; message: MessageView }
  | { ok: false; reason: "not-found" | "not-allowed" };

/**
 * تعديل رسالة نصية أرسلها عضو طاقم — ملكية النصّ شرطٌ في نفس السطر.
 *
 * التعديل للنصّ حده، وصاحبه وحده، وما لم يُحذف: محاولة تعديل كلام غيري أو صوت
 * أو رسالة محذوفة تفشل في شرط WHERE نفسه فلا سباق ولا تحقّق مزدوج. والمحرّر
 * يُختم بedited_at فيعلم من يقرأ أن النصّ الذي أمامه قيل ثم قُوّل.
 */
export async function editStaffMessage(
  messageId: number, userId: number, body: string,
): Promise<MessageMutationResult> {
  await ensureSchema();
  const { rowCount } = await getPool().query(
    `UPDATE messages SET body = $3, edited_at = NOW()
     WHERE id = $1 AND sender_type = 'user' AND sender_user_id = $2
       AND kind = 'text' AND deleted_at IS NULL`,
    [messageId, userId, body],
  );
  if (!rowCount) return { ok: false, reason: "not-allowed" };
  const view = await getMessageViewById(messageId);
  if (!view) return { ok: false, reason: "not-found" };
  return { ok: true, message: view };
}

/** حذف لطيف لرسالة أرسلها عضو طاقم — قبرٌ يُرى مكانه، لا اختفاء يُنكر الكلام. */
export async function deleteStaffMessage(
  messageId: number, userId: number,
): Promise<MessageMutationResult> {
  await ensureSchema();
  const { rowCount } = await getPool().query(
    `UPDATE messages SET deleted_at = NOW()
     WHERE id = $1 AND sender_type = 'user' AND sender_user_id = $2
       AND deleted_at IS NULL`,
    [messageId, userId],
  );
  if (!rowCount) return { ok: false, reason: "not-allowed" };
  const view = await getMessageViewById(messageId);
  if (!view) return { ok: false, reason: "not-found" };
  return { ok: true, message: view };
}

/** تعديل رسالة المريض النصية من البوابة — ملكية المريض في شرط التحديث نفسه. */
export async function editPatientMessage(
  messageId: number, patientId: number, body: string,
): Promise<MessageMutationResult> {
  await ensureSchema();
  const { rowCount } = await getPool().query(
    `UPDATE messages SET body = $3, edited_at = NOW()
     WHERE id = $1 AND sender_type = 'patient' AND sender_patient_id = $2
       AND kind = 'text' AND deleted_at IS NULL`,
    [messageId, patientId, body],
  );
  if (!rowCount) return { ok: false, reason: "not-allowed" };
  const view = await getMessageViewById(messageId);
  if (!view) return { ok: false, reason: "not-found" };
  return { ok: true, message: view };
}

/** حذف لطيف لرسالة المريض من البوابة. */
export async function deletePatientMessage(
  messageId: number, patientId: number,
): Promise<MessageMutationResult> {
  await ensureSchema();
  const { rowCount } = await getPool().query(
    `UPDATE messages SET deleted_at = NOW()
     WHERE id = $1 AND sender_type = 'patient' AND sender_patient_id = $2
       AND deleted_at IS NULL`,
    [messageId, patientId],
  );
  if (!rowCount) return { ok: false, reason: "not-allowed" };
  const view = await getMessageViewById(messageId);
  if (!view) return { ok: false, reason: "not-found" };
  return { ok: true, message: view };
}

/** جهة اتصال الطاقم: المستخدم النشط وحالة محادثته معي. */
export interface StaffConversationItem {
  userId: number;
  username: string;
  displayName: string;
  role: string;
  lastMessageId: number | null;
  lastKind: "text" | "voice" | "file" | null;
  lastBody: string | null;
  lastVoiceMs: number | null;
  lastFileName: string | null;
  lastAt: string | null;
  lastFromMe: boolean;
  lastDeleted: boolean;
  lastUrgent: boolean;
  unread: number;
}

/** خيط مريض: المريض وآخر ما قيل في خيطه. */
export interface PatientConversationItem {
  patientId: number;
  patientName: string;
  patientNumber: string;
  phone: string | null;
  lastMessageId: number | null;
  lastKind: "text" | "voice" | "file" | null;
  lastBody: string | null;
  lastVoiceMs: number | null;
  lastFileName: string | null;
  lastAt: string | null;
  lastFromPatient: boolean;
  lastDeleted: boolean;
  lastUrgent: boolean;
  unread: number;
  /** رسائل عاجلة لم يقرأها أحد بعد — تتصدر القائمة وتحمرّ. */
  urgentUnread: number;
}

/** الخيط الجماعي للطاقم: آخر بثّ وحالته عندي. */
export interface BroadcastSummary {
  lastMessageId: number | null;
  lastKind: "text" | "voice" | "file" | null;
  lastBody: string | null;
  lastVoiceMs: number | null;
  lastFileName: string | null;
  lastAt: string | null;
  lastFromMe: boolean;
  lastDeleted: boolean;
  lastUrgent: boolean;
  lastSenderName: string | null;
  unread: number;
}

/**
 * قائمة محادثات مستخدم الطاقم: زملاؤه النشطون جميعًا (بمن لم يخاطبه بعد —
 * لتبدأ المحادثة من الشاشة نفسها) ومرضاه الذين في خيطهم رسالة واحدة على الأقل.
 *
 * غير المقروء يحسب من سطور القراءة لا من عمود على الرسالة: قراءةُ صندوق
 * المرضى شخصية لكل عضو، وقراءةُ المحادثة المباشرة كذلك.
 */
export async function staffConversationList(userId: number): Promise<{
  staff: StaffConversationItem[];
  patients: PatientConversationItem[];
  broadcast: BroadcastSummary;
}> {
  await ensureSchema();
  const pool = getPool();

  const [usersRes, dmLastRes, dmUnreadRes, patientLastRes, patientUnreadRes, patientUrgentRes, broadcastRes, broadcastUnreadRes] = await Promise.all([
    pool.query<{ id: number; username: string; display_name: string; role: string }>(
      `SELECT id, username, display_name, role FROM users
        WHERE is_active = TRUE AND id <> $1 ORDER BY display_name`,
      [userId],
    ),
    pool.query<{
      other_id: number; id: number; kind: "text" | "voice" | "file"; body: string | null;
      voice_ms: number | null; file_name: string | null; created_at: Date; sender_user_id: number | null;
      deleted_at: Date | null; is_urgent: boolean;
    }>(
      `SELECT DISTINCT ON (other_id) other_id, id, kind, body, voice_ms, file_name, created_at, sender_user_id,
         deleted_at, is_urgent
       FROM (
         SELECT id, kind, body, voice_ms, file_name, created_at, sender_user_id, recipient_user_id,
           deleted_at, is_urgent,
           CASE WHEN sender_user_id = $1 THEN recipient_user_id ELSE sender_user_id END AS other_id
         FROM messages
         WHERE sender_type = 'user' AND recipient_type = 'user'
           AND (sender_user_id = $1 OR recipient_user_id = $1)
       ) convo
       ORDER BY other_id, id DESC`,
      [userId],
    ),
    pool.query<{ sender_user_id: number; unread: number }>(
      `SELECT m.sender_user_id, count(*)::int AS unread
       FROM messages m
       WHERE m.recipient_type = 'user' AND m.recipient_user_id = $1 AND m.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.user_id = $1)
       GROUP BY m.sender_user_id`,
      [userId],
    ),
    pool.query<{
      patient_id: number; patient_name: string; patient_number: string; phone: string | null;
      id: number; kind: "text" | "voice" | "file"; body: string | null;
      voice_ms: number | null; file_name: string | null; created_at: Date; sender_type: "user" | "patient";
      deleted_at: Date | null; is_urgent: boolean;
    }>(
      `SELECT DISTINCT ON (patient_id) patient_id, patient_name, patient_number, phone,
         id, kind, body, voice_ms, file_name, created_at, sender_type, deleted_at, is_urgent
       FROM (
         SELECT m.id, m.kind, m.body, m.voice_ms, m.file_name, m.created_at, m.sender_type,
           m.deleted_at, m.is_urgent,
           p.id AS patient_id, p.full_name AS patient_name, p.patient_number AS patient_number, p.phone AS phone
         FROM messages m
         JOIN patients p ON (m.sender_type = 'patient' AND m.sender_patient_id = p.id)
                        OR (m.recipient_type = 'patient' AND m.recipient_patient_id = p.id)
       ) thread
       ORDER BY patient_id, id DESC`,
    ),
    pool.query<{ patient_id: number; unread: number }>(
      `SELECT m.sender_patient_id AS patient_id, count(*)::int AS unread
       FROM messages m
       WHERE m.recipient_type = 'staff_all' AND m.sender_type = 'patient' AND m.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.user_id = $1)
       GROUP BY m.sender_patient_id`,
      [userId],
    ),
    pool.query<{ patient_id: number; urgent: number }>(
      `SELECT m.sender_patient_id AS patient_id, count(*)::int AS urgent
       FROM messages m
       WHERE m.recipient_type = 'staff_all' AND m.sender_type = 'patient'
         AND m.is_urgent AND m.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.user_id = $1)
       GROUP BY m.sender_patient_id`,
      [userId],
    ),
    pool.query<{
      id: number; kind: "text" | "voice" | "file"; body: string | null;
      voice_ms: number | null; file_name: string | null; created_at: Date;
      sender_user_id: number | null; sender_name: string | null;
      deleted_at: Date | null; is_urgent: boolean;
    }>(
      `SELECT m.id, m.kind, m.body, m.voice_ms, m.file_name, m.created_at,
         m.sender_user_id, u.display_name AS sender_name, m.deleted_at, m.is_urgent
       FROM messages m
       LEFT JOIN users u ON u.id = m.sender_user_id
       WHERE m.recipient_type = 'staff_all' AND m.sender_type = 'user'
       ORDER BY m.id DESC LIMIT 1`,
    ),
    pool.query<{ unread: number }>(
      `SELECT count(*)::int AS unread FROM messages m
       WHERE m.recipient_type = 'staff_all' AND m.sender_type = 'user'
         AND m.sender_user_id <> $1 AND m.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.user_id = $1)`,
      [userId],
    ),
  ]);

  const lastByOther = new Map(dmLastRes.rows.map((row) => [row.other_id, row]));
  const unreadBySender = new Map(dmUnreadRes.rows.map((row) => [row.sender_user_id, row.unread]));

  const staff: StaffConversationItem[] = usersRes.rows.map((user) => {
    const last = lastByOther.get(user.id);
    return {
      userId: user.id,
      username: user.username,
      displayName: user.display_name,
      role: user.role,
      lastMessageId: last?.id ?? null,
      lastKind: last?.kind ?? null,
      lastBody: last?.body ?? null,
      lastVoiceMs: last?.voice_ms ?? null,
      lastFileName: last?.file_name ?? null,
      lastAt: last ? last.created_at.toISOString() : null,
      lastFromMe: last ? last.sender_user_id === userId : false,
      lastDeleted: Boolean(last?.deleted_at),
      lastUrgent: Boolean(last?.is_urgent),
      unread: unreadBySender.get(user.id) ?? 0,
    };
  });

  const unreadByPatient = new Map(patientUnreadRes.rows.map((row) => [row.patient_id, row.unread]));
  const urgentByPatient = new Map(patientUrgentRes.rows.map((row) => [row.patient_id, row.urgent]));
  const patients: PatientConversationItem[] = patientLastRes.rows.map((row) => ({
    patientId: row.patient_id,
    patientName: row.patient_name,
    patientNumber: row.patient_number,
    phone: row.phone,
    lastMessageId: row.id,
    lastKind: row.kind,
    lastBody: row.body,
    lastVoiceMs: row.voice_ms,
    lastFileName: row.file_name,
    lastAt: row.created_at.toISOString(),
    lastFromPatient: row.sender_type === "patient",
    lastDeleted: Boolean(row.deleted_at),
    lastUrgent: Boolean(row.is_urgent),
    unread: unreadByPatient.get(row.patient_id) ?? 0,
    urgentUnread: urgentByPatient.get(row.patient_id) ?? 0,
  }));

  patients.sort((a, b) => {
    if (a.urgentUnread !== b.urgentUnread) return b.urgentUnread - a.urgentUnread;
    if (a.unread !== b.unread) return b.unread - a.unread;
    return (b.lastMessageId ?? 0) - (a.lastMessageId ?? 0);
  });

  const lastBroadcast = broadcastRes.rows[0];
  const broadcast: BroadcastSummary = {
    lastMessageId: lastBroadcast?.id ?? null,
    lastKind: lastBroadcast?.kind ?? null,
    lastBody: lastBroadcast?.body ?? null,
    lastVoiceMs: lastBroadcast?.voice_ms ?? null,
    lastFileName: lastBroadcast?.file_name ?? null,
    lastAt: lastBroadcast ? lastBroadcast.created_at.toISOString() : null,
    lastFromMe: lastBroadcast ? lastBroadcast.sender_user_id === userId : false,
    lastDeleted: Boolean(lastBroadcast?.deleted_at),
    lastUrgent: Boolean(lastBroadcast?.is_urgent),
    lastSenderName: lastBroadcast?.sender_name ?? null,
    unread: Number(broadcastUnreadRes.rows[0]?.unread ?? 0),
  };

  return { staff, patients, broadcast };
}

/** إجمالي غير المقروء عند مستخدم طاقم — لشارة القشرة. المحذوف لا يُعدّ. */
export async function unreadMessageCount(userId: number): Promise<number> {
  await ensureSchema();
  const { rows } = await getPool().query<{ c: number }>(
    `SELECT count(*)::int AS c FROM messages m
     WHERE (
             (m.recipient_type = 'user' AND m.recipient_user_id = $1 AND m.sender_type = 'user')
          OR m.recipient_type = 'staff_all'
           )
       AND m.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.user_id = $1
       )`,
    [userId],
  );
  return Number(rows[0]?.c ?? 0);
}

/**
 * رسائل المرضى العاجلة غير المقروءة عند مستخدم طاقم — وقود بانر الاستغاثة.
 *
 * العدّ شخصي كعدّ غير المقروء: ما فتحه زميلي مرّت عليه عين الطاقم، وتبقى
 * عاجلةً عندي حتى أفتحها أنا. والبانر يظهر ما دام العدد فوق الصفر.
 */
export async function urgentUnreadMessageCount(userId: number): Promise<number> {
  await ensureSchema();
  const { rows } = await getPool().query<{ c: number }>(
    `SELECT count(*)::int AS c FROM messages m
     WHERE m.recipient_type = 'staff_all' AND m.sender_type = 'patient'
       AND m.is_urgent AND m.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.user_id = $1
       )`,
    [userId],
  );
  return Number(rows[0]?.c ?? 0);
}

/** جسم رسالة صوتية مع تحقق الوصول قبل الكشف عن بايت واحد. */
export async function voiceMessagePayload(id: number): Promise<{
  mime: string; data: string;
  senderType: "user" | "patient";
  senderUserId: number | null;
  senderPatientId: number | null;
  recipientType: "user" | "patient" | "staff_all";
  recipientUserId: number | null;
  recipientPatientId: number | null;
} | null> {
  await ensureSchema();
  const { rows } = await getPool().query<{
    voice_mime: string | null; voice_data: string | null;
    sender_type: "user" | "patient";
    sender_user_id: number | null;
    sender_patient_id: number | null;
    recipient_type: "user" | "patient" | "staff_all";
    recipient_user_id: number | null;
    recipient_patient_id: number | null;
  }>(
    `SELECT voice_mime, voice_data, sender_type, sender_user_id, sender_patient_id,
       recipient_type, recipient_user_id, recipient_patient_id
     FROM messages WHERE id = $1 AND kind = 'voice' AND voice_data IS NOT NULL`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    mime: row.voice_mime ?? "audio/webm",
    data: row.voice_data ?? "",
    senderType: row.sender_type,
    senderUserId: row.sender_user_id,
    senderPatientId: row.sender_patient_id,
    recipientType: row.recipient_type,
    recipientUserId: row.recipient_user_id,
    recipientPatientId: row.recipient_patient_id,
  };
}

/** عضو طاقم بمعرفه — لتحقّق جهة الرسالة قبل الإدراج. */
export async function getStaffUserById(id: number): Promise<StaffAccount | null> {
  await ensureSchema();
  const { rows } = await getPool().query<{
    id: number; username: string; display_name: string;
    role: string; is_active: boolean; created_at: Date; party_id: number | null;
  }>(
    `SELECT id, username, display_name, role, is_active, created_at, party_id FROM users WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
    partyId: row.party_id ?? null,
    partyName: null,
  };
}

/**
 * جسم مرفق رسالة — بتحقق الوصول قبل الكشف عن بايت واحد، كجسم الصوت سواء بسواء.
 */
export async function fileMessagePayload(id: number): Promise<{
  mime: string; name: string | null; size: number | null; data: string;
  senderType: "user" | "patient";
  senderUserId: number | null;
  senderPatientId: number | null;
  recipientType: "user" | "patient" | "staff_all";
  recipientUserId: number | null;
  recipientPatientId: number | null;
} | null> {
  await ensureSchema();
  const { rows } = await getPool().query<{
    file_mime: string | null; file_name: string | null; file_size: number | null; file_data: string | null;
    sender_type: "user" | "patient";
    sender_user_id: number | null;
    sender_patient_id: number | null;
    recipient_type: "user" | "patient" | "staff_all";
    recipient_user_id: number | null;
    recipient_patient_id: number | null;
  }>(
    `SELECT file_mime, file_name, file_size, file_data, sender_type, sender_user_id, sender_patient_id,
       recipient_type, recipient_user_id, recipient_patient_id
     FROM messages WHERE id = $1 AND kind = 'file' AND file_data IS NOT NULL`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    mime: row.file_mime ?? "application/octet-stream",
    name: row.file_name,
    size: row.file_size,
    data: row.file_data ?? "",
    senderType: row.sender_type,
    senderUserId: row.sender_user_id,
    senderPatientId: row.sender_patient_id,
    recipientType: row.recipient_type,
    recipientUserId: row.recipient_user_id,
    recipientPatientId: row.recipient_patient_id,
  };
}

/**
 * رسائل المريض في آخر نافذة زمنية — حدّ المعدل لبوابة المريض.
 *
 * صندوق الطاقم مشترك، وإغراقه برسائل آلية أو مزعجة يطمس رسائل المرضى الحقيقيين.
 * العدّ من القاعدة لا من ذاكرة الخادم: إعادة التشغيل لا تصفّر الحدّ.
 */
export async function countRecentPatientMessages(
  patientId: number,
  windowMinutes = 60,
): Promise<number> {
  await ensureSchema();
  const { rows } = await getPool().query<{ c: number }>(
    `SELECT count(*)::int AS c FROM messages
     WHERE sender_type = 'patient' AND sender_patient_id = $1
       AND created_at > NOW() - ($2::int * INTERVAL '1 minute')`,
    [patientId, windowMinutes],
  );
  return Number(rows[0]?.c ?? 0);
}
