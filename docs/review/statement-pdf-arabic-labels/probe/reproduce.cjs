async function main() {
const {chromium}=await import('playwright');
const path=await import('node:path');
const fs=await import('node:fs');
const {execFileSync}=await import('node:child_process');
const output=process.argv[2];if(!output)throw new Error('Pass an empty output directory');
fs.mkdirSync(output,{recursive:true});
const labels=['صافي المحصّل بعد الاستردادات وعكس السندات','إجمالي المفوتر','الرصيد الحالي','المسدّد من الاتفاق','المتبقي من الاتفاق','إيصال قبض','فاتورة علاج','المبلغ المستلم','بلا رسوم'];
const plain=s=>s.normalize('NFKC').replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,'');
const key=s=>s.replace(/[\u064B-\u0652]/g,'').replace(/ا([اأإآ])ل/g,'ال$1');
const b=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium'});const results=[];
try{for(const[name,font,features]of [['naskh','Noto Naskh Arabic',''],['naskh-calt-off','Noto Naskh Arabic','"calt" 0'],['naskh-kern-off','Noto Naskh Arabic','"kern" 0'],['naskh-mark-off','Noto Naskh Arabic','"mark" 0,"mkmk" 0'],['naskh-mark-only','Noto Naskh Arabic','"mark" 0'],['naskh-mkmk-only','Noto Naskh Arabic','"mkmk" 0'],['plex','WitnessPlex',''],['scoped-subset','WitnessSubset','']]){
 const p=await b.newPage({viewport:{width:1000,height:600},deviceScaleFactor:4});
 const data=fs.readFileSync(path.resolve('app/fonts/plex-arabic-400.woff2')).toString('base64');
 const subset=fs.readFileSync(path.resolve('app/fonts/statement-labels.woff')).toString('base64');
 const html=`<!doctype html><html dir="rtl"><meta charset="utf-8"><style>@font-face{font-family:WitnessSubset;src:url(data:font/woff;base64,${subset}) format('woff');font-weight:400}@font-face{font-family:WitnessPlex;src:url(data:font/woff2;base64,${data}) format('woff2');font-weight:400}body{font-family:'${font}',sans-serif;font-feature-settings:${features||'normal'};padding:8mm}.line{display:flex;justify-content:space-between;gap:4mm;font-size:9pt;margin:1mm 0}</style>${labels.map(l=>`<div class="line"><span>${l}</span><span>1,300.00 ر.س</span></div>`).join('')}</html>`;
 await p.setContent(html);await p.evaluate(()=>document.fonts.ready);const pdf=output+'/'+name+'.pdf';await p.pdf({path:pdf,format:'A4',printBackground:true});await p.screenshot({path:output+'/'+name+'.png'});await p.locator('.line').first().locator('span').first().screenshot({path:output+'/'+name+'-label.png'});await p.locator('.line').nth(3).locator('span').first().screenshot({path:output+'/'+name+'-paid.png'});
 const text=plain(execFileSync('pdftotext',['-layout','-enc','UTF-8',pdf,'-'],{encoding:'utf8'}));fs.writeFileSync(output+'/'+name+'.txt',text);
 results.push({name,font,features,text,missing:labels.filter(l=>text.split('\n').filter(r=>key(r).includes(key(l))&&/\d/.test(r)).length!==1)});await p.close();
}}finally{await b.close()}fs.writeFileSync(output+'/results.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));}
main().catch(e=>{console.error(e);process.exitCode=1});
