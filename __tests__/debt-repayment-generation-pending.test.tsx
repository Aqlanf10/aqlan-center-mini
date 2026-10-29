import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { DebtRepaymentEditor, readDebtRepaymentDraft, type DebtRepaymentDraft } from "../components/DebtRepaymentEditor";
import { generateMonthlyDebtSchedule } from "../lib/debt-monthly-schedule";
vi.mock("react", async importOriginal => ({ ...await importOriginal<typeof import("react")>(), useId: () => "schedule" }));
type Element = ReactElement<Record<string, unknown>>;
function nodes(tree: ReactNode): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== "object" || !("props" in tree)) return [];
  const node = tree as Element;
  return [node, ...nodes(node.props.children as ReactNode)];
}
function fixture(remainingMinor = 230000) {
  const initial = generateMonthlyDebtSchedule({ remainingMinor, downPaymentMinor: 0, downPaymentDate: "2026-10-28", monthCount: 24, firstMonthlyDate: "2026-11-28" });
  if (!initial.ok) throw new Error(initial.message);
  let draft: DebtRepaymentDraft = { mode: "installments", rows: initial.terms.installments.map((row,index) => ({ key:String(index),dueDate:row.dueDate,kind:row.kind,amount:(row.amountMinor/100).toFixed(2) })) };
  const view = () => nodes(DebtRepaymentEditor({value:draft,onChange:next=>{draft=next;},currency:"SAR",remainingMinor,today:"2026-10-28"}));
  const change = (label:string,value:string) => {
    const node = view().find(node=>node.props["aria-label"]===label);
    if (!node) throw new Error(label);
    (node.props.onChange as (event:unknown)=>void)({target:{value}});
  };
  const generate = () => {
    const button=view().find(node=>node.type==="button"&&node.props.children==="توليد جدول الأقساط")!;
    expect(button.props.disabled).toBe(false);
    (button.props.onClick as ()=>void)();
  };
  return { view, change, generate, get draft(){return draft;}, valid:()=>readDebtRepaymentDraft(draft,"SAR",remainingMinor).ok };
}
describe("unapplied monthly controls cannot silently save existing schedule",()=>{
  it.each([
    ["مبلغ الدفعة المقدمة المقترحة","500"], ["تاريخ الدفعة المقدمة المقترحة","2026-10-29"],
    ["عدد الأشهر","18"], ["أول استحقاق شهري","2026-12-28"],
  ])("blocks save after changing %s until explicit generation",(label,value)=>{
    const f=fixture(); expect(f.valid()).toBe(true); f.change(label,value); expect(f.valid()).toBe(false);
    f.generate(); expect(f.valid()).toBe(true);
  });
  it("2300 with proposed500 creates500 plus24 future75 installments, without collecting cash",()=>{
    const f=fixture(); f.change("مبلغ الدفعة المقدمة المقترحة","500"); f.change("عدد الأشهر","24");
    expect(f.valid()).toBe(false); f.generate(); expect(f.valid()).toBe(true);
    expect(f.draft.rows).toHaveLength(25); expect(f.draft.rows[0]).toMatchObject({kind:"down_payment",amount:"500.00"});
    expect(f.draft.rows.slice(1).every(row=>row.amount==="75.00")).toBe(true);
    const before=f.draft.rows.map(({key:_,...row})=>row); f.generate();
    expect(f.draft.rows.map(({key:_,...row})=>row)).toEqual(before);
  });
  it("already paid500 leaves1800 distributed once as24×75, without another proposed500",()=>{
    const f=fixture(180000); f.generate(); expect(f.valid()).toBe(true);
    expect(f.draft.rows).toHaveLength(24); expect(f.draft.rows.every(row=>row.amount==="75.00"&&row.kind==="installment")).toBe(true);
  });
  it("keeps pending controls across mode switches; discard/reopen from saved rows is clean",()=>{
    const f=fixture();f.change("مبلغ الدفعة المقدمة المقترحة","500");
    for(const mode of ["full","installments"]){
      const radio=f.view().filter(node=>node.type==="input"&&node.props.type==="radio")[mode==="full"?0:1];
      (radio.props.onChange as ()=>void)();
    }
    expect(f.draft.mode).toBe("installments");expect(f.valid()).toBe(false);
    expect(fixture().valid()).toBe(true);
  });
  it("opening the generator is not a change; manual row editing remains supported",()=>{
    const f=fixture(180000);f.generate();
    const summary=f.view().find(node=>node.type==="summary")!;
    (summary.props.onClick as (event:unknown)=>void)({preventDefault(){}});expect(f.valid()).toBe(true);
    f.change("مبلغ السداد 1","74");expect(f.valid()).toBe(false);
    f.change("مبلغ السداد 2","76");expect(f.valid()).toBe(true);
  });
});
