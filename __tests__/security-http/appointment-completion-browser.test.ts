import {afterAll,beforeAll,expect,it} from 'vitest';
import {chromium,type Browser} from 'playwright';
import {mkdir} from 'node:fs/promises';
import {baseUrl,harness,TEST_PATIENTS} from './_server';
let browser:Browser,h:Awaited<ReturnType<typeof harness>>;
beforeAll(async()=>{h=await harness();browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium'});});
afterAll(async()=>{await browser?.close();});

it.each([1280,390])('recovers a committed lost response after reload at RTL %ipx without a second booking',async width=>{
  const context=await browser.newContext({viewport:{width,height:900},locale:'ar-YE',timezoneId:width===1280?'Asia/Aden':'America/New_York'});
  const [name,...parts]=h.sessions.reception.cookie.split('=');
  await context.addCookies([{name,value:parts.join('='),url:baseUrl}]);
  const page=await context.newPage();let writes=0,committedId=0,commandId='';
  const date=width===1280?'2038-06-10':'2038-06-11';
  const bookedTime=width===1280?'09:30':'15:30';
  try {
    await page.route('**/api/patients?*',route=>route.fulfill({json:[{id:h.seeded.patientAId,fullName:'Synthetic recovery patient',patientNumber:'SYN-RECOVERY',phone:null}]}));
    await page.route('**/api/appointments',async route=>{
      if(route.request().method()!=='POST'){await route.continue();return;}
      writes++;commandId=route.request().postDataJSON().commandId;
      const response=await route.fetch();
      expect(response.status()).toBe(201);
      committedId=(await response.json()).id;
      await route.abort('failed'); // The real server already committed the synthetic booking.
    });
    await page.goto(`${baseUrl}/appointments?date=${date}`,{waitUntil:'networkidle'});
    await page.getByRole('button',{name:/حجز موعد جديد/}).click();
    let dialog=page.getByRole('dialog');
    await dialog.getByLabel('المريض',{exact:true}).fill('Synthetic recovery');
    await dialog.getByRole('button',{name:/Synthetic recovery patient/}).click();
    await dialog.getByLabel('التصنيف السريري للموعد',{exact:true}).selectOption('orthodontics');
    await dialog.locator('input[type=date]').fill(date);
    await dialog.locator('input[type=time]').fill(bookedTime);
    await dialog.locator('button[type=submit]').click();
    await page.getByText('يوجد طلب حجز لم تتأكد نتيجته. لا تنشئ موعدًا ثانيًا.').waitFor();
    await expect.poll(()=>committedId).toBeGreaterThan(0);
    await expect.poll(()=>dialog.getByRole('button',{name:'تحقّق من نتيجة الحجز',exact:true}).isEnabled()).toBe(true);
    expect(writes).toBe(1);
    expect(await dialog.getByRole('button',{name:'أعد نفس الطلب',exact:true}).isDisabled()).toBe(true);
    expect(await dialog.locator('input[type=time]').isDisabled()).toBe(true);
    await mkdir('docs/review/appointments-completion/evidence',{recursive:true});
    await page.screenshot({path:`docs/review/appointments-completion/evidence/recovery-pending-${width}.png`,fullPage:true});
    await page.reload({waitUntil:'networkidle'});
    await page.getByRole('button',{name:/حجز موعد جديد/}).click();dialog=page.getByRole('dialog');
    await dialog.getByText('يوجد طلب حجز لم تتأكد نتيجته. لا تنشئ موعدًا ثانيًا.',{exact:true}).waitFor();
    expect(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('aqlan.appointment.pending.v1')!).commandId)).toBe(commandId);
    await dialog.getByRole('button',{name:'تحقّق من نتيجة الحجز',exact:true}).click();
    await dialog.waitFor({state:'hidden'});
    const response=await page.request.get(`${baseUrl}/api/appointments?date=${date}`);
    expect(response.status()).toBe(200);
    const appointments=await response.json();
    expect(appointments.filter((item:{id:number})=>item.id===committedId)).toHaveLength(1);
    expect(appointments.find((item:{id:number})=>item.id===committedId)).toMatchObject({clinicalCategory:'orthodontics',scheduledTime:bookedTime});
    expect(writes).toBe(1);
    // Inspect the draft URL only: no WhatsApp navigation or message sending.
    const reminder=page.locator(`[data-appointment="${committedId}"] a[href^="https://wa.me/"]`).first();
    await reminder.waitFor();
    const text=new URL((await reminder.getAttribute('href'))!).searchParams.get('text');
    expect(text).toContain(width===1280?'9:30':'3:30');expect(text).not.toContain(width===1280?'10:30':'4:30');
    expect(await page.locator('body').evaluate(node=>node.scrollWidth<=window.innerWidth)).toBe(true);
    await page.screenshot({path:`docs/review/appointments-completion/evidence/recovered-board-${width}.png`,fullPage:true});
    const row=page.locator(`[data-appointment="${committedId}"]`);
    await row.getByRole('button',{name:'تأكيد المريض عبر الموظف',exact:true}).click();
    await row.getByText('أكده الموظف: secreception',{exact:true}).waitFor();
    await row.getByRole('combobox',{name:/تصنيف موعد/}).selectOption('endodontics');
    await row.locator('[data-clinical-category="endodontics"]').waitFor();
    const after=await (await page.request.get(`${baseUrl}/api/appointments?date=${date}`)).json();
    expect(after.find((item:{id:number})=>item.id===committedId)).toMatchObject({status:'booked',clinicalCategory:'endodontics',staffConfirmedBy:'secreception'});
    await page.unroute('**/api/patients?*');
    await page.goto(`${baseUrl}/patients`,{waitUntil:'networkidle'});
    const categories=page.getByRole('group',{name:'مرضى حسب تصنيف المواعيد'});
    await Promise.all([
      page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==='/api/patients' && url.searchParams.get('appointmentCategory')==='endodontics' && !url.searchParams.get('q');}),
      categories.getByRole('button',{name:'علاج عصب',exact:true}).click(),
    ]);
    const patient=page.locator(`a[href="/patients/${h.seeded.patientAId}"]`);
    await patient.waitFor();
    await Promise.all([
      page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==='/api/patients' && url.searchParams.get('appointmentCategory')==='endodontics' && url.searchParams.get('q')===TEST_PATIENTS.patientA.patientNumber;}),
      page.getByLabel('بحث عن مريض').fill(TEST_PATIENTS.patientA.patientNumber),
    ]);
    await expect.poll(()=>page.locator(`a[href="/patients/${h.seeded.patientBId}"]`).count()).toBe(0);
    await expect.poll(()=>page.locator('main li a[href^="/patients/"]').count()).toBe(1);
    await patient.waitFor();
    await page.getByText('يشمل التصنيف المسجل في المواعيد السابقة؛ لا يحدد حالة العلاج الحالية.',{exact:true}).waitFor();
    expect(await page.locator('body').evaluate(node=>node.scrollWidth<=window.innerWidth)).toBe(true);
    await page.screenshot({path:`docs/review/appointments-completion/evidence/patient-categories-${width}.png`,fullPage:true});
    await Promise.all([
      page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==='/api/patients' && url.searchParams.get('appointmentCategory')==='awaiting_prosthetics' && url.searchParams.get('q')===TEST_PATIENTS.patientA.patientNumber;}),
      categories.getByRole('button',{name:'بانتظار التركيبات',exact:true}).click(),
    ]);
    await page.getByText('لا توجد نتائج مطابقة لخيارات البحث أو الفلتر.',{exact:true}).waitFor();
    expect(await patient.count()).toBe(0);
  } finally {await context.close();}
});

it('after an unsent request, lookup404 permits only an exact same-key replay',async()=>{
  const context=await browser.newContext({viewport:{width:390,height:900}});
  const [name,...parts]=h.sessions.reception.cookie.split('=');await context.addCookies([{name,value:parts.join('='),url:baseUrl}]);
  const page=await context.newPage();const bodies:string[]=[];
  try {
    await page.route('**/api/patients?*',route=>route.fulfill({json:[{id:h.seeded.patientBId,fullName:'Synthetic retry patient',patientNumber:'SYN-RETRY',phone:null}]}));
    await page.route('**/api/appointments',async route=>{
      if(route.request().method()!=='POST'){await route.continue();return;}
      bodies.push(route.request().postData()!);
      if(bodies.length===1)await route.abort('failed');else await route.continue();
    });
    await page.goto(`${baseUrl}/appointments?date=2038-06-12`,{waitUntil:'networkidle'});
    await page.getByRole('button',{name:/حجز موعد جديد/}).click();const dialog=page.getByRole('dialog');
    await dialog.getByLabel('المريض',{exact:true}).fill('Synthetic retry');await dialog.getByRole('button',{name:/Synthetic retry patient/}).click();
    await dialog.getByLabel('التصنيف السريري للموعد',{exact:true}).selectOption('filling');
    await dialog.locator('input[type=date]').fill('2038-06-12');
    await dialog.locator('button[type=submit]').click();
    await page.getByText('يوجد طلب حجز لم تتأكد نتيجته. لا تنشئ موعدًا ثانيًا.').waitFor();
    await dialog.getByRole('button',{name:'تحقّق من نتيجة الحجز',exact:true}).click();
    await page.getByText('لم يُعثر على نتيجة بعد.',{exact:false}).waitFor();
    await dialog.getByRole('button',{name:'أعد نفس الطلب',exact:true}).click();await dialog.waitFor({state:'hidden'});
    expect(bodies).toHaveLength(2);expect(bodies[0]).toBe(bodies[1]);
  } finally {await context.close();}
});

it.each(['Asia/Aden','America/New_York'])('uses clinic tomorrow across midnight in browser timezone %s',async timezoneId=>{
  const context=await browser.newContext({timezoneId,viewport:{width:390,height:900}});
  const [name,...parts]=h.sessions.reception.cookie.split('=');await context.addCookies([{name,value:parts.join('='),url:baseUrl}]);
  const page=await context.newPage();
  try {
    await page.clock.install({time:new Date('2038-06-10T22:30:00Z')});
    await page.goto(`${baseUrl}/appointments`,{waitUntil:'networkidle'});
    await page.getByRole('button',{name:/حجز موعد جديد/}).click();
    const date=page.getByRole('dialog').locator('input[type=date]');
    await expect.poll(()=>date.inputValue()).toBe('2038-06-12');
  } finally {await context.close();}
});
