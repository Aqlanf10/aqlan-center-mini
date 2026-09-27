import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * (LIVE-1) كل رابطٍ داخلي في الواجهة يقود إلى صفحةٍ موجودة.
 *
 * زرّا «لوحة اليوم» و«فتح سجل الزيارة» في ملف المريض كانا يشيران إلى `/today` — ولا صفحة
 * بهذا المسار، فيصل الطبيب إلى 404 وسط الزيارة. هذا الحارس يقرأ كل `href` و`router.push`
 * و`location.href` بمسارٍ ثابت (أو قالبٍ بمتغيّرات) ويطابقه بمسارات `app/**\/page.tsx`
 * — فلا يعود رابطٌ معلّق بصمت.
 */

const ROOT = process.cwd();
const SOURCE_DIRS = ["app", "components"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

/** مسارات الصفحات: `[x]` مقطعٌ متغيّر، `[...x]`/`[[...x]]` بقيةٌ، و`(group)` لا يظهر في العنوان. */
function pageRoutes(): string[][] {
  return walk(join(ROOT, "app"))
    .filter((file) => /[/\\]page\.(tsx|ts|jsx|js)$/.test(file))
    .map((file) => relative(join(ROOT, "app"), file).split(sep).slice(0, -1))
    .map((segments) => segments.filter((segment) => !/^\(.*\)$/.test(segment)));
}

function matches(route: string[], path: string[]): boolean {
  for (let index = 0; index < route.length; index += 1) {
    const segment = route[index];
    if (/^\[\[?\.\.\./.test(segment)) return segment.startsWith("[[") || path.length > index;
    if (index >= path.length) return false;
    if (/^\[.+\]$/.test(segment)) continue;
    if (segment !== path[index]) return false;
  }
  return route.length === path.length;
}

const LINK_PATTERNS = [
  /href=\s*"(\/[^"]*)"/g,
  /href=\s*\{\s*"(\/[^"]*)"\s*\}/g,
  /href=\s*\{\s*`(\/[^`]*)`\s*\}/g,
  /router\.(?:push|replace)\(\s*["'`](\/[^"'`]*)["'`]/g,
  /location\.(?:href|assign)\s*(?:=|\()\s*["'`](\/[^"'`]*)["'`]/g,
];

interface Link { file: string; target: string }

function internalLinks(): Link[] {
  const links: Link[] = [];
  for (const dir of SOURCE_DIRS) {
    for (const file of walk(join(ROOT, dir)).filter((name) => /\.(tsx|ts)$/.test(name))) {
      const text = readFileSync(file, "utf8");
      for (const pattern of LINK_PATTERNS) {
        for (const match of text.matchAll(pattern)) links.push({ file: relative(ROOT, file), target: match[1] });
      }
    }
  }
  return links;
}

/** «/patients/${id}?tab=x#y» → ["patients", "*"]؛ الأصول الثابتة وواجهات /api خارج الفحص. */
function pagePath(target: string): string[] | null {
  const path = target.replace(/\$\{[^}]*\}/g, "*").split(/[?#]/)[0];
  if (path.startsWith("/api/") || path.startsWith("//") || /\.[a-z0-9]{2,5}$/i.test(path)) return null;
  // قالبٌ يبني المسار كله من متغيّر (`${base}/x`) لا يُحكم عليه هنا.
  if (path.startsWith("/*")) return null;
  return path.split("/").filter(Boolean);
}

describe("(LIVE-1) internal UI links", () => {
  const routes = pageRoutes();

  it("the patient file's «today» buttons go to the day board and the visit record, not /today", () => {
    const text = readFileSync(join(ROOT, "components/patient/TodayVisitTab.tsx"), "utf8");
    expect(text).not.toMatch(/["'`]\/today\b/);
    expect(text).toContain("href=\"/\"");
    expect(text).toContain("href={`/visits/${visit.id}`}");
  });

  it("every internal page link resolves to an existing app route", () => {
    const dangling = internalLinks()
      .map((link) => ({ ...link, path: pagePath(link.target) }))
      .filter((link) => link.path !== null)
      .filter((link) => !routes.some((route) => matches(route, link.path!.map((segment) => (segment === "*" ? "x" : segment)))))
      .map((link) => `${link.file} → ${link.target}`);
    expect(dangling).toEqual([]);
  });

  it("the matcher itself recognises dynamic and literal routes", () => {
    expect(matches(["visits", "[id]"], ["visits", "12"])).toBe(true);
    expect(matches(["visits", "[id]"], ["visits"])).toBe(false);
    expect(matches([], [])).toBe(true);
    expect(routes.some((route) => matches(route, ["today"]))).toBe(false);
  });
});
