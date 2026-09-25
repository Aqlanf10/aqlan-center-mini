import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, harness } from "./_server";

/**
 * جاهزية أعمال المختبر بجانب مواعيد اليوم — على التطبيق المبني.
 *
 * أولوية المالك (تراكم التراكيب): مريضٌ محجوز لتركيب تاجه والعمل ما زال عند
 * المختبر. قائمة المواعيد تقول ذلك للاستقبال قبل أن يأتي المريض.
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
const stamp = Date.now();
// تاريخٌ بعيد خاصٌّ بهذا الملف — لا يتقاطع مع مواعيد الملفات الأخرى.
const date = "2031-03-11";
let withLab = 0;
let withoutLab = 0;
let otherDoctorsPatient = 0;

type Row = { patientId: number; labReadiness?: { level: string; message: string; orderId: number }[] };

async function day(session: "reception" | "doctorA"): Promise<Row[]> {
  const response = await authedGet(`/api/appointments?date=${date}`, h.sessions[session]);
  expect(response.status).toBe(200);
  return await response.json() as Row[];
}

async function patient(name: string): Promise<number> {
  const { rows: [row] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, $2) RETURNING id`, [`LR-${stamp}-${name}`, name],
  );
  return row.id;
}

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  withLab = await patient("تاج");
  withoutLab = await patient("كشف");
  otherDoctorsPatient = await patient("زميل");
  const { rows: [other] } = await db.query<{ id: number }>(
    `INSERT INTO parties (name, kind) VALUES ($1, 'doctor') RETURNING id`, [`طبيب آخر ${stamp}`],
  );
  await db.query(
    `INSERT INTO appointments (patient_id, scheduled_date, scheduled_time, appointment_type, doctor_id)
     VALUES ($1, $4, '10:00', 'consultation', NULL), ($2, $4, '11:00', 'consultation', NULL),
            ($3, $4, '12:00', 'consultation', $5)`,
    [withLab, withoutLab, otherDoctorsPatient, date, other.id],
  );
  await db.query(
    `INSERT INTO lab_orders (patient_id, lab_name, work_type, due_date, status)
     VALUES ($1, 'مختبر النور', 'تاج زيركون', '2031-03-20', 'sent'),
            ($1, 'مختبر النور', 'جسر', '2031-03-01', 'received'),
            ($1, 'مختبر النور', 'قديم مسلَّم', '2031-01-01', 'delivered'),
            ($2, 'مختبر الأمل', 'طقم', '2031-03-05', 'sent')`,
    [withLab, otherDoctorsPatient],
  );
}, 120_000);

afterAll(async () => {
  await db?.end();
});

describe("جاهزية أعمال المختبر في قائمة المواعيد", () => {
  it("المريض المنتظر تركيبته يحمل جاهزيتها: الأخطر أولًا، والمسلَّم لا يظهر", async () => {
    const row = (await day("reception")).find((item) => item.patientId === withLab);
    expect(row?.labReadiness?.map((item) => item.level)).toEqual(["after_visit", "ready"]);
    expect(row?.labReadiness?.[0]?.message).toBe("تاج زيركون: وصولها المتوقَّع 2031-03-20 بعد الموعد");
    expect(row?.labReadiness?.[1]?.message).toBe("جسر: وصلت العيادة — جاهزة للتركيب");
  });

  it("مريضٌ بلا أعمال مختبر لا يحمل الحقل", async () => {
    const row = (await day("reception")).find((item) => item.patientId === withoutLab);
    expect(row).toBeDefined();
    expect(row?.labReadiness).toBeUndefined();
  });

  it("الطبيب لا يرى أعمال مختبر مريضٍ لزميلٍ لا يراه", async () => {
    const rows = await day("doctorA");
    expect(rows.some((item) => item.patientId === otherDoctorsPatient)).toBe(false);
    expect(JSON.stringify(rows)).not.toContain("مختبر الأمل");
  });
});
