import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (HR-1/HR-2) الموارد البشرية والمهام على PostgreSQL 18 الحقيقي:
 *
 *  * القيود البنيوية تعمل: الخاصة بلا مسؤول، والراتب ثلاثته معًا بعملةٍ معتمدة،
 *    وسجلا التغيير append-only حتى على المدير.
 *  * الخصوصية على مستوى الصف: قائمة وعدّادات وتفاصيل لا تُسرّب الخاصة لغير صاحبها.
 *  * **مسؤولية المكلّف عبر الربط الحالي حصرًا** (مراجعة دوت №2): فكّ ربط الحساب
 *    يسحب الوصول فورًا من القائمة والعدادات والقراءة والكتابة والتعليق والبحث،
 *    وإعادة الربط تمنحه لملف الموظف لا للحساب القديم.
 *  * **تسجيل السجل المرتبط** (مراجعة دوت №3): أحداث الربط بلا أسماء لمن لا يملك
 *    صلاحية المريض — والسحب يسري على الصفوف القديمة المعروضة.
 *  * **فصل المشاهدة عن الإدارة** (مراجعة دوت №4): المسؤول يغيّر الحالة ويعلّق،
 *    ولا يعدّل العنوان/الأولوية/المواعيد ولا يُعيد الإسناد — عبر دوال الطبقة
 *    التي تحرسها المسارات نفسها (HTTP يُختبر في security-http).
 *  * **خصوصية الخاصة في التدقيق** (مراجعة دوت №5): عمليات المهمة الخاصة لا تعود
 *    في listAudit، و404 موحّد بلا تمييزٍ عن المجهول في كل مسارات الكتابة.
 *  * الموظف بلا حساب يُسند إليه، والتحديث يحمل هوية صاحب الجلسة فعلًا.
 *  * التزامن (مراجعة دوت/الملحق №7): تبديلٌ متوازٍ فعليّ لبندٍ واحد لا يضيع
 *    ولا يكرّر، ومفتاح المعاملة يمنع تكرار الإنشاء عند فقدان الرد.
 *  * المالية بلا أثر: لا صف عمولة ولا حركة صندوق بسبب المهام.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const { ensureSchema, getPool, resetPoolForTesting, createPatient, listAudit } = await import("../../lib/db");
const {
  createStaff, updateStaff, setStaffUserLink, listStaffDirectory, listStaff,
  createTask, updateTask, listTasks, getTaskForSession, addTaskComment, mutateTaskChecklist, addTaskLink,
} = await import("../../lib/hr");

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
  (await getPool().query(sql, params)).rows as T[];

/** فكّ نتيجة الكتابة: الفشل يُرمى — الاختبار يقرأ القيمة حين تُنجح العملية فقط. */
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: string; status: number }): T {
  if (!result.ok) throw new Error(`توقّع النجاح: ${result.error}`);
  return result.value;
}

const admin = { userId: 0, username: "hr-admin", role: "admin", expiresAt: Date.now() + 3_600_000 } as never;
const reception = { userId: 0, username: "hr-reception", role: "reception", expiresAt: Date.now() + 3_600_000 } as never;
const doctor = { userId: 0, username: "hr-doctor", role: "doctor", expiresAt: Date.now() + 3_600_000 } as never;
const otherDoctor = { userId: 0, username: "hr-doctor2", role: "doctor", expiresAt: Date.now() + 3_600_000 } as never;

let adminId = 0;
let receptionId = 0;
let doctorId = 0;
let otherDoctorId = 0;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  const inserted = await q<{ id: number; username: string }>(
    `INSERT INTO users (username, display_name, password_hash, role)
     VALUES ('hr-admin', 'مدير الاختبار', 'x', 'admin'),
            ('hr-reception', 'استقبال الاختبار', 'x', 'reception'),
            ('hr-doctor', 'طبيب الاختبار', 'x', 'doctor'),
            ('hr-doctor2', 'طبيب آخر', 'x', 'doctor')
     RETURNING id, username`,
  );
  for (const row of inserted) {
    if (row.username === "hr-admin") adminId = row.id;
    if (row.username === "hr-reception") receptionId = row.id;
    if (row.username === "hr-doctor") doctorId = row.id;
    if (row.username === "hr-doctor2") otherDoctorId = row.id;
  }
  (admin as { userId: number }).userId = adminId;
  (reception as { userId: number }).userId = receptionId;
  (doctor as { userId: number }).userId = doctorId;
  (otherDoctor as { userId: number }).userId = otherDoctorId;
});

afterAll(async () => { await resetPoolForTesting(); });

describe("(HR-1) staff files", () => {
  it("creates a guard file with no login account and a salary saved with currency, period and effective date", async () => {
    const guard = await createStaff({
      fullName: "حارس المركز", jobTitle: "حارس", department: "guard", hireDate: "2026-01-01",
      workStatus: "active", endDate: null,
      contractKind: "salary",
      payTerms: { amountMinor: 1_200_000, currency: "YER", period: "monthly", effectiveOn: "2026-02-01" },
      phone: null, note: null,
    }, admin);
    expect(guard.workStatus).toBe("active");
    expect(guard.userId).toBeNull();
    expect(guard.payTerms).toEqual({ amountMinor: 1_200_000, currency: "YER", period: "monthly", effectiveOn: "2026-02-01" });
    // الجولة الكاملة: ما أُدخل هو ما عاد من القراءة — وحدة اليمني واحدة لا مئة.
    expect(guard.payTerms!.amountMinor).toBe(1_200_000);
  });

  it("saves the work status and end date the user actually chose — not a forced «active» (مراجعة دوت/الملحق)", async () => {
    // قبل الإصلاح كان createStaff يكتب 'active' دائمًا ويتجاهل endDate.
    const ended = await createStaff({
      fullName: "موظف منتهية خدمته", jobTitle: "خدمة", department: "other", hireDate: "2025-01-01",
      workStatus: "ended", endDate: "2026-09-30",
      contractKind: "commission", payTerms: null, phone: null, note: null,
    }, admin);
    expect(ended.workStatus).toBe("ended");
    expect(ended.endDate).toBe("2026-09-30");
    const suspended = await createStaff({
      fullName: "موظف موقوف", jobTitle: "خدمة", department: "other", hireDate: null,
      workStatus: "suspended", endDate: null,
      contractKind: "commission", payTerms: null, phone: null, note: null,
    }, admin);
    expect(suspended.workStatus).toBe("suspended");
    // وقراءة العودة من القاعدة مطابقة.
    const reread = (await q<{ work_status: string; end_date: string }>(
      `SELECT work_status, end_date::text FROM hr_staff WHERE id = $1`, [ended.id],
    ))[0];
    expect(reread.work_status).toBe("ended");
    expect(reread.end_date).toBe("2026-09-30");
  });

  it("rejects a salary without its currency/period/effective date — the named database constraint refuses", async () => {
    await expect(createStaff({
      fullName: "سكرتيرة بلا شروط", jobTitle: "سكرتارية", department: "secretariat", hireDate: null,
      workStatus: "active", endDate: null,
      contractKind: "salary", payTerms: null, phone: null, note: null,
    }, admin)).rejects.toThrow(/hr_staff_pay_terms_complete/);
    await expect(getPool().query(
      `INSERT INTO hr_staff (full_name, contract_kind, salary_amount_minor, created_by)
       VALUES ('راتب بلا عملة', 'salary', 500, 't')`,
    )).rejects.toThrow(/hr_staff_pay_terms_complete/);
  });

  it("the salary currency is locked to YER/SAR/USD by the database constraint itself", async () => {
    await expect(getPool().query(
      `INSERT INTO hr_staff (full_name, contract_kind, salary_amount_minor, salary_currency, salary_period, salary_effective_on, created_by)
       VALUES ('عملة مبتكرة', 'salary', 500, 'EUR', 'monthly', '2026-01-01', 't')`,
    )).rejects.toThrow(/hr_staff_salary_currency_check|salary_currency/);
  });

  it("records who changed what with old and new values, and the change log is append-only", async () => {
    const coordinator = await createStaff({
      fullName: "منسق المرضى", jobTitle: "منسق", department: "coordinator", hireDate: null,
      workStatus: "active", endDate: null,
      contractKind: "commission", payTerms: null, phone: null, note: null,
    }, admin);
    const updated = await updateStaff(coordinator.id, {
      jobTitle: "منسق مرضى", workStatus: "suspended", contractKind: "salary",
      payTerms: { amountMinor: 800_000, currency: "SAR", period: "monthly", effectiveOn: "2026-10-01" },
      reason: "تعديل مسمّى ووقف مؤقت وراتب جديد",
    }, admin);
    if (!updated.ok) throw new Error(updated.error);
    expect(updated.staff.jobTitle).toBe("منسق مرضى");
    expect(updated.staff.contractKind).toBe("salary");
    const changes = await q<{ action: string; field: string; old_value: string; new_value: string; reason: string }>(
      `SELECT action, field, old_value, new_value, reason FROM hr_staff_changes WHERE staff_id = $1 ORDER BY id`, [coordinator.id],
    );
    expect(changes.map((change) => change.field)).toContain("job_title");
    expect(changes.map((change) => change.field)).toContain("pay_terms");
    const payChange = changes.find((change) => change.field === "pay_terms")!;
    expect(payChange.reason).toBe("تعديل مسمّى ووقف مؤقت وراتب جديد");
    expect(payChange.new_value).toContain("SAR");

    // append-only: لا UPDATE ولا DELETE حتى من الإدارة.
    await expect(getPool().query(`DELETE FROM hr_staff_changes WHERE staff_id = $1`, [coordinator.id])).rejects.toThrow(/append-only/);
    await expect(getPool().query(`UPDATE hr_staff_changes SET new_value = 'عبث' WHERE staff_id = $1`, [coordinator.id])).rejects.toThrow(/append-only/);
  });

  it("converting salary to commission clears the old salary terms in the same save — and reload proves it (الملحق)", async () => {
    const staff = await createStaff({
      fullName: "محوّل النوع", jobTitle: "حسابات", department: "accounting", hireDate: null,
      workStatus: "active", endDate: null,
      contractKind: "salary",
      payTerms: { amountMinor: 900_000, currency: "YER", period: "monthly", effectiveOn: "2026-03-01" },
      phone: null, note: null,
    }, admin);
    // قبل الإصلاح كان هذا يصطدم بقيد القاعدة (500) أو يترك راتبًا تحت نسبة.
    const converted = await updateStaff(staff.id, { contractKind: "commission", reason: "تحويل إلى نسبة" }, admin);
    if (!converted.ok) throw new Error(converted.error);
    expect(converted.staff.contractKind).toBe("commission");
    expect(converted.staff.payTerms).toBeNull();
    // إعادة التحميل من القاعدة: الشروط الأربعة كلها NULL فعلًا.
    const raw = (await q<{ salary_amount_minor: string | null; salary_currency: string | null; salary_period: string | null; salary_effective_on: string | null }>(
      `SELECT salary_amount_minor, salary_currency, salary_period, salary_effective_on FROM hr_staff WHERE id = $1`, [staff.id],
    ))[0];
    expect(raw.salary_amount_minor).toBeNull();
    expect(raw.salary_currency).toBeNull();
    expect(raw.salary_period).toBeNull();
    expect(raw.salary_effective_on).toBeNull();
    // والإلغاء الصريح للراتب مع بقاء نوع «راتب» مرفوض بسببٍ واضح — لا 500.
    const salaryKeeper = await createStaff({
      fullName: "باقٍ براتب", jobTitle: "حسابات", department: "accounting", hireDate: null,
      workStatus: "active", endDate: null,
      contractKind: "salary",
      payTerms: { amountMinor: 700_000, currency: "YER", period: "monthly", effectiveOn: "2026-04-01" },
      phone: null, note: null,
    }, admin);
    const refused = await updateStaff(salaryKeeper.id, { payTerms: null }, admin);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.status).toBe(400);
    // أما مسحٌ مكرّر تحت «نسبة» فهو لا-op سليم لا خطأ.
    const noop = await updateStaff(staff.id, { payTerms: null }, admin);
    expect(noop.ok).toBe(true);
  });

  it("protects edits from saving over a newer copy — expectedUpdatedAt mismatch answers 409 (مراجعة دوت №7)", async () => {
    const staff = await createStaff({
      fullName: "حماية التزامن", jobTitle: "خدمة", department: "other", hireDate: null,
      workStatus: "active", endDate: null,
      contractKind: "commission", payTerms: null, phone: null, note: null,
    }, admin);
    const stale = await updateStaff(staff.id, { jobTitle: "تعديل قديم", expectedUpdatedAt: "2000-01-01T00:00:00.000Z" }, admin);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.status).toBe(409);
    // الطابع الصحيح ينجح.
    const fresh = await updateStaff(staff.id, { jobTitle: "تعديل حديث", expectedUpdatedAt: staff.updatedAt }, admin);
    expect(fresh.ok).toBe(true);
  });

  it("links an existing login account optionally and uniquely — never creates one, never auto-creates a doctor party", async () => {
    const partiesBefore = Number((await q<{ n: string }>(`SELECT COUNT(*)::text AS n FROM parties`))[0].n);
    const nurse = await createStaff({
      fullName: "ممرضة الورديات", jobTitle: "تمريض", department: "nursing", hireDate: null,
      workStatus: "active", endDate: null,
      contractKind: "commission", payTerms: null, phone: null, note: null,
    }, admin);
    const linked = await setStaffUserLink(nurse.id, doctorId, "ربط طلب", admin);
    expect(linked.ok).toBe(true);
    // ربط ثانٍ لنفس الحساب مرفوض — الربط واحدٌ لكل حساب
    const second = await createStaff({
      fullName: "ممرضة ثانية", jobTitle: "تمريض", department: "nursing", hireDate: null,
      workStatus: "active", endDate: null,
      contractKind: "commission", payTerms: null, phone: null, note: null,
    }, admin);
    const duplicate = await setStaffUserLink(second.id, doctorId, "محاولة ثانية", admin);
    expect(duplicate.ok).toBe(false);
    // حسابٌ غير موجود: لا إنشاء
    const missing = await setStaffUserLink(second.id, 999_999, "حساب وهمي", admin);
    expect(missing.ok).toBe(false);
    // لا جهة جديدة أُنشئت بسبب ملفات الطاقم — العمولات في مصدرها الحالي لا يتغير شيء فيه
    const partiesAfter = Number((await q<{ n: string }>(`SELECT COUNT(*)::text AS n FROM parties`))[0].n);
    expect(partiesAfter).toBe(partiesBefore);
  });

  it("directory shows name/title/department only — no amounts, no user ids", async () => {
    const directory = await listStaffDirectory();
    expect(directory.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(directory);
    expect(serialized).not.toContain("salary");
    expect(serialized).not.toContain("amountMinor");
    expect(serialized).not.toContain("user_id");
  });

  it("the staff list strips nothing for the admin but the view shape keeps pay terms out of minimal lists", async () => {
    const full = await listStaff({ includePayTerms: true });
    expect(full.some((member) => member.payTerms !== null)).toBe(true);
    const minimal = await listStaff({ includePayTerms: false });
    expect(minimal.every((member) => member.payTerms === null)).toBe(true);
  });
});

describe("(HR-2) tasks — privacy, assignment, change log", () => {
  let privateTaskId = 0;
  let stillPrivateTaskId = 0;
  let assignedTaskId = 0;

  it("a private task belongs to its owner alone: lists, counts, direct read, and even the admin cannot see it", async () => {
    const created = unwrap(await createTask({
      title: "تذكير شخصي", description: "له وحده", isPrivate: true, priority: "normal", dueAt: null, plannedFor: null, assigneeStaffId: null,
    }, doctor));
    privateTaskId = created.id;

    const doctorList = await listTasks(doctor, { scope: "mine" });
    expect(doctorList.tasks.some((task) => task.id === privateTaskId)).toBe(true);

    // المدير والاستقبال: لا في القائمة ولا في العدادات ولا في القراءة المباشرة.
    for (const session of [admin, reception, otherDoctor]) {
      const list = await listTasks(session, { scope: "team" });
      expect(list.tasks.some((task) => task.id === privateTaskId)).toBe(false);
      const mine = await listTasks(session, { scope: "mine" });
      expect(mine.tasks.some((task) => task.id === privateTaskId)).toBe(false);
      // البحث عن عنوان المهمة الخاصة لا يكشفها في عدادات الآخرين.
      const searched = await listTasks(session, { search: "تذكير شخصي" });
      expect(searched.tasks.some((task) => task.id === privateTaskId)).toBe(false);
      const direct = await getTaskForSession(session, privateTaskId);
      expect(direct).toBeNull();
    }
  });

  it("a private task cannot carry an assignee — the named database constraint refuses even raw SQL", async () => {
    await expect(getPool().query(
      `INSERT INTO hr_tasks (title, is_private, owner_user_id, owner_display_name, assignee_staff_id, assignee_label, created_by)
       VALUES ('خاصة بمسؤول', TRUE, $1, 'مدير', 1, 'حارس', 'hr-admin')`, [adminId],
    )).rejects.toThrow(/hr_tasks_no_assignee_on_private/);
    // وبوابة التطبيق نفسها تردّ الطلب قبل القاعدة.
    const refused = await createTask({
      title: "خاصة بمدبّر", description: "", isPrivate: true, priority: "normal", dueAt: null, plannedFor: null, assigneeStaffId: 1,
    }, admin);
    expect(refused.ok).toBe(false);
  });

  it("a doctor cannot hand a task to someone else at creation — assignment is management-only (مراجعة دوت №4)", async () => {
    const directory = await listStaffDirectory();
    const guard = directory.find((entry) => entry.fullName === "حارس المركز")!;
    const refused = await createTask({
      title: "طبيب يُسند بنفسه", description: "", isPrivate: false, priority: "normal", dueAt: null, plannedFor: null, assigneeStaffId: guard.id,
    }, otherDoctor);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.status).toBe(403);
  });

  it("the planning date is stored and returned distinct from the due date (الملحق)", async () => {
    const created = unwrap(await createTask({
      title: "مهمة بتاريخ تخطيط", description: "", isPrivate: false, priority: "normal",
      dueAt: "2026-11-01T00:00:00.000Z", plannedFor: "2026-10-20", assigneeStaffId: null,
    }, admin));
    expect(created.plannedFor).toBe("2026-10-20");
    const edited = unwrap(await updateTask(created.id, { plannedFor: "2026-10-25" }, admin));
    expect(edited.plannedFor).toBe("2026-10-25");
    const detail = await getTaskForSession(admin, created.id);
    expect(detail!.events.some((event) => event.action === "update" && event.field === "planned_for")).toBe(true);
  });

  it("assigns a task to an accountless staff member; the actor of every update is the real session user", async () => {
    const directory = await listStaffDirectory();
    const guard = directory.find((entry) => entry.fullName === "حارس المركز")!;
    expect(guard.hasAccount).toBe(false);
    const created = unwrap(await createTask({
      title: "إغلاق العيادة عند الثامنة", description: "بعد آخر موعد", isPrivate: false,
      priority: "high", dueAt: null, plannedFor: null, assigneeStaffId: guard.id,
    }, reception));
    assignedTaskId = created.id;
    expect(created.assigneeLabel).toBe("حارس المركز");
    expect(created.assigneeUserId).toBeNull();

    // تحديث نيابةً عنه: الفاعل هو الاستقبال فعلًا — لا يُنسب للحارس.
    await addTaskComment(assignedTaskId, "أُبلغ الحارس هاتفيًا", admin);
    const detail = await getTaskForSession(admin, assignedTaskId);
    expect(detail).not.toBeNull();
    const commentEvent = detail!.events.find((event) => event.action === "comment");
    expect(commentEvent?.actorDisplayName).toBe("مدير الاختبار");
    const commentRow = (await q<{ author_display_name: string; author_user_id: number }>(
      `SELECT author_display_name, author_user_id FROM hr_task_comments WHERE task_id = $1`, [assignedTaskId],
    ))[0];
    expect(commentRow.author_display_name).toBe("مدير الاختبار");
    expect(commentRow.author_user_id).toBe(adminId);
  });

  it("unbinding the account revokes task access immediately through every path — not the UI only (مراجعة دوت №2)", async () => {
    // ملف طاقمٍ مرتبط بحساب الطبيب، ومهمةٌ مسندة إلى الملف.
    const staffFile = await createStaff({
      fullName: "مساعد المهام", jobTitle: "مساعد", department: "assistants", hireDate: null,
      workStatus: "active", endDate: null,
      contractKind: "commission", payTerms: null, phone: null, note: null,
    }, admin);
    const linked = await setStaffUserLink(staffFile.id, otherDoctorId, "ربط للتجربة", admin);
    if (!linked.ok) throw new Error(linked.error);
    const task = unwrap(await createTask({
      title: "مهمة المساعد المرتبط", description: "", isPrivate: false, priority: "normal", dueAt: null, plannedFor: null, assigneeStaffId: staffFile.id,
    }, reception));

    // والمرتبط يراها ويكتب فيها عبر ربطه الحالي.
    expect((await getTaskForSession(otherDoctor, task.id))!.task.id).toBe(task.id);
    expect((await addTaskComment(task.id, "قبل الفكّ", otherDoctor)).ok).toBe(true);

    // **فكّ الربط**: الوصول يسقط فورًا من كل المسارات — القائمة والعدادات والبحث
    // والقراءة المباشرة وتغيير الحالة والتعليق وقائمة التحقق.
    const unlinked = await setStaffUserLink(staffFile.id, null, "سحب الوصول", admin);
    if (!unlinked.ok) throw new Error(unlinked.error);

    const teamList = await listTasks(otherDoctor, { scope: "team" });
    expect(teamList.tasks.some((entry) => entry.id === task.id)).toBe(false);
    const mineList = await listTasks(otherDoctor, { scope: "mine" });
    expect(mineList.tasks.some((entry) => entry.id === task.id)).toBe(false);
    const searched = await listTasks(otherDoctor, { search: "مهمة المساعد المرتبط" });
    expect(searched.tasks.some((entry) => entry.id === task.id)).toBe(false);
    const countsTotal = Object.values(searched.counts).reduce((sum, count) => sum + count, 0);
    expect(countsTotal).toBe(0);
    expect(await getTaskForSession(otherDoctor, task.id)).toBeNull();
    const patchDenied = await updateTask(task.id, { status: "completed" }, otherDoctor);
    expect(patchDenied.ok).toBe(false);
    if (!patchDenied.ok) expect(patchDenied.status).toBe(404);
    const commentDenied = await addTaskComment(task.id, "بعد الفكّ", otherDoctor);
    expect(commentDenied.ok).toBe(false);
    if (!commentDenied.ok) expect(commentDenied.status).toBe(404);
    const checklistDenied = await mutateTaskChecklist(task.id, { op: "add", label: "محاولة" }, otherDoctor);
    expect(checklistDenied.ok).toBe(false);
    if (!checklistDenied.ok) expect(checklistDenied.status).toBe(404);
    // والمهمة نفسها ما تزال مسندة إلى الملف — لا نقل ملكية ولا حذف.
    const stillThere = await getTaskForSession(admin, task.id);
    expect(stillThere!.task.assigneeStaffId).toBe(staffFile.id);

    // **إعادة الربط بحسابٍ آخر**: الملف الجديد صاحب المهمة — الحساب القديم لا يعود
    // إطلاقًا حتى لو أُعيد ربطه ثم فُكّ (المسؤولية للملف لا للقطة الحساب).
    // حساب الطبيب الأول مشغول بملف «ممرضة الورديات»: نفكّه أولًا برسالة سببٍ،
    // وربطٌ سابقٌ لتجربة الفريدية لا يعني ملكيةً دائمة.
    const nurseFile = (await q<{ id: number }>(`SELECT id FROM hr_staff WHERE user_id = $1`, [doctorId]))[0];
    if (nurseFile) {
      const freed = await setStaffUserLink(nurseFile.id, null, "تحرير الحساب لاختبار إعادة الربط", admin);
      if (!freed.ok) throw new Error(freed.error);
    }
    const reLinked = await setStaffUserLink(staffFile.id, doctorId, "إعادة ربط بحساب آخر", admin);
    if (!reLinked.ok) throw new Error(reLinked.error);
    expect((await getTaskForSession(doctor, task.id))!.task.id).toBe(task.id);
    expect(await getTaskForSession(otherDoctor, task.id)).toBeNull();
    // الملكية الشخصية الخاصة لا تُنقل تلقائيًّا بمجرد الربط والفكّ:
    const personalPrivate = unwrap(await createTask({
      title: "خاصة الطبيب الأول لا تُمس", description: "", isPrivate: true, priority: "normal", dueAt: null, plannedFor: null, assigneeStaffId: null,
    }, otherDoctor));
    expect((await getTaskForSession(doctor, personalPrivate.id))).toBeNull();
    expect((await getTaskForSession(admin, personalPrivate.id))).toBeNull();
    await setStaffUserLink(staffFile.id, null, "فكّ بعد التجربة", admin);
    // ونعيد ملف الطبيب الآخر مربوطًا — اختبارات الحدود الأدنى بعده تحتاج ملفًا مرتبطًا.
    const restore = await setStaffUserLink(staffFile.id, otherDoctorId, "إعادة الملف لاختبارات الحدود", admin);
    if (!restore.ok) throw new Error(restore.error);
  });

  it("assignee-by-staff-file flow: convert private to shared is explicit and logged", async () => {
    await updateTask(privateTaskId, { convertToShared: true }, doctor).then((result) => { if (!result.ok) throw new Error(result.error); });
    // الآن يراها المدير — وقبل التحويل لم يرها.
    const adminList = await listTasks(admin, { scope: "team" });
    expect(adminList.tasks.some((task) => task.id === privateTaskId)).toBe(true);
    const detail = await getTaskForSession(admin, privateTaskId);
    const visibilityEvent = detail!.events.find((event) => event.action === "visibility");
    expect(visibilityEvent).toBeDefined();
    // التحويل كُتب في التدقيق العام دون عنوان المهمة الخاصة.
    const audits = await q<{ summary: string }>(
      `SELECT summary FROM audit_log WHERE action = 'task.visibility' AND entity_id = $1`, [String(privateTaskId)],
    );
    expect(audits.length).toBe(1);
    expect(audits[0].summary).not.toContain("تذكير شخصي");
  });

  it("viewing is not managing: the assignee cannot PATCH management fields even though he can see the task (مراجعة دوت №4)", async () => {
    // مهمة مشتركة مسندة إلى ملف مرتبط بالطبيب الآخر: يراها، يعمل فيها، ولا يديرها.
    const directory = await listStaffDirectory();
    const linkedStaff = (await q<{ id: number }>(`SELECT id FROM hr_staff WHERE user_id = $1`, [otherDoctorId]))[0];
    if (!linkedStaff) throw new Error("الطبيب الآخر بلا ملف مرتبط للاختبار");
    const task = unwrap(await createTask({
      title: "حدود المسؤول", description: "", isPrivate: false, priority: "normal", dueAt: null, plannedFor: null, assigneeStaffId: linkedStaff.id,
    }, reception));
    const seen = await getTaskForSession(otherDoctor, task.id);
    expect(seen).not.toBeNull();
    expect(seen!.permissions.canWork).toBe(true);
    expect(seen!.permissions.canManage).toBe(false);

    // **PATCH الحقيقي عبر دوال المسار نفسها** بكل حقل إداري: كلٌّ يُرفض 403.
    for (const patch of [
      { title: "عنوان من المسؤول" },
      { description: "وصف من المسؤول" },
      { priority: "urgent" as const },
      { dueAt: "2026-12-01T00:00:00.000Z" },
      { plannedFor: "2026-11-15" },
      { assigneeStaffId: null },
      { convertToShared: true as const },
      // ومزج حقلٍ مسموح بحقلٍ مرفوض لا يمرّ جزئيًّا:
      { status: "completed" as const, title: "عنوان مسروق" },
    ]) {
      const denied = await updateTask(task.id, patch, otherDoctor);
      expect(denied.ok).toBe(false);
      if (!denied.ok) {
        expect(denied.status).toBe(403);
        expect(denied.error).toContain("صلاحية إدارة المهمة");
      }
    }
    // لم يتغير شيء فعلًا على القاعدة.
    const row = (await q<{ title: string; priority: string; status: string; assignee_staff_id: number | null }>(
      `SELECT title, priority, status, assignee_staff_id FROM hr_tasks WHERE id = $1`, [task.id],
    ))[0];
    expect(row.title).toBe("حدود المسؤول");
    expect(row.priority).toBe("normal");
    expect(row.status).toBe("planned");
    expect(row.assignee_staff_id).toBe(linkedStaff.id);
    // والمسؤول يغيّر الحالة ويعلّق بحرية — العمل ليس إدارة.
    const statusOk = await updateTask(task.id, { status: "in_progress" }, otherDoctor);
    expect(statusOk.ok).toBe(true);
    const commentOk = await addTaskComment(task.id, "أعمل فيها الآن", otherDoctor);
    expect(commentOk.ok).toBe(true);
  });

  it("private-task operations answer 404 like the unknown — no 403/404 oracle for existence (مراجعة دوت №5)", async () => {
    // مهمة خاصة **طازجة** (المهمة الأولى حُوّلت إلى مشتركة في اختبارٍ سابق) —
    // ونضيف عليها عملياتٍ لتُولّد أثرًا لاختبار التدقيق الذي يليه.
    const stillPrivate = unwrap(await createTask({
      title: "خاصة ثابتة على حالها", description: "", isPrivate: true, priority: "normal", dueAt: null, plannedFor: null, assigneeStaffId: null,
    }, doctor));
    stillPrivateTaskId = stillPrivate.id;
    // المهمة الخاصة المهمة: المدير نفسه لا يراها — كتابته عليها 404 لا 403،
    // وكذلك 404 للمجهول الحقيقي بنفس الرسالة: لا فرقٍ يستنتج منه وجودها.
    for (const session of [admin, reception, otherDoctor]) {
      const patch = await updateTask(stillPrivate.id, { status: "completed" }, session);
      expect(patch.ok).toBe(false);
      if (!patch.ok) {
        expect(patch.status).toBe(404);
        expect(patch.error).toBe("المهمة غير موجودة أو غير مرئية لك.");
      }
      const comment = await addTaskComment(stillPrivate.id, "تعليق متطفل", session);
      expect(comment.ok).toBe(false);
      if (!comment.ok) expect(comment.status).toBe(404);
      const checklist = await mutateTaskChecklist(stillPrivate.id, { op: "add", label: "متطفل" }, session);
      expect(checklist.ok).toBe(false);
      if (!checklist.ok) expect(checklist.status).toBe(404);
      const link = await addTaskLink(stillPrivate.id, "patient", 1, session);
      expect(link.ok).toBe(false);
      if (!link.ok) expect(link.status).toBe(404);
    }
    // المجهول الحقيقي: نفس الرد والرسالة.
    const unknown = await updateTask(999_999, { status: "completed" }, admin);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toBe("المهمة غير موجودة أو غير مرئية لك.");
  });

  it("private-task audit rows are kept in the database but never returned by the public audit read (مراجعة دوت №5)", async () => {
    // للمهمة الخاصة الطازجة صفوف تدقيق فعلية (محاولاتُ الكتابة أعلاه لا تُدقّق،
    // لكن إنشاء المهمة نفسه يُدقّق) — والتدقيق كُتب في القاعدة append-only.
    const rawAudit = await q<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM audit_log WHERE entity = 'hr_task' AND entity_id = $1`, [String(stillPrivateTaskId)],
    );
    expect(Number(rawAudit[0].n)).toBeGreaterThan(0);
    // وواجهة التدقيق العامة لا تعيدها — بفلترةٍ مشتقةٍ من حالة المهمة الحية.
    const publicEntries = await listAudit({ entity: "hr_task", entityId: String(stillPrivateTaskId) });
    expect(publicEntries.length).toBe(0);
    const everything = await listAudit({});
    expect(everything.some((entry) => entry.entity === "hr_task" && entry.entityId === String(stillPrivateTaskId))).toBe(false);
    // بينما صفوف مهمةٍ مشتركة تعود طبيعيًّا.
    const sharedAudits = await listAudit({ entity: "hr_task", entityId: String(assignedTaskId) });
    expect(sharedAudits.length).toBeGreaterThan(0);
    // وعنوان المهمة الخاصة لا يُكتب في التدقيق أصلًا — لا حتى في الصفوف المخفية.
    const rawSummaries = await q<{ summary: string }>(
      `SELECT summary FROM audit_log WHERE entity = 'hr_task' AND entity_id = $1`, [String(stillPrivateTaskId)],
    );
    for (const row of rawSummaries) expect(row.summary).not.toContain("خاصة ثابتة");
  });

  it("status transitions set completed_at and the checklist is evented", async () => {
    const added = await mutateTaskChecklist(assignedTaskId, { op: "add", label: "إطفاء الأنوار" }, reception);
    expect(added.ok).toBe(true);
    const detail = await getTaskForSession(reception, assignedTaskId);
    const item = detail!.checklist[0];
    await mutateTaskChecklist(assignedTaskId, { op: "toggle", itemId: item.id, done: true }, reception);
    const after = await getTaskForSession(reception, assignedTaskId);
    expect(after!.checklist[0].done).toBe(true);
    expect(after!.checklist[0].doneBy).toBe("استقبال الاختبار");

    const completed = unwrap(await updateTask(assignedTaskId, { status: "completed" }, reception));
    expect(completed.completedAt).not.toBeNull();
    // إعادة الفتح تمسح توقيت الإكمال.
    const reopened = unwrap(await updateTask(assignedTaskId, { status: "in_progress" }, reception));
    expect(reopened.completedAt).toBeNull();
  });

  it("real concurrent toggles of ONE item serialize without lost writes, and 409 protects stale edits (الملحق)", async () => {
    const task = unwrap(await createTask({
      title: "تبديل متزامن فعلي", description: "", isPrivate: false, priority: "normal", dueAt: null, plannedFor: null, assigneeStaffId: null,
    }, admin));
    await mutateTaskChecklist(task.id, { op: "add", label: "بند التبديل" }, admin);
    const detail = await getTaskForSession(admin, task.id);
    const itemId = detail!.checklist[0].id;

    // ثمانية تبدليلات متوازية على **البند نفسه** من مستخدمين مختلفين:
    // كلٌّ يسلسل على قفل الصف — لا فقدان كتابةٍ ولا حالة منتصف.
    const toggles = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        mutateTaskChecklist(task.id, { op: "toggle", itemId, done: index % 2 === 0 }, index % 2 === 0 ? admin : reception)
          .then((result) => result.ok)),
    );
    expect(toggles.every(Boolean)).toBe(true);
    const rows = (await q<{ done_events: string; undone_events: string }>(
      `SELECT
         (SELECT COUNT(*)::text FROM hr_task_events WHERE task_id = $1 AND action = 'checklist' AND field = 'done') AS done_events,
         (SELECT COUNT(*)::text FROM hr_task_events WHERE task_id = $1 AND action = 'checklist' AND field = 'undone') AS undone_events`, [task.id],
    ))[0];
    // لا فقدان كتابة: 8 تبديلات = 4 أحداث done و4 undone — مهما كان ترتيب التسلسل.
    expect(rows.done_events).toBe("4");
    expect(rows.undone_events).toBe("4");

    // الحفظ فوق نسخةٍ أحدث في المهام: 409 لا كتابة صامتة.
    const stale = await updateTask(task.id, { title: "من جلسة قديمة", expectedUpdatedAt: "2000-01-01T00:00:00.000Z" }, admin);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.status).toBe(409);
  });

  it("a lost response replayed with the same client request key never duplicates creations or comments (الملحق)", async () => {
    const task = unwrap(await createTask({
      title: "منع التكرار", description: "", isPrivate: false, priority: "normal", dueAt: null, plannedFor: null, assigneeStaffId: null, clientRequestId: "replay-task-0001",
    }, admin));
    // إعادة الإرسال بنفس المفتاح: المهمة الأصلية تعود ولا نسخة ثانية.
    const replayed = await createTask({
      title: "منع التكرار", description: "", isPrivate: false, priority: "normal", dueAt: null, plannedFor: null, assigneeStaffId: null, clientRequestId: "replay-task-0001",
    }, admin);
    expect(replayed.ok).toBe(true);
    if (replayed.ok) expect(replayed.value.id).toBe(task.id);
    const taskCount = await q<{ n: string }>(`SELECT COUNT(*)::text AS n FROM hr_tasks WHERE client_request_id = 'replay-task-0001'`);
    expect(taskCount[0].n).toBe("1");

    // وتزامنُ إرسالين بنفس المفتاح: واحدٌ فقط ينشئ.
    const [first, second] = await Promise.all([
      addTaskComment(task.id, "تعليق واحد لا اثنان", admin, "replay-comment-0001"),
      addTaskComment(task.id, "تعليق واحد لا اثنان", admin, "replay-comment-0001"),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.value.id).toBe(first.value.id);
    const commentCount = await q<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM hr_task_comments WHERE task_id = $1 AND client_request_id = 'replay-comment-0001'`, [task.id],
    );
    expect(commentCount[0].n).toBe("1");

    // وقائمة التحقق بالمثل.
    const [itemA, itemB] = await Promise.all([
      mutateTaskChecklist(task.id, { op: "add", label: "بند فريد", clientRequestId: "replay-item-00001" }, admin),
      mutateTaskChecklist(task.id, { op: "add", label: "بند فريد", clientRequestId: "replay-item-00001" }, reception),
    ]);
    expect(itemA.ok).toBe(true);
    expect(itemB.ok).toBe(true);
    const itemCount = await q<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM hr_task_checklist WHERE task_id = $1 AND client_request_id = 'replay-item-00001'`, [task.id],
    );
    expect(itemCount[0].n).toBe("1");
  });

  it("concurrent checklist adds and comments never lose writes or duplicate rows", async () => {
    const directory = await listStaffDirectory();
    const guard = directory.find((entry) => entry.fullName === "حارس المركز")!;
    const task = unwrap(await createTask({
      title: "ترتيب الملفات", description: "", isPrivate: false, priority: "normal", dueAt: null, plannedFor: null, assigneeStaffId: guard.id,
    }, admin));
    const items = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        mutateTaskChecklist(task.id, { op: "add", label: `بند ${index + 1}` }, index % 2 === 0 ? admin : reception)
          .then((result) => result.ok)),
    );
    expect(items.every(Boolean)).toBe(true);
    const comments = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        addTaskComment(task.id, `تعليق ${index + 1}`, index % 2 === 0 ? admin : reception)
          .then((result) => result.ok)),
    );
    expect(comments.every(Boolean)).toBe(true);
    const rows = await q<{ items: string; comments: string }>(
      `SELECT (SELECT COUNT(*)::text FROM hr_task_checklist WHERE task_id = $1) AS items,
              (SELECT COUNT(*)::text FROM hr_task_comments WHERE task_id = $1) AS comments`, [task.id],
    );
    expect(rows[0].items).toBe("8");
    expect(rows[0].comments).toBe("6");
  });

  it("task links to a patient respect the original record's access — the doctor links only his own patient; completing mutates nothing", async () => {
    // **fixture المريض يُنشأ صراحةً هنا** — إن فشل إنشاؤه سقط الاختبار كله بدل أن
    // يمرّ فراغًا (مراجعة دوت №8: لا اختبارٍ مشروطٍ ببياناتٍ لا تُنشأ).
    const patient = await createPatient({
      fullName: "مريض مهام", phone: null, altPhone: null, gender: "unknown", birthYear: null, address: null, medicalAlert: null, note: null,
    });
    expect(Number(patient.id)).toBeGreaterThan(0);
    const exists = await q<{ id: number }>(`SELECT id FROM patients WHERE id = $1`, [patient.id]);
    expect(exists.length).toBe(1);

    // الطبيب الآخر ليس له علاقة بالمريض: الربط يُرفض — الإسناد لا يمنح وصولًا.
    const task = unwrap(await createTask({
      title: "متابعة أوراق مريض", description: "", isPrivate: false, priority: "normal", dueAt: null, plannedFor: null, assigneeStaffId: null,
    }, admin));
    const denied = await addTaskLink(task.id, "patient", patient.id, otherDoctor);
    expect(denied.ok).toBe(false);
    const allowed = await addTaskLink(task.id, "patient", patient.id, admin);
    expect(allowed.ok).toBe(true);
    if (allowed.ok) expect(allowed.value.label).toContain("مريض مهام");

    // أسند المهمة إلى ملف الطبيب الآخر ثم يقرأها:
    const otherStaff = (await q<{ id: number }>(`SELECT id FROM hr_staff WHERE user_id = $1`, [otherDoctorId]))[0];
    if (otherStaff) {
      const assignedToOther = unwrap(await createTask({
        title: "أوراق مريض آخرين", description: "", isPrivate: false, priority: "normal", dueAt: null, plannedFor: null, assigneeStaffId: otherStaff.id,
      }, admin));
      const linkedToOther = await addTaskLink(assignedToOther.id, "patient", patient.id, admin);
      expect(linkedToOther.ok).toBe(true);
      const forDoctor = await getTaskForSession(otherDoctor, assignedToOther.id);
      expect(forDoctor).not.toBeNull();
      expect(forDoctor!.links[0].readable).toBe(false);
      expect(forDoctor!.links[0].label).toBe("");
      // **وسجل الأحداث نفسه بلا اسم المريض** (مراجعة دوت №3): حدث الربط
      // الذي كتبه المدير بقيمه يُعاد للطبيب دون الوسم المحجوب عنه.
      const linkEvent = forDoctor!.events.find((event) => event.action === "link");
      expect(linkEvent).toBeDefined();
      expect(linkEvent!.newValue).toBeNull();
      expect(linkEvent!.oldValue).toBeNull();
      expect(JSON.stringify(forDoctor!.events)).not.toContain("مريض مهام");
      // والإدارة ترى التسمية كاملة في الروابط وفي الأحداث.
      const forAdmin = await getTaskForSession(admin, assignedToOther.id);
      expect(forAdmin!.links[0].readable).toBe(true);
      expect(forAdmin!.links[0].label).toContain("مريض مهام");
      expect(forAdmin!.events.find((event) => event.action === "link")!.newValue).toContain("مريض مهام");
    }

    // الإكمال لا يغيّر السجل: المريض كما هو بعد إكمال المهمة.
    await updateTask(task.id, { status: "completed" }, admin);
    const untouched = await q<{ full_name: string }>(`SELECT full_name FROM patients WHERE id = $1`, [patient.id]);
    expect(untouched[0].full_name).toBe("مريض مهام");
    // ولا صف عمولةٍ ولا حركة صندوقٍ أُنشئت.
    const commissionRows = await q<{ n: string }>(`SELECT COUNT(*)::text AS n FROM doctor_commission_history`);
    expect(Number(commissionRows[0].n)).toBe(0);
    const shiftRows = await q<{ n: string }>(`SELECT COUNT(*)::text AS n FROM cashier_shifts`);
    expect(Number(shiftRows[0].n)).toBe(0);
  });
});
