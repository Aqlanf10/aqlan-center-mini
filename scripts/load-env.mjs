import { existsSync, readFileSync } from "node:fs";

/**
 * يقرأ `.env.local` للتشغيل اليدوي من الطرفية — ولا يطغى على متغيّرٍ مضبوطٍ أصلًا،
 * كي يبقى بإمكانك توجيه السكربت إلى قاعدةٍ أخرى بسطرٍ واحد:
 *
 *   DATABASE_URL=postgresql://… npm run verify:clinical
 */
const file = new URL("../.env.local", import.meta.url);
if (existsSync(file)) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const [, key, raw] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = raw.replace(/^(['"])(.*)\1$/s, "$2");
  }
}
