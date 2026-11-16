import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DIAGNOSIS_CHOICE_GROUPS } from "../lib/diagnosis-choice-options";

const source = readFileSync("components/PatientDiagnosis.tsx", "utf8");
// Reviewed React tooling migration from main6a6bdc0. This finite byte map proves
// change isolation against the historical authority slice, NOT semantic equivalence.
// Behavioral permission/lifetime/writer tests remain separate mandatory evidence.
const LEGACY_AUTHORITY_SHA256 = "85e504adeb5112baa10aa2c629fc03c96b88eb101ec7407d0ac61aeb8b7f30ca";
const MODERN_AUTHORITY_SHA256 = "c08245e44dacbc4d04f477a190fc8a007c7b791ed3b4e0af54cc74ef28083647";
const reviewedRuntimeChanges = [
  {
    purpose: "Separate immutable render identity from mutable lifetime state",
    modern: [
      "}\n",
      "\n",
      "type Owner = { scope: readonly unknown[] };\n",
      "type OwnerRuntime = { owner: Owner; active: boolean; ready: boolean; readSequence: number; controller: AbortController | null; saving: boolean; timer: ReturnType<typeof setTimeout> | null };\n",
      "type Writer = { owner: Owner };\n",
      "type Snapshot = { owner: Owner; status: \"loading\" | \"ready\" | \"error\"; versions: DiagnosisVersionView[] };\n",
      "\n",
    ].join(""),
    legacy: [
      "}\n",
      "\n",
      "type Owner = { scope: readonly unknown[]; active: boolean; ready: boolean; readSequence: number; controller: AbortController | null; saving: boolean; timer: ReturnType<typeof setTimeout> | null };\n",
      "type Writer = { owner: Owner; active: boolean };\n",
      "type Snapshot = { owner: Owner; status: \"loading\" | \"ready\" | \"error\"; versions: DiagnosisVersionView[] };\n",
      "\n",
    ].join(""),
  },
  {
    purpose: "Move activation and read admission to effect-owned runtime refs",
    modern: [
      "  const canWrite = !readOnly && canRead && (session?.role === \"doctor\" || session?.role === \"admin\");\n",
      "  const permissionScope = JSON.stringify(session?.permissions ?? null);\n",
      "  const owner = useMemo<Owner>(() => ({ scope: [patientId, orthoCaseId, session?.username, session?.role, permissionScope, readOnly, referenceVisitId] }),\n",
      "    [patientId, orthoCaseId, session?.username, session?.role, permissionScope, readOnly, referenceVisitId]);\n",
      "  // Render snapshots keep immutable identity; effect-owned refs retire async work\n",
      "  // without mutating values already handed to React.\n",
      "  const runtimeRef = useRef<OwnerRuntime | null>(null);\n",
      "  const writerRef = useRef<Writer | null>(null);\n",
      "  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);\n",
      "  const [writer, setWriter] = useState<Writer | null>(null);\n",
      "  const [savingOwner, setSavingOwner] = useState<Owner | null>(null);\n",
      "  useLayoutEffect(() => {\n",
      "    const runtime: OwnerRuntime = { owner, active: true, ready: false, readSequence: 0, controller: null, saving: false, timer: null };\n",
      "    runtimeRef.current = runtime;\n",
      "    return () => {\n",
      "      runtime.active = false; runtime.ready = false; runtime.controller?.abort();\n",
      "      if (runtime.timer !== null) clearTimeout(runtime.timer);\n",
      "      if (runtimeRef.current === runtime) runtimeRef.current = null;\n",
      "      if (writerRef.current?.owner === owner) writerRef.current = null;\n",
      "    };\n",
      "  }, [owner]);\n",
      "\n",
      "  const load = useCallback(async () => {\n",
      "    const runtime = runtimeRef.current;\n",
      "    if (!runtime || runtime.owner !== owner || !runtime.active) return;\n",
      "    runtime.ready = false;\n",
      "    runtime.controller?.abort();\n",
      "    if (runtime.timer !== null) clearTimeout(runtime.timer);\n",
      "    const controller = new AbortController();\n",
      "    runtime.controller = controller;\n",
      "    const sequence = ++runtime.readSequence;\n",
      "    const current = () => runtime.active && !controller.signal.aborted && runtime.readSequence === sequence;\n",
      "    setSnapshot({ owner, status: \"loading\", versions: [] });\n",
      "    const timeout = setTimeout(() => {\n",
    ].join(""),
    legacy: [
      "  const canWrite = !readOnly && canRead && (session?.role === \"doctor\" || session?.role === \"admin\");\n",
      "  const permissionScope = JSON.stringify(session?.permissions ?? null);\n",
      "  const owner = useMemo<Owner>(() => ({ scope: [patientId, orthoCaseId, session?.username, session?.role, permissionScope, readOnly, referenceVisitId],\n",
      "    active: false, ready: false, readSequence: 0, controller: null, saving: false, timer: null }),\n",
      "    [patientId, orthoCaseId, session?.username, session?.role, permissionScope, readOnly, referenceVisitId]);\n",
      "  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);\n",
      "  const [writer, setWriter] = useState<Writer | null>(null);\n",
      "  const [savingOwner, setSavingOwner] = useState<Owner | null>(null);\n",
      "  useLayoutEffect(() => {\n",
      "    owner.active = true;\n",
      "    return () => {\n",
      "      owner.active = false; owner.ready = false; owner.controller?.abort();\n",
      "      if (owner.timer !== null) clearTimeout(owner.timer);\n",
      "    };\n",
      "  }, [owner]);\n",
      "\n",
      "  const load = useCallback(async () => {\n",
      "    if (!owner.active) return;\n",
      "    owner.ready = false;\n",
      "    owner.controller?.abort();\n",
      "    if (owner.timer !== null) clearTimeout(owner.timer);\n",
      "    const controller = new AbortController();\n",
      "    owner.controller = controller;\n",
      "    const sequence = ++owner.readSequence;\n",
      "    const current = () => owner.active && !controller.signal.aborted && owner.readSequence === sequence;\n",
      "    setSnapshot({ owner, status: \"loading\", versions: [] });\n",
      "    const timeout = setTimeout(() => {\n",
    ].join(""),
  },
  {
    purpose: "Keep timeout handle on runtime",
    modern: [
      "      setSnapshot({ owner, status: \"error\", versions: [] });\n",
      "    }, READ_TIMEOUT_MS);\n",
      "    runtime.timer = timeout;\n",
      "    try {\n",
      "      if (!canRead || !positiveId(patientId) || !positiveId(orthoCaseId)) throw new Error(readFailure);\n",
    ].join(""),
    legacy: [
      "      setSnapshot({ owner, status: \"error\", versions: [] });\n",
      "    }, READ_TIMEOUT_MS);\n",
      "    owner.timer = timeout;\n",
      "    try {\n",
      "      if (!canRead || !positiveId(patientId) || !positiveId(orthoCaseId)) throw new Error(readFailure);\n",
    ].join(""),
  },
  {
    purpose: "Retain read publication and timer retirement checks",
    modern: [
      "      if (!response.ok) throw new Error(readFailure);\n",
      "      const versions = decodeVersions(await response.json(), orthoCaseId);\n",
      "      if (current()) { runtime.ready = true; setSnapshot({ owner, status: \"ready\", versions }); }\n",
      "    } catch {\n",
      "      if (current()) setSnapshot({ owner, status: \"error\", versions: [] });\n",
      "    } finally {\n",
      "      clearTimeout(timeout);\n",
      "      if (runtime.timer === timeout) runtime.timer = null;\n",
      "    }\n",
      "  }, [owner, patientId, orthoCaseId, canRead]);\n",
    ].join(""),
    legacy: [
      "      if (!response.ok) throw new Error(readFailure);\n",
      "      const versions = decodeVersions(await response.json(), orthoCaseId);\n",
      "      if (current()) { owner.ready = true; setSnapshot({ owner, status: \"ready\", versions }); }\n",
      "    } catch {\n",
      "      if (current()) setSnapshot({ owner, status: \"error\", versions: [] });\n",
      "    } finally {\n",
      "      clearTimeout(timeout);\n",
      "      if (owner.timer === timeout) owner.timer = null;\n",
      "    }\n",
      "  }, [owner, patientId, orthoCaseId, canRead]);\n",
    ].join(""),
  },
  {
    purpose: "Bind writer admission to current runtime and writer token",
    modern: [
      "  const versions = ready ? snapshot.versions : [];\n",
      "  const current = versions[0];\n",
      "  const writing = writer?.owner === owner;\n",
      "  const saving = savingOwner === owner;\n",
      "\n",
      "  const save = async (content: Record<string, string>, label: string) => {\n",
      "    const runtime = runtimeRef.current;\n",
      "    if (!runtime || runtime.owner !== owner || !runtime.active || !canWrite || !runtime.ready\n",
      "      || !writer || writerRef.current !== writer || writer.owner !== owner || runtime.saving) return;\n",
      "    runtime.saving = true;\n",
      "    setSavingOwner(owner);\n",
      "    onError?.(null);\n",
    ].join(""),
    legacy: [
      "  const versions = ready ? snapshot.versions : [];\n",
      "  const current = versions[0];\n",
      "  const writing = writer?.owner === owner && writer.active;\n",
      "  const saving = savingOwner === owner;\n",
      "\n",
      "  const save = async (content: Record<string, string>, label: string) => {\n",
      "    if (!owner.active || !canWrite || !owner.ready || !writer?.active || writer.owner !== owner || owner.saving) return;\n",
      "    owner.saving = true;\n",
      "    setSavingOwner(owner);\n",
      "    onError?.(null);\n",
    ].join(""),
  },
  {
    purpose: "Retire confirmed writer by token identity",
    modern: [
      "      });\n",
      "      const payload = await response.json().catch(() => null);\n",
      "      if (!runtime.active) return;\n",
      "      if (!response.ok) { onError?.(payload?.message ?? \"تعذّر الحفظ.\"); return; }\n",
      "      if (writerRef.current !== writer) return;\n",
      "      writerRef.current = null;\n",
      "      setWriter(null);\n",
      "      // The POST has settled. A bounded refresh must not keep the write latch\n",
    ].join(""),
    legacy: [
      "      });\n",
      "      const payload = await response.json().catch(() => null);\n",
      "      if (!owner.active) return;\n",
      "      if (!response.ok) { onError?.(payload?.message ?? \"تعذّر الحفظ.\"); return; }\n",
      "      writer.active = false;\n",
      "      setWriter(null);\n",
      "      // The POST has settled. A bounded refresh must not keep the write latch\n",
    ].join(""),
  },
  {
    purpose: "Release save latch only for live runtime",
    modern: [
      "      void load();\n",
      "    } catch {\n",
      "      if (runtime.active) onError?.(\"تعذّر الاتصال بالخادم.\");\n",
      "    } finally {\n",
      "      runtime.saving = false;\n",
      "      if (runtime.active) setSavingOwner(null);\n",
      "    }\n",
      "  };\n",
    ].join(""),
    legacy: [
      "      void load();\n",
      "    } catch {\n",
      "      if (owner.active) onError?.(\"تعذّر الاتصال بالخادم.\");\n",
      "    } finally {\n",
      "      owner.saving = false;\n",
      "      if (owner.active) setSavingOwner(null);\n",
      "    }\n",
      "  };\n",
    ].join(""),
  },
  {
    purpose: "Fence manual reload with live owner",
    modern: [
      "          <div role=\"alert\" className=\"rounded-xl bg-amber-50 p-3 text-xs text-amber-900\">\n",
      "            <p>{readFailure}</p>\n",
      "            <button type=\"button\" onClick={() => { if (runtimeRef.current?.owner === owner && runtimeRef.current.active) void load(); }}\n",
      "              className=\"mt-2 min-h-11 rounded-lg px-2 font-bold underline\">إعادة تحميل التشخيص</button>\n",
      "          </div>\n",
    ].join(""),
    legacy: [
      "          <div role=\"alert\" className=\"rounded-xl bg-amber-50 p-3 text-xs text-amber-900\">\n",
      "            <p>{readFailure}</p>\n",
      "            <button type=\"button\" onClick={() => { if (owner.active) void load(); }}\n",
      "              className=\"mt-2 min-h-11 rounded-lg px-2 font-bold underline\">إعادة تحميل التشخيص</button>\n",
      "          </div>\n",
    ].join(""),
  },
  {
    purpose: "Publish fresh writer token on explicit open",
    modern: [
      "        ) : versions.map(entry)}\n",
      "        {canWrite && ready && (!writing ? (\n",
      "          <button type=\"button\" onClick={() => {\n",
      "            const runtime = runtimeRef.current;\n",
      "            if (runtime?.owner === owner && runtime.active && runtime.ready && !runtime.saving) {\n",
      "              const next = { owner }; writerRef.current = next; setWriter(next);\n",
      "            }\n",
      "          }}\n",
      "            className=\"w-full rounded-xl border border-navy-800 bg-white py-2 text-xs font-bold text-navy-800 hover:bg-navy-50 transition-colors\">\n",
      "            {current ? \"+ تحديث التشخيص (نسخة جديدة — لا يمسح القديم)\" : \"+ سجّل تشخيص هذه الحالة\"}\n",
    ].join(""),
    legacy: [
      "        ) : versions.map(entry)}\n",
      "        {canWrite && ready && (!writing ? (\n",
      "          <button type=\"button\" onClick={() => { if (owner.active && owner.ready && !owner.saving) setWriter({ owner, active: true }); }}\n",
      "            className=\"w-full rounded-xl border border-navy-800 bg-white py-2 text-xs font-bold text-navy-800 hover:bg-navy-50 transition-colors\">\n",
      "            {current ? \"+ تحديث التشخيص (نسخة جديدة — لا يمسح القديم)\" : \"+ سجّل تشخيص هذه الحالة\"}\n",
    ].join(""),
  },
  {
    purpose: "Retire exact writer token on explicit cancel",
    modern: [
      "        ) : (\n",
      "          <DiagnosisForm key={`${patientId}:${orthoCaseId}:${session?.username}:${session?.role}`} saving={saving}\n",
      "            onCancel={() => {\n",
      "              const runtime = runtimeRef.current;\n",
      "              if (runtime?.owner === owner && runtime.active && writer && writerRef.current === writer && !runtime.saving) {\n",
      "                writerRef.current = null; setWriter(null);\n",
      "              }\n",
      "            }} onSave={save} />\n",
      "        ))}\n",
      "      </div>\n",
    ].join(""),
    legacy: [
      "        ) : (\n",
      "          <DiagnosisForm key={`${patientId}:${orthoCaseId}:${session?.username}:${session?.role}`} saving={saving}\n",
      "            onCancel={() => { if (owner.active && writer && !owner.saving) { writer.active = false; setWriter(null); } }} onSave={save} />\n",
      "        ))}\n",
      "      </div>\n",
    ].join(""),
  },
] as const;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
function reconstructLegacyAuthority(value: string): string {
  let restored = value;
  for (const change of reviewedRuntimeChanges) {
    const occurrences = restored.split(change.modern).length - 1;
    if (occurrences !== 1) throw new Error(`${change.purpose}: expected exactly one reviewed snippet, got ${occurrences}`);
    restored = restored.replace(change.modern, change.legacy);
  }
  return restored;
}
function authoritySlice(): string {
  const start = source.indexOf("const READ_TIMEOUT_MS =");
  const end = source.indexOf("function DiagnosisForm(", start);
  expect(start).toBeGreaterThan(-1); expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}
describe("case diagnosis choice boundaries", () => {
  it("isolates the reviewed immutable-owner migration while preserving the main1878 authority baseline", () => {
    const current = authoritySlice();
    expect(reviewedRuntimeChanges).toHaveLength(10);
    expect(sha256(current)).toBe(MODERN_AUTHORITY_SHA256);
    expect(sha256(reconstructLegacyAuthority(current))).toBe(LEGACY_AUTHORITY_SHA256);
  });
  it.each(["absent", "duplicated"])("rejects a reviewed runtime snippet that is %s", (mutation) => {
    const current = authoritySlice(), snippet = reviewedRuntimeChanges[0].modern;
    const altered = current.replace(snippet, mutation === "absent" ? "" : snippet + snippet);
    expect(sha256(altered)).not.toBe(MODERN_AUTHORITY_SHA256);
    expect(() => reconstructLegacyAuthority(altered)).toThrow("expected exactly one reviewed snippet");
  });
  it("rejects a permission-token mutation outside the reviewed changes at both hash boundaries", () => {
    const token = '["admin", "doctor", "reception", "assistant"].includes(session.role)';
    const current = authoritySlice();
    expect(current.split(token)).toHaveLength(2);
    const altered = current.replace(token, '["admin", "doctor", "reception", "assistant", "cashier"].includes(session.role)');
    expect(sha256(altered)).not.toBe(MODERN_AUTHORITY_SHA256);
    expect(sha256(reconstructLegacyAuthority(altered))).not.toBe(LEGACY_AUTHORITY_SHA256);
  });
  it("retains the existing blank partial revision and exact six-key versioned submission", () => {
    const form = source.slice(source.indexOf("function DiagnosisForm("));
    expect(form.match(/useState\(""\)/g)).toHaveLength(7);
    expect(form).toContain("onSave({ skeletal, dental, crowding, overjet, bite, note }, label)");
    expect(form).not.toContain("current.content");
    expect(form.match(/<DiagnosisChoiceField/g)).toHaveLength(4);
    expect(form).toContain('aria-label="البعد الأفقي"');
    expect(form).toContain("Overjet — البعد الأفقي (مم)");
  });
  it("has only explicit descriptive string choices, no numeric Overjet preset or normal default", () => {
    expect(Object.keys(DIAGNOSIS_CHOICE_GROUPS).sort()).toEqual(["bite", "crowding", "dental", "skeletal"]);
    for (const groups of Object.values(DIAGNOSIS_CHOICE_GROUPS)) {
      const values = groups.flatMap(group => group.options.map(option => option.value));
      expect(new Set(values).size).toBe(values.length);
      expect(values.every(value => value.trim() === value && value.length > 0 && value.length <= 200)).toBe(true);
      expect(values.some(value => /طبيعي|سليم|normal|healthy/i.test(value))).toBe(false);
    }
  });
});
