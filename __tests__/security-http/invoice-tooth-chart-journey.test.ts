import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { Client } from "pg";
import { baseUrl, harness } from "./_server";
import { ALL_TEETH } from "../../lib/dental";
import { revealOrthoControlByWheel, settleStrategy } from "./_ortho-strategy-ui-fixture";

/**
 * (INV-LINK TOOTH) أسنان بند الفاتورة العلاجية تُختار بالنقر على **مخطط الأسنان نفسه** (Odontogram المشترك مع
 * المخطط السريري) — لا بكتابة الأرقام. على التطبيق المبني وقاعدة معزولة:
 * عصب 36+46 ⇒ سطران وحالتان · جسر 14-16 ⇒ ثلاثة أسطر وحالة واحدة · حشوة 26 MO · تقويم فك علوي بلا مخطط ·
 * كشف بلا زر أسنان · عصب بلا سن ⇒ الحفظ ممنوع · جوال 390px بلا تمرير أفقي للصفحة.
 */

let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let doctorPartyId = 0;
const stamp = Date.now();
const services: Record<"rct" | "bridge" | "filling" | "ortho" | "consultation", number> = {
  rct: 0, bridge: 0, filling: 0, ortho: 0, consultation: 0,
};
const SHOTS = "/tmp/claude-0/shots";

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  ({ rows: [{ party_id: doctorPartyId }] } = await db.query<{ party_id: number }>(`SELECT party_id FROM users WHERE username = 'secdoctora'`));
  const prices = { rct: 6000000, bridge: 9000000, filling: 1500000, ortho: 30000000, consultation: 300000 };
  for (const category of Object.keys(services) as (keyof typeof services)[]) {
    ({ rows: [{ id: services[category] }] } = await db.query<{ id: number }>(
      `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ($1, $2, TRUE, TRUE, $3) RETURNING id`,
      [`سن مخطط ${category} ${stamp}`, prices[category], category]));
  }
  try { mkdirSync(SHOTS, { recursive: true }); } catch { /* لقطات اختيارية */ }
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

async function newPatient(label: string): Promise<number> {
  const { rows: [{ id }] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1, $2, $3) RETURNING id`,
    [`ITC-${label}-${stamp}`, `مريض مخطط الفاتورة ${label}`, doctorPartyId]);
  return id;
}

async function openInvoice(patientId: number, viewport = { width: 1280, height: 1100 }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport, locale: "ar-YE" });
  const [name, ...value] = h.sessions.reception.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage();
  await page.goto(`${baseUrl}/patients/${patientId}?tab=account`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("treatment-entry-open").click();
  await page.getByRole("button", { name: "علاج جديد", exact: true }).click();
  return { context, page };
}

async function chooseService(page: Page, serviceId: number, line = 0) {
  await page.getByTestId(`invoice-row-${line}`).getByLabel("الخدمة", { exact: true }).selectOption(String(serviceId));
}

/** يفتح المخطط من زر السطر وينقر الأسنان في المخطط المشترك (لا كتابة أرقام). */
async function pickTeeth(page: Page, line: number, teeth: number[], surfaces: string[] = []): Promise<Locator> {
  await page.getByTestId(`invoice-tooth-button-${line}`).click();
  const dialog = page.getByTestId("tooth-dialog");
  await dialog.waitFor();
  for (const tooth of teeth) await dialog.getByTestId(`odontogram-tooth-${tooth}`).click();
  for (const surface of surfaces) await dialog.getByTestId(`surface-${surface}`).click();
  return dialog;
}

async function confirm(page: Page) {
  await page.getByTestId("tooth-dialog-confirm").click();
  await page.getByTestId("tooth-dialog").waitFor({ state: "detached" });
}

async function save(page: Page) {
  await page.getByRole("button", { name: "احفظ الفاتورة" }).click();
  await page.getByTestId("invoice-clinical-notice").waitFor();
}

const planItems = async (patientId: number) => (await db.query<{ tooth_code: number | null; surfaces: string | null }>(
  `SELECT pi.tooth_code, pi.surfaces FROM plan_items pi JOIN treatment_plans tp ON tp.id = pi.plan_id
    WHERE tp.patient_id = $1 ORDER BY pi.tooth_code NULLS FIRST, pi.id`, [patientId])).rows;
const cases = async (patientId: number) => (await db.query<{ specialty: string; site: string | null }>(
  `SELECT specialty, site FROM clinical_cases WHERE patient_id = $1 ORDER BY site NULLS FIRST, id`, [patientId])).rows;

// Measure the entire target against every clipping ancestor, including the
// chart's horizontal scrollport. Background shell bars do not reduce a modal's
// viewport; hit witnesses still catch an actual overlay over the modal itself.
function dialogControlProof(node: Element) {
  const rect = node.getBoundingClientRect();
  const available = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  const clips = [];
  for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor), box = ancestor.getBoundingClientRect();
    const clipX = /auto|scroll|hidden|clip/.test(style.overflowX);
    const clipY = /auto|scroll|hidden|clip/.test(style.overflowY);
    const left = box.left + ancestor.clientLeft, top = box.top + ancestor.clientTop;
    const right = left + ancestor.clientWidth, bottom = top + ancestor.clientHeight;
    if (clipX) { available.left = Math.max(available.left, left); available.right = Math.min(available.right, right); }
    if (clipY) { available.top = Math.max(available.top, top); available.bottom = Math.min(available.bottom, bottom); }
    if (clipX || clipY) clips.push({ testId: ancestor.dataset.testid ?? null, left, top, right, bottom,
      clipX, clipY, scrollLeft: ancestor.scrollLeft, scrollTop: ancestor.scrollTop });
    // The viewport-positioned modal escapes overflow clips on the page behind it.
    if (style.position === "fixed") break;
  }
  const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
  const cornerX = Math.min(8, rect.width / 4), cornerY = Math.min(8, rect.height / 4);
  const points = [[cx, cy], [cx, rect.top + 2], [rect.right - 2, cy], [cx, rect.bottom - 2], [rect.left + 2, cy],
    [rect.left + cornerX, rect.top + cornerY], [rect.right - cornerX, rect.top + cornerY],
    [rect.right - cornerX, rect.bottom - cornerY], [rect.left + cornerX, rect.bottom - cornerY]];
  const hits = points.map(([x, y]) => ({ x, y, clear: node.contains(document.elementFromPoint(x, y)) }));
  return { tooth: node.getAttribute("data-testid"), rect: { left: rect.left, right: rect.right, top: rect.top,
    bottom: rect.bottom, width: rect.width, height: rect.height }, available, clips, hits,
    fits: rect.left >= available.left && rect.right <= available.right && rect.top >= available.top && rect.bottom <= available.bottom,
    clear: hits.every(hit => hit.clear), pageWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth };
}

async function revealDialogControlByWheel(page: Page, control: Locator) {
  await control.waitFor();
  const wheels = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    const proof = await control.evaluate(dialogControlProof);
    if (proof.fits && proof.clear) return { ...proof, wheels };
    const wheel = await control.evaluate(node => {
      const target = node.getBoundingClientRect();
      for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor), box = ancestor.getBoundingClientRect();
        const left = box.left + ancestor.clientLeft, top = box.top + ancestor.clientTop;
        const right = left + ancestor.clientWidth, bottom = top + ancestor.clientHeight;
        const dx = /auto|scroll/.test(style.overflowX) && ancestor.scrollWidth > ancestor.clientWidth
          && (target.left < left || target.right > right) ? (target.left + target.right - left - right) / 2 : 0;
        const dy = /auto|scroll/.test(style.overflowY) && ancestor.scrollHeight > ancestor.clientHeight
          && (target.top < top || target.bottom > bottom) ? (target.top + target.bottom - top - bottom) / 2 : 0;
        if (dx || dy) {
          const x = (Math.max(0, left) + Math.min(innerWidth, right)) / 2;
          const y = (Math.max(0, top) + Math.min(innerHeight, bottom)) / 2;
          const hit = document.elementFromPoint(x, y);
          return { x, y, dx, dy, hitsScrollport: ancestor.contains(hit),
            nativeField: hit?.closest("input,textarea,select")?.tagName ?? null };
        }
      }
      return null;
    });
    expect(wheel, `clipped target must have a user-scrollable ancestor: ${JSON.stringify(proof)}`).not.toBeNull();
    expect(wheel!.hitsScrollport).toBe(true); expect(wheel!.nativeField).toBeNull();
    await page.mouse.move(wheel!.x, wheel!.y); await page.mouse.wheel(wheel!.dx, wheel!.dy);
    wheels.push(wheel); await settleStrategy(page);
    await expect.poll(async () => JSON.stringify((await control.evaluate(dialogControlProof)).clips)).not.toBe(JSON.stringify(proof.clips));
  }
  throw new Error(`Native scrolling did not expose the whole target: ${await control.getAttribute("data-testid")}`);
}

describe("INV-LINK TOOTH — invoice tooth selection through the shared dental chart", () => {
  it.each([390, 1280])("every permanent and primary tooth is reachable by native wheel and full-target clicks at %i×844", async width => {
    const patientId = await newPatient(`all-teeth-${width}`);
    const { context, page } = await openInvoice(patientId, { width, height: 844 });
    const geometry = [];
    const writes: string[] = [];
    page.on("request", request => {
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method())
        && new URL(request.url()).pathname !== "/api/invoices/clinical-preview") writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
    });
    try {
      await chooseService(page, services.filling);
      const opener = page.getByTestId("invoice-tooth-button-0");
      const openerProof = await revealOrthoControlByWheel(page, opener);
      await page.mouse.click(openerProof.left + openerProof.width / 2, openerProof.top + openerProof.height / 2);
      const dialog = page.getByTestId("tooth-dialog");
      await dialog.waitFor();
      await page.evaluate(async () => { await document.fonts.ready; });
      const navigation = dialog.getByTestId("tooth-chart-navigation");
      const navigationProof = await revealDialogControlByWheel(page, navigation);
      expect(await navigation.innerText()).toContain("اسحب المخطط أفقيًا");
      const chart = dialog.getByTestId("tooth-dialog-chart");
      const hasHorizontalOverflow = await chart.evaluate(node => node.scrollWidth > node.clientWidth);
      for (const direction of ["اليمين", "اليسار"]) {
        const arrow = navigation.getByRole("button", { name: `تمرير مخطط الأسنان نحو ${direction}`, exact: true });
        const arrowProof = await revealDialogControlByWheel(page, arrow);
        expect(arrowProof.rect.height).toBeGreaterThanOrEqual(44); expect(arrowProof.rect.width).toBeGreaterThanOrEqual(44);
        await page.mouse.click((arrowProof.rect.left + arrowProof.rect.right) / 2, (arrowProof.rect.top + arrowProof.rect.bottom) / 2);
        if (hasHorizontalOverflow) {
          if (direction === "اليمين") await expect.poll(() => chart.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
          else await expect.poll(() => chart.evaluate(node => node.scrollLeft)).toBe(0);
        }
      }
      mkdirSync(".settings-ui-artifacts", { recursive: true });
      await page.screenshot({ path: `.settings-ui-artifacts/invoice-chart-navigation-${width}.png`, fullPage: false });
      const primary = dialog.locator("label").filter({ hasText: "إظهار الأسنان اللبنية" });
      const primaryProof = await revealDialogControlByWheel(page, primary);
      await page.mouse.click((primaryProof.rect.left + primaryProof.rect.right) / 2, (primaryProof.rect.top + primaryProof.rect.bottom) / 2);
      expect(await primary.getByRole("checkbox").isChecked()).toBe(true);
      expect(await dialog.locator('[data-testid^="odontogram-tooth-"]').count()).toBe(52);
      for (const code of ALL_TEETH) {
        const tooth = dialog.getByTestId(`odontogram-tooth-${code}`);
        const proof = await revealDialogControlByWheel(page, tooth);
        expect(proof.fits).toBe(true); expect(proof.clear).toBe(true); expect(proof.hits).toHaveLength(9);
        expect(proof.rect.width).toBeGreaterThanOrEqual(44); expect(proof.rect.height).toBeGreaterThanOrEqual(44);
        expect(proof.pageWidth).toBeLessThanOrEqual(width + 1);
        // Coordinates are already proven visible: no locator auto-scroll, force,
        // DOM scroll mutation or JavaScript click can manufacture reachability.
        await page.mouse.click((proof.rect.left + proof.rect.right) / 2, (proof.rect.top + proof.rect.bottom) / 2);
        await expect.poll(() => tooth.getAttribute("aria-pressed")).toBe("true");
        expect(await dialog.locator('[data-testid^="odontogram-tooth-"][aria-pressed="true"]').count()).toBe(1);
        geometry.push({ code, ...proof });
      }
      expect(geometry.map(one => one.code)).toEqual(ALL_TEETH);
      const confirmControl = page.getByTestId("tooth-dialog-confirm");
      const confirmProof = await revealDialogControlByWheel(page, confirmControl);
      expect(confirmProof.rect.height).toBeGreaterThanOrEqual(44);
      const selectedTooth = dialog.getByTestId(`odontogram-tooth-${ALL_TEETH.at(-1)}`);
      // The aria state precedes the CSS color transition. Wait for its actual end.
      await selectedTooth.evaluate(async node => {
        await Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished));
      });
      const selectedAppearance = await selectedTooth.evaluate(node => ({
        pressed: node.getAttribute("aria-pressed"), background: getComputedStyle(node).backgroundColor,
        labelColor: getComputedStyle(node.querySelector("span")!).color,
        otherBackground: getComputedStyle(node.closest('[data-testid="tooth-dialog"]')!
          .querySelector('[data-testid^="odontogram-tooth-"][aria-pressed="false"]')!).backgroundColor,
        activeAnimations: node.getAnimations({ subtree: true }).filter(animation => animation.playState === "running").length,
      }));
      expect(selectedAppearance.pressed).toBe("true"); expect(selectedAppearance.activeAnimations).toBe(0);
      expect(selectedAppearance.background).not.toBe(selectedAppearance.otherBackground);
      const selectedProof = await selectedTooth.evaluate(dialogControlProof);
      expect(selectedProof.fits).toBe(true); expect(selectedProof.clear).toBe(true);
      mkdirSync(".settings-ui-artifacts", { recursive: true });
      writeFileSync(`.settings-ui-artifacts/invoice-all-teeth-${width}.json`, `${JSON.stringify({ width, height: 844, openerProof, navigationProof, hasHorizontalOverflow, primaryProof, geometry, confirmProof, selectedAppearance, selectedProof }, null, 2)}\n`);
      await page.screenshot({ path: `.settings-ui-artifacts/invoice-all-teeth-${width}.png`, fullPage: false });
      await page.mouse.click((confirmProof.rect.left + confirmProof.rect.right) / 2, (confirmProof.rect.top + confirmProof.rect.bottom) / 2);
      await dialog.waitFor({ state: "detached" });
      expect(await page.getByTestId("invoice-row-0").getAttribute("data-tooth")).toBe(String(ALL_TEETH.at(-1)));
      expect(writes).toEqual([]);
      for (const table of ["invoices", "payments", "treatment_plans", "clinical_cases"]) {
        expect((await db.query(`SELECT 1 FROM ${table} WHERE patient_id = $1`, [patientId])).rows).toHaveLength(0);
      }
    } catch (error) {
      mkdirSync(".settings-ui-artifacts", { recursive: true });
      await page.screenshot({ path: `.settings-ui-artifacts/invoice-all-teeth-failure-${width}.png`, fullPage: false });
      throw error;
    } finally { await context.close(); }
  }, 120_000);

  it("RCT: clicking 36 and 46 on the chart splits into two lines, each previewing its own case; saved as two items and two cases", async () => {
    const patientId = await newPatient("rct");
    const { context, page } = await openInvoice(patientId);
    await chooseService(page, services.rct);
    const dialog = await pickTeeth(page, 0, [36, 46]);
    expect(await dialog.getAttribute("role")).toBe("dialog");
    expect(await dialog.getAttribute("aria-modal")).toBe("true");
    expect(await dialog.getByTestId("odontogram-tooth-36").getAttribute("aria-pressed")).toBe("true");
    expect(await dialog.getByTestId("tooth-dialog-split-notice").innerText()).toContain("سيُنشأ سطر وحالة مستقلة لكل سن");
    await confirm(page);

    expect(await page.getByTestId("invoice-row-0").getAttribute("data-tooth")).toBe("36");
    expect(await page.getByTestId("invoice-row-1").getAttribute("data-tooth")).toBe("46");
    expect(await page.getByTestId("invoice-split-notice").innerText()).toContain("سيُنشأ سطر وحالة مستقلة لكل سن");
    expect(await page.getByTestId("invoice-tooth-chip-1").innerText()).toContain("سن 46");
    for (const line of [0, 1]) {
      const preview = page.getByTestId(`invoice-clinical-preview-${line}`);
      await preview.filter({ hasText: "سيتم إنشاء حالة أولية تحتاج تقييم الطبيب" }).waitFor();
      expect(await preview.innerText()).toContain("بند خطة جديد");
    }

    // Escape يغلق النافذة دون تغيير السطر
    await page.getByTestId("invoice-tooth-button-0").click();
    await page.getByTestId("tooth-dialog").getByTestId("odontogram-tooth-11").click();
    await page.keyboard.press("Escape");
    await page.getByTestId("tooth-dialog").waitFor({ state: "detached" });
    expect(await page.getByTestId("invoice-row-0").getAttribute("data-tooth")).toBe("36");
    expect(await page.getByTestId("invoice-row-2").count()).toBe(0);

    await page.screenshot({ path: `${SHOTS}/invoice-tooth-rct-desktop.png`, fullPage: true }).catch(() => undefined);
    await save(page);
    expect((await db.query(`SELECT 1 FROM invoices WHERE patient_id = $1`, [patientId])).rows).toHaveLength(1);
    expect((await planItems(patientId)).map((row) => row.tooth_code)).toEqual([36, 46]);
    expect(await cases(patientId)).toEqual([{ specialty: "endodontics", site: "36" }, { specialty: "endodontics", site: "46" }]);
    await context.close();
  });

  it("bridge: 14, 15, 16 on the chart ⇒ three grouped lines carrying the episode, one case", async () => {
    const patientId = await newPatient("bridge");
    const { context, page } = await openInvoice(patientId);
    await chooseService(page, services.bridge);
    const dialog = await pickTeeth(page, 0, [16, 14, 15]);
    expect(await dialog.getByTestId("tooth-dialog-summary").innerText()).toContain("14، 15، 16");
    await confirm(page);
    for (const [line, tooth] of [[0, 14], [1, 15], [2, 16]] as const) {
      expect(await page.getByTestId(`invoice-row-${line}`).getAttribute("data-tooth")).toBe(String(tooth));
      expect(await page.getByTestId(`invoice-tooth-chip-${line}`).innerText()).toContain("جسر/حلقة: 14، 15، 16");
    }
    await page.getByTestId("invoice-clinical-preview-2").waitFor();
    await save(page);
    expect((await planItems(patientId)).map((row) => row.tooth_code)).toEqual([14, 15, 16]);
    const opened = await cases(patientId);
    expect(opened).toHaveLength(1);
    expect(opened[0].specialty).toBe("prosthodontics");
    await context.close();
  });

  it("filling: tooth 26 + surfaces M, O ⇒ plan item surfaces MO", async () => {
    const patientId = await newPatient("filling");
    const { context, page } = await openInvoice(patientId);
    await chooseService(page, services.filling);
    await pickTeeth(page, 0, [26], ["M", "O"]);
    await confirm(page);
    expect(await page.getByTestId("invoice-tooth-chip-0").innerText()).toContain("سن 26 — أسطح MO");
    await page.getByTestId("invoice-clinical-preview-0").waitFor();
    await save(page);
    expect(await planItems(patientId)).toEqual([{ tooth_code: 26, surfaces: "MO" }]);
    await context.close();
  });

  it("ortho: upper arch scope, no tooth chart needed ⇒ case site «الفك العلوي»", async () => {
    const patientId = await newPatient("ortho");
    const { context, page } = await openInvoice(patientId);
    await chooseService(page, services.ortho);
    const row = page.getByTestId("invoice-row-0");
    await row.getByTestId("scope-upper").click();
    expect(await row.getByTestId("scope-upper").getAttribute("aria-pressed")).toBe("true");
    expect(await page.getByTestId("invoice-tooth-button-0").count()).toBe(0);
    await page.locator('[data-testid="invoice-clinical-preview-0"][data-preview-state="ready"]').waitFor();
    expect(await page.getByRole("button", { name: "احفظ الفاتورة" }).isEnabled()).toBe(true);
    await save(page);
    expect(await cases(patientId)).toEqual([{ specialty: "orthodontics", site: "الفك العلوي" }]);
    await context.close();
  });

  it("consultation: no tooth button at all", async () => {
    const patientId = await newPatient("consult");
    const { context, page } = await openInvoice(patientId);
    await chooseService(page, services.consultation);
    await expect.poll(() => page.getByRole("button", { name: "احفظ الفاتورة" }).isEnabled()).toBe(true);
    expect(await page.getByTestId("invoice-tooth-button-0").count()).toBe(0);
    expect(await page.getByTestId("invoice-tooth-control-0").count()).toBe(0);
    await context.close();
  });

  it("RCT without a tooth: save is blocked with an Arabic message and nothing is written", async () => {
    const patientId = await newPatient("blocked");
    const { context, page } = await openInvoice(patientId);
    await chooseService(page, services.rct);
    const blocked = page.getByTestId("invoice-save-blocked");
    await blocked.waitFor();
    expect(await blocked.innerText()).toContain("لا يمكن حفظ الفاتورة قبل تحديد السن");
    expect(await page.getByTestId("invoice-tooth-problem-0").innerText()).toContain("حدّد السن من مخطط الأسنان");
    expect(await page.getByRole("button", { name: "احفظ الفاتورة" }).isDisabled()).toBe(true);
    // ولا يفتح الحفظ بنافذةٍ أُلغيت بلا اختيار
    await page.getByTestId("invoice-tooth-button-0").click();
    expect(await page.getByTestId("tooth-dialog-confirm").isDisabled()).toBe(true);
    await page.getByRole("button", { name: "إلغاء", exact: true }).click();
    expect(await page.getByRole("button", { name: "احفظ الفاتورة" }).isDisabled()).toBe(true);
    expect((await db.query(`SELECT 1 FROM invoices WHERE patient_id = $1`, [patientId])).rows).toHaveLength(0);
    await context.close();
  });

  it("mobile 390×844: the dialog is a full-width sheet, the page never scrolls sideways, confirm works", async () => {
    const patientId = await newPatient("mobile");
    const { context, page } = await openInvoice(patientId, { width: 390, height: 844 });
    await chooseService(page, services.rct);
    await page.getByTestId("invoice-tooth-button-0").click();
    const dialog = page.getByTestId("tooth-dialog");
    await dialog.waitFor();
    const box = await dialog.boundingBox();
    expect(box && box.width <= 390 && box.x >= 0).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    const tooth = dialog.getByTestId("odontogram-tooth-36");
    const toothBox = await tooth.boundingBox();
    expect(toothBox && toothBox.width >= 44 && toothBox.height >= 44).toBe(true);
    await tooth.click();
    const confirmBox = await page.getByTestId("tooth-dialog-confirm").boundingBox();
    expect(confirmBox && confirmBox.height >= 44).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: `${SHOTS}/invoice-tooth-dialog-mobile.png` }).catch(() => undefined);
    await confirm(page);
    expect(await page.getByTestId("invoice-row-0").getAttribute("data-tooth")).toBe("36");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: `${SHOTS}/invoice-tooth-row-mobile.png`, fullPage: true }).catch(() => undefined);
    await context.close();
  });
});
