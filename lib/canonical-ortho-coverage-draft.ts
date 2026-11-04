import type { CoverageEditorRead } from "./canonical-ortho-coverage-editor-projection";

type Values = { selected: string; decision: "" | "included" | "excluded"; reason: string };
const empty = (): Values => ({ selected: "", decision: "", reason: "" });
/** Unsent values belong to one patient/session view, never browser storage.
 * Refresh keeps those values, but only a fresh matching source may restore a
 * choice. Confirmation is deliberately not retained. Submitted commands remain
 * owned by the existing durable financial journal, not by this draft. */
export function makeCanonicalCoverageDraft(admission: { authorized: () => boolean; deny: () => void }) {
 let alive = true, values = empty(), fingerprint: string | null = null, revision: string | null = null;
 const active = () => alive && admission.authorized();
 const clear = () => { values = empty(); fingerprint = null; revision = null; };
 const dirty = () => !!(values.selected || values.decision || values.reason);
 return {
  remember(next: Values, context: CoverageEditorRead | null) {
   if (!active() || !context) return;
   const source = context.sources.find(s => `${s.invoiceId}:${s.planItemId}` === next.selected);
   values = { ...next }; fingerprint = source?.fingerprint ?? null; revision = context.current?.id ?? null;
  },
  restore(context: CoverageEditorRead): Values {
   if (!active()) return empty();
   const source = context.sources.find(s => `${s.invoiceId}:${s.planItemId}` === values.selected);
   if (!context.canEdit || !source || source.fingerprint !== fingerprint || (context.current?.id ?? null) !== revision) {
    values = { selected: "", decision: "", reason: values.reason }; fingerprint = null;
   }
   return { ...values };
  },
  clear,
  // No response/source cache is retained; the mounted editor owns and revokes
  // its network leases. This method matches the existing parent draft registry.
  invalidateRead() {},
  canLeave: (confirm: () => boolean) => !alive || !dirty() || confirm(),
  needsUnloadWarning: () => alive && dirty(),
  retire() { alive = false; clear(); },
  deny() { alive = false; clear(); admission.deny(); },
 };
}
export type CanonicalCoverageDraft = ReturnType<typeof makeCanonicalCoverageDraft>;
