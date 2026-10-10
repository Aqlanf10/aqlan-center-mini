import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HTTP_METHODS,
  HTTP_PERMISSIONS,
  apiRouteVerdict,
  isAccessClass,
  matchApiRoute,
  rolesAlwaysDenied,
  type HttpMethod,
} from "@/lib/http-permissions";
import { restrictedRouteAllowed } from "@/lib/role-routes";
import { ROLES } from "@/lib/roles";
import { canReadReceptionHandoff } from "@/lib/reception-handoff";

/**
 * (TD-04 / TD-REG-006) حارس مصفوفة صلاحيات HTTP — الجزء الثابت.
 *
 * الجزء الحي (كل دور غائب يُرفض فعلًا على التطبيق المبني) في
 * `__tests__/security-http/http-permission-matrix.test.ts`.
 */

const ROOT = process.cwd();
const API_DIR = join(ROOT, "app", "api");

function routeFiles(dir = API_DIR): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...routeFiles(full));
    else if (entry.name === "route.ts") files.push(full);
  }
  return files;
}

function patternOf(file: string): string {
  return `/${relative(join(ROOT, "app"), file).replace(/\\/g, "/").replace(/\/route\.ts$/, "")}`;
}

function exportedMethods(source: string): HttpMethod[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD)\b/g)) found.add(match[1]);
  for (const match of source.matchAll(/export\s+const\s+(GET|POST|PUT|PATCH|DELETE)\s*=/g)) found.add(match[1]);
  for (const group of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const match of group[1].matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\b/g)) found.add(match[1]);
  }
  return HTTP_METHODS.filter((name) => found.has(name));
}

const ROUTES = routeFiles().map((file) => {
  const source = readFileSync(file, "utf8");
  return { file, pattern: patternOf(file), methods: exportedMethods(source), source };
});

const proxySource = readFileSync(join(ROOT, "proxy.ts"), "utf8");

function proxyPublicApi(): string[] {
  const start = proxySource.indexOf("const PUBLIC_API = new Set([");
  const end = proxySource.indexOf("]);", start);
  expect(start).toBeGreaterThan(-1);
  return [...proxySource.slice(start, end).matchAll(/^\s*"([^"]+)",/gm)].map((match) => match[1]).sort();
}

function proxyPublicPrefixes(): string[] {
  const line = proxySource.match(/const PUBLIC_API_PREFIXES = \[([^\]]*)\]/);
  expect(line).not.toBeNull();
  return [...line![1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

/** عنوانٌ فعلي من النمط — المقاطع المتغيّرة أرقام كما في الطلبات الحقيقية. */
function samplePath(pattern: string): string {
  return pattern.replace(/\[[^\]]+\]/g, "1");
}

const ALL_FINANCE_ACCESS = {
  operateShift: true, collectPayments: true, createExpenses: true, viewPatientLedger: true,
  viewReports: true, viewSuppliers: true, viewCommissions: true, viewReconciliation: true,
};

describe("TD-04: المصفوفة تغطي كل مسار API وكل فعل — لا ناقص ولا زائد", () => {
  it("كل route.ts له مدخل، وكل مدخل له route.ts", () => {
    const onDisk = ROUTES.map((route) => route.pattern).sort();
    const registered = Object.keys(HTTP_PERMISSIONS).sort();
    expect(onDisk.filter((pattern) => !registered.includes(pattern))).toEqual([]);
    expect(registered.filter((pattern) => !onDisk.includes(pattern))).toEqual([]);
    expect(onDisk.length).toBeGreaterThan(150);
  });

  it("أفعال كل مدخل هي بالضبط ما يصدّره المسار", () => {
    const mismatches = ROUTES.flatMap((route) => {
      const registered = HTTP_METHODS.filter((method) => HTTP_PERMISSIONS[route.pattern]?.[method] !== undefined);
      return JSON.stringify(registered) === JSON.stringify(route.methods)
        ? [] : [`${route.pattern}: exports ${route.methods.join(",")} / matrix ${registered.join(",")}`];
    });
    expect(mismatches).toEqual([]);
  });

  it("المقاطع المتغيّرة مفردة — المطابِق لا يدعم catch-all بعد", () => {
    const unsupported = ROUTES.map((route) => route.pattern).filter((pattern) => /\[\.\.\.|\[\[/.test(pattern));
    expect(unsupported).toEqual([]);
  });

  it("قوائم الأدوار صالحة وغير فارغة، والمدير فيها دائمًا", () => {
    const problems: string[] = [];
    for (const [pattern, entry] of Object.entries(HTTP_PERMISSIONS)) {
      for (const [method, access] of Object.entries(entry)) {
        if (access === undefined || isAccessClass(access)) continue;
        if (access.length === 0) problems.push(`${method} ${pattern}: empty`);
        if (!access.includes("admin")) problems.push(`${method} ${pattern}: no admin`);
        for (const role of access) if (!ROLES.includes(role)) problems.push(`${method} ${pattern}: ${role}`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe("TD-04: المصفوفة والباب متفقان", () => {
  it("قائمة PUBLIC_API في الباب = مسارات المصفوفة العامة ومسارات البوابة", () => {
    const fromMatrix = Object.entries(HTTP_PERMISSIONS)
      .filter(([, entry]) => Object.values(entry).every((access) => access === "public" || access === "portal"))
      .map(([pattern]) => pattern)
      .sort();
    expect(proxyPublicApi()).toEqual(fromMatrix);
  });

  it("بادئات المرور العامة تحوي وسائط الرسائل والخطافات وحدها", () => {
    const prefixes = proxyPublicPrefixes();
    for (const [pattern, entry] of Object.entries(HTTP_PERMISSIONS)) {
      const underPrefix = prefixes.some((prefix) => samplePath(pattern).startsWith(prefix));
      for (const access of Object.values(entry)) {
        const prefixClass = access === "shared-media" || access === "webhook";
        expect({ pattern, underPrefix }).toEqual({ pattern, underPrefix: prefixClass });
      }
    }
  });

  it("INTERNAL = /api/internal/ وحدها (توكن Bearer سرّي)", () => {
    for (const [pattern, entry] of Object.entries(HTTP_PERMISSIONS)) {
      for (const access of Object.values(entry)) {
        expect({ pattern, internal: access === "internal" }).toEqual({ pattern, internal: pattern.startsWith("/api/internal/") });
      }
    }
  });

  it("الأدوار المحروسة عند الباب (الكاشير/المحاسب/المساعد) لا تُسجَّل على مسارٍ يرفضه بابها", () => {
    const conflicts: string[] = [];
    for (const [pattern, entry] of Object.entries(HTTP_PERMISSIONS)) {
      for (const [method, access] of Object.entries(entry)) {
        if (access === undefined || isAccessClass(access)) continue;
        for (const role of ["cashier", "accountant", "assistant"] as const) {
          if (access.includes(role) && !restrictedRouteAllowed(role, samplePath(pattern), method, ALL_FINANCE_ACCESS)) {
            conflicts.push(`${role} ${method} ${pattern}`);
          }
        }
      }
    }
    expect(conflicts).toEqual([]);
  });
});

describe("TD-04: كل مسار طاقم يستدعي حارسًا معروفًا", () => {
  const GUARDS = /\b(requireSession|requireSessionStrict|readSessionPayload|guardPatient|familyWriter|requireBackupAdminReadOnly|requireBackupAdminSession)\(/;

  it("لا مسار طاقم بلا حارس جلسة في ملفه", () => {
    const unguarded = ROUTES.filter((route) => {
      const entry = HTTP_PERMISSIONS[route.pattern] ?? {};
      const staff = Object.values(entry).some((access) => access !== undefined && !isAccessClass(access));
      return staff && !GUARDS.test(route.source);
    }).map((route) => route.pattern);
    expect(unguarded).toEqual([]);
  });
});

describe("TD-04: مطابِق المسارات وحكم الباب", () => {
  it("المقطع الثابت يغلب المتغيّر، والعنوان المجهول بلا نمط", () => {
    expect(matchApiRoute("/api/patients/12")).toBe("/api/patients/[id]");
    expect(matchApiRoute("/api/patients/12/ledger")).toBe("/api/patients/[id]/ledger");
    expect(matchApiRoute("/api/patients")).toBe("/api/patients");
    expect(matchApiRoute("/api/patients/")).toBe("/api/patients");
    expect(matchApiRoute("/api/no-such-route")).toBeNull();
    expect(matchApiRoute("/api/patients/12/no-such-child")).toBeNull();
    // كل نمطٍ ثابت يطابق نفسه — لا يبتلعه نمطٌ متغيّر.
    for (const pattern of Object.keys(HTTP_PERMISSIONS)) {
      if (!pattern.includes("[")) expect(matchApiRoute(pattern)).toBe(pattern);
    }
  });

  it("مسار مجهول ⇒ unknown-route، فعل غير مسجَّل ⇒ 405 بقائمة Allow، HEAD يتبع GET، OPTIONS يمرّ", () => {
    expect(apiRouteVerdict("/api/no-such-route", "GET")).toEqual({ kind: "unknown-route" });
    expect(apiRouteVerdict("/api/health", "DELETE")).toEqual({ kind: "method-not-allowed", pattern: "/api/health", allow: ["GET", "HEAD", "OPTIONS"] });
    expect(apiRouteVerdict("/api/auth/login", "GET")).toEqual({ kind: "method-not-allowed", pattern: "/api/auth/login", allow: ["POST", "OPTIONS"] });
    expect(apiRouteVerdict("/api/health", "HEAD")).toEqual({ kind: "registered", pattern: "/api/health", access: "public" });
    expect(apiRouteVerdict("/api/health", "OPTIONS")).toEqual({ kind: "registered", pattern: "/api/health", access: null });
    expect(apiRouteVerdict("/api/audit", "get")).toEqual({ kind: "registered", pattern: "/api/audit", access: ["admin"] });
  });

  it("الأدوار المرفوضة دائمًا: متمّم القائمة، ولا شيء للفئات غير الطاقمية", () => {
    expect(rolesAlwaysDenied(["admin"], ROLES)).toEqual(["reception", "doctor", "cashier", "accountant", "assistant"]);
    expect(rolesAlwaysDenied("public", ROLES)).toEqual([]);
  });
});


describe("reception handoff registration matches its existing authority boundary", () => {
  const pattern = "/api/visits/[id]/reception-handoff";
  const path = "/api/visits/17/reception-handoff";
  it("registers only POST for exactly the canonical reception roles", () => {
    const expected = ROLES.filter(role => canReadReceptionHandoff(role));
    expect(expected).toEqual(["admin", "reception"]);
    expect(HTTP_PERMISSIONS[pattern]).toEqual({ POST: expected });
    expect(matchApiRoute(path)).toBe(pattern);
    expect(apiRouteVerdict(path, "POST")).toEqual({ kind: "registered", pattern, access: expected });
    expect(rolesAlwaysDenied(expected, ROLES)).toEqual(["doctor", "cashier", "accountant", "assistant"]);
  });
  it("does not register reads or unrelated write verbs and preserves OPTIONS behavior", () => {
    for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE"]) {
      expect(apiRouteVerdict(path, method)).toEqual({ kind: "method-not-allowed", pattern, allow: ["POST", "OPTIONS"] });
    }
    expect(apiRouteVerdict(path, "OPTIONS")).toEqual({ kind: "registered", pattern, access: null });
    expect(matchApiRoute(`${path}/extra`)).toBeNull();
  });
});
