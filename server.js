import http from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { networkInterfaces, hostname } from 'node:os';
import { openStore, money, transaction, importGroups, assign, audit, auditContext } from './core.js';
import { parseWorkbook, dateKey } from './importer.js';
import { initAuth, publicUser, fail, hashPassword, verifyPassword, sessionFor, createSession, logout, requireCsrf, checkLoginLimit, saveUser } from './auth.js';
import { auditReport } from './audit-report.js';
import { initSms, queueSms, resolveSms, queueFailedSmsRetry, createSmsWorker, smsTokenFor, saveSmsSettings, sendTestSms, refreshSmsReport, smsTestHistory, nextPendingSmsReportRange } from './sms.js';

const root=fileURLToPath(new URL('.',import.meta.url));
try { process.loadEnvFile(`${root}.env`); } catch(e) { if(e.code!=='ENOENT')throw e; }
mkdirSync(`${root}data`,{recursive:true});
const db=openStore(process.env.LOTTERY_DB || `${root}data/lottery.sqlite`);
initAuth(db);
initSms(db);
const getSmsToken=()=>smsTokenFor(db,process.env.AAKASH_SMS_TOKEN?.trim() || '');
const smsWorker=createSmsWorker(db,{getToken:getSmsToken});
let smsReportBusy=false;
async function autoRefreshSmsReport() {
  if(smsReportBusy||!getSmsToken())return;
  const range=nextPendingSmsReportRange(db);if(!range)return;
  smsReportBusy=true;
  try {await refreshSmsReport(db,{...range,token:getSmsToken()});}
  catch {console.error('Automatic Aakash delivery report refresh failed; manual report lookup is still available.');}
  finally {smsReportBusy=false;}
}
const previews=new Map(), port=Number(process.env.PORT || 3010);
const host=process.env.HOST || '127.0.0.1';
const json=(res,data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
async function body(req) {const chunks=[];let size=0;const limit=req.url==='/api/preview'?20*1024*1024:64*1024;for await(const c of req){size+=c.length;if(size>limit)fail('Request is too large.',413);chunks.push(c);}return Buffer.concat(chunks);}
async function readJson(req) {
  if(!/^application\/json(?:;|$)/i.test(String(req.headers['content-type']))) fail('JSON content type required',415);
  let data;try {data=JSON.parse((await body(req)).toString());}catch(e){if(e.status)throw e;fail('Invalid JSON request.');}
  if(!data || typeof data!=='object' || Array.isArray(data))fail('A JSON object is required.');
  return data;
}
function validateHost(req) {
  const authority=req.headers.host || '';
  const target=new URL(`http://${authority}`);
  const allowed=new Set(['localhost','127.0.0.1',hostname().toLowerCase(),...Object.values(networkInterfaces()).flat().filter(Boolean).map(n=>n.address.toLowerCase())]);
  if(!allowed.has(target.hostname.toLowerCase()) || target.username || target.password || target.host!==authority.toLowerCase())fail('Invalid host',403);
  if(req.headers.origin && req.headers.origin!==`http://${authority}`)fail('Invalid origin',403);
  if(req.headers['sec-fetch-site']==='cross-site')fail('Cross-site requests are not allowed.',403);
}
const server=http.createServer((req,res)=>auditContext.run({ip:req.socket.remoteAddress},async()=>{
  try {
    const url=new URL(req.url,'http://localhost');
    validateHost(req);
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
    const appPaths=new Set(['/overview','/sales-returns','/customers','/tickets','/sms','/sms/settings','/campaign-settings','/audit','/users','/account']);
    if(req.method==='GET' && (['/','/app.js','/style.css','/router.js'].includes(url.pathname)||appPaths.has(url.pathname))) {
      const file=url.pathname==='/'||appPaths.has(url.pathname)?'index.html':url.pathname.slice(1);
      res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');return res.end(readFileSync(`${root}public/${file}`));
    }
    if(req.method==='POST' && url.pathname==='/api/login') {
      const data=await readJson(req),username=String(data.username||'').trim().toLowerCase().slice(0,40);
      checkLoginLimit(db,req.socket.remoteAddress,username);
      const found=db.prepare('SELECT * FROM users WHERE username=?').get(username);
      const valid=await verifyPassword(data.password,found?.password_hash);
      const current=found && db.prepare('SELECT * FROM users WHERE id=?').get(found.id);
      if(!valid || !current?.active || current.password_hash!==found.password_hash) {
        audit(db,null,'sign-in failed',JSON.stringify({username}),'failure');
        return json(res,{error:'Invalid username or password.'},401);
      }
      auditContext.getStore().user=current;
      db.prepare('DELETE FROM login_attempts WHERE key=?').run(`user:${username}`);
      logout(db,req,res);
      audit(db,null,'signed in','');
      return json(res,createSession(db,current,res));
    }
    let user=sessionFor(db,req);
    if(req.method==='GET' && url.pathname==='/api/session')return json(res,user?{user:publicUser(user),csrf:user.csrf}:{user:null});
    if(!user)fail('Sign in to continue.',401);
    auditContext.getStore().user=user;
    if(req.method==='POST')requireCsrf(req,user);
    if(req.method==='POST' && url.pathname==='/api/logout') {
      logout(db,req,res);audit(db,null,'signed out','');return json(res,{ok:true});
    }
    if(req.method==='POST' && url.pathname==='/api/password') {
      const data=await readJson(req);
      if(!await verifyPassword(data.currentPassword,user.password_hash))fail('Current password is incorrect.');
      if(data.password===data.currentPassword)fail('Choose a different password.');
      const hash=await hashPassword(data.password);
      const current=sessionFor(db,req);
      if(!current || current.password_hash!==user.password_hash)fail('Session changed. Sign in again.',401);
      transaction(db,()=>{
        db.prepare('UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?').run(hash,user.id);
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
        audit(db,null,'password changed','');
      });
      return json(res,createSession(db,db.prepare('SELECT * FROM users WHERE id=?').get(user.id),res));
    }
    if(user.must_change_password)fail('Change your temporary password before continuing.',403);
    const adminRoute=['/api/users','/api/audit','/api/audit.csv','/api/campaign','/api/sms-settings','/api/sms-test','/api/sms-report','/api/sms-test-history'].includes(url.pathname);
    if(adminRoute && user.role!=='administrator')fail('Administrator access required.',403);
    if(req.method==='POST' && user.role==='viewer')fail('Viewer accounts have read-only access.',403);
    if(req.method==='GET' && url.pathname==='/api/sms-settings')return json(res,{configured:Boolean(getSmsToken())});
    if(req.method==='GET' && url.pathname==='/api/sms-test-history')return json(res,{rows:smsTestHistory(db,url.searchParams.get('start_date'),url.searchParams.get('end_date'))});
    if(req.method==='GET' && url.pathname==='/api/users')return json(res,{users:db.prepare('SELECT * FROM users ORDER BY username').all().map(publicUser)});
    if(req.method==='GET' && url.pathname==='/api/tickets.csv') {
      const campaign=db.prepare('SELECT * FROM campaigns WHERE id=?').get(campaignId);
      if(!campaign)fail('Campaign not found.',404);
      const rows=db.prepare("SELECT t.number,c.name,c.phone,datetime(b.created,'+5 hours','+45 minutes') AS assigned FROM tickets t JOIN customers c ON c.id=t.customer JOIN batches b ON b.id=t.batch WHERE t.campaign=? ORDER BY b.created DESC,t.number").all(campaignId);
      const csvName=`tickets-${campaign.name.replace(/[^a-z0-9]+/gi,'-').toLowerCase()}.csv`;
      const csv='﻿'+'Ticket Number,Customer Name,Phone,Assigned (Nepal Time)\r\n'+rows.map(r=>[r.number,`"${String(r.name||'').replace(/"/g,'""')}"`,r.phone,r.assigned].join(',')).join('\r\n');
      audit(db,campaignId,'tickets exported',JSON.stringify({count:rows.length}));
      res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition',`attachment; filename="${csvName}"`);return res.end(csv);
    }
    if(req.method==='GET' && ['/api/audit','/api/audit.csv'].includes(url.pathname)) {
      const csv=url.pathname.endsWith('.csv'),report=auditReport(db,url.searchParams,csv);
      if(!csv)return json(res,report);
      audit(db,null,'audit report exported',JSON.stringify(Object.fromEntries(url.searchParams)));
      res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition','attachment; filename="audit-report.csv"');return res.end(report);
    }
    const campaignId=Number(url.searchParams.get('campaign'));
    if(req.method==='GET' && url.pathname==='/api/state') {
      const campaigns=db.prepare('SELECT * FROM campaigns ORDER BY id DESC').all();
      const campaign=campaigns.find(c=>c.id===campaignId)||campaigns[0];
      if(!campaign)return json(res,{campaigns,customers:[],tickets:[],messages:[],uploads:[],exports:[],batches:[],audit:[]});
      const id=campaign.id;
      return json(res,{campaigns,campaign,smsConfigured:Boolean(getSmsToken()),
        customers:db.prepare('SELECT * FROM customers WHERE campaign=? ORDER BY name').all(id),
        tickets:db.prepare('SELECT t.*,c.phone,c.name,b.created FROM tickets t JOIN customers c ON c.id=t.customer JOIN batches b ON b.id=t.batch WHERE t.campaign=? ORDER BY b.created DESC,t.number').all(id),
        messages:db.prepare('SELECT m.*,c.phone,c.name,a.provider_id,a.detail AS api_detail FROM messages m JOIN customers c ON c.id=m.customer LEFT JOIN sms_attempts a ON a.message=m.id WHERE m.campaign=? ORDER BY m.rowid DESC').all(id),
        uploads:db.prepare('SELECT * FROM uploads WHERE campaign=? ORDER BY created DESC').all(id),
        batches:db.prepare('SELECT * FROM batches WHERE campaign=? ORDER BY created DESC').all(id),
        exports:db.prepare('SELECT e.*,COUNT(m.id) AS count FROM exports e LEFT JOIN messages m ON m.export_id=e.id WHERE e.campaign=? GROUP BY e.id ORDER BY e.created DESC').all(id),
        audit:user.role==='administrator'?db.prepare('SELECT * FROM audit WHERE campaign=? ORDER BY id DESC LIMIT 100').all(id):[]});
    }
    if(req.method!=='POST')return json(res,{error:'Not found'},404);
    const data=await readJson(req);
    // Body uploads can take time: check permissions again before committing any work.
    user=sessionFor(db,req);
    if(!user)fail('Session expired. Sign in again.',401);
    if(user.must_change_password || user.role==='viewer' || (adminRoute && user.role!=='administrator'))fail('Access changed. Reload the page.',403);
    auditContext.getStore().user=user;
    if(url.pathname==='/api/users')return json(res,await saveUser(db,data,user));
    if(url.pathname==='/api/sms-settings')return json(res,saveSmsSettings(db,data));
    if(url.pathname==='/api/sms-test'){
      const result=await sendTestSms(db,{to:data.to,text:data.text,token:getSmsToken()});
      if(result.status==='accepted')setTimeout(autoRefreshSmsReport,15000).unref();
      return json(res,result);
    }
    if(url.pathname==='/api/sms-report')return json(res,await refreshSmsReport(db,{startDate:data.start_date,endDate:data.end_date,token:getSmsToken()}));
    if(url.pathname==='/api/sms-send')return json(res,queueSms(db,Number(data.campaign),Number(data.count),Boolean(getSmsToken()),data.ids));
    if(url.pathname==='/api/sms-resolve')return json(res,resolveSms(db,Number(data.campaign),String(data.id),data.status));
    if(url.pathname==='/api/retry-send')return json(res,queueFailedSmsRetry(db,Number(data.campaign),String(data.id),Boolean(getSmsToken())));
    if(url.pathname==='/api/campaign') {
      const threshold=money(data.threshold),start=dateKey(data.start),end=dateKey(data.end),name=String(data.name||'').trim();
      if(!name || !start || !end || start>end || threshold<=0)throw Error('Provide a name, valid BS dates, and positive threshold');
      const result=transaction(db,()=>{
        if(data.id) {
          const current=db.prepare('SELECT * FROM campaigns WHERE id=?').get(Number(data.id));if(!current)throw Error('Campaign not found');
          if((current.start!==start||current.end!==end) && db.prepare('SELECT id FROM invoices WHERE campaign=? LIMIT 1').get(current.id))throw Error('Campaign dates cannot change after importing records');
          db.prepare('UPDATE campaigns SET name=?,start=?,end=?,threshold=? WHERE id=?').run(name,start,end,threshold,current.id);
          audit(db,current.id,'settings updated',JSON.stringify({before:current,after:{name,start,end,threshold}}));return {id:current.id};
        }
        const r=db.prepare('INSERT INTO campaigns(name,start,end,threshold) VALUES(?,?,?,?)').run(name,start,end,threshold);
        audit(db,Number(r.lastInsertRowid),'campaign created',name);return {id:Number(r.lastInsertRowid)};
      });return json(res,result);
    }
    if(url.pathname==='/api/preview') {
      const campaign=db.prepare('SELECT * FROM campaigns WHERE id=?').get(Number(data.campaign));if(!campaign)throw Error('Create a campaign first');
      if(!['sale','return'].includes(data.kind))throw Error('Choose sales or returns');
      const parsed=await parseWorkbook(Buffer.from(data.file,'base64'),campaign,data.kind,db);
      const current=sessionFor(db,req);if(!current || current.must_change_password || current.role==='viewer')fail('Access changed. Sign in again.',403);
      for(const [id,p] of previews)if(Date.now()-p.time>30*60*1000)previews.delete(id);
      if(previews.size>=20)throw Error('Too many pending previews; restart the app or wait 30 minutes');
      const id=randomUUID();previews.set(id,{...parsed,campaign:campaign.id,kind:data.kind,filename:String(data.filename),time:Date.now(),owner:user.id});
      audit(db,campaign.id,'upload previewed',JSON.stringify({filename:String(data.filename),kind:data.kind,count:parsed.groups.length}));
      return json(res,{...parsed,id});
    }
    if(url.pathname==='/api/import') {
      const p=previews.get(data.id);if(!p||Date.now()-p.time>30*60*1000)throw Error('Preview expired; upload again');
      if(p.owner!==user.id)fail('This upload preview belongs to another user.',403);
      const result=importGroups(db,p,data.references||[]);previews.delete(data.id);return json(res,result);
    }
    if(url.pathname==='/api/assign')return json(res,assign(db,Number(data.campaign),Number(data.threshold),Number(data.count)));
    if(url.pathname==='/api/retry') {
      return json(res,transaction(db,()=>{
        const m=db.prepare("SELECT * FROM messages WHERE id=? AND campaign=? AND status='failed'").get(data.id,Number(data.campaign));if(!m)throw Error('Only failed messages can be retried');
        const id=randomUUID();
        db.prepare('INSERT INTO messages(id,campaign,customer,batch,message) VALUES(?,?,?,?,?)').run(id,m.campaign,m.customer,m.batch,m.message);
        db.prepare("UPDATE messages SET status='retry queued' WHERE id=?").run(m.id);
        audit(db,m.campaign,'SMS retry queued',JSON.stringify({original:m.id,retry:id}));return {id};
      }));
    }
    return json(res,{error:'Not found'},404);
  }catch(e){
    const status=e.status || 400;
    if(auditContext.getStore().user || status===429) {
      audit(db,null,status===403?'access denied':'request failed',JSON.stringify({method:req.method,path:new URL(req.url,'http://localhost').pathname,status}),status===403?'denied':'failure');
    }
    json(res,{error:e.message},status);
  }
}));
server.on('error',error=>{console.error(`Could not start on port ${port}: ${error.message}. Set PORT to an available local port.`);process.exitCode=1;});
server.requestTimeout=30000;
server.listen(port,host,()=>{
  console.log(`Festival Lottery listening on ${host}:${port}`);
  setInterval(()=>smsWorker.tick().catch(()=>console.error('SMS queue processing failed; review SMS centre.')),1000).unref();
  autoRefreshSmsReport();
  setInterval(autoRefreshSmsReport,120000).unref();
});
