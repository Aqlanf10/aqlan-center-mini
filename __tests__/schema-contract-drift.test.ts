import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import committedContractJson from "../schema/current-schema-contract.pg18.json";
import {
  COMPARED_STRUCTURAL_FIELDS,
  IGNORED_PROVENANCE_FIELDS,
  SCHEMA_CONTRACT_DRIFT_MARKER,
  canonicalizeStructuralContract,
  loadSchemaContractFile,
  provenanceMajorProblems,
  serverMajorFromContractVersion,
  structuralDiffs,
} from "../scripts/verify-schema-contract-drift";
import type { SchemaContract } from "../scripts/schema-introspect";

/**
 * مصفوفة بوابة انحراف عقد المخطط (schema:contract:verify) — فحوصٌ تنفيذية.
 *
 * ليست هذه فحوص verify:schema (المجموعة الجزئية: العقد ⊆ الواقع): هنا
 * المقارنة البنيوية الحتمية بين الملتزم والطازج — كل فرقٍ مقصود يُمسَك
 * (SCHEMA_CONTRACT_DRIFT) ومصدر minor للخادم (18.4 مقابل 18.6) لا يُمسَك
 * وحده. الترتيب الهيكلي في CI/البوابة الكاملة يُفحَص في
 * environment-parity.test.ts؛ هنا دلالة المقارنة نفسها + exit codes حيّة.
 */

const realContract = committedContractJson as unknown as SchemaContract;
const repoRoot = join(__dirname, "..");

let workDir: string;
beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "schema-contract-drift-"));
});
afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** عقدٌ اصطناعي صغير لكنه يغطي كل أنواع البنية: أعمدة/مفتاح/فرادة/فحص/إشارة/فهرس/مُشغِّل. */
function fixtureContract(serverVersion = "18.4"): SchemaContract {
  return {
    format: "aqlan-current-schema-contract",
    formatVersion: 1,
    generatedBy: "ensureSchema()",
    generatedOnServerVersion: serverVersion,
    counts: { tables: 2, columns: 5, constraints: 4, indexes: 2, triggers: 1 },
    tables: {
      invoices: {
        columns: {
          id: { type: "int4", nullable: false },
          amount_minor: { type: "int8", nullable: false },
          note: { type: "text", nullable: true },
        },
        primaryKey: ["id"],
        unique: [["amount_minor"]],
        checks: ["invoices_amount_minor_check"],
        foreignKeys: [],
        indexes: { invoices_pkey: { columns: ["id"], unique: true } },
        triggers: {},
      },
      payments: {
        columns: {
          id: { type: "int4", nullable: false },
          invoice_id: { type: "int4", nullable: false },
        },
        primaryKey: ["id"],
        unique: [],
        checks: [],
        foreignKeys: [{ columns: ["invoice_id"], refTable: "invoices", refColumns: ["id"] }],
        indexes: { payments_invoice_id_idx: { columns: ["invoice_id"], unique: false } },
        triggers: { payments_write_audit: { timing: "AFTER", events: ["INSERT", "UPDATE"] } },
      },
    },
  };
}

function mutated(contract: SchemaContract, mutate: (draft: SchemaContract) => void): SchemaContract {
  const draft = structuredClone(contract);
  mutate(draft);
  return draft;
}

/** يعيد بناء القيمة بعكس ترتيب مفاتيح كل كائن — البنية واحدة والمظهر مختلف. */
function reverseKeyOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeyOrder);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const reversed: Record<string, unknown> = {};
    for (const key of Object.keys(source).reverse()) reversed[key] = reverseKeyOrder(source[key]);
    return reversed;
  }
  return value;
}

describe("عقد المقارنة نفسه — ما يُقارن وما يُهمل معلَنان ومفحوصان", () => {
  it("الملف الملتزم الحقيقي يحمل الحقول الستة المعروفة حصرًا (بنية + مصدر)", () => {
    const known = [...new Set([...COMPARED_STRUCTURAL_FIELDS, ...IGNORED_PROVENANCE_FIELDS])].sort();
    expect(Object.keys(realContract).sort()).toEqual(known);
  });

  it("المهمل هو المصدر وحده: generatedBy وgeneratedOnServerVersion", () => {
    expect([...IGNORED_PROVENANCE_FIELDS]).toEqual(["generatedBy", "generatedOnServerVersion"]);
    expect([...COMPARED_STRUCTURAL_FIELDS]).toEqual(["format", "formatVersion", "counts", "tables"]);
  });

  it("canonicalization يسقط المصدر ويفرز المفاتيح — لا مظهرَ في المقارنة", () => {
    const canonical = canonicalizeStructuralContract(fixtureContract());
    expect(Object.keys(canonical)).toEqual(["counts", "format", "formatVersion", "tables"]);
    expect(JSON.stringify(canonical)).not.toContain("generatedOnServerVersion");
    expect(JSON.stringify(canonical)).not.toContain("generatedBy");
  });
});

describe("مصفوفة الانحراف — الحالات الناجحة (البنية واحدة تمرّ)", () => {
  it("بنية واحدة و18.4 مقابل 18.6 ⇒ صفر فروق — مصدر minor لا يُقارن", () => {
    const fresh = fixtureContract("18.6");
    fresh.generatedBy = "ensureSchema()@rebuild";
    expect(structuralDiffs(fixtureContract("18.4"), fresh)).toEqual([]);
  });

  it("عكس ترتيب مفاتيح الملف كله ليس انحرافًا — canonical", () => {
    const reordered = reverseKeyOrder(fixtureContract("18.4")) as SchemaContract;
    expect(structuralDiffs(fixtureContract("18.4"), reordered)).toEqual([]);
  });

  it("العقد الحقيقي مقابل نفسه ⇒ صفر فروق (61 جدولًا · 742 عمودًا)", () => {
    expect(structuralDiffs(realContract, structuredClone(realContract))).toEqual([]);
  });

  it("18.4 مقابل 18.6 ⇒ لا مشاكل major؛ التفسير نفسه يمسك غير الرقمي", () => {
    expect(provenanceMajorProblems(fixtureContract("18.4"), fixtureContract("18.6"))).toEqual([]);
    expect(serverMajorFromContractVersion("18.4")).toBe(18);
    expect(serverMajorFromContractVersion("18.6")).toBe(18);
    expect(serverMajorFromContractVersion("17.2")).toBe(17);
    expect(serverMajorFromContractVersion("نثّة")).toBeNull();
  });
});

describe("مصفوفة الانحراف — كل تغيّر بنيوي مقصود يُفشِل بالمسار الدقيق", () => {
  const base = fixtureContract("18.4");
  const paths = (fresh: SchemaContract) => structuralDiffs(base, fresh).map((diff) => diff.path);

  it("جدول زائد في الطازج ⇒ tables.settlements: committed=(غائب)", () => {
    const fresh = mutated(base, (draft) => {
      draft.tables.settlements = {
        columns: { id: { type: "int4", nullable: false } },
        primaryKey: ["id"], unique: [], checks: [], foreignKeys: [], indexes: {}, triggers: {},
      };
    });
    const diffs = structuralDiffs(base, fresh);
    expect(paths(fresh)).toContain("tables.settlements");
    expect(diffs.find((diff) => diff.path === "tables.settlements")?.committed).toBe("(غائب)");
    expect(diffs.find((diff) => diff.path === "tables.settlements")?.fresh).toContain("id");
    // لا تكرار في المسارات — كل فرقٍ يُزار مرة واحدة (اتحاد المفاتيح بلا تكرار)
    expect(new Set(diffs.map((diff) => diff.path)).size).toBe(diffs.length);
  });

  it("تغيّر نوع عمود واحد ⇒ فرقٌ واحد لا مكرَّر — على العقد الحقيقي كاملًا", () => {
    const fresh = mutated(realContract, (draft) => {
      const firstTable = Object.keys(draft.tables).sort()[0] as string;
      const firstColumn = Object.keys(draft.tables[firstTable].columns).sort()[0] as string;
      draft.tables[firstTable].columns[firstColumn].type = "text";
    });
    const diffs = structuralDiffs(realContract, fresh);
    expect(diffs).toHaveLength(1);
    expect(new Set(diffs.map((diff) => diff.path)).size).toBe(diffs.length);
  });

  it("جدول ناقص من الطازج (ملتزم متقادم بالعكس) ⇒ tables.legacy: fresh=(غائب)", () => {
    const committed = mutated(base, (draft) => {
      draft.tables.legacy = {
        columns: { id: { type: "int4", nullable: false } },
        primaryKey: ["id"], unique: [], checks: [], foreignKeys: [], indexes: {}, triggers: {},
      };
    });
    const diffs = structuralDiffs(committed, base);
    expect(diffs.map((diff) => diff.path)).toContain("tables.legacy");
    expect(diffs.find((diff) => diff.path === "tables.legacy")?.fresh).toBe("(غائب)");
  });

  it("عمود زائد ⇒ tables.invoices.columns.currency", () => {
    const fresh = mutated(base, (draft) => {
      draft.tables.invoices.columns.currency = { type: "text", nullable: false };
    });
    expect(paths(fresh)).toContain("tables.invoices.columns.currency");
  });

  it("تغيّر نوع عمود ⇒ tables.invoices.columns.amount_minor.type", () => {
    const fresh = mutated(base, (draft) => {
      draft.tables.invoices.columns.amount_minor.type = "int4";
    });
    expect(paths(fresh)).toContain("tables.invoices.columns.amount_minor.type");
  });

  it("تغيّر قابلية عدم عمود ⇒ tables.invoices.columns.note.nullable", () => {
    const fresh = mutated(base, (draft) => {
      draft.tables.invoices.columns.note.nullable = false;
    });
    expect(paths(fresh)).toContain("tables.invoices.columns.note.nullable");
  });

  it("تغيّر المفتاح الأساسي ⇒ tables.invoices.primaryKey", () => {
    const fresh = mutated(base, (draft) => {
      draft.tables.invoices.primaryKey = ["id", "note"];
    });
    expect(paths(fresh).some((path) => path.startsWith("tables.invoices.primaryKey"))).toBe(true);
  });

  it("قيود الفرادة تتغيّر ⇒ tables.invoices.unique", () => {
    const fresh = mutated(base, (draft) => {
      draft.tables.invoices.unique = [["amount_minor"], ["note"]];
    });
    expect(paths(fresh).some((path) => path.startsWith("tables.invoices.unique"))).toBe(true);
  });

  it("قيد فحص يتغيّر ⇒ tables.invoices.checks", () => {
    const fresh = mutated(base, (draft) => {
      draft.tables.invoices.checks = ["invoices_other_check"];
    });
    expect(paths(fresh).some((path) => path.startsWith("tables.invoices.checks"))).toBe(true);
  });

  it("إشارة تتغيّر (refTable) ⇒ tables.payments.foreignKeys[0].refTable", () => {
    const fresh = mutated(base, (draft) => {
      draft.tables.payments.foreignKeys[0].refTable = "payment_batches";
    });
    expect(paths(fresh)).toContain("tables.payments.foreignKeys[0].refTable");
  });

  it("فهرس يتغيّر (فرادة وأعمدة) ⇒ tables.payments.indexes.payments_invoice_id_idx…", () => {
    const uniqueness = mutated(base, (draft) => {
      draft.tables.payments.indexes.payments_invoice_id_idx.unique = true;
    });
    expect(paths(uniqueness)).toContain("tables.payments.indexes.payments_invoice_id_idx.unique");
    const columns = mutated(base, (draft) => {
      draft.tables.payments.indexes.payments_invoice_id_idx.columns = ["invoice_id", "id"];
    });
    expect(paths(columns).some((path) =>
      path.startsWith("tables.payments.indexes.payments_invoice_id_idx.columns"))).toBe(true);
  });

  it("مُشغِّل يتغيّر (توقيت وأحداث) ⇒ tables.payments.triggers.payments_write_audit…", () => {
    const timing = mutated(base, (draft) => {
      draft.tables.payments.triggers.payments_write_audit.timing = "BEFORE";
    });
    expect(paths(timing)).toContain("tables.payments.triggers.payments_write_audit.timing");
    const events = mutated(base, (draft) => {
      draft.tables.payments.triggers.payments_write_audit.events = ["INSERT"];
    });
    expect(paths(events).some((path) =>
      path.startsWith("tables.payments.triggers.payments_write_audit.events"))).toBe(true);
  });

  it("عدّاد يتغيّر ⇒ counts.indexes — العدّادات بنيةٌ لا زينة", () => {
    const fresh = mutated(base, (draft) => {
      draft.counts.indexes = 3;
    });
    expect(paths(fresh)).toContain("counts.indexes");
  });

  it("صيغة العقد تتغيّر ⇒ formatVersion/format — صيغةٌ مجهولة لا تمرّ", () => {
    const versionBump = mutated(base, (draft) => {
      (draft as unknown as Record<string, unknown>).formatVersion = 2;
    });
    expect(paths(versionBump)).toContain("formatVersion");
    const otherFormat = mutated(base, (draft) => {
      (draft as unknown as Record<string, unknown>).format = "aqlan-other-contract";
    });
    expect(paths(otherFormat)).toContain("format");
  });

  it("major مختلف في المصدر ⇒ مشكلة معلَنة (لا يُدَّعى تطابق بنيةٍ عبر major)", () => {
    const problems = provenanceMajorProblems(fixtureContract("18.4"), fixtureContract("16.2"));
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toContain("16");
    const committedWrongMajor = provenanceMajorProblems(fixtureContract("17.2"), fixtureContract("18.6"));
    expect(committedWrongMajor.length).toBeGreaterThan(0);
    expect(committedWrongMajor.join("\n")).toContain("17");
  });
});

describe("قراءة العقد من ملف — تالفٌ أو غريب ⇒ فشل مغلق لا تجاهل", () => {
  it("JSON سليم يُحمَّل بصيغته المعلنة", async () => {
    const file = join(workDir, "valid-contract.json");
    writeFileSync(file, `${JSON.stringify(fixtureContract("18.6"), null, 2)}\n`, "utf8");
    const loaded = await loadSchemaContractFile(file, "اختبار");
    expect(loaded.format).toBe("aqlan-current-schema-contract");
    expect(loaded.generatedOnServerVersion).toBe("18.6");
  });

  it("JSON تالف يُرفض برسالة صريحة", async () => {
    const file = join(workDir, "malformed-contract.json");
    writeFileSync(file, "{ ليس JSON", "utf8");
    await expect(loadSchemaContractFile(file, "اختبار")).rejects.toThrow(/JSON تالف/);
  });

  it("صيغة غير مدعومة تُرفض", async () => {
    const file = join(workDir, "wrong-format.json");
    const stranger = fixtureContract() as unknown as Record<string, unknown>;
    stranger.format = "someone-else-contract";
    writeFileSync(file, JSON.stringify(stranger), "utf8");
    await expect(loadSchemaContractFile(file, "اختبار")).rejects.toThrow(/صيغة مدعومة/);
  });

  it("حقل مجهول في جذر العقد يُرفض — فشل مغلق لا تجاهل", async () => {
    const file = join(workDir, "unknown-field.json");
    const stranger = fixtureContract() as unknown as Record<string, unknown>;
    stranger.surprise = { anything: true };
    writeFileSync(file, JSON.stringify(stranger), "utf8");
    await expect(loadSchemaContractFile(file, "اختبار")).rejects.toThrow(/حقلًا غير معروف/);
  });
});

describe("بوابة CLI حيّة — exit codes على الحقيقة (عقد متقادم عمدًا يُثبت الرمز)", () => {
  function runVerifier(args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", "scripts/verify-schema-contract-drift.ts", ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 120_000,
    });
  }

  function writeContract(name: string, contract: SchemaContract): string {
    const file = join(workDir, name);
    writeFileSync(file, `${JSON.stringify(contract, null, 2)}\n`, "utf8");
    return file;
  }

  it("بنية واحدة (18.4 ملتزم مقابل 18.6 طازج) ⇒ exit 0", () => {
    const committed = writeContract("pass-committed.json", fixtureContract("18.4"));
    const fresh = writeContract("pass-fresh.json", fixtureContract("18.6"));
    const result = runVerifier(["--committed", committed, "--fresh", fresh]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("schema contract drift verify: OK");
    expect(result.stdout).toContain("مصدرٌ مختلف فقط");
  }, 120_000);

  it("الملف الملتزم الحقيقي مقابل نسخة منه (المسار الافتراضي) ⇒ exit 0", () => {
    const fresh = join(workDir, "real-copy.json");
    writeFileSync(fresh, readFileSync(join(repoRoot, "schema", "current-schema-contract.pg18.json"), "utf8"), "utf8");
    const result = runVerifier(["--fresh", fresh]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("schema contract drift verify: OK");
  }, 120_000);

  it("عقد متقادم عمدًا: ملتزم ناقص جدولًا عن الحقيقة ⇒ exit 1 + SCHEMA_CONTRACT_DRIFT", () => {
    const lastTable = Object.keys(realContract.tables).sort().at(-1) as string;
    const stale = mutated(realContract, (draft) => {
      delete draft.tables[lastTable];
    });
    const committed = writeContract("stale-committed.json", stale);
    const fresh = writeContract("stale-fresh.json", realContract);
    const result = runVerifier(["--committed", committed, "--fresh", fresh]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(SCHEMA_CONTRACT_DRIFT_MARKER);
    expect(result.stderr).toContain(`tables.${lastTable}`);
    expect(result.stderr).toContain("(غائب)");
  }, 120_000);

  it("ملتزم JSON تالف ⇒ exit 1 برسالة صريحة (لا انهيار)", () => {
    const committed = join(workDir, "committed-malformed.json");
    writeFileSync(committed, "{ هذا ليس JSON", "utf8");
    const fresh = writeContract("fresh-for-malformed.json", fixtureContract("18.6"));
    const result = runVerifier(["--committed", committed, "--fresh", fresh]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("JSON تالف");
  }, 120_000);

  it("طازج JSON تالف ⇒ exit 1", () => {
    const committed = writeContract("committed-ok.json", fixtureContract("18.4"));
    const fresh = join(workDir, "fresh-malformed.json");
    writeFileSync(fresh, "ليس JSON أصلًا", "utf8");
    const result = runVerifier(["--committed", committed, "--fresh", fresh]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("JSON تالف");
  }, 120_000);

  it("ملف طازج غائب ⇒ exit 1 (فشل مغلق)", () => {
    const committed = writeContract("committed-ok2.json", fixtureContract("18.4"));
    const result = runVerifier(["--committed", committed, "--fresh", join(workDir, "does-not-exist.json")]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("تعذّرت قراءة");
  }, 120_000);

  it("ملتزم على major غير 18 ⇒ exit 1 برمز الانحراف", () => {
    const committed = writeContract("committed-pg16.json", fixtureContract("16.9"));
    const fresh = writeContract("fresh-pg18.json", fixtureContract("18.6"));
    const result = runVerifier(["--committed", committed, "--fresh", fresh]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(SCHEMA_CONTRACT_DRIFT_MARKER);
    expect(result.stderr).toContain("major 16");
  }, 120_000);
});
