import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../core.js';
import { initSms, queueSms, resolveSms, queueFailedSmsRetry, createSmsWorker, smsTokenFor, saveSmsSettings } from '../sms.js';

function fixture(t) {
  const db=openStore();initSms(db);initSms(db);t.after(()=>db.close());
  db.exec(`INSERT INTO campaigns VALUES(1,'Test','2083/01/01','2083/12/30',100);
    INSERT INTO customers VALUES(1,1,'9800000000','Customer',0);
    INSERT INTO messages(id,campaign,customer,message) VALUES('one',1,1,'Ticket 123'),('two',1,1,'Ticket 456');`);
  return db;
}
const status=(db,id='one')=>db.prepare('SELECT status FROM messages WHERE id=?').get(id).status;

test('saved settings override environment, apply to existing worker, and disable queued sends',async t=>{
  const db=fixture(t);assert.equal(smsTokenFor(db,'environment-token'),'environment-token');
  let observed;
  const worker=createSmsWorker(db,{getToken:()=>smsTokenFor(db),fetchImpl:async(url,options)=>{
    observed=options.headers['auth-token'];return {ok:true,json:async()=>({responses:[{data:{valid:[{id:'ref',mobile:'9779800000000',text:'Ticket 123'}]}}]})};
  }});
  saveSmsSettings(db,{token:'saved-token'});assert.equal(smsTokenFor(db,'environment-token'),'saved-token');
  initSms(db);assert.equal(smsTokenFor(db),'saved-token');
  queueSms(db,1,2,true);await worker.tick();assert.equal(observed,'saved-token');
  saveSmsSettings(db,{disable:true});assert.equal(smsTokenFor(db,'environment-token'),'');
  assert.equal(status(db,'two'),'pending');await worker.tick();
  assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM audit').all()),/saved-token/);
  for(const token of ['', 'bad token', 'bad\nheader','x'.repeat(4097)])assert.throws(()=>saveSmsSettings(db,{token}));
});

test('bulk queue validates reviewed count and configuration and prevents double sending',async t=>{
  const db=fixture(t);assert.throws(()=>queueSms(db,1,2,false),/Configure/);
  assert.throws(()=>queueSms(db,1,1,true),/changed/);assert.equal(status(db),'pending');
  assert.deepEqual(queueSms(db,1,1,true,['one']),{count:1});assert.equal(status(db),'api queued');assert.equal(status(db,'two'),'pending');
  assert.throws(()=>queueSms(db,1,1,true,['one']),/changed/);
  db.prepare("UPDATE messages SET status='pending'").run();
  queueSms(db,1,2,true);assert.throws(()=>queueSms(db,1,2,true),/No pending/);
  let calls=0,release;
  const worker=createSmsWorker(db,{token:'secret',fetchImpl:async(url,options)=>{
    calls++;assert.equal(url,'https://sms.aakashsms.com/sms/v4/send-user');assert.equal(options.method,'POST');
    assert.equal(options.headers['auth-token'],'secret');assert.equal(options.headers['Content-Type'],'application/json');
    assert.deepEqual(JSON.parse(options.body),{to:['9800000000'],text:['Ticket 123']});
    await new Promise(r=>release=r);
    return {ok:true,json:async()=>({responses:[{error:false,data:{valid:[{id:'123',mobile:'9779800000000',text:'Ticket 123'}]}}],errors:[]})};
  }});
  const first=worker.tick();await worker.tick();assert.equal(calls,1);release();await first;
  assert.equal(status(db),'api accepted');assert.equal(status(db,'two'),'api queued');
  assert.equal(db.prepare('SELECT provider_id FROM sms_attempts').get().provider_id,'123');
  resolveSms(db,1,'one','delivered');assert.equal(status(db),'delivered');
  assert.throws(()=>resolveSms(db,1,'one','failed'));
});

test('ambiguous failures pause queue and cannot be automatically resent',async t=>{
  const db=fixture(t);queueSms(db,1,2,true);
  let calls=0;
  const worker=createSmsWorker(db,{token:'secret',fetchImpl:async()=>{calls++;throw Error('secret');}});
  await worker.tick();await worker.tick();assert.equal(calls,1);
  assert.equal(status(db),'api unknown');assert.equal(status(db,'two'),'pending');
  assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM sms_attempts').all()),/secret/);
  resolveSms(db,1,'one','failed');assert.equal(status(db),'failed');
});

test('failed Aakash SMS retries create a separate API queue entry and preserve history',t=>{
  const db=fixture(t);
  db.exec("UPDATE messages SET status='failed'; INSERT INTO sms_attempts(message,detail) VALUES('one','Aakash delivery status: failed')");
  assert.throws(()=>queueFailedSmsRetry(db,1,'one',false),/Configure Aakash/);
  assert.throws(()=>queueFailedSmsRetry(db,1,'two',true),/failed Aakash messages/);
  const {id}=queueFailedSmsRetry(db,1,'one',true);
  const retry=db.prepare('SELECT campaign,customer,batch,message,status,export_id FROM messages WHERE id=?').get(id);
  assert.deepEqual({...retry},{campaign:1,customer:1,batch:null,message:'Ticket 123',status:'api queued',export_id:null});
  assert.equal(status(db,'one'),'retry queued');assert.equal(status(db,'two'),'failed');
  assert.throws(()=>queueFailedSmsRetry(db,1,'one',true),/failed Aakash messages/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit WHERE event='SMS API retry queued'").get().count,1);
});

test('restart holds in-flight requests and preserves untouched queue',t=>{
  const db=fixture(t);queueSms(db,1,2,true);
  db.exec("UPDATE messages SET status='api sending' WHERE id='one'");
  createSmsWorker(db,{token:'secret'});
  assert.equal(status(db),'api unknown');assert.equal(status(db,'two'),'api queued');
});

test('provider rejection fails definitively; malformed and HTTP failures stay unknown',async t=>{
  for(const [response,expected] of [
    [{ok:true,json:async()=>({error:true,message:'The provided Auth Token is not valid.',data:[]})},'failed'],
    [{ok:true,json:async()=>({error:true,message:'All messages encountered errors.',errors:[{error:true,message:'Not enough balance.',data:[]}]})},'failed'],
    [{ok:true,json:async()=>({errors:[{error:true,data:{valid:[],invalid:[{mobile:'9779800000000',text:'Ticket 123'}]}}]})},'failed'],
    [{ok:false,json:async()=>({error:true})},'api unknown'],
    [{ok:true,json:async()=>({responses:[{error:false,data:{valid:[{id:1,mobile:'9811111111',text:'Ticket 123'}]}}]})},'api unknown']
  ]) {
    const db=fixture(t);queueSms(db,1,2,true);
    await createSmsWorker(db,{token:'secret',fetchImpl:async()=>response}).tick();
    assert.equal(status(db),expected);assert.equal(status(db,'two'),'pending');
  }
});

test('v4 batches personalized messages and matches out-of-order partial responses',async t=>{
  const db=fixture(t);
  db.exec("INSERT INTO customers VALUES(2,1,'9811111111','Second',0); UPDATE messages SET customer=2 WHERE id='two'; INSERT INTO messages(id,campaign,customer,message) VALUES('three',1,1,'Ticket 789')");
  queueSms(db,1,3,true);
  await createSmsWorker(db,{token:'secret',fetchImpl:async(url,options)=>{
    assert.deepEqual(JSON.parse(options.body),{to:['9800000000','9811111111'],text:['Ticket 123','Ticket 456']});
    return {ok:true,json:async()=>({responses:[{error:false,data:{valid:[{id:'provider_456',mobile:'9779811111111',text:'Ticket 456'}],invalid:[]}}],errors:[{error:true,data:{valid:[],invalid:[{mobile:'9779800000000',text:'Ticket 123',status:'aborted'}]}}]})};
  }}).tick();
  assert.equal(status(db),'failed');assert.equal(status(db,'two'),'api accepted');assert.equal(status(db,'three'),'pending');
  assert.equal(db.prepare("SELECT provider_id FROM sms_attempts WHERE message='two'").get().provider_id,'provider_456');
});

test('v4 missing or mismatched results remain unknown without resending accepted messages',async t=>{
  const db=fixture(t);
  db.exec("INSERT INTO customers VALUES(2,1,'9811111111','Second',0); UPDATE messages SET customer=2 WHERE id='two'");
  queueSms(db,1,2,true);
  let calls=0;
  const worker=createSmsWorker(db,{token:'secret',fetchImpl:async()=>{
    calls++;
    return {ok:true,json:async()=>({responses:[{error:false,data:{valid:[{id:'a',mobile:'9779800000000',text:'Ticket 123'},{id:'b',mobile:'9779811111111',text:'Wrong ticket'}]}}],errors:[]})};
  }});
  await worker.tick();await worker.tick();
  assert.equal(calls,1);assert.equal(status(db),'api accepted');assert.equal(status(db,'two'),'api unknown');
});

test('v4 bounds large campaigns to batches of 100 and continues remaining messages',async t=>{
  const db=fixture(t);db.exec('DELETE FROM messages');
  for(let i=0;i<205;i++) {
    db.prepare('INSERT INTO customers(id,campaign,phone,name) VALUES(?,1,?,?)').run(i+2,String(9810000000+i),'Customer');
    db.prepare('INSERT INTO messages(id,campaign,customer,message) VALUES(?,1,?,?)').run(String(i),i+2,'Ticket '+i);
  }
  queueSms(db,1,205,true);const sizes=[];
  const worker=createSmsWorker(db,{token:'secret',fetchImpl:async(url,options)=>{
    const {to,text}=JSON.parse(options.body);sizes.push(to.length);
    return {ok:true,json:async()=>({responses:to.map((mobile,i)=>({error:false,data:{valid:[{id:'ref'+mobile,mobile:'977'+mobile,text:text[i]}]}})),errors:[]})};
  }});
  await worker.tick();await worker.tick();await worker.tick();await worker.tick();
  assert.deepEqual(sizes,[100,100,5]);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE status='api accepted'").get().count,205);
});
