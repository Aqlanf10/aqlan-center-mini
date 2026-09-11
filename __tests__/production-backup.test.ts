import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, stat, symlink, writeFile, writeFile as write } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  productionRuntimeActivated,
  readDocumentWithRealpathGuard,
  runProductionBackupOnce,
  type ProductionBackupDeps,
} from "../lib/productionBackup";
import {
  assertDocumentsDirInsideVolume,
  backupOnceDir,
  backupStateDir,
  resolveBackupDirectory,
} from "../lib/backupVolume";
import { validBlocksFactory, validBackupEntries, blocksFromEntries, storageKeyOf, sha256Of } from "./helpers/backup-blocks";

/**
 * اختبارات بوابة التفعيل الإنتاجي (المرة الواحدة) على قرصٍ دائمٍ مزيف (temp).
 *
 * تغطية بنود التصميم: الحارس الزمني، فشل التكوين مغلقًا، رمزٌ خاطئ، لا رمز
 * خام في السجلات، احتواء الوجهة (لا /data-evil ولا ../)، هروب symlink،
 * لا اسم نهائي قبل التحقق، الفاشل لا يترك أرشيفًا، الناجح يترك أرشيفًا
 * مكتملًا، بصمات SQL/المستندات والأحجام، مستند مفقود ومدخل مكرر، إعادة
 * نفس الرمز idempotent، توازي الرمز نفسه = نسخة واحدة، إعادة المحاولة بعد
 * الفشل، الاكتمال يمنع نسخة ثانية، واستجابة بلا مسارات مطلقة ولا أسرار.
 *
 * مصفوفة RBAC (مدير مسموح/غير مدير مرفوض) تُطرق على HTTP الحقيقي في
 * __tests__/security-http/production-backup.test.ts.
 */

let volume: string;
let documentsDir: string;

beforeAll(async () => {
  // دليل المستندات ابنٌ حقيقي داخل الجذر المزيف — نفس شكل الإنتاج
  // (/data + /data/documents) حتى يجتاز فحص الاحتواء.
  volume = await mkdtemp(path.join(tmpdir(), "aqlan-gate-volume-"));
  documentsDir = path.join(volume, "documents");
  await mkdir(documentsDir, { recursive: true });
});

afterAll(async () => {
  await rm(volume, { recursive: true, force: true }).catch(() => {});
  await rm(documentsDir, { recursive: true, force: true }).catch(() => {});
});

function baseDeps(overrides: Partial<ProductionBackupDeps> = {}): ProductionBackupDeps {
  const { blocks } = validBlocksFactory();
  return {
    providedToken: "correct-horse-battery-staple",
    expectedToken: "correct-horse-battery-staple",
    volumeRoot: volume,
    documentsDir,
    blocks,
    appCommitSha: "1d004aa8dce5d885167beab9e41832638381dab1",
    log: () => {},
    ...overrides,
  };
}

async function listBackupFiles(): Promise<string[]> {
  const backupDir = resolveBackupDirectory(volume);
  try {
    return (await readdir(backupDir)).filter((entry) => !entry.startsWith("."));
  } catch {
    return [];
  }
}

async function listTmpArtifacts(): Promise<string[]> {
  const backupDir = resolveBackupDirectory(volume);
  try {
    return (await readdir(backupDir)).filter((entry) => entry.startsWith(".") && entry.endsWith(".tmp"));
  } catch {
    return [];
  }
}

describe("الحارس الزمني للتشغيل الإنتاجي", () => {
  it("يرفض كل شيء في غياب الإشارتين معًا", () => {
    expect(productionRuntimeActivated({})).toBe(false);
    expect(productionRuntimeActivated({ NODE_ENV: "production" })).toBe(false);
    expect(productionRuntimeActivated({ DATABASE_ENVIRONMENT: "production" })).toBe(false);
    expect(productionRuntimeActivated({ RAILWAY_PROJECT_ID: "prj-x" })).toBe(false);
  });

  it("لا يكفي NODE_ENV=production وحده (بيئات الاختبار تشتغل به)", () => {
    expect(productionRuntimeActivated({
      NODE_ENV: "production",
      DATABASE_ENVIRONMENT: "staging",
      RAILWAY_PROJECT_ID: "prj-x",
    })).toBe(false);
  });

  it("يفتح فقط بإشارة الإنتاج وإشارة Railway معًا", () => {
    expect(productionRuntimeActivated({
      NODE_ENV: "production",
      DATABASE_ENVIRONMENT: "production",
      RAILWAY_PROJECT_ID: "prj-x",
    })).toBe(true);
    expect(productionRuntimeActivated({
      DATABASE_ENVIRONMENT: "production",
      RAILWAY_SERVICE_ID: "srv-x",
    })).toBe(true);
  });
});

describe("فشل التكوين والرمز — مغلق دائمًا", () => {
  it("رمز غير مهيَّأ ⇒ misconfigured وقارئ الأرشيف لا يُستدعى", async () => {
    const blocks = vi.fn(validBlocksFactory().blocks);
    const outcome = await runProductionBackupOnce(baseDeps({ expectedToken: "  ", blocks }));
    expect(outcome.kind).toBe("misconfigured");
    expect(blocks).not.toHaveBeenCalled();
  });

  it("رمز خاطئ ⇒ denied وقارئ الأرشيف لا يُستدعى", async () => {
    const blocks = vi.fn(validBlocksFactory().blocks);
    const outcome = await runProductionBackupOnce(baseDeps({ providedToken: "wrong-token", blocks }));
    expect(outcome.kind).toBe("denied");
    expect(blocks).not.toHaveBeenCalled();
    if (outcome.kind === "denied") {
      expect(outcome.message).not.toContain("wrong-token");
    }
  });

  it("رمز مفقود من الجسم ⇒ denied بلا تفاصيل", async () => {
    const outcome = await runProductionBackupOnce(baseDeps({ providedToken: "" }));
    expect(outcome.kind).toBe("denied");
  });
});

describe("لا رمز خام في السجلات ولا في الحالة", () => {
  it("نجاحٌ وفشلٌ لا يحمل سجلُهما الرمز الخام، وملف الحالة يحمل البصمة فقط", async () => {
    const firstVolume = await mkdtemp(path.join(tmpdir(), "aqlan-gate-logs-"));
    const firstDocs = path.join(firstVolume, "documents");
    await mkdir(firstDocs, { recursive: true });
    try {
      const lines: string[] = [];
      const log = (message: string) => lines.push(message);
      const secret = "super-secret-activation-token-9f3";

      const bad = await runProductionBackupOnce(baseDeps({
        providedToken: "super-secret-activation-token-WRONG",
        expectedToken: secret,
        volumeRoot: firstVolume,
        documentsDir: firstDocs,
        log,
      }));
      expect(bad.kind).toBe("denied");

      const good = await runProductionBackupOnce(baseDeps({
        providedToken: secret,
        expectedToken: secret,
        volumeRoot: firstVolume,
        documentsDir: firstDocs,
        log,
      }));
      expect(good.kind).toBe("completed");

      for (const line of lines) {
        expect(line).not.toContain(secret);
        expect(line).not.toContain("super-secret-activation-token");
      }
      const stateRaw = await readFile(path.join(backupOnceDir(resolveBackupDirectory(firstVolume)), "state.json"), "utf8");
      expect(stateRaw).not.toContain(secret);
      const state = JSON.parse(stateRaw) as { tokenHash?: string };
      expect(state.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      // والنتيجة الناجحة نفسها لا تحمل الرمز
      expect(JSON.stringify(good)).not.toContain(secret);
    } finally {
      await rm(firstVolume, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe("احتواء الوجهات داخل جذر القرص الدائم", () => {
  it("backups ابنٌ حقيقي داخل الجذر", () => {
    expect(resolveBackupDirectory("/data")).toBe("/data/backups");
    expect(resolveBackupDirectory("/data/")).toBe("/data/backups");
  });

  it("/data-evil ليست داخل /data (لا startsWith الساذج)", () => {
    expect(() => assertDocumentsDirInsideVolume("/data-evil/documents", "/data")).toThrow();
    expect(() => assertDocumentsDirInsideVolume("/data-evil", "/data")).toThrow();
  });

  it("..  يُرفض من الباب", () => {
    expect(() => assertDocumentsDirInsideVolume("/data/../evil", "/data")).toThrow();
    expect(() => assertDocumentsDirInsideVolume("/data/sub/../../evil", "/data")).toThrow();
  });
});

describe("حارس symlink — لا خروج من دليل المستندات", () => {
  it("مستندٌ رابطٌ رمزي خارج الدليل ⇒ مرفوض؛ والعادي يُقرأ", async () => {
    const docs = await mkdtemp(path.join(tmpdir(), "aqlan-symlink-docs-"));
    const outside = await mkdtemp(path.join(tmpdir(), "aqlan-symlink-out-"));
    try {
      const legitContent = "legit-document-bytes";
      const legitKey = storageKeyOf(legitContent);
      await mkdir(path.join(docs, path.dirname(legitKey)), { recursive: true });
      await write(path.join(docs, legitKey), legitContent);

      // الملف العادي يُقرأ بنجاح.
      const legit = await readDocumentWithRealpathGuard(legitKey, docs);
      expect(legit.toString("utf8")).toBe(legitContent);

      // الرابط الرمزي الذي يخرج: mkdir + symlink لملف خارجي في مفتاحٍ صالح النمط.
      const outsideFile = path.join(outside, "secret.txt");
      await write(outsideFile, "classified");
      const escapedKey = "aa/bb/" + "f".repeat(64) + ".png";
      await mkdir(path.join(docs, "aa/bb"), { recursive: true });
      await symlink(outsideFile, path.join(docs, escapedKey));

      await expect(readDocumentWithRealpathGuard(escapedKey, docs)).rejects.toThrow(/رابط رمزي/);
    } finally {
      await rm(docs, { recursive: true, force: true }).catch(() => {});
      await rm(outside, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("مفتاح بنمط غير آمن يُرفض قبل أي قراءة", async () => {
    await expect(readDocumentWithRealpathGuard("../../etc/passwd", documentsDir)).rejects.toThrow(/غير آمن/);
  });
});

describe("لا اسم نهائي لغير نسخة مكتملة", () => {
  afterEach(async () => {
    // تنظيف بين الاختبارات: مجلد النسخ يُفرَّغ من النهائي والحالة.
    for (const name of await listBackupFiles()) {
      await rm(path.join(resolveBackupDirectory(volume), name), { force: true });
    }
    await rm(backupOnceDir(resolveBackupDirectory(volume)), { recursive: true, force: true }).catch(() => {});
    await rm(backupStateDir(resolveBackupDirectory(volume)), { recursive: true, force: true }).catch(() => {});
  });

  it("أرشيفٌ تالف (بصمة SQL لا تطابق) ⇒ failed، لا نهائي، لا tmp، القفل رحل", async () => {
    const tampered = validBackupEntries({
      manifestOverride: {
        format: "aqlan-full-backup", version: 1, createdAt: new Date().toISOString(),
        databaseSha256: "0".repeat(64), documents: [],
      },
    });
    const outcome = await runProductionBackupOnce(baseDeps({ blocks: blocksFromEntries(tampered.entries) }));
    expect(outcome.kind).toBe("failed");
    expect(await listBackupFiles()).toEqual([]);
    expect(await listTmpArtifacts()).toEqual([]);
    const lockGone = await readdir(backupStateDir(resolveBackupDirectory(volume))).catch(() => []);
    expect(lockGone).not.toContain("backup.lock");
  });

  it("قارئٌ يفشل في المنتصف ⇒ failed ولا أرشيف نهائي", async () => {
    const failing = async function* () {
      yield new Uint8Array(1024).fill(7);
      throw new Error("connection lost during dump");
    };
    const outcome = await runProductionBackupOnce(baseDeps({ blocks: failing }));
    expect(outcome.kind).toBe("failed");
    expect(await listBackupFiles()).toEqual([]);
    if (outcome.kind === "failed") {
      expect(outcome.message).toContain("connection lost");
    }
  });

  it("نجاح ⇒ أرشيف نهائي موجود بحجمٍ أكبر من صفر واسمٍ بالصيغة المعتمدة", async () => {
    const outcome = await runProductionBackupOnce(baseDeps());
    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") return;
    const files = await listBackupFiles();
    expect(files).toEqual([outcome.proof.filename]);
    expect(outcome.proof.filename).toMatch(/^production-activation-\d{8}-\d{6}-1d004aa8dce5\.tar\.gz$/);
    const fileStat = await stat(path.join(resolveBackupDirectory(volume), outcome.proof.filename));
    expect(fileStat.size).toBe(outcome.proof.bytes);
    expect(fileStat.size).toBeGreaterThan(0);
  });
});

describe("التحقق الكامل — كل تلفٍ يُكتشف قبل الاسم النهائي", () => {
  const cases: { label: string; build: () => Parameters<typeof blocksFromEntries>[0] }[] = [];
  const base = validBackupEntries();

  cases.push({
    label: "بصمة SQL لا تطابق المفتاح",
    build: () => validBackupEntries({
      manifestOverride: { ...base.manifest, databaseSha256: "1".repeat(64) },
    }).entries,
  });
  cases.push({
    label: "بصمة مستند لا تطابق",
    build: () => validBackupEntries({
      manifestOverride: {
        ...base.manifest,
        documents: (base.manifest.documents as { sha256: string }[]).map((doc, index) =>
          index === 0 ? { ...doc, sha256: "2".repeat(64) } : doc),
      },
    }).entries,
  });
  cases.push({
    label: "حجم مستند لا يطابق",
    build: () => validBackupEntries({
      manifestOverride: {
        ...base.manifest,
        documents: (base.manifest.documents as { sizeBytes: number }[]).map((doc, index) =>
          index === 0 ? { ...doc, sizeBytes: 99999 } : doc),
      },
    }).entries,
  });
  cases.push({
    label: "مستند مفقود من الأرشيف",
    build: () => validBackupEntries({
      manifestOverride: {
        ...base.manifest,
        documents: [
          ...(base.manifest.documents as object[]),
          { id: 99, storageKey: storageKeyOf("ghost"), sha256: sha256Of("ghost"), sizeBytes: 5, title: "شبح", patientId: 99, removedAt: null },
        ],
      },
    }).entries,
  });
  cases.push({
    label: "مدخل مكرر (مسار مكرر)",
    build: () => validBackupEntries({ duplicateEntry: "database.sql" }).entries,
  });
  cases.push({
    label: "manifest ليس آخر مدخل",
    build: () => {
      const entries = base.entries.slice();
      const manifestEntry = entries.find((entry) => entry.name === "manifest.json")!;
      return [manifestEntry, ...entries.filter((entry) => entry.name !== "manifest.json")];
    },
  });

  for (const testCase of cases) {
    it(`${testCase.label} ⇒ failed بلا نهائي`, async () => {
      const outcome = await runProductionBackupOnce(baseDeps({ blocks: blocksFromEntries(testCase.build()) }));
      expect(outcome.kind).toBe("failed");
      expect(await listBackupFiles()).toEqual([]);
    });
  }
});

describe("المرة الواحدة — إعادة وإعادة محاولة وتوازٍ", () => {
  afterEach(async () => {
    for (const name of await listBackupFiles()) {
      await rm(path.join(resolveBackupDirectory(volume), name), { force: true });
    }
    await rm(backupOnceDir(resolveBackupDirectory(volume)), { recursive: true, force: true }).catch(() => {});
    await rm(backupStateDir(resolveBackupDirectory(volume)), { recursive: true, force: true }).catch(() => {});
  });

  it("نفس الرمز بعد النجاح ⇒ إثبات idempotent نفسه بلا نسخة ثانية", async () => {
    const blocks = vi.fn(validBlocksFactory().blocks);
    const first = await runProductionBackupOnce(baseDeps({ blocks }));
    expect(first.kind).toBe("completed");
    const second = await runProductionBackupOnce(baseDeps({ blocks }));
    expect(second.kind).toBe("replayed");
    if (first.kind === "completed" && second.kind === "replayed") {
      expect(second.proof).toEqual(first.proof);
    }
    expect(blocks).toHaveBeenCalledTimes(1);
    expect((await listBackupFiles()).length).toBe(1);
  });

  it("ثلاثة استدعاءات متوازية بنفس الرمز ⇒ نسخة واحدة فقط وكلهم يحصلون على الإثبات نفسه", async () => {
    const blocks = vi.fn(validBlocksFactory().blocks);
    const [first, second, third] = await Promise.all([
      runProductionBackupOnce(baseDeps({ blocks })),
      runProductionBackupOnce(baseDeps({ blocks })),
      runProductionBackupOnce(baseDeps({ blocks })),
    ]);
    for (const outcome of [first, second, third]) {
      expect(["completed", "replayed"]).toContain(outcome.kind);
    }
    const proofs = [first, second, third].map((outcome) =>
      outcome.kind === "completed" || outcome.kind === "replayed" ? outcome.proof.filename : "");
    expect(new Set(proofs).size).toBe(1);
    expect(blocks).toHaveBeenCalledTimes(1);
    expect((await listBackupFiles()).length).toBe(1);
  });

  it("فشلٌ لا يستهلك الرمز: إعادة المحاولة بنفسه تنجح بعده", async () => {
    const good = validBlocksFactory();
    let call = 0;
    const blocks = vi.fn(async function* () {
      call += 1;
      if (call === 1) {
        yield new Uint8Array(10);
        throw new Error("transient volume hiccup");
      }
      yield* good.blocks();
    });
    const first = await runProductionBackupOnce(baseDeps({ blocks }));
    expect(first.kind).toBe("failed");
    const second = await runProductionBackupOnce(baseDeps({ blocks }));
    expect(second.kind).toBe("completed");
    expect(await listBackupFiles().then((files) => files.length)).toBe(1);
  });

  it("اكتمالٌ برمزٍ آخر (تدوير الرمز بعد التفعيل) ⇒ conflict بلا نسخة ثانية", async () => {
    await runProductionBackupOnce(baseDeps());
    // المالك دوّر الرمز بعد الاكتمال: الرمز الجديد صحيح في تكوين اليوم،
    // لكن حالة اللمرة تحمل بصمة رمزٍ قديم — لا نسخة ثانية مهما كان الرمز.
    const outcome = await runProductionBackupOnce(baseDeps({
      providedToken: "rotated-token-b",
      expectedToken: "rotated-token-b",
    }));
    expect(outcome.kind).toBe("conflict");
    expect((await listBackupFiles()).length).toBe(1);
  });
});

describe("الاستجابة والإثبات — بلا مسارات مطلقة ولا أسرار", () => {
  afterEach(async () => {
    for (const name of await listBackupFiles()) {
      await rm(path.join(resolveBackupDirectory(volume), name), { force: true });
    }
    await rm(backupOnceDir(resolveBackupDirectory(volume)), { recursive: true, force: true }).catch(() => {});
    await rm(backupStateDir(resolveBackupDirectory(volume)), { recursive: true, force: true }).catch(() => {});
  });

  it("الإثبات لا يحمل مسار temp ولا مسار المستندات ولا الرمز ولا رابط قاعدة", async () => {
    const secret = "proof-secret-token";
    const outcome = await runProductionBackupOnce(baseDeps({ providedToken: secret, expectedToken: secret }));
    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") return;
    const serialized = JSON.stringify(outcome.proof);
    expect(serialized).not.toContain(tmpdir());
    expect(serialized).not.toContain(documentsDir);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toMatch(/postgres(ql)?:\/\//i);
    expect(serialized).not.toMatch(/DATABASE_URL/i);
    expect(Object.keys(outcome.proof).sort()).toEqual(
      ["bytes", "createdAt", "databaseSha256", "documents", "filename", "ok", "sha256"]);
  });
});

describe("قفلٌ قائم عبر العمليات", () => {
  afterEach(async () => {
    await rm(backupStateDir(resolveBackupDirectory(volume)), { recursive: true, force: true }).catch(() => {});
    for (const name of await listBackupFiles()) {
      await rm(path.join(resolveBackupDirectory(volume), name), { force: true });
    }
    await rm(backupOnceDir(resolveBackupDirectory(volume)), { recursive: true, force: true }).catch(() => {});
  });

  it("قفل حيّ (عملية أخرى تشغّل) ⇒ conflict، وعجوزٌ يتجاوز الحد ⇒ يُستبدل", async () => {
    const { acquireBackupLock, releaseBackupLock } = await import("../lib/backupVolume");
    const stateDir = backupStateDir(resolveBackupDirectory(volume));
    await mkdir(stateDir, { recursive: true });
    const held = await acquireBackupLock(stateDir, "backup.lock");
    expect(held).not.toBe("in-progress");
    const outcome = await runProductionBackupOnce(baseDeps());
    expect(outcome.kind).toBe("conflict");
    if (outcome.kind === "conflict") {
      expect(outcome.message).toContain("قيد التشغيل");
    }
    await releaseBackupLock(held === "in-progress" ? null : held);

    // قفل عجوز: قديم أكثر من ساعتين ⇒ بقايا عملية ماتت، تُستبدل وتُكمل النسخة.
    const { acquireBackupLock: reacquire } = await import("../lib/backupVolume");
    const stale = await reacquire(stateDir, "backup.lock");
    expect(stale).not.toBe("in-progress");
    const { utimes } = await import("node:fs/promises");
    const lockPath = path.join(stateDir, "backup.lock");
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await utimes(lockPath, old, old);
    const after = await runProductionBackupOnce(baseDeps());
    expect(after.kind).toBe("completed");
  });
});
