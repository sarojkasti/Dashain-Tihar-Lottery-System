import { randomUUID } from 'node:crypto';
import { audit, transaction, phone } from './core.js';

export function initSms(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS sms_settings (id INTEGER PRIMARY KEY CHECK(id=1), token TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sms_test_messages (
      id TEXT PRIMARY KEY, provider_id TEXT, mobile TEXT NOT NULL, text TEXT NOT NULL,
      status TEXT NOT NULL, provider_status TEXT, credit REAL, network TEXT,
      created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reported_at TEXT);
    CREATE TABLE IF NOT EXISTS sms_attempts (
    message TEXT PRIMARY KEY REFERENCES messages(id), provider_id TEXT, detail TEXT,
    updated TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE INDEX IF NOT EXISTS messages_status ON messages(status);`);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS sms_test_provider_ref ON sms_test_messages(provider_id) WHERE provider_id IS NOT NULL;');
  // Earlier releases kept only the provider reference and masked recipient in
  // the audit log. Preserve those accepted tests in history without inventing
  // a recipient or message body that the old version did not store.
  for(const entry of db.prepare("SELECT id,detail,created FROM audit WHERE event='SMS API test message'").all())try {
    const detail=JSON.parse(entry.detail||'{}');
    if(!detail.providerId)continue;
    db.prepare(`INSERT OR IGNORE INTO sms_test_messages
      (id,provider_id,mobile,text,status,provider_status,created)
      VALUES(?,?,?,'Message sent before test-message history was enabled',?,'queued',?)`)
      .run(`legacy-${entry.id}`,String(detail.providerId),String(detail.mobile||'Unknown'),detail.status==='accepted'?'accepted':'unknown',entry.created);
  } catch { /* Ignore unrelated or older audit detail formats. */ }
}

export function smsTokenFor(db, fallback='') {
  return db.prepare('SELECT token FROM sms_settings WHERE id=1').get()?.token ?? fallback;
}

export function saveSmsSettings(db, data) {
  const disable=data.disable===true;
  const token=typeof data.token==='string'?data.token.trim():'';
  if(!disable && (!token || token.length>4096 || /[^\x21-\x7e]/.test(token)))throw Error('Enter a valid API token without spaces (maximum 4096 characters).');
  return transaction(db,()=>{
    db.prepare('INSERT INTO sms_settings(id,token) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token').run(disable?'':token);
    if(disable)db.prepare("UPDATE messages SET status='pending' WHERE status='api queued'").run();
    audit(db,null,disable?'SMS API disabled':'SMS API settings updated','');
    return {configured:!disable};
  });
}

export async function sendTestSms(db, {to, text, token, fetchImpl=fetch}) {
  const mobile=phone(to);
  const message=typeof text==='string'?text.trim():'';
  if(!mobile)throw Error('Enter a valid 10-digit Nepal mobile number.');
  if(!message || message.length>1000)throw Error('Enter a test message of 1 to 1000 characters.');
  if(!token)throw Error('Save the Aakash API token before sending a test message.');
  let result,response;
  const localId=randomUUID();
  try {
    response=await fetchImpl('https://sms.aakashsms.com/sms/v4/send-user',{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),
      headers:{'Content-Type':'application/json','auth-token':token},
      body:JSON.stringify({to:[mobile],text:[message]})
    });
    result=await response.json();
  } catch {
    db.prepare("INSERT INTO sms_test_messages(id,mobile,text,status,provider_status) VALUES(?,?,?,'unknown','unknown')").run(localId,mobile,message);
    audit(db,null,'SMS API test message','Uncertain result; check Aakash before sending again.','failure');
    return {status:'unknown',message:'The result is uncertain. Check the Aakash portal before trying again.',id:localId};
  }
  const entries=[...(Array.isArray(result?.responses)?result.responses:[]),...(Array.isArray(result?.errors)?result.errors:[])];
  const valid=entries.flatMap(x=>Array.isArray(x?.data?.valid)?x.data.valid:[]);
  const invalid=entries.flatMap(x=>Array.isArray(x?.data?.invalid)?x.data.invalid:[]);
  const accepted=valid.filter(x=>phone(x.mobile)===mobile&&x.text===message&&x.id!=null);
  const refused=invalid.some(x=>phone(x.mobile)===mobile&&x.text===message);
  const status=response.ok&&accepted.length===1&&!refused?'accepted':response.ok&&refused?'failed':'unknown';
  const sent=status==='accepted'?accepted[0]:null;
  db.prepare('INSERT INTO sms_test_messages(id,provider_id,mobile,text,status,provider_status,credit,network) VALUES(?,?,?,?,?,?,?,?)').run(localId,sent?String(sent.id):null,mobile,message,status,sent?.status||null,sent?.credit??null,sent?.network||null);
  audit(db,null,'SMS API test message',JSON.stringify({mobile:`${mobile.slice(0,3)}•••••••`,status,providerId:sent?String(sent.id):undefined}),status==='accepted'?'success':'failure');
  return {status,message:status==='accepted'?'Aakash accepted the test message. Delivery is not yet confirmed.':status==='failed'?'Aakash rejected this recipient or message. Check the API token and credit balance.':'Aakash returned no clear result. Check the portal before trying again.',...(sent?{reference:String(sent.id),providerStatus:sent.status,credit:sent.credit,network:sent.network}:{id:localId})};
}

const isoDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(`${value}T00:00:00Z`))&&new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;
const currentDate=()=>new Date().toISOString().slice(0,10);
const statusMap={queued:'api accepted',submitted:'sent',sent:'sent',delivered:'delivered',failed:'failed',cancelled:'failed',aborted:'failed'};

export function nextPendingSmsReportRange(db,now=new Date()) {
  const oldest=db.prepare(`SELECT MIN(day) AS day FROM (
    SELECT date(a.updated,'+5 hours','+45 minutes') AS day
      FROM messages m JOIN sms_attempts a ON a.message=m.id
      WHERE m.export_id IS NULL AND m.status IN ('api accepted','sent') AND a.provider_id IS NOT NULL
    UNION ALL
    SELECT date(created,'+5 hours','+45 minutes') AS day FROM sms_test_messages
      WHERE provider_id IS NOT NULL AND status IN ('accepted','api accepted','sent')
        AND COALESCE(provider_status,'queued') IN ('queued','submitted','sent'))`).get()?.day;
  if(!oldest)return null;
  const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Kathmandu'}).format(now);
  const cutoff=new Date(`${today}T00:00:00Z`);cutoff.setUTCDate(cutoff.getUTCDate()-30);
  return {startDate:oldest<cutoff.toISOString().slice(0,10)?cutoff.toISOString().slice(0,10):oldest,endDate:today};
}

export async function refreshSmsReport(db,{startDate,endDate,token,fetchImpl=fetch}={}) {
  if(!isoDate(startDate)||!isoDate(endDate)||startDate>endDate)throw Error('Choose a valid report date range.');
  if(Date.parse(`${endDate}T00:00:00Z`)-Date.parse(`${startDate}T00:00:00Z`)>30*86400000)throw Error('Reports can cover up to 31 days at a time.');
  if(!token)throw Error('Save the Aakash API token before checking reports.');
  const providerRows=[];let result,total=null,credits=null;
  for(let page=1;page<=100;page++) {
    let response;
    try {
      const endpoint=new URL('https://sms.aakashsms.com/sms/v4/api-report');
      if(page>1)endpoint.searchParams.set('page',String(page));
      response=await fetchImpl(endpoint,{
        method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),
        headers:{'Content-Type':'application/json','auth-token':token},
        body:JSON.stringify({start_date:startDate,end_date:endDate})
      });
      result=await response.json();
    } catch { throw Error('Could not retrieve the Aakash report. Try again.'); }
    if(!response.ok||result?.error===true||result?.status==='error')throw Error(typeof result?.message==='string'?`Aakash report: ${result.message}`:'Aakash returned an error while retrieving the report.');
    // Aakash v4 currently wraps its rows in Laravel pagination:
    // data.result.data. Accept the documented flat data array as well.
    const report=result?.data?.result;
    const rows=Array.isArray(report?.data)?report.data:Array.isArray(result?.data)?result.data:null;
    if(!rows)throw Error('Aakash returned an unrecognized report response.');
    total=report?.total??result?.total??total;
    credits=result?.credits??credits;
    providerRows.push(...rows.filter(r=>r&&r.id!=null));
    const lastPage=Number(report?.last_page||1);
    if(!Number.isInteger(lastPage)||lastPage<1)throw Error('Aakash returned an invalid report page count.');
    if(page>=lastPage)break;
    if(page===100)throw Error('Aakash report has more than 100 pages. Narrow the date range and try again.');
  }
  const normalized=providerRows.map(r=>({
    reference:String(r.id??r.message_id),mobile:String(r.mobile??r.recipient??r.receiver??''),text:String(r.text??r.message??r.body??''),
    status:String(r.status??'unknown').toLowerCase(),credit:r.credit??r.api_credit??null,
    network:String(r.network??''),sentAt:String(r.sent_on??r.delivery_at??r.created_at??''),reportedAt:String(r.updated_at??'')
  }));
  if(credits==null&&providerRows.some(r=>Number.isFinite(Number(r.credit??r.api_credit))))credits=providerRows.reduce((sum,r)=>sum+Number(r.credit??r.api_credit??0),0);
  const matched=[],reportOutput=[];
  const timestamp=value=>{const s=String(value||'');return Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(s)?s.replace(' ','T')+'Z':s);};
  const usedMessages=new Set(),usedTests=new Set();
  function resolveByContent(items,row,phoneField,textField,timeField,used,legacy=false) {
    const idMatches=items.filter(x=>!used.has(x.id)&&x.provider_id&&[row.reference,row.reference.split('_').at(-1)].some(v=>v===String(x.provider_id)||v===String(x.provider_id).split('_').at(-1)));
    if(idMatches.length===1)return idMatches[0];
    const targetPhone=phone(row.mobile),targetTime=timestamp(row.sentAt);
    if(!targetPhone||!Number.isFinite(targetTime))return null;
    const candidates=items.flatMap(x=>{
      if(used.has(x.id))return [];
      const localPhone=phone(x[phoneField]);
      const exact=localPhone===targetPhone&&x[textField]===row.text;
      const oldAudit=legacy&&!localPhone&&String(x[phoneField]||'').startsWith(targetPhone.slice(0,3))&&String(x[textField]||'').startsWith('Message sent before test-message history was enabled');
      if(!exact&&!oldAudit)return [];
      const delta=Math.abs(timestamp(x[timeField])-targetTime);
      if(!Number.isFinite(delta)||delta>(oldAudit?1000:10*60*1000))return [];
      return [{x,delta}];
    }).sort((a,b)=>a.delta-b.delta);
    if(!candidates.length||candidates.length>1&&candidates[0].delta===candidates[1].delta)return null;
    return candidates[0].x;
  }
  transaction(db,()=>{
    const local=db.prepare("SELECT m.id,m.campaign,m.status,m.message,c.phone,a.provider_id,datetime(a.updated,'+5 hours','+45 minutes') AS submitted_at FROM messages m JOIN customers c ON c.id=m.customer JOIN sms_attempts a ON a.message=m.id WHERE a.provider_id IS NOT NULL").all();
    const tests=db.prepare("SELECT id,provider_id,status,mobile,text,datetime(created,'+5 hours','+45 minutes') AS submitted_at FROM sms_test_messages").all();
    for(const row of normalized) {
      let m=resolveByContent(local,row,'phone','message','submitted_at',usedMessages);
      let t=resolveByContent(tests,row,'mobile','text','submitted_at',usedTests,true);
      if(m) {
        usedMessages.add(m.id);
        const status=statusMap[row.status];if(status){db.prepare('UPDATE messages SET status=? WHERE id=?').run(status,m.id);db.prepare('UPDATE sms_attempts SET detail=? WHERE message=?').run(`Aakash delivery status: ${row.status}`,m.id);}
        matched.push({...row,id:m.id,campaign:m.campaign,source:'campaign'});
      }
      if(t) {
        usedTests.add(t.id);
        db.prepare('UPDATE sms_test_messages SET status=?,provider_status=?,credit=?,network=?,reported_at=CURRENT_TIMESTAMP WHERE id=?').run(statusMap[row.status]||t.status,row.status,row.credit,row.network,t.id);
        matched.push({...row,id:t.id,source:'test'});
      }
      reportOutput.push({...row,source:m?'campaign':t?'test':'Aakash report',...(m?{campaign:m.campaign}:{})});
    }
    audit(db,null,'SMS delivery report refreshed',JSON.stringify({startDate,endDate,providerRows:providerRows.length,matched:matched.length}));
  });
  return {startDate,endDate,total:total??providerRows.length,credits,providerRows:providerRows.length,matched:matched.length,rows:reportOutput};
}

export function smsTestHistory(db,startDate,endDate) {
  if(!isoDate(startDate)||!isoDate(endDate)||startDate>endDate)throw Error('Choose a valid report date range.');
  return db.prepare("SELECT id,provider_id,mobile,text,status,provider_status,credit,network,datetime(created,'+5 hours','+45 minutes') AS created,reported_at FROM sms_test_messages WHERE date(created,'+5 hours','+45 minutes') BETWEEN ? AND ? ORDER BY created DESC").all(startDate,endDate);
}

export function queueSms(db, campaign, expectedCount, configured, ids=null) {
  if (!configured) throw Error('Configure AAKASH_SMS_TOKEN on the server first.');
  return transaction(db, () => {
    const selectedIds=Array.isArray(ids)?[...new Set(ids.map(String))]:null;
    if(selectedIds && !selectedIds.length)throw Error('Select pending SMS messages first.');
    const rows=selectedIds
      ? selectedIds.map(id=>db.prepare("SELECT id FROM messages WHERE id=? AND campaign=? AND status='pending'").get(id,campaign))
      : db.prepare("SELECT id FROM messages WHERE campaign=? AND status='pending'").all(campaign);
    if(selectedIds && rows.some(row=>!row))throw Error('Selected messages changed. Refresh and review before sending.');
    if (!rows.length) throw Error('No pending SMS messages.');
    if (rows.length!==expectedCount) throw Error('Pending messages changed. Refresh and review before sending.');
    if(selectedIds)for(const id of selectedIds)db.prepare("UPDATE messages SET status='api queued' WHERE id=? AND campaign=? AND status='pending'").run(id,campaign);
    else db.prepare("UPDATE messages SET status='api queued' WHERE campaign=? AND status='pending'").run(campaign);
    audit(db,campaign,'SMS API queued',JSON.stringify({count:rows.length}));
    return {count:rows.length};
  });
}

export function resolveSms(db, campaign, id, status) {
  if (!['sent','failed','delivered'].includes(status)) throw Error('Invalid SMS result.');
  return transaction(db,()=>{
    const m=db.prepare('SELECT * FROM messages WHERE id=? AND campaign=?').get(id,campaign);
    if (!m || !['api unknown','api accepted','sent'].includes(m.status) || m.export_id) throw Error('This API message cannot be resolved.');
    if (m.status==='sent' && status!=='delivered') throw Error('Sent messages can only be marked delivered.');
    db.prepare('UPDATE messages SET status=? WHERE id=?').run(status,id);
    audit(db,campaign,'SMS API result confirmed',JSON.stringify({id,status}));
    return {ok:true};
  });
}

export function queueFailedSmsRetry(db, campaign, id, configured) {
  if (!configured) throw Error('Configure Aakash SMS before sending a retry.');
  return transaction(db,()=>{
    const m=db.prepare(`SELECT m.* FROM messages m JOIN sms_attempts a ON a.message=m.id
      WHERE m.id=? AND m.campaign=? AND m.status='failed' AND m.export_id IS NULL`).get(id,campaign);
    if(!m)throw Error('Only failed Aakash messages can be sent as an API retry.');
    const retryId=randomUUID();
    db.prepare("INSERT INTO messages(id,campaign,customer,batch,message,status) VALUES(?,?,?,?,?,'api queued')")
      .run(retryId,m.campaign,m.customer,m.batch,m.message);
    db.prepare("UPDATE messages SET status='retry queued' WHERE id=? AND status='failed'").run(m.id);
    audit(db,m.campaign,'SMS API retry queued',JSON.stringify({original:m.id,retry:retryId}));
    return {id:retryId};
  });
}

// One process owns the queue. In-flight requests after a crash must be checked
// with Aakash before retrying: the provider has no documented idempotency key.
export function createSmsWorker(db,{token,getToken=()=>token,fetchImpl=fetch}={}) {
  transaction(db,()=>{
    const interrupted=db.prepare("SELECT id,campaign FROM messages WHERE status='api sending'").all();
    for (const m of interrupted) {
      db.prepare("UPDATE messages SET status='api unknown' WHERE id=?").run(m.id);
      db.prepare("INSERT OR REPLACE INTO sms_attempts(message,detail) VALUES(?,?)").run(m.id,'Server stopped during sending. Check Aakash before retrying.');
      audit(db,m.campaign,'SMS API interrupted',JSON.stringify({id:m.id}),'failure');
    }
  });
  let busy=false;
  async function tick() {
    const token=getToken();
    if (busy || !token) return;
    busy=true;
    try {
      const batch=transaction(db,()=>{
        const rows=db.prepare("SELECT m.*,c.phone FROM messages m JOIN customers c ON c.id=m.customer WHERE m.status='api queued' ORDER BY m.rowid LIMIT 100").all();
        // Keep phone numbers unique within a request so results can be matched
        // without relying on undocumented response ordering.
        const seen=new Set();
        const selected=rows.filter(m=>{if(seen.has(m.phone))return false;seen.add(m.phone);return true;});
        for(const m of selected)db.prepare("UPDATE messages SET status='api sending' WHERE id=?").run(m.id);
        return selected;
      });
      if (!batch.length) return;
      const sendable=batch.filter(m=>phone(m.phone));
      let response,result;
      if(sendable.length)try {
        response=await fetchImpl('https://sms.aakashsms.com/sms/v4/send-user',{
          method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),
          headers:{'Content-Type':'application/json','auth-token':token},
          body:JSON.stringify({to:sendable.map(m=>m.phone),text:sendable.map(m=>m.message)})
        });
        result=await response.json();
      } catch { /* Transport failures remain unknown; never retry automatically. */ }
      const entries=[...(Array.isArray(result?.responses)?result.responses:[]),...(Array.isArray(result?.errors)?result.errors:[])];
      const valid=entries.flatMap(x=>Array.isArray(x?.data?.valid)?x.data.valid:[]);
      const invalid=entries.flatMap(x=>Array.isArray(x?.data?.invalid)?x.data.invalid:[]);
      // Only known whole-request rejections prove that no SMS was accepted.
      const rejectionMessages=new Set(['The provided Auth Token is not valid.','The auth token field is required.','The to field is required.','The text field is required.','Not enough balance.']);
      const rejected=response?.ok && result?.error===true && !valid.length && (
        rejectionMessages.has(result.message) ||
        (Array.isArray(result.errors) && result.errors.length>0 && result.errors.every(x=>x?.error===true && rejectionMessages.has(x.message)))
      );
      const outcomes=batch.map(m=>{
        let status='api unknown',detail='Uncertain response. Check Aakash before retrying.',providerId=null;
        const accepted=valid.filter(x=>phone(x.mobile)===m.phone && x.text===m.message && x.id!=null);
        const refused=invalid.filter(x=>phone(x.mobile)===m.phone && x.text===m.message);
        if(!phone(m.phone)) {status='failed';detail='Invalid Nepal mobile number.';}
        else if(response?.ok && accepted.length===1 && !refused.length) {
          status='api accepted';providerId=String(accepted[0].id);detail='Aakash accepted the SMS; delivery is not yet confirmed.';
        } else if(response?.ok && !accepted.length && (refused.length || rejected)) {
          status='failed';detail='Aakash rejected the request or recipient. Check your API credentials, credit balance and recipient in the portal.';
        }
        return {m,status,detail,providerId};
      });
      transaction(db,()=>{
        for(const {m,status,detail,providerId} of outcomes) {
          db.prepare('UPDATE messages SET status=? WHERE id=?').run(status,m.id);
          db.prepare('INSERT OR REPLACE INTO sms_attempts(message,provider_id,detail) VALUES(?,?,?)').run(m.id,providerId,detail);
          audit(db,m.campaign,'SMS API response',JSON.stringify({id:m.id,status,providerId}),status==='api accepted'?'success':'failure');
        }
        // Pause untouched messages after a partial failure as well as a total failure.
        if(outcomes.some(x=>x.status!=='api accepted'))db.prepare("UPDATE messages SET status='pending' WHERE status='api queued'").run();
      });
    } finally { busy=false; }
  }
  return {tick};
}
