import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildPreflightArtifact } from "../scripts/build-preflight";
import { loadMigrationFiles } from "../lib/migration-files";

const execute = promisify(execFile);
let temporary: string;
let artifact: string;
let manifest: Awaited<ReturnType<typeof buildPreflightArtifact>>;
const canary = `synthetic-build-secret-${randomUUID()}`;

beforeAll(async () => {
  temporary = await mkdtemp(path.join(tmpdir(), "aqlan-preflight-artifact-"));
  artifact = path.join(temporary, "preflight");
  vi.stubEnv("AQLAN_BUILD_SECRET_CANARY", canary);
  vi.stubEnv("DATABASE_URL", `postgresql://synthetic:${canary}@invalid.example/build_only`);
  manifest = await buildPreflightArtifact(artifact);
  vi.unstubAllEnvs();
});
afterAll(async () => { vi.unstubAllEnvs(); if (temporary) await rm(temporary, { recursive: true, force: true }); });

describe("packaged read-only preflight", () => {
  it("runs from an isolated directory without TypeScript or node_modules", async () => {
    expect((await readdir(temporary)).sort()).toEqual(["preflight"]);
    expect((await readdir(artifact)).sort()).toEqual(["THIRD_PARTY_NOTICES.txt", "manifest.json", "migrations", "runner"]);
    const result = await execute(process.execPath, [path.join(artifact, "runner/run.mjs"), "--help"], {
      cwd: temporary, env: { ...process.env, DATABASE_URL: "", NODE_ENV: "production" },
    });
    expect(result.stdout).toContain("no writes");
    await expect(execute(process.execPath, [path.join(artifact, "runner/run.mjs"), "--apply"], { cwd: temporary }))
      .rejects.toMatchObject({ code: 1, stdout: "", stderr: expect.stringContaining("CLI_ARGUMENTS_INVALID") });
  });

  it("ships exact immutable migration bytes and contains no build-time secret values", async () => {
    const source = await loadMigrationFiles();
    const packaged = await loadMigrationFiles(path.join(artifact, "migrations"));
    expect(packaged).toEqual(source);
    expect(manifest.migrations.map((file) => file.checksum)).toEqual(source.map((file) => file.checksum));
    const bundle = await readFile(path.join(artifact, "runner/run.mjs"), "utf8");
    expect(bundle).not.toContain(canary);
    expect(await readFile(path.join(artifact, "manifest.json"), "utf8")).not.toContain(canary);
    expect(createHash("sha256").update(bundle).digest("hex")).toBe(manifest.bundleSha256);
    expect(manifest.nodeMajor).toBe(22);
    const notices = await readFile(path.join(artifact, "THIRD_PARTY_NOTICES.txt"), "utf8");
    expect(notices).not.toContain(canary);
    expect(manifest.bundledPackages.map((pkg) => pkg.name)).toEqual(expect.arrayContaining([
      "pg", "pg-pool", "pg-protocol", "pg-types", "pgpass", "split2", "xtend",
    ]));
    for (const pkg of manifest.bundledPackages) expect(notices).toContain(`${pkg.name}@${pkg.version}`);
    expect(notices).toContain("Copyright (c) 2014 Brian M. Carlson");
    expect(notices).toContain("Copyright (c) 2013-2016 Hannes Hörl");
    expect(createHash("sha256").update(notices).digest("hex")).toBe(manifest.noticesSha256);
  });

  it("rebuilds reproducibly and preserves the normal Docker server entrypoint", async () => {
    expect(await buildPreflightArtifact(artifact)).toEqual(manifest);
    const dockerfile = await readFile("Dockerfile", "utf8");
    expect(dockerfile).toContain("RUN npm run build:preflight");
    expect(dockerfile).toContain("/app/.preflight ./preflight");
    expect(dockerfile).toContain('CMD ["node", "server.js"]');
    expect(await readFile("docker-entrypoint.sh", "utf8")).not.toContain("preflight");
  });

  it("rejects native selection before importing any ambient native driver", async () => {
    const native = path.join(temporary, "node_modules/pg-native");
    await mkdir(native, { recursive: true });
    await writeFile(path.join(native, "index.js"), 'throw new Error("AMBIENT_NATIVE_LOADED");');
    try {
      await expect(execute(process.execPath, [path.join(artifact, "runner/run.mjs"), "--help"], {
        cwd: temporary, env: { ...process.env, NODE_PG_FORCE_NATIVE: "1" },
      })).rejects.toMatchObject({ code: 1, stdout: "", stderr: expect.stringContaining('"error":"PACKAGED_NATIVE_UNSUPPORTED"') });
    } finally { await rm(path.join(temporary, "node_modules"), { recursive: true, force: true }); }
  });

  it.each(["missing-file", "changed-file", "extra-file", "missing-manifest", "invalid-manifest", "missing-notices"])(
    "refuses %s before opening a database socket", async (damage) => {
      const migrations = path.join(artifact, "migrations");
      const last = manifest.migrations.at(-1)!;
      const selected = path.join(migrations, last.filename);
      const original = await readFile(selected, "utf8");
      const manifestText = await readFile(path.join(artifact, "manifest.json"), "utf8");
      let connections = 0;
      const server = createServer((socket) => { connections++; socket.destroy(); });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as { port: number }).port;
      try {
        if (damage === "missing-file") await rename(selected, path.join(artifact, "held.sql"));
        if (damage === "changed-file") await writeFile(selected, original + "\n-- changed artifact fixture\n");
        if (damage === "extra-file") await writeFile(path.join(migrations, "9999_extra.sql"), "SELECT 1;");
        if (damage === "missing-manifest") await rm(path.join(artifact, "manifest.json"));
        if (damage === "invalid-manifest") await writeFile(path.join(artifact, "manifest.json"), "{}");
        if (damage === "missing-notices") await rename(path.join(artifact, "THIRD_PARTY_NOTICES.txt"), path.join(artifact, "held-notices"));
        let failure: { stdout?: string; stderr?: string; code?: number } | undefined;
        try {
          await execute(process.execPath, [path.join(artifact, "runner/run.mjs")], {
            cwd: temporary, env: { ...process.env, NODE_ENV: "test", DATABASE_ENVIRONMENT: "test",
              DATABASE_URL: `postgresql://synthetic@127.0.0.1:${port}/aqlan_p1_test?sslmode=disable` },
          });
        } catch (error) { failure = error as typeof failure; }
        expect(failure).toMatchObject({ code: 1, stdout: "" });
        expect(failure?.stderr).toContain('"error":"PREFLIGHT_ARTIFACT_INVALID"');
        expect(failure?.stderr).not.toContain("node:internal");
        expect(connections).toBe(0);
      } finally {
        if (damage === "missing-file") await rename(path.join(artifact, "held.sql"), selected);
        if (damage === "changed-file") await writeFile(selected, original);
        if (damage === "extra-file") await rm(path.join(migrations, "9999_extra.sql"));
        if (damage.includes("manifest")) await writeFile(path.join(artifact, "manifest.json"), manifestText);
        if (damage === "missing-notices") await rename(path.join(artifact, "held-notices"), path.join(artifact, "THIRD_PARTY_NOTICES.txt"));
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});
