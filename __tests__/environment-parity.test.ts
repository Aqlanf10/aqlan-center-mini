import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CI_REQUIRED_NPM_MAJOR,
  CLINIC_TIME_ZONE_CONTRACT,
  REQUIRED_CI_GATES,
  SUPPORTED_NODE_MAJOR,
  SUPPORTED_NODE_RANGE,
  SUPPORTED_NPM_RANGE,
  SUPPORTED_POSTGRES_MAJOR,
  assertPostgresMajorOrThrow,
  checkDatabaseUrlForGates,
  checkNpmContract,
  checkNodeContract,
  checkPostgresMajor,
  isLoopbackHost,
  looksLikeRailwayDatabaseHost,
  nodeMajorFromVersionString,
  postgresMajorFromVersionNum,
} from "../lib/env-contract";
import { CLINIC_ZONE_FALLBACK, resolveClinicZone } from "../lib/clinicZone";

/**
 * عقد البيئة وتكافؤ CI — الفحوص التنفيذية (TD-02).
 *
 * هذه ليست فحوصَ نصٍّ توثيقي: كلٌّ منها يقرأ الملف الحقيقي (package.json،
 * ci.yml، Dockerfile، docker-compose.yml) أو يستدعي الدالة الحية التي يمرّ
 * منها الفحص نفسه، فيصبح انجرافُ أي ملفٍ بين هذه من عقد الآخر سقوطًا في
 * `npm test` — لا رأيًا في مراجعة.
 */

const repoRoot = join(__dirname, "..");
const readRepoFile = (relative: string): string => readFileSync(join(repoRoot, relative), "utf8");
const packageJson = JSON.parse(readRepoFile("package.json")) as {
  engines?: { node?: string; npm?: string };
  scripts?: Record<string, string>;
};

describe("عقد Node — صريحٌ ومُفحَص (TD-REG-019)", () => {
  it("engines.node في package.json يطابق العقد الحي حرفيًا", () => {
    expect(packageJson.engines?.node).toBe(SUPPORTED_NODE_RANGE);
  });

  it("‎.nvmrc يثبّت الإصدار نفسه لمطوّر nvm", () => {
    const nvmrc = readRepoFile(".nvmrc").trim();
    expect(nodeMajorFromVersionString(`v${nvmrc}`)).toBe(SUPPORTED_NODE_MAJOR);
  });

  it("‎.nvmrc إصدارٌ صريح لا اسم فرع أو وسم", () => {
    expect(readRepoFile(".nvmrc").trim()).toMatch(/^\d+(\.\d+)*$/);
  });

  it("الفحص يكتشف الإصدار غير المدعوم ويرفضه برسالة العقد", () => {
    for (const bad of ["v24.19.0", "v23.0.0", "v20.11.3"]) {
      const violation = checkNodeContract(bad);
      expect(violation, bad).not.toBeNull();
      expect(violation?.rule, bad).toBe("node.major.unsupported");
      expect(violation?.message, bad).toContain(String(SUPPORTED_NODE_MAJOR));
    }
  });

  it("الإصدار المدعوم يمرّ بلا انتهاك", () => {
    expect(checkNodeContract(`v${SUPPORTED_NODE_MAJOR}.20.0`)).toBeNull();
  });

  it("نصٌّ لا يُفسَّر كإصدار يُرفض لا يُتجاهَل", () => {
    expect(checkNodeContract("نثّة")?.rule).toBe("node.version.unparseable");
  });
});

describe("عقد npm — التثبيت والتدقيق (المرحلة C)", () => {
  it("engines.npm يطابق النطاق الحي", () => {
    expect(packageJson.engines?.npm).toBe(SUPPORTED_NPM_RANGE);
  });

  it("النطاق يشمل npm المدمج مع node:22 (بناء Docker) وnpm 11 (تدقيق CI)", () => {
    expect(checkNpmContract("10.9.3")).toBeNull();
    expect(checkNpmContract(`11.19.1`)).toBeNull();
  });

  it("major خارج النطاق يُرفض — 9 و12 وnpm 10.5 ما قبل المدمج", () => {
    expect(checkNpmContract("9.8.1")?.rule).toBe("npm.range.unsupported");
    expect(checkNpmContract("12.0.0")?.rule).toBe("npm.range.unsupported");
    expect(checkNpmContract("10.5.0")?.rule).toBe("npm.range.unsupported");
  });

  it("CI يرفع إلى major التدقيق المطلوب داخل النطاق", () => {
    expect(CI_REQUIRED_NPM_MAJOR).toBe(11);
    expect(checkNpmContract("11.0.0")).toBeNull();
  });
});

describe("توافق Docker وCI وengines على إصدار Node واحد", () => {
  it("مراحل Dockerfile كلها على الصورة التعاقدية node:22-alpine", () => {
    const dockerfile = readRepoFile("Dockerfile");
    const fromLines = dockerfile.split("\n").filter((line) => /^\s*FROM\s+/i.test(line));
    expect(fromLines.length).toBeGreaterThanOrEqual(3);
    for (const line of fromLines) {
      expect(line).toMatch(new RegExp(`^\\s*FROM\\s+node:${SUPPORTED_NODE_MAJOR}-alpine\\s`, "i"));
    }
  });

  it("setup-node في CI على الإصدار التعاقدي نفسه", () => {
    const ci = readRepoFile(".github/workflows/ci.yml");
    const match = new RegExp(`node-version:\\s*${SUPPORTED_NODE_MAJOR}\\s*$`, "m").exec(ci);
    expect(match).not.toBeNull();
  });
});

describe("بوابات CI الإلزامية لا تختفي صامتًا (المرحلة H)", () => {
  const ciYaml = readRepoFile(".github/workflows/ci.yml");

  it("كل بوابة إلزامية موجودة في الـworkflow — بالأمر نفسه أو بما يشغّله الأمر", () => {
    for (const gate of REQUIRED_CI_GATES) {
      const scriptName = gate === "npm test" ? "test" : gate.replace("npm run ", "");
      const underlying = packageJson.scripts?.[scriptName] ?? "";
      const present = ciYaml.includes(gate) || (underlying !== "" && ciYaml.includes(underlying));
      expect(present, `${gate} (والأمر التحتي «${underlying}»)`).toBe(true);
    }
  });

  it("القائمة نفسها تعرّف البوابات الأساسية للعقد", () => {
    expect(REQUIRED_CI_GATES).toEqual(expect.arrayContaining([
      "npm run test:postgres",
      "npm run verify:ci",
      "npm run test:security-http",
      "npm run build",
      "npm run ci:audit",
      "npm run ci:scan:body",
    ]));
  });

  it("فحص عقد البيئة نفسه بوابةٌ في CI — الانجراف يُكشَف في البناء لا محليًا فقط", () => {
    expect(ciYaml).toContain("npm run verify:environment");
  });

  it("القاعدة: البوابات تطابق خطوات البوابة الكاملة المحلية", async () => {
    const { FULL_GATE_STEPS } = await import("../scripts/verify-full.mjs");
    const commands = FULL_GATE_STEPS.map((step) => step.command.join(" "));
    for (const gate of REQUIRED_CI_GATES) {
      expect(commands, gate).toContain(gate);
    }
    expect(commands).toContain("npm run verify:environment");
  });
});

describe("أمان قاعدة CI — لا تُصيب إنتاجًا عبر افتراضات المستودع (المرحلة H)", () => {
  const ciYaml = readRepoFile(".github/workflows/ci.yml");

  it("روابط CI في الـworkflow محلية (loopback) وقواعد الاختبار المعروفة", () => {
    const databaseUrls = [...ciYaml.matchAll(/postgresql:\/\/[^\s]+/g)].map((m) => m[0]);
    expect(databaseUrls.length).toBeGreaterThanOrEqual(3);
    for (const url of databaseUrls) {
      const host = new URL(url).hostname;
      expect(isLoopbackHost(host), url).toBe(true);
    }
  });

  it("الفحص الحي يمرّ روابط CI الافتراضية بلا انتهاك", () => {
    const ciDefaults = [
      "postgresql://ci:ci@127.0.0.1:5432/aqlan_center_ci?sslmode=disable",
      "postgresql://ci:ci@127.0.0.1:5432/aqlan_p1_test?sslmode=disable",
      "postgresql://ci:ci@127.0.0.1:5432/postgres?sslmode=disable",
    ];
    for (const url of ciDefaults) {
      expect(checkDatabaseUrlForGates(url, "TEST_DATABASE_URL", { ci: true }), url).toBeNull();
    }
  });

  it("رابط بعيد في سياق CI مرفوض حتى لو صُنِّف", () => {
    const url = "postgresql://ci:ci@db.example.com:5432/x?sslmode=disable";
    expect(checkDatabaseUrlForGates(url, "TEST_DATABASE_URL", { ci: true })?.rule)
      .toBe("db.host.ci-not-loopback");
  });

  it("مضيف Railway مرفوض مطلقًا — تصنيفٌ لا يفتح قرص الإنتاج", () => {
    expect(looksLikeRailwayDatabaseHost("postgres.railway.internal")).toBe(true);
    expect(looksLikeRailwayDatabaseHost("containers-us-west-1.railway.app")).toBe(true);
    expect(looksLikeRailwayDatabaseHost("prime.db.railway.internal")).toBe(true);
    const violation = checkDatabaseUrlForGates(
      "postgresql://postgres:p@containers-us-west-1.railway.app:6543/railway",
      "DATABASE_URL",
      { ci: false },
    );
    expect(violation?.rule).toBe("db.host.railway");
  });

  it("البعيد غير المصنَّف مرفوض محليًا — والمصنَّف test يمرّ", () => {
    const url = "postgresql://ci:ci@db.example.com:5432/x?sslmode=disable";
    expect(checkDatabaseUrlForGates(url, "TEST_DATABASE_URL", { ci: false })?.rule)
      .toBe("db.host.remote-unclassified");
    const previous = process.env.DATABASE_ENVIRONMENT;
    process.env.DATABASE_ENVIRONMENT = "test";
    try {
      expect(checkDatabaseUrlForGates(url, "TEST_DATABASE_URL", { ci: false })).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.DATABASE_ENVIRONMENT;
      else process.env.DATABASE_ENVIRONMENT = previous;
    }
  });

  it("الرابط غير القابل للتحليل يُرفض لا يُتجاهَل", () => {
    expect(checkDatabaseUrlForGates("file:/somewhere/custom.db", "DATABASE_URL", { ci: false })?.rule)
      .toBe("db.url.protocol");
  });
});

describe("عقد التوقيت — Asia/Aden معنى واحد (المرحلة E)", () => {
  it("الثابت التعاقدي هو توقيت العيادة الافتراضي الحي", () => {
    expect(CLINIC_TIME_ZONE_CONTRACT).toBe("Asia/Aden");
    expect(CLINIC_ZONE_FALLBACK).toBe(CLINIC_TIME_ZONE_CONTRACT);
  });

  it("غياب الإعداد يحلّ إلى Asia/Aden — لا إلى توقيت الجهاز", () => {
    expect(resolveClinicZone(undefined)).toBe("Asia/Aden");
    expect(resolveClinicZone("   ")).toBe("Asia/Aden");
  });

  it("منطقة مجهولة تُردّ إلى العقد لا تُمرَّر فتُطفئ الحساب", () => {
    expect(resolveClinicZone("Asia/Taiz")).toBe("Asia/Aden");
    expect(resolveClinicZone("نثّة")).toBe("Asia/Aden");
  });

  it("المنطقة المعروفة تمرّ كما هي — فرعٌ مستقبلي لا يُمنع", () => {
    expect(resolveClinicZone("Asia/Riyadh")).toBe("Asia/Riyadh");
  });

  it("CI يضبط التوقيت التعاقدي صراحةً في الـworkflow", () => {
    expect(readRepoFile(".github/workflows/ci.yml")).toContain(`CLINIC_TIME_ZONE: ${CLINIC_TIME_ZONE_CONTRACT}`);
  });
});

describe("عقد PostgreSQL — 18 للاختبار والتطوير (TD-REG-008)", () => {
  it("الفحص يرفض الإصدار غير المدعوم ويحمل طريق الإصلاح", () => {
    const violation = checkPostgresMajor(16);
    expect(violation?.rule).toBe("postgres.major.unsupported");
    expect(violation?.message).toContain("docker compose up -d pg18");
  });

  it("الإصدار المدعوم يمرّ — والاستثناء الصريح يرمي لغيره", () => {
    expect(checkPostgresMajor(SUPPORTED_POSTGRES_MAJOR)).toBeNull();
    expect(() => assertPostgresMajorOrThrow(SUPPORTED_POSTGRES_MAJOR)).not.toThrow();
    expect(() => assertPostgresMajorOrThrow(16)).toThrowError(/postgres\.major\.unsupported/);
  });

  it("server_version_num يُفسَّر إلى major — 180004 ⇒ 18", () => {
    expect(postgresMajorFromVersionNum(180004)).toBe(18);
    expect(postgresMajorFromVersionNum("160005")).toBe(16);
    expect(postgresMajorFromVersionNum(0)).toBe(0);
  });

  it("الطريق المحلي الموثَّق (docker-compose) على الإصدار التعاقدي نفسه", () => {
    const compose = readRepoFile("docker-compose.yml");
    expect(compose).toContain(`image: postgres:${SUPPORTED_POSTGRES_MAJOR}-alpine`);
    expect(compose).toContain("54329:5432");
  });

  it("إعداد اختبارات PostgreSQL يمرّ بعقد الإصدار (globalSetup موصول)", () => {
    const config = readRepoFile("vitest.config.postgres.mts");
    expect(config).toContain("globalSetup");
    expect(config).toContain("__tests__/postgres/_global-setup.ts");
  });

  it("توليد عقد المخطط يفحص الإصدار قبل الكتابة (لا عقد pg18 من خادم آخر)", () => {
    const generator = readRepoFile("scripts/generate-current-schema-contract.ts");
    expect(generator).toContain("assertPostgresMajorOrThrow");
  });
});

describe("عقد المتغيرات — لا أسرار في المستودع (المرحلة F)", () => {
  it("‎.env.example لا يحمل قيمًا حيّة: القوالب فارغة أو مثالٌ معلن", () => {
    const example = readRepoFile(".env.example");
    const secretAssignments = [...example.matchAll(/^(SESSION_SECRET|SETUP_TOKEN|GEMINI_API_KEY)[ \t]*=[ \t]*(.*)$/gm)];
    expect(secretAssignments.length).toBeGreaterThanOrEqual(3);
    for (const [, name, value] of secretAssignments) {
      expect(`${name}=${value}`.trim()).toMatch(/=\s*$/);
    }
    // روابط القواعد في القالب: مضيف المثال لا قاعدة حيّة
    for (const url of [...example.matchAll(/postgresql:\/\/[^\s]+/g)].map((m) => m[0])) {
      expect(new URL(url).hostname, url).toMatch(/^(host|user|127\.0\.0\.1|localhost)$/);
    }
  });

  it("سرّ CI قيمةٌ مكانية معلنة لا سرًّا حقيقيًا", () => {
    const ciYaml = readRepoFile(".github/workflows/ci.yml");
    expect(ciYaml).toContain("SESSION_SECRET: ci-placeholder-secret-0123456789abcdef");
    // لا أسرار منصوبة في الـworkflow — المتغيرات البيئية قيم معلنة كلها
    expect(ciYaml).not.toMatch(/secrets\./);
  });

  it("‎.env و.env.local محجوبان من الالتزام", () => {
    const gitignore = readRepoFile(".gitignore");
    expect(gitignore).toMatch(/^\.env$/m);
    expect(gitignore).toMatch(/^\.env\.local$/m);
  });
});

describe("البوابة الكاملة المحلية — عقدٌ واحد معلن (TD-REG-013)", () => {
  it("الأمر المعلن في package.json يشغّل منسّق البوابة الكاملة", () => {
    expect(packageJson.scripts?.["verify:full"]).toBe("node scripts/verify-full.mjs");
    expect(packageJson.scripts?.["verify:environment"]).toContain("verify-environment.mjs");
  });
  it("الخطوات تغطي كل بوابات CI الإلزامية نفسها — بلا استثناء أو تخطٍّ", async () => {
    const { FULL_GATE_STEPS } = await import("../scripts/verify-full.mjs");
    const commands = FULL_GATE_STEPS.map((step) => step.command.join(" "));
    for (const gate of REQUIRED_CI_GATES) {
      expect(commands, gate).toContain(gate);
    }
  });

  it("فحص البيئة أول الخطوات — الانجراف يُكشَف قبل إنفاق دقائق البوابة", async () => {
    const { FULL_GATE_STEPS } = await import("../scripts/verify-full.mjs");
    expect(FULL_GATE_STEPS[0]?.command.join(" ")).toBe("npm run verify:environment");
  });
});
