/** Local Chromium component harness only. Synthetic images/draft; no app, DB or deployment. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright';
import sharp from 'sharp';
import postcss from 'postcss';
import tailwind from 'tailwindcss';

async function main() {
  const root = process.cwd(), output = path.join(root, 'evidence/panoramic-browser-local-20261105');
  await mkdir(output, { recursive: true });
  const bytes = await sharp({ create: { width: 960, height: 320, channels: 3, background: '#a3b8c9' } }).png().toBuffer();
  const digest = createHash('sha256').update(bytes).digest('hex');
  const entry = `import React,{useState,useLayoutEffect,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {OrthoPanoramicReview} from './components/OrthoPanoramicReview';
import {newAssessmentEditorV2} from './lib/ortho-assessment-editor-v2';
const documents=[91,92,93].map(id=>({id,patientId:9001,orthoCaseId:9002,title:'Synthetic image '+id,isImage:true,photoView:'panoramic',photoStage:null,takenOn:null,uploadedAt:'2026-11-05T00:00:00Z',removedAt:null}));
const sources=documents.map(d=>({kind:'document',id:d.id,version:'sha256:${digest}',label:d.title}));
function Harness(){const [draft,setDraft]=useState(()=>newAssessmentEditorV2('synthetic-panoramic-command-0001',null).measurements);const current=useRef(draft);useLayoutEffect(()=>{current.current=draft;window.syntheticDraft=draft},[draft]);return <main dir="rtl"><h1>اختبار محلي اصطناعي، ليس صورة مريض</h1><OrthoPanoramicReview draft={draft} documents={documents} sources={sources} owner={{renderEditable:true,active:()=>current.current===draft,editable:()=>current.current===draft}} onChange={setDraft}/></main>};createRoot(document.getElementById('root')).render(<Harness/>);`;
  const bundle = await build({ stdin: { contents: entry, loader: 'tsx', resolveDir: root }, bundle: true, write: false, platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' } });
  const css = await postcss([tailwind({ content: [{ raw: entry, extension: 'tsx' }, './components/OrthoPanoramicReview.tsx'], theme: { extend: {} } })]).process('@tailwind base;@tailwind components;@tailwind utilities;body{font-family:Arial,sans-serif;padding:16px}main{max-width:1000px;margin:auto}', { from: undefined });
  const gates = new Map<string, () => void>();
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/documents/')) {
      requests.push(url.pathname + url.search);
      const id = url.pathname.split('/').pop()!;
      if (url.searchParams.get('cephSource') !== digest) { res.writeHead(409).end(); return; }
      const reply = () => { if (id === '93') res.writeHead(410).end('Synthetic missing image'); else res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }).end(bytes); };
      gates.set(id, reply); return;
    }
    if (url.pathname === '/bundle.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(bundle.outputFiles[0].contents); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(`<!doctype html><html lang="ar"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css.css}</style><div id="root"></div><script src="/bundle.js"></script></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  let browser: Browser | undefined;
  const results: unknown[] = [];
  try {
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'], env: { ...process.env, XDG_CONFIG_HOME: '/tmp/panoramic-chromium-config' } });
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
      await page.goto(base);
      const select = page.getByLabel('صورة البانوراما', { exact: true }), target = page.getByLabel('نطاق الملاحظة', { exact: true });
      const add = page.getByRole('button', { name: 'إضافة ملاحظة غير معبأة' });
      async function release(id: string) { for (let n = 0; n < 100 && !gates.has(id); n++) await new Promise(r => setTimeout(r, 20)); assert(gates.has(id), `image ${id} requested`); gates.get(id)!(); gates.delete(id); }
      const snapshot = () => page.evaluate(() => JSON.parse(JSON.stringify((window as unknown as { syntheticDraft: unknown }).syntheticDraft)));
      await select.selectOption('91'); assert(await target.isDisabled()); assert(await add.isDisabled());
      assert.equal(await page.locator('img').getAttribute('src'), `/api/documents/91?cephSource=${digest}`);
      await page.screenshot({ path: path.join(output, `${width}-loading.png`), fullPage: true });
      await release('91'); await target.waitFor(); await page.waitForFunction(() => !(document.querySelector('[aria-label="نطاق الملاحظة"]') as HTMLSelectElement).disabled);
      await target.selectOption('case'); await add.click();
      let draft = await snapshot(); const caseId = 'panoramic_v1_91_case';
      assert.equal(draft.values[caseId].state, 'not_recorded'); assert.equal(draft.values[caseId].text, ''); assert.equal(draft.values[caseId].date, ''); assert.equal(draft.values[caseId].method, ''); assert.equal(draft.values[caseId].performer, 'unknown');
      await target.selectOption('13'); await add.click();
      const toothId = 'panoramic_v1_91_tooth_13'; draft = await snapshot(); assert.equal(draft.values[toothId].state, 'not_recorded');
      await page.getByLabel('حالة قراءة السن FDI 13', { exact: true }).selectOption('recorded');
      await page.getByLabel('نتائج قراءة السن FDI 13', { exact: true }).fill('Synthetic tooth observation');
      // Retain the real React handler from the old selected-image render, then invoke it after navigation.
      await page.getByLabel('حالة قراءة السن FDI 13', { exact: true }).evaluate(element => {
        const key = Object.keys(element).find(k => k.startsWith('__reactProps$'))!;
        (window as unknown as { staleChange: (event: unknown) => void }).staleChange = (element as unknown as Record<string, { onChange: (event: unknown) => void }>)[key].onChange;
      });
      const beforeSwitch = await snapshot(); await select.selectOption('92'); assert(await target.isDisabled());
      await page.evaluate(() => (window as unknown as { staleChange: (event: unknown) => void }).staleChange({ target: { value: 'not_recorded' } }));
      assert.deepEqual(await snapshot(), beforeSwitch, 'old image callback cannot mutate draft');
      assert.equal(await page.getByLabel('حالة قراءة السن FDI 13', { exact: true }).count(), 0);
      await release('92'); await page.waitForFunction(() => !(document.querySelector('[aria-label="نطاق الملاحظة"]') as HTMLSelectElement).disabled);
      await target.selectOption('case'); await add.click(); draft = await snapshot();
      assert.equal(draft.values['panoramic_v1_92_case'].state, 'not_recorded');
      assert.equal(draft.values[toothId].text, 'Synthetic tooth observation');
      assert.deepEqual(draft.values[toothId].sources, [{ kind: 'document', id: 91, version: `sha256:${digest}` }]);
      await select.selectOption('91'); await release('91'); await page.waitForFunction(() => !(document.querySelector('[aria-label="نطاق الملاحظة"]') as HTMLSelectElement).disabled);
      assert.equal(await page.getByLabel('نتائج قراءة السن FDI 13', { exact: true }).inputValue(), 'Synthetic tooth observation');
      await page.screenshot({ path: path.join(output, `${width}-notes.png`), fullPage: true });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth); assert.equal(overflow, false, 'no horizontal overflow');
      await select.selectOption('93'); await release('93'); await page.getByRole('alert').waitFor();
      assert(await target.isDisabled()); assert(await add.isDisabled());
      assert.equal((await snapshot()).values[toothId].text, 'Synthetic tooth observation');
      await page.screenshot({ path: path.join(output, `${width}-failed-image.png`), fullPage: true });
      assert.deepEqual(errors, []); results.push({ width, passed: true, loadGate: true, blankCaseAndTooth: true, sourceSpecificPreservation: true, staleCallbackRejected: true, failedImageDisabled: true, noHorizontalOverflow: true });
      await page.close();
    }
    assert(requests.every(r => r.includes(`cephSource=${digest}`)));
    await writeFile(path.join(output, 'report.json'), JSON.stringify({ scope: 'Local component harness, not full app or production verification', syntheticOnly: true, browser: await browser.version(), results, imageRequests: requests }, null, 2));
    console.log(JSON.stringify({ output, results }, null, 2));
  } finally { await browser?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
