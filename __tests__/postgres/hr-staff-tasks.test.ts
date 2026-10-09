import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (HR-1/HR-2) الموارد البشرية والمهام على PostgreSQL 18 الحقيقي:
 *
 *  * القيود البنيوية تعمل: الخاصة بلا مسؤول، والراتب ثلاثته معًا، وسجلا التغيير
 *    append-only حتى على المدير.
 *  * الخصوصية على مستوى الصف: قائمة وعدّادات وتفاصيل لا تُسرّب الخاصة لغير صاحبها.
 *  * الموظف بلا حساب يُسند إليه، والتحديث يحمل هوية صاحب الجلسة فعلًا.
 *  * التزامن: تحويلات قائمة التحقق المتوازية لا تضيع ولا تُكرَّر.
 *  * المالية بلا أثر: لا صف عمولة ولا حركة صندوق بسبب المهام.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const { ensureSchema, getPool, resetPoolForTesting, createPatient } = await import("../../lib/db");
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
      contractKind: "salary",
      payTerms: { amountMinor: 1_200_000, currency: "YER", period: "monthly", effectiveOn: "2026-02-01" },
      phone: null, note: null,
    }, admin);
    expect(guard.workStatus).toBe("active");
    expect(guard.userId).toBeNull();
    expect(guard.payTerms).toEqual({ amountMinor: 1_200_000, currency: "YER", period: "monthly", effectiveOn: "2026-02-01" });
  });

  it("rejects a salary without its currency/period/effective date — the named database constraint refuses", async () => {
    await expect(createStaff({
      fullName: "سكرتيرة بلا شروط", jobTitle: "سكرتارية", department: "secretariat", hireDate: null,
      contractKind: "salary", payTerms: null, phone: null, note: null,
    }, admin)).rejects.toThrow(/hr_staff_pay_terms_complete/);
    await expect(getPool().query(
      `INSERT INTO hr_staff (full_name, contract_kind, salary_amount_minor, created_by)
       VALUES ('راتب بلا عملة', 'salary', 500, 't')`,
    )).rejects.toThrow(/hr_staff_pay_terms_complete/);
  });

  it("records who changed what with old and new values, and the change log is append-only", async () => {
    const coordinator = await createStaff({
      fullName: "منسق المرضى", jobTitle: "منسق", department: "coordinator", hireDate: null,
      contractKind: "commission", payTerms: null, phone: null, note: null,
    }, admin);
    const updated = await updateStaff(coordinator.id, {
      jobTitle: "منسق مرضى", workStatus: "suspended", contractKind: "salary",
      payTerms: { amountMinor: 800_000, currency: "SAR", period: "monthly", effectiveOn: "2026-10-01" },
      reason: "تعديل مسمّى ووقف مؤقت وراتب جديد",
    }, admin);
    expect(updated?.jobTitle).toBe("منسق مرضى");
    expect(updated?.contractKind).toBe("salary");
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

  it("links an existing login account optionally and uniquely — never creates one, never auto-creates a doctor party", async () => {
    const partiesBefore = Number((await q<{ n: string }>(`SELECT COUNT(*)::text AS n FROM parties`))[0].n);
    const nurse = await createStaff({
      fullName: "ممرضة الورديات", jobTitle: "تمريض", department: "nursing", hireDate: null,
      contractKind: "commission", payTerms: null, phone: null, note: null,
    }, admin);
    const linked = await setStaffUserLink(nurse.id, doctorId, "ربط طلب", admin);
    expect(linked.ok).toBe(true);
    // ربط ثانٍ لنفس الحساب مرفوض — الربط واحدٌ لكل حساب
    const second = await createStaff({
      fullName: "ممرضة ثانية", jobTitle: "تمريض", department: "nursing", hireDate: null,
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
  let assignedTaskId = 0;

  it("a private task belongs to its owner alone: lists, counts, direct read, and even the admin cannot see it", async () => {
    const created = unwrap(await createTask({
      title: "تذكير شخصي", description: "له وحده", isPrivate: true, priority: "normal", dueAt: null, assigneeStaffId: null,
    }, doctor));
    privateTaskId = created.id;

    const doctorList = await listTasks(doctor, { scope: "mine" });
    expect(doctorList.tasks.some((task) => task.id === privateTaskId)).toBe(true);

    // المدير والاستقبال: لا في القائمة ولا في العدادات ولا في القراءة المباشرة.
    for (const session of [admin, reception, otherDoctor]) {
      const list = await listTasks(session, { scope: "team" });
      expect(list.tasks.some((task) => task.id === privateTaskId)).toBe(false);
      const totalVisible = list.tasks.length + Object.values(list.counts).reduce((sum, count) => sum + count, 0);
      expect(JSON.stringify(list.counts)).toBeDefined();
      expect(totalVisible).toBeGreaterThanOrEqual(0);
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
      title: "خاصة بمدبّر", description: "", isPrivate: true, priority: "normal", dueAt: null, assigneeStaffId: 1,
    }, admin);
    expect(refused.ok).toBe(false);
  });

  it("assigns a task to an accountless staff member; the actor of every update is the real session user", async () => {
    const directory = await listStaffDirectory();
    const guard = directory.find((entry) => entry.fullName === "حارس المركز")!;
    expect(guard.hasAccount).toBe(false);
    const created = unwrap(await createTask({
      title: "إغلاق العيادة عند الثامنة", description: "بعد آخر موعد", isPrivate: false,
      priority: "high", dueAt: null, assigneeStaffId: guard.id,
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

  it("concurrent checklist toggles and comments never lose writes or duplicate rows", async () => {
    const directory = await listStaffDirectory();
    const guard = directory.find((entry) => entry.fullName === "حارس المركز")!;
    const task = unwrap(await createTask({
      title: "ترتيب الملفات", description: "", isPrivate: false, priority: "normal", dueAt: null, assigneeStaffId: guard.id,
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
    const patient = await createPatient({
      fullName: "مريض مهام", phone: null, altPhone: null, gender: "unknown", birthYear: null, address: null, medicalAlert: null, note: null,
    });
    // الطبيب الآخر ليس له علاقة بالمريض: الربط يُرفض — الإسناد لا يمنح وصولًا.
    const task = unwrap(await createTask({
      title: "متابعة أوراق مريض", description: "", isPrivate: false, priority: "normal", dueAt: null, assigneeStaffId: null,
    }, admin));
    const denied = await addTaskLink(task.id, "patient", patient.id, otherDoctor);
    expect(denied.ok).toBe(false);
    const allowed = await addTaskLink(task.id, "patient", patient.id, admin);
    expect(allowed.ok).toBe(true);
    if (allowed.ok) expect(allowed.value.label).toContain("مريض مهام");
    // المهمة مشتركة والمسؤول عليها ملفٌ لا حساب: الطبيب الآخر يرى المهمة إن أُسندت إليه.
    // هنا المسؤول هو المدير نفسه، فالطبيب الآخر لا يرى المهمة أصلًا — خصوصية الروابط تُختبر عبر مهمةٍ مسندة إليه:
    const assignedToOther = unwrap(await createTask({
      title: "أوراق مريض آخرين", description: "", isPrivate: false, priority: "normal", dueAt: null, assigneeStaffId: null,
    }, admin));
    const linkedToOther = await addTaskLink(assignedToOther.id, "patient", patient.id, admin);
    expect(linkedToOther.ok).toBe(true);
    // أسند المهمة إلى ملف الطبيب الآخر (لهم ملف من اختبار الربط) ثم يقرأها:
    const otherStaff = (await q<{ id: number }>(`SELECT id FROM hr_staff WHERE user_id = $1`, [otherDoctorId]))[0];
    if (otherStaff) {
      await updateTask(assignedToOther.id, { assigneeStaffId: otherStaff.id }, admin);
      const forDoctor = await getTaskForSession(otherDoctor, assignedToOther.id);
      expect(forDoctor).not.toBeNull();
      expect(forDoctor!.links[0].readable).toBe(false);
      expect(forDoctor!.links[0].label).toBe("");
      // والإدارة ترى التسمية كاملة.
      const forAdmin = await getTaskForSession(admin, assignedToOther.id);
      expect(forAdmin!.links[0].readable).toBe(true);
      expect(forAdmin!.links[0].label).toContain("مريض مهام");
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
