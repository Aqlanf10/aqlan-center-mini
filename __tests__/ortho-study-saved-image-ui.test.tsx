import type {ReactElement,ReactNode} from "react";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0,
  effects: [] as { index: number; effect(): void | (() => void) }[], cleanups: new Map<number, () => void>() }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState(initial: unknown) {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.slots[index], (value: unknown) => { hooks.slots[index] = typeof value === "function" ? value(hooks.slots[index]) : value; }];
  },
  useEffect(effect: () => void | (() => void), dependencies: unknown[]) {
    const index = hooks.cursor++, prior = hooks.slots[index] as unknown[] | undefined;
    if (!prior || dependencies.some((value, offset) => value !== prior[offset])) {
      hooks.slots[index] = dependencies; hooks.effects.push({ index, effect });
    }
  },
}));
const transport=vi.hoisted(()=>({fetch:vi.fn()}));
vi.mock('../lib/ortho-study-review-image-client',async original=>({...await original<typeof import('../lib/ortho-study-review-image-client')>(),fetchSavedStudyImage:transport.fetch}));
import OrthoSavedStudyImages,{SavedImage} from '../components/OrthoSavedStudyImages';
import {SavedStudyImageDenied} from '../lib/ortho-study-review-image-client';
import {studyPreviewFixture} from './fixtures/ortho-study-preview';
import {makeStudyOwner} from '../lib/ortho-case-study-owner';
import {makeStudyRecoveryLedger} from '../lib/ortho-case-study-recovery';
type Element=ReactElement<Record<string,unknown>>;
const nodes=(node:ReactNode):Element[]=>Array.isArray(node)?node.flatMap(nodes):node&&typeof node==='object'&&'props' in node?[node as Element,...nodes((node as Element).props.children as ReactNode)]:[];
function fixture(){const revision=studyPreviewFixture(),deny=vi.fn();let authorized=true;
 const owner=makeStudyOwner({...revision,actorId:7,recovery:makeStudyRecoveryLedger(),authorized:()=>authorized,writable:()=>false,deny});owner.activate();
 const props={owner,revision,readVersion:0,panelId:'panel1',useId:'use1',slot:revision.authored.panels[0].images[0].slot,locale:'en' as const};
 const render=()=>{hooks.cursor=0;const tree=SavedImage(props);for(const {index,effect} of hooks.effects.splice(0)){hooks.cleanups.get(index)?.();hooks.cleanups.delete(index);const cleanup=effect();if(cleanup)hooks.cleanups.set(index,cleanup);}return nodes(tree);};
 return {props,owner,deny,render,revoke:()=>{authorized=false;}};
}
beforeEach(()=>{hooks.slots=[];hooks.cursor=0;hooks.effects=[];hooks.cleanups.clear();transport.fetch.mockReset();vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:synthetic');vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});});
afterEach(()=>{for(const cleanup of hooks.cleanups.values())cleanup();hooks.cleanups.clear();vi.restoreAllMocks();vi.useRealTimers();});
it('shows verified blob with saved caption and revokes synchronously on retirement',async()=>{transport.fetch.mockResolvedValue(new Blob(['synthetic']));const f=fixture();f.render();await vi.waitFor(()=>expect(f.render().some(n=>n.type==='img')).toBe(true));f.owner.retire();expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:synthetic');expect(f.owner.active()).toBe(false);expect(f.owner.editable()).toBe(false);expect(f.render().some(n=>n.type==='img')).toBe(false);});
it('never accepts late bytes from retired owner, including attempted reactivation',async()=>{let resolve!:(v:Blob)=>void;transport.fetch.mockImplementation(()=>new Promise<Blob>(r=>{resolve=r;}));const f=fixture();f.render();f.owner.retire();f.owner.activate();resolve(new Blob(['late']));await Promise.resolve();expect(URL.createObjectURL).not.toHaveBeenCalled();expect(f.render().some(n=>n.type==='img')).toBe(false);});
it('drops old bytes after revision switches',async()=>{let resolve!:(v:Blob)=>void;transport.fetch.mockImplementationOnce(()=>new Promise<Blob>(r=>{resolve=r;})).mockResolvedValue(new Blob(['next']));const f=fixture();f.render();f.props.revision={...f.props.revision,id:92,contentHash:'d'.repeat(64)};f.render();resolve(new Blob(['old']));await vi.waitFor(()=>expect(URL.createObjectURL).toHaveBeenCalledTimes(1));});
it('invalidating read revokes existing URLs before rerender',async()=>{transport.fetch.mockResolvedValue(new Blob(['synthetic']));const f=fixture();f.render();await vi.waitFor(()=>expect(URL.createObjectURL).toHaveBeenCalled());f.owner.invalidateRead();expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:synthetic');expect(f.render().some(n=>n.type==='img')).toBe(false);});
it('hides and disposes when authority is revoked',async()=>{transport.fetch.mockResolvedValue(new Blob(['synthetic']));const f=fixture();f.render();await vi.waitFor(()=>expect(URL.createObjectURL).toHaveBeenCalled());f.revoke();expect(f.render().some(n=>n.type==='img')).toBe(false);expect(URL.revokeObjectURL).toHaveBeenCalled();});
it('denial quarantines owner and never creates a URL',async()=>{transport.fetch.mockRejectedValue(new SavedStudyImageDenied());const f=fixture();f.render();await vi.waitFor(()=>expect(f.deny).toHaveBeenCalled());expect(URL.createObjectURL).not.toHaveBeenCalled();expect(f.owner.active()).toBe(false);});
it('timeout reports failure even though transport is aborted',async()=>{vi.useFakeTimers();transport.fetch.mockImplementation(()=>new Promise(()=>{}));const f=fixture();f.render();await vi.advanceTimersByTimeAsync(15000);expect(f.render().some(n=>n.props.role==='alert')).toBe(true);expect(transport.fetch.mock.calls[0][1].aborted).toBe(true);});
it('unmount aborts pending work',()=>{transport.fetch.mockImplementation(()=>new Promise(()=>{}));const f=fixture();f.render();for(const cleanup of hooks.cleanups.values())cleanup();expect(transport.fetch.mock.calls[0][1].aborted).toBe(true);});
it.each(['restricted','unavailable','not_recorded'] as const)('does not mount images for %s panel',state=>{const f=fixture();f.props.revision.authored.panels[0].state=state;hooks.cursor=0;expect(OrthoSavedStudyImages(f.props)).toBeNull();expect(transport.fetch).not.toHaveBeenCalled();});
it('excluded available panel has explicit review-only label and click-to-load images',()=>{const f=fixture();f.props.revision.authored.panels[0].included=false;hooks.cursor=0;const tree=nodes(OrthoSavedStudyImages(f.props));expect(JSON.stringify(tree)).toContain('Excluded from export');expect(tree.some(n=>n.type===SavedImage)).toBe(false);expect(transport.fetch).not.toHaveBeenCalled();});
it('retirement subscribers cannot reactivate or write drafts',()=>{const f=fixture();const called=vi.fn(()=>{f.owner.activate();f.owner.change('must not be stored');expect(f.owner.active()).toBe(false);expect(f.owner.editable()).toBe(false);expect(f.owner.document).toBe('');});f.owner.subscribe(called);f.owner.retire();expect(called).toHaveBeenCalledOnce();f.owner.refresh();expect(called).toHaveBeenCalledOnce();});
it('owner ABA late completion cannot create an old principal URL',async()=>{let resolve!:(v:Blob)=>void;transport.fetch.mockImplementationOnce(()=>new Promise<Blob>(r=>{resolve=r;})).mockResolvedValue(new Blob(['new']));const f=fixture();f.render();f.owner.retire();const next=makeStudyOwner({...f.props.revision,actorId:8,recovery:makeStudyRecoveryLedger(),authorized:()=>true,writable:()=>false,deny:vi.fn()});next.activate();f.props.owner=next;f.render();resolve(new Blob(['old']));await vi.waitFor(()=>expect(URL.createObjectURL).toHaveBeenCalledTimes(1));expect(transport.fetch.mock.calls[1][0].actorId).toBe(8);});
it('late decode error from old image cannot hide next image',async()=>{transport.fetch.mockResolvedValue(new Blob(['synthetic']));const f=fixture();f.render();let old:Element|undefined;await vi.waitFor(()=>{old=f.render().find(n=>n.type==='img');expect(old).toBeTruthy();});f.props.revision={...f.props.revision,id:92,contentHash:'d'.repeat(64)};f.render();await vi.waitFor(()=>expect(f.render().some(n=>n.type==='img')).toBe(true));(old!.props.onError as ()=>void)();expect(f.render().some(n=>n.type==='img')).toBe(true);});
it('A to B to A revision transition does not revive the first A request',async()=>{const pending:((v:Blob)=>void)[]=[];transport.fetch.mockImplementation(()=>new Promise<Blob>(r=>pending.push(r)));const f=fixture(),a=f.props.revision;f.render();f.props.revision={...a,id:92,contentHash:'d'.repeat(64)};f.render();f.props.revision=a;f.render();pending[0](new Blob(['oldA']));pending[1](new Blob(['B']));await Promise.resolve();expect(URL.createObjectURL).not.toHaveBeenCalled();pending[2](new Blob(['newA']));await vi.waitFor(()=>expect(URL.createObjectURL).toHaveBeenCalledTimes(1));});
it('old image decode failure after owner replacement cannot clear replacement URL',async()=>{transport.fetch.mockResolvedValue(new Blob(['synthetic']));const f=fixture();f.render();let old:Element|undefined;await vi.waitFor(()=>{old=f.render().find(n=>n.type==='img');expect(old).toBeTruthy();});f.owner.retire();const next=makeStudyOwner({...f.props.revision,actorId:8,recovery:makeStudyRecoveryLedger(),authorized:()=>true,writable:()=>false,deny:vi.fn()});next.activate();f.props.owner=next;f.render();await vi.waitFor(()=>expect(f.render().some(n=>n.type==='img')).toBe(true));(old!.props.onError as ()=>void)();expect(f.render().some(n=>n.type==='img')).toBe(true);});
