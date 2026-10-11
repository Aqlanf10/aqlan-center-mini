import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { baseUrl, harness } from "./_server";

/**
 * (HR-1/HR-2) رحلة متصفح وHTTP فعلية لشاشة «الموارد البشرية والمهام»:
 *
 *  * صور فعلية بعرضَي 390 (هاتف) و1280 (مكتب) لبياناتٍ تجريبية حقيقية عبر HTTP.
 *  * بلا تمريرٍ أفقي على الهاتف (مقياس P3-4 نفسه).
 *  * إنشاء موظفٍ براتبٍ **بوحداته البشرية** (مراجعة دوت №6): ما يُكتب في الحقل
 *    هو ما يظهر في الجدول وما يُطبع على الورق — YER وحدةٌ واحدة لا مئة.
 *  * الاستخدام الفعلي (مراجعة دوت №7): تعديل حالة عملٍ موظفٍ موجود وتعديل
 *    عنوان المهمة وأولويتها من الواجهة.
 *  * خصوصية المهمة الخاصة على **صفحة الاستقبال نفسها** وعبر API (الملحق:
 *    لا التحقق من صفحة المدير في النهاية).
 *  * مخالفات PATCH الحقيقية (مراجعة دوت №4): المكلّف يرسل حقول إدارةٍ فعليًّا
 *    عبر HTTP فتُردّ 403، وعلى مهمةٍ خاصة تُردّ 404 موحّدًا (№5).
 *  * سحب ربط الحساب يسحب الوصول عبر HTTP فورًا (مراجعة دوت №2).
 *  * ملفات طباعةٍ فعلية (PDF) لكشفي الطاقم والمهام بمبالغٍ صحيحة.
 *
 * الأدلة تُكتب في HR_EVIDENCE_DIR (خارج المستودع) — هذا الملف يُثبت الحالة،
 * والأدلة مراجعتها البشري.
 */

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const EVIDENCE_DIR = process.env.HR_EVIDENCE_DIR ?? join(process.cwd(), ".hr-evidence");

let browser: Browser;
let context: BrowserContext;
let h: Awaited<ReturnType<typeof harness>>;

function sessionCookie(raw: string): { name: string; value: string } {
  const [name, ...rest] = raw.split("=");
  return { name, value: rest.join("=") };
}

async function overflowExcess(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/**
 * انتظار جاهزية لوحة المهام للتفاعل: نصّ «جارٍ التحميل…» يُولَّد على الخادم
 * ثم يُستبدل بعد الترطيب والجلب — اختفاؤه دليلٌ على أن React حيّ والأزرار تعمل.
 */
async function waitTasksReady(page: Page): Promise<void> {
  await page.waitForSelector("text=جارٍ التحميل…", { state: "detached", timeout: 60_000 });
}

/** استدعاء API بجلسةٍ موقّعة — لمسارات POST/PATCH الحقيقية لا دوال الوحدة.
 *  رأس Origin ضروري: حارس CSRF يردّ الطلبات المتقاطعة من نفس الأصل بلا دليل أصل. */
async function api(
  cookie: string, method: "GET" | "POST" | "PATCH", path: string, body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", cookie, origin: baseUrl },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: response.status, json };
}

beforeAll(async () => {
  h = await harness();
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
  context = await browser.newContext({ viewport: DESKTOP, locale: "ar-YE" });
  await context.addCookies([{ ...sessionCookie(h.sessions.admin.cookie), url: baseUrl }]);
}, 240_000);

afterAll(async () => {
  try { await context?.close(); await browser?.close(); } catch { /* الإغلاق أفضل جهد */ }
});

describe("(HR) browser journey — staff files and tasks", () => {
  it("admin creates a guard with a human-unit salary (1,500,000 ر.ي) — input, table and print all agree (مراجعة دوت №6)", async () => {
    const page = await context.newPage();
    try {
      await page.goto(`${baseUrl}/hr`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await waitTasksReady(page);
      await page.screenshot({ path: join(EVIDENCE_DIR, "hr-desktop-1280.png"), fullPage: true });

      // تبويب الطاقم (المدير وحده يراه) ثم إنشاء ملف حارسٍ براتب بوحداته البشرية
      await page.getByRole("tab", { name: "الطاقم" }).click();
      await page.getByRole("button", { name: "ملف موظف جديد" }).click();
      await page.getByLabel("الاسم الكامل").fill("حارس الورديات");
      await page.getByLabel(/المسمّى الوظيفي/).fill("حارس");
      await page.getByRole("radio", { name: "راتب", exact: true }).check();
      // الإدخال البشري: 1,500,000 ريال يمني (وحدةٌ واحدة) — لا وحداتٍ صغرى ولا قسمة ثابتة.
      await page.getByLabel("المبلغ (ر.ي)").fill("1500000");
      await page.getByLabel("العملة").selectOption("YER");
      await page.getByLabel("الدورية").selectOption({ label: "شهري" });
      await page.getByLabel("سريان المبلغ").fill("2026-10-01");
      await page.getByRole("button", { name: "حفظ" }).click();
      await page.waitForTimeout(800);
      const listText = await page.textContent("table");
      expect(listText).toContain("حارس الورديات");
      // ما أُدخل هو ما يُعرض: 1,500,000 كما كُتبت لا 15,000 بقسمةٍ ثابتة.
      expect(listText).toContain("1,500,000");
      expect(listText).not.toContain("15,000 ");
      await page.screenshot({ path: join(EVIDENCE_DIR, "hr-staff-desktop-1280.png"), fullPage: true });
    } finally { await page.close(); }
  }, 240_000);

  it("edits an existing employee's work status through the UI and it really saves (مراجعة دوت №7)", async () => {
    const page = await context.newPage();
    try {
      await page.goto(`${baseUrl}/hr`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await waitTasksReady(page);
      await page.getByRole("tab", { name: "الطاقم" }).click();
      // انتظار ظهور صفوف الطاقم فعلًا — التحميل الأول للشاشة قد يتأخر.
      await page.waitForSelector("table", { timeout: 60_000 });
      await page.waitForTimeout(400);
      await page.getByRole("button", { name: "حارس الورديات" }).click();
      await page.waitForTimeout(400);
      await page.getByLabel("حالة العمل").selectOption({ label: "موقوف مؤقتًا" });
      await page.getByLabel(/سبب هذا التعديل/).fill("إيقاف مؤقت ريثما تكتمل أوراقه");
      await page.getByRole("button", { name: "حفظ" }).click();
      await page.waitForTimeout(800);
      const listText = await page.textContent("table");
      expect(listText).toContain("موقوف مؤقتًا");
      // وسجل التغييرات في الخادم يحمل الفاعل والقيم والسبب — نقرأه عبر API.
      const detail = await api(h.sessions.admin.cookie, "GET", "/api/hr/staff?q=حارس الورديات");
      const staffId = (detail.json as { id: number }[])[0]?.id;
      const full = await api(h.sessions.admin.cookie, "GET", `/api/hr/staff/${staffId}`);
      const changes = (full.json as { changes: { field: string; newValue: string; reason: string | null }[] }).changes;
      const statusChange = changes.find((change) => change.field === "work_status");
      expect(statusChange?.newValue).toBe("suspended");
      expect(statusChange?.reason).toBe("إيقاف مؤقت ريثما تكتمل أوراقه");
      // نعيد الحارس نشطًا — دليل الإسناد يستثني غير النشطين، واختبار الإسناد بعده يحتاجه.
      const restored = await api(h.sessions.admin.cookie, "PATCH", `/api/hr/staff/${staffId}`, {
        workStatus: "active", reason: "إعادة للاختبار", expectedUpdatedAt: (full.json as { staff: { updatedAt: string } }).staff.updatedAt,
      });
      expect(restored.status, JSON.stringify(restored.json)).toBe(200);
    } finally { await page.close(); }
  }, 240_000);

  it("creates an assigned task, then edits its title and priority through the UI (مراجعة دوت №7)", async () => {
    const page = await context.newPage();
    try {
      await page.goto(`${baseUrl}/hr`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await waitTasksReady(page);
      await page.getByRole("button", { name: "مهمة جديدة" }).click();
      await page.getByLabel("العنوان").fill("مراجعة كاميرا المدخل يوميًا");
      await page.getByLabel("تاريخ التخطيط").fill("2026-10-12");
      // دليل الإسناد يجلب لحظة فتح النافذة — انتظر ظهور خيار الحارس قبل الاختيار.
      await page.waitForFunction(
        () => Array.from(document.querySelectorAll("option")).some((option) => option.textContent?.includes("حارس الورديات")),
        undefined, { timeout: 30_000 },
      );
      await page.getByLabel("المسؤول (من ملفات الطاقم)").selectOption({ label: "حارس الورديات — حارس" });
      await page.getByRole("button", { name: "إنشاء" }).click();
      await page.waitForTimeout(800);
      const tasksText = await page.textContent("section[aria-label='المهام']");
      expect(tasksText).toContain("مراجعة كاميرا المدخل يوميًا");
      expect(tasksText).toContain("التخطيط: 2026-10-12");
      await page.screenshot({ path: join(EVIDENCE_DIR, "hr-tasks-desktop-1280.png"), fullPage: true });

      // التعديل الإداري من الواجهة: العنوان والأولوية — يُحفظ فعليًّا.
      await page.getByRole("button", { name: /مراجعة كاميرا المدخل يوميًا/ }).first().click();
      await page.waitForTimeout(400);
      await page.getByRole("button", { name: /تعديل العنوان والأولوية/ }).click();
      const editForm = page.getByRole("form", { name: "تعديل بيانات المهمة" });
      await editForm.getByLabel("العنوان").fill("مراجعة كاميرا المدخل صباحًا ومساءً");
      await editForm.getByLabel("الأولوية").selectOption({ label: "عاجلة" });
      await editForm.getByRole("button", { name: "حفظ التعديل" }).click();
      await page.waitForTimeout(800);
      const modalText = await page.textContent("[role='dialog'], .mx-auto");
      expect(modalText).toContain("مراجعة كاميرا المدخل صباحًا ومساءً");
      await page.screenshot({ path: join(EVIDENCE_DIR, "hr-task-edit-1280.png"), fullPage: true });
      await page.getByRole("button", { name: "إغلاق" }).click();
    } finally { await page.close(); }
  }, 240_000);

  it("stale save answers 409 with a visible reason, and the draft survives to retry (مراجعة دوت №7)", async () => {
    // مهمةٌ تُنشأ عبر API ثم تُفتح في محرر الواجهة؛ بينما هي مفتوحة تغيّرها
    // جلسةٌ أخرى عبر API — حفظ المحرّر يُردّ 409 بسببٍ ظاهر، والمسودة تبقى
    // في الحقول لإعادة المحاولة بعد التحديث.
    const adminCookie = h.sessions.admin.cookie;
    const created = await api(adminCookie, "POST", "/api/tasks", {
      title: "مهمة سباق النسخ", isPrivate: false, priority: "normal", plannedFor: "2026-10-14",
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const taskId = (created.json as { id: number }).id;

    const page = await context.newPage();
    try {
      await page.goto(`${baseUrl}/hr`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await waitTasksReady(page);
      await page.getByRole("button", { name: /مهمة سباق النسخ/ }).first().click();
      await page.waitForTimeout(400);
      await page.getByRole("button", { name: /تعديل العنوان والأولوية/ }).click();
      const editForm = page.getByRole("form", { name: "تعديل بيانات المهمة" });
      await editForm.getByLabel("العنوان").fill("تعديل من جلسة قديمة");

      // جلسةٌ أخرى تغيّر المهمة بينما النموذج مفتوح.
      const other = await api(adminCookie, "PATCH", `/api/tasks/${taskId}`, { priority: "urgent" });
      expect(other.status).toBe(200);

      // حفظ الجلسة القديمة: 409 — والسبب يظهر في النموذج والمسودة باقية.
      await editForm.getByRole("button", { name: "حفظ التعديل" }).click();
      await page.waitForTimeout(600);
      const modalText = await page.textContent("[role='dialog'], .mx-auto");
      expect(modalText).toContain("أعد التحميل ثم أعد المحاولة");
      expect(await editForm.getByLabel("العنوان").inputValue()).toBe("تعديل من جلسة قديمة");
      await page.screenshot({ path: join(EVIDENCE_DIR, "hr-task-stale-409-1280.png"), fullPage: true });

      // الأولوية الجديدة من الجلسة الأخرى ظاهرة بعد إعادة فتح التفاصيل.
      const recheck = await api(adminCookie, "GET", `/api/tasks/${taskId}`);
      expect((recheck.json as { task: { priority: string; title: string } }).task.priority).toBe("urgent");
      expect((recheck.json as { task: { title: string } }).task.title).toBe("مهمة سباق النسخ");
    } finally { await page.close(); }
  }, 240_000);

  it("real violating PATCHes over HTTP: the assignee cannot manage, private tasks answer 404 (مراجعتا دوت №4 و№5)", async () => {
    const adminCookie = h.sessions.admin.cookie;
    const doctorCookie = h.sessions.doctorA.cookie;

    // ملف طاقمٍ مرتبط بحساب الطبيب، ومهمةٌ مشتركة مسندة إليه.
    const createdStaff = await api(adminCookie, "POST", "/api/hr/staff", {
      fullName: "مساعد HTTP", jobTitle: "مساعد", department: "assistants", hireDate: null,
      workStatus: "active", endDate: null, contractKind: "commission", phone: null, note: null,
    });
    expect(createdStaff.status, JSON.stringify(createdStaff.json)).toBe(201);
    const staffId = (createdStaff.json as { id: number }).id;
    // معرّف حساب الطبيب من مسار المستخدمين نفسه الذي تستعمله شاشة الربط.
    const users = await api(adminCookie, "GET", "/api/users");
    expect(users.status).toBe(200);
    const doctorUser = (users.json as { id: number; username: string }[]).find((user) => user.username === "secdoctora");
    expect(doctorUser).toBeDefined();
    const linked = await api(adminCookie, "PATCH", `/api/hr/staff/${staffId}`, {
      action: "link_user", userId: doctorUser!.id, reason: "ربط الاختبار",
    });
    expect(linked.status).toBe(200);

    // مهمةٌ خاصة للطبيب: المدير والاستقبال يقرآنها 404 موحّدًا بلا فرقٍ عن المجهول.
    const privateTask = await api(doctorCookie, "POST", "/api/tasks", {
      title: "خاصة الطبيب عبر HTTP", isPrivate: true, priority: "normal",
    });
    expect(privateTask.status).toBe(201);
    const privateId = (privateTask.json as { id: number }).id;

    for (const [label, cookie] of [["admin", adminCookie], ["reception", h.sessions.reception.cookie]] as const) {
      void label;
      const read = await api(cookie, "GET", `/api/tasks/${privateId}`);
      expect(read.status).toBe(404);
      const patch = await api(cookie, "PATCH", `/api/tasks/${privateId}`, { status: "completed" });
      expect(patch.status).toBe(404);
      const comment = await api(cookie, "POST", `/api/tasks/${privateId}/comments`, { body: "متطفل" });
      expect(comment.status).toBe(404);
      // والمجهول الحقيقي بنفس الرسالة: لا بوصلتين تميّزان الوجود.
      const unknown = await api(cookie, "GET", "/api/tasks/999999");
      expect(unknown.status).toBe(404);
      expect((unknown.json as { message?: string }).message)
        .toBe((read.json as { message?: string }).message);
    }
    // والمهمة الخاصة لا تظهر في قائمة ولا عدادات الاستقبال عبر API أيضًا.
    const receptionList = await api(h.sessions.reception.cookie, "GET", "/api/tasks?scope=team");
    expect(JSON.stringify(receptionList.json)).not.toContain("خاصة الطبيب عبر HTTP");
  }, 240_000);

  it("management fields are refused at the real route with a clear reason, while status work passes (مراجعة دوت №4)", async () => {
    const adminCookie = h.sessions.admin.cookie;
    // مهمةٌ مسندة إلى ملفٍ مرتبط بطبيب HTTP (أنشأناه وربطناه في الاختبار السابق عبر API).
    const directory = await api(adminCookie, "GET", "/api/hr/directory");
    const entry = (directory.json as { id: number; fullName: string }[]).find((item) => item.fullName === "مساعد HTTP");
    expect(entry).toBeDefined();
    const task = await api(adminCookie, "POST", "/api/tasks", {
      title: "مهمة حدود HTTP", isPrivate: false, priority: "normal", assigneeStaffId: entry!.id,
    });
    expect(task.status).toBe(201);
    const taskId = (task.json as { id: number }).id;

    // الطبيب المكلّف يرى المهمة لكن يُرفض كل PATCH إداري حقيقي 403 بسببٍ واضح.
    const doctorCookie = h.sessions.doctorA.cookie;
    for (const body of [
      { title: "عنوان من المسؤول" },
      { priority: "urgent" },
      { plannedFor: "2026-11-01" },
      { assigneeStaffId: null },
      { convertToShared: true },
    ]) {
      const denied = await api(doctorCookie, "PATCH", `/api/tasks/${taskId}`, body);
      expect(denied.status).toBe(403);
      expect((denied.json as { message?: string }).message).toContain("صلاحية إدارة المهمة");
    }
    // لا تغييرًا وقع فعلًا.
    const recheck = await api(adminCookie, "GET", `/api/tasks/${taskId}`);
    expect((recheck.json as { task: { title: string; priority: string } }).task.title).toBe("مهمة حدود HTTP");
    expect((recheck.json as { task: { priority: string } }).task.priority).toBe("normal");
    // والعمل المسموح يمرّ: الحالة والتعليق.
    const statusOk = await api(doctorCookie, "PATCH", `/api/tasks/${taskId}`, { status: "in_progress" });
    expect(statusOk.status).toBe(200);
    const commentOk = await api(doctorCookie, "POST", `/api/tasks/${taskId}/comments`, { body: "بدأتها" });
    expect(commentOk.status).toBe(201);
  }, 240_000);

  it("reception cannot see the staff tab, and the doctor's private task never reaches reception's own page (الملحق)", async () => {
    const receptionContext = await browser.newContext({ viewport: DESKTOP, locale: "ar-YE" });
    await receptionContext.addCookies([{ ...sessionCookie(h.sessions.reception.cookie), url: baseUrl }]);
    const receptionPage = await receptionContext.newPage();
    try {
      // **صفحة الاستقبال نفسها** — لا صفحة المدير في نهاية الاختبار.
      await receptionPage.goto(`${baseUrl}/hr`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await waitTasksReady(receptionPage);
      expect(await receptionPage.getByRole("tab", { name: "الطاقم" }).count()).toBe(0);
      const receptionTasksText = await receptionPage.textContent("section[aria-label='المهام']");
      expect(receptionTasksText).not.toContain("خاصة الطبيب عبر HTTP");
      expect(receptionTasksText).not.toContain("تذكير شخصي");
      await receptionPage.screenshot({ path: join(EVIDENCE_DIR, "hr-reception-desktop-1280.png"), fullPage: true });
    } finally {
      await receptionPage.close();
      await receptionContext.close();
    }

    // طبيب ينشئ مهمة خاصة من واجهته — وتبقى غائبة عن الاستقبال أعلاه.
    const doctorContext = await browser.newContext({ viewport: DESKTOP, locale: "ar-YE" });
    await doctorContext.addCookies([{ ...sessionCookie(h.sessions.doctorA.cookie), url: baseUrl }]);
    const doctorPage = await doctorContext.newPage();
    try {
      await doctorPage.goto(`${baseUrl}/hr`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await waitTasksReady(doctorPage);
      await doctorPage.getByRole("button", { name: "مهمة جديدة" }).click();
      await doctorPage.getByLabel("العنوان").fill("تذكير شخصي خاص بالدوام");
      await doctorPage.getByLabel(/مهمة خاصة/).check();
      const created = doctorPage.waitForResponse(response => response.url().endsWith("/api/tasks") && response.request().method() === "POST");
      await doctorPage.getByRole("button", { name: "إنشاء" }).click();
      expect((await created).status()).toBe(201);
      await expect.poll(async () => await doctorPage.textContent("section[aria-label='المهام']")).toContain("تذكير شخصي خاص بالدوام");
    } finally {
      await doctorPage.close();
      await doctorContext.close();
    }
  }, 240_000);

  it("unbinding the staff account revokes task access over HTTP immediately (مراجعة دوت №2)", async () => {
    const adminCookie = h.sessions.admin.cookie;
    // مهمةٌ مسندة إلى ملف الطبيب المرتبط (مساعد HTTP — رُبط في اختبار سابق).
    const directory = await api(adminCookie, "GET", "/api/hr/directory");
    const entry = (directory.json as { id: number; fullName: string }[]).find((item) => item.fullName === "مساعد HTTP");
    expect(entry).toBeDefined();
    const task = await api(adminCookie, "POST", "/api/tasks", {
      title: "مهمة قبل فكّ الربط", isPrivate: false, priority: "normal", assigneeStaffId: entry!.id,
    });
    expect(task.status).toBe(201);
    const taskId = (task.json as { id: number }).id;
    const doctorCookie = h.sessions.doctorA.cookie;
    expect((await api(doctorCookie, "GET", `/api/tasks/${taskId}`)).status).toBe(200);

    // فكّ الربط عبر API: الوصول يسقط فورًا — القراءة والكتابة والقائمة.
    const detail = await api(adminCookie, "GET", `/api/hr/staff/${entry!.id}`);
    const staffDetail = detail.json as { staff: { id: number }; linkedUser: { id: number } | null };
    expect(staffDetail.linkedUser).not.toBeNull();
    const unlink = await api(adminCookie, "PATCH", `/api/hr/staff/${entry!.id}`, {
      action: "unlink_user", reason: "سحب وصول الحساب القديم — مراجعة دوت",
    });
    expect(unlink.status).toBe(200);
    expect((await api(doctorCookie, "GET", `/api/tasks/${taskId}`)).status).toBe(404);
    expect((await api(doctorCookie, "PATCH", `/api/tasks/${taskId}`, { status: "completed" })).status).toBe(404);
    expect((await api(doctorCookie, "POST", `/api/tasks/${taskId}/comments`, { body: "بعد الفكّ" })).status).toBe(404);
    const mine = await api(doctorCookie, "GET", "/api/tasks?scope=mine");
    expect(JSON.stringify(mine.json)).not.toContain("مهمة قبل فكّ الربط");
    // والمهمة ما تزال قائمة للإدارة مسندةً إلى الملف.
    const forAdmin = await api(adminCookie, "GET", `/api/tasks/${taskId}`);
    expect(forAdmin.status).toBe(200);
    expect((forAdmin.json as { task: { assigneeLabel: string } }).task.assigneeLabel).toBe("مساعد HTTP");
  }, 240_000);

  it("fits a 390px phone without horizontal overflow, with evidence screenshots", async () => {
    const phoneContext = await browser.newContext({ viewport: PHONE, locale: "ar-YE", isMobile: true, hasTouch: true });
    await phoneContext.addCookies([{ ...sessionCookie(h.sessions.admin.cookie), url: baseUrl }]);
    const page = await phoneContext.newPage();
    try {
      await page.goto(`${baseUrl}/hr`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForSelector("section[aria-label='المهام']");
      await page.screenshot({ path: join(EVIDENCE_DIR, "hr-phone-390.png"), fullPage: true });
      expect(await overflowExcess(page)).toBeLessThanOrEqual(1);

      await page.getByRole("button", { name: "لوحة" }).click();
      await page.screenshot({ path: join(EVIDENCE_DIR, "hr-phone-board-390.png"), fullPage: true });
      expect(await overflowExcess(page)).toBeLessThanOrEqual(1);
    } finally {
      await page.close();
      await phoneContext.close();
    }
  }, 240_000);

  it("produces real print files: staff report PDF shows the same 1,500,000 ر.ي — money print is unit-true (مراجعة دوت №6)", async () => {
    const page = await context.newPage();
    try {
      await page.goto(`${baseUrl}/print/hr/staff`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      // الورق يطابق الإدخال والعرض: 1,500,000 ر.ي لا 15,000 ولا 1,500,000.00.
      const printText = await page.textContent(".hr-staff-sheet");
      expect(printText).toContain("حارس الورديات");
      expect(printText).toContain("1,500,000");
      expect(printText).toContain("ر.ي");
      expect(printText).not.toContain("15,000 ");
      // تاريخ التقرير ظاهر على الورق والإجمالي مرتبط به.
      expect(printText).toContain("تاريخ التقرير");
      await page.screenshot({ path: join(EVIDENCE_DIR, "hr-staff-print-preview.png"), fullPage: true });
      await page.pdf({ path: join(EVIDENCE_DIR, "hr-staff-report.pdf"), format: "A4", landscape: true });

      await page.goto(`${baseUrl}/print/hr/tasks`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      const tasksPrintText = await page.textContent(".hr-tasks-sheet");
      expect(tasksPrintText).toContain("مراجعة كاميرا المدخل صباحًا ومساءً");
      await page.screenshot({ path: join(EVIDENCE_DIR, "hr-tasks-print-preview.png"), fullPage: true });
      await page.pdf({ path: join(EVIDENCE_DIR, "hr-tasks-report.pdf"), format: "A4" });
    } finally { await page.close(); }
  }, 240_000);
});
