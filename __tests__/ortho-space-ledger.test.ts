import { describe, expect, it } from "vitest";
import { newSpacePlan, readSpaceCommand, readSpaceContent, projectIpr, spaceBudget, iprReviewNeeded, mmToUm, type SpacePlan, type SpaceEvent } from "../lib/ortho-space-ledger";
const plan = (): SpacePlan => ({ kind: "plan", arch: "upper", strategyRevisionId: 1,
  baseline: { kind: "assessment_analysis", id: 1, member: "upper", version: `sha256:${"a".repeat(64)}` },
  gains: [], uses: [], contacts: [{ teeth: [11, 12], plannedUm: 300, budgetGainUm: 300, clinicianLimitUm: null, note: "Synthetic clinician verified contact" }], rationale: "Synthetic plan", alternatives: "Synthetic alternative" });
const event = (id: number, amount: number | null, adjustmentId: number, supersedesEntryId: number | null = null): SpaceEvent => ({ id, version: id, content: { kind: "ipr", arch: "upper", planEntryId: 1, teeth: [11, 12], adjustmentId, performedUm: amount, supersedesEntryId, measurementNote: "Synthetic measurement", reviewReason: null } });
const root = (): SpaceEvent => ({ id: 1, version: 1, content: plan() });
describe("space and IPR documentary arithmetic", () => {
  it("canonicalizes contacts, including reversed input, and refuses two rows for the same contact", () => {
    const p = plan(); p.contacts[0].teeth.reverse(); expect(readSpaceContent(p)).toMatchObject({ ok: true, value: { contacts: [{ teeth: [11, 12] }] } });
    p.contacts.push({ ...p.contacts[0], teeth: [11, 12] }); expect(readSpaceContent(p)).toMatchObject({ ok: false, code: "space_duplicate_contact" });
  });
  it.each([[11, 11], [11, 31], [11, 19], [11, 51]])("refuses invalid permanent contact %j", (a, b) => {
    const p = plan(); p.contacts[0].teeth = [a, b]; expect(readSpaceContent(p).ok).toBe(false);
  });
  it("retains an explicitly named nonadjacent FDI contact without guessing adjacency after extraction", () => { const p = plan(); p.contacts[0].teeth = [11, 14]; expect(readSpaceContent(p).ok).toBe(true); });
  it("counts two visits exactly once and corrections replace a fact instead of adding enamel again", () => {
    const result = projectIpr([event(4, 150, 1, 2), event(3, 200, 2), root(), event(2, 100, 1)]);
    expect(result).toMatchObject({ ok: true, value: { totals: [{ performedUm: 350 }] } });
    if (result.ok) expect(result.value.current.map(e => e.id)).toEqual([3, 4]);
  });
  it("rejects a second event for the same session/contact and competing corrections", () => {
    expect(projectIpr([root(), event(2, 100, 1), event(3, 200, 1)])).toMatchObject({ ok: false, code: "ipr_duplicate_session_contact" });
    expect(projectIpr([root(), event(2, 100, 1), event(3, 200, 1, 2), event(4, 50, 1, 2)])).toMatchObject({ ok: false, code: "ipr_correction_identity" });
  });
  it("does not allow a correction to move the fact to another actual session", () => { expect(projectIpr([root(), event(2, 100, 1), event(3, 200, 2, 2)]).ok).toBe(false); });
  it("unknown performance leaves cumulative amount unknown", () => { expect(projectIpr([root(), event(2, null, 1), event(3, 100, 2)])).toMatchObject({ ok: true, value: { totals: [{ performedUm: null }] } }); });
  it("requires review for an unknown or exceeded plan or clinician-selected limit without supplying a universal one", () => {
    expect(iprReviewNeeded(plan().contacts[0], 301)).toEqual(["planned_exceeded"]);
    expect(iprReviewNeeded({ ...plan().contacts[0], clinicianLimitUm: 200 }, 250)).toEqual(["planned_exceeds_clinician_limit", "clinician_limit_exceeded"]);
    expect(iprReviewNeeded({ ...plan().contacts[0], plannedUm: null }, null)).toEqual(["cumulative_unknown", "planned_unknown"]);
  });
  it("does not round baseline inputs or add a manual IPR gain on top of contact gains", () => {
    const p = plan(); p.gains.push({ key: "exp", method: "expansion", label: "Synthetic estimate", estimateUm: 500, overlapGroup: "anterior", included: true, rationale: "Clinician estimate" }); p.uses.push({ key: "use", label: "Synthetic use", amountUm: 200 });
    expect(spaceBudget(p, -1.23456789)).toEqual({ baselineDiscrepancyMm: -1.23456789, iprUm: 300, gainsUm: 800, usesUm: 200, estimatedBalanceMm: -1.23456789 + .6 });
    p.gains[0].method = "ipr" as never; expect(readSpaceContent(p).ok).toBe(false);
  });
  it("refuses two included estimates from one overlapping group; excluded alternatives are not added", () => {
    const p = plan(); const g = { key: "a", method: "expansion" as const, label: "Synthetic", estimateUm: 100, overlapGroup: "same", included: true, rationale: "Synthetic" };
    p.gains = [g, { ...g, key: "b" }]; expect(readSpaceContent(p)).toMatchObject({ ok: false, code: "space_overlap" });
    p.gains[1].overlapGroup = "  SAME  "; expect(readSpaceContent(p)).toMatchObject({ ok: false, code: "space_overlap" });
    p.gains[1].included = false; expect(readSpaceContent(p).ok).toBe(true); expect(spaceBudget(p, -1).gainsUm).toBe(400);
  });
  it("propagates missing estimates, while an explicit zero remains zero", () => { const p = plan(); p.contacts[0].plannedUm = null; p.contacts[0].budgetGainUm = null; expect(spaceBudget(p, -2).estimatedBalanceMm).toBeNull(); p.contacts[0].plannedUm = 0; p.contacts[0].budgetGainUm = 0; expect(spaceBudget(p, -2).estimatedBalanceMm).toBe(-2); });
  it.each([["0.1", 100], ["0.2", 200], ["0.001", 1], ["", null], ["0", 0], ["0.0001", undefined], ["-1", undefined], ["1e3", undefined], ["NaN", undefined]])("parses entered mm %s without floating point accumulation", (raw, expected) => expect(mmToUm(raw)).toBe(expected));
});
it("does not count IPR already included in the selected measurement as a new gain", () => {
  const p = plan(); p.contacts[0].plannedUm = 500; p.contacts[0].budgetGainUm = 200;
  expect(spaceBudget(p, -1).iprUm).toBe(200);
  expect(p.contacts[0].plannedUm).toBe(500);
  p.contacts[0].budgetGainUm = null; expect(spaceBudget(p, -1).estimatedBalanceMm).toBeNull();
  p.contacts[0].budgetGainUm = 501; expect(readSpaceContent(p)).toMatchObject({ ok: false, code: "ipr_budget_exceeds_plan" });
});

it("clears incremental estimates when the measurement or strategy changes, preserving the recorded contact plan", () => {
  const old = plan(); old.gains = [{ key: "gain", method: "other", label: "Synthetic", estimateUm: 200, overlapGroup: "new", included: true, rationale: "Synthetic" }]; old.uses = [{ key: "use", label: "Synthetic", amountUm: 50 }];
  const original = JSON.stringify(old);
  for (const [strategy, baseline] of [[old.strategyRevisionId + 1, old.baseline], [old.strategyRevisionId, { ...old.baseline, id: old.baseline.id + 1 }]] as const) {
    const next = newSpacePlan(old.arch, strategy, baseline, old);
    expect(next.contacts[0]).toEqual({ ...old.contacts[0], budgetGainUm: null });
    expect(next.gains[0].estimateUm).toBeNull(); expect(next.uses[0].amountUm).toBeNull();
    expect(spaceBudget(next, -1).estimatedBalanceMm).toBeNull();
  }
  const same = newSpacePlan(old.arch, old.strategyRevisionId, old.baseline, old);
  expect(same.contacts).toEqual(old.contacts); expect(same.gains).toEqual(old.gains); expect(same.uses).toEqual(old.uses);
  same.contacts[0].teeth[0] = 18; expect(JSON.stringify(old)).toBe(original);
});
it("rejects malformed event content rather than treating its amount as clinical arithmetic", () => {
  const malformed = event(2, -50, 1);
  expect(projectIpr([root(), malformed])).toMatchObject({ok:false});
  malformed.content = {...malformed.content, kind:"unknown"} as never;
  expect(projectIpr([root(), malformed])).toMatchObject({ok:false});
});
it("rejects missing history versions instead of presenting incomplete totals", () => {
  expect(projectIpr([root(),event(3,100,1)])).toMatchObject({ok:false,code:"space_event_sequence"});
});
it("returns detached canonical events so caller mutation cannot rewrite history", () => {
  const events=[root(),event(2,100,1)],before=JSON.stringify(events),result=projectIpr(events);
  if(!result.ok)throw Error(result.code);
  result.value.current[0].content.teeth[0]=18;
  expect(JSON.stringify(events)).toBe(before);
});
it("does not accept sparse contact arrays as an empty known budget", () => {
  const p=plan();p.contacts=Array(1) as SpacePlan["contacts"];
  expect(readSpaceContent(p)).toMatchObject({ok:false});
});
it("warns before performance when the proposed plan exceeds the clinician's entered limit",()=>{
 expect(iprReviewNeeded({...plan().contacts[0],clinicianLimitUm:200},0)).toEqual(["planned_exceeds_clinician_limit"]);
});
it.each([-1,NaN,Infinity,0.5,Number.MAX_SAFE_INTEGER+1])("rejects invalid recorded cumulative quantity %s",amount=>{
 expect(()=>iprReviewNeeded(plan().contacts[0],amount)).toThrow("space_amount");
});
it("preserves explicit unknown through several correction chains without mutating history",()=>{
 const events=[root(),event(2,100,1),event(3,null,1,2),event(4,200,2),event(5,125,1,3)];
 const before=JSON.stringify(events),a=projectIpr(events.slice(0,4)),b=projectIpr(events);
 expect(a).toMatchObject({ok:true,value:{totals:[{performedUm:null}]}});
 expect(b).toMatchObject({ok:true,value:{totals:[{performedUm:325}]}});expect(JSON.stringify(events)).toBe(before);
});
it("does not duplicate the same contact/session through a later plan revision",()=>{
 const later={id:3,version:3,content:{...plan(),strategyRevisionId:2}};
 const repeated=event(4,200,1);if(repeated.content.kind==='ipr')repeated.content.planEntryId=3;
 expect(projectIpr([root(),event(2,100,1),later,repeated])).toMatchObject({ok:false,code:"ipr_duplicate_session_contact"});
});
it("keeps excluded unknown alternatives outside the budget but included unknowns unquantified",()=>{
 const p=plan();p.gains=[{key:"alternative",method:"other",label:"Synthetic",estimateUm:null,overlapGroup:"alternative",included:false,rationale:"Not selected"}];
 expect(spaceBudget(p,-2).estimatedBalanceMm).toBe(-1.7);p.gains[0].included=true;expect(spaceBudget(p,-2).estimatedBalanceMm).toBeNull();
});
it("keeps independent integer totals exact for many sessions and both input orders",()=>{
 const events=[root(),...Array.from({length:100},(_,i)=>event(i+2,(i+1)*3,i+1))];
 // Sum 3*(1+...+100), evaluated independently as an integer closed-form oracle.
 for(const order of [events,[...events].reverse()])expect(projectIpr(order)).toMatchObject({ok:true,value:{totals:[{performedUm:15150}]}});
});
it("parses bounded exact commands and rejects unknown payload fields",()=>{
 const command={schemaVersion:1,clientRequestId:"synthetic_command_0001",expectedHeadId:null,reason:"Synthetic review",content:plan()};
 expect(readSpaceCommand(command)).toMatchObject({ok:true});expect(readSpaceCommand({...command,automaticApproval:true})).toMatchObject({ok:false});
 expect(readSpaceCommand({...command,expectedHeadId:0})).toMatchObject({ok:false});
});
it("rejects excessive history before attempting clinical projection",()=>{
 expect(projectIpr(Array(1001).fill(root()))).toMatchObject({ok:false,code:"space_history_budget"});
});
it("rejects a correction retargeted to a different contact",()=>{
 const p=root();if(p.content.kind==='plan')p.content.contacts.push({...p.content.contacts[0],teeth:[12,13]});
 const correction=event(3,50,1,2);if(correction.content.kind==='ipr')correction.content.teeth=[12,13];
 expect(projectIpr([p,event(2,100,1),correction])).toMatchObject({ok:false,code:"ipr_correction_identity"});
});
it.each([0,1])("rejects a two-tooth tuple with missing own index %s",missing=>{
 const p=plan(),teeth=[11,12];delete teeth[missing];p.contacts[0].teeth=teeth as [number,number];
 expect(readSpaceContent(p)).toMatchObject({ok:false,code:"space_contact"});
});
it.each([0,1])("rejects incomplete performed contact tuple at position %s",missing=>{
 const e=event(2,100,1);if(e.content.kind!=="ipr")throw Error("fixture");const teeth=[11,12];delete teeth[missing];e.content.teeth=teeth as [number,number];
 expect(readSpaceContent(e.content)).toMatchObject({ok:false,code:"space_contact"});
});
it("detaches the parsed baseline reference from subsequent draft mutation",()=>{
 const p=plan(),parsed=readSpaceContent(p);if(!parsed.ok||parsed.value.kind!=="plan")throw Error("fixture");
 p.baseline.id=99;expect(parsed.value.baseline.id).toBe(1);
});
