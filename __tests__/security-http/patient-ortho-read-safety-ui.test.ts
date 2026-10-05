import { mkdir, writeFile } from "node:fs/promises";
import { Client } from "pg";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { baseUrl, harness } from "./_server";

// Built Next/React acceptance on the existing isolated aqlan_sec_http harness.
// Seeded records are synthetic; initial/retry reads hit the actual HTTP routes.
// Selected read failures and one explicitly armed rejected submission are
// intercepted. No browser mutation is sent to the server. This is UI ownership
// evidence, not a substitute for route authorization/integrity tests.
let h: Awaited<ReturnType<typeof harness>>;
let db: Client; let browser: Browser; let patientId: number; let caseId: number;
const marker = "SYNTHETIC-ORTHO-READ-GRANT";
const draftText = "مسودة شدّة اصطناعية محفوظة عند تعذّر القراءة";
const rejected = "رفض تجريبي للحفظ؛ لم تُحفظ بيانات";
beforeAll(async () => {
  h = await harness();
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  const doctor = (await db.query<{ party_id: number }>("SELECT party_id FROM users WHERE username='secdoctora'")).rows[0].party_id;
  patientId = (await db.query<{ id: number }>(
    "INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1,$2,$3) RETURNING id",
    [`ORTHO-READ-${Date.now()}`, "مريض قراءة تقويم اصطناعي — ليس حقيقياً", doctor],
  )).rows[0].id;
  caseId = (await db.query<{ id: number }>(
    `INSERT INTO ortho_cases (patient_id, appliance, arches, slot, upper_wire, lower_wire, bracket_system, created_by)
     VALUES ($1,'fixed_metal','both','022','014 NiTi','012 NiTi',$2,'synthetic-ortho-read-ui') RETURNING id`,
    [patientId, marker],
  )).rows[0].id;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  await mkdir(".settings-ui-artifacts", { recursive: true });
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

async function storedState() {
  // Full row equality, including metadata, is deliberately stronger than counts.
  return (await db.query(`SELECT
    (SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.id),'[]'::jsonb) FROM ortho_cases c WHERE c.patient_id=$1) AS cases,
    (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb) FROM ortho_adjustments a JOIN ortho_cases c ON c.id=a.case_id WHERE c.patient_id=$1) AS adjustments,
    (SELECT COALESCE(jsonb_agg(to_jsonb(v) ORDER BY v.id),'[]'::jsonb) FROM visits v WHERE v.patient_id=$1) AS visits,
    (SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY d.id),'[]'::jsonb) FROM patient_documents d WHERE d.patient_id=$1) AS documents,
    (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]'::jsonb) FROM treatment_plans p WHERE p.patient_id=$1) AS plans,
    (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.id),'[]'::jsonb) FROM plan_installments i JOIN treatment_plans p ON p.id=i.plan_id WHERE p.patient_id=$1) AS installments,
    (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]'::jsonb) FROM payments p WHERE p.patient_id=$1) AS payments,
    (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.id),'[]'::jsonb) FROM invoices i WHERE i.patient_id=$1) AS invoices,
    (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb) FROM appointments a WHERE a.patient_id=$1) AS appointments`, [patientId])).rows;
}
type Fault = { endpoint: "ortho" | "patient"; status: 401 | 403 | 503 } | null;
const workspace = (page: Page) => page.locator('[data-testid="patient-ortho-workspace"]');
async function readState(page: Page, expected: string) {
  await expect.poll(() => workspace(page).getAttribute("data-read-state")).toBe(expected);
}
async function hidden(page: Page) {
  const view = workspace(page);
  expect(await view.locator("form,input,textarea,select,img,a[href]").count()).toBe(0);
  const html = await view.innerHTML(); expect(html).not.toContain(marker); expect(html).not.toContain(draftText);
  expect(await view.getByRole("button", { name: /سجّل شدّة وجلسة جديدة الآن/ }).count()).toBe(0);
}
async function open(width: number) {
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 },
    locale: "ar-YE", timezoneId: "Asia/Aden", serviceWorkers: "block" });
  const [name, ...value] = h.sessions.admin.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  let fault: Fault = null; let armed = false;
  const reads = { ortho: 0, patient: 0 }; const submitted: Record<string, unknown>[] = [];
  const unexpected: string[] = []; const errors: string[] = [];
  await context.route("**/*", async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin !== baseUrl) { unexpected.push(`${request.method()} ${url.origin}${url.pathname}`); await route.abort(); return; }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      if (armed && request.method() === "POST" && url.pathname === `/api/ortho/${caseId}` && url.search === "") {
        armed = false; submitted.push(request.postDataJSON() as Record<string, unknown>);
        await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ message: rejected }) }); return;
      }
      unexpected.push(`${request.method()} ${url.pathname}`);
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ message: "Synthetic write blocked" }) }); return;
    }
    const endpoint = request.method() === "GET" && url.pathname === "/api/ortho" && url.searchParams.get("patientId") === String(patientId)
      ? "ortho" : request.method() === "GET" && url.pathname === `/api/patients/${patientId}` && url.search === "" ? "patient" : null;
    if (endpoint) {
      reads[endpoint]++;
      if (fault?.endpoint === endpoint) {
        await route.fulfill({ status: fault.status, contentType: "application/json", body: JSON.stringify({ message: "Synthetic selected read failure" }) }); return;
      }
    }
    await route.continue();
  });
  const page = await context.newPage(); page.on("pageerror", (error) => errors.push(error.message));
  try {
    const [response] = await Promise.all([
      page.waitForResponse((one) => one.request().method() === "GET" && new URL(one.url()).pathname === "/api/ortho"
        && new URL(one.url()).searchParams.get("patientId") === String(patientId)),
      page.goto(`${baseUrl}/patients/${patientId}?tab=ortho`, { waitUntil: "domcontentloaded" }),
    ]);
    expect(response.status()).toBe(200);
    const payload = await response.json() as { cases: Array<{ id: number; patientId: number; bracketSystem: string }> };
    expect(payload.cases.find((one) => one.id === caseId)).toMatchObject({ patientId, bracketSystem: marker });
    await readState(page, "ready");
    return { context, page, reads, submitted, setFault: (next: Fault) => { fault = next; },
      arm: () => { armed = true; }, assertIsolated: () => {
        expect(unexpected).toEqual([]); expect(errors).toEqual([]); expect(armed).toBe(false);
      } };
  } catch (error) { await context.close(); throw error; }
}
async function captureRetry(page: Page, width: number) {
  const retry = workspace(page).getByRole("button", { name: "إعادة تحميل كابينة التقويم", exact: true });
  await retry.evaluate((element) => element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
  await page.evaluate(async () => { await document.fonts.ready; });
  const geometry = await retry.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const radii = [style.borderTopLeftRadius, style.borderTopRightRadius,
      style.borderBottomLeftRadius, style.borderBottomRightRadius];
    const transforms = [];
    for (let node: Element | null = element; node !== null; node = node.parentElement) {
      const css = getComputedStyle(node);
      transforms.push({ tag: node.tagName, transform: css.transform,
        translate: css.getPropertyValue("translate"), rotate: css.getPropertyValue("rotate"),
        scale: css.getPropertyValue("scale"), zoom: css.getPropertyValue("zoom") });
    }
    const untransformed = transforms.every((css) => css.transform === "none"
      && [css.translate, css.rotate, css.scale].every((value) => value === "" || value === "none")
      && ["", "1", "normal"].includes(css.zoom));
    // This control has one circular rounded-xl radius. Refuse other shapes
    // instead of moving probes until an occluded point happens to pass.
    const supportedShape = radii.every((value) => /^\d+(?:\.\d+)?px$/.test(value) && value === radii[0])
      && untransformed && style.clipPath === "none";
    const radius = Math.min(Number.parseFloat(radii[0]), rect.width / 2, rect.height / 2);
    const insidePaintedShape = (x: number, y: number) => {
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return false;
      const dx = Math.max(rect.left + radius - x, 0, x - (rect.right - radius));
      const dy = Math.max(rect.top + radius - y, 0, y - (rect.bottom - radius));
      return dx * dx + dy * dy <= radius * radius;
    };
    const describe = (hit: Element | null) => hit === null ? null : ({
      tag: hit.tagName, id: hit.id, role: hit.getAttribute("role"), testId: hit.getAttribute("data-testid"),
      classes: hit.getAttribute("class")?.slice(0, 200) ?? null,
    });
    const inspect = ([x, y]: number[]) => {
      const hit = document.elementFromPoint(x, y);
      return { x, y, insidePaintedShape: insidePaintedShape(x, y),
        hit: hit !== null && (hit === element || element.contains(hit)), target: describe(hit),
        stack: document.elementsFromPoint(x, y).slice(0, 4).map(describe) };
    };
    const originalPoints = [[rect.left + 3, rect.top + 3], [rect.right - 3, rect.top + 3],
      [rect.left + 3, rect.bottom - 3], [rect.right - 3, rect.bottom - 3],
      [rect.left + rect.width / 2, rect.top + rect.height / 2]];
    // At a circular corner the diagonal reaches the curve at r*(1-1/sqrt(2)).
    // Keep all four near-corner probes 2px further inside, plus the center.
    const inset = Math.max(3, radius * (1 - Math.SQRT1_2) + 2);
    const points = [[rect.left + inset, rect.top + inset], [rect.right - inset, rect.top + inset],
      [rect.left + inset, rect.bottom - inset], [rect.right - inset, rect.bottom - inset],
      [rect.left + rect.width / 2, rect.top + rect.height / 2]];
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, height: rect.height,
      width: rect.width, viewportWidth: innerWidth, viewportHeight: innerHeight,
      dir: document.documentElement.getAttribute("dir"), noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth + 1,
      radii, radius, inset, supportedShape, transforms, clipPath: style.clipPath,
      original: originalPoints.map(inspect), painted: points.map(inspect) };
  });
  // Preserve the actual failure state before any fatal geometry assertion.
  // Exactly two synthetic viewport images and two JSON records are allowed.
  const artifact = `.settings-ui-artifacts/patient-ortho-parent-read-safety-${width}`;
  await writeFile(`${artifact}-bounds.json`, `${JSON.stringify(geometry, null, 2)}\n`);
  await page.screenshot({ path: `${artifact}.png` });
  expect(geometry.dir).toBe("rtl"); expect(geometry.noHorizontalOverflow).toBe(true);
  expect(geometry.width).toBeGreaterThan(100); expect(geometry.height).toBeGreaterThanOrEqual(44);
  expect(geometry.left).toBeGreaterThanOrEqual(0); expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth); expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
  expect(geometry.supportedShape).toBe(true);
  expect(geometry.painted.map((point) => point.insidePaintedShape)).toEqual([true, true, true, true, true]);
  expect(geometry.painted.map((point) => point.hit)).toEqual([true, true, true, true, true]);
  // Original probes remain fatal whenever they are inside the painted control.
  expect(geometry.original.every((point) => !point.insidePaintedShape || point.hit)).toBe(true);
}

describe("PatientOrtho parent-read safety on the real built RTL patient page", () => {
  it.each([1280, 390])("hides denied/failed clinical content, restores an opaque draft and retries by keyboard at %ipx", async (width) => {
    const before = await storedState(); const f = await open(width);
    try {
      const view = workspace(f.page);
      await view.getByRole("button", { name: /سجّل شدّة وجلسة جديدة الآن/ }).click();
      const note = view.getByLabel("ما نُفّذ في الشدّة", { exact: true }); await note.fill(draftText);
      await view.getByLabel("أسابيع حتى الشدّة القادمة", { exact: true }).fill("7");
      const expected = await view.locator("input:not([type=file]),select").evaluateAll((elements) => elements.map((element) => ({
        label: element.getAttribute("aria-label"), value: (element as HTMLInputElement).value,
      })));
      for (const fault of [{ endpoint: "ortho", status: 503 }, { endpoint: "ortho", status: 401 },
        { endpoint: "ortho", status: 403 }, { endpoint: "patient", status: 401 }, { endpoint: "patient", status: 403 }] as const) {
        const prior = { ...f.reads }; f.setFault(fault);
        await view.getByRole("button", { name: "تحديث كابينة التقويم", exact: true }).click();
        await readState(f.page, fault.status === 503 ? "error" : "denied"); await hidden(f.page);
        // Native AbortController may cancel the peer before it reaches route
        // interception; the deferred real-React fixture proves paired issuance.
        await expect.poll(() => f.reads[fault.endpoint]).toBeGreaterThan(prior[fault.endpoint]);
        expect(f.submitted).toHaveLength(0);
        if (fault.endpoint === "patient" && fault.status === 403) await captureRetry(f.page, width);
        f.setFault(null);
        await view.getByRole("button", { name: "إعادة تحميل كابينة التقويم", exact: true }).focus();
        await f.page.keyboard.press("Enter"); await readState(f.page, "ready");
        expect(await view.locator("input:not([type=file]),select").evaluateAll((elements) => elements.map((element) => ({
          label: element.getAttribute("aria-label"), value: (element as HTMLInputElement).value,
        })))).toEqual(expected);
      }
      // An optional contact read failure must not erase valid clinical data.
      f.setFault({ endpoint: "patient", status: 503 });
      await view.getByRole("button", { name: "تحديث كابينة التقويم", exact: true }).click();
      await readState(f.page, "ready"); await expect.poll(() => view.textContent()).toContain("الحجز والتذكير متوقفان");
      expect(await note.inputValue()).toBe(draftText); expect(await view.textContent()).toContain(marker);
      f.setFault(null); await view.getByRole("button", { name: "تحديث كابينة التقويم", exact: true }).click(); await readState(f.page, "ready");
      f.arm(); await view.getByRole("button", { name: "احفظ الشدّة والصور", exact: true }).click();
      await expect.poll(() => f.submitted.length).toBe(1);
      await view.getByRole("alert").filter({ hasText: rejected }).waitFor();
      expect(f.submitted[0]).toMatchObject({ done: draftText, upperWire: "014 NiTi", lowerWire: "012 NiTi", nextWeeks: 7 });
      expect(await note.inputValue()).toBe(draftText);
      f.assertIsolated(); expect(await storedState()).toEqual(before);
    } finally { await f.context.close(); }
  });
});
