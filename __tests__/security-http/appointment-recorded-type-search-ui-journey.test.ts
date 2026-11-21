import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { authedGet, baseUrl, harness, TEST_USERS, type Session } from "./_server";

const term = "شد تقويم";
const catalogTerm = "تجريبفريد";
const stamp = `SYN-APPT-${randomUUID().slice(0, 8)}`;
const privateName = `${stamp}-B`;
const privatePhone = "770000301";
const currentDay = ["current", "historical", "otherDoctor", "arrived", "consultation", "catalogOnly"] as const;
type Fixture = typeof currentDay[number] | "nextDay";
type ListRow = { id: number; patientId: number; appointmentType: string | null; serviceId: number | null };

let h: Awaited<ReturnType<typeof harness>>;
let db: Client | undefined;
let day: string, nextDay: string, doctorA: number, patientB: number, serviceId: number;
let seeded = false;
const patients: number[] = [];
const appointments = new Map<Fixture, number>();
const ids = (keys: readonly Fixture[]) => keys.map(key => appointments.get(key)!);

beforeAll(async () => {
  // Existing global setup creates aqlan_sec_http on the runner's disposable
  // PG service. Require an explicit loopback test target, never DATABASE_URL.
  const origin = new URL(baseUrl);
  const target = new URL(process.env.TEST_DATABASE_URL ?? "postgresql://invalid");
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1"
    || target.protocol !== "postgresql:" || target.hostname !== "127.0.0.1") {
    throw new Error("Appointment browser witness requires the explicit loopback test harness");
  }
  h = await harness();
  const database = new URL(h.seeded.dbUrl);
  if (database.protocol !== target.protocol || database.host !== target.host
    || database.username !== target.username || database.pathname !== "/aqlan_sec_http") {
    throw new Error("Appointment fixture is outside the synthetic security database");
  }
  db = new Client({
    host: database.hostname, port: Number(database.port || "5432"),
    database: "aqlan_sec_http", user: decodeURIComponent(database.username),
    password: decodeURIComponent(database.password), ssl: false,
  });
  await db.connect();
  const { rows: [connection] } = await db.query<{ name: string }>("SELECT current_database() AS name");
  expect(connection.name).toBe("aqlan_sec_http");

  const { rows: [dates] } = await db.query<{ day: string; tomorrow: string }>(
    "SELECT ((NOW() AT TIME ZONE 'Asia/Aden')::date+7)::text AS day, ((NOW() AT TIME ZONE 'Asia/Aden')::date+8)::text AS tomorrow",
  );
  day = dates.day;
  nextDay = dates.tomorrow;
  const { rows: staff } = await db.query<{ username: string; party_id: number }>(
    "SELECT username, party_id FROM users WHERE username IN ($1,$2)",
    [TEST_USERS.doctorA.username, TEST_USERS.doctorB.username],
  );
  doctorA = staff.find(row => row.username === TEST_USERS.doctorA.username)!.party_id;
  const doctorB = staff.find(row => row.username === TEST_USERS.doctorB.username)!.party_id;
  expect(doctorA).toBeGreaterThan(0);
  expect(doctorB).toBeGreaterThan(0);
  expect(doctorA).not.toBe(doctorB);

  await db.query("BEGIN");
  try {
    for (const [name, provider, phone] of [[`${stamp}-A`, doctorA, null], [privateName, doctorB, privatePhone]] as const) {
      const { rows: [patient] } = await db.query<{ id: number }>(
        "INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES ($1,$1,$2,$3) RETURNING id",
        [name, phone, provider],
      );
      patients.push(patient.id);
    }
    const [patientA, secondPatient] = patients;
    patientB = secondPatient;
    const { rows: [service] } = await db.query<{ id: number }>(
      "INSERT INTO appointment_services(code,name_ar,legacy_type) VALUES ($1,$2,NULL) RETURNING id",
      [stamp, `خدمة اختبار ${catalogTerm}`],
    );
    serviceId = service.id;
    // Seed both real stored spellings literally. This tests search, not how booking stores them.
    for (const [key, date, time, type, status] of [
      ["current", day, "09:00", "follow_up", "booked"],
      ["historical", day, "09:15", "متابعة دورية", "booked"],
      ["otherDoctor", day, "09:30", "follow_up", "booked"],
      ["arrived", day, "09:45", "follow_up", "arrived"],
      ["consultation", day, "10:00", "consultation", "booked"],
      ["catalogOnly", day, "10:15", null, "booked"],
      ["nextDay", nextDay, "09:00", "follow_up", "booked"],
    ] as const) {
      const secondDoctor = key === "otherDoctor";
      const { rows: [appointment] } = await db.query<{ id: number }>(
        `INSERT INTO appointments(patient_id,doctor_id,scheduled_date,scheduled_time,
                                  appointment_type,status,duration_minutes,service_id)
         VALUES ($1,$2,$3::date,$4,$5,$6,15,$7) RETURNING id`,
        [secondDoctor ? patientB : patientA, secondDoctor ? doctorB : doctorA,
          date, time, type, status, key === "catalogOnly" ? serviceId : null],
      );
      appointments.set(key, appointment.id);
    }
    await db.query("COMMIT");
    seeded = true;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
});

afterAll(async () => {
  try {
    if (!db || !seeded) return;
    // Remove only the rows this file made; all other hosted test fixtures are untouched.
    await db.query("DELETE FROM appointments WHERE id = ANY($1::int[]) AND patient_id = ANY($2::int[])",
      [[...appointments.values()], patients]);
    await db.query("DELETE FROM appointment_services WHERE id=$1 AND code=$2", [serviceId, stamp]);
    await db.query("DELETE FROM patients WHERE id = ANY($1::int[]) AND patient_number = ANY($2::text[])",
      [patients, [`${stamp}-A`, privateName]]);
  } finally {
    await db?.end();
  }
});

async function snapshot() {
  // Compare our operational rows, any visits created for them, and their audits.
  const { rows: [row] } = await db!.query<{ watched: string }>(`SELECT jsonb_build_object(
    'appointments', (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM appointments a WHERE patient_id=ANY($1::int[])),
    'patients', (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM patients p WHERE id=ANY($1::int[])),
    'visits', (SELECT jsonb_agg(to_jsonb(v) ORDER BY id) FROM visits v WHERE patient_id=ANY($1::int[])),
    'audits', (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM audit_log l WHERE
      (entity='appointment' AND entity_id=ANY($2::text[])) OR (entity='patient' AND entity_id=ANY($1::int[]::text[]))),
    'service', (SELECT to_jsonb(s) FROM appointment_services s WHERE id=$3)
  )::text AS watched`, [patients, [...appointments.values()].map(String), serviceId]);
  return row.watched;
}
const listPath = () => `/api/appointments?date=${day}`;
function fixtureRows(rows: ListRow[]) {
  return rows.filter(row => patients.includes(row.patientId)).map(row => row.id);
}

it("keeps normal appointment read scope and the selected day", async () => {
  const before = await snapshot();
  const anonymous = await fetch(baseUrl + listPath(), { redirect: "manual" });
  expect(anonymous.status).toBe(401);
  expect(await anonymous.text()).not.toContain(stamp);

  const reception = await authedGet(listPath(), h.sessions.reception);
  expect(reception.status).toBe(200);
  const rows = await reception.json() as ListRow[];
  expect(fixtureRows(rows)).toEqual(ids(currentDay));
  const byKey = (key: Fixture) => rows.find(row => row.id === appointments.get(key));
  expect(byKey("current")?.appointmentType).toBe("follow_up");
  expect(byKey("historical")?.appointmentType).toBe("متابعة دورية");
  expect(byKey("catalogOnly")).toMatchObject({ appointmentType: null, serviceId });

  const doctor = await authedGet(listPath(), h.sessions.doctorA);
  expect(doctor.status).toBe(200);
  const body = await doctor.text();
  expect(body).not.toContain(privateName);
  expect(body).not.toContain(privatePhone);
  expect(fixtureRows(JSON.parse(body) as ListRow[])).toEqual(ids(currentDay.filter(key => key !== "otherDoctor")));
  expect(await snapshot()).toBe(before);
});

async function open(browser: Browser, session: Session) {
  const context = await browser.newContext({ locale: "ar-YE", viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  const split = session.cookie.indexOf("=");
  await context.addCookies([{ name: session.cookie.slice(0, split), value: session.cookie.slice(split + 1), url: baseUrl }]);
  const writes: string[] = [];
  await context.route("**/*", async route => {
    const request = route.request();
    if (new URL(request.url()).origin !== baseUrl) return route.abort();
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      writes.push(request.method());
      return route.abort();
    }
    return route.continue();
  });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/appointments?date=${day}`, { waitUntil: "domcontentloaded" });
  await page.locator(`li[data-appointment="${appointments.get("current")}"]`).waitFor({ timeout: 30_000 });
  const visible = () => page.locator("li[data-appointment]").evaluateAll((rows, owned) =>
    rows.map(row => Number(row.getAttribute("data-appointment"))).filter(id => owned.includes(id)),
  [...appointments.values()]);
  return { context, page, visible, writes };
}

it("finds both stored shared-type spellings with the current day, doctor and status filters", async () => {
  const before = await snapshot();
  const browser = await chromium.launch({
    headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
  try {
    const { context, page, visible, writes } = await open(browser, h.sessions.reception);
    const shows = (...keys: Fixture[]) => expect.poll(visible, { timeout: 15_000 }).toEqual(ids(keys));
    const search = page.getByRole("searchbox");
    await shows(...currentDay);
    await search.fill(term);
    await shows("current", "historical", "otherDoctor", "arrived");

    await page.getByRole("combobox").filter({ has: page.locator(`option[value="${doctorA}"]`) }).selectOption(String(doctorA));
    await shows("current", "historical", "arrived");
    const booked = page.getByRole("button", { name: /^محجوز \(/ });
    await booked.click();
    await shows("current", "historical");
    await page.getByRole("button", { name: /اليوم التالي/ }).click();
    await shows("nextDay");
    await page.getByRole("button", { name: /اليوم السابق/ }).click();
    await shows("current", "historical");
    await page.getByRole("button", { name: /^وصل بالعيادة \(/ }).click();
    await shows("arrived");

    // A catalog-only term is not a legacy type alias, a specialty, or a search field.
    await booked.click();
    await search.clear();
    await shows("current", "historical", "consultation", "catalogOnly");
    await search.fill(catalogTerm);
    await shows();
    expect(writes).toEqual([]);
    await context.close();

    const scoped = await open(browser, h.sessions.doctorA);
    await expect.poll(scoped.visible).toEqual(ids(currentDay.filter(key => key !== "otherDoctor")));
    await scoped.page.getByRole("searchbox").fill(term);
    await expect.poll(scoped.visible).toEqual(ids(["current", "historical", "arrived"]));
    expect(await scoped.page.getByText(privateName, { exact: true }).count()).toBe(0);
    expect(await scoped.page.getByText(privatePhone).count()).toBe(0);
    expect(scoped.writes).toEqual([]);
    await scoped.context.close();
  } finally {
    await browser.close();
  }
  expect(await snapshot()).toBe(before);
});
