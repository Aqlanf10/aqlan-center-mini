import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { describe, it } from "vitest";
import * as catalogue from "../lib/ortho-workup-navigation";
interface Tree { type: string; props: Record<string, unknown>; }
const h=(type:string,props:Record<string,unknown>|null,...children:unknown[]):Tree=>({type,props:{...props,children}});
function flatten(value:unknown):Tree[]{
  if(Array.isArray(value))return value.flatMap(flatten);
  if(!value||typeof value!=="object"||!("type" in value))return [];
  const node=value as Tree;return [node,...flatten(node.props.children)];
}
function components(){
  const code=transformSync(readFileSync("components/OrthoWorkupNavigation.tsx","utf8"),{loader:"tsx",format:"cjs",target:"node22",jsxFactory:"h"}).code;
  const module={exports:{}};
  new Function("require","module","exports","h",code)((id:string)=>{assert.equal(id,"@/lib/ortho-workup-navigation");return catalogue;},module,module.exports,h);
  return module.exports as {OrthoWorkupNavigation:(props:{step:number;legacy:boolean;onSelect:(step:number)=>void;onClose:()=>void})=>unknown;OrthoCaseNavigation:(props:{pillar:string;onSelect:(pillar:string)=>void})=>unknown};
}
describe("compact orthodontic navigation retains parent-owned transitions",()=>{
  for(let step=0;step<catalogue.ORTHO_WORKUP_STEPS.length;step++)it(`retains every destination from step ${step}`,()=>{
    const calls:number[]=[];let closed=0;
    const nodes=flatten(components().OrthoWorkupNavigation({step,legacy:false,onSelect:value=>calls.push(value),onClose:()=>closed++}));
    assert.equal(calls.length,0);assert.equal(closed,0);
    const groupNav=nodes.find(node=>node.props["aria-label"]==="مجموعات ملف التقويم");assert.ok(groupNav);
    const buttons=flatten(groupNav).filter(node=>node.type==="button");assert.equal(buttons.length,catalogue.ORTHO_WORKUP_GROUPS.length);
    assert.equal(buttons.filter(node=>node.props["aria-pressed"]===true).length,1);
    buttons.forEach((button,index)=>{
      (button.props.onClick as ()=>void)();
      const group=catalogue.ORTHO_WORKUP_GROUPS[index];assert.equal(calls.at(-1),group.steps.some(value=>value===step)?step:group.entry);
    });
    assert.ok(nodes.filter(node=>node.type==="button").every(node=>node.props.type==="button"));
    assert.ok(!nodes.some(node=>node.props.role==="progressbar"));
    const close=nodes.find(node=>node.type==="button"&&!Object.hasOwn(node.props,"aria-pressed")&&!Object.hasOwn(node.props,"aria-current"));assert.ok(close);
    (close.props.onClick as ()=>void)();assert.equal(closed,1);
  });
  for(const step of [-1,NaN,Infinity,0.5,999])it(`rejects invalid step ${step} without a transition`,()=>{
    assert.equal(components().OrthoWorkupNavigation({step,legacy:false,onSelect:()=>assert.fail("unexpected transition"),onClose:()=>assert.fail("unexpected close")}),null);
  });
  it("retains the existing routine-visit-first case order",()=>{
    const calls:string[]=[];
    const nodes=flatten(components().OrthoCaseNavigation({pillar:"wires",onSelect:value=>calls.push(value)}));
    const buttons=nodes.filter(node=>node.type==="button");assert.equal(buttons.length,catalogue.ORTHO_CASE_PILLARS.length);
    buttons.forEach(button=>(button.props.onClick as ()=>void)());
    assert.deepEqual(calls,catalogue.ORTHO_CASE_PILLARS.map(item=>item.id));assert.equal(calls[0],"wires");
  });
});
