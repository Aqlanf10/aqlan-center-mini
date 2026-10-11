import { afterAll, beforeAll, describe, expect, it, onTestFailed } from "vitest";
import { chromium, type Browser, type Page, type Locator } from "playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
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



// Additive synthetic failure evidence only. No assertion, test deadline or input
// action is changed; ordinary full CI does not enable this diagnostic collector.
async function taskFailureEvidence(page: Page, id: string) {
  const output = process.env.HR_UI_DIAGNOSTIC_DIR;
  if (!output) return { at:(_next:string)=>{ void _next; }, failed:async()=>undefined };
  const bounded = async <T,>(work:Promise<T>,ms:number):Promise<T> => {
    let timer:ReturnType<typeof setTimeout>|undefined;
    try { return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("Diagnostic observation timeout")),ms);})]); }
    finally { if(timer)clearTimeout(timer); }
  };
  let phase = "created", finished = false, capture: Promise<void> | undefined;
  const events: Record<string, unknown>[] = [];
  let retained: Record<string, unknown> = {};
  const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
  const sourceSha256 = sha(readFileSync(join(process.cwd(), "__tests__/security-http/hr-task-create-replay.test.ts")));
  const persist = (extra: Record<string, unknown> = {}) => {
    if (!output) return;
    retained = { ...retained, ...extra };
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, `${id}.json`), JSON.stringify({ format: "hr-ui-failure-diagnostic-v1", acceptance: false,
      syntheticOnly: true, id, phase, sourceSha256, runId: process.env.GITHUB_RUN_ID ?? null,
      checkout: process.env.GITHUB_SHA ?? null, finished, events, ...retained }, null, 2));
  };
  const record = (event: Record<string, unknown>) => { if (finished) return; if (events.length < 80) events.push(event); persist(); };
  const ownedPath = (raw: string) => { const url = new URL(raw); return url.origin === owned.baseUrl
    && ["/api/auth/me", "/api/tasks", "/api/hr/directory"].includes(url.pathname) ? url.pathname : null; };
  if (output) {
    page.on("request", request => {
      const path = ownedPath(request.url()); if (!path) return;
      let body: Record<string, unknown> | null = null;
      try { body = request.method() === "POST" ? request.postDataJSON() : null; } catch { /* shape only */ }
      record({ kind: "request", path, method: request.method(), hasBody: !!body,
        keySha256: typeof body?.clientRequestId === "string" ? sha(body.clientRequestId) : null,
        private: body?.isPrivate === true, syntheticTitle: typeof body?.title === "string" && body.title.startsWith("Synthetic "),
        hasExpectedOwner: !!body?.expectedOwner });
    });
    page.on("response", response => { const path = ownedPath(response.url()); if (path) record({ kind: "response", path,
      method: response.request().method(), status: response.status() }); });
    page.on("requestfailed", request => { const path = ownedPath(request.url()); if (path) record({ kind: "requestfailed", path,
      method: request.method() }); });
    page.on("pageerror", error => record({ kind: "pageerror", name: error.name, messageSha256: sha(error.message) }));
    // Passive CDP observation leaves Playwright's normal dialog handling intact.
    try {
    const cdp = await bounded(page.context().newCDPSession(page),1500);
    cdp.on("Page.javascriptDialogOpening", event => record({ kind:"dialog", type:event.type,
      message:event.message.replace(/[\u0000-\u001f]/g," ").slice(0,400) }));
    await bounded(cdp.send("Page.enable"),1500);
    } catch (error) { record({kind:"dialog-observer-unavailable",name:error instanceof Error?error.name:"unknown"}); }
  }
  const finish = () => {
    if (capture) return capture;
    capture = (async () => {
      if (!output) return;
      finished = true; persist({ outcome: "failure", pageClosed: page.isClosed() });
      if (page.isClosed()) return;
      try {
        const geometry = await bounded(page.evaluate(() => {
          const box = (e: Element) => { const r = e.getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height,
            top:r.top,bottom:r.bottom,left:r.left,right:r.right }; };
          const dialog = document.querySelector("dialog[open]");
          const elements = Array.from((dialog ?? document).querySelectorAll("button,input,textarea,select")).slice(0, 35);
          return { viewport: { width:innerWidth,height:innerHeight,visualWidth:visualViewport?.width,visualHeight:visualViewport?.height },
            pagePath:location.pathname, scroll: { x:scrollX,y:scrollY }, dialog:dialog ? { box:box(dialog),
              scrollTop:dialog.scrollTop,scrollHeight:dialog.scrollHeight,clientHeight:dialog.clientHeight } : null,
            controls:elements.map(e => { const r=e.getBoundingClientRect(),style=getComputedStyle(e);
              const x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);
              return { tag:e.tagName,type:e.getAttribute("type"),label:e.getAttribute("aria-label"),
                buttonText:e.tagName==="BUTTON"?(e.textContent??"").trim().slice(0,80):null,
                disabled:(e as HTMLInputElement).disabled===true,checked:e instanceof HTMLInputElement?e.checked:undefined,
                box:box(e),display:style.display,visibility:style.visibility,centerOwned:!!hit&&(hit===e||e.contains(hit)),
                validity:e instanceof HTMLInputElement?{valid:e.validity.valid,valueMissing:e.validity.valueMissing,typeMismatch:e.validity.typeMismatch}:undefined };
            }) };
        }),2000);
        persist({ outcome:"failure", geometry });
        const png = await page.screenshot({ fullPage:false, timeout:2000 });
        writeFileSync(join(output, `${id}.png`),png); persist({ outcome:"failure", geometry, pngSha256:sha(png), pngBytes:png.length });
      } catch (error) { persist({ outcome:"failure", captureErrorName:error instanceof Error?error.name:"unknown" }); }
      console.log("HR_UI_FAILURE_DIAGNOSTIC_V1",JSON.stringify({id,phase,acceptance:false,sourceSha256}));
    })();
    return capture;
  };
  onTestFailed(async () => { await finish(); await page.close().catch(() => undefined); });
  persist();
  return { at:(next:string)=>{if (!finished) { phase=next;persist(); }}, failed:finish };
}

// A controlled textarea's value and a select's options can enter a wrapping
// label's textContent. Bind each unique native control to the exact own text of
// its real associated label; never weaken the content or locked-state assertions.
async function taskNativeField(modal: Locator, selector: "textarea" | "select", labelText: string) {
  const control = modal.locator(selector);
  expect(await control.count()).toBe(1);
  expect(await control.evaluate(element => Array.from((element as HTMLTextAreaElement | HTMLSelectElement).labels ?? []).map(label =>
    Array.from(label.childNodes).filter(node => node.nodeType === Node.TEXT_NODE)
      .map(node => node.textContent ?? "").join("").trim()))).toEqual([labelText]);
  expect(await control.isVisible()).toBe(true);
  return control;
}

function cookieParts(raw: string) {
  const [name, ...parts] = raw.split("="); return { name, value: parts.join("=") };
}
for (const width of [390, 1280]) {
  it(`actual committed-response loss retains one owner/key/body through double click and modal reopening at ${width}px`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "ar-YE" });
    await context.addCookies([{ ...cookieParts(h.sessions.doctorA.cookie), url: owned.baseUrl }]);
    const page = await context.newPage(), title = `Synthetic retained task ${width}`;
    const diagnostic = await taskFailureEvidence(page, `task-loss-${width}`);
    const sent: Record<string, unknown>[] = []; let committedId = 0;
    try {
      diagnostic.at("navigate-hr"); await page.goto(`${owned.baseUrl}/hr`, { waitUntil: "domcontentloaded" });
      diagnostic.at("open-create"); await page.getByRole("button", { name: "مهمة جديدة", exact: true }).click();
      const modal = page.getByRole("dialog", { name: "مهمة جديدة", exact: true });
      diagnostic.at("fill-title"); await modal.getByLabel("العنوان", { exact: true }).fill(title);
      diagnostic.at("fill-description"); const description = await taskNativeField(modal, "textarea", "الوصف"); await description.fill("Synthetic immutable private detail");
      diagnostic.at("check-private"); await modal.getByLabel(/مهمة خاصة/).check();
      let release!: () => void, fail!: (error: unknown) => void;
      const committed = new Promise<void>((resolve, reject) => { release = resolve; fail = reject; });
      await page.route("**/api/tasks", async route => {
        try {
          sent.push(route.request().postDataJSON());
          diagnostic.at("intercept-fetch-real-post"); const response = await route.fetch(); expect(response.status()).toBe(201);
          diagnostic.at("read-real-receipt"); const receipt = await response.json(); committedId = receipt.id;
          expect(receipt.creationReceipt.clientRequestId).toBe(sent[0].clientRequestId);
          // The real write and receipt exist, but the browser receives no response.
          diagnostic.at("abort-committed-response"); await route.abort("connectionfailed"); release();
        } catch (error) { fail(error); await route.abort().catch(() => undefined); }
      }, { times: 1 });
      diagnostic.at("native-double-create"); await modal.getByRole("button", { name: "إنشاء", exact: true }).dblclick(); diagnostic.at("wait-actual-commit"); await committed;
      diagnostic.at("wait-uncertainty-alert"); await expect.poll(() => modal.getByRole("alert").count()).toBe(1);
      expect(sent).toHaveLength(1); expect(await count(String(sent[0].clientRequestId))).toBe(1);
      expect(await modal.getByLabel("العنوان", { exact: true }).isDisabled()).toBe(true);
      expect(await description.isDisabled()).toBe(true);
      expect(await description.inputValue()).toBe("Synthetic immutable private detail");
      const priority = await taskNativeField(modal, "select", "الأولوية");
      expect(await priority.isDisabled()).toBe(true); expect(await priority.inputValue()).toBe("normal");
      expect(await modal.getByLabel(/مهمة خاصة/).isDisabled()).toBe(true);
      expect(await modal.getByRole("status").innerText()).toContain("راجع قائمة مهامك قبل إنشاء طلب جديد");
      diagnostic.at("close-modal"); await modal.getByRole("button", { name: "إلغاء", exact: true }).click();
      diagnostic.at("open-create"); await page.getByRole("button", { name: "مهمة جديدة", exact: true }).click();
      expect(await modal.getByLabel("العنوان", { exact: true }).inputValue()).toBe(title);
      expect(await (await taskNativeField(modal, "textarea", "الوصف")).inputValue()).toBe("Synthetic immutable private detail");
      expect(await description.isDisabled()).toBe(true);
      expect(await priority.isDisabled()).toBe(true); expect(await priority.inputValue()).toBe("normal");
      expect(await modal.getByLabel("العنوان", { exact: true }).isDisabled()).toBe(true);
      page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/tasks") sent.push(request.postDataJSON()); });
      const replayed = page.waitForResponse(response => new URL(response.url()).pathname === "/api/tasks" && response.request().method() === "POST");
      diagnostic.at("native-double-replay"); await modal.getByRole("button", { name: "تحقق وأعد نفس الطلب", exact: true }).dblclick();
      diagnostic.at("wait-replay-response"); const response = await replayed; expect(response.status()).toBe(201); expect((await response.json()).id).toBe(committedId);
      await expect.poll(() => modal.count()).toBe(0);
      expect(sent).toHaveLength(2); expect(sent[1]).toEqual(sent[0]);
      expect(await count(String(sent[0].clientRequestId))).toBe(1);
      expect((await owned.db.query("SELECT count(*)::int AS n FROM hr_task_events WHERE task_id=$1", [committedId])).rows[0].n).toBe(1);
      expect((await owned.db.query("SELECT count(*)::int AS n FROM audit_log WHERE action='task.create' AND entity='hr_task' AND entity_id=$1", [String(committedId)])).rows[0].n).toBe(1);
      // Only the explicit new-task action starts an editable new intent.
      diagnostic.at("open-create"); await page.getByRole("button", { name: "مهمة جديدة", exact: true }).click();
      expect(await modal.getByLabel("العنوان", { exact: true }).inputValue()).toBe("");
      expect(await modal.getByLabel("العنوان", { exact: true }).isEnabled()).toBe(true);
      diagnostic.at("close-modal"); await modal.getByRole("button", { name: "إلغاء", exact: true }).click();
    } catch (error) { await diagnostic.failed().catch(() => undefined); throw error; } finally { await context.close(); }
  });

  it(`a foreign receipt remains pending and a changed signed owner cannot resend the retained draft at ${width}px`, async () => {
    const ownerWitnessTitle = `Synthetic current owner B witness ${width}`;
    const ownerWitnessKey = `http-task-owner-b-witness-${width}`;
    const ownerWitness = await post(h.sessions.doctorB.cookie, { ...body(ownerWitnessKey), title: ownerWitnessTitle });
    expect(ownerWitness.status).toBe(201);
    expect(ownerWitness.body.creationReceipt).toEqual({ clientRequestId: ownerWitnessKey, username: "secdoctorb", role: "doctor" });
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "ar-YE" });
    await context.addCookies([{ ...cookieParts(h.sessions.doctorA.cookie), url: owned.baseUrl }]);
    const page = await context.newPage(), title = `Synthetic owner-fenced task ${width}`;
    const diagnostic = await taskFailureEvidence(page, `task-foreign-${width}`);
    let sent: Record<string, unknown> | undefined;
    try {
      diagnostic.at("navigate-hr"); await page.goto(`${owned.baseUrl}/hr`, { waitUntil: "domcontentloaded" });
      diagnostic.at("open-create"); await page.getByRole("button", { name: "مهمة جديدة", exact: true }).click();
      const modal = page.getByRole("dialog", { name: "مهمة جديدة", exact: true });
      diagnostic.at("fill-title"); await modal.getByLabel("العنوان", { exact: true }).fill(title); diagnostic.at("check-private"); await modal.getByLabel(/مهمة خاصة/).check();
      await page.route("**/api/tasks", async route => {
        sent = route.request().postDataJSON(); diagnostic.at("intercept-fetch-real-post"); const response = await route.fetch(); expect(response.status()).toBe(201);
        diagnostic.at("read-real-receipt"); const receipt = await response.json();
        diagnostic.at("fulfill-foreign-receipt"); await route.fulfill({ response, json: { ...receipt, creationReceipt: { ...receipt.creationReceipt, clientRequestId: "synthetic-foreign-receipt" } } });
      }, { times: 1 });
      diagnostic.at("native-create"); await modal.getByRole("button", { name: "إنشاء", exact: true }).click();
      diagnostic.at("wait-foreign-alert"); await expect.poll(() => modal.getByRole("alert").innerText()).toContain("لم تصل نتيجة مطابقة");
      expect(await count(String(sent!.clientRequestId))).toBe(1);
      diagnostic.at("switch-signed-owner"); await context.addCookies([{ ...cookieParts(h.sessions.doctorB.cookie), url: owned.baseUrl }]);
      const refused = page.waitForResponse(response => new URL(response.url()).pathname === "/api/tasks" && response.request().method() === "POST");
      diagnostic.at("native-foreign-owner-replay"); await modal.getByRole("button", { name: "تحقق وأعد نفس الطلب", exact: true }).click();
      diagnostic.at("wait-owner-refusal"); expect((await refused).status()).toBe(403);
      expect(await modal.getByLabel("العنوان", { exact: true }).isDisabled()).toBe(true);
      expect(await count(String(sent!.clientRequestId))).toBe(1);
      await expect.poll(() => modal.getByRole("alert").innerText()).toContain("تغيّر صاحب الجلسة");
      let unsolicited = 0;
      page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/tasks") unsolicited++; });
      page.on("dialog", dialog => dialog.accept());
      const currentTasks = page.waitForResponse(response => new URL(response.url()).pathname === "/api/tasks" && response.request().method() === "GET");
      diagnostic.at("reload-new-owner"); const reloaded = await page.reload({ waitUntil: "domcontentloaded" });
      expect(reloaded?.status()).toBe(200);
      // RootLayout supplies the signed session directly; SessionProvider need not
      // issue /api/auth/me on reload. This explicit context request independently
      // verifies the cookie identity; the actual application GET below proves its
      // positive B-owned private view as well as absence of A's retained task.
      diagnostic.at("verify-new-owner-cookie"); const currentOwner = await context.request.get(`${owned.baseUrl}/api/auth/me`);
      expect(currentOwner.status()).toBe(200);
      expect(await currentOwner.json()).toMatchObject({ username: "secdoctorb", role: "doctor" });
      diagnostic.at("wait-new-tasks-read"); const visible = await currentTasks; expect(visible.status()).toBe(200);
      const visibleTasks = await visible.json();
      expect(JSON.stringify(visibleTasks)).not.toContain(title);
      expect(visibleTasks.tasks).toEqual(expect.arrayContaining([expect.objectContaining({ id: ownerWitness.body.id, title: ownerWitnessTitle, isPrivate: true })]));
      await expect.poll(() => page.locator("section[aria-label='المهام']").getByText(ownerWitnessTitle, { exact: true }).isVisible()).toBe(true);
      diagnostic.at("open-create"); await page.getByRole("button", { name: "مهمة جديدة", exact: true }).click();
      expect(await modal.getByLabel("العنوان", { exact: true }).inputValue()).toBe("");
      expect(await modal.getByRole("status").count()).toBe(0); expect(unsolicited).toBe(0);
      expect(await page.locator("section[aria-label='المهام']").innerText()).not.toContain(title);
      diagnostic.at("close-modal"); await modal.getByRole("button", { name: "إلغاء", exact: true }).click();
    } catch (error) { await diagnostic.failed().catch(() => undefined); throw error; } finally { await context.close(); }
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
