import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import JSZip from "jszip";
import { Client } from "pg";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { tanakaCommandV2 } from "../fixtures/ortho-assessment-tanaka";
import { authedGet, authedMutation, baseUrl, harness } from "./_server";

let h: Awaited<ReturnType<typeof harness>>, db: Client, browser: Browser;
beforeAll(async () => {
  h = await harness(); expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  await mkdir(".settings-ui-artifacts", { recursive: true });
});
afterAll(async () => { await browser?.close(); await db?.end(); });

it.each([390, 1280])("saves a linked space plan, documents IPR in two actual sessions and reconciles an interrupted reply without duplicate enamel at width %i", async width => {
  const patient = (await db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'سجل مسافات اصطناعي') RETURNING id", [`SYN-SPACE-${randomUUID()}`])).rows[0].id;
  const intake = await authedMutation('/api/ortho/intake', h.sessions.admin, 'POST', JSON.stringify({ patientId: patient, command: { schemaVersion: 1, clientRequestId: randomUUID(), reason: 'Synthetic space journey' } }));
  expect(intake.status).toBe(201); const { orthoCaseId: ortho, clinicalCaseId: clinical } = await intake.json();
  const assessment = await authedMutation(`/api/ortho/${ortho}/assessment`, h.sessions.admin, 'POST', JSON.stringify({ ...tanakaCommandV2(), commandId: randomUUID() })); expect(assessment.status).toBe(201);
  const problem = (await db.query("INSERT INTO patient_problems(patient_id,case_id,label,noted_by) VALUES($1,$2,'مشكلة مسافة اصطناعية','synthetic') RETURNING id", [patient, clinical])).rows[0].id;
  const strategy = await authedMutation(`/api/ortho/${ortho}/strategy`, h.sessions.admin, 'POST', JSON.stringify({ schemaVersion: 1, commandId: randomUUID(), expectedRevisionId: null, reason: 'Synthetic manual goal', rows: [{ problemId: problem, objective: 'هدف اصطناعي', strategy: 'خطة يراجعها الطبيب', rationale: 'Synthetic', planItemIds: [] }] })); expect(strategy.status).toBe(201);
  // Treatment and actual sessions are explicit fixture setup, not ledger effects.
  await db.query("UPDATE ortho_cases SET status='active',phase='aligning',appliance='fixed_metal',arches='both',slot='022',start_date='2026-11-04',planned_months=12 WHERE id=$1", [ortho]);
  const sessions: number[] = [];
  for (let i = 0; i < 2; i++) {
    const visit = (await db.query("INSERT INTO visits(patient_id,patient_name,status) VALUES($1,'Synthetic actual visit','done') RETURNING id", [patient])).rows[0].id;
    sessions.push((await db.query("INSERT INTO ortho_adjustments(case_id,visit_id,recorded_by) VALUES($1,$2,'طبيب اصطناعي') RETURNING id", [ortho, visit])).rows[0].id);
  }
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: 'ar-YE' });
  const [name, ...value] = h.sessions.admin.cookie.split('='); await context.addCookies([{ name, value: value.join('='), url: baseUrl }]);
  const page = await context.newPage(), errors: string[] = []; page.setDefaultTimeout(20000); page.on('pageerror', e => errors.push(e.message));
  const read = async () => { const r = await authedGet(`/api/ortho/${ortho}/space-ledger?patientId=${patient}`, h.sessions.admin); expect(r.status).toBe(200); return r.json(); };
  try {
    await page.goto(`${baseUrl}/patients/${patient}?tab=treatment&sub=ortho&orthoCaseId=${ortho}&pillar=prescription`);
    await expect.poll(() => page.getByTestId('patient-ortho-workspace').getAttribute('data-read-state')).toBe('ready');
    await page.locator('summary').filter({ hasText: 'ميزانية المسافات وIPR' }).click();
    const panel = page.getByTestId('ortho-space-ledger');
    await panel.getByRole('button', { name: 'مراجعة ميزانية الفك العلوي', exact: true }).click();
    await panel.getByLabel('سبب الاختيار والاستطباب', { exact: true }).fill('استطباب اصطناعي بعد فحص الحالة');
    await panel.getByLabel('البدائل التي راجعها الطبيب', { exact: true }).fill('بدائل اصطناعية يراجعها الطبيب');
    await panel.getByRole('button', { name: 'إضافة تماس IPR', exact: true }).click();
    await panel.getByLabel('السن 1 للتماس 1', { exact: true }).selectOption('12');
    await panel.getByLabel('السن 2 للتماس 1', { exact: true }).selectOption('11');
    await panel.getByLabel('IPR المخطط للتماس 1 (mm)', { exact: true }).pressSequentially('0.3');
    await panel.getByLabel('المكسب الإضافي بعد قياس المرجع للتماس 1 (mm)', { exact: true }).fill('0.3');
    await panel.getByLabel('حد الطبيب للتماس 1 (mm)، اختياري', { exact: true }).fill('0.4');
    await panel.getByLabel('توثيق فحص التماس ومبرر المقدار', { exact: true }).fill('تماس اصطناعي تحقق منه الطبيب');
    await panel.getByLabel('سبب توثيق نسخة المسافات', { exact: true }).fill('Synthetic first space plan');
    // Collapsing and reopening retains the parent's exact unsaved document.
    await page.locator('summary').filter({ hasText: 'ميزانية المسافات وIPR' }).click();
    await page.locator('summary').filter({ hasText: 'ميزانية المسافات وIPR' }).click();
    expect(await panel.getByLabel('IPR المخطط للتماس 1 (mm)', { exact: true }).inputValue()).toBe('0.3');
    await panel.getByRole('button', { name: 'حفظ سجل المسافات', exact: true }).click();
    await expect.poll(async () => (await read()).history.length).toBe(1);
    await panel.getByRole('button', { name: 'تسجيل IPR لهذا التماس', exact: true }).waitFor();
    expect(await panel.innerText()).toContain('-1.7 mm');
    const before = await read(); expect(before.history[0].content.authored.contacts[0].teeth).toEqual([11, 12]);
    // One failed response after the server committed must be reconciled by replay.
    let interrupted = false;
    await page.route(`**/api/ortho/${ortho}/space-ledger`, async route => {
      if (route.request().method() === 'POST' && !interrupted) { interrupted = true; const response = await route.fetch(); expect(response.status()).toBe(201); await route.abort('failed'); } else await route.continue();
    });
    await panel.getByRole('button', { name: 'تسجيل IPR لهذا التماس', exact: true }).click();
    await panel.getByLabel('جلسة التقويم الفعلية', { exact: true }).selectOption(String(sessions[0]));
    await panel.getByLabel('مقدار IPR المنفذ في هذه الجلسة (mm)', { exact: true }).fill('0.1');
    await panel.getByLabel('طريقة القياس ومصدر التوثيق', { exact: true }).fill('قياس اصطناعي للجلسة الأولى');
    await panel.getByLabel('سبب توثيق نسخة المسافات', { exact: true }).fill('Synthetic first IPR');
    await panel.getByRole('button', { name: 'حفظ سجل المسافات', exact: true }).click();
    await panel.getByRole('button', { name: 'التحقق بإعادة نفس طلب المسافات', exact: true }).click();
    await expect.poll(async () => (await read()).history.length).toBe(2);
    await expect.poll(async () => panel.getByRole('button', { name: 'تسجيل IPR لهذا التماس', exact: true }).isEnabled()).toBe(true);
    await panel.getByRole('button', { name: 'تسجيل IPR لهذا التماس', exact: true }).click();
    await panel.getByLabel('جلسة التقويم الفعلية', { exact: true }).selectOption(String(sessions[1]));
    await panel.getByLabel('مقدار IPR المنفذ في هذه الجلسة (mm)', { exact: true }).fill('0.2');
    await panel.getByLabel('طريقة القياس ومصدر التوثيق', { exact: true }).fill('قياس اصطناعي للجلسة الثانية');
    await panel.getByLabel('سبب توثيق نسخة المسافات', { exact: true }).fill('Synthetic second IPR');
    await panel.getByRole('button', { name: 'حفظ سجل المسافات', exact: true }).click();
    await expect.poll(async () => (await read()).ipr.totals[0].performedUm).toBe(300);
    await page.reload(); await page.locator('summary').filter({ hasText: 'ميزانية المسافات وIPR' }).click(); await panel.getByRole('button', { name: 'تسجيل IPR لهذا التماس', exact: true }).waitFor();
    expect(await panel.innerText()).toContain('الموثق المنفذ 0.3 mm');
    await panel.locator('summary').filter({ hasText: 'سجل النسخ والتصحيحات' }).click();
    await panel.getByRole('button', { name: 'تصحيح هذا الحدث', exact: true }).first().click();
    expect(await panel.getByLabel('جلسة التقويم الفعلية', { exact: true }).isDisabled()).toBe(true);
    await panel.getByLabel('مقدار IPR المنفذ في هذه الجلسة (mm)', { exact: true }).fill('0.15');
    await panel.getByLabel('طريقة القياس ومصدر التوثيق', { exact: true }).fill('تصحيح قياس اصطناعي للجلسة الثانية');
    await panel.getByLabel('سبب توثيق نسخة المسافات', { exact: true }).fill('Synthetic measurement correction');
    await panel.getByRole('button', { name: 'حفظ سجل المسافات', exact: true }).click();
    await expect.poll(async () => (await read()).ipr.totals[0].performedUm).toBe(250);
    const corrected = await read(); expect(corrected.history).toHaveLength(4); expect(corrected.ipr.current).toHaveLength(2);
    expect(corrected.history[0].content.authored.supersedesEntryId).toBe(corrected.history[1].id);
    await page.reload(); await page.locator('summary').filter({ hasText: 'ميزانية المسافات وIPR' }).click();
    await panel.getByRole('button', { name: 'تسجيل IPR لهذا التماس', exact: true }).waitFor();
    expect(await panel.innerText()).toContain('الموثق المنفذ 0.25 mm');
    expect((await panel.getByRole('button', { name: 'تسجيل IPR لهذا التماس', exact: true }).boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await panel.evaluate(el => window.scrollTo({ top: Math.max(0, scrollY + el.getBoundingClientRect().top - 80), behavior: 'instant' })); await page.screenshot({ path: `.settings-ui-artifacts/ortho-space-ledger-${width}.png` });
    expect((await panel.getByRole('heading', { name: 'ميزانية المسافات وسجل IPR', exact: true }).boundingBox())?.y).toBeGreaterThanOrEqual(60);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    // A fresh measurement must not inherit incremental space already reflected
    // in that measurement. The prior saved budget remains unchanged.
    const changed = { ...tanakaCommandV2(), commandId: randomUUID(), expectedRevisionId: before.history[0].content.authored.baseline.id };
    changed.content.observations.observations.find(row => row.id === 'width_11')!.value = { state: 'measured', value: 9 };
    expect((await authedMutation(`/api/ortho/${ortho}/assessment`, h.sessions.admin, 'POST', JSON.stringify(changed))).status).toBe(201);
    await panel.getByRole('button', { name: 'تحديث سجل المسافات', exact: true }).click();
    await panel.getByText('تغير مصدر القياسات أو الاستراتيجية؛ هذه النسخة محفوظة وتحتاج مراجعة الطبيب.', { exact: true }).waitFor();
    await panel.getByRole('button', { name: 'مراجعة ميزانية الفك العلوي', exact: true }).click();
    expect(await panel.getByLabel('IPR المخطط للتماس 1 (mm)', { exact: true }).inputValue()).toBe('0.3');
    expect(await panel.getByLabel('المكسب الإضافي بعد قياس المرجع للتماس 1 (mm)', { exact: true }).inputValue()).toBe('');
    expect((await read()).history).toEqual(corrected.history);
    expect((await authedGet(`/api/ortho/${ortho}/space-ledger?patientId=${patient}`, h.sessions.accountant)).status).toBe(403);
    expect((await authedMutation(`/api/ortho/${ortho}/space-ledger`, h.sessions.reception, 'POST', JSON.stringify({ patientId: patient, command: {} }))).status).toBe(403);
    expect((await db.query("SELECT (SELECT count(*)::int FROM invoices WHERE patient_id=$1) invoices,(SELECT count(*)::int FROM payments WHERE patient_id=$1) payments,(SELECT count(*)::int FROM visits WHERE patient_id=$1) visits", [patient])).rows).toEqual([{ invoices: 0, payments: 0, visits: 2 }]);
    // Select the existing immutable plan; never retype its measurements or
    // confuse planned 0.3 mm with the corrected performed 0.25 mm above.
    await page.getByRole('button', { name: /عرض الحالة/ }).click();
    const study=page.getByRole('region',{name:'دراسة حالة التقويم',exact:true});
    await study.getByLabel('إضافة المرجع إلى القسم',{exact:true}).selectOption('section_7');
    await study.getByLabel('نوع مصدر الدراسة',{exact:true}).selectOption('space_plan');
    const choices=study.getByRole('group',{name:'اختيار مصدر حقيقي',exact:true}).getByRole('button',{name:'اختيار',exact:true});
    await expect.poll(()=>choices.count()).toBe(1);await choices.click();
    await study.getByLabel('سبب حفظ النسخة',{exact:true}).fill('Synthetic saved planned space budget');
    const saved=page.waitForResponse(r=>r.url().includes(`/ortho/${ortho}/case-study/editor`)&&r.request().method()==='POST');
    await study.getByRole('button',{name:'حفظ مسودة الدراسة',exact:true}).click();expect((await saved).status()).toBe(201);
    const review=study.getByRole('region',{name:'مراجعة الدراسة المحفوظة',exact:true});
    await review.getByRole('combobox',{name:'القسم المحفوظ المعروض',exact:true}).selectOption('section_7');
    await expect.poll(()=>review.innerText()).toContain('-1.7');
    expect(await review.innerText()).toContain('تقديرات الطبيب لا تثبت تحقق الحركة أو تنفيذ IPR');
    expect(await review.innerText()).toContain('0.3');expect(await review.innerText()).not.toContain('0.25');
    await study.getByLabel('سبب حفظ النسخة',{exact:true}).fill('Synthetic documentary review of planned budget');
    const documented=page.waitForResponse(r=>r.url().includes(`/ortho/${ortho}/case-study/editor`)&&r.request().method()==='POST');
    await study.getByRole('button',{name:'توثيق النسخة المحفوظة نفسها',exact:true}).click();expect((await documented).status()).toBe(201);
    const href=await study.getByRole('link',{name:'PowerPoint نصي قابل للتحرير',exact:true}).getAttribute('href');
    const exported=await context.request.get(new URL(href!,baseUrl).href);expect(exported.status()).toBe(200);
    const zip=await JSZip.loadAsync(await exported.body());
    const slides=Object.keys(zip.files).filter(key=>/^ppt\/slides\/slide\d+\.xml$/.test(key));
    const xml=(await Promise.all(slides.map(key=>zip.file(key)!.async('text')))).join('\n');
    expect(xml).toContain('-1.7');expect(xml).toContain('ميزانية مسافات مخططة محفوظة');
    await page.reload();
    // The original URL explicitly opens the prescription pillar. Reopen the
    // study after reload before verifying its persisted documentary version.
    await page.getByRole('button',{name:/عرض الحالة/}).click();
    await review.getByRole('combobox',{name:'القسم المحفوظ المعروض',exact:true}).selectOption('section_7');
    await expect.poll(()=>review.innerText()).toContain('-1.7');
    await review.scrollIntoViewIfNeeded();await page.screenshot({path:`.settings-ui-artifacts/ortho-space-study-${width}.png`});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    expect(errors).toEqual([]);
  } catch (e) { await page.screenshot({ path: `.settings-ui-artifacts/ortho-space-ledger-failure-${width}.png`, fullPage: true }); throw e; }
  finally { await context.close(); }
});
