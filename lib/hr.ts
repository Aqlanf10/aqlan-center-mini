/**
 * (HR-1/HR-2) الموارد البشرية والمهام — **طبقة القاعدة والخادم**.
 *
 * كل دالة هنا تلمس PostgreSQL (مباشرةً أو عبر معاملة) فلا يجوز استيرادها من
 * مكوّن عميل: الاستيراد العرضي يجرّ `pg` إلى حزمة المتصفح ويُسقط البناء.
 * العقد الخالص المشترك (أنواع، مفردات، صلاحيات، خصوصية، تحقق، عرض) في
 * `lib/hr-shared.ts`، وهذا الملف يُعيد تصديره للخادم ويضيف دوال القراءة
 * والكتابة والتدقيق.
 *
 * قاعدة الجمعود الاتصالي المكتسبة: سطر التدقيق العام (recordAudit) يحتاج اتصالًا
 * من الـpool نفسه — فلا يُكتب **داخل** معاملةٍ تحتفظ بقفل صفٍّ تنتظر عليه
 * معاملات أخرى. كل فعلٍ كتابي يجمع بيانات التدقيق داخل المعاملة ويطلقها
 * بعد الالتزام (انظر updateStaff).
 */

import { getPool, recordAudit, type DbClient, type DbPool } from "./db";
import { withTransaction } from "./transactions";
import { canAccessPatient } from "./patient-access";
import type { SessionPayload } from "./auth";
import type { AuditAction } from "./audit";
import {
  canAssignTasks, canManageTask, canSeeTask, canUseTasks, canWorkOnTask,
  TASK_LINK_KIND_LABEL, TASK_LINK_KINDS, TASK_PRIORITY_LABEL, TASK_STATUS_LABEL,
  taskToView, staffToView,
  type HrContractKind, type HrStaffRow, type HrStaffView, type HrTaskRow,
  type HrTaskView, type HrDepartment, type HrWorkStatus, type TaskLinkKind,
  type TaskPriority, type TaskStatus, type PayTermsInput, type StaffUpdateResult,
} from "./hr-shared";

/** أي منفّذ استعلام (pool أو client معاملة) — للدوال التي تعمل في السياقين. */
type QueryRunner = DbClient | DbPool;

export * from "./hr-shared";

/* ── سجل أحداث المهمة — الفاعل الفعلي لا الموظف المُسند إليه ─────────────── */

export interface TaskEventInput {
  taskId: number;
  actorUserId: number;
  actorDisplayName: string;
  action: "create" | "update" | "status" | "assign" | "comment" | "checklist" | "visibility" | "link" | "unlink";
  field?: string | null;
  oldValue?: string | null;
  newValue?: string | null;
  /** معرّف الرابط لأحداث link/unlink — به تُطبّق صلاحية السجل عند كل قراءة. */
  linkId?: number | null;
}

/** سجل تغييرات المهمة append-only على مستوى القاعدة — الفاعل هو صاحب الجلسة فعلًا. */
export async function recordTaskEvent(client: DbClient, input: TaskEventInput): Promise<void> {
  await client.query(
    `INSERT INTO hr_task_events (task_id, actor_user_id, actor_display_name, action, field, old_value, new_value, link_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [input.taskId, input.actorUserId, input.actorDisplayName, input.action,
     input.field ?? null, input.oldValue ?? null, input.newValue ?? null, input.linkId ?? null],
  );
}

/** تدقيق عام بياناتٌ وصفية فقط: عنوان المهمة الخاصة لا يُكتب في audit_log أبدًا. */
export async function auditTask(
  action: AuditAction,
  session: SessionPayload,
  taskId: number,
  summary: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  await recordAudit({
    action,
    entity: "hr_task",
    entityId: String(taskId),
    entityLabel: summary,
    details: extra ?? null,
    actor: session.username,
    actorRole: session.role,
  });
}

/* ── ملفات الطاقم — القراءة ──────────────────────────────────────────────── */

function staffRowMapper(row: Record<string, unknown>): HrStaffRow {
  return row as unknown as HrStaffRow;
}

export async function listStaff(options: {
  department?: HrDepartment | null;
  status?: HrWorkStatus | null;
  search?: string | null;
  includePayTerms: boolean;
}): Promise<HrStaffView[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (options.department) {
    params.push(options.department);
    conditions.push(`department = $${params.length}`);
  }
  if (options.status) {
    params.push(options.status);
    conditions.push(`work_status = $${params.length}`);
  }
  if (options.search && options.search.trim()) {
    params.push(`%${options.search.trim()}%`);
    conditions.push(`(full_name ILIKE $${params.length} OR job_title ILIKE $${params.length})`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await getPool().query(
    `SELECT * FROM hr_staff ${where} ORDER BY full_name`,
    params,
  );
  return result.rows.map((row) => staffToView(staffRowMapper(row), options.includePayTerms));
}

/**
 * دليل الإسناد الآمن: اسمٌ ومسمًّى وقسمٌ وحالة عمل وحسب — لا مبالغ ولا عملات
 * ولا معرّفات مستخدمين: الرواتب لا تظهر بقائمة اختيار الموظفين مهما كان السائل.
 */
export async function listStaffDirectory(): Promise<
  { id: number; fullName: string; jobTitle: string; department: HrDepartment; hasAccount: boolean }[]
> {
  const result = await getPool().query(
    `SELECT id, full_name, job_title, department, (user_id IS NOT NULL) AS has_account
     FROM hr_staff WHERE work_status = 'active' ORDER BY full_name`,
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    fullName: String(row.full_name),
    jobTitle: String(row.job_title ?? ""),
    department: String(row.department) as HrDepartment,
    hasAccount: Boolean(row.has_account),
  }));
}

export interface HrStaffChangeView {
  id: number;
  actor: string;
  actorRole: string | null;
  action: string;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  reason: string | null;
  createdAt: string;
}

export async function getStaffDetail(id: number): Promise<{
  staff: HrStaffView;
  changes: HrStaffChangeView[];
  linkedUser: { id: number; username: string; displayName: string; role: string; isActive: boolean } | null;
} | null> {
  const result = await getPool().query(`SELECT * FROM hr_staff WHERE id = $1`, [id]);
  if (result.rowCount === 0) return null;
  const changes = await getPool().query(
    `SELECT id, actor, actor_role, action, field, old_value, new_value, reason, created_at
     FROM hr_staff_changes WHERE staff_id = $1 ORDER BY id DESC LIMIT 100`, [id],
  );
  let linkedUser: { id: number; username: string; displayName: string; role: string; isActive: boolean } | null = null;
  const staff = staffRowMapper(result.rows[0]);
  if (staff.user_id !== null) {
    const user = await getPool().query(
      `SELECT id, username, display_name, role, is_active FROM users WHERE id = $1`, [staff.user_id],
    );
    if (user.rowCount && user.rowCount > 0) {
      linkedUser = {
        id: Number(user.rows[0].id),
        username: String(user.rows[0].username),
        displayName: String(user.rows[0].display_name),
        role: String(user.rows[0].role),
        isActive: Boolean(user.rows[0].is_active),
      };
    }
  }
  return {
    staff: staffToView(staff, true),
    changes: changes.rows.map((row) => ({
      id: Number(row.id),
      actor: String(row.actor),
      actorRole: row.actor_role ? String(row.actor_role) : null,
      action: String(row.action),
      field: row.field ? String(row.field) : null,
      oldValue: row.old_value ? String(row.old_value) : null,
      newValue: row.new_value ? String(row.new_value) : null,
      reason: row.reason ? String(row.reason) : null,
      createdAt: new Date(row.created_at).toISOString(),
    })),
    linkedUser,
  };
}

/* ── ملفات الطاقم — الكتابة (كل فعلٍ يسجَّل مرتين: سجل الملف + التدقيق العام) ── */

export interface CreateStaffInput {
  fullName: string;
  jobTitle: string;
  department: HrDepartment;
  hireDate: string | null;
  /** الحالة التي اختارها المستخدم فعلًا — لا «نشط» مفروضة من الخادم. */
  workStatus: HrWorkStatus;
  endDate: string | null;
  contractKind: HrContractKind;
  payTerms: PayTermsInput | null;
  phone: string | null;
  note: string | null;
}

export async function createStaff(input: CreateStaffInput, session: SessionPayload): Promise<HrStaffView> {
  const result = await withTransaction(getPool(), async (client) => {
    const inserted = await client.query(
      `INSERT INTO hr_staff
         (full_name, job_title, department, work_status, hire_date, end_date, contract_kind,
          salary_amount_minor, salary_currency, salary_period, salary_effective_on, phone, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [input.fullName, input.jobTitle, input.department, input.workStatus, input.hireDate, input.endDate,
       input.contractKind, input.payTerms?.amountMinor ?? null, input.payTerms?.currency ?? null,
       input.payTerms?.period ?? null, input.payTerms?.effectiveOn ?? null,
       input.phone, input.note, session.username],
    );
    const row = staffRowMapper(inserted.rows[0]);
    await client.query(
      `INSERT INTO hr_staff_changes (staff_id, actor, actor_role, action, field, new_value)
       VALUES ($1, $2, $3, 'create', NULL, $4)`,
      [row.id, session.username, session.role, input.fullName],
    );
    return row;
  });
  await recordAudit({
    action: "hr.staff.create",
    entity: "hr_staff",
    entityId: String(result.id),
    entityLabel: `إنشاء ملف الموظف «${input.fullName}»`,
    details: { department: input.department, contractKind: input.contractKind, workStatus: input.workStatus },
    actor: session.username,
    actorRole: session.role,
  });
  return staffToView(result, true);
}


export interface UpdateStaffPatch {
  fullName?: string;
  jobTitle?: string;
  department?: HrDepartment;
  workStatus?: HrWorkStatus;
  hireDate?: string | null;
  endDate?: string | null;
  contractKind?: HrContractKind;
  payTerms?: PayTermsInput | null;
  phone?: string | null;
  note?: string | null;
  reason?: string;
  /** طابع تحديثٍ يتوقعه العميل — اختلافه يعني نسخة أحدث: 409 لا كتابة فوقها. */
  expectedUpdatedAt?: string;
}

/**
 * تعديل ملف موظف: كل حقلٍ تغيّر يترك سطرًا في سجل الملف (القيمة القديمة والجديدة)،
 * وشروط الأجر تُسجَّل سطرًا واحدًا مجمّعًا مع تاريخ السريان — من عدّل وعلى ماذا
 * ولماذا، بلا استثناء.
 *
 * نوع التعاقد وشروطه يُحسمان معًا في التحديث نفسه: «نسبة» تمسح شروط الراتب
 * كلها، وراتب/راتب ونسبة يتطلبها مكتملة، وexpectedUpdatedAt يحمي من الكتابة
 * فوق نسخة أحدث (409).
 */

export async function updateStaff(id: number, patch: UpdateStaffPatch, session: SessionPayload): Promise<StaffUpdateResult> {
  /* التدقيق يُكتب **بعد** التزام المعاملة لا داخلها: سطر التدقيق يحتاج اتصالاً من
     الـpool نفسه، وكتابته داخل معاملةٍ تحتفظ بقفل صفٍّ تنتظر عليه معاملاتٌ أخرى
     يفتح جمودًا اتصاليًّا (كل اتصالٍ ينتظر قفلًا يحمله اتصالٌ ينتظر اتصالًا).
     القاعدة: المعاملة تُعيد ما سيُدقَّق، والتدقيق يُطلق بعد الالتزام — فلا يُكتب
     أبدًا لعمليةٍ فشلت، ولا يمسك اتصالًا وهو ينتظر. */
  const outcome = await withTransaction(getPool(), async (client): Promise<
    { missing: true }
    | StaffUpdateResult
    | { outcome: "none" | "updated"; row: HrStaffRow; changes: { field: string; oldValue: string; newValue: string }[] }
  > => {
    const current = await client.query(`SELECT * FROM hr_staff WHERE id = $1 FOR UPDATE`, [id]);
    if (current.rowCount === 0) return { missing: true as const };
    const row = staffRowMapper(current.rows[0]);

    if (patch.expectedUpdatedAt !== undefined) {
      const expected = new Date(patch.expectedUpdatedAt).getTime();
      if (!Number.isFinite(expected) || expected !== new Date(row.updated_at).getTime()) {
        return { ok: false as const, error: "غُيِّر ملف الموظف من جلسة أخرى بعد فتحك له — أعد التحميل ثم أعد المحاولة.", status: 409 };
      }
    }

    const changes: { field: string; oldValue: string; newValue: string }[] = [];
    const sets: string[] = [];
    const params: unknown[] = [];

    const pushChange = (field: string, oldValue: unknown, newValue: unknown) => {
      changes.push({ field, oldValue: oldValue === null || oldValue === undefined ? "" : String(oldValue), newValue: newValue === null || newValue === undefined ? "" : String(newValue) });
    };

    if (patch.fullName !== undefined && patch.fullName !== row.full_name) {
      params.push(patch.fullName);
      sets.push(`full_name = $${params.length}`);
      pushChange("full_name", row.full_name, patch.fullName);
    }
    if (patch.jobTitle !== undefined && patch.jobTitle !== row.job_title) {
      params.push(patch.jobTitle);
      sets.push(`job_title = $${params.length}`);
      pushChange("job_title", row.job_title, patch.jobTitle);
    }
    if (patch.department !== undefined && patch.department !== row.department) {
      params.push(patch.department);
      sets.push(`department = $${params.length}`);
      pushChange("department", row.department, patch.department);
    }
    if (patch.workStatus !== undefined && patch.workStatus !== row.work_status) {
      params.push(patch.workStatus);
      sets.push(`work_status = $${params.length}`);
      pushChange("work_status", row.work_status, patch.workStatus);
      // انتهاء الخدمة بتاريخ انتهاء: من غياب النظام فرُدّ إليه — ويُسجَّل كأي تعديل.
      // «اليوم» من القاعدة بتوقيت المركز (CURRENT_DATE) لا من ساعة الخادم UTC.
      if (patch.workStatus === "ended" && patch.endDate === undefined && row.end_date === null) {
        const todayRows = await client.query<{ d: string }>(`SELECT CURRENT_DATE::text AS d`);
        const today = todayRows.rows[0]?.d;
        if (today) {
          params.push(today);
          sets.push(`end_date = $${params.length}`);
          pushChange("end_date", row.end_date, today);
        }
      }
    }
    if (patch.hireDate !== undefined && patch.hireDate !== row.hire_date) {
      params.push(patch.hireDate);
      sets.push(`hire_date = $${params.length}`);
      pushChange("hire_date", row.hire_date, patch.hireDate);
    }
    if (patch.endDate !== undefined && patch.endDate !== row.end_date) {
      params.push(patch.endDate);
      sets.push(`end_date = $${params.length}`);
      pushChange("end_date", row.end_date, patch.endDate);
    }
    if (patch.contractKind !== undefined && patch.contractKind !== row.contract_kind) {
      params.push(patch.contractKind);
      sets.push(`contract_kind = $${params.length}`);
      pushChange("contract_kind", row.contract_kind, patch.contractKind);
    }
    if (patch.phone !== undefined && patch.phone !== row.phone) {
      params.push(patch.phone);
      sets.push(`phone = $${params.length}`);
      pushChange("phone", row.phone, patch.phone);
    }
    if (patch.note !== undefined && patch.note !== row.note) {
      params.push(patch.note);
      sets.push(`note = $${params.length}`);
      pushChange("note", row.note, patch.note);
    }

    // شروط الأجر: مجموعة واحدة — مبلغ وعملة ودورية وتاريخ سريان معًا،
    // محسومة مع نوع التعاقد النهائي (بعد أي تغييرٍ له في هذا الطلب):
    // «نسبة» تمسح الأربعة كلها، وراتب/راتب ونسبة يتطلب الأربعة مكتملة.
    const nextKind = patch.contractKind ?? row.contract_kind;
    const userPayTerms = patch.payTerms;
    let nextPayTerms: PayTermsInput | null | undefined = userPayTerms;
    if (nextKind === "commission") {
      // لا راتب تحت نسبة — قيد القاعدة يرفضه، فالمسح هنا جزء من نفس التحديث.
      nextPayTerms = null;
    } else if (userPayTerms === null) {
      // إلغاء راتبٍ صريح تحت نوعٍ براتب: رفضٌ بسببٍ واضح — الإلغاء بتحويل النوع إلى نسبة.
      return { ok: false as const, error: "لا يُلغى الراتب مع بقاء نوع التعاقد براتبًا — حوّل النوع إلى «نسبة» ليُمسح الراتب.", status: 400 };
    } else if (nextPayTerms === undefined) {
      const hasExisting = row.salary_amount_minor !== null && row.salary_currency !== null
        && row.salary_period !== null && row.salary_effective_on !== null;
      if (!hasExisting) {
        return { ok: false as const, error: "نوع التعاقد براتبٍ يتطلب المبلغ والعملة والدورية وتاريخ السريان معًا.", status: 400 };
      }
    }
    const payChanged = nextPayTerms !== undefined && (
      nextPayTerms === null
        ? row.salary_amount_minor !== null || row.salary_currency !== null || row.salary_period !== null || row.salary_effective_on !== null
        : nextPayTerms.amountMinor !== Number(row.salary_amount_minor)
          || nextPayTerms.currency !== row.salary_currency
          || nextPayTerms.period !== row.salary_period
          || nextPayTerms.effectiveOn !== row.salary_effective_on
    );
    if (payChanged && nextPayTerms !== undefined) {
      if (nextPayTerms === null) {
        sets.push(`salary_amount_minor = NULL, salary_currency = NULL, salary_period = NULL, salary_effective_on = NULL`);
        pushChange("pay_terms", `${row.salary_amount_minor ?? ""} ${row.salary_currency ?? ""} ${row.salary_period ?? ""} ${row.salary_effective_on ?? ""}`.trim(), "");
      } else {
        const pay = nextPayTerms;
        params.push(pay.amountMinor, pay.currency, pay.period, pay.effectiveOn);
        sets.push(`salary_amount_minor = $${params.length - 3}, salary_currency = $${params.length - 2}, salary_period = $${params.length - 1}, salary_effective_on = $${params.length}`);
        pushChange("pay_terms", `${row.salary_amount_minor ?? ""} ${row.salary_currency ?? ""} ${row.salary_period ?? ""} ${row.salary_effective_on ?? ""}`.trim(),
          `${pay.amountMinor} ${pay.currency} ${pay.period} ${pay.effectiveOn}`);
      }
    }

    if (sets.length === 0) return { outcome: "none" as const, row, changes: [] };

    params.push(id);
    sets.push(`updated_at = NOW()`);
    const updated = await client.query(
      `UPDATE hr_staff SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`,
      params,
    );
    const updatedRow = staffRowMapper(updated.rows[0]);
    for (const change of changes) {
      await client.query(
        `INSERT INTO hr_staff_changes (staff_id, actor, actor_role, action, field, old_value, new_value, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, session.username, session.role,
         change.field === "pay_terms" ? "pay_terms" : "update",
         change.field, change.oldValue, change.newValue, patch.reason?.trim() || null],
      );
    }
    return { outcome: "updated" as const, row: updatedRow, changes };
  });
  if ("missing" in outcome) return { ok: false, error: "ملف الموظف غير موجود.", status: 404 };
  if ("ok" in outcome) return outcome; // رفض 409/400 بسببٍ واضح
  if (outcome.outcome === "updated") {
    await recordAudit({
      action: "hr.staff.update",
      entity: "hr_staff",
      entityId: String(id),
      entityLabel: `تعديل ملف الموظف «${outcome.row.full_name}» (${outcome.changes.map((c) => c.field).join("، ")})`,
      details: { fields: outcome.changes.map((c) => c.field), reason: patch.reason?.trim() || null },
      actor: session.username,
      actorRole: session.role,
    });
  }
  return { ok: true, staff: staffToView(outcome.row, true), changed: outcome.outcome === "updated" };
}

/**
 * ربط الملف بحسابٍ موجود أو فكّه — اختياريٌّ وفريد ويدوي: لا إنشاء حسابٍ من هنا،
 * ولا ربطٌ بتشابه الأسماء. الحساب المعطّل يُربط علمًا لكن الجلسات تُحكم بحالتها.
 */
export async function setStaffUserLink(id: number, userId: number | null, reason: string, session: SessionPayload): Promise<
  { ok: true; staff: HrStaffView } | { ok: false; error: string; status: number }
> {
  const outcome = await withTransaction(getPool(), async (client) => {
    const current = await client.query(`SELECT * FROM hr_staff WHERE id = $1 FOR UPDATE`, [id]);
    if (current.rowCount === 0) return { ok: false as const, error: "ملف الموظف غير موجود.", status: 404 };
    const row = staffRowMapper(current.rows[0]);

    if (userId === null) {
      if (row.user_id === null) return { ok: false as const, error: "الملف غير مرتبط بحسابٍ أصلًا.", status: 400 };
      await client.query(
        `UPDATE hr_staff SET user_id = NULL, user_linked_at = NULL, updated_at = NOW() WHERE id = $1`, [id],
      );
      await client.query(
        `INSERT INTO hr_staff_changes (staff_id, actor, actor_role, action, field, old_value, new_value, reason)
         VALUES ($1, $2, $3, 'unlink_user', 'user_id', $4, NULL, $5)`,
        [id, session.username, session.role, String(row.user_id), reason],
      );
      return { ok: true as const, kind: "unlink" as const, fullName: row.full_name, previousUserId: row.user_id } as const;
    }

    const user = await client.query(`SELECT id, username, display_name, is_active FROM users WHERE id = $1`, [userId]);
    if (user.rowCount === 0) return { ok: false as const, error: "حساب الدخول غير موجود — أنشئه من شاشة المستخدمين أولًا.", status: 404 };
    if (!user.rows[0].is_active) return { ok: false as const, error: "حساب الدخول معطّل — لا يمكن ربطه.", status: 400 };
    // الفريدية بنيوية (UNIQUE) لكن الرسالة العربية هنا أوضح من خطأ القاعدة.
    const taken = await client.query(`SELECT id, full_name FROM hr_staff WHERE user_id = $1 AND id <> $2`, [userId, id]);
    if (taken.rowCount && taken.rowCount > 0) {
      return { ok: false as const, error: `الحساب مرتبط مسبقًا بملف «${String(taken.rows[0].full_name)}» — الربط واحدٌ لكل حساب.`, status: 409 };
    }
    await client.query(
      `UPDATE hr_staff SET user_id = $1, user_linked_at = NOW(), updated_at = NOW() WHERE id = $2`, [userId, id],
    );
    await client.query(
      `INSERT INTO hr_staff_changes (staff_id, actor, actor_role, action, field, old_value, new_value, reason)
       VALUES ($1, $2, $3, 'link_user', 'user_id', $4, $5, $6)`,
      [id, session.username, session.role, row.user_id === null ? null : String(row.user_id), String(userId), reason],
    );
    return { ok: true as const, kind: "link" as const, fullName: row.full_name, userId, username: String(user.rows[0].username) } as const;
  });
  if (!outcome.ok) return outcome;
  // التدقيق بعد الالتزام — لا اتصالٌ يُمسك أثناء انتظار الأقفال.
  const refreshedRow = staffRowMapper((await getPool().query(`SELECT * FROM hr_staff WHERE id = $1`, [id])).rows[0]);
  if (outcome.kind === "unlink") {
    await recordAudit({
      action: "hr.staff.unlink_user",
      entity: "hr_staff",
      entityId: String(id),
      entityLabel: `فكّ ربط حساب الدخول عن ملف الموظف «${outcome.fullName}»`,
      details: { previousUserId: outcome.previousUserId, reason },
      actor: session.username,
      actorRole: session.role,
    });
  } else {
    await recordAudit({
      action: "hr.staff.link_user",
      entity: "hr_staff",
      entityId: String(id),
      entityLabel: `ربط ملف الموظف «${outcome.fullName}» بحساب الدخول «${outcome.username}»`,
      details: { userId, reason },
      actor: session.username,
      actorRole: session.role,
    });
  }
  return { ok: true, staff: staffToView(refreshedRow, true) };
}


/* ── المهام — القراءة بخصوصية على مستوى الصف ─────────────────────────────── */

function taskRowMapper(row: Record<string, unknown>): HrTaskRow {
  return row as unknown as HrTaskRow;
}

/** ملف الطاقم المرتبط بجلسة المستخدم — إن وُجد: به تُحسب المهام المسندة لملفه. */
export async function staffIdForUser(userId: number, client?: QueryRunner): Promise<number | null> {
  const runner = client ?? getPool();
  const result = await runner.query(`SELECT id FROM hr_staff WHERE user_id = $1`, [userId]);
  return result.rowCount && result.rowCount > 0 ? Number(result.rows[0].id) : null;
}

export interface TaskListFilters {
  status?: TaskStatus | null;
  priority?: TaskPriority | null;
  search?: string | null;
  overdueOnly?: boolean;
  assigneeStaffId?: number | null;
  scope?: "mine" | "team";
}

export interface TaskListResult {
  tasks: HrTaskView[];
  counts: Record<TaskStatus, number>;
  overdueCount: number;
}

/**
 * قائمة المهام كما يراها سائلها: الخاصة لصاحبها وحدها حتى في العدّاد، والمشتركة
 * للإدارة المخولة كلها ولصاحبها وللمسؤول. الشرط يُبنى في WHERE على الخادم —
 * أي معرّفٍ يُمرَّر من العميل لا يوسّع الرؤية أبدًا.
 */
export async function listTasks(session: SessionPayload, filters: TaskListFilters): Promise<TaskListResult> {
  const viewerStaffId = await staffIdForUser(session.userId);
  const oversight = canAssignTasks(session.role);
  const params: unknown[] = [session.userId];

  // بناء شرط الرؤية — مكان واحد يحكم القائمة والعدادات والبحث معًا.
  // مسؤولية المكلّف عبر الربط الحالي (hr_staff.user_id ← معرّف الملف) حصرًا:
  // assignee_user_id المخزَّن لقطة تاريخية لا تُفتح بها رؤية — فكّ الربط
  // يسحب الوصول فورًا من القائمة والعدادات والبحث معًا.
  const visibility: string[] = [`(t.is_private AND t.owner_user_id = $1)`];
  if (oversight) {
    visibility.push(`(NOT t.is_private)`);
  } else {
    visibility.push(`(NOT t.is_private AND t.owner_user_id = $1)`);
  }
  if (viewerStaffId !== null) {
    params.push(viewerStaffId);
    visibility.push(`(NOT t.is_private AND t.assignee_staff_id = $${params.length})`);
  }
  let mineOnly: string | null = null;
  if (filters.scope === "mine") {
    const mine = [`t.owner_user_id = $1`];
    if (viewerStaffId !== null) mine.push(`t.assignee_staff_id = $${params.length}`);
    mineOnly = `(${mine.join(" OR ")})`;
  }

  const conditions: string[] = [`(${visibility.join(" OR ")})`];
  if (mineOnly) conditions.push(mineOnly);
  if (filters.status) {
    params.push(filters.status);
    conditions.push(`t.status = $${params.length}`);
  }
  if (filters.priority) {
    params.push(filters.priority);
    conditions.push(`t.priority = $${params.length}`);
  }
  if (filters.assigneeStaffId) {
    params.push(filters.assigneeStaffId);
    conditions.push(`t.assignee_staff_id = $${params.length}`);
  }
  if (filters.overdueOnly) {
    conditions.push(`t.due_at IS NOT NULL AND t.due_at < NOW() AND t.status IN ('planned','in_progress','blocked')`);
  }
  if (filters.search && filters.search.trim()) {
    params.push(`%${filters.search.trim()}%`);
    conditions.push(`(t.title ILIKE $${params.length} OR t.description ILIKE $${params.length})`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const rows = await getPool().query(
    `SELECT t.* FROM hr_tasks t ${where} ORDER BY t.updated_at DESC LIMIT 300`,
    params,
  );
  // العدادات بنفس شرط الرؤية نفسه: ما لا يظهر في القائمة لا يُحصى.
  const countResult = await getPool().query(
    `SELECT t.status, COUNT(*)::int AS n,
       COUNT(*) FILTER (WHERE t.due_at IS NOT NULL AND t.due_at < NOW()
         AND t.status IN ('planned','in_progress','blocked'))::int AS overdue
     FROM hr_tasks t ${where} GROUP BY t.status`,
    params,
  );
  const counts: Record<TaskStatus, number> = { planned: 0, in_progress: 0, blocked: 0, completed: 0, cancelled: 0 };
  let overdueCount = 0;
  for (const row of countResult.rows) {
    const status = String(row.status) as TaskStatus;
    if (status in counts) counts[status] = Number(row.n);
    overdueCount += Number(row.overdue);
  }
  const nowMs = Date.now();
  return {
    tasks: rows.rows.map((row) => taskToView(taskRowMapper(row), nowMs)),
    counts,
    overdueCount,
  };
}

/**
 * قراءة مهمةٍ بمعرّفها: غير المرئي يُجاب بـ404 لا 403 — لا إفشاء بوجود ملفٍ
 * خاص عبر الفرق بين الرفضين. الروابط تُصفّى بصلاحية القارئ نفسها.
 */
export async function getTaskForSession(
  session: SessionPayload,
  taskId: number,
  client?: QueryRunner,
): Promise<{
  task: HrTaskView;
  checklist: { id: number; label: string; done: boolean; doneBy: string | null; doneAt: string | null }[];
  comments: { id: number; authorUserId: number; authorDisplayName: string; body: string; createdAt: string }[];
  events: { id: number; actorUserId: number; actorDisplayName: string; action: string; field: string | null; oldValue: string | null; newValue: string | null; createdAt: string }[];
  links: { id: number; kind: TaskLinkKind; linkId: number; label: string; readable: boolean }[];
  permissions: { canManage: boolean; canWork: boolean };
} | null> {
  const runner = client ?? getPool();
  const result = await runner.query(`SELECT * FROM hr_tasks WHERE id = $1`, [taskId]);
  if (!result.rowCount || result.rowCount === 0) return null;
  const row = taskRowMapper(result.rows[0]);
  const viewerStaffId = await staffIdForUser(session.userId, runner);
  if (!canSeeTask(row, session, viewerStaffId)) return null;

  const checklistResult = await runner.query(
    `SELECT id, label, done, done_by, done_at FROM hr_task_checklist WHERE task_id = $1 ORDER BY position, id`, [taskId],
  );
  const commentsResult = await runner.query(
    `SELECT id, author_user_id, author_display_name, body, created_at FROM hr_task_comments WHERE task_id = $1 ORDER BY id`, [taskId],
  );
  const eventsResult = await runner.query(
    `SELECT id, actor_user_id, actor_display_name, action, field, old_value, new_value, link_id, created_at
     FROM hr_task_events WHERE task_id = $1 ORDER BY id DESC LIMIT 200`, [taskId],
  );
  const linksResult = await runner.query(
    `SELECT id, link_kind, link_id, link_label FROM hr_task_links WHERE task_id = $1 ORDER BY id`, [taskId],
  );
  const links: { id: number; kind: TaskLinkKind; linkId: number; label: string; readable: boolean }[] = [];
  for (const link of linksResult.rows) {
    const kind = String(link.link_kind) as TaskLinkKind;
    const linkId = Number(link.link_id);
    const readable = await linkReadableForSession(session, kind, linkId, runner);
    links.push({ id: Number(link.id), kind, linkId, label: readable ? String(link.link_label) : "", readable });
  }

  return {
    task: taskToView(row),
    checklist: checklistResult.rows.map((item) => ({
      id: Number(item.id),
      label: String(item.label),
      done: Boolean(item.done),
      doneBy: item.done_by ? String(item.done_by) : null,
      doneAt: item.done_at ? new Date(item.done_at).toISOString() : null,
    })),
    comments: commentsResult.rows.map((comment) => ({
      id: Number(comment.id),
      authorUserId: Number(comment.author_user_id),
      authorDisplayName: String(comment.author_display_name),
      body: String(comment.body),
      createdAt: new Date(comment.created_at).toISOString(),
    })),
    events: await Promise.all(eventsResult.rows.map(async (event) => {
      const action = String(event.action);
      const field = event.field ? String(event.field) : null;
      let oldValue = event.old_value ? String(event.old_value) : null;
      let newValue = event.new_value ? String(event.new_value) : null;
      // أحداث الربط تحمل في قيمها وسم السجل المرتبط (رقم المريض واسمه…) —
      // تُطبَّق صلاحية السجل نفسها هنا: بمعرّف رابطٍ يُفحص وصوله لحظة القراءة
      // (سحب صلاحية المريض يسري على البيانات القديمة المعروضة)، وبلا معرّفٍ
      // (صفوف سابقة على عمود link_id) تُسنَت القيم فشلَ الإغلاق.
      if ((action === "link" || action === "unlink") && field !== null) {
        const kind = field as TaskLinkKind;
        const linkId = event.link_id === null || event.link_id === undefined ? null : Number(event.link_id);
        const readable = linkId !== null
          && (TASK_LINK_KINDS as readonly string[]).includes(kind)
          && await linkReadableForSession(session, kind, linkId, runner);
        if (!readable) {
          oldValue = null;
          newValue = null;
        }
      }
      return {
        id: Number(event.id),
        actorUserId: Number(event.actor_user_id),
        actorDisplayName: String(event.actor_display_name),
        action,
        field,
        oldValue,
        newValue,
        createdAt: new Date(event.created_at).toISOString(),
      };
    })),
    links,
    permissions: {
      canManage: canManageTask(row, session),
      canWork: canWorkOnTask(row, session, viewerStaffId),
    },
  };
}

/** وصول القارئ إلى السجل المرتبط — نفس صلاحيات سجلّه الأصلي لا أكثر. */
export async function linkReadableForSession(
  session: SessionPayload,
  kind: TaskLinkKind,
  linkId: number,
  client?: QueryRunner,
): Promise<boolean> {
  const runner = client ?? getPool();
  if (kind === "patient") {
    return canAccessPatient(session, linkId, undefined, client as DbClient | undefined);
  }
  if (kind === "lab_order") {
    const exists = await runner.query(`SELECT 1 FROM lab_orders WHERE id = $1`, [linkId]);
    return Boolean(exists.rowCount);
  }
  const exists = await runner.query(`SELECT 1 FROM inventory_items WHERE id = $1`, [linkId]);
  return Boolean(exists.rowCount);
}

/** وسم السجل المرتبط كما يظهر في المهمة — قراءةٌ خفيفة بعد التحقق من الوصول. */
export async function describeLinkTarget(
  session: SessionPayload,
  kind: TaskLinkKind,
  linkId: number,
  client?: QueryRunner,
): Promise<string | null> {
  const runner = client ?? getPool();
  if (kind === "patient") {
    const result = await runner.query(`SELECT patient_number, full_name FROM patients WHERE id = $1`, [linkId]);
    if (!result.rowCount) return null;
    return `${result.rows[0].patient_number} — ${result.rows[0].full_name}`;
  }
  if (kind === "lab_order") {
    const result = await runner.query(
      `SELECT l.work_type, p.full_name AS patient FROM lab_orders l JOIN patients p ON p.id = l.patient_id WHERE l.id = $1`,
      [linkId],
    );
    if (!result.rowCount) return null;
    return `${result.rows[0].work_type} — ${result.rows[0].patient}`;
  }
  const result = await runner.query(`SELECT name FROM inventory_items WHERE id = $1`, [linkId]);
  if (!result.rowCount) return null;
  return String(result.rows[0].name);
}

/* ── المهام — الكتابة ────────────────────────────────────────────────────── */

export interface CreateTaskInput {
  title: string;
  description: string;
  isPrivate: boolean;
  priority: TaskPriority;
  dueAt: string | null;
  /** تاريخ التخطيط المستقل عن الاستحقاق — حالة «مخطّطة» وحدها لا تعوّضه. */
  plannedFor: string | null;
  assigneeStaffId: number | null;
  /** مفتاح معاملة من العميل لمنع تكرار الإنشاء عند فقدان الرد. */
  clientRequestId?: string | null;
}

export type TaskMutationResult<T> = { ok: true; value: T } | { ok: false; error: string; status: number };

/**
 * إنشاء مهمة: الخاصة تُملك لصاحبها ولا تقبل مسؤولًا (القاعدة نفسها تمنعه)،
 * والمسندة تُحسم إلى موظفٍ من ملفات الطاقم — بحسابٍ أو بلا حساب — وتُثبَّت
 * هوية المسؤول كاسمٍ معروض وقت الإسناد. **الإسناد للإدارة المخولة وحدها**
 * (canAssignTasks) — صاحب المهمة يبدأها بلا مسؤولٍ وتديرها هو.
 * إعادة الإرسال بنفس clientRequestId تعيد المهمة الأصلية ولا تنشئ نسخة.
 */
export async function createTask(input: CreateTaskInput, session: SessionPayload): Promise<TaskMutationResult<HrTaskView>> {
  if (!canUseTasks(session.role)) return { ok: false, error: "المهام خارج صلاحيات دورك.", status: 403 };
  if (input.isPrivate && input.assigneeStaffId !== null) {
    return { ok: false, error: "المهمة الخاصة لا تُسند إلى غيرك — حوّلها إلى مشتركة أولًا.", status: 400 };
  }
  if (!input.isPrivate && input.assigneeStaffId !== null && !canAssignTasks(session.role)) {
    return { ok: false, error: "إسناد المهام للإدارة المخولة (المدير والاستقبال) — أنشئ المهمة بلا مسؤولٍ وستتابعها الإدارة.", status: 403 };
  }
  let assigneeStaffId: number | null = null;
  let assigneeUserId: number | null = null;
  let assigneeLabel = "";
  if (!input.isPrivate && input.assigneeStaffId !== null) {
    const staff = await getPool().query(
      `SELECT id, full_name, user_id, work_status FROM hr_staff WHERE id = $1`, [input.assigneeStaffId],
    );
    if (!staff.rowCount) return { ok: false, error: "ملف الموظف المسند إليه غير موجود.", status: 404 };
    if (String(staff.rows[0].work_status) !== "active") {
      return { ok: false, error: "لا تُسند مهمة لموظف ليس على رأس العمل.", status: 400 };
    }
    assigneeStaffId = Number(staff.rows[0].id);
    assigneeUserId = staff.rows[0].user_id === null ? null : Number(staff.rows[0].user_id);
    assigneeLabel = String(staff.rows[0].full_name);
  }

  const displayName = await sessionDisplayName(session);
  const { row: inserted, duplicate } = await withTransaction(getPool(), async (client) => {
    const result = await client.query(
      `INSERT INTO hr_tasks
         (title, description, is_private, status, priority, due_at, planned_for, owner_user_id, owner_display_name,
          assignee_staff_id, assignee_user_id, assignee_label, created_by, client_request_id)
       VALUES ($1, $2, $3, 'planned', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (client_request_id) WHERE client_request_id IS NOT NULL DO NOTHING
       RETURNING *`,
      [input.title, input.description, input.isPrivate, input.priority, input.dueAt, input.plannedFor,
       session.userId, displayName, assigneeStaffId, assigneeUserId, assigneeLabel, session.username,
       input.clientRequestId ?? null],
    );
    if (result.rows.length === 0) {
      // فقدان الرد ثم إعادة الإرسال بنفس المفتاح: الصف الأصلي يعود ولا نسخة ثانية.
      const existing = await client.query(
        `SELECT * FROM hr_tasks WHERE client_request_id = $1`, [input.clientRequestId ?? null],
      );
      if (existing.rows.length > 0) {
        return { row: taskRowMapper(existing.rows[0]), duplicate: true as const };
      }
      // مفتاح طُعن فيه من مهمة أخرى؟ (مستحيل بندريًّا — الفهرس فريد عالميًّا)
      return { row: null, duplicate: true as const };
    }
    const row = taskRowMapper(result.rows[0]);
    await recordTaskEvent(client, {
      taskId: row.id, actorUserId: session.userId, actorDisplayName: displayName,
      action: "create",
      field: input.isPrivate ? "is_private" : null,
      newValue: input.isPrivate ? "خاصة" : assigneeLabel || null,
    });
    return { row, duplicate: false as const };
  });
  if (inserted === null || duplicate) {
    // لا حدث ولا تدقيق لعمليةٍ لم تقع — الأصل عاد كما هو.
    if (inserted === null) return { ok: false, error: "تعذّر إنشاء المهمة — أعد المحاولة.", status: 500 };
    return { ok: true, value: taskToView(inserted) };
  }
  await auditTask("task.create", session, inserted.id,
    input.isPrivate ? "إنشاء مهمة خاصة" : `إنشاء مهمة مسندة إلى ${assigneeLabel || "لا أحد"}`,
    { private: input.isPrivate });
  return { ok: true, value: taskToView(inserted) };
}

/** اسم صاحب الجلسة كما يُسجَّل في الأحداث — من الusers لا من العميل. */
async function sessionDisplayName(session: SessionPayload): Promise<string> {
  const result = await getPool().query(`SELECT display_name FROM users WHERE id = $1`, [session.userId]);
  return result.rowCount && result.rowCount > 0 ? String(result.rows[0].display_name) : session.username;
}

export interface UpdateTaskPatch {
  title?: string;
  description?: string;
  priority?: TaskPriority;
  dueAt?: string | null;
  /** تاريخ التخطيط المستقل عن الاستحقاق. */
  plannedFor?: string | null;
  status?: TaskStatus;
  assigneeStaffId?: number | null;
  /** التحويل إلى مشتركة فعلٌ صريح مستقل — لا يمرّ عبر تعديل عادي. */
  convertToShared?: true;
  /** طابع تحديثٍ يتوقعه العميل — اختلافه يعني نسخة أحدث: 409 لا كتابة فوقها. */
  expectedUpdatedAt?: string;
}

const TASK_STATUS_EVENT: Record<TaskStatus, string> = {
  planned: "أعادتها إلى مخططة",
  in_progress: "بدأها",
  blocked: "أوقفها — متعطلة",
  completed: "أكملها",
  cancelled: "ألغاها",
};

/**
 * تحديث مهمة موجودة — **فصلٌ صريح بين المشاهدة والإدارة والعمل**:
 * - الرؤية (canSeeTask) شرطُ دخولٍ وحده: غير المرئي يُجاب 404 بلا فرقٍ عن المجهول.
 * - حقول الإدارة (العنوان/الوصف/الأولوية/الموعدان/المسؤول/التحويل إلى مشتركة)
 *   تتطلب canManageTask في الخادم على مستوى الحقل: المكلّف لا يعدّلها ولا
 *   يُعيد إسناد المهمة — فإعادة الإسناد تمنح غيره الوصول، وهي قرار إداري.
 * - تغيير الحالة عملٌ يُتاح للمكلّف (canWorkOnTask).
 * - expectedUpdatedAt يحمي من الحفظ فوق نسخةٍ أحدث (409).
 * أي تحديثٍ نيابةً عن موظفٍ بلا حساب يحمل هوية من ضغط الزر — صاحب الجلسة فعلًا.
 */


export async function updateTask(
  taskId: number, patch: UpdateTaskPatch, session: SessionPayload,
): Promise<TaskMutationResult<HrTaskView>> {
  if (!canUseTasks(session.role)) return { ok: false as const, error: "المهام خارج صلاحيات دورك.", status: 403 };
  const displayName = await sessionDisplayName(session);

  const managementChangeRequested =
    patch.title !== undefined
    || patch.description !== undefined
    || patch.priority !== undefined
    || patch.dueAt !== undefined
    || patch.plannedFor !== undefined
    || patch.assigneeStaffId !== undefined
    || patch.convertToShared === true;

  /* التدقيق بعد الالتزام — انظر updateStaff: سطر التدقيق لا يُكتب داخل معاملةٍ
     تحتفظ بقفل الصف، فلا جمود اتصالي تحت التحميل المتوازي. */
  return withTransaction(getPool(), async (client) => {
    const current = await client.query(`SELECT * FROM hr_tasks WHERE id = $1 FOR UPDATE`, [taskId]);
    if (!current.rowCount) return { ok: false as const, error: "المهمة غير موجودة أو غير مرئية لك.", status: 404 };
    const row = taskRowMapper(current.rows[0]);
    const viewerStaffId = await staffIdForUser(session.userId, client);
    if (!canSeeTask(row, session, viewerStaffId)) {
      return { ok: false as const, error: "المهمة غير موجودة أو غير مرئية لك.", status: 404 };
    }
    // الحماية الحقلية في الخادم: canManageTask قرارٌ مستقل عن canSeeTask —
    // اختبار الدالة وحدها لا يحمي المسار؛ هذا الحارس هنا يحميه.
    if (managementChangeRequested && !canManageTask(row, session)) {
      return {
        ok: false as const,
        error: "تعديل عنوان المهمة أو وصفها أو أولويتها أو موعديها أو مسؤولها أو مشاركتها يتطلب صلاحية إدارة المهمة — المكلّف يغيّر الحالة ويعلّق ويعمل في القائمة.",
        status: 403,
      };
    }
    if (patch.expectedUpdatedAt !== undefined) {
      const expected = new Date(patch.expectedUpdatedAt).getTime();
      if (!Number.isFinite(expected) || expected !== new Date(row.updated_at).getTime()) {
        return { ok: false as const, error: "غُيِّرت المهمة من جلسة أخرى بعد فتحك لها — أعد التحميل ثم أعد المحاولة.", status: 409 };
      }
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    const events: { action: "update" | "status" | "assign" | "visibility"; field: string; oldValue: string | null; newValue: string | null }[] = [];

    if (patch.convertToShared === true && row.is_private) {
      sets.push(`is_private = FALSE`);
      events.push({ action: "visibility", field: "is_private", oldValue: "خاصة", newValue: "مشتركة" });
    }
    if (patch.title !== undefined && patch.title !== row.title) {
      params.push(patch.title);
      sets.push(`title = $${params.length}`);
      events.push({ action: "update", field: "title", oldValue: row.title, newValue: patch.title });
    }
    if (patch.description !== undefined && patch.description !== row.description) {
      params.push(patch.description);
      sets.push(`description = $${params.length}`);
      events.push({ action: "update", field: "description", oldValue: null, newValue: null });
    }
    if (patch.priority !== undefined && patch.priority !== row.priority) {
      params.push(patch.priority);
      sets.push(`priority = $${params.length}`);
      events.push({ action: "update", field: "priority", oldValue: TASK_PRIORITY_LABEL[row.priority], newValue: TASK_PRIORITY_LABEL[patch.priority] });
    }
    if (patch.dueAt !== undefined && (patch.dueAt ?? null) !== (row.due_at ? new Date(row.due_at).toISOString() : null)) {
      params.push(patch.dueAt);
      sets.push(`due_at = $${params.length}`);
      events.push({ action: "update", field: "due_at", oldValue: row.due_at ? new Date(row.due_at).toISOString() : null, newValue: patch.dueAt });
    }
    if (patch.plannedFor !== undefined && (patch.plannedFor ?? null) !== (row.planned_for ? String(row.planned_for).slice(0, 10) : null)) {
      params.push(patch.plannedFor);
      sets.push(`planned_for = $${params.length}`);
      events.push({ action: "update", field: "planned_for", oldValue: row.planned_for ? String(row.planned_for).slice(0, 10) : null, newValue: patch.plannedFor });
    }
    if (patch.assigneeStaffId !== undefined && patch.assigneeStaffId !== row.assignee_staff_id) {
      if (row.is_private) return { ok: false as const, error: "المهمة الخاصة لا تقبل إسنادًا.", status: 400 };
      if (patch.assigneeStaffId === null) {
        sets.push(`assignee_staff_id = NULL, assignee_user_id = NULL, assignee_label = ''`);
        events.push({ action: "assign", field: "assignee", oldValue: row.assignee_label || null, newValue: null });
      } else {
        const staff = await client.query(`SELECT id, full_name, user_id, work_status FROM hr_staff WHERE id = $1`, [patch.assigneeStaffId]);
        if (!staff.rowCount) return { ok: false as const, error: "ملف الموظف المسند إليه غير موجود.", status: 404 };
        if (String(staff.rows[0].work_status) !== "active") {
          return { ok: false as const, error: "لا تُسند مهمة لموظف ليس على رأس العمل.", status: 400 };
        }
        params.push(Number(staff.rows[0].id),
          staff.rows[0].user_id === null ? null : Number(staff.rows[0].user_id),
          String(staff.rows[0].full_name));
        sets.push(`assignee_staff_id = $${params.length - 2}, assignee_user_id = $${params.length - 1}, assignee_label = $${params.length}`);
        events.push({ action: "assign", field: "assignee", oldValue: row.assignee_label || null, newValue: String(staff.rows[0].full_name) });
      }
    }
    if (patch.status !== undefined && patch.status !== row.status) {
      if (!canWorkOnTask(row, session, viewerStaffId)) {
        return { ok: false as const, error: "لا تعمل في هذه المهمة.", status: 403 };
      }
      params.push(patch.status);
      sets.push(`status = $${params.length}`);
      if (patch.status === "completed") {
        sets.push(`completed_at = NOW()`);
      } else if (row.status === "completed") {
        sets.push(`completed_at = NULL`);
      }
      events.push({ action: "status", field: "status", oldValue: TASK_STATUS_LABEL[row.status], newValue: TASK_STATUS_LABEL[patch.status] });
    }

    if (sets.length === 0) return { ok: true as const, value: taskToView(row), events: [], wasPrivate: row.is_private, changed: false as const };

    params.push(taskId);
    sets.push(`updated_at = NOW()`);
    const updated = await client.query(`UPDATE hr_tasks SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`, params);
    const updatedRow = taskRowMapper(updated.rows[0]);
    for (const event of events) {
      await recordTaskEvent(client, {
        taskId, actorUserId: session.userId, actorDisplayName: displayName,
        action: event.action, field: event.field, oldValue: event.oldValue, newValue: event.newValue,
      });
    }
    // راية الخصوصية من الصف قبل العملية: ما جرى وهو خاصٌّ يُدقّق محميًّا وفق خصوصيته.
    return { ok: true as const, value: taskToView(updatedRow), events, wasPrivate: row.is_private, changed: true as const };
  }).then(async (result) => {
    if (!result.ok) return result;
    if (!result.changed) return { ok: true as const, value: result.value };
    // التدقيق العام بعد الالتزام: بيانات وصفية فقط — عنوان الخاصة لا يُكتب أبدًا.
    const events = result.events ?? [];
    const primary = events[0];
    if (primary) {
      await auditTask(
        primary.action === "status" ? "task.status"
          : primary.action === "assign" ? "task.assign"
          : primary.action === "visibility" ? "task.visibility" : "task.update",
        session, taskId,
        primary.action === "visibility" ? "تحويل مهمة خاصة إلى مشتركة"
          : primary.action === "status" ? `${TASK_STATUS_EVENT[patch.status ?? "planned"]} (#${taskId})`
          : `تعديل مهمة (#${taskId})`,
        { fields: events.map((e) => e.field), private: result.wasPrivate },
      );
    }
    const { value } = result;
    return { ok: true as const, value };
  });
}

export async function addTaskComment(
  taskId: number, body: string, session: SessionPayload, clientRequestId?: string | null,
): Promise<TaskMutationResult<{ id: number; createdAt: string }>> {
  if (!canUseTasks(session.role)) return { ok: false, error: "المهام خارج صلاحيات دورك.", status: 403 };
  const displayName = await sessionDisplayName(session);
  const inserted = await withTransaction(getPool(), async (client) => {
    const current = await client.query(`SELECT * FROM hr_tasks WHERE id = $1 FOR UPDATE`, [taskId]);
    if (!current.rowCount) return { ok: false as const, error: "المهمة غير موجودة أو غير مرئية لك.", status: 404 };
    const row = taskRowMapper(current.rows[0]);
    const viewerStaffId = await staffIdForUser(session.userId, client);
    // التوحيد: غير المرئي (خاصةً لغير صاحبها) 404 بلا فرقٍ عن المجهول — لا استنتاج
    // بوجود مهمةٍ خاصة من 403. والعمل (تعليق) للمكلّف بعد ثبوت الرؤية.
    if (!canSeeTask(row, session, viewerStaffId)) {
      return { ok: false as const, error: "المهمة غير موجودة أو غير مرئية لك.", status: 404 };
    }
    if (!canWorkOnTask(row, session, viewerStaffId)) {
      return { ok: false as const, error: "لا تعمل في هذه المهمة.", status: 403 };
    }
    const result = clientRequestId
      ? await client.query(
          `INSERT INTO hr_task_comments (task_id, author_user_id, author_display_name, body, client_request_id)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (task_id, client_request_id) WHERE client_request_id IS NOT NULL DO NOTHING
           RETURNING id, created_at`,
          [taskId, session.userId, displayName, body, clientRequestId],
        )
      : await client.query(
          `INSERT INTO hr_task_comments (task_id, author_user_id, author_display_name, body)
           VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
          [taskId, session.userId, displayName, body],
        );
    if (result.rows.length === 0) {
      // فقدان الرد ثم إعادة الإرسال بنفس المفتاح: التعليق الأصلي يعود ولا نسخة.
      const existing = await client.query(
        `SELECT id, created_at FROM hr_task_comments WHERE task_id = $1 AND client_request_id = $2`,
        [taskId, clientRequestId],
      );
      if (existing.rows.length > 0) {
        return { ok: true as const, id: Number(existing.rows[0].id), createdAt: new Date(existing.rows[0].created_at).toISOString(), duplicate: true as const, wasPrivate: row.is_private };
      }
      return { ok: false as const, error: "تعذّر إضافة التعليق — أعد المحاولة.", status: 500 };
    }
    await client.query(`UPDATE hr_tasks SET updated_at = NOW() WHERE id = $1`, [taskId]);
    await recordTaskEvent(client, {
      taskId, actorUserId: session.userId, actorDisplayName: displayName, action: "comment",
    });
    return { ok: true as const, id: Number(result.rows[0].id), createdAt: new Date(result.rows[0].created_at).toISOString(), duplicate: false as const, wasPrivate: row.is_private };
  });
  if (!inserted.ok) return inserted;
  if (!inserted.duplicate) {
    await auditTask("task.comment", session, taskId, `تعليق على مهمة (#${taskId})`, { private: inserted.wasPrivate });
  }
  return { ok: true, value: { id: inserted.id, createdAt: inserted.createdAt } };
}

export type ChecklistOperation =
  | { op: "add"; label: string; clientRequestId?: string | null }
  | { op: "toggle"; itemId: number; done: boolean }
  | { op: "remove"; itemId: number };

/** قائمة التحقق: إضافة وتحويل وإزالة — كل بديلٍ يُسجَّل باسم فعّاله. */
export async function mutateTaskChecklist(
  taskId: number, operation: ChecklistOperation, session: SessionPayload,
): Promise<TaskMutationResult<{ ok: true }>> {
  if (!canUseTasks(session.role)) return { ok: false, error: "المهام خارج صلاحيات دورك.", status: 403 };
  const displayName = await sessionDisplayName(session);
  const outcome = await withTransaction(getPool(), async (client) => {
    const current = await client.query(`SELECT * FROM hr_tasks WHERE id = $1 FOR UPDATE`, [taskId]);
    if (!current.rowCount) return { ok: false as const, error: "المهمة غير موجودة أو غير مرئية لك.", status: 404 };
    const row = taskRowMapper(current.rows[0]);
    const viewerStaffId = await staffIdForUser(session.userId, client);
    // التوحيد: غير المرئي 404 بلا فرقٍ عن المجهول، والعمل بعد ثبوت الرؤية.
    if (!canSeeTask(row, session, viewerStaffId)) {
      return { ok: false as const, error: "المهمة غير موجودة أو غير مرئية لك.", status: 404 };
    }
    if (!canWorkOnTask(row, session, viewerStaffId)) {
      return { ok: false as const, error: "لا تعمل في هذه المهمة.", status: 403 };
    }

    let auditSummary: string | null = null;
    if (operation.op === "add") {
      const insertResult = operation.clientRequestId
        ? await client.query(
            `INSERT INTO hr_task_checklist (task_id, label, position, client_request_id)
             SELECT $1, $2, COALESCE(MAX(position), 0) + 1, $3 FROM hr_task_checklist WHERE task_id = $1
             ON CONFLICT (task_id, client_request_id) WHERE client_request_id IS NOT NULL DO NOTHING
             RETURNING id`,
            [taskId, operation.label, operation.clientRequestId],
          )
        : await client.query(
            `INSERT INTO hr_task_checklist (task_id, label, position)
             SELECT $1, $2, COALESCE(MAX(position), 0) + 1 FROM hr_task_checklist WHERE task_id = $1
             RETURNING id`,
            [taskId, operation.label],
          );
      if (insertResult.rows.length === 0) {
        // فقدان الرد ثم إعادة الإرسال بنفس المفتاح: البند الأصلي يعود ولا نسخة.
        return { ok: true as const, auditSummary: null, wasPrivate: row.is_private };
      }
      await recordTaskEvent(client, {
        taskId, actorUserId: session.userId, actorDisplayName: displayName,
        action: "checklist", field: "add", newValue: operation.label,
      });
      auditSummary = `إضافة بند تحقق (#${taskId})`;
    } else if (operation.op === "toggle") {
      const item = await client.query(`SELECT id, label, done FROM hr_task_checklist WHERE id = $1 AND task_id = $2 FOR UPDATE`, [operation.itemId, taskId]);
      if (!item.rowCount) return { ok: false as const, error: "بند التحقق غير موجود.", status: 404 };
      await client.query(
        `UPDATE hr_task_checklist SET done = $1, done_by = $2, done_at = $3 WHERE id = $4`,
        [operation.done, operation.done ? displayName : null, operation.done ? new Date() : null, operation.itemId],
      );
      await recordTaskEvent(client, {
        taskId, actorUserId: session.userId, actorDisplayName: displayName,
        action: "checklist", field: operation.done ? "done" : "undone", newValue: String(item.rows[0].label),
      });
      auditSummary = `تحديث بند تحقق (#${taskId})`;
    } else {
      const item = await client.query(`SELECT id, label FROM hr_task_checklist WHERE id = $1 AND task_id = $2`, [operation.itemId, taskId]);
      if (!item.rowCount) return { ok: false as const, error: "بند التحقق غير موجود.", status: 404 };
      await client.query(`DELETE FROM hr_task_checklist WHERE id = $1`, [operation.itemId]);
      await recordTaskEvent(client, {
        taskId, actorUserId: session.userId, actorDisplayName: displayName,
        action: "checklist", field: "remove", oldValue: String(item.rows[0].label),
      });
      auditSummary = `حذف بند تحقق (#${taskId})`;
    }
    await client.query(`UPDATE hr_tasks SET updated_at = NOW() WHERE id = $1`, [taskId]);
    return { ok: true as const, auditSummary, wasPrivate: row.is_private };
  });
  if (!outcome.ok) return outcome;
  if (outcome.auditSummary !== null) {
    await auditTask("task.checklist", session, taskId, outcome.auditSummary, { private: outcome.wasPrivate });
  }
  return { ok: true, value: { ok: true } };
}

/**
 * ربط المهمة بسجلٍّ (مريض/أمر مختبر/بند مخزون): الوصول إلى السجل الأصلي يُفحص
 * عند الإنشاء وعند كل قراءة — الإسناد والربط لا يمنحان وصولًا جديدًا لأحد.
 */
export async function addTaskLink(
  taskId: number, kind: TaskLinkKind, linkId: number, session: SessionPayload,
): Promise<TaskMutationResult<{ label: string }>> {
  if (!canUseTasks(session.role)) return { ok: false, error: "المهام خارج صلاحيات دورك.", status: 403 };
  const displayName = await sessionDisplayName(session);
  const exists = await linkReadableForSession(session, kind, linkId);
  if (!exists) {
    return { ok: false, error: "السجل المطلوب ربطه غير موجود أو خارج صلاحياتك — الربط لا يمنح وصولًا.", status: 404 };
  }
  const label = await describeLinkTarget(session, kind, linkId);
  if (label === null) return { ok: false, error: "السجل المطلوب ربطه غير موجود.", status: 404 };

  const outcome = await withTransaction(getPool(), async (client) => {
    const current = await client.query(`SELECT * FROM hr_tasks WHERE id = $1 FOR UPDATE`, [taskId]);
    if (!current.rowCount) return { ok: false as const, error: "المهمة غير موجودة أو غير مرئية لك.", status: 404 };
    const row = taskRowMapper(current.rows[0]);
    const viewerStaffId = await staffIdForUser(session.userId, client);
    // التوحيد: غير المرئي 404 بلا فرقٍ عن المجهول — لا استنتاج بوجود مهمةٍ خاصة.
    if (!canSeeTask(row, session, viewerStaffId)) {
      return { ok: false as const, error: "المهمة غير موجودة أو غير مرئية لك.", status: 404 };
    }
    if (!canManageTask(row, session)) return { ok: false as const, error: "لا تدير هذه المهمة.", status: 403 };
    const duplicate = await client.query(
      `SELECT 1 FROM hr_task_links WHERE task_id = $1 AND link_kind = $2 AND link_id = $3`, [taskId, kind, linkId],
    );
    if (duplicate.rowCount) return { ok: false as const, error: "السجل مرتبط بهذه المهمة مسبقًا.", status: 409 };
    await client.query(
      `INSERT INTO hr_task_links (task_id, link_kind, link_id, link_label, linked_by) VALUES ($1, $2, $3, $4, $5)`,
      [taskId, kind, linkId, label, session.username],
    );
    await client.query(`UPDATE hr_tasks SET updated_at = NOW() WHERE id = $1`, [taskId]);
    await recordTaskEvent(client, {
      taskId, actorUserId: session.userId, actorDisplayName: displayName,
      action: "link", field: kind, newValue: label, linkId,
    });
    return { ok: true as const, wasPrivate: row.is_private };
  });
  if (!outcome.ok) return outcome;
  await auditTask("task.link", session, taskId, `ربط مهمة (#${taskId}) بـ${TASK_LINK_KIND_LABEL[kind]}`,
    { kind, linkId, private: outcome.wasPrivate });
  return { ok: true, value: { label } };
}

export async function removeTaskLink(taskId: number, linkId: number, session: SessionPayload): Promise<TaskMutationResult<{ ok: true }>> {
  if (!canUseTasks(session.role)) return { ok: false, error: "المهام خارج صلاحيات دورك.", status: 403 };
  const displayName = await sessionDisplayName(session);
  const outcome = await withTransaction(getPool(), async (client) => {
    const current = await client.query(`SELECT * FROM hr_tasks WHERE id = $1 FOR UPDATE`, [taskId]);
    if (!current.rowCount) return { ok: false as const, error: "المهمة غير موجودة أو غير مرئية لك.", status: 404 };
    const row = taskRowMapper(current.rows[0]);
    const viewerStaffId = await staffIdForUser(session.userId, client);
    if (!canSeeTask(row, session, viewerStaffId)) {
      return { ok: false as const, error: "المهمة غير موجودة أو غير مرئية لك.", status: 404 };
    }
    if (!canManageTask(row, session)) return { ok: false as const, error: "لا تدير هذه المهمة.", status: 403 };
    const link = await client.query(`SELECT id, link_kind, link_id, link_label FROM hr_task_links WHERE id = $1 AND task_id = $2`, [linkId, taskId]);
    if (!link.rowCount) return { ok: false as const, error: "الرابط غير موجود.", status: 404 };
    await client.query(`DELETE FROM hr_task_links WHERE id = $1`, [linkId]);
    await client.query(`UPDATE hr_tasks SET updated_at = NOW() WHERE id = $1`, [taskId]);
    await recordTaskEvent(client, {
      taskId, actorUserId: session.userId, actorDisplayName: displayName,
      action: "unlink", field: String(link.rows[0].link_kind), oldValue: String(link.rows[0].link_label),
      linkId: Number(link.rows[0].link_id),
    });
    return { ok: true as const, kind: String(link.rows[0].link_kind), wasPrivate: row.is_private };
  });
  if (!outcome.ok) return outcome;
  await auditTask("task.unlink", session, taskId, `فكّ ربط مهمة (#${taskId}) عن ${outcome.kind}`,
    { private: outcome.wasPrivate });
  return { ok: true, value: { ok: true } };
}
