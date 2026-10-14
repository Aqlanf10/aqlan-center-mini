import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { JSON_BODY_LIMIT_BYTES } from "../../lib/security-limits";
import { authedMutation, baseUrl, harness, TEST_USERS, type Session } from "./_server";

// Real built-app HTTP plus the harness's isolated PostgreSQL database. Fixtures
// are created before snapshots; every request under test must be a no-op.
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let patientAId = 0;
let patientBId = 0;
let serviceId = 0;
const stamp = Date.now();
const ENTRY_REQUIRED = {
  code: "PLAN_CREATION_ENTRY_REQUIRED",
  message: "ابدأ العلاج من الفاتورة أو الاتفاق السابق للنظام في حساب المريض.",
};

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  for (const [label, username] of [["A", TEST_USERS.doctorA.username], ["B", TEST_USERS.doctorB.username]]) {
    const { rows: [doctor] } = await db.query<{ party_id: number }>(
      "SELECT party_id FROM users WHERE username = $1", [username],
    );
    expect(doctor?.party_id).toBeGreaterThan(0);
    const { rows: [patient] } = await db.query<{ id: number }>(
      `INSERT INTO patients (patient_number, full_name, primary_doctor_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [`PLAN-ENTRY-${stamp}-${label}`, `Synthetic plan entry ${label}`, doctor.party_id],
    );
    if (label === "A") patientAId = patient.id;
    else patientBId = patient.id;
  }
  ({ rows: [{ id: serviceId }] } = await db.query<{ id: number }>(
    `INSERT INTO services (name, category, price_minor, price_configured, is_active)
     VALUES ($1, 'rct', 44000, TRUE, TRUE) RETURNING id`, [`Synthetic plan entry service ${stamp}`],
  ));
}, 120_000);
afterAll(async () => { await db?.end(); });

// Counts alone miss in-place updates and delete/insert substitutions. Hash the
// complete, deterministically sorted row contents as well, in one SQL snapshot.
// Table identifiers are a fixed allowlist, never request or environment input.
// The security configuration serializes files; login/setup finished above.
// Proxy denials and requireSession/doctorOwnsPatient do not write audit rows.
const unchangedTables = [
  "patients", "treatment_plans", "plan_installments", "plan_items",
  "treatment_sessions", "planned_visits", "visits", "visit_procedures",
  "appointments", "ortho_cases", "invoices", "invoice_items", "payments",
  "patient_opening_balances", "journal_manual", "journal_manual_lines", "audit_log",
  "clinical_cases", "legacy_treatment_agreements", "legacy_treatment_coverage_snapshots",
] as const;
async function snapshot() {
  const { rows } = await db.query<{ table_name: string; count: string; digest: string }>(
    unchangedTables.map((table) => `
      SELECT '${table}'::text AS table_name, COUNT(*)::text AS count,
        md5(COALESCE(string_agg(row_to_json(t)::text, E'\\n' ORDER BY row_to_json(t)::text), '')) AS digest
      FROM ${table} t`).join(" UNION ALL ") + " ORDER BY table_name",
  );
  expect(rows).toHaveLength(unchangedTables.length);
  return rows;
}
async function withoutWrites(action: () => Promise<void>) {
  const before = await snapshot();
  try {
    await action();
  } finally {
    expect(await snapshot()).toEqual(before);
  }
}
function payload(extra: Record<string, unknown> = {}) {
  return {
    patientId: patientAId, title: `Synthetic retired plan ${stamp}`, currency: "YER",
    total: "1000", count: 2, everyDays: 30, startDate: "2026-10-01", ...extra,
  };
}
function post(body: unknown, session: Pick<Session, "cookie"> = h.sessions.admin, headers: Record<string, string> = {}, query = "") {
  return authedMutation(`/api/plans${query}`, session, "POST", JSON.stringify(body), headers);
}
async function expectEntryRequired(response: Response) {
  expect(response.status).toBe(409);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toEqual(ENTRY_REQUIRED);
}
function oldModes(): { name: string; extra: Record<string, unknown> }[] {
  return [
    { name: "implicit financial", extra: {} },
    { name: "financial", extra: { mode: "financial" } },
    { name: "clinical", extra: { mode: "clinical" } },
    { name: "v2 per-procedure", extra: {
      mode: "v2", billingMode: "per_procedure",
      items: [{ serviceId, quantity: 1, unitPriceMinor: 44000, billingRule: "on_start", sessionCount: 2 }],
    } },
    { name: "v2 installments", extra: {
      mode: "v2", billingMode: "installments", installments: [{ dueDate: "2026-10-01", amountMinor: 1000 }],
    } },
    { name: "v2 custom schedule", extra: {
      mode: "v2", billingMode: "custom_schedule", installments: [{ dueDate: "2026-10-01", amountMinor: 1000 }],
    } },
    { name: "specialty template", extra: {
      mode: "template", templateId: "endo", teeth: [36],
      steps: [{ key: "rct", include: true, serviceId }, { key: "post", include: false }, { key: "crown", include: false }],
    } },
    { name: "unknown mode", extra: { mode: "future-entry" } },
  ];
}

describe("POST /api/plans requires the canonical creation entry", () => {
  it.each(["admin", "reception", "doctorA"] as const)("refuses every old mode for %s without changing stored rows", async (role) => {
    for (const { name, extra } of oldModes()) {
      await withoutWrites(async () => {
        const response = await post(payload({ ...extra, title: `Synthetic retired ${name} ${stamp}` }), h.sessions[role]);
        await expectEntryRequired(response);
      });
    }
  });

  it("rejects retries and simultaneous old-mode requests without creating even partial rows", async () => {
    await withoutWrites(async () => {
      const requests = oldModes().flatMap(({ extra }, index) => [0, 1].map(() =>
        post(payload(extra), h.sessions.admin, { "Idempotency-Key": `plan-entry-${stamp}-${index}` }),
      ));
      const responses = await Promise.all(requests);
      for (const response of responses) await expectEntryRequired(response);
      // A later replay must not find a successfully created object either.
      await expectEntryRequired(await post(payload(), h.sessions.admin, { "Idempotency-Key": `plan-entry-${stamp}-0` }));
    });
  });

  it("does not trust invoice/agreement body flags, query parameters or a same-origin Referer", async () => {
    await withoutWrites(async () => {
      for (const source of ["invoice", "legacy_agreement"]) {
        await expectEntryRequired(await post(payload({
          mode: "v2", source, entryPoint: source, canonicalEntry: true,
          fromInvoice: true, sourceInvoiceId: 123, legacyAgreement: true,
          allowPlanCreation: true, bypass: true,
        }), h.sessions.admin, {
          Referer: `${baseUrl}/patients/${patientAId}?tab=account`,
          "X-Plan-Entry": source, "X-Allow-Plan-Creation": "true",
        }, "?fromInvoice=true&allowPlanCreation=true&entry=invoice"));
      }
    });
  });

  it("preserves 401 for missing or portal-only staff authentication", async () => {
    await withoutWrites(async () => {
      for (const session of [{ cookie: "" }, h.sessions.portalA]) {
        const response = await post(payload(), session);
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({ message: expect.any(String) });
      }
    });
  });

  it.each(["accountant", "cashier"] as const)("preserves the HTTP proxy's 403 for %s", async (role) => {
    await withoutWrites(async () => {
      const response = await post(payload(), h.sessions[role]);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ message: expect.any(String) });
    });
  });

  it("preserves 403 for another doctor's patient even with forged entry hints", async () => {
    await withoutWrites(async () => {
      for (const [session, patientId] of [[h.sessions.doctorA, patientBId], [h.sessions.doctorB, patientAId]] as const) {
        const response = await post(payload({ patientId, mode: "clinical", fromInvoice: true }), session);
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ message: "غير مصرّح لك بإنشاء خطة لهذا المريض." });
      }
    });
  });

  it("retains patient validation, malformed-body rejection and the JSON byte limit", async () => {
    await withoutWrites(async () => {
      for (const patientId of [undefined, null, 0, -1, 1.5, "invalid"]) {
        const response = await post(payload({ patientId }));
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ message: "اختر المريض أولًا." });
      }
      const malformed = await authedMutation("/api/plans", h.sessions.admin, "POST", "{");
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toEqual({ message: "طلب غير صالح." });
      const oversized = await post(payload({ note: "x".repeat(JSON_BODY_LIMIT_BYTES) }));
      expect(oversized.status).toBe(413);
      expect(await oversized.json()).toMatchObject({ message: expect.any(String) });
    });
  });
});
