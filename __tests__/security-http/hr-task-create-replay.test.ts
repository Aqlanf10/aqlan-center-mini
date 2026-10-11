import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { harness } from "./_server";
import { openHrJourneyServer } from "./_hr-isolated-server";

// Only this suite's owned database/account copies are changed by lock-barrier cases.
let h: Awaited<ReturnType<typeof harness>>;
let browser: Browser;
let owned: Awaited<ReturnType<typeof openHrJourneyServer>>;
const body = (key: string) => ({ title: "Synthetic private HTTP canary", description: "Synthetic private HTTP detail",
  isPrivate: true, priority: "normal", dueAt: null, plannedFor: null, assigneeStaffId: null, clientRequestId: key });
async function post(cookie: string, value: unknown) {
  const response = await fetch(`${owned.baseUrl}/api/tasks`, { method: "POST",
    headers: { cookie, origin: owned.baseUrl, "content-type": "application/json" }, body: JSON.stringify(value) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
const count = async (key: string) => Number((await owned.db.query("SELECT count(*)::int AS n FROM hr_tasks WHERE client_request_id=$1", [key])).rows[0].n);
beforeAll(async () => { h = await harness(); owned = await openHrJourneyServer(h); browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined }); }, 240_000);
afterAll(async () => { try { await browser?.close(); } finally { await owned?.close(); } });

describe("real task POST: actor-bound and current-authority replay", () => {
  it("replays an identical confirmed request but uniformly rejects another actor or changed content", async () => {
    const request = body("http-task-response-loss-001");
    const committed = await post(h.sessions.doctorA.cookie, request); expect(committed.status).toBe(201);
    const replay = await post(h.sessions.doctorA.cookie, { ...request, title: ` ${request.title} ` });
    expect(replay.status).toBe(201); expect(replay.body.id).toBe(committed.body.id);
    const foreign = await post(h.sessions.admin.cookie, request);
    const changed = await post(h.sessions.doctorA.cookie, { ...request, description: "Different intent" });
    expect(foreign.status).toBe(409); expect(changed.status).toBe(409); expect(foreign.body).toEqual(changed.body);
    expect(Object.keys(foreign.body)).toEqual(["message"]);
    expect(JSON.stringify(foreign.body)).not.toContain(request.title); expect(JSON.stringify(foreign.body)).not.toContain(request.description);
    expect(await count(request.clientRequestId)).toBe(1);
    expect((await owned.db.query("SELECT count(*)::int AS n FROM hr_task_events WHERE task_id=$1", [committed.body.id])).rows[0].n).toBe(1);
    expect((await owned.db.query("SELECT count(*)::int AS n FROM audit_log WHERE action='task.create' AND entity='hr_task' AND entity_id=$1", [String(committed.body.id)])).rows[0].n).toBe(1);
  });

  it.each(["short", "x".repeat(101), 12345])("rejects malformed supplied keys instead of converting them into keyless writes", async (key) => {
    const result = await post(h.sessions.doctorA.cookie, { ...body("unused-key-001"), clientRequestId: key });
    expect(result.status).toBe(400); expect(await count("unused-key-001")).toBe(0);
  });

  for (const replay of [false, true]) for (const change of ["role", "credential", "active"] as const) {
    it(`rejects ${replay ? "replay" : "new creation"} when ${change} changes after admission but before the key lock is released`, async () => {
      const request = body(`http-task-authority-${change}-${replay}-001`);
      if (replay) expect((await post(h.sessions.doctorA.cookie, request)).status).toBe(201);
      // Resolve the actual signed fixture user via a known task, never change shared accounts.
      const marker = await post(h.sessions.doctorA.cookie, body(`http-task-marker-${change}-${replay}-001`)); expect(marker.status).toBe(201);
      const actorId = (await owned.db.query("SELECT owner_user_id FROM hr_tasks WHERE id=$1", [marker.body.id])).rows[0].owner_user_id;
      const original = (await owned.db.query("SELECT role,password_hash,is_active FROM users WHERE id=$1", [actorId])).rows[0];
      const evidenceBefore = (await owned.db.query(`SELECT
        (SELECT count(*)::int FROM hr_task_events) AS events,
        (SELECT count(*)::int FROM audit_log WHERE action='task.create') AS audits`)).rows[0];
      const blocker = await owned.db.connect(); let pending: ReturnType<typeof post> | undefined;
      try {
        await blocker.query("BEGIN"); const pid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`hr-task-create:${request.clientRequestId}`]);
        pending = post(h.sessions.doctorA.cookie, request);
        await expect.poll(async () => Number((await owned.db.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))", [pid])).rows[0].n)).toBeGreaterThan(0);
        if (change === "role") await owned.db.query("UPDATE users SET role='assistant' WHERE id=$1", [actorId]);
        else if (change === "credential") await owned.db.query("UPDATE users SET password_hash='synthetic-task-revoked' WHERE id=$1", [actorId]);
        else await owned.db.query("UPDATE users SET is_active=false WHERE id=$1", [actorId]);
        await blocker.query("COMMIT");
        const refused = await pending; expect(refused.status).toBe(403); expect(Object.keys(refused.body).sort()).toEqual(["creationRefusal", "message"]);
        expect(refused.body.creationRefusal).toEqual({ clientRequestId: request.clientRequestId, username: "secdoctora", role: "doctor", noWrite: true });
        expect(JSON.stringify(refused.body)).not.toContain(request.title); expect(JSON.stringify(refused.body)).not.toContain(request.description);
        expect(await count(request.clientRequestId)).toBe(replay ? 1 : 0);
        expect((await owned.db.query(`SELECT
          (SELECT count(*)::int FROM hr_task_events) AS events,
          (SELECT count(*)::int FROM audit_log WHERE action='task.create') AS audits`)).rows[0]).toEqual(evidenceBefore);
      } finally {
        await blocker.query("ROLLBACK"); blocker.release(); await pending;
        await owned.db.query("UPDATE users SET role=$1,password_hash=$2,is_active=$3 WHERE id=$4", [original.role, original.password_hash, original.is_active, actorId]);
      }
      // Restoration permits the original request, without changing its key or intent.
      expect((await post(h.sessions.doctorA.cookie, request)).status).toBe(201); expect(await count(request.clientRequestId)).toBe(1);
    });
  }
});


function cookieParts(raw: string) {
  const [name, ...parts] = raw.split("="); return { name, value: parts.join("=") };
}
for (const width of [390, 1280]) {
  it(`actual committed-response loss retains one owner/key/body through double click and modal reopening at ${width}px`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "ar-YE" });
    await context.addCookies([{ ...cookieParts(h.sessions.doctorA.cookie), url: owned.baseUrl }]);
    const page = await context.newPage(), title = `Synthetic retained task ${width}`;
    const sent: Record<string, unknown>[] = []; let committedId = 0;
    try {
      await page.goto(`${owned.baseUrl}/hr`, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "مهمة جديدة", exact: true }).click();
      const modal = page.getByRole("dialog", { name: "مهمة جديدة", exact: true });
      await modal.getByLabel("العنوان", { exact: true }).fill(title);
      await modal.getByLabel("الوصف", { exact: true }).fill("Synthetic immutable private detail");
      await modal.getByLabel(/مهمة خاصة/).check();
      let release!: () => void, fail!: (error: unknown) => void;
      const committed = new Promise<void>((resolve, reject) => { release = resolve; fail = reject; });
      await page.route("**/api/tasks", async route => {
        try {
          sent.push(route.request().postDataJSON());
          const response = await route.fetch(); expect(response.status()).toBe(201);
          const receipt = await response.json(); committedId = receipt.id;
          expect(receipt.creationReceipt.clientRequestId).toBe(sent[0].clientRequestId);
          // The real write and receipt exist, but the browser receives no response.
          await route.abort("connectionfailed"); release();
        } catch (error) { fail(error); await route.abort().catch(() => undefined); }
      }, { times: 1 });
      await modal.getByRole("button", { name: "إنشاء", exact: true }).dblclick(); await committed;
      await expect.poll(() => modal.getByRole("alert").count()).toBe(1);
      expect(sent).toHaveLength(1); expect(await count(String(sent[0].clientRequestId))).toBe(1);
      expect(await modal.getByLabel("العنوان", { exact: true }).isDisabled()).toBe(true);
      expect(await modal.getByLabel("الوصف", { exact: true }).isDisabled()).toBe(true);
      expect(await modal.getByLabel("الأولوية", { exact: true }).isDisabled()).toBe(true);
      expect(await modal.getByLabel(/مهمة خاصة/).isDisabled()).toBe(true);
      expect(await modal.getByRole("status").innerText()).toContain("راجع قائمة مهامك قبل إنشاء طلب جديد");
      await modal.getByRole("button", { name: "إلغاء", exact: true }).click();
      await page.getByRole("button", { name: "مهمة جديدة", exact: true }).click();
      expect(await modal.getByLabel("العنوان", { exact: true }).inputValue()).toBe(title);
      expect(await modal.getByLabel("الوصف", { exact: true }).inputValue()).toBe("Synthetic immutable private detail");
      expect(await modal.getByLabel("العنوان", { exact: true }).isDisabled()).toBe(true);
      page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/tasks") sent.push(request.postDataJSON()); });
      const replayed = page.waitForResponse(response => new URL(response.url()).pathname === "/api/tasks" && response.request().method() === "POST");
      await modal.getByRole("button", { name: "تحقق وأعد نفس الطلب", exact: true }).dblclick();
      const response = await replayed; expect(response.status()).toBe(201); expect((await response.json()).id).toBe(committedId);
      await expect.poll(() => modal.count()).toBe(0);
      expect(sent).toHaveLength(2); expect(sent[1]).toEqual(sent[0]);
      expect(await count(String(sent[0].clientRequestId))).toBe(1);
      expect((await owned.db.query("SELECT count(*)::int AS n FROM hr_task_events WHERE task_id=$1", [committedId])).rows[0].n).toBe(1);
      expect((await owned.db.query("SELECT count(*)::int AS n FROM audit_log WHERE action='task.create' AND entity='hr_task' AND entity_id=$1", [String(committedId)])).rows[0].n).toBe(1);
      // Only the explicit new-task action starts an editable new intent.
      await page.getByRole("button", { name: "مهمة جديدة", exact: true }).click();
      expect(await modal.getByLabel("العنوان", { exact: true }).inputValue()).toBe("");
      expect(await modal.getByLabel("العنوان", { exact: true }).isEnabled()).toBe(true);
      await modal.getByRole("button", { name: "إلغاء", exact: true }).click();
    } finally { await context.close(); }
  });

  it(`a foreign receipt remains pending and a changed signed owner cannot resend the retained draft at ${width}px`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "ar-YE" });
    await context.addCookies([{ ...cookieParts(h.sessions.doctorA.cookie), url: owned.baseUrl }]);
    const page = await context.newPage(), title = `Synthetic owner-fenced task ${width}`;
    let sent: Record<string, unknown> | undefined;
    try {
      await page.goto(`${owned.baseUrl}/hr`, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "مهمة جديدة", exact: true }).click();
      const modal = page.getByRole("dialog", { name: "مهمة جديدة", exact: true });
      await modal.getByLabel("العنوان", { exact: true }).fill(title); await modal.getByLabel(/مهمة خاصة/).check();
      await page.route("**/api/tasks", async route => {
        sent = route.request().postDataJSON(); const response = await route.fetch(); expect(response.status()).toBe(201);
        const receipt = await response.json();
        await route.fulfill({ response, json: { ...receipt, creationReceipt: { ...receipt.creationReceipt, clientRequestId: "synthetic-foreign-receipt" } } });
      }, { times: 1 });
      await modal.getByRole("button", { name: "إنشاء", exact: true }).click();
      await expect.poll(() => modal.getByRole("alert").innerText()).toContain("لم تصل نتيجة مطابقة");
      expect(await count(String(sent!.clientRequestId))).toBe(1);
      await context.addCookies([{ ...cookieParts(h.sessions.doctorB.cookie), url: owned.baseUrl }]);
      const refused = page.waitForResponse(response => new URL(response.url()).pathname === "/api/tasks" && response.request().method() === "POST");
      await modal.getByRole("button", { name: "تحقق وأعد نفس الطلب", exact: true }).click();
      expect((await refused).status()).toBe(403);
      expect(await modal.getByLabel("العنوان", { exact: true }).isDisabled()).toBe(true);
      expect(await count(String(sent!.clientRequestId))).toBe(1);
      await expect.poll(() => modal.getByRole("alert").innerText()).toContain("تغيّر صاحب الجلسة");
      let unsolicited = 0;
      page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/tasks") unsolicited++; });
      page.on("dialog", dialog => dialog.accept());
      const currentOwner = page.waitForResponse(response => new URL(response.url()).pathname === "/api/auth/me");
      const currentTasks = page.waitForResponse(response => new URL(response.url()).pathname === "/api/tasks" && response.request().method() === "GET");
      await page.reload({ waitUntil: "domcontentloaded" });
      expect((await (await currentOwner).json()).username).toBe("secdoctorb");
      const visible = await currentTasks; expect(visible.status()).toBe(200);
      expect(JSON.stringify(await visible.json())).not.toContain(title);
      await page.getByRole("button", { name: "مهمة جديدة", exact: true }).click();
      expect(await modal.getByLabel("العنوان", { exact: true }).inputValue()).toBe("");
      expect(await modal.getByRole("status").count()).toBe(0); expect(unsolicited).toBe(0);
      expect(await page.locator("section[aria-label='المهام']").innerText()).not.toContain(title);
      await modal.getByRole("button", { name: "إلغاء", exact: true }).click();
    } finally { await context.close(); }
  });
}

for (const width of [390, 1280]) {
  it(`a matching first no-write 400 lets the operator correct the inactive assignee and create once at ${width}px`, async () => {
    const staffResponse = await fetch(`${owned.baseUrl}/api/hr/staff`, { method: "POST",
      headers: { cookie: h.sessions.admin.cookie, origin: owned.baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ fullName: `Synthetic refusal assignee ${width}`, jobTitle: "Synthetic", department: "other",
        hireDate: null, endDate: null, workStatus: "active", contractKind: "commission", phone: null, note: null }),
    });
    expect(staffResponse.status).toBe(201); const staff = await staffResponse.json();
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "ar-YE" });
    await context.addCookies([{ ...cookieParts(h.sessions.admin.cookie), url: owned.baseUrl }]);
    const page = await context.newPage(), title = `Synthetic corrected task ${width}`;
    const sent: Record<string, unknown>[] = [];
    try {
      await page.goto(`${owned.baseUrl}/hr`, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "مهمة جديدة", exact: true }).click();
      const modal = page.getByRole("dialog", { name: "مهمة جديدة", exact: true });
      await modal.getByLabel("العنوان", { exact: true }).fill(title);
      await modal.getByLabel(/المسؤول \(من ملفات الطاقم\)/).selectOption(String(staff.id));
      await owned.db.query("UPDATE hr_staff SET work_status='suspended' WHERE id=$1", [staff.id]);
      page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/tasks") sent.push(request.postDataJSON()); });
      const refusal = page.waitForResponse(response => new URL(response.url()).pathname === "/api/tasks" && response.request().method() === "POST");
      await modal.getByRole("button", { name: "إنشاء", exact: true }).click();
      const response = await refusal; expect(response.status()).toBe(400);
      expect((await response.json()).creationRefusal).toEqual({ clientRequestId: sent[0].clientRequestId, username: "secadmin", role: "admin", noWrite: true });
      await expect.poll(() => modal.getByLabel("العنوان", { exact: true }).isEnabled()).toBe(true);
      expect(await modal.getByRole("status").count()).toBe(0); expect(await count(String(sent[0].clientRequestId))).toBe(0);
      await modal.getByLabel(/المسؤول \(من ملفات الطاقم\)/).selectOption("");
      await modal.getByLabel("العنوان", { exact: true }).fill(`${title} corrected`);
      const created = page.waitForResponse(result => new URL(result.url()).pathname === "/api/tasks" && result.request().method() === "POST");
      await modal.getByRole("button", { name: "إنشاء", exact: true }).click(); expect((await created).status()).toBe(201);
      await expect.poll(() => modal.count()).toBe(0);
      expect(sent).toHaveLength(2); expect(sent[1].clientRequestId).not.toBe(sent[0].clientRequestId);
      expect(sent[1].assigneeStaffId).toBeNull(); expect(sent[1].title).toBe(`${title} corrected`);
      expect(await count(String(sent[0].clientRequestId))).toBe(0); expect(await count(String(sent[1].clientRequestId))).toBe(1);
    } finally { await context.close(); }
  });
}
