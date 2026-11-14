/** Slice 27: public screen and separately admitted staff controls, synthetic only. */
import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdir } from "node:fs/promises";
import type { Page } from "playwright";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";
const ACCOUNTS = {
  owner: { username: "canon-display-owner", password: "Canon#DisplayOwner1", role: "admin", display: "مالك تجريبي" },
  operator: { username: "canon-display-operator", password: "Canon#DisplayOperator1", role: "reception", display: "مشغل رسالة التأخير", grants: { "settings.view": true, "settings.operational.edit": true } },
  controller: { username: "canon-display-controller", password: "Canon#DisplayControl1", role: "reception", display: "مشغل تجريبي", grants: { "settings.view": true, "settings.operational.edit": true }, patientScope: "all" },
  caller: { username: "canon-display-caller", password: "Canon#DisplayCaller1", role: "doctor", display: "طبيب ينادي تجريبي", grants: { "visits.manage": true }, patientScope: "own", doctor: true },
  viewer: { username: "canon-display-viewer", password: "Canon#DisplayViewer1", role: "reception", display: "قارئ تجريبي", grants: { "settings.view": true } },
  own: { username: "canon-display-own", password: "Canon#DisplayOwn1", role: "doctor", display: "طبيب تجريبي", grants: { "patients.create": true }, patientScope: "own", doctor: true },
  all: { username: "canon-display-all", password: "Canon#DisplayAll1", role: "admin", display: "حساب تجريبي", grants: { "patients.create": true }, patientScope: "all" },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>;
beforeAll(async () => {
  journey = await openCanonicalJourney({ portOffset: 35, secret: "canonical-display-journey-secret-20261030-only", accounts: ACCOUNTS, ownerKey: "owner", seed: async db => {
    await db.query("INSERT INTO visits(patient_name,patient_phone,note,status,chair,called_at) VALUES('SYN-CALL SYN-SECRET-LAST','0551234567','SYN-PRIVATE-NOTE','called',1,NOW())");
    await db.query("INSERT INTO settings(key,value) VALUES('clinical.phrases_diagnosis','SYN-INTERNAL-CLINIC-PHRASE') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
  } });
}, 300_000);
afterAll(async () => { await journey?.close(); });

it("admits the canonical notice reader by settings.view without granting a patient scope", async () => {
  const login = await journey.login("operator");
  const response = await journey.api("/api/display/notice", login.cookie);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ on: false });
});

it("public HTML does not serialize the staff settings context", async () => {
  const response = await fetch(`${journey.baseUrl}/display`);
  expect(response.status).toBe(200);
  expect(await response.text()).not.toContain("SYN-INTERNAL-CLINIC-PHRASE");
});

it("browser drops the current caller after a failed refresh", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 1280, height: 720 } });
  try {
    const page = await context.newPage();
    await page.goto(`${journey.baseUrl}/display`);
    await expect.poll(() => page.locator("body").innerText()).toContain("SYN-CALL");
    await page.route("**/api/display", route => route.fulfill({ status: 503, json: { message: "synthetic unavailable" } }));
    await page.getByText("يُعاد الاتصال…").waitFor();
    expect(await page.locator("body").innerText()).not.toContain("SYN-CALL");
  } finally { await context.close(); }
});

it("browser never speaks a patient call through a non-Arabic fallback voice", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 1280, height: 720 } });
  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      const observed: unknown[] = [];
      Object.assign(window, { __displaySpeech: observed });
      Object.defineProperty(window, "speechSynthesis", { configurable: true, value: {
        getVoices: () => [{ name: "Synthetic English", lang: "en-US", voiceURI: "synthetic-en", localService: true, default: true }],
        addEventListener() {}, removeEventListener() {}, cancel() {},
        speak(utterance: SpeechSynthesisUtterance) { observed.push({ text: utterance.text, lang: utterance.lang, voice: utterance.voice?.voiceURI ?? null }); },
      } });
    });
    await page.goto(`${journey.baseUrl}/display`);
    await expect.poll(() => page.locator("body").innerText()).toContain("SYN-CALL");
    await page.getByRole("button", { name: "تشغيل صوت النداء" }).click();
    await journey.db.query("UPDATE visits SET patient_name='SYN-NEWCALL SYN-SECRET-LAST',called_at=clock_timestamp() WHERE status='called'");
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect.poll(() => page.locator("body").innerText()).toContain("SYN-NEWCALL");
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await page.evaluate(() => (window as unknown as { __displaySpeech: unknown[] }).__displaySpeech)).toEqual([]);
  } finally { await context.close(); }
});

const noticePatch = (cookie: string, body: unknown) => journey.api("/api/display/notice", cookie, { method: "PATCH", body: JSON.stringify(body) });
const central = async (cookie: string, values: Record<string, string>) => {
  const snapshot = await (await journey.api("/api/settings", cookie)).json();
  return journey.api("/api/settings", cookie, { method: "PATCH", body: JSON.stringify({ ...values, __versions: Object.fromEntries(Object.keys(values).map(key => [key, snapshot.__versions[key] ?? null])) }) });
};
const freshCall = async (name: string) => journey.db.query("UPDATE visits SET patient_name=$1,called_at=clock_timestamp() WHERE status='called'", [name]);
const refresh = (page: Page) => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

it("anonymous and every staff scope receive the exact same minimum projection; URL parameters cannot expand it", async () => {
  const expected = ["now", "called", "delayNotice", "voice", "speech", "announcements", "welcomeText", "tagline"].sort();
  let baseline: unknown;
  for (const key of [null, "owner", "operator", "viewer", "own", "all"] as const) {
    const cookie = key ? (await journey.login(key)).cookie : "";
    const response = await journey.api("/api/display?privacy=full&scope=all&show_ortho=true&include=patients,stats,finance", cookie);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toMatch(/no-store/);
    const body = await response.json(); expect(Object.keys(body).sort()).toEqual(expected);
    expect(body.called).toHaveLength(1); expect(Object.keys(body.called[0]).sort()).toEqual(["at", "chair", "name", "speechName"]);
    expect(JSON.stringify(body)).not.toMatch(/SYN-SECRET-LAST|SYN-PRIVATE-NOTE|0551234567|patientId|patientNumber|ortho|avgWait|chairs|queue|done/);
    delete body.now; if (!baseline) baseline = body; else expect(body).toEqual(baseline);
    const html = await (await journey.api("/display?include=all", cookie)).text();
    expect(html).not.toMatch(/SYN-INTERNAL-CLINIC-PHRASE|canon-display-owner|canon-display-operator|SYN-SECRET-LAST/);
  }
});

it("staff management is separate: none/own/all patient scopes do not grant settings or call management", async () => {
  for (const key of ["own", "all"] as const) {
    const login = await journey.login(key);
    expect((await journey.api("/api/display/notice", login.cookie)).status).toBe(403);
    expect((await noticePatch(login.cookie, { on: true, version: null })).status).toBe(403);
  }
  const viewer = await journey.login("viewer"); const view = await (await journey.api("/api/display/notice", viewer.cookie)).json();
  expect(view.canEdit).toBe(false); expect(Object.keys(view).sort()).toEqual(["canEdit", "on", "version"]);
  expect((await noticePatch(viewer.cookie, { on: true, version: view.version })).status).toBe(403);
  const operator = await journey.login("operator");
  expect((await journey.api("/api/visits", operator.cookie)).status).toBe(403);
  const visit = (await journey.db.query("SELECT id FROM visits WHERE status='called'")).rows[0].id;
  expect((await journey.api(`/api/visits/${visit}`, operator.cookie, { method: "PATCH", body: JSON.stringify({ action: "call_again" }) })).status).toBe(403);
  expect((await journey.api("/api/display/notice", "")).status).toBe(401);
});

it("notice writes are audited, CAS conflicts refuse, and hostile input/cross-origin writes have no effect", async () => {
  const operator = await journey.login("operator"); const before = await (await journey.api("/api/display/notice", operator.cookie)).json();
  const saved = await noticePatch(operator.cookie, { on: true, version: before.version, "clinic.chairs": "20" });
  expect(saved.status).toBe(200); expect(await saved.json()).toMatchObject({ on: true, canEdit: true });
  expect((await noticePatch(operator.cookie, { on: false, version: before.version })).status).toBe(409);
  expect((await journey.db.query("SELECT actor,action FROM audit_log WHERE entity_id='display.delay_notice'")).rows).toEqual([{ actor: ACCOUNTS.operator.username, action: "clinic_settings.update" }]);
  for (const body of [[], { on: "true", version: null }, { on: true, version: {} }]) expect((await noticePatch(operator.cookie, body)).status).toBe(400);
  expect((await noticePatch(operator.cookie, { on: true })).status).toBe(409);
  expect((await journey.api("/api/display/notice", operator.cookie, { method: "PATCH", headers: { Origin: "https://invalid.example" }, body: JSON.stringify({ on: false, version: null }) })).status).toBe(403);
});

it("central audio/privacy settings enforce per-key grants, validation and preserve the minimum public contract", async () => {
  const operator = await journey.login("operator"), viewer = await journey.login("viewer");
  expect((await central(viewer.cookie, { "display.voice_rate": "0.8" })).status).toBe(403);
  expect((await central(operator.cookie, { "display.voice_rate": "5" })).status).toBe(400);
  expect((await central(operator.cookie, { "display.voice_pause_ms": "-1" })).status).toBe(400);
  expect((await central(operator.cookie, { "display.voice_uri": "Microsoft Naayf - Arabic (Saudi)", "display.voice_rate": "0.8", "display.voice_pause_ms": "250", "display.privacy_mode": "first_only", "display.show_ortho": "true" })).status).toBe(200);
  const body = await (await journey.api("/api/display", "")).json();
  expect(body.speech).toEqual({ voiceURI: "Microsoft Naayf - Arabic (Saudi)", rate: 0.8, pauseMs: 250 });
  expect(body.called[0].name).toBe(body.called[0].speechName); expect(body).not.toHaveProperty("stats");
});

async function mockSpeech(page: Page, late = false) {
  await page.addInitScript(({ late }) => {
    const observations: { text: string; voice: string | null; rate: number }[] = [];
    let voices = late ? [] : [{ name: "Synthetic Arabic local", voiceURI: "syn-ar-local", lang: "ar-SA", localService: true, default: true }];
    const events = new EventTarget();
    Object.assign(window, { __displaySpeech: observations, __loadArabic: () => { voices = [{ name: "Synthetic Arabic local", voiceURI: "syn-ar-local", lang: "ar-SA", localService: true, default: true }]; events.dispatchEvent(new Event("voiceschanged")); } });
    Object.defineProperty(window, "SpeechSynthesisUtterance", { configurable: true, value: class { text: string; voice = null; lang = ""; rate = 1; onend: (() => void) | null = null; constructor(text: string) { this.text = text; } } });
    Object.defineProperty(window, "speechSynthesis", { configurable: true, value: {
      getVoices: () => voices,
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), cancel() {},
      speak(u: SpeechSynthesisUtterance) { observations.push({ text: u.text, voice: u.voice?.voiceURI ?? null, rate: u.rate }); setTimeout(() => u.onend?.call(u, {} as SpeechSynthesisEvent), 10); },
    } });
  }, { late });
}
const heard = (page: Page) => page.evaluate(() => (window as unknown as { __displaySpeech: { text: string; voice: string; rate: number }[] }).__displaySpeech);

it("browser: delayed Arabic voices, different-device fallback, pauses and settings changes never replay polling or reconnect calls", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 1280, height: 720 } });
  try {
    const page = await context.newPage(); await mockSpeech(page, true); await page.goto(`${journey.baseUrl}/display`);
    await page.getByTestId("current-call").waitFor(); await page.getByRole("button", { name: "تشغيل صوت النداء" }).click();
    await page.getByText("لا يوجد صوت عربي محلي", { exact: false }).waitFor();
    await page.evaluate(() => (window as unknown as { __loadArabic: () => void }).__loadArabic());
    await page.getByText("الصوت المحفوظ غير متاح هنا", { exact: false }).waitFor(); expect(await heard(page)).toEqual([]);
    await freshCall("أحمد المخفي"); await refresh(page); await expect.poll(async () => (await heard(page)).length).toBe(2);
    expect(await heard(page)).toEqual([{ text: "أحمد", voice: "syn-ar-local", rate: 0.8 }, { text: "يرجى التوجه إلى غرفة العلاج رقم ١", voice: "syn-ar-local", rate: 0.8 }]);
    await refresh(page); expect((await heard(page)).length).toBe(2);
    await page.route("**/api/display", route => route.fulfill({ status: 503, json: { message: "synthetic failure" } })); await refresh(page);
    await page.getByText("يُعاد الاتصال…").waitFor(); expect(await page.getByTestId("current-call").count()).toBe(0);
    await freshCall("سارة المخفي"); await page.unroute("**/api/display"); await refresh(page);
    await expect.poll(() => page.getByTestId("current-call").innerText()).toContain("سارة"); expect((await heard(page)).length).toBe(2);
    const operator = await journey.login("operator"); expect((await central(operator.cookie, { "display.voice_rate": "0.7", "display.privacy_mode": "first_initial" })).status).toBe(200);
    await refresh(page); await expect.poll(() => page.getByTestId("current-call").innerText()).toContain("سارة م."); expect((await heard(page)).length).toBe(2);
    await freshCall("علي المخفي"); await refresh(page); await expect.poll(async () => (await heard(page)).length).toBe(4);
    expect((await heard(page))[2]).toMatchObject({ text: "علي", rate: 0.7 });
  } finally { await context.close(); }
});

it("browser: public HTML/DOM/network remain minimal, stale rich payloads are rejected, and synthetic screenshot preserves the identity", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "ar" });
  try {
    const page = await context.newPage(); const apiCalls: string[] = [];
    page.on("request", request => { const path = new URL(request.url()).pathname; if (path.startsWith("/api/")) apiCalls.push(path); });
    await freshCall("أحمد التجريبي"); await page.goto(`${journey.baseUrl}/display?patientId=999&show_ortho=true`);
    await page.getByTestId("current-call").waitFor(); const text = await page.locator("body").innerText();
    expect(text).toContain("أحمد ت."); expect(text).not.toMatch(/أُنجز اليوم|جلسات تقويم|متوسط الانتظار|في العلاج الآن|SYN-SECRET-LAST|SYN-INTERNAL/);
    expect(new Set(apiCalls)).toEqual(new Set(["/api/display"]));
    await mkdir(".settings-ui-artifacts", { recursive: true }); await page.locator(".display-fade").evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)); });
    await page.screenshot({ path: ".settings-ui-artifacts/display-public-1440.png" });
    const payload = await (await journey.api("/api/display", "")).json();
    await page.route("**/api/display", route => route.fulfill({ json: { ...payload, stats: { done: 300 } } })); await refresh(page);
    await page.getByText("يُعاد الاتصال…").waitFor(); expect(await page.getByTestId("current-call").count()).toBe(0);
  } finally { await context.close(); }
});

it("browser: central voice selector/preview uses synthetic text without saving and local voice arrival updates it", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ar" });
  try {
    const page = await context.newPage(); await mockSpeech(page, true); await journey.browserLogin(page, "operator"); await page.goto(`${journey.baseUrl}/settings`);
    await page.getByRole("button", { name: /^الاستقبال/ }).click();
    await page.getByRole("article", { name: "الصوت العربي لشاشة الصالة" }).getByRole("button", { name: "تعديل" }).click();
    expect(await page.getByRole("button", { name: "تجربة الصوت قبل الحفظ" }).isDisabled()).toBe(true);
    await page.evaluate(() => (window as unknown as { __loadArabic: () => void }).__loadArabic());
    await page.getByRole("combobox", { name: "الصوت العربي المحلي" }).selectOption("syn-ar-local");
    await page.getByRole("button", { name: "تجربة الصوت قبل الحفظ" }).click();
    await expect.poll(async () => (await heard(page)).length).toBe(2); expect((await heard(page))[0].text).toBe("أحمد");
    expect((await journey.db.query("SELECT value FROM settings WHERE key='display.voice_uri'")).rows[0].value).toBe("Microsoft Naayf - Arabic (Saudi)");
    await page.getByRole("button", { name: "حفظ التغيير" }).click(); await page.getByText("حُفظ الإعداد وسُجّل التغيير.").waitFor();
    expect((await journey.db.query("SELECT value FROM settings WHERE key='display.voice_uri'")).rows[0].value).toBe("syn-ar-local");
  } finally { await context.close(); }
});

it("browser: staff retains internal queue summary and notice controls, while a spoofed public header never removes staff admission", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ar" });
  try {
    const page = await context.newPage(); await journey.browserLogin(page, "owner"); await page.goto(`${journey.baseUrl}/visits`);
    await page.getByTestId("queue-summary").waitFor(); await page.getByTestId("canonical-display-controls").waitFor();
    await page.getByRole("button", { name: "إيقاف رسالة التأخير" }).click(); await page.getByText("حُفظت رسالة شاشة الصالة.").waitFor();
    expect((await (await journey.api("/api/display", "")).json()).delayNotice).toBe(false);
    const owner = await journey.login("owner");
    const response = await journey.api("/visits", owner.cookie, { headers: { "x-aqlan-public-display": "1" } });
    expect(await response.text()).toContain("SYN-INTERNAL-CLINIC-PHRASE");
  } finally { await context.close(); }
});

it("browser clears a caller when a refresh never completes", async () => {
  const context = await journey.browser.newContext();
  try {
    const page = await context.newPage(); await page.goto(`${journey.baseUrl}/display`); await page.getByTestId("current-call").waitFor();
    await page.route("**/api/display", async () => { /* Deliberately no response; owned context closes it. */ });
    await refresh(page); await page.getByText("يُعاد الاتصال…").waitFor({ timeout: 12_000 });
    expect(await page.getByTestId("current-call").count()).toBe(0);
  } finally { await context.close(); }
});

it("browser hides stale notice authority after grant revocation on refresh", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const page = await context.newPage(); await journey.browserLogin(page, "controller"); await page.goto(`${journey.baseUrl}/visits`);
    await page.getByRole("button", { name: "تشغيل رسالة التأخير" }).waitFor();
    await journey.db.query("UPDATE users SET permissions=jsonb_set(jsonb_set(permissions::jsonb,'{revision}',to_jsonb((permissions::jsonb->>'revision')::int+1)),'{grants}','{}'::jsonb)::text WHERE id=$1", [journey.ids.controller]);
    await refresh(page);
    await expect.poll(() => page.getByRole("button", { name: "تشغيل رسالة التأخير" }).count()).toBe(0);
    expect(await page.getByTestId("canonical-display-controls").innerText()).not.toContain("رسالة التأخير:");
  } finally { await context.close(); }
});

it("call management retains own scope while the public screen reveals only the resulting current call", async () => {
  const login = await journey.login("caller");
  const party = (await journey.db.query("SELECT party_id FROM users WHERE id=$1", [journey.ids.caller])).rows[0].party_id;
  const own = (await journey.db.query("INSERT INTO visits(patient_name,doctor_id,status,chair,called_at) VALUES('منادى سري',$1,'called',2,NOW()) RETURNING id", [party])).rows[0].id;
  const outside = (await journey.db.query("INSERT INTO visits(patient_name,status) VALUES('ممنوع سري','called') RETURNING id")).rows[0].id;
  const move = (id: number) => journey.api(`/api/visits/${id}`, login.cookie, { method: "PATCH", body: JSON.stringify({ action: "call_again" }) });
  const refused = await move(outside), missing = await move(99999999);
  expect(refused.status).toBe(404); expect(await refused.json()).toEqual(await missing.json());
  expect((await move(own)).status).toBe(200);
  const body = await (await journey.api("/api/display", "")).json();
  expect(body.called).toHaveLength(1); expect(body.called[0]).toMatchObject({ name: "منادى س.", speechName: "منادى" });
  expect(JSON.stringify(body)).not.toContain("ممنوع");
  expect((await journey.db.query("SELECT count(*)::int AS n FROM audit_log WHERE entity='visit' AND entity_id=$1", [String(outside)])).rows[0].n).toBe(0);
});

it("permission revision invalidates old sessions; canonical cookies never fall back to legacy management", async () => {
  const operator = await journey.login("operator");
  await journey.db.query("UPDATE users SET permissions=jsonb_set(jsonb_set(permissions::jsonb,'{revision}',to_jsonb((permissions::jsonb->>'revision')::int+1)),'{grants}','{}'::jsonb)::text WHERE id=$1", [journey.ids.operator]);
  expect((await journey.api("/api/display/notice", operator.cookie)).status).toBe(401);
  expect((await noticePatch(operator.cookie, { on: true, version: null })).status).toBe(401);
  expect((await journey.api("/api/display", operator.cookie)).status).toBe(200); // explicit anonymous route, never a staff grant
  const fresh = await journey.login("operator"); expect((await journey.api("/api/display/notice", fresh.cookie)).status).toBe(403);
  expect(await journey.ddlLog()).toEqual([]);
});
