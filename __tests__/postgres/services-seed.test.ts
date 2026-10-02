import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Client, Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbClient, DbPool } from "../../lib/db";
import { DEFAULT_SERVICES } from "../../lib/services-catalog";
import { seedDefaultServices } from "../../lib/services-seed";
import { validateOwnershipHarnessEnvironment } from "../../scripts/verify-schema-ownership";

let target: ReturnType<typeof validateOwnershipHarnessEnvironment>;
let database: string;
let connectionString: string;
let created = false;
let observer: Client;
const pools: Pool[] = [];
const borrowers: PoolClient[] = [];

beforeAll(async () => {
  target = validateOwnershipHarnessEnvironment();
  if ([...target.testUrl.searchParams.keys()].some((key) => key !== "sslmode")) throw new Error("Unexpected test connection override.");
  database = `aqlan_schema_ownership_seed_${randomUUID().replace(/-/g, "")}`;
  const admin = new Client({ connectionString: target.maintenanceUrl.toString(), ssl: false });
  await admin.connect();
  try { await admin.query(`CREATE DATABASE ${database}`); created = true; }
  finally { await admin.end(); }
  const url = new URL(target.testUrl); url.pathname = `/${database}`;
  connectionString = url.toString();
  observer = new Client({ connectionString, ssl: false });
  await observer.connect();
  await observer.query(`
    CREATE TABLE services (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, category TEXT,
      price_minor BIGINT NOT NULL, sort_order INTEGER NOT NULL
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
});

beforeEach(async () => {
  await observer.query("ALTER TABLE settings DROP CONSTRAINT IF EXISTS reject_seed_marker");
  await observer.query("TRUNCATE services, settings RESTART IDENTITY");
});

afterEach(async () => {
  for (const client of borrowers.splice(0)) {
    await client.query("ROLLBACK");
    client.release();
  }
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
});

afterAll(async () => {
  await observer?.end();
  if (!created) return;
  const admin = new Client({ connectionString: target.maintenanceUrl.toString(), ssl: false });
  await admin.connect();
  try { await admin.query(`DROP DATABASE ${database} WITH (FORCE)`); }
  finally { await admin.end(); }
});

function poolFor(name: string): Pool {
  const pool = new Pool({ connectionString, ssl: false, max: 3, application_name: name });
  pools.push(pool);
  return pool;
}

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/**
 * Observe actual PostgreSQL statements, never simulate their result. Both access
 * paths are instrumented so the old Pool.query implementation also gets real
 * contention: a borrower holds the connection immediately after BEGIN.
 */
function instrument(pool: Pool, hooks: {
  before?: (sql: string) => Promise<void>;
  after?: (sql: string) => Promise<void>;
}): DbPool {
  async function query<T>(client: Pool | PoolClient, sql: string, values?: unknown[]) {
    await hooks.before?.(sql);
    const result = await client.query(sql, values);
    await hooks.after?.(sql);
    return { rows: result.rows as T[], rowCount: result.rowCount };
  }
  return {
    query: <T>(sql: string, values?: unknown[]) => query<T>(pool, sql, values),
    connect: async (): Promise<DbClient> => {
      const client = await pool.connect();
      return {
        query: <T>(sql: string, values?: unknown[]) => query<T>(client, sql, values),
        release: () => client.release(),
      };
    },
  };
}

async function counts() {
  return (await observer.query(`SELECT
    (SELECT COUNT(*)::int FROM services) AS services,
    (SELECT COUNT(*)::int FROM settings WHERE key='services.seeded') AS markers
  `)).rows[0];
}

async function assertReleased(pool: Pool) {
  expect(pool.idleCount).toBe(pool.totalCount);
  const result = await observer.query(
    "SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND state LIKE 'idle in transaction%'",
    [database],
  );
  expect(result.rows[0].n).toBe(0);
}

describe("default service seed on PostgreSQL 18", () => {
  it("keeps its transaction and lock while unrelated requests borrow the pool", async () => {
    const pool = poolFor("seed-contention");
    const atLock = latch();
    const resume = latch();
    const seed = seedDefaultServices(instrument(pool, {
      after: async (sql) => {
        if (sql === "BEGIN") borrowers.push(await pool.connect());
        if (sql.includes("pg_advisory_xact_lock")) {
          atLock.resolve();
          await resume.promise;
        }
      },
    }));
    try {
      await atLock.promise;
      const heldLock = await observer.query("SELECT COUNT(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND objid=7461 AND database=(SELECT oid FROM pg_database WHERE datname=$1)", [database]);
      expect(heldLock.rows[0].n).toBe(1);
      expect(await counts()).toEqual({ services: 0, markers: 0 });
      // Use the third pool connection while the seed and another borrower hold two.
      expect((await pool.query("SELECT 1 AS healthy")).rows[0].healthy).toBe(1);
    } finally {
      resume.resolve();
      await seed;
    }
    expect(await counts()).toEqual({ services: DEFAULT_SERVICES.length, markers: 1 });
    borrowers.splice(0).forEach((client) => client.release());
    await assertReleased(pool);
  });

  it("commits the marker and catalog together even when a borrower arrives after the insert", async () => {
    const pool = poolFor("seed-marker-atomicity");
    await seedDefaultServices(instrument(pool, {
      after: async (sql) => {
        if (sql.includes("INSERT INTO services")) {
          borrowers.push(await pool.connect());
          expect(await counts()).toEqual({ services: 0, markers: 0 });
        }
      },
    }));
    // The old pool-query transaction could publish only the marker here, leaving
    // catalog rows uncommitted on the borrowed connection and suppressing retries.
    expect(await counts()).toEqual({ services: DEFAULT_SERVICES.length, markers: 1 });
    borrowers.splice(0).forEach((client) => client.release());
    await assertReleased(pool);
    await seedDefaultServices(pool);
    expect(await counts()).toEqual({ services: DEFAULT_SERVICES.length, markers: 1 });
  });

  it("rolls back catalog rows on marker failure under pool contention, then permits retry", async () => {
    await observer.query("ALTER TABLE settings ADD CONSTRAINT reject_seed_marker CHECK (key <> 'services.seeded')");
    const pool = poolFor("seed-rollback");
    await expect(seedDefaultServices(instrument(pool, {
      after: async (sql) => {
        if (sql === "BEGIN") borrowers.push(await pool.connect());
      },
    }))).rejects.toMatchObject({ code: "23514" });
    expect(await counts()).toEqual({ services: 0, markers: 0 });
    borrowers.splice(0).forEach((client) => client.release());
    await assertReleased(pool);
    await observer.query("ALTER TABLE settings DROP CONSTRAINT reject_seed_marker");
    await seedDefaultServices(pool);
    expect(await counts()).toEqual({ services: DEFAULT_SERVICES.length, markers: 1 });
    await assertReleased(pool);
  });

  it("serializes independent seeders across real connections before their empty-catalog decision", async () => {
    const first = poolFor("seed-concurrent-first");
    const second = poolFor("seed-concurrent-second");
    const atLock = latch();
    const resume = latch();
    const attemptingLock = latch();
    const firstSeed = seedDefaultServices(instrument(first, {
      after: async (sql) => {
        if (sql === "BEGIN") borrowers.push(await first.connect());
        if (sql.includes("pg_advisory_xact_lock")) { atLock.resolve(); await resume.promise; }
      },
    }));
    await atLock.promise;
    const secondSeed = seedDefaultServices(instrument(second, {
      before: async (sql) => { if (sql.includes("pg_advisory_xact_lock")) attemptingLock.resolve(); },
      after: async (sql) => { if (sql === "BEGIN") borrowers.push(await second.connect()); },
    }));
    // Handle rejections immediately even while checking the lock from a third client.
    const both = Promise.all([firstSeed, secondSeed]);
    void both.catch(() => {});
    try {
      await attemptingLock.promise;
      let waiting = false;
      const deadline = Date.now() + 5_000;
      do {
        const result = await observer.query("SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND application_name='seed-concurrent-second' AND wait_event='advisory'", [database]);
        waiting = result.rows[0].n === 1;
        if (!waiting) await delay(10);
      } while (!waiting && Date.now() < deadline);
      expect(waiting).toBe(true);
      expect(await counts()).toEqual({ services: 0, markers: 0 });
    } finally {
      resume.resolve();
      await both;
    }
    expect(await counts()).toEqual({ services: DEFAULT_SERVICES.length, markers: 1 });
    expect((await observer.query("SELECT name FROM services GROUP BY name HAVING COUNT(*) > 1")).rows).toEqual([]);
    borrowers.splice(0).forEach((client) => client.release());
    await assertReleased(first);
    await assertReleased(second);
  });

  it("inserts the unchanged default catalog exactly once", async () => {
    const pool = poolFor("seed-idempotent");
    await seedDefaultServices(pool);
    const before = (await observer.query("SELECT * FROM services ORDER BY id")).rows;
    expect(before.map((row) => ({ name: row.name, category: row.category, priceMinor: Number(row.price_minor), sortOrder: row.sort_order }))).toEqual(DEFAULT_SERVICES);
    await seedDefaultServices(pool);
    expect((await observer.query("SELECT * FROM services ORDER BY id")).rows).toEqual(before);
    expect(await counts()).toEqual({ services: DEFAULT_SERVICES.length, markers: 1 });
  });

  it("preserves an owner's existing catalog and only records the marker", async () => {
    await observer.query("INSERT INTO services(name, category, price_minor, sort_order) VALUES ('Owner catalog', 'owner', 12345, 9)");
    const before = (await observer.query("SELECT * FROM services ORDER BY id")).rows;
    await seedDefaultServices(poolFor("seed-owner-catalog"));
    expect((await observer.query("SELECT * FROM services ORDER BY id")).rows).toEqual(before);
    expect(await counts()).toEqual({ services: 1, markers: 1 });
  });

  it("preserves edited or deliberately emptied catalogs when the marker exists", async () => {
    const pool = poolFor("seed-owner-edits");
    await seedDefaultServices(pool);
    await observer.query("UPDATE services SET name='Owner edit', price_minor=98765 WHERE id=1");
    const before = (await observer.query("SELECT * FROM services ORDER BY id")).rows;
    await seedDefaultServices(pool);
    expect((await observer.query("SELECT * FROM services ORDER BY id")).rows).toEqual(before);
    await observer.query("DELETE FROM services");
    await seedDefaultServices(pool);
    expect(await counts()).toEqual({ services: 0, markers: 1 });
  });
});

// Exercise the actual bootstrap caller, including SKIP_SEED and fail-soft logging.
// It uses its own newly generated database and does not share the helper fixtures.
describe("runtime seed integration", () => {
  it("honors SKIP_SEED, completes after seed failure, and succeeds on the next cold start", async () => {
    const runtimeDatabase = `aqlan_schema_ownership_seed_${randomUUID().replace(/-/g, "")}`;
    const admin = new Client({ connectionString: target.maintenanceUrl.toString(), ssl: false });
    await admin.connect();
    let runtimeCreated = false;
    let db: typeof import("../../lib/db") | undefined;
    let runtimeObserver: Client | undefined;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await admin.query(`CREATE DATABASE ${runtimeDatabase}`); runtimeCreated = true;
      const url = new URL(target.testUrl); url.pathname = `/${runtimeDatabase}`;
      vi.stubEnv("DATABASE_URL", url.toString());
      vi.stubEnv("NODE_ENV", "test");
      vi.stubEnv("USE_LOCAL_DB", "false");
      vi.stubEnv("SKIP_SEED", "true");
      db = await import("../../lib/db");
      await db.resetPoolForTesting();
      await db.ensureSchema();
      runtimeObserver = new Client({ connectionString: url.toString(), ssl: false });
      await runtimeObserver.connect();
      expect((await runtimeObserver.query("SELECT COUNT(*)::int AS n FROM services")).rows[0].n).toBe(0);
      expect((await runtimeObserver.query("SELECT key FROM settings WHERE key='services.seeded'")).rows).toEqual([]);
      await runtimeObserver.query("ALTER TABLE settings ADD CONSTRAINT reject_seed_marker CHECK (key <> 'services.seeded')");
      vi.stubEnv("SKIP_SEED", "false");
      await db.resetPoolForTesting();
      await expect(db.ensureSchema()).resolves.toBeUndefined();
      expect(log).toHaveBeenCalledWith("[db] services seed skipped:", expect.objectContaining({ code: "23514" }));
      expect((await runtimeObserver.query("SELECT COUNT(*)::int AS n FROM services")).rows[0].n).toBe(0);
      expect((await runtimeObserver.query("SELECT key FROM settings WHERE key='services.seeded'")).rows).toEqual([]);
      expect((await runtimeObserver.query("SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND state LIKE 'idle in transaction%'", [runtimeDatabase])).rows[0].n).toBe(0);
      await runtimeObserver.query("ALTER TABLE settings DROP CONSTRAINT reject_seed_marker");
      await db.resetPoolForTesting();
      await db.ensureSchema();
      expect((await runtimeObserver.query("SELECT COUNT(*)::int AS n FROM services")).rows[0].n).toBe(DEFAULT_SERVICES.length);
      expect((await runtimeObserver.query("SELECT value FROM settings WHERE key='services.seeded'")).rows).toEqual([{ value: "1" }]);
    } finally {
      await db?.resetPoolForTesting();
      await runtimeObserver?.end();
      vi.unstubAllEnvs();
      log.mockRestore();
      if (runtimeCreated) await admin.query(`DROP DATABASE ${runtimeDatabase} WITH (FORCE)`);
      await admin.end();
    }
  });
});
