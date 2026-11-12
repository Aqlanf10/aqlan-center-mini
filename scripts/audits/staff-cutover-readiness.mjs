/** Read-only source inventory, not a database probe or activation gate.
 * --write updates only the checked-in report; default verifies drift.
 * --require-ready additionally exits nonzero while cutover remains unproved. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const reportPath = 'docs/security/staff-cutover/inventory.json';
const nonStaffClasses = new Set(['public','portal','webhook','internal']);
export function classifyHttpAccess(access, { mismatch=false, nonApi=false, auth=false }={}) {
 if(mismatch||nonApi||(!Array.isArray(access)&&!nonStaffClasses.has(access)&&access!=='shared-media'))return 'unknown';
 if(auth||Array.isArray(access))return 'staff-legacy-held';
 return nonStaffClasses.has(access)?'public-separate-portal':'unknown';
}
export const isSourceFile = file => /\.(js|jsx|cjs|mjs|ts|tsx|cts|mts)$/.test(file);
export function discoverEntries(files) {
 const candidates=files.filter(f=>/\/(route|page|layout)(?:\..+)?$/.test(f));
 return {supported:candidates.filter(f=>/\/(route|page|layout)\.(js|jsx|ts|tsx)$/.test(f)),unsupported:candidates.filter(f=>!/\/(route|page|layout)\.(js|jsx|ts|tsx)$/.test(f))};
}
const entryKind = file => path.basename(file).split('.')[0];
const routeOf = file => '/'+file.slice(4).replace(/(?:^|\/)(route|page|layout)\.[^/]+$/,'');
function inventoryReader(root) {
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const walk = d => fs.readdirSync(path.join(root,d), {withFileTypes:true}).flatMap(e => e.isDirectory()?walk(`${d}/${e.name}`):[`${d}/${e.name}`]).sort();
const parse = f => ts.createSourceFile(f,read(f),ts.ScriptTarget.Latest,true,({'.tsx':ts.ScriptKind.TSX,'.jsx':ts.ScriptKind.JSX,'.js':ts.ScriptKind.JS})[path.extname(f)]??ts.ScriptKind.TS);
function constants(file) {
 const result = {};
 function value(n) {
  if(ts.isStringLiteral(n))return n.text;
  if(ts.isIdentifier(n) && Object.hasOwn(result,n.text))return result[n.text];
  if(ts.isArrayLiteralExpression(n))return n.elements.map(value);
  if(ts.isObjectLiteralExpression(n))return Object.fromEntries(n.properties.map(p=>{if(!ts.isPropertyAssignment(p))throw Error('unsupported property');return [p.name.text,value(p.initializer)];}));
  if(ts.isAsExpression(n))return value(n.expression);
  if(ts.isNewExpression(n)&&n.expression.getText()==='Set')return value(n.arguments[0]);
  throw Error(`unsupported inventory constant: ${n.getText().slice(0,100)}`);
 }
 for(const s of parse(file).statements)if(ts.isVariableStatement(s))for(const d of s.declarationList.declarations) {
  if(['PUBLIC','PORTAL','SHARED_MEDIA','WEBHOOK','INTERNAL','CANONICAL','ADMIN','CLINIC','FRONT_DESK','CLINICAL','HTTP_PERMISSIONS','PUBLIC_PATHS','PUBLIC_API','PUBLIC_API_PREFIXES','actions'].includes(d.name.text))result[d.name.text]=value(d.initializer);
 }
 return result;
}
const helpers=['requireSession','requireSessionStrict','readSessionPayload','readSessionToken','findUserByUsername','withLegacyStaffReadOnlySnapshot','revalidateSessionInTransaction','requireBackupAdminSession','requireBackupAdmin','readVerifiedDurableSession','withStaffOperation','assertStaffOperation'];
function evidence(file) {
 const source=read(file);
 return helpers.flatMap(symbol=>source.split('\n').flatMap((line,i)=>new RegExp(`\\b${symbol}\\b`).test(line)?[{symbol,line:i+1}]:[]));
}
function methods(file) {
 const found=new Set();
 for(const s of parse(file).statements) {
  const exported=s.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword);
  if(exported&&ts.isFunctionDeclaration(s)&&s.name)found.add(s.name.text);
  if(exported&&ts.isVariableStatement(s))for(const d of s.declarationList.declarations)found.add(d.name.text);
  if(ts.isExportDeclaration(s)&&s.exportClause&&ts.isNamedExports(s.exportClause))for(const e of s.exportClause.elements)found.add(e.name.text);
 }
 return [...found].filter(m=>/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(m)).sort();
}
function family(route) {
 if(/\/(ai|dot)(\/|$)/.test(route))return 'excluded-ai-dot';
 if(/^\/(api\/)?auth(\/|$)|^\/(login|setup)$/.test(route))return 'entry';
 if(/\/(users|staff-access|settings\/readiness)(\/|$)/.test(route))return 'administration';
 if(/\/(backup|production-backup)(\/|$)/.test(route))return 'backup';
 if(/\/(hr|tasks)(\/|$)/.test(route))return 'hr-tasks';
 if(/\/(inventory)(\/|$)/.test(route))return 'inventory';
 if(/\/(appointments|booking-requests|waiting-list)(\/|$)/.test(route))return 'appointments';
 if(/(financial|billing|statement|ledger|invoice|receipt|payment|expense|payable|commission|reconciliation|accounting|shift|cash|supplier|report|executive)/.test(route))return 'finance-reports';
 if(/\/(patients|visits|treatments|plans|ortho|endo|ceph|lab|clinical|teeth|images|documents)(\/|$)/.test(route))return 'patient-clinical';
 return 'other-review-required';
}
return function buildInventory() {
 const matrix=constants('lib/http-permissions.ts').HTTP_PERMISSIONS;
 const proxy=constants('proxy.ts');
 const discovery=discoverEntries(walk('app'));
 const files=discovery.supported;
 const sourceIssues=discovery.unsupported.map(file=>({file,reason:'unsupported entry filename',classification:'unknown'}));
 const routes=[];const mismatches=[];
 const allRouteFiles=files.filter(f=>entryKind(f)==='route');
 const routeMap={};
 for(const file of allRouteFiles) {
  const route=routeOf(file);
  if(Object.hasOwn(routeMap,route))sourceIssues.push({file,reason:'duplicate route pathname',classification:'unknown'});
  else routeMap[route]=file;
  if(!methods(file).length)sourceIssues.push({file,reason:'no recognized explicit HTTP exports',classification:'unknown'});
 }
 for(const route of [...new Set([...Object.keys(matrix),...Object.keys(routeMap)])].sort()) {
  const file=routeMap[route];const exported=file?methods(file):[];
  for(const method of [...new Set([...Object.keys(matrix[route]??{}),...exported])].sort()) {
   const access=matrix[route]?.[method]??null;
   const nonApi=!route.startsWith('/api/');
   const mismatch=!file||!exported.includes(method)||(!nonApi&&access===null);
   if(mismatch)mismatches.push({route,method,file:file??null,access});
   const auth=route.startsWith('/api/auth/');
   const classification=classifyHttpAccess(access,{mismatch,nonApi,auth});
   routes.push({route,method,file:file??null,httpAccess:access,classification,workflow:family(route),boundary:method==='GET'||method==='HEAD'?'read-snapshot-required-if-staff':'transaction-or-external-effect-boundary-required-if-staff',reason:mismatch?'matrix/export mismatch':nonApi?'Non-API route outside HTTP_PERMISSIONS; explicit proxy/handler review required':auth?'Public transport exemption is staff entry, not canonical admission':Array.isArray(access)?'Legacy staff proxy/session; no reviewed canonical route acceptance':access==='shared-media'?'Mixed portal/staff admission: staff branch held; separate portal branch requires independent regression':nonStaffClasses.has(access)?'Non-staff transport class; this is not a claim of marker-bearing runtime acceptance':'Unrecognized HTTP access class; review required',directHelperEvidence:file?evidence(file):[]});
  }
 }
 const pages=files.filter(f=>entryKind(f)==='page').map(file=> {
  const route=routeOf(file);const publicPath=proxy.PUBLIC_PATHS.includes(route)||route.startsWith('/portal/');
  return {route,file,classification:['/login','/setup'].includes(route)?'staff-legacy-held':publicPath?'public-separate-portal':route.startsWith('/print/')?'unknown':'staff-legacy-held',workflow:family(route),reason:publicPath?'Proxy public page; root layout still has legacy session dependencies, marker-bearing regression unproved':'Staff or print surface; proxy/root layout and data authorization require migration',directHelperEvidence:evidence(file)};
 });
 const sourceFiles=[...walk('app'),...walk('components'),...walk('lib'),'proxy.ts'].filter(isSourceFile);
 const directCanonicalReferences=sourceFiles.filter(f=>/^(app|components)\//.test(f)).flatMap(file=>evidence(file).filter(e=>['readVerifiedDurableSession','withStaffOperation','assertStaffOperation'].includes(e.symbol)).map(e=>({file,...e})));
 const legacyReferences=sourceFiles.filter(f=>/^(app|components)\//.test(f)).map(file=>({file,evidence:evidence(file).filter(e=>!['readVerifiedDurableSession','withStaffOperation','assertStaffOperation'].includes(e.symbol))})).filter(e=>e.evidence.length);
 const count=rows=>Object.fromEntries(['public-separate-portal','staff-legacy-held','canonical-ready','unknown'].map(k=>[k,rows.filter(r=>r.classification===k).length]));
 return {formatVersion:2,baseCommit:'74b82cea27d407626fb3c5e691bf68e6defb4598',readiness:'NOT_READY',readinessMeaning:'Source inventory only; no full marker-bearing clinic journey or cutover decision exists. Presence of new symbols never promotes readiness.',scope:'All explicit app route HTTP exports and matrix entries; all page/layout entries in JS, JSX, TS and TSX. Unsupported entry filenames are reported as unknown source issues. Rows and lexical references do not prove semantic workflow coverage. Framework implicit HEAD/OPTIONS and static assets are not independent workflows. AI/Dot listed for coverage only, excluded from implementation.',sourceDigest:hash(sourceFiles.sort().map(f=>`${f}\0${hash(read(f))}`).join('\n')),runtimeActions:constants('lib/staff-operation-runtime.ts').actions,summary:{routeMethods:routes.length,routeClassifications:count(routes),pages:pages.length,pageClassifications:count(pages),legacyReferenceFiles:legacyReferences.length,canonicalDirectReferences:directCanonicalReferences.length},sourceEntries:files,sourceIssues,matrixExportMismatches:mismatches,canonicalDirectReferences:directCanonicalReferences,legacyReferenceFiles:legacyReferences,layouts:files.filter(f=>entryKind(f)==='layout').map(file=>({file,directHelperEvidence:evidence(file)})),routes,pages};
}
}
export function buildInventory(rootDir=root) { return inventoryReader(rootDir)(); }
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const report=buildInventory();const content=JSON.stringify(report,null,2)+'\n';
 if(process.argv.includes('--write'))fs.writeFileSync(path.join(root,reportPath),content);
 else if(!fs.existsSync(path.join(root,reportPath))||fs.readFileSync(path.join(root,reportPath),'utf8')!==content){console.error('Inventory drift: regenerate and review with --write.');process.exitCode=1;}
 if(report.sourceIssues.length){console.error('Entry source issues require review.');process.exitCode=1;}
 if(report.matrixExportMismatches.length){console.error('Matrix/export discrepancies require review.');process.exitCode=1;}
 console.log(JSON.stringify({readiness:report.readiness,...report.summary}));
 if(process.argv.includes('--require-ready'))process.exitCode=1;
}
