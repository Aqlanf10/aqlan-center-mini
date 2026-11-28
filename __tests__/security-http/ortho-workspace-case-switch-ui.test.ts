import { expect, it } from "vitest";
import { chromium } from "playwright";
import { Client } from "pg";
import { baseUrl, harness } from "./_server";

it("keeps two case drafts independent when a doctor saves and switches in the real workspace", async () => {
  const h = await harness();
  const db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  try {
    await db.connect();
    const [{id: patient}] = (await db.query<{id: number}>(`
      INSERT INTO patients(patient_number,full_name) VALUES ('P-20001','Synthetic two-case patient') RETURNING id`)).rows;
    const cases = (await db.query<{id: number}>(`
      INSERT INTO ortho_cases(patient_id,status,created_by)
      VALUES ($1,'closed','secadmin'),($1,'active','secadmin') RETURNING id`, [patient])).rows;
    const a = cases[0].id, b = cases[1].id;
    const context = await browser.newContext();
    const [name,...value] = h.sessions.admin.cookie.split("=");
    await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    const page = await context.newPage();
    await page.goto(`${baseUrl}/patients/${patient}?tab=treatment&sub=ortho&orthoTab=questionnaire`);
    const switcher = page.getByTestId("ortho-case-switcher");
    const complaint = page.getByPlaceholder(/سبب الزيارة بكلمات المريض|Patient chief complaint/);
    await complaint.waitFor({state:"visible"});
    expect(await switcher.inputValue()).toBe(String(b));

    const save = async (id: number, value: string) => {
      const persisted = page.waitForResponse(r => r.request().method() === "PUT"
        && new URL(r.url()).pathname === `/api/ortho/workspace/${patient}`
        && new URL(r.url()).searchParams.get("orthoCaseId") === String(id));
      await complaint.fill(value);
      const response = await persisted;
      expect(response.status()).toBe(200);
      expect((await response.json()).workspace.orthoCaseId).toBe(id);
      await expect.poll(() => switcher.isEnabled()).toBe(true);
    };
    await save(b,"Synthetic history B");
    await switcher.selectOption(String(a));
    await expect.poll(() => complaint.inputValue()).toBe("");
    await save(a,"Synthetic history A");
    await switcher.selectOption(String(b));
    await expect.poll(() => complaint.inputValue()).toBe("Synthetic history B");
    await switcher.selectOption(String(a));
    await expect.poll(() => complaint.inputValue()).toBe("Synthetic history A");
    await page.reload();
    await complaint.waitFor({state:"visible"});
    await expect.poll(() => complaint.inputValue()).toBe("Synthetic history B");
    await switcher.selectOption(String(a));
    await expect.poll(() => complaint.inputValue()).toBe("Synthetic history A");
  } finally {
    await db.end().catch(() => undefined);
    await browser.close();
  }
}, 90_000);

it("round-trips two same-patient case revisions through the built authenticated workspace", async () => {
  const h = await harness();
  const db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  try {
    const [{id: patient}] = (await db.query<{id: number}>(
      "INSERT INTO patients(patient_number,full_name) VALUES ('P-20002','Synthetic scoped workspace') RETURNING id")).rows;
    const [{id: a},{id: b}] = (await db.query<{id: number}>(`
      INSERT INTO ortho_cases(patient_id,status,created_by)
      VALUES ($1,'closed','secadmin'),($1,'active','secadmin') RETURNING id`,[patient])).rows;
    const url = (c: number) => `${baseUrl}/api/ortho/workspace/${patient}?orthoCaseId=${c}`;
    const headers = { Cookie:h.sessions.admin.cookie, Origin:baseUrl, "Content-Type":"application/json" };
    for (const [c, annotation] of [[a,"SYN first"],[b,"SYN second"]] as const) {
      const res = await fetch(url(c),{method:"PUT",headers,body:JSON.stringify({ expectedRevision:0,
        workspace:{ orthoCaseId:c, orthoCoreCase:{media:[{ id:`case-${c}`, annotations:[annotation] }]}} })});
      if (res.status !== 200) throw new Error(`scoped synthetic store returned ${res.status}: ${await res.text()}`);
      expect((await res.json()).workspace.revision).toBe(1);
    }
    for (const [c, annotation] of [[a,"SYN first"],[b,"SYN second"]] as const) {
      const res = await fetch(url(c),{headers});
      expect(res.status).toBe(200);
      expect((await res.json()).workspace).toMatchObject({ orthoCaseId:c, revision:1,
        orthoCoreCase:{media:[{ id:`case-${c}`, annotations:[annotation] }]} });
    }
  } finally { await db.end(); }
});
