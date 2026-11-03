import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { Client } from "pg";
import { chromium, type Browser, type Page } from "playwright";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { baseUrl, harness, authedMutation } from "./_server";
let h: Awaited<ReturnType<typeof harness>>, db: Client, browser: Browser;
beforeAll(async () => { h = await harness(); expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http"); db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect(); browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined }); await mkdir(".settings-ui-artifacts", { recursive: true }); });
afterAll(async () => { await browser?.close(); await db?.end(); });
async function source(page: Page, title: string) { await page.getByRole("button", { name: `مصدر وتاريخ ${title}`, exact: true }).click(); await page.getByLabel(`حالة تاريخ ${title}`, { exact: true }).selectOption("unknown"); await page.getByLabel(`سبب غياب تاريخ ${title}`, { exact: true }).fill("تاريخ غير معلوم في المثال الاصطناعي"); await page.getByLabel(`طريقة توثيق ${title}`, { exact: true }).selectOption("direct_examination"); await page.getByLabel(`وصف طريقة توثيق ${title}`, { exact: true }).fill("فحص اصطناعي موثق"); }
const unrelated = async () => (await db.query("SELECT (SELECT count(*)::int FROM invoices) invoices,(SELECT count(*)::int FROM payments) payments,(SELECT count(*)::int FROM patient_opening_balances) opening,(SELECT count(*)::int FROM visits) visits,(SELECT count(*)::int FROM appointments) appointments")).rows;
describe("first diagnostic case from module through saved assessment to explicit treatment", () => {
    it("enforces current route admission and patient ownership without financial writes", async () => {
        const patientId = (await db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'حالة صلاحيات اصطناعية') RETURNING id", [`SYN-INTAKE-AUTH-${randomUUID()}`])).rows[0].id;
        const command = { schemaVersion: 1, clientRequestId: randomUUID(), reason: "تقييم اصطناعي لاختبار الصلاحية" };
        const body = JSON.stringify({ patientId, command }), before = await unrelated();
        expect((await fetch(`${baseUrl}/api/ortho/intake`, { method: "POST", headers: { "Content-Type": "application/json", Origin: baseUrl }, body })).status).toBe(401);
        for (const role of ["reception", "accountant", "cashier"] as const) {
            expect((await authedMutation("/api/ortho/intake", h.sessions[role], "POST", body)).status).toBe(403);
        }
        expect((await authedMutation("/api/ortho/intake?patientId=1", h.sessions.admin, "POST", body)).status).toBe(400);
        expect((await authedMutation("/api/ortho/intake", h.sessions.admin, "POST", JSON.stringify({ patientId, command: {} }))).status).toBe(400);
        expect((await db.query("SELECT id FROM ortho_cases WHERE patient_id=$1", [patientId])).rows).toEqual([]);
        const created = await authedMutation("/api/ortho/intake", h.sessions.admin, "POST", body);
        expect(created.status).toBe(201);
        expect(created.headers.get("cache-control")).toContain("no-store");
        const receipt = await created.json(), path = `/api/ortho/${receipt.orthoCaseId}/treatment-start`;
        for (const role of ["reception", "accountant", "cashier"] as const) {
            expect((await authedMutation(path, h.sessions[role], "POST", JSON.stringify({ patientId, command: {} }))).status).toBe(403);
        }
        const treatment = { ...command, clientRequestId: randomUUID(), confirmed: true, appliance: "fixed_metal", arches: "both", slot: "022", startDate: "2026-10-01", plannedMonths: 18, bracketSystem: "" };
        expect((await authedMutation(path, h.sessions.admin, "POST", JSON.stringify({ patientId: h.seeded.patientAId, command: treatment }))).status).toBe(404);
        expect((await authedMutation(path, h.sessions.admin, "POST", JSON.stringify({ patientId, command: {} }))).status).toBe(400);
        expect((await db.query("SELECT status,start_date FROM ortho_cases WHERE id=$1", [receipt.orthoCaseId])).rows).toEqual([{ status: "assessment", start_date: null }]);
        expect(await unrelated()).toEqual(before);
    });
    it.each([390, 1280])("keeps one identity, incremental findings and explicit start at %ipx", async (width) => {
        const number = `SYN-INTAKE-${randomUUID()}`, patientId = (await db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'حالة تقييم أولي اصطناعية') RETURNING id", [number])).rows[0].id, before = await unrelated();
        const planId = (await db.query("INSERT INTO treatment_plans(patient_id,title,total_minor) VALUES($1,'مرجع أقساط اصطناعي قائم',900000) RETURNING id", [patientId])).rows[0].id;
        await db.query("INSERT INTO plan_installments(plan_id,number,due_date,amount_minor) VALUES($1,1,'2026-12-01',900000)", [planId]);
        const planBefore = (await db.query("SELECT * FROM treatment_plans WHERE id=$1", [planId])).rows;
        const installmentsBefore = (await db.query("SELECT * FROM plan_installments WHERE plan_id=$1", [planId])).rows;
        const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE" }), [name, ...value] = h.sessions.admin.cookie.split("=");
        await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
        const writes: {
            path: string;
            body: string;
        }[] = [], unexpected: string[] = [], errors: string[] = [];
        let lost = false;
        await context.route("**/*", async (route) => { const req = route.request(), url = new URL(req.url()); if (url.origin !== baseUrl) {
            unexpected.push(req.url());
            return route.abort();
        } if (req.method() === "POST" && (url.pathname === "/api/ortho/intake" || /^\/api\/ortho\/\d+\/(assessment|treatment-start)$/.test(url.pathname))) {
            writes.push({ path: url.pathname, body: req.postData()! });
            const response = await route.fetch();
            if (width === 390 && url.pathname === "/api/ortho/intake" && !lost) {
                lost = true;
                expect(response.status()).toBe(201);
                await route.abort("failed");
                return;
            }
            return route.fulfill({ response });
        } if (req.method() === "PATCH" && /^\/api\/ortho\/\d+$/.test(url.pathname)) {
            expect(Object.keys(req.postDataJSON()).sort()).toEqual(["expectedVersion", "planId"]);
            expect(req.postDataJSON().planId).toBe(planId);
            writes.push({ path: url.pathname, body: req.postData()! });
            return route.continue();
        } if (!["GET", "HEAD", "OPTIONS"].includes(req.method())) {
            unexpected.push(`${req.method()} ${url.pathname}`);
            return route.abort();
        } return route.continue(); });
        const page = await context.newPage();
        page.setDefaultTimeout(20000);
        page.on("pageerror", e => errors.push(e.message));
        const enter = async () => { await page.goto(`${baseUrl}/ortho`); await page.getByLabel("بحث مريض لملف التقويم").fill(number); await page.getByRole("button", { name: "البحث عن ملف التقويم", exact: true }).click(); await page.locator(`a[href^="/patients/${patientId}?"]`, { hasText: "فتح ملف التقويم" }).click(); };
        try {
            await enter();
            await page.getByLabel("سبب فتح التقييم", { exact: true }).fill("تقييم أولي اصطناعي دون بدء علاج");
            await page.getByRole("button", { name: "فتح ملف التقييم", exact: true }).click();
            if (width === 390) {
                await page.getByRole("button", { name: "التحقق من فتح الحالة أو بدء العلاج بنفس الطلب", exact: true }).click();
                expect(writes[0].body).toBe(writes[1].body);
            }
            await page.getByRole("button", { name: "بدء تقييم غير معبأ", exact: true }).click();
            const cases = async () => (await db.query("SELECT id,status,phase,appliance,arches,slot,start_date,planned_months FROM ortho_cases WHERE patient_id=$1", [patientId])).rows;
            const firstCase = await cases();
            expect(firstCase).toHaveLength(1);
            expect(firstCase[0]).toMatchObject({ status: "assessment", phase: "assessment", appliance: null, arches: null, slot: null, start_date: null, planned_months: null });
            const caseId = firstCase[0].id;
            const revisions = async () => (await db.query("SELECT id,version,clinical_case_id,content FROM ortho_assessment_revisions WHERE ortho_case_id=$1 ORDER BY version", [caseId])).rows;
            await page.getByLabel("حالة الشكوى الرئيسية", { exact: true }).selectOption("recorded");
            await page.getByLabel("الشكوى الرئيسية — اختيار قابل للبحث أو نص حر", { exact: true }).fill("شكوى أولى اصطناعية تحفظ مرة واحدة");
            await source(page, "الشكوى الرئيسية");
            await page.getByLabel("سبب إنشاء هذه المراجعة", { exact: true }).fill("حفظ المقابلة قبل اكتمال الفحص");
            await page.getByRole("button", { name: "حفظ مراجعة تقييم جديدة", exact: true }).click();
            await page.getByText("ملخص التقييم المحفوظ — نسخة 1", { exact: true }).waitFor();
            const first = await revisions();
            expect(first).toHaveLength(1);
            const original = first[0].content.draft.observations.observations;
            expect(original.filter((o: {
                id: string;
                value: {
                    state: string;
                };
            }) => o.id !== "clinical_chiefComplaint").every((o: {
                value: {
                    state: string;
                };
            }) => o.value.state === "not_recorded")).toBe(true);
            await page.reload();
            await page.getByText("ملخص التقييم المحفوظ — نسخة 1", { exact: true }).waitFor();
            await enter();
            await page.getByText("ملخص التقييم المحفوظ — نسخة 1", { exact: true }).waitFor();
            expect(await page.getByLabel("سبب فتح التقييم", { exact: true }).count()).toBe(0);
            expect(await cases()).toEqual(firstCase);
            await page.getByRole("button", { name: "فتح مراجعة تصحيحية من النسخة الحالية", exact: true }).click();
            await page.getByRole("button", { name: "فحص الوجه والابتسامة", exact: true }).click();
            await page.getByLabel("حالة تناظر الوجه", { exact: true }).selectOption("not_measured");
            await page.getByLabel("سبب حالة تناظر الوجه", { exact: true }).fill("الفحص مؤجل في هذا المثال");
            await source(page, "تناظر الوجه");
            await page.getByLabel("سبب إنشاء هذه المراجعة", { exact: true }).fill("استكمال حالة فحص الوجه دون إعادة الشكوى");
            await page.getByRole("button", { name: "المقابلة والتاريخ", exact: true }).click();
            expect(await page.getByLabel("الشكوى الرئيسية — اختيار قابل للبحث أو نص حر", { exact: true }).inputValue()).toBe("شكوى أولى اصطناعية تحفظ مرة واحدة");
            await page.getByRole("button", { name: "حفظ مراجعة تقييم جديدة", exact: true }).click();
            await page.getByText("ملخص التقييم المحفوظ — نسخة 2", { exact: true }).waitFor();
            const second = await revisions();
            expect(second).toHaveLength(2);
            expect(second[0]).toEqual(first[0]);
            expect(await unrelated()).toEqual(before);
            await page.getByText("ربط خطة علاج أو اتفاق قائم", { exact: true }).click();
            await page.getByLabel("اختر اتفاقًا قائمًا", { exact: true }).selectOption(String(planId));
            await page.getByRole("button", { name: "اربط", exact: true }).click();
            await expect.poll(async () => (await db.query("SELECT plan_id FROM ortho_cases WHERE id=$1", [caseId])).rows[0].plan_id).toBe(planId);
            await page.getByText("ملخص التقييم المحفوظ — نسخة 2", { exact: true }).waitFor();
            await page.screenshot({ path: `.settings-ui-artifacts/ortho-intake-assessment-${width}.png`, fullPage: true });
            await page.getByText("بعد اكتمال التقييم: توثيق بدء العلاج", { exact: true }).click();
            const start = page.getByRole("region", { name: "توثيق بدء العلاج", exact: true });
            expect(await start.getByLabel("الجهاز عند بدء العلاج", { exact: true }).inputValue()).toBe("");
            expect(await start.getByLabel("تاريخ بدء العلاج الفعلي", { exact: true }).inputValue()).toBe("");
            await start.getByLabel("الجهاز عند بدء العلاج", { exact: true }).selectOption("fixed_metal");
            await start.getByLabel("الفك المعالج عند البدء", { exact: true }).selectOption("both");
            await start.getByLabel("مقاس الشق عند البدء", { exact: true }).selectOption("022");
            await start.getByLabel("تاريخ بدء العلاج الفعلي", { exact: true }).fill("2026-10-01");
            await start.getByLabel("المدة المتوقعة عند البدء بالأشهر", { exact: true }).fill("18");
            await start.getByLabel("سبب توثيق بدء العلاج", { exact: true }).fill("قرار بدء اصطناعي موثق");
            await start.getByLabel("أؤكد أن العلاج بدأ فعلياً بهذه البيانات").check();
            await start.getByRole("button", { name: "حفظ بدء العلاج على هذه الحالة", exact: true }).click();
            await expect.poll(async () => (await cases())[0].status).toBe("active");
            await page.reload();
            await page.getByText("ملخص التقييم المحفوظ — نسخة 2", { exact: true }).waitFor();
            expect(await revisions()).toEqual(second);
            expect((await cases()).map(c => c.id)).toEqual([caseId]);
            expect((await db.query("SELECT id FROM clinical_cases WHERE patient_id=$1 AND ortho_case_id=$2", [patientId, caseId])).rows).toEqual([{ id: first[0].clinical_case_id }]);
            expect(await unrelated()).toEqual(before);
            expect((await db.query("SELECT plan_id FROM ortho_cases WHERE id=$1", [caseId])).rows[0].plan_id).toBe(planId);
            expect((await db.query("SELECT * FROM treatment_plans WHERE id=$1", [planId])).rows).toEqual(planBefore);
            expect((await db.query("SELECT * FROM plan_installments WHERE plan_id=$1", [planId])).rows).toEqual(installmentsBefore);
            expect(errors).toEqual([]);
            expect(unexpected).toEqual([]);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        }
        finally {
            await context.close();
        }
    });
});
