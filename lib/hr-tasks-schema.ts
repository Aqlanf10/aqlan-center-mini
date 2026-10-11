/**
 * (HR-2) المهام — مصدرٌ واحد لمسارَي المخطط.
 *
 * النص نفسه يُنفَّذ في `ensureSchema()` وهو جسد الهجرة
 * `migrations/0046_hr_tasks.sql` حرفيًّا — واختبار الوحدة يُسقط البناء إن افترقا.
 *
 * المهمة الخاصة (is_private) ملكٌ لصاحبها وحده: القاعدة نفسها تمنع خاصّةً لها
 * مسؤول (CHECK) — الخصوصية قرارٌ بنيويّ لا تفصيلٌ في الواجهة. والتحويل إلى
 * مشتركة فعلٌ صريح يُسجَّل في السجل.
 *
 * المسؤول موظفٌ من ملفات الطاقم — بحسابٍ أو بلا حساب. كل تحديثٍ يمرّ بجلسة
 * مستخدمٍ حقيقية، و`hr_task_events` يسجّل الفاعل الفعلي (user_id) واسمه —
 * لا يُنسب التحديث أبدًا إلى موظفٍ بلا حساب.
 *
 * الربط بمريضٍ أو أمر مختبرٍ أو بند مخزون مرجعٌ يُفحص وصوله عند الإنشاء وعند
 * كل قراءة — إسناد المهمة لا يمنح وصولًا، وإكمالها لا يغيّر السجل المرتبط.
 *
 * planned_for تاريخ التخطيط المستقل عن due_at، وclient_request_id مفتاح معاملة
 * من العميل يمنع التكرار عند فقدان الرد — فريد جزئيًّا في المهام والتعليقات والقائمة.
 *
 * إضافيٌّ خالص: خمسة جداول جديدة — لا عمودٌ قديم يُمسّ ولا صفٌّ يُعاد كتابته.
 */
export const HR_TASKS_SQL = `CREATE TABLE IF NOT EXISTS hr_tasks (
  id                 SERIAL      PRIMARY KEY,
  title              TEXT        NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  description        TEXT        NOT NULL DEFAULT '' CHECK (length(description) <= 4000),
  is_private         BOOLEAN     NOT NULL DEFAULT FALSE,
  status             TEXT        NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned','in_progress','blocked','completed','cancelled')),
  priority           TEXT        NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low','normal','high','urgent')),
  due_at             TIMESTAMPTZ,
  planned_for        DATE,
  owner_user_id      INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_display_name TEXT        NOT NULL,
  assignee_staff_id  INTEGER     REFERENCES hr_staff(id) ON DELETE SET NULL,
  assignee_user_id   INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  assignee_label     TEXT        NOT NULL DEFAULT '' CHECK (length(btrim(assignee_label)) <= 120),
  completed_at       TIMESTAMPTZ,
  client_request_id  TEXT        CHECK (client_request_id IS NULL OR length(btrim(client_request_id)) BETWEEN 8 AND 100),
  created_by         TEXT        NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- الخاصة بلا مسؤول ولا إسناد: صاحبها وحده — والأثر يمنع تسرّبها بإسنادٍ خاطئ
  CONSTRAINT hr_tasks_no_assignee_on_private
    CHECK (is_private = FALSE OR (assignee_staff_id IS NULL AND assignee_user_id IS NULL AND btrim(assignee_label) = '')),
  CHECK (status <> 'completed' OR completed_at IS NOT NULL),
  CHECK (status = 'completed' OR completed_at IS NULL),
  CHECK (assignee_staff_id IS NULL OR btrim(assignee_label) <> '')
);
CREATE INDEX IF NOT EXISTS hr_tasks_owner_idx ON hr_tasks (owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS hr_tasks_assignee_user_idx ON hr_tasks (assignee_user_id, created_at DESC) WHERE assignee_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS hr_tasks_assignee_staff_idx ON hr_tasks (assignee_staff_id, created_at DESC) WHERE assignee_staff_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS hr_tasks_status_due_idx ON hr_tasks (status, due_at);
CREATE UNIQUE INDEX IF NOT EXISTS hr_tasks_request_dedupe_idx
  ON hr_tasks (client_request_id) WHERE client_request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS hr_task_links (
  id          SERIAL      PRIMARY KEY,
  task_id     INTEGER     NOT NULL REFERENCES hr_tasks(id) ON DELETE CASCADE,
  link_kind   TEXT        NOT NULL CHECK (link_kind IN ('patient','lab_order','inventory_item')),
  link_id     INTEGER     NOT NULL CHECK (link_id > 0),
  link_label  TEXT        NOT NULL DEFAULT '',
  linked_by   TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (task_id, link_kind, link_id)
);
CREATE INDEX IF NOT EXISTS hr_task_links_task_idx ON hr_task_links (task_id);

CREATE TABLE IF NOT EXISTS hr_task_checklist (
  id          SERIAL      PRIMARY KEY,
  task_id     INTEGER     NOT NULL REFERENCES hr_tasks(id) ON DELETE CASCADE,
  label       TEXT        NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 300),
  done        BOOLEAN     NOT NULL DEFAULT FALSE,
  done_by     TEXT,
  done_at     TIMESTAMPTZ,
  position    INTEGER     NOT NULL DEFAULT 0,
  client_request_id TEXT   CHECK (client_request_id IS NULL OR length(btrim(client_request_id)) BETWEEN 8 AND 100),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS hr_task_checklist_task_idx ON hr_task_checklist (task_id, position, id);
CREATE UNIQUE INDEX IF NOT EXISTS hr_task_checklist_request_dedupe_idx
  ON hr_task_checklist (task_id, client_request_id) WHERE client_request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS hr_task_comments (
  id                  SERIAL      PRIMARY KEY,
  task_id             INTEGER     NOT NULL REFERENCES hr_tasks(id) ON DELETE CASCADE,
  author_user_id      INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_display_name TEXT        NOT NULL,
  body                TEXT        NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 2000),
  client_request_id   TEXT        CHECK (client_request_id IS NULL OR length(btrim(client_request_id)) BETWEEN 8 AND 100),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS hr_task_comments_task_idx ON hr_task_comments (task_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS hr_task_comments_request_dedupe_idx
  ON hr_task_comments (task_id, client_request_id) WHERE client_request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS hr_task_events (
  id                  SERIAL      PRIMARY KEY,
  task_id             INTEGER     NOT NULL REFERENCES hr_tasks(id) ON DELETE CASCADE,
  actor_user_id       INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_display_name  TEXT        NOT NULL,
  action              TEXT        NOT NULL
    CHECK (action IN ('create','update','status','assign','comment','checklist','visibility','link','unlink')),
  field               TEXT,
  old_value           TEXT,
  new_value           TEXT,
  link_id             INTEGER,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS hr_task_events_task_idx ON hr_task_events (task_id, id);

-- سجل تغييرات المهمة شاهدٌ لا يُمحى ولا يُبدَّل من التطبيق.
CREATE OR REPLACE FUNCTION aqlan_hr_task_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'hr_task_events is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS hr_task_events_append_only ON hr_task_events;
CREATE TRIGGER hr_task_events_append_only
  BEFORE UPDATE OR DELETE ON hr_task_events
  FOR EACH ROW EXECUTE FUNCTION aqlan_hr_task_events_append_only();`;
