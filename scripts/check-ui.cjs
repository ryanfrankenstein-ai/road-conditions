const { chromium } = require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const artifacts=path.join(root,'.test-artifacts');
fs.mkdirSync(artifacts,{recursive:true});
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
 const page=await browser.newPage({viewport:{width:1440,height:1100},deviceScaleFactor:1,colorScheme:'light'});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.clock.install({time:new Date('2026-11-06T14:00:00Z')});
 let mode='normal';
 const start=new Date('2026-11-06T14:00:00Z');start.setUTCHours(0,0,0,0);
 const periods=Array.from({length:240},(_,i)=>{const t=new Date(+start+i*3600000);const rough=t.getUTCDay()===2;return {startTime:t.toISOString(),endTime:new Date(+t+3600000).toISOString(),temperature:rough?30:48,shortForecast:rough?'Snow':'Partly Sunny',windSpeed:rough?'25 mph':'5 to 10 mph',windDirection:'NW',probabilityOfPrecipitation:{value:rough?70:10},isDaytime:t.getUTCHours()>12};});
 await page.route('https://api.weather.gov/**',async route=>{
  if(mode==='offline')return route.abort();
  const url=route.request().url();let body;
  if(url.includes('/points/'))body={properties:{forecastHourly:'https://api.weather.gov/test-hourly/'+url.split('/').pop()}};
  else if(url.includes('/alerts/'))body={features:mode==='alert'?[{properties:{id:'test-alert',event:'Winter Storm Warning',headline:'Test warning: snow and wind expected along Highway 71.',onset:start.toISOString(),ends:new Date(+start+240*3600000).toISOString()}}]:[]};
  else {body={properties:{periods:mode==='clear'?periods.map(p=>({...p,shortForecast:'Partly Sunny',windSpeed:'5 to 10 mph',temperature:48,probabilityOfPrecipitation:{value:10}})):periods}};}
  await route.fulfill({json:body});
 });
 await page.route('http://127.0.0.1:4173/**', async route=>{ const file=new URL(route.request().url()).pathname.slice(1)||'index.html'; if(!['index.html','styles.css','roads.json','theme.js'].includes(file))return route.fulfill({status:404,body:''}); await route.fulfill({path:path.join(root,file),contentType:file.endsWith('.css')?'text/css':file.endsWith('.json')?'application/json':file.endsWith('.js')?'text/javascript':'text/html'}); });
 await page.goto('http://127.0.0.1:4173/');await page.waitForFunction(()=>document.querySelectorAll('.drive-card').length===3);
 assert.equal(await page.locator('h1').count(),1);
 assert.equal(await page.locator('.cell').count(),15);
 assert.equal(await page.locator('.win').count(),6);
 assert.match(await page.locator('#hero').innerText(),/Avoid|Rough/);
 await page.locator('.dh').nth(2).click();assert.equal(await page.locator('.dh[aria-pressed="true"]').count(),1);
 assert.equal(await page.locator('.cell[aria-pressed="true"]').count(),3);
 const selected=await page.locator('#detail h2').innerText();assert.match(selected,/Tuesday/);
 assert.equal(await page.locator('.dh').nth(2).evaluate(el=>el===document.activeElement),true);
 await page.screenshot({path:path.join(artifacts,'desktop-preview.png'),fullPage:true});
 for(const width of [320,375,390,580,768,1024,1440]){
  await page.setViewportSize({width,height:900});
  const result=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,small:[...document.querySelectorAll('button,.btn,select')].filter(e=>e.getBoundingClientRect().height<44).map(e=>e.className)}));
  assert.ok(result.scroll<=width,`Overflow at ${width}: ${result.scroll}`);assert.deepEqual(result.small,[],`Small touch targets at ${width}`);
 }
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(artifacts,'mobile-preview.png'),fullPage:true});
 mode='alert';await page.click('#refresh');await page.waitForFunction(()=>!document.querySelector('#refresh').disabled);
 assert.equal(await page.locator('.alert').count(),1);await page.locator('.alert summary').click();assert.equal(await page.locator('.alert[open]').count(),1);assert.match(await page.locator('#hero').innerText(),/Avoid/);
 mode='offline';await page.click('#refresh');await page.waitForFunction(()=>!document.querySelector('#refresh').disabled);assert.equal(await page.locator('.err').count(),1);assert.match(await page.locator('#updated').innerText(),/Last attempted/);
 await page.click('#refresh');await page.waitForFunction(()=>!document.querySelector('#refresh').disabled);assert.equal(await page.locator('.err').count(),1);
 mode='normal';await page.click('#refresh');await page.waitForFunction(()=>!document.querySelector('#refresh').disabled);assert.equal(await page.locator('.err').count(),0);assert.equal(await page.locator('.alert').count(),0);
 mode='clear';await page.click('#refresh');await page.waitForFunction(()=>!document.querySelector('#refresh').disabled);assert.match(await page.locator('#hero').innerText(),/Clear driving through/);
 await page.evaluate(()=>{GAMES.push({date:'2026-11-06',sport:'Basketball',opponent:'Spirit Lake',time:'19:00',home:true});renderGames();});
 assert.match(await page.locator('#games').innerText(),/Basketball vs Spirit Lake/);assert.equal(await page.locator('#games .now').count(),1);
 // Auto follows system changes; explicit choices override them and survive reloads.
 assert.equal(await page.locator('html').getAttribute('data-theme'),'light');
 await page.emulateMedia({colorScheme:'dark'});
 await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
 assert.equal(await page.locator('#appearance').inputValue(),'system');
 assert.equal(await page.locator('meta[name="theme-color"]').getAttribute('content'),'#111e19');
 await page.selectOption('#appearance','light');
 await page.reload();await page.waitForFunction(()=>document.querySelectorAll('.drive-card').length===3);
 assert.equal(await page.locator('html').getAttribute('data-theme'),'light');
 assert.equal(await page.locator('#appearance').inputValue(),'light');
 await page.selectOption('#appearance','dark');
 await page.emulateMedia({colorScheme:'light'});
 await page.reload();await page.waitForFunction(()=>document.querySelectorAll('.drive-card').length===3);
 assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
 assert.equal(await page.locator('#appearance').inputValue(),'dark');
 for(const width of [320,375,390,580,768,1024,1440]){
  await page.setViewportSize({width,height:900});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`Dark overflow at ${width}`);
 }
 await page.setViewportSize({width:1440,height:1100});
 await page.screenshot({path:path.join(artifacts,'dark-desktop-preview.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:path.join(artifacts,'dark-mobile-preview.png'),fullPage:true});
 await page.selectOption('#appearance','system');
 assert.equal(await page.locator('html').getAttribute('data-theme'),'light');
 // Storage restrictions should not prevent switching appearance.
 await page.addInitScript(()=>{Storage.prototype.getItem=()=>{throw new Error('Storage blocked')};Storage.prototype.setItem=()=>{throw new Error('Storage blocked')};});
 await page.emulateMedia({colorScheme:'dark'});
 await page.reload();await page.waitForFunction(()=>document.querySelectorAll('.drive-card').length===3);
 assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
 await page.selectOption('#appearance','light');
 assert.equal(await page.locator('html').getAttribute('data-theme'),'light');
 assert.deepEqual(errors,[]);console.log('PASS: forecast rendering, day selection, 7 responsive widths, 44px control heights, alerts, refresh, outage, recovery, system appearance, saved overrides, dark responsive layouts and blocked storage.');
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});

