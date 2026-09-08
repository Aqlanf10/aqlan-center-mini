-- 0001 — Baseline Schema (P1 Migration Framework Adoption)
-- المصدر: استخراج حرفي لسلسلة SQL داخل ensureSchema() من lib/db.ts كما هي في
-- commit bd9a399 (دمج P0). هذا الملف هو خط الأساس المعتمد: كل DDL هنا idempotent
-- (IF NOT EXISTS) ومطابق تمامًا لما تنتجه ensureSchema على قاعدة فارغة.
--
-- دلالات التطبيق:
--  * قاعدة فارغة جديدة: يُنفَّذ هذا الملف كاملًا فينشئ المخطط.
--  * قاعدة موجودة من النظام الحالي (أنشأتها ensureSchema تاريخيًا): يُعتمد
--    كخط أساس (baseline adoption) — يُسجَّل في schema_migrations دون تنفيذ،
--    بعد فحص توافق (probe) يثبت أن الجداول الحرجة موجودة.
--  * DDL خالص بلا أي بيانات (P1.1): عبارات البذور/التصحيحات المضمّنة في
--    ensureSchema الأصل (ai_settings الافتراضي، مزوّد zai، مزامنة جهات
--    الأطباء، إصلاحات أكواد الحسابات) أُزيلت عمدًا — البيانات تأتي من بذور
--    التطبيق عند التشغيل، أو من ملف الاستعادة عند التدريب/الاستعادة، لا من
--    الهجرة. بهذا لا يصطدم restore بقاعدة هُيّئت بالهجرات (duplicate keys).
--  * الحقول اللاحقة (0002+) هي مصدر التغيّر المُرقَّم المستقبلي.

      CREATE TABLE IF NOT EXISTS staff_login_limits (
        account_key TEXT PRIMARY KEY,
        window_started_at TIMESTAMPTZ NOT NULL,
        attempts INTEGER NOT NULL
      );
      -- حدّ الدخول المشترك (طاقم + بوابة) بمفاتيح HMAC: الحساب دائمًا، والمصدر
      -- خلف وسيطٍ موثوق فقط — انظر lib/loginLimit.ts.
      CREATE TABLE IF NOT EXISTS login_limits (
        key          TEXT PRIMARY KEY,
        window_start TIMESTAMPTZ NOT NULL,
        attempts     INTEGER NOT NULL
      );
      -- استهلاك رموز تأكيد أدوات الذكاء الاصطناعي: كل رمز يُنفَّذ مرةً واحدة
      -- فقط — الاستهلاك ذرّيّ بالإدخال تحت قيد المفتاح الأساسي (P0.6).
      CREATE TABLE IF NOT EXISTS ai_confirmation_claims (
        jti        TEXT PRIMARY KEY,
        user_id    INTEGER NOT NULL,
        tool       TEXT NOT NULL,
        claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
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
        -- نطاق الأسنان (سن مفرد / جسر / فك كامل / عام) وهل تحتاج لون VITA —
        -- من دليل الخدمات تُشتق حقول الطلب: الجسر يفتح دعامات ودمى، والفك الكامل
        -- يخفي رقم السن، واللون إلزامي حين تتطلبه الخدمة.
        tooth_scope  TEXT        NOT NULL DEFAULT 'single_tooth',
        requires_shade BOOLEAN   NOT NULL DEFAULT TRUE,
        default_days INTEGER     NOT NULL DEFAULT 7,
        description  TEXT,
        is_active    BOOLEAN     NOT NULL DEFAULT TRUE,
        sort_order   INTEGER     NOT NULL DEFAULT 100,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS lab_services_active_idx ON lab_services (is_active, sort_order);
      ALTER TABLE lab_services ADD COLUMN IF NOT EXISTS tooth_scope TEXT NOT NULL DEFAULT 'single_tooth';
      ALTER TABLE lab_services ADD COLUMN IF NOT EXISTS requires_shade BOOLEAN NOT NULL DEFAULT TRUE;

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
      -- الربط المالي: حالة التسوية والتكلفة الأساسية بسعر يوم التسجيل تُضافان
      -- بعد إنشاء payables أسفل — العمود الدال على الالتزام يحتاج الجدول نفسه.
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

      -- بوابة التسعير (من مستودع الوكيل الآخر): لا سعر بلا قرار.
      -- price_configured: سعرٌ قرّره المالك؛ price_provisional: سعرٌ تخميني موسوم
      -- تُنبّه عليه الجاهزية حتى يستبدله قرار المالك فيمسح الوسم.
      ALTER TABLE services ADD COLUMN IF NOT EXISTS price_configured BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE services ADD COLUMN IF NOT EXISTS price_provisional BOOLEAN NOT NULL DEFAULT FALSE;

      -- نسب إهلاك المواد لكل تخصص (نقاط أساس: 10000 = 100%) — قرار المالك، لا
      -- رقم افتراضي: تخصّصٌ بلا نسبةٍ محدَّدة لا يُخصم منه شيء ويُقال عدده.
      -- متصلة بالعمولات: انظر lib/materialRate.ts و commissionReport.
      CREATE TABLE IF NOT EXISTS material_rates (
        category   TEXT PRIMARY KEY,
        rate_bp    INTEGER NOT NULL CHECK (rate_bp >= 0 AND rate_bp <= 10000),
        updated_by TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

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

      -- بيانات إضافية للمختبرات والموردين (إدارة المختبرات السنية V2):
      -- واتساب والعنوان وشخص الاتصال وعملة التسعير وأيام التسليم، وربط الحسابات
      -- المحاسبية لكل مختبر (المصروف/الالتزام) وترحيل القيود تلقائيًا عند السداد.
      ALTER TABLE parties ADD COLUMN IF NOT EXISTS whatsapp TEXT;
      ALTER TABLE parties ADD COLUMN IF NOT EXISTS address TEXT;
      ALTER TABLE parties ADD COLUMN IF NOT EXISTS contact_person TEXT;
      ALTER TABLE parties ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'YER';
      ALTER TABLE parties ADD COLUMN IF NOT EXISTS delivery_days INTEGER NOT NULL DEFAULT 7;
      ALTER TABLE parties ADD COLUMN IF NOT EXISTS expense_account_code TEXT NOT NULL DEFAULT '5101';
      ALTER TABLE parties ADD COLUMN IF NOT EXISTS payable_account_code TEXT NOT NULL DEFAULT '2101';
      ALTER TABLE parties ADD COLUMN IF NOT EXISTS auto_post_journal BOOLEAN NOT NULL DEFAULT TRUE;
      ALTER TABLE parties ADD COLUMN IF NOT EXISTS custom_account_name TEXT;

      -- ── صلاحيات الأطباء (من عمل الوكيل المساعد) ────────────────────────────
      -- الطبيب الأساسي للمريض عمودٌ صريح يوسّع عزل الخادم: من ربطه الاستقبال
      -- بجهته يرى ملفه حتى لو لم تُسجّل له زيارة بعد. وموعد الطبيب يعرف جهته
      -- صراحةً فيرى مواعيده وحدها في جدول اليوم ما لم يُمنح رؤية الجميع.
      ALTER TABLE patients ADD COLUMN IF NOT EXISTS primary_doctor_id INTEGER REFERENCES parties(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS patients_primary_doctor_idx ON patients (primary_doctor_id);
      ALTER TABLE appointments ADD COLUMN IF NOT EXISTS doctor_id INTEGER REFERENCES parties(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS appointments_doctor_idx ON appointments (doctor_id);

      -- الزيارات ترث الطبيب المعالج من الموعد أو الاستقبال لحساب العمولات والمتابعة السريرية
      ALTER TABLE visits ADD COLUMN IF NOT EXISTS doctor_id INTEGER REFERENCES parties(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS visits_doctor_idx ON visits (doctor_id);

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

      -- الربط المالي (المختبرات V2): حالة التسوية — هل وُلد الالتزام؟ هل سُدّد؟ —
      -- والالتزام نفسه مربوعًا بالطلب، والتكلفة الأساسية بسعر يوم التسجيل: نفس
      -- دستور الدفعات، السعر منسوخ في الصف لا يُقرأ من الإعدادات بعدها أبدًا.
      -- (هنا بعد إنشاء payables — العمود يشير إليها بمفتاح أجنبي.)
      ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS financial_status  TEXT NOT NULL DEFAULT 'pending_delivery';
      ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS payable_id       INTEGER REFERENCES payables(id) ON DELETE SET NULL;
      ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS base_amount_minor BIGINT;
      ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS exchange_rate     NUMERIC(18,6) NOT NULL DEFAULT 1;
      CREATE INDEX IF NOT EXISTS lab_orders_payable_idx ON lab_orders (payable_id) WHERE payable_id IS NOT NULL;

      -- بنود المصروفات التشغيلية والربط بدليل الحسابات والميزانيات التقديرية:
      -- كل بندٍ تشغيلي (كهرباء، إيجار، تسويق…) له حسابه في الدليل وميزانيته
      -- الشهرية/السنوية وعملتها، وحسابات المختبرات تُرحَّل تلقائيًا من هنا.
      CREATE TABLE IF NOT EXISTS expense_categories (
        id                   SERIAL PRIMARY KEY,
        key                  TEXT UNIQUE NOT NULL,
        name                 TEXT NOT NULL,
        category_group       TEXT NOT NULL DEFAULT 'تشغيلية ومرافق',
        account_code         TEXT NOT NULL DEFAULT '5901',
        monthly_budget_minor BIGINT NOT NULL DEFAULT 0,
        annual_budget_minor  BIGINT NOT NULL DEFAULT 0,
        budget_currency      TEXT NOT NULL DEFAULT 'YER',
        is_active            BOOLEAN NOT NULL DEFAULT TRUE,
        is_system            BOOLEAN NOT NULL DEFAULT FALSE,
        auto_post_journal    BOOLEAN NOT NULL DEFAULT TRUE,
        description          TEXT,
        display_order        INTEGER NOT NULL DEFAULT 0,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS expense_categories_active_idx ON expense_categories (is_active, display_order ASC);
      ALTER TABLE expense_categories ADD COLUMN IF NOT EXISTS auto_post_journal BOOLEAN NOT NULL DEFAULT TRUE;

      -- ربط أوامر المختبر والذمم ببنود المصروفات والترحيل المحاسبي النهائي:
      -- البند يحدد حساب المصروف، وحالة الترحيل تقرر دخول القيد في الدفاتر المشتقة.
      ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS expense_category_id INTEGER REFERENCES expense_categories(id) ON DELETE SET NULL;
      ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS expense_account_code TEXT;
      ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS payable_account_code TEXT;
      ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS is_posted BOOLEAN NOT NULL DEFAULT TRUE;
      ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS posted_at TIMESTAMPTZ;

      ALTER TABLE payables ADD COLUMN IF NOT EXISTS expense_category_id INTEGER REFERENCES expense_categories(id) ON DELETE SET NULL;
      ALTER TABLE payables ADD COLUMN IF NOT EXISTS expense_account_code TEXT;
      ALTER TABLE payables ADD COLUMN IF NOT EXISTS payable_account_code TEXT;
      ALTER TABLE payables ADD COLUMN IF NOT EXISTS is_posted BOOLEAN NOT NULL DEFAULT TRUE;

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
      -- الجلسات المخطَّطة لكل بند: رقم الزيارة التي ينفَّذ فيها البند (تجميع بنود
      -- الخطة في جلسات منظَّمة)، وحالة الفوترة، والجلسات المنجزة، وطبيب البند.
      ALTER TABLE plan_items ADD COLUMN IF NOT EXISTS planned_visit_number INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE plan_items ADD COLUMN IF NOT EXISTS billing_status TEXT NOT NULL DEFAULT 'unbilled';
      ALTER TABLE plan_items ADD COLUMN IF NOT EXISTS sessions_completed INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE plan_items ADD COLUMN IF NOT EXISTS doctor_id INTEGER REFERENCES parties(id);
      -- طريقة استحقاق الخطة كلها: بالخدمات المنفَّذة (الافتراضي) أو بأقساطٍ متفق
      -- عليها (التقويم والباقات). الخطة ببنودٍ وأقساطٍ معًا مسموحة: بنودٌ تُبنى
      -- ويُوزَّع ثمنها أقساطًا — اتفاقٌ واحد بوجهين.
      ALTER TABLE treatment_plans ADD COLUMN IF NOT EXISTS billing_mode TEXT NOT NULL DEFAULT 'per_procedure';
      ALTER TABLE treatment_plans ADD COLUMN IF NOT EXISTS specialty TEXT;
      ALTER TABLE treatment_plans ADD COLUMN IF NOT EXISTS primary_doctor_id INTEGER REFERENCES parties(id);
      -- آخر تذكير أُرسل للمريض عن الخطة أو القسط (واتساب): يمنع إزعاج المريض
      -- بتذكيرات متكررة ويُظهر للمستقبِل متى خُوطب آخر مرة.
      ALTER TABLE treatment_plans ADD COLUMN IF NOT EXISTS last_reminder_at TIMESTAMPTZ;
      ALTER TABLE plan_installments ADD COLUMN IF NOT EXISTS last_reminder_at TIMESTAMPTZ;

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

      -- appointments/planned_visits/visits تشير كلٌّ إلى الأخرى (حجز جلسة تقويم قادمة
      -- يكتب appointments.planned_visit_id وplanned_visits.appointment_id معًا في
      -- معاملة واحدة) — دَورٌ حقيقي في بيانات الإنتاج لا افتراضي. والاستعادة من نسخة
      -- احتياطية تُدرج الصفوف بترتيبٍ ما، فأيّ ترتيب يصطدم بمفتاح أجنبي لصفٍّ لم
      -- يُدرَج بعد. تأجيل هذه القيود إلى COMMIT (بدل فحصها سطرًا سطرًا) يجعل الاستعادة
      -- تصحّ بأي ترتيب إدراج، لأن كل الصفوف تكون قد دخلت قبل أن يُتحقَّق من أي منها.
      ALTER TABLE planned_visits ALTER CONSTRAINT planned_visits_appointment_id_fkey DEFERRABLE INITIALLY DEFERRED;
      ALTER TABLE planned_visits ALTER CONSTRAINT planned_visits_visit_id_fkey DEFERRABLE INITIALLY DEFERRED;
      ALTER TABLE visits ALTER CONSTRAINT visits_planned_visit_id_fkey DEFERRABLE INITIALLY DEFERRED;
      ALTER TABLE visits ALTER CONSTRAINT visits_appointment_id_fkey DEFERRABLE INITIALLY DEFERRED;
      ALTER TABLE appointments ALTER CONSTRAINT appointments_planned_visit_id_fkey DEFERRABLE INITIALLY DEFERRED;

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
      -- أبعاد الصورة (بكسل) من ترويسة الملف وقت الرفع — بلا مكتبة (lib/imageSize.ts):
      -- التراكب والمقارنة يرسمان فوق الشععة فيحتاجان مقاسها الحقيقي، وطباعة التراكب
      -- تُبنى على الخادم فلا متصفّح هناك يقيسها لها.
      ALTER TABLE patient_documents ADD COLUMN IF NOT EXISTS width INTEGER;
      ALTER TABLE patient_documents ADD COLUMN IF NOT EXISTS height INTEGER;
      CREATE INDEX IF NOT EXISTS patient_documents_adjustment_idx ON patient_documents (adjustment_id);
      CREATE INDEX IF NOT EXISTS patient_documents_ortho_idx ON patient_documents (ortho_case_id);

      -- الوصفات كوثائق محفوظة (من مستودع الوكيل الآخر): ما يُطبَّع يُخزَّن كما
      -- طُبِع، والإبطال موثَّق بسببه لا تعديل صامت — والاقتراحات تُبنى على
      -- ما سبق وصفه للمريض نفسه.
      CREATE TABLE IF NOT EXISTS prescriptions (
        id                SERIAL PRIMARY KEY,
        patient_id        INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
        visit_id          INTEGER REFERENCES visits(id) ON DELETE SET NULL,
        diagnosis         TEXT,
        notes             TEXT,
        instructions_lang TEXT NOT NULL DEFAULT 'both'
                         CHECK (instructions_lang IN ('both','ar','en')),
        items             JSONB NOT NULL,
        status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
        void_reason       TEXT,
        voided_by         TEXT,
        voided_at         TIMESTAMPTZ,
        created_by        TEXT NOT NULL,
        doctor_party_id   INTEGER,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS prescriptions_patient_idx ON prescriptions (patient_id, created_at DESC);
      -- نسبة الوصفة إلى جهة الطبيب الصادرة منها (P0.8): الإضافة آمنة تراكميًا
      -- لما رُفع قبل العمود — الوصفات القديمة بلا جهة تبقى بلا جهة.
      ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS doctor_party_id INTEGER;

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

      -- إعلانات شاشة الصالة — سجلٌّ لكل إعلان لا سطرٌ في خانة إعداد واحدة.
      --
      -- الخانة الواحدة (display.announcements) كانت تكفي ثلاثة إعلانات ثم
      -- اصطدمت بحدّ الإعداد الكلي: أربع مئة حرف ترفض العشرين إعلانًا برسالة
      -- «القيمة طويلة أكثر من اللازم»، ولا يمكن تعطيل إعلانٍ واحد أو ترتيبه إلا
      -- بإعادة كتابة الخانة كلها. هنا لكل إعلانٍ سطره: عنوانه ونصّه وترتيبه
      -- وتفعيله ومَن مسّه آخرًا. والترتيب أرقام متتالية تُعاد كتابتها كلها عند
      -- كل ترتيبٍ جديد فلا تتشابك أبدًا. created_by/updated_by أسماء مستخدمين
      -- نصٌّ (كالعادة في هذا المخطط) لا مفاتيح أجنبية: حذفُ مستخدم لا يمسّ
      -- تاريخ إعلانٍ شهده.
      CREATE TABLE IF NOT EXISTS display_announcements (
        id         SERIAL PRIMARY KEY,
        title      TEXT        NOT NULL,
        body       TEXT        NOT NULL,
        sort_order INTEGER     NOT NULL DEFAULT 0,
        is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
        created_by TEXT,
        updated_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS display_announcements_screen_idx
        ON display_announcements (is_active, sort_order, id);

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

      -- جدول مزودي الذكاء الاصطناعي الديناميكي (Dynamic AI Provider Registry)
      CREATE TABLE IF NOT EXISTS ai_providers (
        id                 TEXT PRIMARY KEY,
        name               TEXT NOT NULL,
        protocol_type      TEXT NOT NULL DEFAULT 'openai-compatible',
        base_url           TEXT NOT NULL,
        api_endpoint       TEXT,
        model              TEXT NOT NULL,
        models             TEXT[] DEFAULT '{}',
        api_key_enc        TEXT,
        organization_id    TEXT,
        custom_headers     JSONB DEFAULT '{}',
        timeout_ms         INTEGER DEFAULT 30000,
        max_tokens         INTEGER DEFAULT 2048,
        temperature        NUMERIC(3,2) DEFAULT 0.2,
        enabled            BOOLEAN NOT NULL DEFAULT TRUE,
        is_default         BOOLEAN NOT NULL DEFAULT FALSE,
        priority           INTEGER NOT NULL DEFAULT 10,
        task_models        JSONB DEFAULT '{}',
        last_test_at       TIMESTAMPTZ,
        last_test_ok       BOOLEAN,
        last_test_message  TEXT,
        last_test_latency  INTEGER,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by         TEXT
      );

      CREATE INDEX IF NOT EXISTS ai_providers_priority_idx
        ON ai_providers (enabled, priority, id);

      -- هجرة آمنة من ai_settings إلى ai_providers إن كان الجدول فارغاً
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
      -- تكلفة الوحدة بالوحدة الصغرى للعملة الأساسية لحظة الشراء (من مستودع الوكيل
      -- الآخر) — للإدخال المُشترى وحده؛ القيمة كلها مشتقّة بالمتوسّط المرجّح
      -- (lib/inventoryCost.ts). is_return: إدخالٌ هو ردُّ مصروفٍ سابق — لا يُحرّك
      -- المتوسط بل يعيد بالمتوسّط القائم.
      ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS unit_cost_minor BIGINT;
      ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS is_return BOOLEAN NOT NULL DEFAULT FALSE;
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
