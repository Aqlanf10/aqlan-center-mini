import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { createRequire, isBuiltin } from "node:module";
import { BRACES_EXCEPTION as PIN } from "../../lib/braces-exception-pins.mjs";
import { canonical, equal, invariant, isRecord, packagePath } from "../../lib/scoped-braces-exception.mjs";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const jsonFile = async (file) => JSON.parse(await readFile(file, "utf8"));
export const slash = (value) => value.split(path.sep).join("/");

/** Walk all real files, including otherwise-unexpected executable additions. */
export async function fileInventory(directory, { skipNodeModules = false, binLinks = null, bracesDirectories = null } = {}) {
  invariant((await lstat(directory)).isDirectory() && !(await lstat(directory)).isSymbolicLink(), `not a real directory: ${directory}`);
  const output = {};
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const relative = slash(path.relative(directory, full));
      if (entry.isSymbolicLink()) {
        invariant(binLinks !== null && /(?:^|\/node_modules\/)\.bin\/[^/]+$/.test(relative), `symlink not supported: ${relative}`);
        const target = await realpath(full);
        const base = await realpath(directory);
        invariant(target.startsWith(`${base}${path.sep}`) && (await lstat(target)).isFile(), `bin link escapes installation/non-file: ${relative}`);
        binLinks.push({ link: `node_modules/${relative}`, target: `node_modules/${slash(path.relative(base, target))}` });
        continue;
      }
      if (entry.isDirectory()) {
        if (bracesDirectories !== null && entry.name === PIN.package && path.basename(current) === "node_modules") bracesDirectories.push(`node_modules/${relative}`);
        if (!(skipNodeModules && current === directory && entry.name === "node_modules")) pending.push(full);
      } else {
        invariant(entry.isFile(), `non-regular entry: ${relative}`);
        invariant(!(bracesDirectories !== null && path.basename(current) === "node_modules" && /^(?:braces|braces\.(?:js|json|node))$/.test(entry.name)), `unmanifested braces file shadow: ${relative}`);
        output[relative] = sha256(await readFile(full));
      }
    }
  }
  return Object.fromEntries(Object.entries(output).sort(([a], [b]) => a.localeCompare(b)));
}

function lockName(packageLocation) {
  return packageLocation.slice(packageLocation.lastIndexOf("node_modules/") + "node_modules/".length);
}
const mapFields = ["dependencies", "optionalDependencies", "peerDependencies"];
function dependencyMap(pkg, field) {
  const value = pkg[field] ?? {};
  invariant(isRecord(value) && Object.entries(value).every(([name, range]) => name && typeof range === "string" && range), `invalid ${field}`);
  return value;
}
export function validateRootManifest(manifest, lock) {
  invariant(isRecord(manifest) && isRecord(lock) && lock.lockfileVersion === 3 && isRecord(lock.packages) && isRecord(lock.packages[""]), "invalid package/lock manifests");
  const root = lock.packages[""];
  invariant(manifest.name === root.name && manifest.version === root.version, "root package/lock identity mismatch");
  for (const field of [...mapFields, "devDependencies"]) invariant(equal(dependencyMap(manifest, field), dependencyMap(root, field)), `root package/lock ${field} mismatch`);
  invariant(!Object.hasOwn(manifest, "overrides") && !Object.hasOwn(manifest, "workspaces"), "unreviewed overrides/workspaces");
  invariant(manifest.devDependencies?.braces === "file:vendor/braces-3.0.3-local.tgz", "local braces package disposition removed or changed");
  invariant(!Object.hasOwn(manifest.dependencies ?? {}, "braces") && !Object.hasOwn(manifest.optionalDependencies ?? {}, "braces"), "braces declared in production root");
}

/** Actual Node resolution, not lockfile dev:true flags, establishes graph edges. */
export async function inspectInstalledBraces(root) {
  const absoluteRoot = await realpath(root);
  const manifest = await jsonFile(path.join(root, "package.json"));
  const lock = await jsonFile(path.join(root, "package-lock.json"));
  validateRootManifest(manifest, lock);
  invariant(sha256(await readFile(path.join(root, "vendor/braces-provenance.json"))) === PIN.provenanceSha256, "provenance manifest changed");
  invariant(sha256(await readFile(path.join(root, "vendor/braces-security.patch"))) === PIN.patchSha256, "patch content changed");
  const archive = await readFile(path.join(root, "vendor/upstream/braces-3.0.3.tgz"));
  invariant(sha256(archive) === PIN.officialArchiveSha256 && `sha512-${createHash("sha512").update(archive).digest("base64")}` === PIN.officialIntegrity, "independent official fixture changed");
  const candidate = await readFile(path.join(root, "vendor/braces-3.0.3-local.tgz"));
  invariant(`sha512-${createHash("sha512").update(candidate).digest("base64")}` === PIN.candidateIntegrity, "local package archive changed");
  invariant(equal(await fileInventory(path.join(root, "vendor/braces")), PIN.files), "vendor source file set/hash changed");
  const packages = {};
  // Scan every installed file tree, not just paths reported by npm audit. This
  // also catches a hidden/unlocked copy in a package's vendor/example directory.
  const binLinks = [];
  const bracesDirectories = [];
  const tree = await fileInventory(path.join(root, "node_modules"), { binLinks, bracesDirectories });
  for (const relative of Object.keys(tree).filter((name) => name.endsWith("/package.json") || name === "package.json")) {
    const packageLocation = slash(path.dirname(`node_modules/${relative}`));
    const pkg = await jsonFile(path.join(root, packageLocation, "package.json"));
    invariant(isRecord(pkg), `invalid installed manifest ${packageLocation}`);
    if (!packagePath(packageLocation)) {
      invariant(pkg.name !== PIN.package, `additional braces copy outside package graph: ${packageLocation}`);
      continue;
    }
    const entry = lock.packages[packageLocation];
    invariant(isRecord(entry) && !entry.link && pkg.name === (entry.name ?? lockName(packageLocation)) && pkg.version === entry.version, `installed package/lock identity mismatch: ${packageLocation}`);
    // npm lock metadata can omit optional dependencies from dependencies; compare
    // the effective required map rather than manufacturing missing lock entries.
    for (const field of mapFields) {
      const actual = { ...dependencyMap(pkg, field) };
      if (field === "dependencies") for (const name of Object.keys(dependencyMap(pkg, "optionalDependencies"))) delete actual[name];
      invariant(equal(actual, dependencyMap(entry, field)), `installed package/lock ${field} mismatch: ${packageLocation}`);
    }
    invariant(equal(pkg.peerDependenciesMeta ?? {}, entry.peerDependenciesMeta ?? {}), `peer metadata differs: ${packageLocation}`);
    packages[packageLocation] = { name: pkg.name, version: pkg.version, manifest: pkg };
  }
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (!location) continue;
    invariant(packagePath(location) && isRecord(entry) && !entry.link, `unsupported lock entry ${location}`);
    invariant(packages[location] || entry.optional === true, `required installed package missing: ${location}`);
  }
  const bracesPaths = Object.keys(packages).filter((location) => packages[location].name === PIN.package).sort();
  invariant(bracesPaths.length > 0, "no installed patched braces copy");
  invariant(equal([...bracesDirectories].sort(), bracesPaths), "additional/unmanifested/shadow braces directory");
  const allowedBins = new Set();
  for (const [location, pkg] of Object.entries(packages)) {
    const bins = typeof pkg.manifest.bin === "string" ? { [pkg.name.split("/").pop()]: pkg.manifest.bin } : (pkg.manifest.bin ?? {});
    invariant(isRecord(bins), `invalid binary manifest ${location}`);
    for (const [name, target] of Object.entries(bins)) {
      invariant(typeof target === "string" && typeof name === "string", `invalid binary entry ${location}`);
      const resolved = slash(path.relative(absoluteRoot, path.resolve(absoluteRoot, location, target)));
      invariant(resolved.startsWith(`${location}/`) && Object.hasOwn(tree, resolved.slice("node_modules/".length)), `missing/escaping binary target ${location}`);
      allowedBins.add(`${name}=${resolved}`);
    }
  }
  for (const link of binLinks) invariant(allowedBins.has(`${path.basename(link.link)}=${link.target}`), `undeclared binary link ${link.link}`);
  for (const location of bracesPaths) {
    const entry = lock.packages[location];
    invariant(packages[location].version === PIN.version && entry.version === PIN.version
      && entry.resolved === "file:vendor/braces-3.0.3-local.tgz" && entry.integrity === PIN.candidateIntegrity
      && entry.dev === true, `unapproved installed braces identity: ${location}`);
    invariant(equal(await fileInventory(path.join(root, location), { skipNodeModules: true }), PIN.files), `installed braces file set/hash differs: ${location}`);
  }
  const edges = {};
  for (const [location, pkg] of [["", { manifest }], ...Object.entries(packages)]) {
    const fields = location ? mapFields : [...mapFields, "devDependencies"];
    const all = Object.assign({}, ...fields.map((field) => dependencyMap(pkg.manifest, field)));
    const require = createRequire(path.join(root, location, "package.json"));
    edges[location] = [];
    for (const name of Object.keys(all).sort()) {
      let resolvedPath;
      // A declared npm dependency may share a core-module name (uri-js declares
      // punycode). Bare core names return null lookup paths, despite the npm
      // package being required by the lock. A directory specifier obtains Node's
      // package lookup paths without confusing core resolution with package
      // absence. The package must still exist, match the lock and be traversed.
      const coreCollision = isBuiltin(name);
      const lookup = coreCollision ? `${name}/` : name;
      for (const searchPath of require.resolve.paths(lookup) ?? []) {
        const candidatePath = path.join(searchPath, name);
        let stat;
        try { stat = await lstat(candidatePath); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
        invariant(stat.isDirectory() && !stat.isSymbolicLink(), `non-directory/symlink dependency ${location} -> ${name}`);
        const real = await realpath(candidatePath);
        invariant(real.startsWith(`${absoluteRoot}${path.sep}`), `dependency escapes installation ${name}`);
        resolvedPath = slash(path.relative(absoluteRoot, real));
        break;
      }
      if (!resolvedPath) {
        invariant(Object.hasOwn(dependencyMap(pkg.manifest, "optionalDependencies"), name)
          || pkg.manifest.peerDependenciesMeta?.[name]?.optional === true, `required dependency unresolved ${location} -> ${name}`);
        continue;
      }
      invariant(packages[resolvedPath]?.name === name, `resolution is absent/misidentified in lock ${location} -> ${name}`);
      if (name === PIN.package) {
        const actualEntry = require.resolve(name);
        invariant(slash(path.relative(absoluteRoot, actualEntry)) === `${resolvedPath}/index.js`, `braces entry point differs ${location}`);
        invariant(bracesPaths.includes(resolvedPath), "consumer resolves unverified braces");
      }
      edges[location].push({ name, path: resolvedPath, ...(coreCollision ? { bareCoreSpecifier: require.resolve(name) } : {}) });
    }
  }
  const runtimeRoots = new Set([...Object.keys(dependencyMap(manifest, "dependencies")), ...Object.keys(dependencyMap(manifest, "optionalDependencies")), ...Object.keys(dependencyMap(manifest, "peerDependencies"))]);
  const pending = edges[""].filter((edge) => runtimeRoots.has(edge.name)).map((edge) => edge.path);
  const runtimePaths = new Set();
  while (pending.length) {
    const location = pending.pop();
    if (runtimePaths.has(location)) continue;
    runtimePaths.add(location);
    invariant(packages[location].name !== PIN.package, `production dependency chain includes braces: ${location}`);
    pending.push(...edges[location].map((edge) => edge.path));
  }
  const consumers = Object.entries(edges).flatMap(([consumer, dependencies]) => dependencies.filter((edge) => edge.name === PIN.package).map((edge) => ({ consumer, path: edge.path })));
  invariant(consumers.some(({ consumer }) => consumer !== ""), "no installed consumer of patched braces");
  return { packages, edges, bracesPaths, consumers, lockPackageCount: Object.keys(lock.packages).length - 1, runtimePaths: [...runtimePaths].sort(), installedTreeSha256: sha256(canonical(tree)), lockSha256: sha256(await readFile(path.join(root, "package-lock.json"))), packageSha256: sha256(await readFile(path.join(root, "package.json"))) };
}
