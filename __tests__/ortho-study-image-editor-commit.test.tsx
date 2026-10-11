import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OrthoStudyImageEditor, { type OrthoStudyImageEditorProps } from "../components/OrthoStudyImageEditor";
import type { StudyImageEditRequest } from "../lib/ortho-study-image-editor";
import { defaultOrthoMediaRecipe } from "../lib/ortho-study-media";
// Actual component callbacks with synthetic hooks only; native React proof remains required.
const hooks = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0, changed: false,
  effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(),
  memos: new Map<number, { deps?: readonly unknown[]; value: unknown }>(),
  pending: [] as Array<() => void>,
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return index;
  };
  const same = (a?: readonly unknown[], b?: readonly unknown[]) =>
    !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => {
    const index = slot(undefined), previous = hooks.memos.get(index);
    if (previous && same(previous.deps, deps)) return previous.value;
    const value = factory(); hooks.memos.set(index, { deps, value }); return value;
  };
  return { ...react,
    useState: (initial: unknown) => {
      const index = slot(typeof initial === "function" ? initial() : initial);
      return [hooks.values[index], (update: unknown) => {
        const next = typeof update === "function" ? update(hooks.values[index]) : update;
        if (!Object.is(next, hooks.values[index])) hooks.changed = true;
        hooks.values[index] = next;
      }];
    },
    useRef: (initial: unknown) => { const index = slot({ current: initial }); return hooks.values[index]; },
    useMemo: memo,
    useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useLayoutEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = slot(undefined), previous = hooks.effects.get(index);
      if (previous && same(previous.deps, deps)) return;
      hooks.pending.push(() => {
        previous?.cleanup?.(); const cleanup = effect();
        hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined });
      });
    },
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = slot(undefined), previous = hooks.effects.get(index);
      if (previous && same(previous.deps, deps)) return;
      hooks.pending.push(() => {
        previous?.cleanup?.(); const cleanup = effect();
        hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined });
      });
    },
  };
});

type Element=ReactElement<Record<string,unknown>>;
const nodes=(node:ReactNode):Element[]=>Array.isArray(node)?node.flatMap(nodes):node&&typeof node==="object"&&"props" in node?[node as Element,...nodes((node as Element).props.children as ReactNode)]:[];
const textOf=(node:ReactNode):string=>typeof node==="string"||typeof node==="number"?String(node):Array.isArray(node)?node.map(textOf).join(""):node&&typeof node==="object"&&"props" in node?textOf((node as Element).props.children as ReactNode):"";
let props:OrthoStudyImageEditorProps;
const change=vi.fn((_request:StudyImageEditRequest)=>true), preview=vi.fn(async()=>({ok:false as const,code:"unavailable" as const}));
const retire=()=>{hooks.effects.forEach(e=>e.cleanup?.());hooks.values.length=0;hooks.effects.clear();hooks.memos.clear();hooks.pending.length=0;};
function render(commit=true){hooks.cursor=0;hooks.changed=false;const outer=OrthoStudyImageEditor(props);const tree=(outer.type as (p:unknown)=>ReactNode)(outer.props);if(commit)hooks.pending.splice(0).forEach(effect=>effect());return tree;}
const action=(tree:ReactNode,label:string)=>{const node=nodes(tree).find(n=>n.type==="button"&&textOf(n)===label);if(!node)throw Error(label);return node.props.onClick as ()=>void;};
const rotate="تدوير +90° وإعادة القص";
beforeEach(()=>{retire();change.mockClear();preview.mockClear();props={ownerKey:"synthetic-case1-principal1",use:{useId:"use1",documentId:1,sourceSha256:"a".repeat(64),groupId:"group1",slotId:"face",order:0,view:"face-rest",caption:"Synthetic",recipe:defaultOrthoMediaRecipe(800,400,1)},frame:{width:400,height:200},editable:true,onChange:change,requestPreview:preview};});
afterEach(retire);
describe("committed image-editor handler admission",()=>{
  it("an abandoned render cannot publish different source props to an already committed handler",()=>{
    const initial=props,first=render(),old=action(first,rotate);
    props={...initial,editable:false};render(false);hooks.pending.length=0;props=initial;
    old();expect(change).toHaveBeenCalledTimes(1);expect(change.mock.calls[0]?.[0]).toMatchObject({useId:"use1",documentId:1});
  });
  it("a committed permission change rejects retained edit callbacks",()=>{const old=action(render(),rotate);props={...props,editable:false};render();old();expect(change).not.toHaveBeenCalled();});
  it("a same-source committed recipe replacement rejects old edits",()=>{const old=action(render(),rotate);props={...props,use:{...props.use,recipe:{...props.use.recipe,brightnessPermille:1100}}};render();old();expect(change).not.toHaveBeenCalled();});
  it("retired handlers cannot edit a remounted use",()=>{const old=action(render(),rotate);retire();render();old();expect(change).not.toHaveBeenCalled();});
});

// Exercise the private Preview function obtained from the real editor's element tree.
// The URL state is seeded to isolate pointer admission; this does not claim preview verification.
describe("committed preview pointer admission",()=>{
  it("retained pointer-up/cancel and a different pointer cannot cancel a newer committed drag",()=>{
    const tree=render();const child=nodes(tree).find(n=>typeof n.type==="function"&&n.type.name==="Preview")!;
    const Preview=child.type as (p:Record<string,unknown>)=>ReactNode;retire();
    const onCrop=vi.fn(()=>true);let input:Record<string,unknown>={...child.props,request:{...(child.props.request as Record<string,unknown>),purpose:"editor-canvas"},onCrop};
    const draw=()=>{hooks.cursor=0;hooks.changed=false;const result=Preview(input);hooks.pending.splice(0).forEach(effect=>effect());return nodes(result).find(n=>n.type==="img");};
    draw();hooks.values[4]="blob:synthetic-preview";const old=draw()!;
    input={...input,zoom:2};const current=draw()!;
    const target={setPointerCapture:vi.fn(),getBoundingClientRect:()=>({left:0,top:0,width:400,height:200})};
    const event=(pointerId:number,x:number,y:number)=>({pointerId,button:0,clientX:x,clientY:y,currentTarget:target});
    (current.props.onPointerDown as (e:unknown)=>void)(event(10,20,20));draw();
    (old.props.onPointerUp as (e:unknown)=>void)(event(10,200,100));
    (old.props.onPointerCancel as (e:unknown)=>void)(event(10,200,100));
    (current.props.onPointerCancel as (e:unknown)=>void)(event(11,200,100));
    (current.props.onPointerUp as (e:unknown)=>void)(event(11,200,100));
    expect(onCrop).not.toHaveBeenCalled();
    (draw()!.props.onPointerUp as (e:unknown)=>void)(event(10,200,100));
    expect(onCrop).toHaveBeenCalledTimes(1);
  });
});
