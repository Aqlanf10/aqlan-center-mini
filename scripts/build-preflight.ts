import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isBuiltin } from "node:module";
import { loadMigrationFiles } from "../lib/migration-files";
import type { PreflightArtifactManifest } from "../lib/preflight-artifact";
import { preflightThirdPartyNotices } from "./preflight-licenses";
import { preflightSourceDigests, PREFLIGHT_SOURCE_FILES } from "../lib/preflight-provenance";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

/** Build-only: does not import the application DB, run SQL, or read .env files. */
export async function buildPreflightArtifact(outputRoot = path.join(projectRoot, ".preflight")) {
  const target = path.resolve(outputRoot);
  // The only replaceable directory is this tool's generated artifact. Tests use
  // a fresh temporary parent; the command itself accepts no destination flags.
  if (![".preflight", "preflight"].includes(path.basename(target))) throw new Error("Invalid preflight artifact destination.");
  await mkdir(path.dirname(target), { recursive: true });
  const stage = await mkdtemp(path.join(path.dirname(target), ".preflight-build-"));
  try {
    const files = await loadMigrationFiles();
    const sourceFiles = await preflightSourceDigests();
    await mkdir(path.join(stage, "runner"));
    await mkdir(path.join(stage, "migrations"));
    const result = await build({
      absWorkingDir: projectRoot,
      entryPoints: [path.join(projectRoot, "scripts/db-preflight-entry.ts")],
      outfile: path.join(stage, "runner/run.mjs"),
      bundle: true, platform: "node", format: "esm", target: "node22",
      define: { __PREFLIGHT_SOURCE_DIGESTS__: JSON.stringify(sourceFiles) },
      // Remove the optional native route entirely: no ambient native-driver lookup.
      plugins: [{ name: "preflight-js-driver-only", setup(plugin) {
        plugin.onResolve({ filter: /^\.\/native$/ }, (args) => args.importer.replace(/\\/g, "/").endsWith("/pg/lib/index.js")
          ? { path: "native-disabled", namespace: "preflight-internal" } : undefined);
        plugin.onLoad({ filter: /.*/, namespace: "preflight-internal" }, () => ({
          contents: 'throw Object.assign(new Error("Native driver disabled."), { code: "PACKAGED_NATIVE_UNSUPPORTED" });', loader: "js",
        }));
      } }],
      banner: { js: "import { createRequire as preflightCreateRequire } from 'node:module'; const require = preflightCreateRequire(import.meta.url);" },
      metafile: true, sourcemap: false, logLevel: "silent",
    });
    const allowedSources = new Set<string>(PREFLIGHT_SOURCE_FILES);
    if (Object.keys(result.metafile!.inputs).some((name) => {
      const relative = path.relative(projectRoot, path.resolve(projectRoot, name)).replace(/\\/g, "/");
      return name !== "preflight-internal:native-disabled" && name !== "<define:__PREFLIGHT_SOURCE_DIGESTS__>"
        && !relative.startsWith("node_modules/") && !allowedSources.has(relative);
    })) {
      throw new Error("Preflight artifact imported an unreviewed application module.");
    }
    const imports = Object.values(result.metafile!.outputs).flatMap((output) => output.imports);
    if (imports.some((entry) => entry.external && !isBuiltin(entry.path))) {
      throw new Error("Preflight artifact has an unpackaged runtime dependency.");
    }
    for (const file of files) await writeFile(path.join(stage, "migrations", file.filename), file.sql, "utf8");
    const bundle = await readFile(path.join(stage, "runner/run.mjs"));
    const notices = await preflightThirdPartyNotices(projectRoot, Object.keys(result.metafile!.inputs));
    await writeFile(path.join(stage, "THIRD_PARTY_NOTICES.txt"), notices.text);
    const manifest: PreflightArtifactManifest = {
      format: "aqlan-read-only-preflight-artifact", formatVersion: 2, nodeMajor: 22,
      bundleSha256: createHash("sha256").update(bundle).digest("hex"),
      noticesSha256: createHash("sha256").update(notices.text).digest("hex"),
      sourceFiles,
      bundledPackages: notices.packages,
      migrations: files.map(({ version, name, filename, checksum }) => ({ version, name, filename, checksum })),
    };
    await writeFile(path.join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    await rm(target, { recursive: true, force: true });
    await rename(stage, target);
    return manifest;
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("/build-preflight.ts")) {
  if (process.argv.length > 2) throw new Error("build:preflight accepts no arguments.");
  buildPreflightArtifact().then((manifest) => {
    console.log(`Preflight artifact built: ${manifest.migrations.length} immutable migration assets; Node ${manifest.nodeMajor}.`);
  }).catch(() => {
    console.error("PREFLIGHT_ARTIFACT_BUILD_FAILED");
    process.exitCode = 1;
  });
}
