import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { validatePostgresTestTarget } from "./_safe-target";
import { ensureSchema, resetPoolForTesting } from "../../lib/db";
import { catalogHash, readOrthoCatalog } from "../../lib/ortho-reconciliation-catalog";
import { readLanguageContract } from "../../lib/ortho-language-contract";

describe("semantic language contract across independent allocations", () => {
  const suffix = randomBytes(8).toString("hex"), other = `language_other_${suffix}`;
  const names = [`aqlan_language_${suffix}_a`, `aqlan_language_${suffix}_b`];
  const saved = { DATABASE_URL: process.env.DATABASE_URL, SKIP_SEED: process.env.SKIP_SEED };
  let admin: Client, target: ReturnType<typeof validatePostgresTestTarget>;
  const clients: Client[] = [], owned: { name: string; oid: string; owner: string }[] = [];
  let languageOid: string, baseline: Record<string, unknown>;
  beforeAll(async () => {
    target = validatePostgresTestTarget(process.env);
    const maintenance = new URL(target.testUrl); maintenance.pathname = "/postgres";
    admin = new Client({ connectionString: maintenance.toString(), ssl: false }); await admin.connect();
    await admin.query(`CREATE ROLE "${other}" NOLOGIN NOSUPERUSER`);
    for (const [index, name] of names.entries()) {
      await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
      owned.push((await admin.query("SELECT datname AS name,oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1", [name])).rows[0]);
      const url = new URL(target.testUrl); url.pathname = `/${name}`;
      const client = new Client({ connectionString: url.toString(), ssl: false }); await client.connect(); clients.push(client);
      // Supported extension DDL only, before schema bootstrap in a fresh DB.
      if (index === 1) { await client.query("DROP EXTENSION plpgsql"); await client.query("CREATE EXTENSION plpgsql"); }
      process.env.DATABASE_URL = url.toString(); process.env.SKIP_SEED = "true";
      await resetPoolForTesting(); await ensureSchema(); await resetPoolForTesting();
    }
    languageOid = (await clients[1].query("SELECT oid::text FROM pg_language WHERE lanname='plpgsql'")).rows[0].oid;
    baseline = await readLanguageContract(clients[1], languageOid);
  });
  afterAll(async () => {
    await resetPoolForTesting();
    for (const client of clients) await client.end();
    for (const identity of owned) {
      const actual = (await admin.query("SELECT oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1", [identity.name])).rows[0];
      if (actual?.oid !== identity.oid || actual?.owner !== identity.owner) throw new Error("SYNTHETIC_CLEANUP_IDENTITY");
      await admin.query(`DROP DATABASE "${identity.name}"`);
    }
    if (admin) { await admin.query(`DROP ROLE "${other}"`); await admin.end(); }
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  it("accepts equivalent full catalogs with different language and handler OIDs", async () => {
    const before = (await clients[0].query("SELECT oid::text,lanplcallfoid::text FROM pg_language WHERE lanname='plpgsql'")).rows[0];
    const after = (await clients[1].query("SELECT oid::text,lanplcallfoid::text FROM pg_language WHERE lanname='plpgsql'")).rows[0];
    expect(before.oid).not.toBe(after.oid); expect(before.lanplcallfoid).not.toBe(after.lanplcallfoid);
    expect(await readLanguageContract(clients[0], before.oid)).toEqual(baseline);
    expect(catalogHash(await readOrthoCatalog(clients[0], "0051"))).toBe(catalogHash(await readOrthoCatalog(clients[1], "0051")));
  });
  it.each(["handler", "validator", "trust", "owner", "acl", "handler_owner", "handler_acl", "security_definer", "config", "prosrc", "probin", "dependency"])("rejects same-name language with changed %s contract", async defect => {
    const client = clients[1]; await client.query("BEGIN");
    try {
      const call = "pg_catalog.plpgsql_call_handler()";
      if (defect === "owner") await client.query(`ALTER LANGUAGE plpgsql OWNER TO "${other}"`);
      if (defect === "acl") await client.query("REVOKE USAGE ON LANGUAGE plpgsql FROM PUBLIC");
      if (defect === "handler_owner") await client.query(`ALTER FUNCTION ${call} OWNER TO "${other}"`);
      if (defect === "handler_acl") await client.query(`REVOKE EXECUTE ON FUNCTION ${call} FROM PUBLIC`);
      if (defect === "security_definer") await client.query(`ALTER FUNCTION ${call} SECURITY DEFINER`);
      if (defect === "config") await client.query(`ALTER FUNCTION ${call} SET search_path TO public`);
      if (defect === "dependency") await client.query(`ALTER EXTENSION plpgsql DROP FUNCTION ${call}`);
      if (defect === "prosrc" || defect === "probin") {
        await client.query(`CREATE OR REPLACE FUNCTION ${call} RETURNS language_handler AS '${defect === "probin" ? "$libdir/plpgsql.so" : "$libdir/plpgsql"}', '${defect === "prosrc" ? "plpgsql_validator" : "plpgsql_call_handler"}' LANGUAGE c`);
      }
      if (["handler", "validator", "trust"].includes(defect)) {
        if (defect === "handler") await client.query("CREATE FUNCTION public.synthetic_language_handler() RETURNS language_handler AS '$libdir/plpgsql','plpgsql_call_handler' LANGUAGE c");
        if (defect === "validator") await client.query("CREATE FUNCTION public.synthetic_language_validator(oid) RETURNS void AS '$libdir/plpgsql','plpgsql_validator' LANGUAGE c");
        await client.query(`CREATE OR REPLACE ${defect === "trust" ? "" : "TRUSTED"} PROCEDURAL LANGUAGE plpgsql HANDLER ${defect === "handler" ? "public.synthetic_language_handler" : "pg_catalog.plpgsql_call_handler"} INLINE pg_catalog.plpgsql_inline_handler VALIDATOR ${defect === "validator" ? "public.synthetic_language_validator" : "pg_catalog.plpgsql_validator"}`);
      }
      expect(catalogHash(await readLanguageContract(client, languageOid))).not.toBe(catalogHash(baseline));
    } finally { await client.query("ROLLBACK"); }
    expect(await readLanguageContract(client, languageOid)).toEqual(baseline);
  });
  it("refuses an unresolved language", async () => { await expect(readLanguageContract(clients[1], "0")).rejects.toThrow("ORTHO_LANGUAGE_CONTRACT_UNRESOLVED"); });
});
