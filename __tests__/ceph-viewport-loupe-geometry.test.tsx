import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CephViewport } from "../components/CephViewport";

// Synthetic hook scheduling, element rectangles and pointer propagation execute
// the actual viewport handlers. This is not browser/device acceptance.
const context = vi.hoisted(() => {
  const make = () => ({ values: [] as unknown[], cursor: 0, changed: false,
    effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(),
    memos: new Map<number, { deps?: readonly unknown[]; value: unknown }>(), pending: [] as Array<() => void>,
  });
  return { make, current: make() };
});
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => { const hooks = context.current; const i = hooks.cursor++; if (!(i in hooks.values)) hooks.values[i] = initial; return i; };
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => {
    const hooks = context.current; const index = slot(undefined), before = hooks.memos.get(index); if (before && same(before.deps, deps)) return before.value;
    const value = factory(); hooks.memos.set(index, { deps, value }); return value;
  };
  const effect = (run: () => void | (() => void), deps?: readonly unknown[]) => {
    const hooks = context.current; const index = slot(undefined), previous = hooks.effects.get(index); if (previous && same(previous.deps, deps)) return;
    hooks.pending.push(() => { previous?.cleanup?.(); const cleanup = run(); hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }); });
  };
  return { ...react,
    useState: (initial: unknown) => {
      const hooks = context.current; const index = slot(typeof initial === "function" ? initial() : initial);
      return [hooks.values[index], (update: unknown) => {
        const next = typeof update === "function" ? update(hooks.values[index]) : update;
        if (!Object.is(next, hooks.values[index])) hooks.changed = true; hooks.values[index] = next;
      }];
    },
    useRef: (initial: unknown) => { const hooks = context.current; const index = slot({ current: initial }); return hooks.values[index]; },
    useMemo: memo, useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: effect, useLayoutEffect: effect,
  };
});
vi.mock("react-dom", () => ({ createPortal: (child: ReactNode) => child }));
type Element = ReactElement<Record<string, unknown>>;
const nodes = (node: ReactNode): Element[] => Array.isArray(node) ? node.flatMap(nodes)
  : node && typeof node === "object" && "props" in node ? [node as Element, ...nodes((node as Element).props.children as ReactNode)] : [];
let props: ComponentProps<typeof CephViewport>;
let tree: ReactNode;
let scrollLeft = 0, scrollTop = 0;
let resize: () => void;
let attachedRef: ((node:unknown)=>void)|undefined, attachedNode:unknown;
const imageNodes = new Map<unknown, {complete:boolean;naturalWidth:number;naturalHeight:number}>();
const imageNode = (element: Element) => imageNodes.get(element.key)!;
const host = { get scrollLeft() { return scrollLeft; }, set scrollLeft(value: number) { scrollLeft = Math.max(0, value); },
  get scrollTop() { return scrollTop; }, set scrollTop(value: number) { scrollTop = Math.max(0, value); }, clientWidth: 600, clientHeight: 400,
  getBoundingClientRect: () => ({ left: 20, top: 30, width: 600, height: 400 }) };
function render() {
  const hooks = context.current;
  for (let round = 0; round < 20; round++) {
    hooks.cursor = 0; hooks.changed = false; hooks.pending = [];
    tree = CephViewport(props);
    const viewport = nodes(tree).find(n => n.props["data-testid"] === "ceph-viewport")!;
    (viewport.props.ref as {current: unknown}).current = host;
    const surface=nodes(tree).find(n=>n.props['data-testid']==='ceph-surface')!;
    (surface.props.ref as {current:unknown}).current={getBoundingClientRect:()=>({left:20-host.scrollLeft,top:30-host.scrollTop})};
    const image=nodes(tree).find(n=>n.props['data-testid']==='ceph-image')!;
    if(!imageNodes.has(image.key))imageNodes.set(image.key,{complete:false,naturalWidth:0,naturalHeight:0});
    const nextRef=image.props.ref as (node:unknown)=>void;
    if(attachedRef!==nextRef || attachedNode!==imageNode(image)){attachedRef?.(null);attachedRef=nextRef;attachedNode=imageNode(image);nextRef(attachedNode);}
    hooks.pending.splice(0).forEach(run => run());
    if (!hooks.changed) return;
  }
  throw new Error("Render did not settle");
}
const find = (id: string) => nodes(tree).find(n => n.props["data-testid"] === id)!;
beforeEach(() => {
  attachedRef=undefined;attachedNode=undefined;imageNodes.clear(); context.current = context.make(); host.scrollLeft = 0; host.scrollTop = 0; host.clientWidth=600; host.clientHeight=400;
  vi.stubGlobal("ResizeObserver", class { constructor(callback:()=>void){resize=callback;} observe() {} disconnect() {} });
  vi.stubGlobal("document", {body: {}});
  vi.stubGlobal("window", {innerWidth: 1000, innerHeight: 800, addEventListener: vi.fn(), removeEventListener: vi.fn()});
  props = {...{onGestureTakeover: vi.fn()}, src: "/synthetic-source?hash=exact", natural: {w:1200,h:800}, onNaturalSize: vi.fn(), zoom:1,
    onZoomChange: vi.fn(), panMode:false, filter:"contrast(1.2) brightness(0.8)", showLoupe:true,
    cursor:{x:321.25,y:245.5}, onCursor:vi.fn(), onClick:vi.fn(), onPointerStart:vi.fn(),
    onPointerMove:vi.fn(), onPointerUp:vi.fn(), onPointerCancel:vi.fn(),
    renderOverlay: vi.fn((scale, interactive) => <g data-testid={interactive ? "main-mark" : "loupe-mark"} data-scale={scale}><circle cx={321.25} cy={245.5} r={2}/></g>)};
});
afterEach(() => {context.current.effects.forEach(e => e.cleanup?.()); vi.unstubAllGlobals();});

describe("actual viewport native loupe geometry (synthetic layout)", () => {
  it.each([
    {w:1200,h:800,zoom:1,scale:0.5,loupe:2.5},
    {w:600,h:400,zoom:1,scale:1,loupe:2.5},
    {w:1200,h:800,zoom:4,scale:2,loupe:5},
    {w:300,h:200,zoom:2,scale:2,loupe:5},
  ])("keeps native center/source/overlay at $w x $h zoom $zoom", ({w,h,zoom,scale,loupe}) => {
    props.natural={w,h}; props.zoom=zoom; render();
    const [x,y,width,height] = String(find("ceph-loupe-scene").props.viewBox).split(" ").map(Number);
    expect(width).toBe(180/loupe); expect(height).toBe(width);
    expect(x+width/2).toBe(321.25); expect(y+height/2).toBe(245.5);
    expect(find("ceph-overlay").props.viewBox).toBe(`0 0 ${w} ${h}`);
    expect(find("main-mark").props["data-scale"]).toBe(scale);
    expect(find("loupe-mark").props["data-scale"]).toBe(loupe);
    const image=nodes(find("ceph-loupe-scene")).find(n=>n.type==="image")!;
    expect(image.props).toMatchObject({href:props.src,x:"0",y:"0",width:w,height:h,style:{filter:props.filter}});
    expect(find("ceph-image").props).toMatchObject({src:props.src,style:{filter:props.filter}});
    const circles=nodes(tree).filter(n=>n.type==="circle");
    expect(circles).toHaveLength(2);
    for(const circle of circles) expect(circle.props).toMatchObject({cx:321.25,cy:245.5});
  });
  it("preserves the scrollable native center across toolbar zoom and back", () => {
    props.zoom=2; render(); host.scrollLeft=100; host.scrollTop=80;
    props.zoom=3; render();
    expect(host.scrollLeft).toBe(300); expect(host.scrollTop).toBe(220);
    props.zoom=2; render();
    expect(host.scrollLeft).toBe(100); expect(host.scrollTop).toBe(80);
  });
  it("excludes centered horizontal fit margins from the native zoom anchor", () => {
    props.natural={w:600,h:1200}; render();
    props.zoom=4; render();
    expect(host.scrollLeft).toBe(100);
    expect(host.scrollTop).toBe(600);
  });
  it("removes the loupe and overlay on image failure rather than showing stale source evidence", () => {
    render(); (find("ceph-image").props.onError as (e:unknown)=>void)({currentTarget:imageNode(find("ceph-image"))}); render();
    expect(nodes(tree).some(n=>n.props["data-testid"]==="ceph-loupe")).toBe(false);
    expect(nodes(tree).some(n=>n.props["data-testid"]==="ceph-overlay")).toBe(false);
    expect(props.onNaturalSize).toHaveBeenCalledWith(null);
  });
  it('preserves native center on width-only container resize even when fit scale is unchanged',()=>{
    props.zoom=2;render();host.scrollLeft=300;host.scrollTop=80;
    host.clientWidth=800;resize();render();
    expect(host.scrollLeft).toBe(200);expect(host.scrollTop).toBe(80);
    props.zoom=3;render();expect(host.scrollLeft).toBe(500);
  });
  it('preserves native center on height-only resize with width-limited fit',()=>{
    host.clientHeight=600;props.zoom=3;render();host.scrollLeft=300;host.scrollTop=300;
    host.clientHeight=800;resize();render();expect(host.scrollTop).toBe(200);expect(host.scrollLeft).toBe(300);
  });

  it('preserves a feasible native center through portrait/landscape resize and back',()=>{
    props.zoom=3;render();host.scrollLeft=300;host.scrollTop=250;
    // Old native center=(400,300); new fit=1/3, display scale=1.
    host.clientWidth=400;host.clientHeight=600;resize();render();
    expect(host.scrollLeft).toBe(200);expect(host.scrollTop).toBe(0);
    host.clientWidth=600;host.clientHeight=400;resize();render();
    expect(host.scrollLeft).toBe(300);expect(host.scrollTop).toBe(250);
  });
  it('accepts edge clamping when a centered native point cannot remain at the new viewport center',()=>{
    props.zoom=2;render();host.scrollLeft=0;host.scrollTop=0;
    host.clientWidth=800;resize();render();expect(host.scrollLeft).toBe(0);
    // The next zoom must use the actual clamped center400 and current width800.
    props.zoom=3;render();expect(host.scrollLeft).toBe(200);
  });

  it('keeps a held pan anchored after resize when the pointer has not moved',()=>{
    props.zoom=2;props.panMode=true;render();host.scrollLeft=300;host.scrollTop=80;
    const e={pointerId:1,pointerType:'mouse',button:0,clientX:100,clientY:100,currentTarget:{setPointerCapture(){}},preventDefault(){},stopPropagation(){}};
    (find('ceph-surface').props.onPointerDownCapture as(e:unknown)=>void)(e);
    host.clientWidth=800;resize();render();expect(host.scrollLeft).toBe(200);
    (find('ceph-surface').props.onPointerMoveCapture as(e:unknown)=>void)(e);expect(host.scrollLeft).toBe(200);
  });

  it('does not retain a clamped pinch anchor for an unrelated later resize',()=>{
    props.zoom=4;render();host.scrollLeft=300;host.scrollTop=80;
    const e=(id:number,x:number)=>({pointerId:id,pointerType:'touch',button:0,clientX:x,clientY:100,currentTarget:{setPointerCapture(){},hasPointerCapture:()=>false},preventDefault(){},stopPropagation(){}});
    const down=find('ceph-surface').props.onPointerDownCapture as(e:unknown)=>void;down(e(1,200));down(e(2,300));
    (find('ceph-surface').props.onPointerMoveCapture as(e:unknown)=>void)(e(2,400));
    const up=find('ceph-surface').props.onPointerUpCapture as(e:unknown)=>void;up(e(1,200));up(e(2,400));
    host.clientWidth=800;resize();render();expect(host.scrollLeft).toBe(200);expect(host.scrollTop).toBe(80);
  });

  it('ignores a superseded same-source image load after explicit retry',()=>{
    render();const old=find('ceph-image');(old.props.onError as(e:unknown)=>void)({currentTarget:imageNode(old)});render();
    const retry=nodes(tree).find(n=>n.type==='button'&&n.props.children==='إعادة تحميل الصورة')!;(retry.props.onClick as()=>void)();render();
    vi.mocked(props.onNaturalSize).mockClear();
    (old.props.onLoad as(e:unknown)=>void)({currentTarget:{complete:true,naturalWidth:99,naturalHeight:77}});
    expect(props.onNaturalSize).not.toHaveBeenCalled();
  });
  it('ignores an old image error after the replacement attempt loaded successfully',()=>{
    render();const old=find('ceph-image');(old.props.onError as(e:unknown)=>void)({currentTarget:imageNode(old)});render();
    const retry=nodes(tree).find(n=>n.type==='button'&&n.props.children==='إعادة تحميل الصورة')!;(retry.props.onClick as()=>void)();render();
    const fresh=find('ceph-image');Object.assign(imageNode(fresh),{complete:true,naturalWidth:1200,naturalHeight:800});(fresh.props.onLoad as(e:unknown)=>void)({currentTarget:imageNode(fresh)});render();
    vi.mocked(props.onNaturalSize).mockClear();(old.props.onError as(e:unknown)=>void)({currentTarget:imageNode(old)});render();
    expect(props.onNaturalSize).not.toHaveBeenCalled();expect(nodes(tree).some(n=>n.props['data-testid']==='ceph-overlay')).toBe(true);
  });

  it('rejects prior source callbacks across source ABA and after unmount',()=>{
    render();const old=find('ceph-image');props.src='/second-source';render();props.src='/synthetic-source?hash=exact';render();
    vi.mocked(props.onNaturalSize).mockClear();Object.assign(imageNode(old),{complete:true,naturalWidth:99,naturalHeight:77});
    (old.props.ref as(n:unknown)=>void)(imageNode(old));(old.props.onLoad as(e:unknown)=>void)({currentTarget:imageNode(old)});(old.props.onError as(e:unknown)=>void)({currentTarget:imageNode(old)});expect(props.onNaturalSize).not.toHaveBeenCalled();
    const fresh=find('ceph-image');context.current.effects.forEach(e=>e.cleanup?.());
    (fresh.props.onLoad as(e:unknown)=>void)({currentTarget:imageNode(fresh)});expect(props.onNaturalSize).not.toHaveBeenCalled();
  });
  it('accepts cached complete image attachment and rejects a different node in the same attempt',()=>{
    imageNodes.set('/synthetic-source?hash=exact:0',{complete:true,naturalWidth:1200,naturalHeight:800});render();expect(props.onNaturalSize).toHaveBeenCalledWith({w:1200,h:800});vi.mocked(props.onNaturalSize).mockClear();
    const image=find('ceph-image');(image.props.onLoad as(e:unknown)=>void)({currentTarget:{complete:true,naturalWidth:99,naturalHeight:77}});expect(props.onNaturalSize).not.toHaveBeenCalled();
    (image.props.ref as(n:unknown)=>void)(null);(image.props.ref as(n:unknown)=>void)(imageNode(image));expect(props.onNaturalSize).toHaveBeenCalledWith({w:1200,h:800});
  });

  it('invalidates retry synchronously and rejects an old retry after current success',()=>{
    render();const image=find('ceph-image');(image.props.onError as(e:unknown)=>void)({currentTarget:imageNode(image)});render();const retry=nodes(tree).find(n=>n.type==='button'&&n.props.children==='إعادة تحميل الصورة')!.props.onClick as()=>void;
    Object.assign(imageNode(image),{complete:true,naturalWidth:1200,naturalHeight:800});(image.props.onLoad as(e:unknown)=>void)({currentTarget:imageNode(image)});retry();render();expect(find('ceph-image').key).toBe(image.key);
    (image.props.onError as(e:unknown)=>void)({currentTarget:imageNode(image)});render();const current=nodes(tree).find(n=>n.type==='button'&&n.props.children==='إعادة تحميل الصورة')!.props.onClick as()=>void;current();current();render();expect(find('ceph-image').key).toBe('/synthetic-source?hash=exact:1');
  });

});
