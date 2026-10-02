import { DatabaseSync } from 'node:sqlite';
import { randomInt, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
export const auditContext = new AsyncLocalStorage();

export function money(value) {
  const n = Number(String(value ?? '').replaceAll(',', '').trim());
  if (!Number.isFinite(n) || Math.abs(n) > 1e10) throw Error('Invalid amount');
  return Math.round(n * 100);
}
export function phone(value) {
  let p = String(value ?? '').replace(/[^\d]/g, '');
  if (p.startsWith('00977')) p = p.slice(5);
  if (p.length === 13 && p.startsWith('977')) p = p.slice(3);
  return /^9\d{9}$/.test(p) ? p : '';
}
export const outlet = id => String(id).replace(/^SR-/i, '').split(/[-/]/)[0].toUpperCase();
export function openStore(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS campaigns(id INTEGER PRIMARY KEY,name TEXT NOT NULL,start TEXT NOT NULL,end TEXT NOT NULL,threshold INTEGER NOT NULL CHECK(threshold>0));
    CREATE TABLE IF NOT EXISTS customers(id INTEGER PRIMARY KEY,campaign INTEGER REFERENCES campaigns(id),phone TEXT NOT NULL,name TEXT NOT NULL,balance INTEGER NOT NULL DEFAULT 0,UNIQUE(campaign,phone));
    CREATE TABLE IF NOT EXISTS uploads(id TEXT PRIMARY KEY,campaign INTEGER REFERENCES campaigns(id),kind TEXT,filename TEXT,created TEXT DEFAULT CURRENT_TIMESTAMP,count INTEGER,total INTEGER);
    CREATE TABLE IF NOT EXISTS invoices(id INTEGER PRIMARY KEY,campaign INTEGER REFERENCES campaigns(id),upload TEXT REFERENCES uploads(id),kind TEXT,reference TEXT,customer INTEGER REFERENCES customers(id),outlet TEXT,date TEXT,amount INTEGER,UNIQUE(campaign,kind,reference));
    CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY,campaign INTEGER REFERENCES campaigns(id),threshold INTEGER,count INTEGER,created TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS tickets(number TEXT PRIMARY KEY,campaign INTEGER REFERENCES campaigns(id),customer INTEGER REFERENCES customers(id),batch TEXT REFERENCES batches(id));
    CREATE TABLE IF NOT EXISTS ticket_sources(ticket TEXT REFERENCES tickets(number),invoice INTEGER REFERENCES invoices(id),amount INTEGER NOT NULL,PRIMARY KEY(ticket,invoice));
    CREATE TABLE IF NOT EXISTS exports(id TEXT PRIMARY KEY,campaign INTEGER REFERENCES campaigns(id),created TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,campaign INTEGER REFERENCES campaigns(id),customer INTEGER REFERENCES customers(id),batch TEXT REFERENCES batches(id),message TEXT,status TEXT DEFAULT 'pending',export_id TEXT REFERENCES exports(id));
    CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,campaign INTEGER,event TEXT,detail TEXT,created TEXT DEFAULT CURRENT_TIMESTAMP);`);
  const columns = new Set(db.prepare('PRAGMA table_info(audit)').all().map(c => c.name));
  for (const [name, type] of [['actor_id','INTEGER'],['actor','TEXT'],['ip','TEXT'],['outcome',"TEXT DEFAULT 'success'"]]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE audit ADD COLUMN ${name} ${type}`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS audit_created ON audit(created,id);
    CREATE INDEX IF NOT EXISTS audit_actor ON audit(actor);
    CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'Audit records cannot be edited'); END;
    CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'Audit records cannot be deleted'); END;`);
  return db;
}
export function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
export function audit(db, campaign, event, detail, outcome = 'success') {
  const context = auditContext.getStore() || {};
  db.prepare('INSERT INTO audit(campaign,event,detail,actor_id,actor,ip,outcome) VALUES(?,?,?,?,?,?,?)')
    .run(campaign,event,detail,context.user?.id ?? null,context.user?.username ?? null,context.ip ?? null,outcome);
}
export function importGroups(db, preview, references) {
  return transaction(db, () => {
    const selected = new Set(references);
    const groups = preview.groups.filter(g => selected.has(g.reference));
    if (!groups.length) throw Error('Select at least one valid invoice');
    if (groups.some(g => g.errors.length || g.excluded)) throw Error('Invalid or excluded invoices cannot be imported');
    const campaign=db.prepare('SELECT * FROM campaigns WHERE id=?').get(preview.campaign);
    if(!campaign || groups.some(g=>g.date<campaign.start || g.date>campaign.end))throw Error('Campaign dates changed. Preview this file again.');
    const id = randomUUID(); let count = 0, total = 0;
    db.prepare('INSERT INTO uploads(id,campaign,kind,filename,count,total) VALUES(?,?,?,?,0,0)').run(id,preview.campaign,preview.kind,preview.filename);
    for (const g of groups) {
      if (db.prepare('SELECT id FROM invoices WHERE campaign=? AND kind=? AND reference=?').get(preview.campaign,preview.kind,g.reference)) continue;
      db.prepare('INSERT INTO customers(campaign,phone,name) VALUES(?,?,?) ON CONFLICT(campaign,phone) DO NOTHING').run(preview.campaign,g.phone,g.name || g.phone);
      const c = db.prepare('SELECT id FROM customers WHERE campaign=? AND phone=?').get(preview.campaign,g.phone);
      const amount = preview.kind === 'return' ? -g.amount : g.amount;
      db.prepare('INSERT INTO invoices(campaign,upload,kind,reference,customer,outlet,date,amount) VALUES(?,?,?,?,?,?,?,?)').run(preview.campaign,id,preview.kind,g.reference,c.id,g.outlet,g.date,amount);
      db.prepare('UPDATE customers SET balance=balance+? WHERE id=?').run(amount,c.id);
      count++; total += amount;
    }
    db.prepare('UPDATE uploads SET count=?,total=? WHERE id=?').run(count,total,id);
    audit(db,preview.campaign,'import',JSON.stringify({id,kind:preview.kind,count,total,omitted:preview.groups.length-groups.length}));
    return {id,count,total};
  });
}
function ticketSourceQueue(db, customer) {
  const rows = db.prepare(`SELECT i.id,i.reference,i.date,i.amount-COALESCE(SUM(ts.amount),0) AS remaining
    FROM invoices i LEFT JOIN ticket_sources ts ON ts.invoice=i.id
    WHERE i.customer=?
    GROUP BY i.id
    HAVING remaining!=0
    ORDER BY i.id`).all(customer);
  const queue = []; let debt = 0;
  for (const row of rows) {
    if (row.remaining < 0) { debt += -row.remaining; continue; }
    let usable = row.remaining;
    if (debt) {
      const offset = Math.min(debt, usable);
      debt -= offset; usable -= offset;
    }
    if (usable > 0) queue.push({...row, remaining: usable});
  }
  return queue;
}
function recordTicketSources(db, ticket, customer, amount) {
  const queue = ticketSourceQueue(db, customer);
  let needed = amount;
  for (const source of queue) {
    if (!needed) break;
    const used = Math.min(needed, source.remaining);
    db.prepare('INSERT INTO ticket_sources(ticket,invoice,amount) VALUES(?,?,?)').run(ticket,source.id,used);
    needed -= used;
  }
  if (needed) throw Error('Could not match ticket to purchase records. Review customer balance.');
}
export function assign(db, campaign, expectedThreshold, expectedCount) {
  return transaction(db, () => {
    const config = db.prepare('SELECT * FROM campaigns WHERE id=?').get(campaign);
    if (!config) throw Error('Campaign not found');
    const customers = db.prepare('SELECT * FROM customers WHERE campaign=? AND balance>=?').all(campaign,config.threshold);
    const count = customers.reduce((n,c) => n + Math.floor(c.balance/config.threshold),0);
    if (config.threshold !== expectedThreshold || count !== expectedCount) throw Error('Balances or threshold changed. Review the assignment preview again.');
    if (!count) throw Error('No eligible balances to assign');
    if (count > 100000) throw Error('Batch exceeds 100,000 tickets; review the threshold and balances');
    const batch = randomUUID();
    db.prepare('INSERT INTO batches(id,campaign,threshold,count) VALUES(?,?,?,?)').run(batch,campaign,config.threshold,count);
    for (const c of customers) {
      const quantity = Math.floor(c.balance/config.threshold), numbers = [];
      for (let i=0;i<quantity;i++) {
        let number;
        do { number = `DT-${randomInt(0,10000000000).toString().padStart(10,'0')}`; } while(db.prepare('SELECT number FROM tickets WHERE number=?').get(number));
        db.prepare('INSERT INTO tickets(number,campaign,customer,batch) VALUES(?,?,?,?)').run(number,campaign,c.id,batch);
        recordTicketSources(db,number,c.id,config.threshold);
        numbers.push(number);
      }
      db.prepare('UPDATE customers SET balance=balance-? WHERE id=?').run(quantity*config.threshold,c.id);
      for (let i=0;i<numbers.length;i+=5) {
        const chunk=numbers.slice(i,i+5);
        const codeList=chunk.length===1?`is ${chunk[0]}`:`are: ${chunk.join(', ')}`;
        const message=`You're in! 🎉 Your Newmew Dashain Giveaway voucher code${chunk.length>1?'s':''} ${codeList}. Keep this code safe for your chance to win a 2 nights/3 days.  Rupakot Resort stay for two, with dinner & breakfast included.`;
        db.prepare('INSERT INTO messages(id,campaign,customer,batch,message) VALUES(?,?,?,?,?)').run(randomUUID(),campaign,c.id,batch,message);
      }
    }
    audit(db,campaign,'tickets assigned',JSON.stringify({batch,count,threshold:config.threshold}));
    return {batch,count};
  });
}
