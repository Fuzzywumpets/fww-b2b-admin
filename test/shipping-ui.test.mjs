import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
// DEPENDS: the Brain's Jarvis text console owns 8905, so CI/operators can
// select a collision-free port without changing this browser contract.
const testPort=process.env.SHIPPING_UI_TEST_PORT || '8905';
const base=`http://127.0.0.1:${testPort}`;
const server=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:testPort,B2B_ADMIN_MOCK:'1'},stdio:'ignore'});
let browser;
try {
 for(let i=0;i<60;i++){try{if((await fetch(base+'/healthz')).ok)break;}catch{} await new Promise(r=>setTimeout(r,100));}
 assert.equal((await fetch(base+'/orders/1001/shipping-charge',{method:'POST',redirect:'manual'})).status,302);
 browser=await chromium.launch({headless:true});
 const page=await browser.newPage();
 await page.goto(base+'/auth/login');
 await page.goto(base+'/orders/1001');
 const form=page.locator('form[action="/orders/1001/shipping-charge"]');
 const old=await form.locator('[name=expectedAmount]').inputValue();
 const key=await form.locator('[name=idemKey]').inputValue();
 await form.getByLabel('Service').fill('UPS');
 await form.getByLabel('Amount (USD)').fill('45.00');
 await Promise.all([page.waitForURL('**success=shipping_saved'),form.getByRole('button',{name:'Save shipping charge'}).click()]);
 assert.match(await page.locator('.alert-success').innerText(),/Shipping charge updated/);
 assert.equal(await page.locator('[name=amount]').first().inputValue(),'45.00');
 const state1=await (await page.request.get(base+'/api/orders/1001/line-state')).json();
 const replay=await page.request.post(base+'/orders/1001/shipping-charge',{form:{amount:'45.00',expectedAmount:old,title:'UPS',idemKey:key}});
 assert.match(replay.url(),/success=shipping_saved/);
 const state2=await (await page.request.get(base+'/api/orders/1001/line-state')).json();
 assert.equal(state1.total,state2.total);
 const stale=await page.request.post(base+'/orders/1001/shipping-charge',{form:{amount:'20',expectedAmount:old,title:'UPS',idemKey:crypto.randomUUID()}});
 assert.match(stale.url(),/error=shipping_failed/);
 const bad=await page.request.post(base+'/orders/1001/shipping-charge',{form:{amount:'',expectedAmount:'45',title:'UPS',idemKey:crypto.randomUUID()}});
 assert.match(bad.url(),/error=shipping_failed/);
 await page.setViewportSize({width:390,height:844});
 await page.goto(base+'/orders/1001');
 assert.equal(await page.locator('[name=amount]').first().inputValue(),'45.00');
 const box=await page.locator('form[action="/orders/1001/shipping-charge"]').boundingBox();
 assert.ok(box.x>=0 && box.x+box.width<=391,JSON.stringify(box));
 const pdf=await page.request.get(base+'/orders/1001/invoice.pdf');
 assert.equal(pdf.status(),200);assert.equal((await pdf.body()).subarray(0,4).toString(),'%PDF');
 console.log('PASS: browser save, replacement amount, unchanged replay total, stale/invalid refusal, mobile form, PDF generation');
} finally {await browser?.close();server.kill();}
