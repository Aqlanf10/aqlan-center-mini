import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Frozen synthetic vectors from .validation-fx/v1-golden-vectors.json. Keep
// literals here so CI does not depend on a local validation artifact or recreate
// the production serializer to manufacture its own expected values.
const GOLDENS = [
  {
    name: "invoice_raw",
    serialized: '{"v":1,"actor":"fx-contract-test","patientId":17,"invoiceId":23,"kind":"payment","amountMinor":81,"currency":"SAR","baseCurrency":"YER","exchangeRate":140.1234567,"method":"cash","reversalOfId":null}',
    sha256: "9450947cbd6dd92f87f3f143490754663b3946ba7adfe25bfe89315a3089f6d2",
  },
  {
    name: "invoice_stored_rate",
    serialized: '{"v":1,"actor":"fx-contract-test","patientId":17,"invoiceId":23,"kind":"payment","amountMinor":81,"currency":"SAR","baseCurrency":"YER","exchangeRate":140.123457,"method":"cash","reversalOfId":null}',
    sha256: "3a00bc68a5e19ae278484373e5870c9267b5fc27dcac0464f1b04d462a15b67c",
  },
  {
    name: "plan_only",
    serialized: '{"v":1,"actor":"fx-contract-test","patientId":17,"invoiceId":null,"kind":"payment","amountMinor":81,"currency":"SAR","baseCurrency":"YER","exchangeRate":140.1234567,"method":"cash","reversalOfId":null,"planId":31}',
    sha256: "e22c4c37a841ae7de65df93081c20a996e3c0e91b7b08c73450afbb5b60ccede",
  },
  {
    name: "opening",
    serialized: '{"v":1,"actor":"fx-contract-test","patientId":17,"invoiceId":null,"kind":"payment","amountMinor":81,"currency":"SAR","baseCurrency":"YER","exchangeRate":140.1234567,"method":"cash","reversalOfId":null,"openingCurrency":"YER"}',
    sha256: "3ed14a770ee0c40509dfb17712bc450ddd535eb24570c0a777ce3a5496f660a8",
  },
  {
    name: "yer_on_account",
    serialized: '{"v":1,"actor":"fx-contract-test","patientId":17,"invoiceId":null,"kind":"payment","amountMinor":81,"currency":"YER","baseCurrency":"YER","exchangeRate":1,"method":"cash","reversalOfId":null}',
    sha256: "82c27fa280ef9fc70c20afc3d7ee8ce855f4f9a9a36c5537750408a4355dba61",
  },
  {
    name: "inherited_refund",
    serialized: '{"v":1,"actor":"fx-contract-test","patientId":17,"invoiceId":23,"kind":"refund","amountMinor":81,"currency":"SAR","baseCurrency":"YER","exchangeRate":140.123457,"method":"cash","reversalOfId":41}',
    sha256: "bac1f7a16a1275f14c99bf687b063fddec3ef1789244ad612404df6916105005",
  },
] as const;

type LiteralIdentity = {
  actor: string;
  patientId: number;
  invoiceId: number | null;
  kind: "payment" | "refund";
  amountMinor: number;
  currency: string;
  baseCurrency: string;
  exchangeRate: number;
  method: string;
  reversalOfId: number | null;
  planId?: number;
  openingCurrency?: string;
};

// Execute only the actual private function, not db.ts bootstrap or a copied
// implementation. AST extraction survives surrounding implementation changes.
const source = ts.createSourceFile(
  "lib/db.ts",
  readFileSync(new URL("../lib/db.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const declarations = source.statements.filter((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === "idempotencyRequestHash");
if (declarations.length !== 1 || !declarations[0].body) {
  throw new Error("Expected exactly one real idempotencyRequestHash implementation");
}
const compiled = ts.transpileModule(declarations[0].getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  reportDiagnostics: true,
});
const errors = compiled.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error) ?? [];
if (errors.length) {
  throw new Error(errors.map(item => ts.flattenDiagnosticMessageText(item.messageText, "\n")).join("\n"));
}
const actualHash = new Script(`${compiled.outputText}\nidempotencyRequestHash(...args);`, {
  filename: "isolated-payment-v1-fingerprint.js",
});

function invokeActual(
  literal: string,
  options: { note?: string | null; idempotencyKey?: string | null; omitOpeningArgument?: boolean } = {},
) {
  // Decode fixture values into the real function's arguments. This does not
  // serialize a replacement request object or calculate an expected digest.
  const identity = JSON.parse(literal) as LiteralIdentity;
  const args: unknown[] = [
    {
      patientId: identity.patientId,
      kind: identity.kind,
      amountMinor: identity.amountMinor,
      currency: identity.currency,
      method: identity.method,
      note: options.note ?? null,
      createdBy: identity.actor,
    },
    {
      idempotencyKey: options.idempotencyKey ?? null,
      reversalOfId: identity.reversalOfId,
    },
    identity.invoiceId,
    identity.planId ?? null,
    identity.exchangeRate,
    identity.baseCurrency,
  ];
  if (!options.omitOpeningArgument) args.push(identity.openingCurrency ?? null);
  const serialized: Array<string | undefined> = [];
  const digest: unknown = actualHash.runInNewContext({
    args,
    createHash,
    JSON: {
      stringify(value: unknown) {
        const bytes = JSON.stringify(value);
        serialized.push(bytes);
        return bytes;
      },
    },
  }, { timeout: 1_000 });
  return { digest, serialized };
}

describe("actual generic payment v1 fingerprint frozen bytes", () => {
  it.each(GOLDENS)("preserves $name literal serialization and SHA-256", vector => {
    const actual = invokeActual(vector.serialized);
    expect(actual.serialized).toEqual([vector.serialized]);
    expect(actual.digest).toBe(vector.sha256);
    // Also validate the archived literal digest independently of the function.
    expect(createHash("sha256").update(vector.serialized, "utf8").digest("hex")).toBe(vector.sha256);
  });

  it.each(GOLDENS)("keeps note and transport key outside $name identity", vector => {
    const actual = invokeActual(vector.serialized, {
      note: "Changed synthetic note must not alter legacy identity.",
      idempotencyKey: "different-transport-key",
    });
    expect(actual.serialized).toEqual([vector.serialized]);
    expect(actual.digest).toBe(vector.sha256);
  });

  it("preserves the default omitted opening-target argument", () => {
    const vector = GOLDENS[0];
    const actual = invokeActual(vector.serialized, { omitOpeningArgument: true });
    expect(actual.serialized).toEqual([vector.serialized]);
    expect(actual.digest).toBe(vector.sha256);
  });
});
