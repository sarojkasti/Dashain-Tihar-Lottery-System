// Optional Windows UI smoke test using the installed Edge browser and its DevTools protocol.
// It uses a temporary database and never opens the production database.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { openStore } from '../core.js';
import { initAuth, hashPassword } from '../auth.js';

const root=fileURLToPath(new URL('..',import.meta.url));
const temp=mkdtempSync(join(tmpdir(),'lottery-browser-'));
const password='Browser test password 123!',changedPassword='Changed browser password 456!';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort(){const s=createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;}
const port=await freePort(),debugPort=await freePort();
const db=openStore(join(temp,'test.sqlite'));initAuth(db);
const hash=await hashPassword(password);
db.prepare("INSERT INTO users(username,name,password_hash,role,must_change_password) VALUES('admin','Admin',?,'administrator',1)").run(hash);
db.prepare("INSERT INTO users(username,name,password_hash,role,must_change_password) VALUES('viewer','Viewer',?,'viewer',0)").run(hash);db.close();
let app,browser,ws,send;
try {
  app=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(port),LOTTERY_DB:join(temp,'test.sqlite'),HOST:'127.0.0.1'},stdio:'ignore',windowsHide:true});
  browser=spawn(process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',[
    '--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',`--remote-debugging-port=${debugPort}`,`--user-data-dir=${join(temp,'profile')}`,'about:blank'
  ],{stdio:'ignore',windowsHide:true});
  let targets;
  for(let i=0;i<30;i++){try{targets=await(await fetch(`http://127.0.0.1:${debugPort}/json`,{signal:AbortSignal.timeout(500)})).json();if(targets.some(t=>t.type==='page'))break;}catch{}await pause(100);}
  assert.ok(targets?.some(t=>t.type==='page'),'Edge DevTools did not become ready');
  ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await once(ws,'open');
  let seq=0;const pending=new Map(),errors=[];
  ws.addEventListener('message',event=>{const msg=JSON.parse(event.data);if(msg.id){const p=pending.get(msg.id);if(p){pending.delete(msg.id);msg.error?p.reject(Error(msg.error.message)):p.resolve(msg.result);}}else if(msg.method==='Runtime.exceptionThrown')errors.push(msg.params.exceptionDetails.text+': '+(msg.params.exceptionDetails.exception?.description||''));});
  send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(Error('DevTools timeout: '+method));},10000);pending.set(id,{resolve:r=>{clearTimeout(timer);resolve(r);},reject:e=>{clearTimeout(timer);reject(e);}});ws.send(JSON.stringify({id,method,params}));});
  async function evaluate(expression){const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;}
  async function wait(expression){for(let i=0;i<100;i++){if(await evaluate(expression))return;await pause(100);}throw Error('Browser wait failed: '+expression+'; '+await evaluate('document.body.innerText'));}
  async function form(selector,values){await evaluate(`(()=>{const form=document.querySelector(${JSON.stringify(selector)});for(const [key,value] of Object.entries(${JSON.stringify(values)}))form.elements[key].value=value;form.requestSubmit();})()`);}
  async function click(selector){await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);}
  await send('Runtime.enable');await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url:`http://127.0.0.1:${port}`});
  await wait('!!document.querySelector("#loginForm")');
  await form('#loginForm',{username:'admin',password});
  await wait('!!document.querySelector("#passwordForm")');
  await form('#passwordForm',{currentPassword:password,password:changedPassword,confirmPassword:changedPassword});
  await wait('document.querySelector("#title").textContent==="Overview"');
  await click('[data-page="Campaign settings"]');
  await form('#settings',{name:'Browser campaign',threshold:'2000',start:'2083/06/01',end:'2083/08/30'});
  await wait('document.querySelector("#notice").textContent==="Campaign saved."');
  await click('[data-page="SMS centre"]');
  assert.equal(await evaluate('!!document.querySelector("#sendSms")'),true);
  assert.equal(await evaluate('document.querySelector("#sendSms").disabled'),true);
  await click('#refreshSms');
  await wait('!!document.querySelector("#sendSms")');
  await click('[data-page="Users"]');await wait('!!document.querySelector("#userForm")');
  await form('#userForm',{username:'operator',name:'Operator Test',password,role:'operator',active:'true'});
  await wait('document.querySelector("#notice").textContent==="User saved."');
  assert.match(await evaluate('document.querySelector("#view").innerText'),/Operator Test/);
  await click('[data-page="Audit report"]');await wait('!!document.querySelector("#auditForm")');
  await form('#auditForm',{actor:'admin',event:'user created'});
  await wait('!!document.querySelector("#auditForm") && document.querySelector("#view").innerText.includes("1 records")');
  assert.match(await evaluate('document.querySelector("#view table").innerText'),/operator/);
  mkdirSync(join(root,'.browser-check'),{recursive:true});
  const screenshot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
  writeFileSync(join(root,'.browser-check','audit-report.png'),Buffer.from(screenshot.data,'base64'));
  await click('#logout');await wait('!!document.querySelector("#loginForm")');
  await form('#loginForm',{username:'viewer',password});await wait('!document.body.classList.contains("signed-out")');
  assert.equal(await evaluate('!!document.querySelector("#nav [data-page=Users]")'),false);
  await click('[data-page="SMS centre"]');
  assert.equal(await evaluate('!!document.querySelector("#sendSms")'),false);
  await click('[data-page="Tickets"]');assert.equal(await evaluate('!!document.querySelector("#assign")'),false);
  await click('[data-page="Sales & returns"]');assert.equal(await evaluate('!!document.querySelector("#file")'),false);
  await click('[data-page="SMS centre"]');assert.equal(await evaluate('!!document.querySelector("#export")'),false);
  await click('#logout');await wait('!!document.querySelector("#loginForm")');
  assert.deepEqual(errors,[]);
  console.log('Browser checks passed: login, required password change, campaign creation, user creation, audit filters, logout and viewer controls.');
} finally {
  if(send){try{await send('Browser.close');}catch{}}
  ws?.close();
  for(const process of [app,browser])if(process && process.exitCode===null){const done=once(process,'exit');process.kill();await Promise.race([done,pause(3000)]);}
  try{rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:200});}catch{console.warn('Temporary browser profile remains at '+temp);}
}
