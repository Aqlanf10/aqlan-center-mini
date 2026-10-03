import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withTransaction } from "../../lib/transactions";
import { withDefaults } from "../../lib/settings";
import type { DbClient, PlanItemDraft, QueryResult } from "../../lib/db";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (FIN-1) تحصيل قسط الخطة من ملف المريض: إعادة المحاولة لا تُنشئ سندًا ثانيًا.
 *
 * كان POST /api/plans/[id] يسجّل فاتورةً وسند قبضٍ في كل طلب بلا مفتاح إعادة: ينقطع
 * الرد بعد الالتزام («تعذّر الاتصال بالخادم»)، فيضغط المحصّل «تحصيل» ثانيةً — فاتورتان
 * وسندان عن نقدٍ قُبض مرة واحدة، ودرجٌ «متوقَّعه» أكبر من الحقيقة. الدفعات العادية
 * محميةٌ بهذا منذ P1-1؛ هذا المسار وحده بقي بلا حماية.
 *
 * الآن: المفتاح نفسه بالعملية نفسها ⇒ السند الأول نفسه (replay)؛ وبعملية مختلفة ⇒
 * idempotency_conflict — والمفاتيح في فضاء السندات نفسه مع recordPayment.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const {
  getPool, resetPoolForTesting, ensureSchema, openShift, recordPayment, recordPlanInstallment, createPlanV2,
  createPlan, createPlanInTransaction, createPlanV2InTransaction, PlanCreationRefusal,
  getSettings, getSettingsInTransaction, invalidateSettingsCache, listServices, listServicesInTransaction,
} = await import("../../lib/db");

let patientId: number;
let planId: number;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  await openShift({ openedBy: "fin1", opening: { YER: 0, SAR: 0, USD: 0 } });
  const pool = getPool();
  const { rows: [patient] } = await pool.query(
    `INSERT INTO patients (patient_number, full_name) VALUES ('FIN1-1', 'مريض أقساط') RETURNING id`,
  );
  patientId = patient.id;
  const plan = await createPlanV2({
    patientId, title: "تقويم ثابت", specialty: null, primaryDoctorId: null,
    billingMode: "installments", baseCurrency: "YER", startDate: "2026-01-01", note: null,
    items: [], installments: [
      { dueDate: "2026-01-01", amountMinor: 5_000_000 },
      { dueDate: "2026-02-01", amountMinor: 5_000_000 },
    ],
    createdBy: "fin1",
  });
  expect(plan.ok).toBe(true);
  if (plan.ok) planId = plan.planId;
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

const collect = (key: string | null, amountMinor = 5_000_000, actor = "reception1") =>
  recordPlanInstallment({
    planId, patientId, installmentNumber: 1, planTitle: "تقويم ثابت",
    amountMinor, currency: "YER", baseCurrency: "YER", exchangeRate: 1,
    method: "cash", note: null, createdBy: actor, idempotencyKey: key,
  });

async function countsFor(key: string) {
  const { rows: [row] } = await getPool().query<{ payments: number; invoices: number }>(
    `SELECT (SELECT COUNT(*)::int FROM payments WHERE idempotency_key = $1) AS payments,
            (SELECT COUNT(*)::int FROM invoices i JOIN payments y ON y.invoice_id = i.id
              WHERE y.idempotency_key = $1) AS invoices`,
    [key],
  );
  return row;
}

async function planTotals() {
  const { rows: [row] } = await getPool().query<{ payments: number; invoices: number }>(
    `SELECT (SELECT COUNT(*)::int FROM payments WHERE plan_id = $1) AS payments,
            (SELECT COUNT(*)::int FROM invoices WHERE plan_id = $1) AS invoices`,
    [planId],
  );
  return row;
}

describe("(FIN-1) plan installment collection is idempotent", () => {
  it("a retry with the same key returns the first receipt — one invoice, one payment", async () => {
    const before = await planTotals();
    const first = await collect("inst:retry-0001");
    const again = await collect("inst:retry-0001");
    expect("paymentId" in first && "paymentId" in again).toBe(true);
    if (!("paymentId" in first) || !("paymentId" in again)) return;
    expect(again.paymentId).toBe(first.paymentId);
    expect(again.invoiceId).toBe(first.invoiceId);
    expect(again.replayed).toBe(true);
    expect(first.replayed).toBeFalsy();
    expect(await countsFor("inst:retry-0001")).toEqual({ payments: 1, invoices: 1 });
    const after = await planTotals();
    expect(after.payments - before.payments).toBe(1);
    expect(after.invoices - before.invoices).toBe(1);
  });

  it("five concurrent submissions with one key record a single receipt", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => collect("inst:burst-0001")));
    const ids = new Set(results.map((result) => ("paymentId" in result ? result.paymentId : null)));
    expect(ids.size).toBe(1);
    expect([...ids][0]).not.toBeNull();
    expect(await countsFor("inst:burst-0001")).toEqual({ payments: 1, invoices: 1 });
  });

  it("the same key for a different amount or another actor is a conflict, not a replay", async () => {
    await collect("inst:conflict-01", 5_000_000);
    expect(await collect("inst:conflict-01", 4_000_000)).toEqual({ reason: "idempotency_conflict" });
    expect(await collect("inst:conflict-01", 5_000_000, "reception2")).toEqual({ reason: "idempotency_conflict" });
    expect(await countsFor("inst:conflict-01")).toEqual({ payments: 1, invoices: 1 });
  });

  it("a key already spent on an ordinary payment cannot be reused for an installment", async () => {
    const paid = await recordPayment({
      patientId, invoiceId: null, kind: "payment", amountMinor: 100_000, currency: "YER",
      baseCurrency: "YER", exchangeRate: 1, method: "cash", note: null, createdBy: "reception1",
      idempotencyKey: "shared:key-0001",
    });
    expect(paid.payment).not.toBeNull();
    expect(await collect("shared:key-0001")).toEqual({ reason: "idempotency_conflict" });
    expect((await countsFor("shared:key-0001")).payments).toBe(1);
  });

  it("without a key each call is its own collection (unchanged behaviour)", async () => {
    const before = await planTotals();
    await collect(null);
    await collect(null);
    const after = await planTotals();
    expect(after.payments - before.payments).toBe(2);
  });
});

// Extraction prerequisite only: uses this existing guarded PG test file's real,
// already-linked patient and schema lifecycle. No new connection/target harness.
const writerItem = (overrides: Partial<PlanItemDraft> = {}): PlanItemDraft => ({
  serviceId: null, serviceName: "Synthetic writer item", category: "filling", toothCode: 11,
  surfaces: null, quantity: 1, unitPriceMinor: 300, billingRule: "on_completion",
  sessionCount: 2, note: null, ...overrides,
});
function writerInput(items: PlanItemDraft[] = [writerItem()]) {
  return {
    patientId, title: "Synthetic writer extraction", specialty: null, primaryDoctorId: null,
    billingMode: "custom_schedule" as const, baseCurrency: "SAR" as const, startDate: "2028-01-03",
    note: null, createdBy: "synthetic-writer", items,
    installments: [{ dueDate: "2028-01-03", amountMinor: 100 }, { dueDate: "2028-02-03", amountMinor: 200 }],
  };
}
const legacyWriterInput = () => ({
  patientId, title: " Legacy writer title ", totalMinor: 300, baseCurrency: "USD" as const,
  startDate: "2028-01-03", note: " legacy writer note ", createdBy: "synthetic-writer",
  installments: [{ number: 3, dueDate: "2028-01-03", amountMinor: 100 }, { number: 5, dueDate: "2028-02-03", amountMinor: 200 }],
});
async function writerSnapshot() {
  const { rows: [row] } = await getPool().query<{ snapshot: unknown }>(`SELECT jsonb_build_object(
    'plans', (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM treatment_plans t WHERE t.patient_id = $1),
    'items', (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM plan_items i JOIN treatment_plans t ON t.id = i.plan_id WHERE t.patient_id = $1),
    'sessions', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM treatment_sessions s JOIN plan_items i ON i.id = s.plan_item_id JOIN treatment_plans t ON t.id = i.plan_id WHERE t.patient_id = $1),
    'visits', (SELECT jsonb_agg(to_jsonb(v) ORDER BY v.id) FROM planned_visits v WHERE v.patient_id = $1),
    'installments', (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM plan_installments i JOIN treatment_plans t ON t.id = i.plan_id WHERE t.patient_id = $1),
    'audits', (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM audit_log a WHERE a.actor = 'synthetic-writer')
  ) AS snapshot`, [patientId]);
  return row.snapshot;
}
async function unrelatedWriterSnapshot() {
  const snapshot: Record<string, unknown> = {};
  for (const table of ["invoices", "invoice_items", "payments", "cashier_shifts", "inventory_movements", "lab_orders", "journal_manual", "journal_manual_lines", "commission_case_overrides"]) {
    snapshot[table] = (await getPool().query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return snapshot;
}
async function withWriterFault(
  match: (sql: string) => boolean,
  occurrence: number,
  work: (evidence: { commands: string[]; error: Error; releases: () => number }) => Promise<void>,
) {
  const pool = getPool(); const originalConnect = pool.connect.bind(pool);
  const commands: string[] = []; let matches = 0, released = 0;
  const error = new Error("synthetic writer execution failure");
  const spy = vi.spyOn(pool, "connect").mockImplementation(async (): Promise<DbClient> => {
    const client = await originalConnect();
    return {
      query: async <T>(sql: string, values?: unknown[]): Promise<QueryResult<T>> => {
        commands.push(sql);
        if (match(sql) && ++matches === occurrence) throw error;
        return client.query<T>(sql, values);
      },
      release: () => { released += 1; client.release(); },
    };
  });
  try { await work({ commands, error, releases: () => released }); }
  finally { spy.mockRestore(); }
}

describe("plan writer extraction: public parity and actual PostgreSQL rollback", () => {
  it.each(["YER", "SAR", "USD"] as const)("keeps legacy raw values/numbering and no-key creates in %s", async (baseCurrency) => {
    const input = { ...legacyWriterInput(), baseCurrency }; const unrelated = await unrelatedWriterSnapshot();
    const first = await createPlan(input); const second = await createPlan(input);
    expect(Number.isInteger(first)).toBe(true); expect(first).not.toBe(second);
    expect((await getPool().query(`SELECT title, total_minor::text, base_currency, start_date::text, note, created_by
      FROM treatment_plans WHERE id = $1`, [first])).rows).toEqual([
      { title: input.title, total_minor: "300", base_currency: baseCurrency, start_date: input.startDate, note: input.note, created_by: input.createdBy },
    ]);
    expect((await getPool().query(`SELECT number, due_date::text, amount_minor::text
      FROM plan_installments WHERE plan_id = $1 ORDER BY number`, [first])).rows).toEqual([
      { number: 3, due_date: "2028-01-03", amount_minor: "100" }, { number: 5, due_date: "2028-02-03", amount_minor: "200" },
    ]);
    expect(await unrelatedWriterSnapshot()).toEqual(unrelated);
  });
  it("keeps zero-total empty legacy plans and empty-V2 refusal before connection acquisition", async () => {
    const id = await createPlan({ ...legacyWriterInput(), totalMinor: 0, installments: [] });
    expect(Number.isInteger(id)).toBe(true);
    const before = await writerSnapshot();
    const spy = vi.spyOn(getPool(), "connect");
    try {
      expect(await createPlanV2({ ...writerInput([]), installments: [] })).toEqual({ ok: false, message: "أضف بنود الخطة أو المبلغ المتفق عليه." });
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
    expect(await writerSnapshot()).toEqual(before);
  });
  it.each(["name", "tooth"])("late %s refusal returns the unchanged false result after full rollback", async (reason) => {
    const invalid = writerItem(reason === "name" ? { serviceName: " " } : { toothCode: 99 });
    const before = await writerSnapshot(); const unrelated = await unrelatedWriterSnapshot();
    expect(await createPlanV2(writerInput([writerItem(), invalid]))).toEqual({ ok: false,
      message: reason === "name" ? "لكل بندٍ خدمةٌ من الدليل." : "رقم سنّ غير صحيح بالترقيم الدولي." });
    expect(await writerSnapshot()).toEqual(before); expect(await unrelatedWriterSnapshot()).toEqual(unrelated);
  });
  it("rolls back template visits inserted before discovering a bad item", async () => {
    const before = await writerSnapshot();
    const sessionPlan = [{ title: "Synthetic session", minutes: 30, afterDays: 7, visitKey: "f:0", visitTitle: "Synthetic visit" }];
    expect(await createPlanV2(writerInput([writerItem({ serviceName: " ", sessionPlan })])))
      .toEqual({ ok: false, message: "لكل بندٍ خدمةٌ من الدليل." });
    expect(await writerSnapshot()).toEqual(before);
  });
  it("keeps nonpositive-total refusal with no saved plan", async () => {
    const before = await writerSnapshot();
    expect(await createPlanV2(writerInput([writerItem({ unitPriceMinor: 0 })])))
      .toEqual({ ok: false, message: "إجمالي الخطة يجب أن يكون أكبر من صفر." });
    expect(await writerSnapshot()).toEqual(before);
  });
  it.each(["treatment_plans", "plan_items", "planned_visits", "treatment_sessions", "plan_installments"])("rolls back the complete bundle on injected %s insert failure", async (table) => {
      const before = await writerSnapshot(); const unrelated = await unrelatedWriterSnapshot();
      await withWriterFault((sql) => sql.includes(`INSERT INTO ${table}`), table === "treatment_plans" ? 1 : 2, async (evidence) => {
        await expect(createPlanV2(writerInput([writerItem(), writerItem({ toothCode: 12 })]))).rejects.toBe(evidence.error);
        expect(evidence.commands.at(-1)).toBe("ROLLBACK");
        expect(evidence.commands).not.toContain("COMMIT"); expect(evidence.releases()).toBe(1);
      });
      expect(await writerSnapshot()).toEqual(before); expect(await unrelatedWriterSnapshot()).toEqual(unrelated);
    });
  it("legacy installment failure rolls back both the plan and prior installment", async () => {
    const before = await writerSnapshot();
    await withWriterFault((sql) => sql.includes("INSERT INTO plan_installments"), 2, async (evidence) => {
      await expect(createPlan(legacyWriterInput())).rejects.toBe(evidence.error);
      expect(evidence.commands.at(-1)).toBe("ROLLBACK"); expect(evidence.releases()).toBe(1);
    });
    expect(await writerSnapshot()).toEqual(before);
  });
  it.each(["BEGIN", "COMMIT"])("preserves rollback/rethrow/release when %s rejects before execution", async (command) => {
    for (const write of [() => createPlan(legacyWriterInput()), () => createPlanV2(writerInput())]) {
      const before = await writerSnapshot();
      await withWriterFault((sql) => sql === command, 1, async (evidence) => {
        await expect(write()).rejects.toBe(evidence.error);
        expect(evidence.commands.at(-1)).toBe("ROLLBACK"); expect(evidence.releases()).toBe(1);
      });
      expect(await writerSnapshot()).toEqual(before);
    }
  });
  it("a failed refusal ROLLBACK is retried by the old outer cleanup and throws, never false success", async () => {
    const before = await writerSnapshot();
    await withWriterFault((sql) => sql === "ROLLBACK", 1, async (evidence) => {
      await expect(createPlanV2(writerInput([writerItem(), writerItem({ serviceName: " " })]))).rejects.toBe(evidence.error);
      expect(evidence.commands.slice(-2)).toEqual(["ROLLBACK", "ROLLBACK"]);
      expect(evidence.commands).not.toContain("COMMIT"); expect(evidence.releases()).toBe(1);
    });
    expect(await writerSnapshot()).toEqual(before);
  });
});

describe("extracted writers compose in one externally owned transaction", () => {
  it("commits both writers once and does not acquire an inner connection", async () => {
    const pool = getPool();
    const controls: string[] = []; const unrelated = await unrelatedWriterSnapshot();
    // Start measuring only after fixture evidence reads; those use pool.query/connect.
    const connect = vi.spyOn(pool, "connect");
    let result: { legacyId: number; planId: number };
    try {
      result = await withTransaction(pool, async (client) => {
        const query = client.query.bind(client);
        const tracked: DbClient = {
          query: async <T>(sql: string, values?: unknown[]) => {
            if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) controls.push(sql);
            return query<T>(sql, values);
          },
          release: () => { throw new Error("Inner writer released its caller-owned client"); },
        };
        const legacyId = await createPlanInTransaction(tracked, legacyWriterInput());
        const created = await createPlanV2InTransaction(tracked, writerInput());
        return { legacyId, planId: created.planId };
      });
      expect(connect).toHaveBeenCalledTimes(1);
    } finally { connect.mockRestore(); }
    expect(controls).toEqual([]); // Only the outer withTransaction can control the transaction.
    expect((await pool.query(`SELECT COUNT(*)::int AS n FROM treatment_plans WHERE id = ANY($1::int[])`, [[result.legacyId, result.planId]])).rows[0].n).toBe(2);
    expect(await unrelatedWriterSnapshot()).toEqual(unrelated);
  });
  it("a late typed refusal rolls back the earlier composed legacy plan and installments too", async () => {
    const before = await writerSnapshot();
    await expect(withTransaction(getPool(), async (client) => {
      await createPlanInTransaction(client, legacyWriterInput());
      return createPlanV2InTransaction(client, writerInput([writerItem(), writerItem({ toothCode: 99 })]));
    })).rejects.toBeInstanceOf(PlanCreationRefusal);
    expect(await writerSnapshot()).toEqual(before);
  });
  it("a downstream error after both complete writers rolls back every created row", async () => {
    const before = await writerSnapshot(); const unrelated = await unrelatedWriterSnapshot();
    const failure = new Error("synthetic downstream command failure");
    await expect(withTransaction(getPool(), async (client) => {
      await createPlanInTransaction(client, legacyWriterInput());
      await createPlanV2InTransaction(client, writerInput());
      throw failure;
    })).rejects.toBe(failure);
    expect(await writerSnapshot()).toEqual(before); expect(await unrelatedWriterSnapshot()).toEqual(unrelated);
  });
});

// Catalog-reader prerequisite only. Reuses this file's guarded database/schema
// lifecycle and linked plan fixture; no alternate target or unlinked harness.
async function onlyCatalogClient<T>(
  client: DbClient, work: (tracked: DbClient, statements: string[]) => Promise<T>,
): Promise<T> {
  const statements: string[] = [];
  const query = vi.spyOn(getPool(), "query").mockImplementation(async () => {
    throw new Error("Catalog reader used the pool instead of its supplied client");
  });
  const connect = vi.spyOn(getPool(), "connect").mockImplementation(async () => {
    throw new Error("Catalog reader acquired an inner connection");
  });
  const tracked: DbClient = {
    query: async <R>(sql: string, values?: unknown[]): Promise<QueryResult<R>> => {
      statements.push(sql);
      return client.query<R>(sql, values);
    },
    release: () => { throw new Error("Catalog reader released its caller-owned client"); },
  };
  try { return await work(tracked, statements); }
  finally { query.mockRestore(); connect.mockRestore(); }
}

describe("same-client plan catalog readers on existing linked PostgreSQL fixture", () => {
  it("matches public settings and active/all catalog results on the supplied client", async () => {
    invalidateSettingsCache();
    const settings = await getSettings();
    const active = await listServices(); const all = await listServices(true);
    await withTransaction(getPool(), (client) => onlyCatalogClient(client, async (tracked, statements) => {
      expect(await getSettingsInTransaction(tracked)).toEqual(settings);
      expect(await listServicesInTransaction(tracked)).toEqual(active);
      expect(await listServicesInTransaction(tracked, false)).toEqual(active);
      expect(await listServicesInTransaction(tracked, true)).toEqual(all);
      expect(statements).toHaveLength(4);
      expect(statements.every((sql) => /^SELECT\b/.test(sql))).toBe(true);
    }));
  });

  it("sees successive uncommitted settings and defaults without reading or replacing warm process cache", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const rollback = new Error("rollback synthetic settings changes");
    invalidateSettingsCache();
    try {
      const committed = await getSettings();
      await expect(withTransaction(getPool(), async (client) => {
        await client.query(`INSERT INTO settings (key, value) VALUES
          ('clinic.name', 'Synthetic transaction clinic'), ('clinic.chairs', '')
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
        await onlyCatalogClient(client, async (tracked, statements) => {
          const first = await getSettingsInTransaction(tracked);
          expect(first).toEqual(withDefaults({ ...committed, "clinic.name": "Synthetic transaction clinic", "clinic.chairs": "" }));
          expect(first).not.toBe(committed);
          expect(await getSettings()).toBe(committed);
          await client.query("UPDATE settings SET value = 'Synthetic second value' WHERE key = 'clinic.name'");
          const second = await getSettingsInTransaction(tracked);
          expect(second["clinic.name"]).toBe("Synthetic second value");
          expect(first["clinic.name"]).toBe("Synthetic transaction clinic");
          expect(await getSettings()).toBe(committed);
          expect(statements).toEqual(["SELECT key, value FROM settings", "SELECT key, value FROM settings"]);
        });
        throw rollback;
      })).rejects.toBe(rollback);
      expect(await getSettings()).toBe(committed);
      invalidateSettingsCache();
      expect(await getSettings()).toEqual(committed);
    } finally { clock.mockRestore(); invalidateSettingsCache(); }
  });

  it("never publishes an uncommitted settings result when process cache is empty", async () => {
    invalidateSettingsCache();
    const committed = await getSettings();
    invalidateSettingsCache();
    const rollback = new Error("rollback cold-cache settings changes");
    await expect(withTransaction(getPool(), async (client) => {
      await client.query(`INSERT INTO settings (key, value) VALUES ('clinic.name', 'Synthetic unpublished clinic')
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
      await onlyCatalogClient(client, async (tracked) => {
        expect((await getSettingsInTransaction(tracked))["clinic.name"]).toBe("Synthetic unpublished clinic");
      });
      throw rollback;
    })).rejects.toBe(rollback);
    const query = vi.spyOn(getPool(), "query");
    try {
      const visible = await getSettings();
      expect(visible).toEqual(committed);
      expect(query.mock.calls.filter(([sql]) => sql === "SELECT key, value FROM settings")).toHaveLength(1);
    } finally { query.mockRestore(); invalidateSettingsCache(); }
  });

  it("keeps the public five-second TTL and does not extend it through transaction reads", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    invalidateSettingsCache();
    const query = vi.spyOn(getPool(), "query");
    try {
      const first = await getSettings();
      clock.mockReturnValue(5_999);
      expect(await getSettings()).toBe(first);
      await withTransaction(getPool(), async (client) => {
        expect(await getSettingsInTransaction(client)).toEqual(first);
      });
      clock.mockReturnValue(6_000);
      const expired = await getSettings();
      expect(expired).toEqual(first); expect(expired).not.toBe(first);
      expect(query.mock.calls.filter(([sql]) => sql === "SELECT key, value FROM settings")).toHaveLength(2);
      invalidateSettingsCache();
      expect(await getSettings()).not.toBe(expired);
      expect(query.mock.calls.filter(([sql]) => sql === "SELECT key, value FROM settings")).toHaveLength(3);
    } finally { query.mockRestore(); clock.mockRestore(); invalidateSettingsCache(); }
  });

  it("reads uncommitted catalog state, exact sort order and all currency price mappings without pooling", async () => {
    const committed = await listServices(true);
    const rollback = new Error("rollback synthetic service catalog changes");
    await expect(withTransaction(getPool(), async (client) => {
      const { rows } = await client.query<{ id: number; name: string }>(`INSERT INTO services
        (name, category, price_minor, is_active, sort_order, price_configured, price_provisional, price_sar_minor, price_usd_minor)
        VALUES ('Synthetic catalog Z', 'filling', 12345, TRUE, 9100, TRUE, FALSE, 987, NULL),
               ('Synthetic catalog B', NULL, 0, FALSE, 9101, FALSE, TRUE, NULL, 0),
               ('Synthetic catalog A', 'exam', 999, TRUE, 9101, TRUE, FALSE, 0, 456)
        RETURNING id, name`);
      const ids = rows.map((row) => row.id);
      const idFor = (name: string) => rows.find((row) => row.name === name)!.id;
      await onlyCatalogClient(client, async (tracked, statements) => {
        const all = (await listServicesInTransaction(tracked, true)).filter((service) => ids.includes(service.id));
        expect(all).toEqual([
          { id: idFor("Synthetic catalog Z"), name: "Synthetic catalog Z", category: "filling", priceMinor: 12345,
            isActive: true, sortOrder: 9100, priceConfigured: true, priceProvisional: false, priceSarMinor: 987, priceUsdMinor: null },
          { id: idFor("Synthetic catalog A"), name: "Synthetic catalog A", category: "exam", priceMinor: 999,
            isActive: true, sortOrder: 9101, priceConfigured: true, priceProvisional: false, priceSarMinor: 0, priceUsdMinor: 456 },
          { id: idFor("Synthetic catalog B"), name: "Synthetic catalog B", category: null, priceMinor: 0,
            isActive: false, sortOrder: 9101, priceConfigured: false, priceProvisional: true, priceSarMinor: null, priceUsdMinor: 0 },
        ]);
        expect((await listServicesInTransaction(tracked)).filter((service) => ids.includes(service.id)))
          .toEqual(all.filter((service) => service.isActive));
        await client.query("UPDATE services SET is_active = FALSE, price_minor = 54321 WHERE id = $1", [idFor("Synthetic catalog Z")]);
        const current = (await listServicesInTransaction(tracked, true)).find((service) => service.id === idFor("Synthetic catalog Z"));
        expect(current).toMatchObject({ isActive: false, priceMinor: 54321 });
        expect((await listServicesInTransaction(tracked)).filter((service) => ids.includes(service.id)).map((service) => service.name))
          .toEqual(["Synthetic catalog A"]);
        expect(statements).toHaveLength(4);
        expect(statements.every((sql) => /^SELECT\b/.test(sql))).toBe(true);
      });
      // A separate committed reader must not see the transaction's new services.
      expect(await listServices(true)).toEqual(committed);
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await listServices(true)).toEqual(committed);
  });

  it.each([
    ["settings", getSettingsInTransaction], ["services", listServicesInTransaction],
  ] as const)("propagates a real PostgreSQL %s read error without returning cached/default data", async (_name, read) => {
    invalidateSettingsCache();
    const committed = await getSettings();
    await expect(withTransaction(getPool(), async (client) => {
      await client.query("SET LOCAL search_path = pg_catalog");
      return onlyCatalogClient(client, async (tracked) => { await read(tracked); });
    })).rejects.toMatchObject({ code: "42P01" });
    expect(await getSettings()).toEqual(committed);
    invalidateSettingsCache();
  });

  it.each(["price_minor", "price_sar_minor", "price_usd_minor"] as const)("preserves %s safe-integer rejection and outer rollback", async (column) => {
    const committed = await listServices(true);
    await expect(withTransaction(getPool(), async (client) => {
      // Column comes solely from the fixed test allowlist above.
      await client.query(`INSERT INTO services (name, price_minor, price_sar_minor, price_usd_minor)
        VALUES ('Synthetic unsafe catalog price', 1, 1, 1)`);
      await client.query(`UPDATE services SET ${column} = 9007199254740992 WHERE name = 'Synthetic unsafe catalog price'`);
      return onlyCatalogClient(client, async (tracked) => listServicesInTransaction(tracked));
    })).rejects.toThrow("قيمة مالية خارج نطاق الأعداد الصحيحة الآمنة");
    expect(await listServices(true)).toEqual(committed);
  });
});
