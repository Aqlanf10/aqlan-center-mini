/** Read evidence only. No eligibility, prices, receipts, balances or mutation commands. */
export type VisitSource = {
  kind: "invoice" | "historical_agreement" | "approved_agreement" | "installment_plan";
  id: number;
  state: "current" | "historical" | "review";
  path: string;
};
export type VisitFinancialWork = {
  key: string;
  kind: "procedure" | "plan_item" | "orthodontic_adjustment" | "endodontic_record";
  id: number;
  references: VisitSource[];
  coverage: "verified" | "unresolved";
  decision: "no_charge" | "billed" | "none";
  recordedClassification?: string;
  reasons: string[];
};
export type VisitFinancialContext = {
  visitId: number;
  patientId: number | null;
  signed: boolean;
  directReference: VisitSource | null;
  directReferenceState: "missing" | "current" | "historical" | "review";
  work: VisitFinancialWork[];
  summary: "verified" | "no_new_charge" | "mixed" | "unresolved" | "no_recorded_work";
};
export function projectVisitFinancialContext(input: Omit<VisitFinancialContext, "summary">): VisitFinancialContext {
  const seen = new Set<string>();
  const work = input.work.map(line => {
    if (seen.has(line.key)) throw new Error("Duplicate visit work identity");
    seen.add(line.key);
    return { ...line, reasons: [...new Set(line.reasons)], references: line.references.filter((source, index, all) =>
      all.findIndex(other => other.kind === source.kind && other.id === source.id && other.path === source.path) === index) };
  });
  const states = new Set(work.map(line => line.reasons.length ? "unresolved" : line.coverage === "verified" ? "verified"
    : line.decision === "no_charge" ? "no_new_charge" : "unresolved"));
  const summary = !work.length ? "no_recorded_work" : states.size > 1 ? "mixed" : [...states][0] as VisitFinancialContext["summary"];
  return { ...input, work, summary };
}
/** An explicit allowlist, not object spreading. Clinical roles receive no financial source identifiers or links. */
export function redactVisitFinancialContext(context: VisitFinancialContext, financial: boolean): VisitFinancialContext {
  return { visitId: context.visitId, patientId: context.patientId, signed: context.signed, summary: context.summary, directReferenceState: context.directReferenceState,
    directReference: financial && context.directReference ? { ...context.directReference } : null,
    work: context.work.map(line => ({ key: line.key, id: line.id, kind: line.kind, coverage: line.coverage,
      decision: line.decision, reasons: [...line.reasons],
      ...(line.recordedClassification ? { recordedClassification: line.recordedClassification } : {}),
      references: financial ? line.references.map(source => ({ kind: source.kind, id: source.id, state: source.state, path: source.path })) : [] })) };
}
export const VISIT_SOURCE_SUMMARY: Record<VisitFinancialContext["summary"], string> = {
  verified: "مصادر تغطية مثبتة للعمل المسجل",
  no_new_charge: "قرار بلا رسوم مثبت للعمل المسجل",
  mixed: "عمل بمصادر أو قرارات مختلفة — راجع التفاصيل",
  unresolved: "مصادر العمل تحتاج مراجعة",
  no_recorded_work: "لا عمل مهيكل يثبت مصدرًا ماليًا",
};
