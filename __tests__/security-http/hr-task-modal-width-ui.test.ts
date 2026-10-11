import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { harness } from './_server';
import { openHrJourneyServer } from './_hr-isolated-server';

let h: Awaited<ReturnType<typeof harness>>, owned: Awaited<ReturnType<typeof openHrJourneyServer>>, browser: Browser;
const evidence = process.env.HR_EVIDENCE_DIR ?? join(process.cwd(), '.hr-evidence');
beforeAll(async () => {
  mkdirSync(evidence, { recursive: true }); h = await harness(); owned = await openHrJourneyServer(h);
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
});
afterAll(async () => { try { await browser?.close(); } finally { await owned?.close(); } });

async function inspectLayout(page: Page, dialog: Locator, name: string) {
  const layout = await dialog.evaluate(element => {
    const panel = element.firstElementChild as HTMLElement, bounds = panel.getBoundingClientRect();
    const controls = [...element.querySelectorAll<HTMLElement>('input,select,textarea,button')]
      .filter(control => control.getClientRects().length > 0).map(control => {
        const rect = control.getBoundingClientRect();
        return { tag: control.tagName, label: control.getAttribute('placeholder') ?? control.textContent?.trim().slice(0, 60) ?? '', left: rect.left, right: rect.right, width: rect.width };
      });
    return { direction: getComputedStyle(element).direction, viewport: innerWidth,
      pageWidth: document.documentElement.scrollWidth, pageClientWidth: document.documentElement.clientWidth, pageX: scrollX,
      dialogWidth: element.scrollWidth, dialogClientWidth: element.clientWidth, dialogX: element.scrollLeft,
      panel: { left: bounds.left, right: bounds.right, width: bounds.width }, controls };
  });
  writeFileSync(join(evidence, `${name}-layout.json`), JSON.stringify(layout, null, 2));
  await page.screenshot({ path: join(evidence, `${name}.png`), fullPage: false });
  expect(layout.direction).toBe('rtl'); expect(layout.pageX).toBe(0); expect(layout.dialogX).toBe(0);
  expect(layout.pageWidth).toBeLessThanOrEqual(layout.pageClientWidth + 1);
  expect(layout.dialogWidth).toBeLessThanOrEqual(layout.dialogClientWidth + 1);
  for (const control of layout.controls) {
    expect(control.left, `${control.tag} ${control.label} left edge`).toBeGreaterThanOrEqual(Math.max(0, layout.panel.left) - 1);
    expect(control.right, `${control.tag} ${control.label} right edge`).toBeLessThanOrEqual(Math.min(layout.viewport, layout.panel.right) + 1);
  }
}

/** Check the entire button rectangle and hit targets before an ordinary Playwright click. */
async function clickReachable(button: Locator) {
  await button.scrollIntoViewIfNeeded();
  const visible = await button.evaluate(element => {
    const r = element.getBoundingClientRect(), dialog = element.closest('dialog')!;
    // Sample edge midpoints and centre, not transparent corners outside the rounded button shape.
    const x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2;
    const points = [[x, y], [r.left + 2, y], [r.right - 2, y], [x, r.top + 2], [x, r.bottom - 2]];
    return { entire: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight,
      hit: points.every(([x, y]) => { const hit = document.elementFromPoint(x, y); return hit !== null && element.contains(hit); }),
      pageX: scrollX, dialogX: dialog.scrollLeft };
  });
  expect(visible).toEqual({ entire: true, hit: true, pageX: 0, dialogX: 0 });
  expect(await button.isEnabled()).toBe(true); await button.click();
}
async function contextAt(width: number) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ar-YE', timezoneId: 'Asia/Aden' });
  const [name, ...value] = h.sessions.admin.cookie.split('='); await context.addCookies([{ name, value: value.join('='), url: owned.baseUrl }]);
  return context;
}

for (const width of [390, 1280]) {
  it(`keeps native create fields and actions contained in RTL and preserves values at ${width}`, async () => {
    const context = await contextAt(width);
    try {
      const page = await context.newPage(); await page.goto(owned.baseUrl + '/hr');
      await page.getByRole('button', { name: 'مهمة جديدة', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'مهمة جديدة', exact: true });
      await dialog.getByLabel('العنوان', { exact: true }).fill(`إنشاء بعرض سليم ${width}`);
      await dialog.getByLabel('الوصف', { exact: true }).fill('وصف اصطناعي محفوظ دون تغيير المحتوى.');
      await dialog.getByLabel('تاريخ التخطيط', { exact: true }).fill('2026-10-12');
      await dialog.getByLabel('موعد الاستحقاق', { exact: true }).fill('10000-01-01T14:00');
      await dialog.getByRole('button', { name: 'إنشاء', exact: true }).click();
      await expect.poll(() => dialog.getByRole('alert').count()).toBe(1);
      await inspectLayout(page, dialog, `task-create-width-${width}`);
      await dialog.getByLabel('موعد الاستحقاق', { exact: true }).fill('2026-10-12T14:00');
      const [saved] = await Promise.all([page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/tasks'),
        clickReachable(dialog.getByRole('button', { name: 'إنشاء', exact: true }))]);
      expect(saved.status()).toBe(201); const task = await saved.json();
      await dialog.waitFor({ state: 'hidden' });
      const row = (await owned.db.query('SELECT title,description,due_at,planned_for::text FROM hr_tasks WHERE id=$1', [task.id])).rows[0];
      expect(row).toMatchObject({ title: `إنشاء بعرض سليم ${width}`, description: 'وصف اصطناعي محفوظ دون تغيير المحتوى.', planned_for: '2026-10-12' });
      expect(row.due_at.toISOString()).toBe('2026-10-12T11:00:00.000Z');
      await page.getByRole('button', { name: 'مهمة جديدة', exact: true }).click();
      await clickReachable(dialog.getByRole('button', { name: 'إلغاء', exact: true })); await dialog.waitFor({ state: 'hidden' });
    } finally { await context.close(); }
  });

  it(`adds checklist/comment, saves deadline and closes through fully reachable RTL controls at ${width}`, async () => {
    const context = await contextAt(width);
    const actions: Record<string, unknown> = { width, forceClick: false, syntheticOnly: true };
    try {
      // Seed one task through the real API; every action under test below uses native UI input/clicks.
      const seeded = await context.request.post(owned.baseUrl + '/api/tasks', { headers: { Origin: owned.baseUrl }, data: {
        title: `نموذج المهمة الكامل ${width}`, description: 'محتوى ثابت — اختبار اصطناعي', isPrivate: false, priority: 'normal',
        plannedFor: '2026-10-12', dueAt: '2026-10-12T11:00:00.000Z', assigneeStaffId: null,
        clientRequestId: `task-width-native-${width}-0001`,
      } });
      expect(seeded.status()).toBe(201); const task = await seeded.json();
      const page = await context.newPage(); await page.goto(owned.baseUrl + '/hr');
      await page.getByRole('button', { name: new RegExp(`نموذج المهمة الكامل ${width}`) }).first().click();
      const dialog = page.getByRole('dialog', { name: `المهمة: نموذج المهمة الكامل ${width}`, exact: true });
      await dialog.getByRole('button', { name: /تعديل العنوان/ }).click();
      const form = dialog.getByRole('form', { name: 'تعديل بيانات المهمة' });
      await form.getByLabel('موعد الاستحقاق', { exact: true }).fill('10000-01-01T14:00');
      await form.getByRole('button', { name: 'حفظ التعديل', exact: true }).click();
      await expect.poll(() => dialog.getByRole('alert').count()).toBe(1);
      await inspectLayout(page, dialog, `task-edit-width-${width}`);
      await dialog.getByPlaceholder('بند جديد…', { exact: true }).fill(`بند مثبت ${width}`);
      const [checklistResponse] = await Promise.all([page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/tasks/${task.id}/checklist`),
        clickReachable(dialog.getByRole('button', { name: 'إضافة', exact: true }))]);
      actions.checklistStatus = checklistResponse.status(); expect(actions.checklistStatus).toBe(200);
      await expect.poll(() => dialog.getByText(`بند مثبت ${width}`, { exact: true }).count()).toBe(1);
      expect((await owned.db.query('SELECT label FROM hr_task_checklist WHERE task_id=$1', [task.id])).rows).toEqual([{ label: `بند مثبت ${width}` }]);
      await dialog.getByPlaceholder('اكتب تعليقًا — يُسجَّل باسمك', { exact: true }).fill(`تعليق مثبت ${width}`);
      const [commentResponse] = await Promise.all([page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/tasks/${task.id}/comments`),
        clickReachable(dialog.getByRole('button', { name: 'إرسال', exact: true }))]);
      actions.commentStatus = commentResponse.status(); expect(actions.commentStatus).toBe(201);
      await expect.poll(() => dialog.getByText(`تعليق مثبت ${width}`, { exact: true }).count()).toBe(1);
      expect((await owned.db.query('SELECT body FROM hr_task_comments WHERE task_id=$1', [task.id])).rows).toEqual([{ body: `تعليق مثبت ${width}` }]);
      // The existing detail reload remounts the modal after a comment; reopen its editor normally.
      await dialog.getByRole('button', { name: /تعديل العنوان/ }).click();
      await form.getByLabel('موعد الاستحقاق', { exact: true }).fill('2026-10-12T15:00');
      const [patchResponse] = await Promise.all([page.waitForResponse(r => r.request().method() === 'PATCH' && new URL(r.url()).pathname === `/api/tasks/${task.id}`),
        clickReachable(form.getByRole('button', { name: 'حفظ التعديل', exact: true }))]);
      actions.deadlineStatus = patchResponse.status(); expect(actions.deadlineStatus).toBe(200); await form.waitFor({ state: 'hidden' });
      const row = (await owned.db.query('SELECT title,description,due_at,planned_for::text,is_private,priority,assignee_staff_id FROM hr_tasks WHERE id=$1', [task.id])).rows[0];
      expect(row).toMatchObject({ title: `نموذج المهمة الكامل ${width}`, description: 'محتوى ثابت — اختبار اصطناعي', planned_for: '2026-10-12', is_private: false, priority: 'normal', assignee_staff_id: null });
      expect(row.due_at.toISOString()).toBe('2026-10-12T12:00:00.000Z');
      await dialog.getByRole('button', { name: /تعديل العنوان/ }).click();
      expect(await form.getByLabel('موعد الاستحقاق', { exact: true }).inputValue()).toBe('2026-10-12T15:00');
      await clickReachable(form.getByRole('button', { name: 'تراجع', exact: true })); await form.waitFor({ state: 'hidden' });
      const backgroundY = await page.evaluate(() => scrollY);
      // Real wheel input, confined to the native dialog; no horizontal scroll commands or synthetic clicks.
      await page.mouse.move(width / 2, 450); await page.mouse.wheel(0, -1500);
      await expect.poll(() => dialog.evaluate(element => element.scrollTop)).toBe(0);
      await page.mouse.wheel(0, 1500);
      await expect.poll(() => dialog.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
      expect(await page.evaluate(() => scrollY)).toBe(backgroundY);
      actions.dialogScrollTop = await dialog.evaluate(element => element.scrollTop);
      await inspectLayout(page, dialog, `task-actions-width-${width}`);
      await page.screenshot({ path: join(evidence, `task-actions-completed-${width}.png`), fullPage: false });
      await clickReachable(dialog.getByRole('button', { name: 'إغلاق', exact: true })); await dialog.waitFor({ state: 'hidden' }); actions.closed = true;
      await page.getByRole('button', { name: new RegExp(`نموذج المهمة الكامل ${width}`) }).first().click();
      await expect.poll(() => dialog.getByText(`بند مثبت ${width}`, { exact: true }).count()).toBe(1);
      await expect.poll(() => dialog.getByText(`تعليق مثبت ${width}`, { exact: true }).count()).toBe(1);
      await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' }); actions.escapeClosed = true; actions.completed = true;
    } finally { writeFileSync(join(evidence, `task-actions-${width}.json`), JSON.stringify(actions, null, 2)); await context.close(); }
  });
}
