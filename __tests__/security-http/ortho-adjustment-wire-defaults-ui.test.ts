import { mkdir, writeFile } from "node:fs/promises";
import { Client } from "pg";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { baseUrl, harness } from "./_server";

// Built-app acceptance for the standalone Ortho form, using the existing isolated
// CI harness and real patient/case GETs. Expected POSTs are captured and rejected
// before reaching the server; every other browser mutation/external request is
// blocked. Only synthetic fixture seed INSERTs touch the isolated CI database.
let browser: Browser;
let db: Client;
let h: Awaited<ReturnType<typeof harness>>;
const stamp = Date.now();
const rejected = "رفض تجريبي لحفظ الشدّة؛ لم تُحفظ بيانات";
const definitions = [
  { kind: "ordinary", slot: "022", upperWire: "014 NiTi", lowerWire: "012 NiTi" },
  { kind: "custom", slot: "022", upperWire: "Custom upper wire", lowerWire: "Custom lower wire" },
  { kind: "unset", slot: "022", upperWire: null, lowerWire: null },
  { kind: "terminal", slot: "018", upperWire: "017×025 TMA", lowerWire: "017×025 TMA" },
  { kind: "ongoing", slot: "022", upperWire: "014 NiTi", lowerWire: "012 NiTi",
    regimen: { elastics: "class_ii", elasticNote: "3/16 خفيفة — ليلًا", nextWeeks: 6 } },
  { kind: "baseline", slot: "022", upperWire: "014 NiTi", lowerWire: "012 NiTi",
    baseline: "صنف ثانٍ 3/16 — ليلًا" },
  { kind: "recorded-none", slot: "022", upperWire: "014 NiTi", lowerWire: "012 NiTi",
    baseline: "وصف قديم لا يُعاد تطبيقه", regimen: { elastics: "none", elasticNote: null, nextWeeks: 8 } },
] as const;
type Kind = typeof definitions[number]["kind"];
type Fixture = { patientId: number; caseId: number; slot: string; upperWire: string | null; lowerWire: string | null };
const fixtures = new Map<Kind, Fixture>();

beforeAll(async () => {
  h = await harness();
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const doctor = (await db.query<{ party_id: number }>(
    "SELECT party_id FROM users WHERE username = 'secdoctora'",
  )).rows[0].party_id;
  for (const row of definitions) {
    const patientId = (await db.query<{ id: number }>(
      "INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1, $2, $3) RETURNING id",
      [`WIRE-DEFAULTS-${stamp}-${row.kind}`, `مريض أسلاك تقويم تجريبي ${row.kind}`, doctor],
    )).rows[0].id;
    const caseId = (await db.query<{ id: number }>(
      `INSERT INTO ortho_cases (patient_id, appliance, arches, slot, upper_wire, lower_wire, created_by, baseline_kind, elastics)
       VALUES ($1, 'fixed_metal', 'both', $2, $3, $4, 'synthetic-wire-defaults', $5::text, $6::text) RETURNING id`,
      [patientId, row.slot, row.upperWire, row.lowerWire, "baseline" in row ? "legacy" : null,
        "baseline" in row ? row.baseline : null],
    )).rows[0].id;
    if ("regimen" in row) {
      await db.query(
        `INSERT INTO ortho_adjustments
           (case_id, done_on, upper_wire, lower_wire, elastics, elastic_note, next_weeks, done, recorded_by)
         VALUES ($1, '2026-09-01', $2::text, $3::text, $4, $5::text, $6, 'إجراء سابق للمرجع فقط', 'synthetic-wire-defaults')`,
        [caseId, row.upperWire, row.lowerWire, row.regimen.elastics, row.regimen.elasticNote, row.regimen.nextWeeks],
      );
    }
    fixtures.set(row.kind, { patientId, caseId, slot: row.slot, upperWire: row.upperWire, lowerWire: row.lowerWire });
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

async function storedState(patientId: number) {
  return (await db.query(
    `SELECT
       (SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.id), '[]'::jsonb)
          FROM ortho_cases c WHERE c.patient_id = $1) AS cases,
       (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.id), '[]'::jsonb)
          FROM ortho_adjustments a JOIN ortho_cases c ON c.id = a.case_id WHERE c.patient_id = $1) AS adjustments,
       (SELECT COALESCE(jsonb_agg(to_jsonb(v) ORDER BY v.id), '[]'::jsonb)
          FROM visits v WHERE v.patient_id = $1) AS visits,
       (SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY d.id), '[]'::jsonb)
          FROM patient_documents d WHERE d.patient_id = $1) AS documents,
       (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.id), '[]'::jsonb)
          FROM treatment_plans p WHERE p.patient_id = $1) AS plans,
       (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.id), '[]'::jsonb)
          FROM plan_installments i JOIN treatment_plans p ON p.id = i.plan_id WHERE p.patient_id = $1) AS installments,
       (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.id), '[]'::jsonb)
          FROM payments p WHERE p.patient_id = $1) AS payments,
       (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.id), '[]'::jsonb)
          FROM invoices i WHERE i.patient_id = $1) AS invoices`,
    [patientId],
  )).rows;
}

async function open(width: number, kind: Kind = "ordinary") {
  const fixture = fixtures.get(kind);
  if (!fixture) throw new Error(`Missing synthetic fixture: ${kind}`);
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE",
    timezoneId: "Asia/Aden", serviceWorkers: "block" });
  const [name, ...value] = h.sessions.admin.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const writes: Record<string, unknown>[] = [];
  const unexpected: string[] = [];
  const errors: string[] = [];
  let submitArmed = false;
  const postPath = `/api/ortho/${fixture.caseId}`;
  await context.route("**/*", async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin !== baseUrl) { unexpected.push(`${request.method()} ${url.origin}${url.pathname}`); await route.abort(); return; }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      if (submitArmed && request.method() === "POST" && url.pathname === postPath && url.search === "") {
        submitArmed = false;
        writes.push(request.postDataJSON() as Record<string, unknown>);
        await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ message: rejected }) });
        return;
      }
      unexpected.push(`${request.method()} ${url.pathname}`);
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ message: "Unexpected synthetic command blocked" }) });
      return;
    }
    await route.continue();
  });
  const page = await context.newPage(); page.on("pageerror", (error) => errors.push(error.message));
  try {
    const [caseResponse] = await Promise.all([
      page.waitForResponse((response) => response.request().method() === "GET"
        && new URL(response.url()).origin === baseUrl
        && new URL(response.url()).pathname === "/api/ortho"
        && new URL(response.url()).searchParams.get("patientId") === String(fixture.patientId)),
      page.goto(`${baseUrl}/patients/${fixture.patientId}?tab=ortho`),
    ]);
    expect(caseResponse.status()).toBe(200);
    const payload = await caseResponse.json() as { cases: Array<{ id: number; upperWire: string | null; lowerWire: string | null; slot: string }> };
    expect(payload.cases.find((row) => row.id === fixture.caseId)).toMatchObject({
      upperWire: fixture.upperWire, lowerWire: fixture.lowerWire, slot: fixture.slot,
    });
    await page.getByRole("button", { name: "⚡ سجّل شدّة وجلسة جديدة الآن", exact: true }).click();
    const upper = page.getByRole("combobox", { name: "السلك العلوي", exact: true });
    const lower = page.getByRole("combobox", { name: "السلك السفلي", exact: true });
    await upper.waitFor(); await lower.waitFor();
    const form = page.locator("form").filter({ has: upper });
    expect(await form.count()).toBe(1);
    const note = form.getByRole("textbox", { name: "ما نُفّذ في الشدّة", exact: true });
    const save = form.getByRole("button", { name: "احفظ الشدّة والصور", exact: true });
    return { context, page, fixture, form, upper, lower, note, save, writes,
      submit: async () => {
        const expected = writes.length + 1;
        submitArmed = true;
        await save.click();
        await expect.poll(() => writes.length).toBe(expected);
        await page.getByRole("alert").filter({ hasText: rejected }).waitFor();
        await expect.poll(() => save.isEnabled()).toBe(true);
        expect(submitArmed).toBe(false);
      },
      assertSafe: () => { expect(unexpected).toEqual([]); expect(errors).toEqual([]); },
    };
  } catch (error) { await context.close(); throw error; }
}

async function expectSelected(control: Locator, value: string | null) {
  // Inspect actual native DOM state/text, not only React's controlled value.
  await expect.poll(() => control.inputValue()).toBe(value ?? "");
  const selected = await control.evaluate((element) => Array.from((element as HTMLSelectElement).selectedOptions)
    .map((option) => ({ value: option.value, text: option.textContent })));
  expect(selected).toEqual([{ value: value ?? "", text: value ?? "— بلا تغيير —" }]);
}

async function captureWires(page: Page, upper: Locator, lower: Locator, width: number) {
  expect(await page.locator("html").getAttribute("dir")).toBe("rtl");
  await page.evaluate(async () => { await document.fonts.ready; });
  const row = upper.locator("../..");
  await row.evaluate((element) => element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await row.evaluate((element) => getComputedStyle(element).direction)).toBe("rtl");
  const bounds = [];
  for (const control of [upper, lower]) {
    const geometry = await control.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const points = [[rect.left + 3, rect.top + 3], [rect.right - 3, rect.top + 3],
        [rect.left + 3, rect.bottom - 3], [rect.right - 3, rect.bottom - 3],
        [rect.left + rect.width / 2, rect.top + rect.height / 2]];
      return { label: element.getAttribute("aria-label"), left: rect.left, right: rect.right,
        top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height,
        viewport: { width: innerWidth, height: innerHeight },
        hits: points.map(([x, y]) => { const hit = document.elementFromPoint(x, y); return hit !== null && (hit === element || element.contains(hit)); }) };
    });
    expect(geometry.width).toBeGreaterThan(100); expect(geometry.height).toBeGreaterThan(20);
    expect(geometry.left).toBeGreaterThanOrEqual(0); expect(geometry.top).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewport.width);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewport.height);
    expect(geometry.hits).toEqual([true, true, true, true, true]);
    bounds.push(geometry);
  }
  await mkdir(".settings-ui-artifacts", { recursive: true });
  await writeFile(`.settings-ui-artifacts/ortho-adjustment-current-wires-${width}-bounds.json`, JSON.stringify(bounds, null, 2));
  await page.screenshot({ path: `.settings-ui-artifacts/ortho-adjustment-current-wires-${width}.png` });
}

describe("standalone orthodontic wire defaults in the real RTL form", () => {
  it.each([1280, 390])("preserves notes-only wires and changes only an explicitly selected arch at %ipx", async (width) => {
    const fixture = fixtures.get("ordinary")!;
    const before = await storedState(fixture.patientId);
    const f = await open(width);
    try {
      await expectSelected(f.upper, "014 NiTi"); await expectSelected(f.lower, "012 NiTi");
      expect(await f.note.inputValue()).toBe(""); expect(f.writes).toEqual([]);
      await captureWires(f.page, f.upper, f.lower, width);
      await f.note.fill("مراجعة اليوم دون تغيير الأسلاك");
      await f.submit();
      expect(f.writes).toHaveLength(1);
      expect(f.writes[0]).toMatchObject({ upperWire: "014 NiTi", lowerWire: "012 NiTi", done: "مراجعة اليوم دون تغيير الأسلاك" });
      await expectSelected(f.upper, "014 NiTi"); await expectSelected(f.lower, "012 NiTi");
      expect(await f.note.inputValue()).toBe("مراجعة اليوم دون تغيير الأسلاك");
      if (width === 1280) await f.upper.selectOption("016 NiTi");
      else await f.lower.selectOption("014 NiTi");
      const chosen = width === 1280 ? { upperWire: "016 NiTi", lowerWire: "012 NiTi" }
        : { upperWire: "014 NiTi", lowerWire: "014 NiTi" };
      await expectSelected(f.upper, chosen.upperWire); await expectSelected(f.lower, chosen.lowerWire);
      await f.note.fill("اختيار صريح لسلك فك واحد");
      await f.submit();
      expect(f.writes).toHaveLength(2);
      expect(f.writes[1]).toMatchObject({ ...chosen, done: "اختيار صريح لسلك فك واحد" });
      f.assertSafe(); expect(await storedState(fixture.patientId)).toEqual(before);
    } finally { await f.context.close(); }
  });

  it.each(["custom", "unset", "terminal"] as const)("displays and submits the actual %s wire values without silent replacement", async (kind) => {
    const fixture = fixtures.get(kind)!;
    const before = await storedState(fixture.patientId);
    const f = await open(390, kind);
    try {
      await expectSelected(f.upper, fixture.upperWire); await expectSelected(f.lower, fixture.lowerWire);
      await f.note.fill("توثيق تجريبي دون تغيير السلك");
      await f.submit();
      expect(f.writes).toHaveLength(1);
      expect(f.writes[0]).toMatchObject({ upperWire: fixture.upperWire ?? "", lowerWire: fixture.lowerWire ?? "", done: "توثيق تجريبي دون تغيير السلك" });
      await f.lower.selectOption(kind === "unset" ? "012 NiTi" : "");
      await f.submit();
      expect(f.writes).toHaveLength(2);
      expect(f.writes[1]).toMatchObject({ upperWire: fixture.upperWire ?? "", lowerWire: kind === "unset" ? "012 NiTi" : "" });
      f.assertSafe(); expect(await storedState(fixture.patientId)).toEqual(before);
    } finally { await f.context.close(); }
  });
});


async function captureRegimen(f: Awaited<ReturnType<typeof open>>, width: number, kind: "ongoing" | "baseline") {
  await f.page.evaluate(async () => { await document.fonts.ready; });
  await f.form.evaluate((element) => element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
  await f.page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const bounds = [];
  for (const label of ["صنف المطاطات", "وصف المطاطات", "أسابيع حتى الشدّة القادمة"]) {
    const control = f.form.getByLabel(label, { exact: true });
    const geometry = await control.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const points = [[rect.left + 3, rect.top + 3], [rect.right - 3, rect.top + 3],
        [rect.left + 3, rect.bottom - 3], [rect.right - 3, rect.bottom - 3],
        [rect.left + rect.width / 2, rect.top + rect.height / 2]];
      return { label: element.getAttribute("aria-label"), left: rect.left, right: rect.right,
        top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height,
        viewport: { width: innerWidth, height: innerHeight },
        hits: points.map(([x, y]) => { const hit = document.elementFromPoint(x, y); return hit !== null && (hit === element || element.contains(hit)); }) };
    });
    expect(geometry.width).toBeGreaterThan(70); expect(geometry.height).toBeGreaterThan(20);
    expect(geometry.left).toBeGreaterThanOrEqual(0); expect(geometry.top).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewport.width);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewport.height);
    expect(geometry.hits).toEqual([true, true, true, true, true]);
    bounds.push(geometry);
  }
  expect(await f.page.locator("html").getAttribute("dir")).toBe("rtl");
  expect(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await mkdir(".settings-ui-artifacts", { recursive: true });
  const name = `ortho-regimen-${kind}-${width}`;
  await writeFile(`.settings-ui-artifacts/${name}-bounds.json`, JSON.stringify(bounds, null, 2));
  await f.page.screenshot({ path: `.settings-ui-artifacts/${name}.png` });
}

describe("standalone orthodontic regimen continuity in the real RTL form", () => {
  it.each([1280, 390])("keeps the saved regimen and interval until explicitly changed at %ipx", async (width) => {
    const target = fixtures.get("ongoing")!; const before = await storedState(target.patientId);
    const f = await open(width, "ongoing");
    try {
      const elasticClass = f.form.getByLabel("صنف المطاطات", { exact: true });
      const description = f.form.getByLabel("وصف المطاطات", { exact: true });
      const interval = f.form.getByLabel("أسابيع حتى الشدّة القادمة", { exact: true });
      expect(await elasticClass.inputValue()).toBe("class_ii");
      expect(await elasticClass.locator("option:checked").textContent()).toBe("صنف ثانٍ");
      expect(await description.inputValue()).toBe("3/16 خفيفة — ليلًا");
      expect(await interval.inputValue()).toBe("6"); expect(await f.note.inputValue()).toBe("");
      await captureRegimen(f, width, "ongoing");
      await f.note.fill("مراجعة اليوم دون تغيير المطاطات"); await f.submit();
      expect(f.writes[0]).toMatchObject({ upperWire: "014 NiTi", lowerWire: "012 NiTi", elastics: "class_ii",
        elasticNote: "3/16 خفيفة — ليلًا", nextWeeks: 6, done: "مراجعة اليوم دون تغيير المطاطات" });
      expect(await elasticClass.inputValue()).toBe("class_ii"); expect(await interval.inputValue()).toBe("6");
      await f.submit(); expect(f.writes[1]).toEqual(f.writes[0]);
      await elasticClass.selectOption("none"); await interval.fill("2"); await f.submit();
      expect(f.writes[2]).toMatchObject({ elastics: "none", elasticNote: "", nextWeeks: 2 });
      f.assertSafe(); expect(await storedState(target.patientId)).toEqual(before);
    } finally { await f.context.close(); }
  });

  it.each([1280, 390])("makes baseline classification explicit without losing its saved description at %ipx", async (width) => {
    const target = fixtures.get("baseline")!; const before = await storedState(target.patientId);
    const f = await open(width, "baseline");
    try {
      const elasticClass = f.form.getByLabel("صنف المطاطات", { exact: true });
      expect(await elasticClass.inputValue()).toBe("");
      expect(await elasticClass.locator("option:checked").textContent()).toContain("اختر الصنف");
      expect(await f.form.getByLabel("وصف المطاطات", { exact: true }).inputValue()).toBe("صنف ثانٍ 3/16 — ليلًا");
      expect(await f.form.getByTestId("adjustment-baseline-elastics").textContent()).toContain("لا يُستنتج الصنف");
      expect(await f.note.inputValue()).toBe(""); await captureRegimen(f, width, "baseline");
      await f.save.click();
      expect(await elasticClass.evaluate((element) => (element as HTMLSelectElement).validity.valueMissing)).toBe(true);
      expect(f.writes).toEqual([]);
      await elasticClass.selectOption(width === 1280 ? "class_ii" : "none"); await f.submit();
      expect(f.writes[0]).toMatchObject(width === 1280
        ? { elastics: "class_ii", elasticNote: "صنف ثانٍ 3/16 — ليلًا", done: "" }
        : { elastics: "none", elasticNote: "", done: "" });
      f.assertSafe(); expect(await storedState(target.patientId)).toEqual(before);
    } finally { await f.context.close(); }
  });

  it("preserves a recorded none and its interval over the older baseline description", async () => {
    const target = fixtures.get("recorded-none")!; const before = await storedState(target.patientId);
    const f = await open(390, "recorded-none");
    try {
      expect(await f.form.getByLabel("صنف المطاطات", { exact: true }).inputValue()).toBe("none");
      expect(await f.form.getByLabel("أسابيع حتى الشدّة القادمة", { exact: true }).inputValue()).toBe("8");
      expect(await f.form.getByTestId("adjustment-baseline-elastics").count()).toBe(0);
      await f.submit(); expect(f.writes[0]).toMatchObject({ elastics: "none", elasticNote: "", nextWeeks: 8, done: "" });
      f.assertSafe(); expect(await storedState(target.patientId)).toEqual(before);
    } finally { await f.context.close(); }
  });
});
