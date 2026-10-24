// Prints the runtime's published migration versions and checksums. Usage: tsx checksums.mjs <runtime root>
const root = process.argv[2];
const mod = await import(`${root}/lib/migration-files.ts`);
const load = mod.loadMigrationFiles ?? mod.default?.loadMigrationFiles;
const files = await load(`${root}/migrations`);
console.log(JSON.stringify({ checksums: Object.fromEntries(files.map((f) => [f.version, f.checksum])) }));
process.exit(0);
