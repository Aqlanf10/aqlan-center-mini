import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * (P3-7) الوثائق لا تتأخر عن الكود بصمت.
 *
 * كانت docs/DATABASE_MIGRATIONS.md تقف عند 0011 والمجلد وصل 0020، وكان README
 * يصف النظام بأنه «شاشة واحدة بلا إعدادات». هذا الحارس يُسقط CI إن أُضيفت هجرة
 * دون ذكرها في وثيقة الهجرات، أو أشارت خريطة وثائق README إلى ملفٍّ غير موجود.
 */
const root = path.resolve(__dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

describe("حارس انحراف الوثائق", () => {
  it("كل ملف في migrations/ مذكور باسمه في docs/DATABASE_MIGRATIONS.md", () => {
    const doc = read("docs/DATABASE_MIGRATIONS.md");
    const files = readdirSync(path.join(root, "migrations")).filter((name) => /^\d{4}_.+\.sql$/.test(name));
    expect(files.length).toBeGreaterThan(0);
    const missing = files.filter((name) => !doc.includes(name));
    expect(missing).toEqual([]);
  });

  it("كل وثيقة تشير إليها خريطة README موجودة فعلًا", () => {
    const readme = read("README.md");
    const referenced = [...readme.matchAll(/`(docs\/[A-Za-z0-9_\-./]+\.md)`/g)].map((match) => match[1]);
    expect(referenced.length).toBeGreaterThan(0);
    const missing = referenced.filter((file) => !existsSync(path.join(root, file)));
    expect(missing).toEqual([]);
  });
});
