import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { backupSqlLines } from "../../lib/db";
import { fullBackupBlocks } from "../../lib/fullBackup";
import { parseTarBytes } from "../../lib/restore/archive";
import { openBackupTimestampFixture } from "./_backup-timestamp-fixture";

it("requires the exact public numbering cursor only when the exported public catalog contains patients", async () => {
  const fixture = await openBackupTimestampFixture(process.env);
  const c = await fixture.source.connect();
  const role = "p_counter_reader_" + randomUUID().replaceAll("-", "");
  let createdRole = false;
  const collectSql = async () => {
    let sql = "";
    for await (const line of backupSqlLines(c)) sql += line;
    return sql;
  };
  const collectTar = async () => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of fullBackupBlocks({ source: c })) chunks.push(chunk);
    return parseTarBytes(Buffer.concat(chunks));
  };
  async function refuses(code: string) {
    const incomplete: string[] = [];
    const plain = (async () => {
      for await (const line of backupSqlLines(c)) incomplete.push(line);
    })();
    await expect(plain).rejects.toMatchObject({ code });
    expect(incomplete.join("")).not.toMatch(/\nCOMMIT;\n$/);
    const chunks: Uint8Array[] = [];
    const tar = (async () => {
      for await (const chunk of fullBackupBlocks({ source: c })) chunks.push(chunk);
    })();
    await expect(tar).rejects.toMatchObject({ code });
    expect(chunks).toHaveLength(0);
  }
  try {
    await c.query(`CREATE TABLE public.settings(key text PRIMARY KEY,value text NOT NULL);
      CREATE TABLE public.patient_documents(id serial PRIMARY KEY,storage_key text,sha256 text,size_bytes bigint);
      CREATE SCHEMA shadow;
      CREATE TABLE shadow.patients(id serial PRIMARY KEY);
      CREATE SEQUENCE shadow.patient_number_seq;
      SET search_path TO shadow,public`);
    const partial = await collectSql();
    expect(partial).toContain("\nCOMMIT;\n");
    expect(partial).not.toContain("public.patient_number_seq");
    const tar = await collectTar();
    expect(tar.order).toEqual(["database.sql", "manifest.json"]);
    expect(Buffer.from(tar.entries.get("database.sql")!.data).toString("utf8")).not.toContain(
      "public.patient_number_seq",
    );

    await c.query(`DROP TABLE shadow.patients;
      CREATE TABLE public.patients(id serial PRIMARY KEY,patient_number text NOT NULL)`);
    await refuses("42P01");

    await c.query("CREATE SEQUENCE public.patient_number_seq MINVALUE -5 START WITH -5");
    await expect(collectSql()).rejects.toThrow("Invalid patient-number sequence snapshot");
    await expect(collectTar()).rejects.toThrow("Invalid patient-number sequence snapshot");
    await c.query(`DROP SEQUENCE public.patient_number_seq;
      CREATE TABLE public.patient_number_seq(last_value bigint,is_called boolean);
      INSERT INTO public.patient_number_seq VALUES(7000,false)`);
    await expect(collectSql()).rejects.toThrow("Patient-number sequence snapshot unavailable");
    await expect(collectTar()).rejects.toThrow("Patient-number sequence snapshot unavailable");
    await c.query("DROP TABLE public.patient_number_seq; CREATE SEQUENCE public.patient_number_seq START WITH 7000");
    expect(await collectSql()).toContain("RESTART WITH 7000;");

    await c.query(`CREATE ROLE ${role} NOLOGIN`);
    createdRole = true;
    await c.query(`GRANT USAGE ON SCHEMA public TO ${role};
      GRANT SELECT ON public.patients,public.settings,public.patient_documents TO ${role};
      SET ROLE ${role}`);
    expect(
      (await c.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='patients'"))
        .rows,
    ).toEqual([{ table_name: "patients" }]);
    await refuses("42501");
    await c.query(`RESET ROLE; REVOKE SELECT ON public.patients FROM ${role}; SET ROLE ${role}`);
    expect(
      (await c.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='patients'"))
        .rows,
    ).toHaveLength(0);
    await expect(collectSql()).rejects.toThrow("Public patients table is not exportable");
    await expect(collectTar()).rejects.toThrow("Public patients table is not exportable");
  } finally {
    try {
      await c.query("RESET ROLE");
      if (createdRole) await c.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
    } finally {
      c.release();
      await fixture.close();
    }
  }
});
