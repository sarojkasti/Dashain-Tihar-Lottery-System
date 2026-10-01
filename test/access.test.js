import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { openStore, audit, auditContext } from '../core.js';
import { initAuth, hashPassword, verifyPassword } from '../auth.js';
import { auditReport } from '../audit-report.js';
import ExcelJS from 'exceljs';

test('legacy audit migration preserves records, attribution is isolated, and reports filter and escape CSV', async()=>{
  const dir=mkdtempSync(join(tmpdir(),'lottery-migration-')),path=join(dir,'legacy.sqlite');
  try {
    const old=new DatabaseSync(path);
    old.exec("CREATE TABLE audit(id INTEGER PRIMARY KEY,campaign INTEGER,event TEXT,detail TEXT,created TEXT DEFAULT CURRENT_TIMESTAMP); INSERT INTO audit(event,detail) VALUES('old entry','original')");old.close();
    const db=openStore(path);
    assert.equal(db.prepare('SELECT detail FROM audit WHERE id=1').get().detail,'original');
    await Promise.all(['alice','bob'].map((username,i)=>auditContext.run({user:{id:i+1,username},ip:`192.168.1.${i+1}`},async()=>{
      await new Promise(r=>setTimeout(r,10-i*5));audit(db,null,'test',username==='alice'?'=SUM(1,2)':'bob action');
    })));
    const filtered=auditReport(db,new URLSearchParams({actor:'alice'}));
    assert.equal(filtered.total,1);assert.equal(filtered.rows[0].ip,'192.168.1.1');
    const csv=auditReport(db,new URLSearchParams({actor:'alice'}),true);
    assert.match(csv,/'=SUM/);assert.doesNotMatch(csv,/bob action/);
    assert.throws(()=>auditReport(db,new URLSearchParams({from:'2026-02-30'})),/valid/);
    assert.throws(()=>db.exec("UPDATE audit SET event='tampered'"),/cannot be edited/);
    assert.throws(()=>db.exec('DELETE FROM audit'),/cannot be deleted/);
    db.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('authenticated API enforces roles, CSRF, password resets, preview ownership and audit reporting',async(t)=>{
  const dir=mkdtempSync(join(tmpdir(),'lottery-access-')),path=join(dir,'test.sqlite');
  const db=openStore(path);initAuth(db);
  const password='Test-only password 123!',newPassword='Changed test password 456!';
  const hash=await hashPassword(password);
  assert.notEqual(hash,password);assert.equal(await verifyPassword(password,hash),true);assert.equal(await verifyPassword('incorrect',hash),false);
  for(const [username,role,change] of [['admin','administrator',0],['operator','operator',0],['viewer','viewer',0],['temporary','viewer',1]]) {
    db.prepare('INSERT INTO users(username,name,password_hash,role,must_change_password) VALUES(?,?,?,?,?)').run(username,username,hash,role,change);
  }
  const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
  const child=spawn(process.execPath,['server.js'],{cwd:new URL('..',import.meta.url),env:{...process.env,LOTTERY_DB:path,PORT:String(port),HOST:'0.0.0.0'},stdio:['ignore','pipe','pipe'],windowsHide:true});
  let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);
  t.after(async()=>{if(child.exitCode===null){child.kill();await once(child,'exit');}db.close();rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${port}`;
  for(let i=0;i<100;i++){try{await fetch(base+'/api/session');break;}catch{if(i===99)throw Error(output);await new Promise(r=>setTimeout(r,50));}}
  async function request(path,data,client={},extra={}) {
    const response=await fetch(base+'/api/'+path,{method:data===undefined?'GET':'POST',headers:{...(data===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':client.csrf||''}),...(client.cookie?{Cookie:client.cookie}:{}),...extra},body:data===undefined?undefined:JSON.stringify(data)});
    const text=await response.text();let value;try{value=JSON.parse(text);}catch{value=text;}
    return {status:response.status,value,cookie:response.headers.get('set-cookie')?.split(';')[0],headers:response.headers};
  }
  async function login(username,pass=password) {
    const r=await request('login',{username,password:pass});assert.equal(r.status,200,JSON.stringify(r.value));
    assert.match(r.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);return {cookie:r.cookie,csrf:r.value.csrf};
  }
  assert.equal((await request('state')).status,401);
  assert.equal((await request('users')).status,401);
  assert.equal((await request('audit.csv')).status,401);
  const invalidHostStatus=await new Promise((resolve,reject)=>{const req=httpRequest(base+'/api/session',{headers:{Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});
  assert.equal(invalidHostStatus,403);
  assert.equal((await request('login',{username:'admin',password}, {},{Origin:'http://evil.example'})).status,403);
  const admin=await login('admin'),operator=await login('operator'),viewer=await login('viewer'),temporary=await login('temporary');
  for(const client of [operator,viewer]) {
    assert.equal((await request('sms-settings',undefined,client)).status,403);
    assert.equal((await request('sms-settings',{token:'test-token'},client)).status,403);
  }
  assert.equal((await request('sms-settings',{token:'test-token'},{cookie:admin.cookie})).status,403);
  assert.equal((await request('sms-settings',{token:''},admin)).status,400);
  const saved=await request('sms-settings',{token:'test-private-token'},admin);
  assert.deepEqual(saved.value,{configured:true});
  const settings=await request('sms-settings',undefined,admin);
  assert.deepEqual(settings.value,{configured:true});
  assert.doesNotMatch(JSON.stringify((await request('audit',undefined,admin)).value),/test-private-token/);
  assert.equal((await request('sms-settings',{disable:true},admin)).value.configured,false);
  assert.equal((await request('state',undefined,temporary)).status,403);
  const changed=await request('password',{currentPassword:password,password:newPassword},temporary);
  assert.equal(changed.status,200);assert.equal(changed.value.user.mustChangePassword,false);
  assert.equal((await request('state',undefined,temporary)).status,401);
  assert.equal((await request('state',undefined,{cookie:changed.cookie,csrf:changed.value.csrf})).status,200);
  assert.equal((await request('campaign',{name:'Forbidden'},operator)).status,403);
  for(const endpoint of ['campaign','preview','import','assign','sms-send','sms-resolve','retry','users'])assert.equal((await request(endpoint,{},viewer)).status,403,endpoint);
  assert.equal((await request('audit',undefined,operator)).status,403);
  assert.equal((await request('users',undefined,viewer)).status,403);
  const campaign={name:'Test campaign',start:'2083/05/01',end:'2083/08/30',threshold:2000};
  assert.equal((await request('campaign',campaign,{cookie:admin.cookie})).status,403);
  assert.equal((await request('campaign',campaign,admin)).status,200);
  const wb=new ExcelJS.Workbook(),ws=wb.addWorksheet('Sales');ws.addRow(['Date BS','Invoice No','TotalNet Amount','Phone Number']);ws.addRow(['2083/6/8','WEB-1',4000,'9800000000']);
  const preview=await request('preview',{campaign:1,kind:'sale',filename:'test.xlsx',file:Buffer.from(await wb.xlsx.writeBuffer()).toString('base64')},operator);
  assert.equal(preview.status,200,JSON.stringify(preview.value));
  assert.equal((await request('import',{id:preview.value.id,references:['WEB-1']},admin)).status,403);
  assert.equal((await request('import',{id:preview.value.id,references:['WEB-1']},operator)).status,200);
  assert.equal((await request('assign',{campaign:1,threshold:200000,count:2},operator)).value.count,2);
  assert.equal((await request('state',undefined,viewer)).value.tickets.length,2);
  const report=await request('audit?actor=operator&event=import',undefined,admin);
  assert.equal(report.value.total,1);assert.equal(report.value.rows[0].actor,'operator');assert.equal(report.value.rows[0].campaign,1);
  const csv=await request('audit.csv?actor=operator&event=import',undefined,admin);assert.equal(csv.status,200);assert.match(csv.value,/operator/);
  const user=await request('users',{username:'newuser',name:'New User',role:'viewer',active:true,password},admin);assert.equal(user.status,200);
  assert.equal((await request('users',undefined,admin)).value.users.some(u=>'password_hash' in u),false);
  assert.equal((await request('users',{id:1,username:'admin',name:'Admin',role:'viewer',active:true},admin)).status,400);
  assert.equal((await request('users',{id:3,username:'viewer',name:'Viewer',role:'viewer',active:false},admin)).status,200);
  assert.equal((await request('state',undefined,viewer)).status,401);
  assert.equal((await request('login',{username:'viewer',password})).status,401);
  assert.equal((await request('users',{id:2,username:'operator',name:'Operator',role:'viewer',active:true},admin)).status,200);
  assert.equal((await request('state',undefined,operator)).status,401);
  const relogged=await login('operator');assert.equal((await request('assign',{},relogged)).status,403);
  assert.equal((await request('users',{id:2,username:'operator',name:'Operator',role:'operator',active:true,password:newPassword},admin)).status,200);
  assert.equal((await request('state',undefined,relogged)).status,401);
  assert.equal((await request('login',{username:'operator',password})).status,401);
  const reset=await login('operator',newPassword);assert.equal((await request('state',undefined,reset)).status,403);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit WHERE detail LIKE ?").get('%'+password+'%').n,0);
  for(let i=0;i<10;i++)assert.equal((await request('login',{username:'nobody',password:'wrong'})).status,401);
  assert.equal((await request('login',{username:'nobody',password:'wrong'})).status,429);
  assert.equal((await request('logout',{},admin)).status,200);
  assert.equal((await request('state',undefined,admin)).status,401);
});
