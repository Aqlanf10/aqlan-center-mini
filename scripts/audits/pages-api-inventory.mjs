// Strict source discovery for Pages API routes.  This is lexical evidence,
// not proof of the handler's authorization or effects.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const ALLOWED = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const SOURCE = /\.(?:js|jsx|ts|tsx)$/;

/** Bound source paths must stay inside real lib directories, never via links. */
export function readPagesCoreSource(root, relative) {
  if (!/^lib\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.ts$/.test(relative)) throw new Error('invalid Pages API core path');
  const parts=relative.split('/'); let current=root;
  for (let i=0;i<parts.length;i++) {
    current=path.join(current,parts[i]); let stat;
    try { stat=fs.lstatSync(current); } catch { throw new Error('Pages API core handler source missing'); }
    if (stat.isSymbolicLink() || (i===parts.length-1 ? !stat.isFile() : !stat.isDirectory()))
      throw new Error('unsafe Pages API core handler source');
  }
  return fs.readFileSync(current,'utf8');
}

// Pages may inspect transport metadata and delegate a still-unconsumed request
// only to the reviewed shared body adapter. This rejects common raw stream and
// aliasing paths; it is a lexical guard, not proof of all downstream behavior.
function inspectRequestReferences(node) {
  let bodyAdapterImported=false;
  for (const s of node.statements) if (ts.isImportDeclaration(s) && s.moduleSpecifier.text==='@/lib/pages-body') {
    const named=s.importClause?.namedBindings;
    if (named && ts.isNamedImports(named) && named.elements.some(e=>e.name.text==='nodeRequestForBoundedJson'&&!e.propertyName&&!e.isTypeOnly)) bodyAdapterImported=true;
  }
  const allowedProperties=new Set(['headers','url','query','method']);
  function visit(n) {
    if (ts.isIdentifier(n) && n.text==='req') {
      const p=n.parent;
      if (ts.isParameter(p) && p.name===n) return;
      if (ts.isPropertyAccessExpression(p) && p.expression===n && allowedProperties.has(p.name.text)) return;
      if (ts.isCallExpression(p) && p.arguments[0]===n && ts.isIdentifier(p.expression)
          && (p.expression.text==='execute' || p.expression.text==='nodeRequestForBoundedJson'&&bodyAdapterImported)) return;
      throw new Error('unsupported Pages API request stream access or alias');
    }
    ts.forEachChild(n,visit);
  }
  visit(node);
}

export function inspectPagesHandler(file, source) {
  const node = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : file.endsWith('.jsx') ? ts.ScriptKind.JSX : file.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  if (node.parseDiagnostics.length) throw new Error('invalid Pages API syntax');
  inspectRequestReferences(node);
  const imports = node.statements.filter(s => ts.isImportDeclaration(s) && s.moduleSpecifier.text === '@/lib/pages-api');
  if (imports.length !== 1 || !imports[0].importClause?.namedBindings || !ts.isNamedImports(imports[0].importClause.namedBindings))
    throw new Error('missing direct definePagesApi import');
  const named = imports[0].importClause.namedBindings.elements.filter(e => e.name.text === 'definePagesApi' && !e.propertyName && !e.isTypeOnly);
  if (named.length !== 1) throw new Error('missing unaliased definePagesApi import');
  const configs = node.statements.filter(s => ts.isVariableStatement(s) && (s.declarationList.flags & ts.NodeFlags.Const)!==0 && s.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword))
    .flatMap(s=>s.declarationList.declarations.filter(d=>ts.isIdentifier(d.name)&&d.name.text==='config'));
  const config = configs[0]?.initializer;
  const api = config && ts.isObjectLiteralExpression(config) && config.properties.length === 1 && config.properties[0];
  const apiObject = api && ts.isPropertyAssignment(api) && ts.isIdentifier(api.name) && api.name.text === 'api' && api.initializer;
  const parser = apiObject && ts.isObjectLiteralExpression(apiObject) && apiObject.properties.length === 1 && apiObject.properties[0];
  if (configs.length !== 1 || !parser || !ts.isPropertyAssignment(parser) || !ts.isIdentifier(parser.name)
      || parser.name.text !== 'bodyParser' || parser.initializer.kind !== ts.SyntaxKind.FalseKeyword)
    throw new Error('Pages API must disable implicit body parsing');
  const exports = node.statements.filter(s => ts.isExportAssignment(s) && !s.isExportEquals);
  const executors=node.statements.filter(s=>ts.isFunctionDeclaration(s)&&s.name?.text==='execute');
  if (executors.length!==1 || !executors[0].body || executors[0].parameters.length!==4
      || executors[0].parameters.some(p=>!ts.isIdentifier(p.name)) || executors[0].parameters[0].name.text!=='req') throw new Error('ambiguous Pages API transport');
  const handlerName=executors[0].parameters[3].name.text;
  let handlerCalls=0;
  function scanTransport(n) {
    if (ts.isCallExpression(n)) {
      let target=n.expression;
      while (ts.isParenthesizedExpression(target)||ts.isAsExpression(target)||ts.isNonNullExpression(target)) target=target.expression;
      if (ts.isIdentifier(target)&&target.text===handlerName) handlerCalls++;
    }
    ts.forEachChild(n,scanTransport);
  }
  scanTransport(executors[0].body);
  if (!handlerCalls) throw new Error('Pages API transport never invokes its selected core handler');
  if (exports.length !== 1) throw new Error('missing unique Pages API dispatcher');
  const call = exports[0].expression;
  if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== 'definePagesApi'
      || call.arguments.length !== 1 || !ts.isObjectLiteralExpression(call.arguments[0])) throw new Error('ambiguous Pages API dispatcher');
  const methods = {};
  for (const property of call.arguments[0].properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) || !ALLOWED.has(property.name.text))
      throw new Error('unsupported Pages API method definition');
    const method = property.name.text, fn = property.initializer;
    if (Object.hasOwn(methods, method) || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))
      || !fn.modifiers?.some(mod => mod.kind === ts.SyntaxKind.AsyncKeyword)
      || fn.parameters.length !== 2 || fn.parameters.some(p => !ts.isIdentifier(p.name) || p.dotDotDotToken || p.initializer))
      throw new Error('ambiguous Pages API method implementation');
    if (fn.parameters[0].name.text!=='req') throw new Error('unsupported Pages API request name');
    if (!ts.isCallExpression(fn.body) || !ts.isIdentifier(fn.body.expression) || fn.body.expression.text !== 'execute'
        || fn.body.arguments.length !== 4 || !ts.isIdentifier(fn.body.arguments[0]) || fn.body.arguments[0].text !== fn.parameters[0].name.text
        || !ts.isIdentifier(fn.body.arguments[1]) || fn.body.arguments[1].text !== fn.parameters[1].name.text
        || !ts.isStringLiteral(fn.body.arguments[2]) || fn.body.arguments[2].text !== method || !ts.isIdentifier(fn.body.arguments[3]))
      throw new Error('Pages API method must bind a static core handler');
    methods[method] = fn.getText(node);
  }
  if (!Object.keys(methods).length) throw new Error('empty Pages API method table');
  return methods;
}

function coreEvidence(root, file, source, methods) {
  const node = ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const imported = new Map();
  for (const statement of node.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.moduleSpecifier.text.startsWith('@/lib/')) continue;
    const bindings=statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const item of bindings.elements) if (!item.isTypeOnly && !item.propertyName) imported.set(item.name.text,statement.moduleSpecifier.text);
  }
  const output={}, coreFiles=new Set();
  for (const [method,body] of Object.entries(methods)) {
    const callNode=ts.createSourceFile(file,`const probe = ${body}`,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
    const fn=callNode.statements[0]?.declarationList?.declarations[0]?.initializer;
    const target=fn?.body?.arguments?.[3]?.text;
    const specifier=imported.get(target);
    if (!specifier || !/^@\/lib\/[a-zA-Z0-9_/-]+$/.test(specifier)) throw new Error('Pages API core handler must be an unaliased lib import');
    const coreFile=`${specifier.slice(2)}.ts`, coreSource=readPagesCoreSource(root,coreFile);
    coreFiles.add(coreFile);
    const core=ts.createSourceFile(coreFile,coreSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
    const declarations=core.statements.filter(s=>ts.isFunctionDeclaration(s)&&s.name?.text===target&&s.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword));
    if (declarations.length!==1) throw new Error('Pages API core handler source ambiguous');
    output[method]=`${body}\n${declarations[0].getText(core)}`;
  }
  return { methods:output, coreFiles:[...coreFiles].sort() };
}

export function discoverPagesApi(root) {
  const base = path.join(root, 'pages', 'api'), entries = [], issues = [];
  if (!fs.existsSync(base)) return { entries, issues };
  function walk(dir) {
    for (const item of fs.readdirSync(dir, {withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
      const full = path.join(dir,item.name);
      if (item.isDirectory()) { walk(full); continue; }
      const file = path.relative(root,full).split(path.sep).join('/');
      if (!item.isFile() || !SOURCE.test(file) || /\.d\.ts$/.test(file)) {
        issues.push({file,reason:'unsupported Pages API source',classification:'unknown'}); continue;
      }
      let suffix = file.slice('pages/api/'.length).replace(SOURCE, '');
      suffix = suffix.replace(/(?:^|\/)index$/, '');
      const route = `/api${suffix ? `/${suffix}` : ''}`;
      if (/\[\.\.\.|\[\[/.test(route)) { issues.push({file,reason:'unsupported Pages API route',classification:'unknown'}); continue; }
      try { const source=fs.readFileSync(full,'utf8'), methods=inspectPagesHandler(file,source);
        entries.push({file,route,...coreEvidence(root,file,source,methods)}); }
      catch (error) { issues.push({file,reason:error.message,classification:'unknown'}); }
    }
  }
  walk(base);
  return { entries, issues };
}
