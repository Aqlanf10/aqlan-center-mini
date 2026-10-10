import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Pinned 055c399a contract: this UX candidate cannot rewrite core mutation/read authority.
const baseline = [
  {
    "label": "load",
    "start": "  const load = useCallback(",
    "end": "  useEffect(() => { void load(); }",
    "sha": "9c4c1d6146498314955b8bb563c79f54e5fec255f98c8f2386d9407de6fa93d8"
  },
  {
    "label": "send",
    "start": "  const send = useCallback(",
    "end": "  /** التوقيع",
    "sha": "a6afc51765da78bf0631a43360ffed82c272328606f6202ef35d287b5ed0b22d"
  },
  {
    "label": "sign",
    "start": "  const sign = useCallback(",
    "end": "  /** (VISIT-2) فتح ملف",
    "sha": "ef28cfac2060d5b9e80e2e17a947a49287c3daf8c0c6efe5a6798504c45a698e"
  },
  {
    "label": "payload",
    "start": "  const payload = () => (",
    "end": "  /*\n   * «مخطَّط لليوم»",
    "sha": "e311cf68c9ceb5fb0305c20c5c07bc401ce06505dbb4515c5e84d3fa3e98afda"
  },
  {
    "label": "addPlannedItem",
    "start": "  const addPlannedItem = (",
    "end": "  /* ملاحظة جلسةٍ",
    "sha": "28ab4c344ef3a0bdb893778e4b0fe50405235e514251c0e8440d014a19905156"
  }
];
const source = readFileSync("components/ClinicalVisit.tsx", "utf8");
describe("actual visit workspace retains its authoritative contracts", () => {
  it.each(baseline)("keeps $label byte-identical to reviewed 055c399a", ({ start, end, sha }) => {
    const from = source.indexOf(start); expect(from).toBeGreaterThan(-1);
    const to = source.indexOf(end, from); expect(to).toBeGreaterThan(from);
    expect(createHash("sha256").update(source.slice(from, to)).digest("hex")).toBe(sha);
  });
  it("uses one catalog action and one worklist, preserving tooth and plan callbacks", () => {
    expect(source.match(/<QuickServicePicker/g)).toHaveLength(1);
    expect(source).not.toContain("<ServiceSelect");
    expect(source.match(/aria-label="بنود عمل الزيارة"/g)).toHaveLength(1);
    expect(source).toContain("onPick={(service) => addFreeProcedure(service as Service)}");
    expect(source).toContain("onClick={() => addPlannedItem(item)}");
    expect(source).toContain("<ToothField value={draft.toothCode}");
    expect(source).toContain("disabled={draft.planItemId !== null}");
    expect(source).toContain("disabled={busy || Boolean(signatureBlock)}");
  });
});
