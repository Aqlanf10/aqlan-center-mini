import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CI_REQUIRED_NPM_MAJOR,
  CLINIC_TIME_ZONE_CONTRACT,
  GATE_DATABASE_URL_ENV_NAMES,
  REQUIRED_CI_GATES,
  RUNTIME_DATABASE_URL_ENV_NAMES,
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

afterEach(() => vi.unstubAllEnvs());

/** هل الأمر مطابِقٌ للبوابة حرفيًا أو بادئٌ لها بمعاملات (مثل ‎--output لمسار مؤقت)؟ */
function stepCommandsInclude(commands: readonly string[], gate: string): boolean {
  return commands.some((command) => command === gate || command.startsWith(`${gate} `));
}

/** موضع بوابة في ci.yml — بالأمر الحرفي أو بأمرها التحتّي (كما في فحص الوجود أعلاه). */
function ciYamlPosition(ciYaml: string, gate: string): number {
  const literal = ciYaml.indexOf(gate);
  if (literal >= 0) return literal;
  const scriptName = gate === "npm test" ? "test" : gate.replace("npm run ", "");
  const underlying = packageJson.scripts?.[scriptName] ?? "";
  return ciYaml.indexOf(underlying);
}

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
      "npm run schema:ownership:verify",
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
      expect(stepCommandsInclude(commands, gate), `${gate} — commands: ${commands.join(" | ")}`).toBe(true);
    }
    expect(stepCommandsInclude(commands, "npm run verify:environment")).toBe(true);
  });
});

describe("بوابة توصيف ملكية المخطط — CI ومحليًا متطابقان", () => {
  it("package.json يربط البوابة بالأداة المحمية", () => {
    expect(packageJson.scripts?.["schema:ownership:verify"]).toBe("tsx scripts/verify-schema-ownership.ts");
  });

  it("البوابة إلزامية في عقد CI", () => {
    expect(REQUIRED_CI_GATES).toContain("npm run schema:ownership:verify");
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

  it("volume الـPG18 مركَّبٌ على /var/lib/postgresql لا على ‎/data (وإلا ترفض الصورة الإقلاع)", () => {
    // صور postgres:18 نقلت PGDATA إلى /var/lib/postgresql/18/docker، وتخرج
    // برمز 1 إن وجدت تركيبًا على المسار القديم /var/lib/postgresql/data —
    // فكان «docker compose up -d pg18» الموثَّق يفشل على volume جديد.
    const compose = readRepoFile("docker-compose.yml");
    expect(compose).toMatch(/-\s*pg18-data:\/var\/lib\/postgresql\s*$/m);
    expect(compose).not.toContain("pg18-data:/var/lib/postgresql/data");
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
    expect(packageJson.scripts?.["verify:full"]).toBe("node --import tsx scripts/verify-full.mjs");
    expect(packageJson.scripts?.["verify:environment"]).toContain("verify-environment.mjs");
  });
  it("الخطوات تغطي كل بوابات CI الإلزامية نفسها — بلا استثناء أو تخطٍّ", async () => {
    const { FULL_GATE_STEPS } = await import("../scripts/verify-full.mjs");
    const commands = FULL_GATE_STEPS.map((step) => step.command.join(" "));
    for (const gate of REQUIRED_CI_GATES) {
      expect(stepCommandsInclude(commands, gate), gate).toBe(true);
    }
  });

  it("فحص البيئة أول الخطوات — الانجراف يُكشَف قبل إنفاق دقائق البوابة", async () => {
    const { FULL_GATE_STEPS } = await import("../scripts/verify-full.mjs");
    expect(FULL_GATE_STEPS[0]?.command.join(" ")).toBe("npm run verify:environment");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// تصحيحات مراجعة المالك على PR #45 — تغطية تنفيذية لا نصية
// ═══════════════════════════════════════════════════════════════════════════

describe("تصحيح ١ — قرار البيئة الموثَّق (الرابطان) قابلٌ للتنفيذ لا للقراءة", () => {
  it("الإعداد الموثَّق (TEST_DATABASE_URL + DATABASE_URL) يجتاز الفحص المسبق بلا فشلٍ ولا تحذير", async () => {
    const { databasePreflight, DOCUMENTED_FULL_GATE_SETUP } = await import("../scripts/verify-full.mjs");
    const { problems, warnings } = databasePreflight({
      TEST_DATABASE_URL: DOCUMENTED_FULL_GATE_SETUP.testDatabaseUrl,
      DATABASE_URL: DOCUMENTED_FULL_GATE_SETUP.databaseUrl,
    });
    expect(problems).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("رابط اختبار التكامل وحده لا يكفي — الرحلات تقرأ DATABASE_URL (الفخ المُصلَح)", async () => {
    const { databasePreflight } = await import("../scripts/verify-full.mjs");
    const { problems } = databasePreflight({
      TEST_DATABASE_URL: "postgresql://ci:ci@127.0.0.1:54329/aqlan_p1_test?sslmode=disable",
    });
    expect(problems.some((problem) => problem.includes("DATABASE_URL غير مضبوط"))).toBe(true);
  });

  it("رابط الصيانة وحده لا يكفي — اختبارات التكامل والأمن وبيان خط الأساس تقرأ TEST_DATABASE_URL", async () => {
    const { databasePreflight } = await import("../scripts/verify-full.mjs");
    const { problems } = databasePreflight({
      DATABASE_URL: "postgresql://ci:ci@127.0.0.1:54329/postgres?sslmode=disable",
    });
    expect(problems.some((problem) => problem.includes("TEST_DATABASE_URL غير مضبوط"))).toBe(true);
  });

  it("USE_LOCAL_DB=true يُرفض قبل البوابة — لا PGlite في العقد الكامل", async () => {
    const { databasePreflight } = await import("../scripts/verify-full.mjs");
    const { problems } = databasePreflight({
      TEST_DATABASE_URL: "postgresql://ci:ci@127.0.0.1:54329/aqlan_p1_test?sslmode=disable",
      DATABASE_URL: "postgresql://ci:ci@127.0.0.1:54329/postgres?sslmode=disable",
      USE_LOCAL_DB: "true",
    });
    expect(problems.some((problem) => problem.includes("USE_LOCAL_DB"))).toBe(true);
  });

  it("الرابطان على القيمة نفسها: تحذير فصلٍ معلن — لا فشلًا ولا صمتًا", async () => {
    const { databasePreflight } = await import("../scripts/verify-full.mjs");
    const { problems, warnings } = databasePreflight({
      TEST_DATABASE_URL: "postgresql://ci:ci@127.0.0.1:54329/aqlan_p1_test?sslmode=disable",
      DATABASE_URL: "postgresql://ci:ci@127.0.0.1:54329/aqlan_p1_test?sslmode=disable",
    });
    expect(problems).toEqual([]);
    expect(warnings.length).toBe(1);
  });

  it("الرحلات نفسها: التوفر يُقرأ من DATABASE_URL لا من رابط الاختبار", async () => {
    const { postgresAvailableFromEnv } = await import("../scripts/verify-ci.mjs");
    expect(postgresAvailableFromEnv({
      DATABASE_URL: "postgresql://ci:ci@127.0.0.1:54329/postgres?sslmode=disable",
    })).toBe(true);
    // الفخ بعينه: رابط اختبارٍ آمن بلا رابط صيانة — الرحلات غير متاحة
    expect(postgresAvailableFromEnv({
      TEST_DATABASE_URL: "postgresql://ci:ci@127.0.0.1:54329/aqlan_p1_test?sslmode=disable",
    })).toBe(false);
    expect(postgresAvailableFromEnv({})).toBe(false);
    expect(postgresAvailableFromEnv({
      DATABASE_URL: "postgresql://ci:ci@127.0.0.1:54329/postgres?sslmode=disable",
      USE_LOCAL_DB: "true",
    })).toBe(false);
  });

  it("الروابط الموثَّقة نفسها: مضيف/منفذ/قاعدتان كما في compose، وآمنة للبوابات، ومختلفان", async () => {
    const { DOCUMENTED_FULL_GATE_SETUP } = await import("../scripts/verify-full.mjs");
    const testUrl = new URL(DOCUMENTED_FULL_GATE_SETUP.testDatabaseUrl);
    const maintenanceUrl = new URL(DOCUMENTED_FULL_GATE_SETUP.databaseUrl);
    expect(testUrl.hostname).toBe("127.0.0.1");
    expect(maintenanceUrl.hostname).toBe("127.0.0.1");
    expect(testUrl.port).toBe("54329");
    expect(maintenanceUrl.port).toBe("54329");
    expect(testUrl.pathname).toBe("/aqlan_p1_test");
    expect(maintenanceUrl.pathname).toBe("/postgres");
    expect(DOCUMENTED_FULL_GATE_SETUP.testDatabaseUrl).not.toBe(DOCUMENTED_FULL_GATE_SETUP.databaseUrl);
    expect(checkDatabaseUrlForGates(DOCUMENTED_FULL_GATE_SETUP.testDatabaseUrl, "TEST_DATABASE_URL", { ci: false })).toBeNull();
    expect(checkDatabaseUrlForGates(DOCUMENTED_FULL_GATE_SETUP.databaseUrl, "DATABASE_URL", { ci: false })).toBeNull();
  });

  it("التوثيق الثلاثة (README وcompose وenv.example) يعرض الإعداد الموثَّق نفسه بالرابطين", async () => {
    const { DOCUMENTED_FULL_GATE_SETUP } = await import("../scripts/verify-full.mjs");
    for (const file of ["README.md", "docker-compose.yml", ".env.example"]) {
      const text = readRepoFile(file);
      expect(text, file).toContain(DOCUMENTED_FULL_GATE_SETUP.databaseUrl);
      expect(text, file).toContain(DOCUMENTED_FULL_GATE_SETUP.testDatabaseUrl);
      expect(text, file).toContain("docker compose up -d pg18");
    }
  });

  it("أمر هدم compose الموثَّق صحيح — بلا وسيطة خدمة بعد down", () => {
    const compose = readRepoFile("docker-compose.yml");
    expect(compose).toContain("docker compose down -v");
    expect(compose).not.toContain("docker compose down -v pg18");
  });
});

describe("تصحيح ٢ — كل مسارات الاتصال الحية داخل الفحص الفاشل مغلقًا", () => {
  it("القائمة المرجعية الحية هي الأسماء الأربعة المعروفة بترتيب قراءة lib/db.ts", () => {
    expect([...RUNTIME_DATABASE_URL_ENV_NAMES]).toEqual([
      "DATABASE_URL",
      "POSTGRES_URL",
      "POSTGRES_PRISMA_URL",
      "POSTGRES_URL_NON_POOLING",
    ]);
  });

  it("قائمة فحص البوابة تشمل المسارات الحية كلها + رابط الاختبار + مصدر الرحلات", () => {
    expect(GATE_DATABASE_URL_ENV_NAMES).toEqual(expect.arrayContaining([
      ...RUNTIME_DATABASE_URL_ENV_NAMES,
      "TEST_DATABASE_URL",
      "SOURCE_DATABASE_URL",
    ]));
  });

  it("التطبيق نفسه يستشير كل اسم بديل حي — لا نسخة منجرفة في lib/db.ts", async () => {
    const { rawConnectionStringFromEnv } = await import("../lib/db");
    const probe = "postgresql://ci:ci@127.0.0.1:54329/probe?sslmode=disable";
    for (const name of RUNTIME_DATABASE_URL_ENV_NAMES) {
      for (const other of RUNTIME_DATABASE_URL_ENV_NAMES) vi.stubEnv(other, "");
      vi.stubEnv(name, probe);
      expect(rawConnectionStringFromEnv(), name).toBe(probe);
    }
    for (const name of RUNTIME_DATABASE_URL_ENV_NAMES) vi.stubEnv(name, "");
    expect(rawConnectionStringFromEnv()).toBeNull();
  });

  it("مضيف Railway مرفوض عبر كل مسار — الأربعة الحية ورابط الاختبار ومصدر الرحلات، محليًّا وفي CI", () => {
    const railway = "postgresql://postgres:p@containers-us-west-1.railway.app:6543/railway";
    for (const name of GATE_DATABASE_URL_ENV_NAMES) {
      expect(checkDatabaseUrlForGates(railway, name, { ci: false })?.rule, name).toBe("db.host.railway");
      expect(checkDatabaseUrlForGates(railway, name, { ci: true })?.rule, name).toBe("db.host.railway");
    }
  });

  it("البعيد غير المصنَّف مرفوض عبر كل مسار — والمصنَّف test يمر محليًّا", () => {
    const remote = "postgresql://ci:ci@db.example.com:5432/x?sslmode=disable";
    for (const name of GATE_DATABASE_URL_ENV_NAMES) {
      expect(checkDatabaseUrlForGates(remote, name, { ci: false })?.rule, name).toBe("db.host.remote-unclassified");
    }
    const previous = process.env.DATABASE_ENVIRONMENT;
    process.env.DATABASE_ENVIRONMENT = "test";
    try {
      for (const name of GATE_DATABASE_URL_ENV_NAMES) {
        expect(checkDatabaseUrlForGates(remote, name, { ci: false }), name).toBeNull();
      }
    } finally {
      if (previous === undefined) delete process.env.DATABASE_ENVIRONMENT;
      else process.env.DATABASE_ENVIRONMENT = previous;
    }
  });

  it("CI يبقى loopback حصرًا عبر كل مسار — حتى المصنَّف يُرفض هناك", () => {
    const remote = "postgresql://ci:ci@db.example.com:5432/x?sslmode=disable";
    for (const name of GATE_DATABASE_URL_ENV_NAMES) {
      expect(checkDatabaseUrlForGates(remote, name, { ci: true })?.rule, name).toBe("db.host.ci-not-loopback");
    }
  });

  it("المحلي الآمن يمر عبر كل مسار — محليًّا وفي CI", () => {
    const local = "postgresql://ci:ci@127.0.0.1:54329/aqlan_p1_test?sslmode=disable";
    for (const name of GATE_DATABASE_URL_ENV_NAMES) {
      expect(checkDatabaseUrlForGates(local, name, { ci: false }), name).toBeNull();
      expect(checkDatabaseUrlForGates(local, name, { ci: true }), name).toBeNull();
    }
  });

  it("فحص البيئة نفسه يمر على القائمة المرجعية — لا قائمةً محليةً منجرفة", () => {
    expect(readRepoFile("scripts/verify-environment.mjs")).toContain("GATE_DATABASE_URL_ENV_NAMES");
  });

  it("lib/db.ts يستهلك القائمة المرجعية المشتركة لا نسخةً خاصة", () => {
    const dbSource = readRepoFile("lib/db.ts");
    expect(dbSource).toContain("RUNTIME_DATABASE_URL_ENV_NAMES");
    expect(dbSource).not.toMatch(/const CONNECTION_ENV_NAMES = \[/);
  });
});

describe("تصحيح ٢ (البوابة نفسها) — فحص عقد البيئة حيًّا كعملية طرفية، بلا اتصال إنتاج", () => {
  /** بيئة نظيفة: ترث ما تحتاجه العملية (PATH) بلا أي رابط قواعد أو تصنيف من الوسط الجاري. */
  function cleanGateEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { NODE_ENV: "test" };
    const stripped = new Set<string>([...GATE_DATABASE_URL_ENV_NAMES, "DATABASE_ENVIRONMENT", "CI", "CLINIC_TIME_ZONE", "USE_LOCAL_DB", "NODE_ENV"]);
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !stripped.has(key)) env[key] = value;
    }
    return { ...env, ...overrides };
  }

  function runEnvironmentGate(env: NodeJS.ProcessEnv) {
    return spawnSync(process.execPath, ["--import", "tsx", "scripts/verify-environment.mjs"], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      timeout: 90_000,
    });
  }

  it("رابط اختبارٍ آمن + POSTGRES_URL على Railway ⇒ البوابة تسقط بقاعدة db.host.railway (فخ المراجعة بعينه)", () => {
    const result = runEnvironmentGate(cleanGateEnv({
      TEST_DATABASE_URL: "postgresql://ci:ci@127.0.0.1:54329/aqlan_p1_test?sslmode=disable",
      POSTGRES_URL: "postgresql://postgres:p@containers-us-west-1.railway.app:6543/railway",
    }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("db.host.railway");
    expect(result.stderr).toContain("POSTGRES_URL");
  }, 120_000);

  it("بعيدٌ غير مصنَّف عبر POSTGRES_PRISMA_URL ⇒ البوابة تسقط بقاعدة db.host.remote-unclassified", () => {
    const result = runEnvironmentGate(cleanGateEnv({
      POSTGRES_PRISMA_URL: "postgresql://ci:ci@db.example.com:5432/x?sslmode=disable",
    }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("db.host.remote-unclassified");
    expect(result.stderr).toContain("POSTGRES_PRISMA_URL");
  }, 120_000);

  it.skipIf(nodeMajorFromVersionString(process.version) !== SUPPORTED_NODE_MAJOR)(
    "المسارات الحية كلها محلية آمنة ⇒ البوابة تجتاز",
    () => {
      const result = runEnvironmentGate(cleanGateEnv({
        TEST_DATABASE_URL: "postgresql://ci:ci@127.0.0.1:54329/aqlan_p1_test?sslmode=disable",
        DATABASE_URL: "postgresql://ci:ci@127.0.0.1:54329/postgres?sslmode=disable",
        POSTGRES_URL: "postgresql://ci:ci@127.0.0.1:54329/alias1?sslmode=disable",
        POSTGRES_PRISMA_URL: "postgresql://ci:ci@127.0.0.1:54329/alias2?sslmode=disable",
        POSTGRES_URL_NON_POOLING: "postgresql://ci:ci@127.0.0.1:54329/alias3?sslmode=disable",
        SOURCE_DATABASE_URL: "postgresql://ci:ci@127.0.0.1:54329/alias4?sslmode=disable",
      }));
      expect(result.status, result.stderr).toBe(0);
    },
    120_000,
  );
});

describe("تصحيح ٣ — البوابة الكاملة تحمل بوابات الأمان الأساسية كلها بترتيب CI", () => {
  it("REQUIRED_CI_GATES تشمل الآن عقد المخطط وبيان خط الأساس (توليدًا وتحققًا)", () => {
    expect(REQUIRED_CI_GATES).toEqual(expect.arrayContaining([
      "npm run schema:contract",
      "npm run db:baseline:manifest",
      "npm run db:baseline:manifest:verify",
    ]));
  });

  it("خطوات البوابة الكاملة بترتيب ci.yml نفسه — للبوابات الإلزامية كلها", async () => {
    const { FULL_GATE_STEPS } = await import("../scripts/verify-full.mjs");
    const commands = FULL_GATE_STEPS.map((step) => step.command.join(" "));
    const ciYaml = readRepoFile(".github/workflows/ci.yml");
    let previousStepIndex = -1;
    let previousCiPosition = -1;
    for (const gate of REQUIRED_CI_GATES) {
      const stepIndex = commands.findIndex((command) => command === gate || command.startsWith(`${gate} `));
      expect(stepIndex, `${gate} ليست في البوابة الكاملة`).toBeGreaterThanOrEqual(0);
      expect(stepIndex, `${gate} خارج ترتيب البوابة`).toBeGreaterThan(previousStepIndex);
      previousStepIndex = stepIndex;
      const ciPosition = ciYamlPosition(ciYaml, gate);
      expect(ciPosition, `${gate} ليست في ci.yml`).toBeGreaterThanOrEqual(0);
      expect(ciPosition, `${gate} خارج ترتيب ci.yml`).toBeGreaterThan(previousCiPosition);
      previousCiPosition = ciPosition;
    }
  });

  it("خطوة عقد المخطط وحدها هي التي تولّد الملتزم — وتستعيده بعدها (عين git checkout في CI)", async () => {
    const { FULL_GATE_STEPS } = await import("../scripts/verify-full.mjs");
    const regenerating = FULL_GATE_STEPS.filter((step) => step.regeneratesCommittedSchemaContract);
    expect(regenerating.length).toBe(1);
    expect(regenerating[0]?.command.join(" ")).toBe("npm run schema:contract");
  });

  it("تحقق بيان خط الأساس يقارن الملتزم ضد توليدٍ طازج (--fresh) من ملفٍّ خارج المستودع", async () => {
    const { FULL_GATE_STEPS } = await import("../scripts/verify-full.mjs");
    const commands = FULL_GATE_STEPS.map((step) => step.command.join(" "));
    const verifyIndex = commands.findIndex((command) => command.startsWith("npm run db:baseline:manifest:verify"));
    expect(verifyIndex).toBeGreaterThanOrEqual(0);
    const verifyStep = FULL_GATE_STEPS[verifyIndex];
    expect(verifyStep?.command).toContain("--fresh");
    const generationIndex = commands.findIndex((command) => command.startsWith("npm run db:baseline:manifest "));
    const generationStep = FULL_GATE_STEPS[generationIndex];
    expect(generationStep?.command).toContain("--output");
    const generated = generationStep?.command[(generationStep?.command.indexOf("--output") ?? 0) + 1];
    const fresh = verifyStep?.command[(verifyStep?.command.indexOf("--fresh") ?? 0) + 1];
    expect(fresh).toBe(generated);
    expect(generated?.startsWith(repoRoot)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// التصحيح النهائي — بوابة انحراف عقد المخطط: مقارنة بنيوية حتمية قبل الاستعادة
// ═══════════════════════════════════════════════════════════════════════════

describe("التصحيح النهائي — بوابة انحراف عقد المخطط (SCHEMA_CONTRACT_DRIFT)", () => {
  const ciYaml = readRepoFile(".github/workflows/ci.yml");

  it("package.json يعرّف schema:contract:verify على المُتحقِّق البنيوي", () => {
    expect(packageJson.scripts?.["schema:contract:verify"]).toBe("tsx scripts/verify-schema-contract-drift.ts");
  });

  it("REQUIRED_CI_GATES تشمل بوابة الانحراف — اختفاؤها من ci.yml أو البوابة الكاملة يسقط npm test", () => {
    expect(REQUIRED_CI_GATES).toContain("npm run schema:contract:verify");
  });

  it("verify:schema نفسه لم يُغيَّر — حماية المجموعة الجزئية المستقلة باقية كما هي", () => {
    const verifySchema = readRepoFile("scripts/verify-schema.mjs");
    expect(verifySchema).toContain("العقد ⊆ الواقع");
    expect(verifySchema).not.toContain("SCHEMA_CONTRACT_DRIFT");
  });

  it("البوابة الكاملة: 16 خطوة بعد إضافة توصيف ملكية المخطط — والانحراف والتوصيف قبل الرحلات", async () => {
    const { FULL_GATE_STEPS } = await import("../scripts/verify-full.mjs");
    expect(FULL_GATE_STEPS).toHaveLength(16);
    // (P-01) حارس تجميع المال خطوةٌ إلزامية بعد التنقيط — كما في CI.
    const commands = FULL_GATE_STEPS.map((step) => step.command.join(" "));
    const lintIndex = commands.findIndex((command) => command === "npm run lint");
    const moneyGuardIndex = commands.findIndex((command) => command === "npm run scan:money");
    expect(moneyGuardIndex).toBeGreaterThan(lintIndex);
    const generationIndex = commands.findIndex((command) => command === "npm run schema:contract");
    const driftIndex = commands.findIndex((command) => command.startsWith("npm run schema:contract:verify"));
    const ownershipIndex = commands.findIndex((command) => command.startsWith("npm run schema:ownership:verify"));
    const journeysIndex = commands.findIndex((command) => command === "npm run verify:ci");
    expect(generationIndex).toBeGreaterThanOrEqual(0);
    expect(driftIndex).toBeGreaterThan(generationIndex);
    expect(ownershipIndex).toBeGreaterThan(driftIndex);
    expect(journeysIndex).toBeGreaterThan(ownershipIndex);
    const driftStep = FULL_GATE_STEPS[driftIndex];
    const fresh = driftStep?.command[(driftStep?.command.indexOf("--fresh") ?? 0) + 1];
    expect(fresh).toBeTruthy();
    // عين دور /tmp في CI: الأثر خارج المستودع لا داخله
    expect(fresh?.startsWith(repoRoot)).toBe(false);
  });

  it("CI: الترتيب توليد → حفظ الطازج في /tmp → تحقّق بنيوي → استعادة الملتزم → رفع الأثر → الرحلات", () => {
    const anchors: Array<[string, string]> = [
      ["التوليد", "npm run schema:contract\n"],
      ["حفظ الطازج", "cp schema/current-schema-contract.pg18.json /tmp/current-schema-contract.pg18.json"],
      ["التحقق البنيوي", "npm run schema:contract:verify"],
      ["استعادة الملتزم", "git checkout -- schema/current-schema-contract.pg18.json"],
      ["رفع الأثر", "name: current-schema-contract-pg18"],
      ["الرحلات", "npm run verify:ci"],
    ];
    let previous = -1;
    for (const [label, literal] of anchors) {
      const position = ciYaml.indexOf(literal);
      expect(position, `${label} («${literal.trim()}») ليس في ci.yml`).toBeGreaterThanOrEqual(0);
      expect(position, `${label} خارج الترتيب`).toBeGreaterThan(previous);
      previous = position;
    }
  });

  it("CI: المقارنة قبل استعادة الملف الملتزم — والملتزم يُقرأ من HEAD لا من شجرة العمل المكتوبة فوقها", () => {
    expect(ciYaml).toContain("git show HEAD:schema/current-schema-contract.pg18.json");
    const verifyPosition = ciYaml.indexOf("npm run schema:contract:verify");
    const restorePosition = ciYaml.indexOf("git checkout -- schema/current-schema-contract.pg18.json");
    expect(verifyPosition).toBeGreaterThan(0);
    expect(verifyPosition, "المقارنة يجب أن تسبق git checkout --").toBeLessThan(restorePosition);
  });

  it("أمر CI للتحقق يمرّر الطازج والملتزم صراحةً كاملَين", () => {
    expect(ciYaml).toContain(
      "npm run schema:contract:verify -- --fresh /tmp/current-schema-contract.pg18.json --committed /tmp/committed-schema-contract.pg18.json",
    );
  });
});
