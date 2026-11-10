import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { chromium, type Browser } from "playwright";

let browser: Browser, script: string;
beforeAll(async () => {
  const built = await build({
    stdin: { resolveDir: process.cwd(), sourcefile: "synthetic-workup-owners.jsx", loader: "jsx", contents: `
      import React, {StrictMode} from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import {makeOrthoWorkupOwners,OrthoWorkupOwnersContext,useOrthoWorkupOwner} from './components/OrthoWorkupOwners';
      const root=createRoot(document.getElementById('root'));
      const registries=[makeOrthoWorkupOwners(),makeOrthoWorkupOwners()];
      const owners=[{},{}];
      const states=[{active:true,busy:false,dirty:false},{active:true,busy:false,dirty:false}];
      function Child({caseId,identity,state}) {
        useOrthoWorkupOwner(caseId,identity,()=>state);
        return <button onClick={()=>{state.busy=true;window.immediatePending=registries.some(r=>r.pending(caseId));}}>Begin</button>;
      }
      window.workupFixture={
        mount:(registry,caseId,identity,state,visible=true)=>flushSync(()=>root.render(<StrictMode><OrthoWorkupOwnersContext.Provider value={registries[registry]}>{visible&&<Child caseId={caseId} identity={owners[identity]} state={states[state]}/>}</OrthoWorkupOwnersContext.Provider></StrictMode>)),
        change:(state,patch)=>Object.assign(states[state],patch),
        snapshot:(registry,caseId)=>({pending:registries[registry].pending(caseId),dirty:registries[registry].dirty(caseId)}),
        unmount:()=>flushSync(()=>root.unmount())
      };
    ` },
    bundle: true, write: false, jsx: "automatic", platform: "browser", format: "iife",
    define: { "process.env.NODE_ENV": '"development"' },
  });
  script = built.outputFiles[0].text;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
});
afterAll(async () => { await browser?.close(); });

type FixtureWindow = Window & {
  immediatePending: boolean;
  workupFixture: {
    mount(registry: number, caseId: number, identity: number, state: number, visible?: boolean): void;
    change(state: number, patch: { active?: boolean; busy?: boolean; dirty?: boolean }): void;
    snapshot(registry: number, caseId?: number): { pending: boolean; dirty: boolean };
    unmount(): void;
  };
};

it("StrictMode registrations use live latches, committed getters and exact case/authority cleanup", async () => {
  const page = await browser.newPage();
  try {
    await page.route("**/*", route => route.abort());
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: script });
    await page.evaluate(() => (window as unknown as FixtureWindow).workupFixture.mount(0, 21, 0, 0));
    await page.getByRole("button", { name: "Begin" }).click();
    expect(await page.evaluate(() => (window as unknown as FixtureWindow).immediatePending)).toBe(true);
    const snapshots = await page.evaluate(() => {
      const f = (window as unknown as FixtureWindow).workupFixture;
      const first = f.snapshot(0, 21);
      f.mount(0, 21, 0, 1); // Same identity; the committed getter changes.
      const replacedReader = f.snapshot(0, 21);
      f.change(1, { dirty: true });
      const liveDirty = f.snapshot(0, 21);
      f.mount(0, 22, 1, 1);
      const retiredCase = f.snapshot(0, 21), currentCase = f.snapshot(0, 22);
      f.mount(1, 22, 1, 1);
      const retiredRegistry = f.snapshot(0), currentRegistry = f.snapshot(1);
      f.change(1, { active: false, busy: true });
      const retiredOwner = f.snapshot(1);
      f.unmount();
      return { first, replacedReader, liveDirty, retiredCase, currentCase, retiredRegistry, currentRegistry, retiredOwner, unmounted: f.snapshot(1) };
    });
    expect(snapshots).toEqual({
      first: { pending: true, dirty: false }, replacedReader: { pending: false, dirty: false },
      liveDirty: { pending: false, dirty: true }, retiredCase: { pending: false, dirty: false },
      currentCase: { pending: false, dirty: true }, retiredRegistry: { pending: false, dirty: false },
      currentRegistry: { pending: false, dirty: true }, retiredOwner: { pending: false, dirty: false },
      unmounted: { pending: false, dirty: false },
    });
  } finally { await page.close(); }
});
