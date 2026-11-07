// Offline synthetic fixture export for visual QA in a browser-capable environment.
// Usage: node __tests__/fixtures/build-ceph-browser.mjs /tmp/ceph-browser [--baseline]
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const destination = resolve(process.argv[2] || '/tmp/ceph-browser');
mkdirSync(destination, { recursive: true });
const sourceFixture = JSON.parse(readFileSync(new URL('./ceph-source-fixture.json', import.meta.url), 'utf8'));
const baseline = process.argv.includes('--baseline');
await build({ entryPoints: ['__tests__/fixtures/ceph-tracer-real-react.tsx'], outfile: join(destination,'fixture.js'), bundle:true, platform:'browser', format:'iife', jsx:'automatic', tsconfig:'tsconfig.json', define:{'process.env.NODE_ENV':'"development"'}, plugins:[{ name:'fixture-adapters', setup(b) {
 b.onResolve({filter:/^next\/link$/},()=>({path:'link',namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export default function Link({children,...props}) { return <a {...props}>{children}</a> }',loader:'tsx',resolveDir:process.cwd()}));
 if(baseline) b.onLoad({filter:/components\/CephTracer\.tsx$/},()=>({contents:execFileSync('git',['show','c6c886121bcc50aa548f64b0b0fbd7b5beb1f324:components/CephTracer.tsx'],{encoding:'utf8'}),loader:'tsx',resolveDir:process.cwd()+'/components'}));
}}] });
execFileSync(process.execPath,['node_modules/tailwindcss/lib/cli.js','-i','app/globals.css','-o',join(destination,'fixture.css')]);
writeFileSync(join(destination,'index.html'),'<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"></head><body><main style="width:1100px;max-width:calc(100vw - 40px);margin:20px;transform:translate(3px,5px)"><div id="root"></div></main><script src="/fixture.js"></script></body></html>');
writeFileSync(join(destination,'synthetic.svg'),sourceFixture.image);
writeFileSync(join(destination,'serve.mjs'),`import { createServer } from 'node:http';\nimport { readFileSync } from 'node:fs';\nconst routes = { '/': ['index.html','text/html'], '/fixture.js':['fixture.js','text/javascript'], '/fixture.css':['fixture.css','text/css'], '/api/documents/990003':['synthetic.svg','image/svg+xml'] };\ncreateServer((req,res)=>{const item=routes[new URL(req.url,'http://127.0.0.1').pathname]; if(req.method!=='GET'||!item){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',item[1]);res.end(readFileSync(new URL(item[0],import.meta.url)));}).listen(Number(process.argv[2]||19973),'127.0.0.1');\n`);
console.log(destination);
