import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { Client } from "pg";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authedGet, authedMutation, baseUrl, harness } from "./_server";
import { assertOrthoViewportBounds, orthoViewportProof, revealOrthoControlByWheel } from "./_ortho-strategy-ui-fixture";

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let browser: Browser;
let patientId = 0, doctorId = 0;
const stamp = Date.now();
const serviceIds = new Map<string, number>();
const categories = [
  ["constructor", "constructor"], ["Constructor", "Constructor"],
  ["toString", "toString"], ["__proto__", "__proto__"],
  ["hasOwnProperty", "hasOwnProperty"], ["custom_raw", "custom_raw"],
  ["endo", "endo"], ["rct", "علاج جذور"],
] as const;

beforeAll(async () => {
  h = await harness();
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  const config = JSON.stringify({ calculationMode: "percentage", defaultPercent: 17,
    deductLabCost: false, deductMaterialCost: false, basis: "invoiced" });
  const { rows: [party] } = await db.query<{ id: number }>(
    "INSERT INTO parties (name, kind, commission_percent) VALUES ($1, 'doctor', 17) RETURNING id", [`طبيب عرض الفئات ${stamp}`]);
  doctorId = party.id;
  await db.query(`INSERT INTO users (username, display_name, password_hash, role, party_id, commission_config)
    VALUES ($1, $1, 'unused-synthetic-hash', 'doctor', $2, $3)`, [`label-${stamp}`, doctorId, config]);
  await db.query(`INSERT INTO doctor_commission_history (party_id, percent, config, effective_from, source, reason, recorded_by)
    VALUES ($1, 17, $2::jsonb, '1970-01-01', 'baseline', 'synthetic existing policy', 'test')`, [doctorId, config]);
  const { rows: [patient] } = await db.query<{ id: number }>(
    "INSERT INTO patients (patient_number, full_name) VALUES ($1, 'مريض عرض الفئات الاصطناعي') RETURNING id", [`LABEL-${stamp}`]);
  patientId = patient.id;
  for (const [category] of categories) {
    const response = await authedMutation("/api/services", h.sessions.admin, "POST",
      JSON.stringify({ name: `خدمة عرض ${category} ${stamp}`, category, price: "10000" }));
    expect(response.status).toBe(201);
    const service = await response.json() as { id: number; category: string };
    serviceIds.set(category, service.id); expect(service.category).toBe(category);
    const { rows: [invoice] } = await db.query<{ id: number }>(`INSERT INTO invoices
      (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by, created_at)
      VALUES ($1, $2, 10000, 0, 'YER', 'test', '2024-06-10 09:00+03') RETURNING id`, [`LABEL-${category}-${stamp}`, patientId]);
    const { rows: [visit] } = await db.query<{ id: number }>(`INSERT INTO visits
      (patient_name, patient_id, doctor_id, status, invoice_id, arrived_at, signed_at, signed_by)
      VALUES ('مريض عرض الفئات الاصطناعي', $1, $2, 'done', $3, '2024-06-10 09:00+03', '2024-06-10 09:00+03', 'test') RETURNING id`,
    [patientId, doctorId, invoice.id]);
    const { rows: [procedure] } = await db.query<{ id: number }>(`INSERT INTO visit_procedures
      (visit_id, service_id, doctor_id, quantity, unit_price_minor) VALUES ($1, $2, $3, 1, 10000) RETURNING id`,
    [visit.id, service.id, doctorId]);
    await db.query(`INSERT INTO invoice_items
      (invoice_id, service_id, description, quantity, unit_price_minor, total_minor, doctor_id, source_type, source_id)
      VALUES ($1, $2, 'عمل فئة خام', 1, 10000, 10000, $3, 'visit_procedure', $4)`, [invoice.id, service.id, doctorId, procedure.id]);
  }
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
}, 240_000);

afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    try {
      // Retire only this file's catalogue fixtures; preserve all historical facts.
      if (serviceIds.size) await db.query("UPDATE services SET is_active = false WHERE id = ANY($1::int[])", [[...serviceIds.values()]]);
    } finally { await db?.end(); }
  }
});

async function facts() {
  return (await db.query(`SELECT jsonb_build_object(
    'config', (SELECT commission_config FROM users WHERE party_id=$1),
    'history', (SELECT jsonb_agg(to_jsonb(h) ORDER BY id) FROM doctor_commission_history h WHERE party_id=$1),
    'invoices', (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invoices i WHERE patient_id=$2),
    'items', (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM invoice_items i JOIN invoices v ON v.id=i.invoice_id WHERE v.patient_id=$2),
    'visits', (SELECT jsonb_agg(to_jsonb(v) ORDER BY id) FROM visits v WHERE patient_id=$2),
    'procedures', (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM visit_procedures p JOIN visits v ON v.id=p.visit_id WHERE v.patient_id=$2),
    'payments', (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY id), '[]') FROM payments p WHERE patient_id=$2)
  ) AS facts`, [doctorId, patientId])).rows;
}

describe("reachable raw category labels on the actual built app", () => {
  it.each(categories)("returns %s as the correct string label without changing financial facts", async (category, label) => {
    const before = await facts();
    const response = await authedGet(`/api/finance/commissions?detail=1&from=2024-01-01&to=2024-12-31&doctorId=${doctorId}`, h.sessions.admin);
    expect(response.status).toBe(200);
    const body = await response.json() as { lines: Array<{ serviceId: number; category: string; categoryLabel: string; percent: number; accruedMinor: number; earnedMinor: number }> };
    const matching = body.lines.filter(line => line.serviceId === serviceIds.get(category));
    expect(matching).toHaveLength(1);
    expect(matching[0]).toMatchObject({ category, categoryLabel: label, percent: 17, accruedMinor: 1700, earnedMinor: 1700 });
    expect(typeof matching[0].categoryLabel).toBe("string");
    expect(await facts()).toEqual(before);
  });

  it.each([1280, 390])("selects raw prototype-named services in the real patient Account at RTL %ipx with zero writes", async width => {
    const context = await browser.newContext({ viewport: { width, height: 844 } });
    const [name, ...value] = h.sessions.admin.cookie.split("=");
    await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    const page = await context.newPage(); const errors: string[] = [], writes: string[] = [];
    const blockedRequests: Array<Record<string, unknown>> = [];
    const initiators: Array<Record<string, unknown>> = [];
    const safePath = (raw: string) => {
      try { const url = new URL(raw); return { sameOrigin: url.origin === baseUrl, path: url.pathname.slice(0, 240) }; }
      catch { return { sameOrigin: false, path: "unavailable" }; }
    };
    const requestWitness = () => ({ protocol: "AQLAN_RAW_CATEGORY_REQUESTS_V1", acceptance: false,
      head: process.env.GITHUB_SHA ?? null, run: process.env.GITHUB_RUN_ID ?? null,
      attempt: process.env.GITHUB_RUN_ATTEMPT ?? null, width, blockedRequests, initiators });
    // Bounded, read-only CDP request initiators. Never retain headers, cookies,
    // query strings, bodies, stacks' arguments or unbounded page text.
    let observationTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([(async () => {
        const cdp = await context.newCDPSession(page);
        cdp.on("Network.requestWillBeSent", (event: { request: { method: string; url: string };
          initiator?: { type?: string; stack?: { callFrames?: Array<{ url: string; lineNumber: number; columnNumber: number }> } } }) => {
          if (["GET", "HEAD"].includes(event.request.method) || initiators.length >= 8) return;
          initiators.push({ method: event.request.method, ...safePath(event.request.url),
            type: event.initiator?.type ?? "unknown",
            frames: (event.initiator?.stack?.callFrames ?? []).slice(0, 4).map(frame => ({
              ...safePath(frame.url), line: frame.lineNumber, column: frame.columnNumber,
            })) });
        });
        await cdp.send("Network.enable");
      })(), new Promise<never>((_, reject) => {
        observationTimer = setTimeout(() => reject(new Error("Bounded request observation did not start")), 2000);
      })]);
    } catch (error) {
      await context.close(); throw error;
    } finally { clearTimeout(observationTimer); }
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", async route => {
      const request = route.request();
      if (!["GET", "HEAD"].includes(request.method())) {
        // Abort first. Diagnostics cannot accidentally let a request reach the server.
        writes.push(request.method()); await route.abort();
        if (blockedRequests.length < 8) {
          const raw = request.postData() ?? "";
          let shape: Record<string, unknown> = { json: false };
          if (raw.length <= 16_384) {
            try {
              const body: unknown = JSON.parse(raw);
              if (body && typeof body === "object" && !Array.isArray(body)) {
                const value = body as Record<string, unknown>;
                shape = { json: true, keys: Object.keys(value).sort().slice(0, 24),
                  ownsSyntheticPatient: value.patientId === patientId,
                  items: Array.isArray(value.items) ? value.items.slice(0, 8).map(item => {
                    if (!item || typeof item !== "object") return { shape: "non-object" };
                    const row = item as Record<string, unknown>;
                    return { keys: Object.keys(row).sort().slice(0, 24),
                      syntheticServiceCategory: [...serviceIds].find(([, id]) => id === row.serviceId)?.[0] ?? "not-owned" };
                  }) : null };
              }
            } catch { /* Body format is diagnostic only; every request still fails the guard. */ }
          }
          blockedRequests.push({ method: request.method(), ...safePath(request.url()),
            resourceType: request.resourceType(), navigation: request.isNavigationRequest(),
            bodyBytes: Buffer.byteLength(raw), bodySha256: createHash("sha256").update(raw).digest("hex"), shape });
        }
        return;
      }
      if (new URL(request.url()).origin !== new URL(baseUrl).origin) { await route.abort(); return; }
      await route.continue();
    });
    const before = await facts();
    try {
      await page.goto(`${baseUrl}/patients/${patientId}?tab=account`, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "فاتورة يدوية", exact: true }).click();
      const invoice = page.getByRole("region", { name: "فاتورة جديدة", exact: true });
      const select = invoice.getByRole("combobox", { name: "الخدمة", exact: true });
      for (const category of ["constructor", "__proto__", "toString"]) {
        await select.selectOption(String(serviceIds.get(category)));
        await expect.poll(async () => invoice.getByText(category, { exact: true }).count()).toBe(1);
      }
      // Font metrics must settle before native scrolling and strict geometry.
      await page.evaluate(async () => { await document.fonts.ready; });
      await select.scrollIntoViewIfNeeded();
      const label = invoice.getByText("toString", { exact: true });
      await label.scrollIntoViewIfNeeded();
      // Native wheel, not DOM scrolling: expose the whole label above real shell bars.
      const labelReachability = await revealOrthoControlByWheel(page, label);
      expect(await select.inputValue()).toBe(String(serviceIds.get("toString")));
      const measure = async () => ({
        targets: await Promise.all([select, label].map(async (target, index) => ({
          fullBounds: await target.evaluate(orthoViewportProof).then(proof => ({
            top: proof.top, bottom: proof.bottom, left: proof.left, right: proof.right,
            availableViewport: proof.availableViewport, hitPoints: proof.hitPoints, unobscured: proof.unobscured,
          })),
          name: index === 0 ? "service-select" : "raw-category-label",
          ...await target.evaluate((element) => {
            const b = element.getBoundingClientRect();
            const point = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
            const hit = document.elementFromPoint(point.x, point.y);
            const ancestors: Array<{ tag: string; role: string | null; position: string; zIndex: string }> = [];
            for (let node = hit, depth = 0; node && depth < 6; node = node.parentElement, depth++) {
              const style = getComputedStyle(node);
              ancestors.push({ tag: node.tagName, role: node.getAttribute("role"), position: style.position, zIndex: style.zIndex });
            }
            return { box: { x: b.x, y: b.y, width: b.width, height: b.height }, point,
              hitOwned: hit === element || !!hit && element.contains(hit), hitAncestors: ancestors };
          }),
        }))),
        shell: await page.evaluate(() => ({
          width: innerWidth, height: innerHeight, scrollX, scrollY, fonts: document.fonts.status,
          documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth,
          visualViewport: visualViewport && { width: visualViewport.width, height: visualViewport.height,
            offsetLeft: visualViewport.offsetLeft, offsetTop: visualViewport.offsetTop,
            pageLeft: visualViewport.pageLeft, pageTop: visualViewport.pageTop },
          bars: Array.from(document.querySelectorAll("header, nav")).flatMap((element) => {
            const style = getComputedStyle(element), b = element.getBoundingClientRect();
            if (!["fixed", "sticky"].includes(style.position) || !b.width || !b.height) return [];
            return [{ tag: element.tagName, position: style.position, zIndex: style.zIndex,
              box: { x: b.x, y: b.y, width: b.width, height: b.height } }];
          }),
        })),
      });
      // Stability is separate from reachability: an obscured but stable target
      // still fails the original hit assertion below; never poll until it passes.
      let previous = "", stableFrames = 0;
      await expect.poll(async () => {
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
        const current = JSON.stringify(await measure());
        stableFrames = current === previous ? stableFrames + 1 : 1; previous = current;
        return stableFrames;
      }).toBeGreaterThanOrEqual(3);
      const witness = await measure();
      await mkdir(".settings-ui-artifacts", { recursive: true });
      // Retain the actual pre-assert frame even when the original geometry fails.
      // These files are diagnostic observations, not standalone passing evidence.
      const diagnosticPng = `service-raw-category-${width}-diagnostic.png`;
      const diagnosticBytes = await page.screenshot({ path: `.settings-ui-artifacts/${diagnosticPng}` });
      const afterCapture = await measure();
      const diagnostic = { protocol: "AQLAN_RAW_CATEGORY_GEOMETRY_V1", acceptance: false,
        head: process.env.GITHUB_SHA ?? null, run: process.env.GITHUB_RUN_ID ?? null, attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
        png: diagnosticPng, pngBytes: diagnosticBytes.length, pngSha256: createHash("sha256").update(diagnosticBytes).digest("hex"),
        width, beforeCapture: witness, afterCapture, labelReachability, requestWitness: requestWitness() };
      console.log("AQLAN_RAW_CATEGORY_GEOMETRY_V1 " + JSON.stringify(diagnostic));
      await writeFile(`.settings-ui-artifacts/service-raw-category-${width}-diagnostic.json`, JSON.stringify(diagnostic, null, 2) + "\n");
      expect(afterCapture).toEqual(witness);
      for (const target of [select, label]) {
        assertOrthoViewportBounds(await target.evaluate(orthoViewportProof), width);
        const bounds = await target.boundingBox(); expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
        expect(bounds!.y).toBeGreaterThanOrEqual(0); expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
        expect(await target.evaluate(element => {
          const b = element.getBoundingClientRect(); const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
          return hit === element || !!hit && element.contains(hit);
        })).toBe(true);
      }
      expect(await page.locator("html").getAttribute("dir")).toBe("rtl");
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.evaluate(async () => { await document.fonts.ready; await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
      await mkdir(".settings-ui-artifacts", { recursive: true });
      await page.screenshot({ path: `.settings-ui-artifacts/service-raw-category-${width}.png` });
      expect(errors).toEqual([]); expect(writes).toEqual([]); expect(await facts()).toEqual(before);
    } finally {
      console.log("AQLAN_RAW_CATEGORY_REQUESTS_V1 " + JSON.stringify(requestWitness()));
      await context.close();
    }
  }, 90_000);
});
