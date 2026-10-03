import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { compileFunction } from "node:vm";
import { gunzipSync } from "node:zlib";

export const OFFICIAL_BRACES_INTEGRITY = "sha512-yQbXgO/OSZVD2IsiLlro+7Hf6Q18EJrKSEsdoMzKePKXct3gvD8oLcOQdIzGupr5Fj+EDe8gO/lxc1BzfMpxvA==";
export const OFFICIAL_BRACES_ARCHIVE = fileURLToPath(new URL("../../vendor/upstream/braces-3.0.3.tgz", import.meta.url));
const provenance = JSON.parse(readFileSync(new URL("../../vendor/braces-provenance.json", import.meta.url), "utf8"));
const originalHashes = provenance.upstream.source_sha256;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

function files(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const name = prefix + entry.name;
    if (entry.isDirectory()) return files(join(directory, entry.name), name + "/");
    if (!entry.isFile()) throw new Error(`Non-regular fixture entry: ${name}`);
    return [name];
  });
}

export function verifyFixtureDirectory(directory) {
  const actual = files(directory).sort();
  const expected = Object.keys(originalHashes).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Official fixture file inventory mismatch");
  for (const name of expected) {
    if (hash(readFileSync(join(directory, name))) !== originalHashes[name]) {
      throw new Error(`Official fixture source hash mismatch: ${name}`);
    }
  }
  return { ...originalHashes };
}

export function extractOfficialBracesFixture(archivePath = OFFICIAL_BRACES_ARCHIVE) {
  const archive = readFileSync(archivePath);
  const integrity = "sha512-" + createHash("sha512").update(archive).digest("base64");
  if (integrity !== OFFICIAL_BRACES_INTEGRITY) throw new Error("Official braces archive integrity mismatch");
  // This minimal tar reader handles only the ten regular files in the exact
  // pinned npm artifact. No links, directories, PAX extensions or other tar
  // entries are accepted, even though integrity is verified before extraction.
  const tar = gunzipSync(archive, { maxOutputLength: 128 * 1024 });
  const directory = mkdtempSync(join(tmpdir(), "aqlan-braces-official-"));
  const seen = new Set();
  try {
    let offset = 0;
    for (; offset + 512 <= tar.length; ) {
      const header = tar.subarray(offset, offset + 512);
      if (header.every(byte => byte === 0)) break;
      const text = (start, end) => header.subarray(start, end).toString("utf8").replace(/\0.*$/s, "");
      const name = text(0, 100);
      const size = Number.parseInt(text(124, 136).trim(), 8);
      const declaredChecksum = Number.parseInt(text(148, 156).trim(), 8);
      let checksum = 0;
      for (let index = 0; index < 512; index++) checksum += index >= 148 && index < 156 ? 32 : header[index];
      const relative = name.startsWith("package/") ? name.slice(8) : "";
      if (checksum !== declaredChecksum || header[156] !== 48 || text(345, 500) !== "" ||
          !Object.hasOwn(originalHashes, relative) || seen.has(relative) ||
          relative.split("/").some(part => part === "." || part === ".." || !part) ||
          !Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) {
        throw new Error("Unexpected official braces tar entry");
      }
      const bytes = tar.subarray(offset + 512, offset + 512 + size);
      if (hash(bytes) !== originalHashes[relative]) throw new Error(`Official tar source hash mismatch: ${relative}`);
      const destination = join(directory, relative);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, bytes, { flag: "wx", mode: 0o600 });
      seen.add(relative);
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    if (!tar.subarray(offset).every(byte => byte === 0)) throw new Error("Unexpected data after official tar entries");
    const hashes = verifyFixtureDirectory(directory);
    return { directory, hashes, integrity, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function loadOfficialBracesFixture({ dependencyRequire = createRequire(import.meta.url) } = {}) {
  const fixture = extractOfficialBracesFixture();
  const manifest = JSON.parse(readFileSync(join(fixture.directory, "package.json"), "utf8"));
  const cache = new Map();
  // The comparison implementation is ONLY the verified fixture, regardless
  // of whether application node_modules/braces is original or patched. The
  // official package's sole external dependency, fill-range, is resolved from
  // the caller's locked dependency tree and cannot substitute a braces module.
  const load = name => {
    if (!Object.hasOwn(originalHashes, name) || !name.endsWith(".js")) throw new Error(`Unverified fixture module: ${name}`);
    if (cache.has(name)) return cache.get(name).exports;
    const filename = join(fixture.directory, name);
    const bytes = readFileSync(filename);
    if (hash(bytes) !== originalHashes[name]) throw new Error(`Official fixture changed before load: ${name}`);
    const module = { exports: {} };
    cache.set(name, module);
    const localRequire = specifier => {
      if (specifier.startsWith(".")) {
        const target = posix.normalize(posix.join(posix.dirname(name), specifier));
        return load(target.endsWith(".js") ? target : target + ".js");
      }
      if (!Object.hasOwn(manifest.dependencies, specifier)) throw new Error(`Unexpected official fixture dependency: ${specifier}`);
      return dependencyRequire(specifier);
    };
    compileFunction(bytes.toString("utf8"), ["require", "module", "exports", "__filename", "__dirname"], { filename })(
      localRequire, module, module.exports, filename, dirname(filename),
    );
    return module.exports;
  };
  try {
    return { ...fixture, module: load("index.js") };
  } catch (error) {
    fixture.cleanup();
    throw error;
  }
}
