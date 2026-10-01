import { fail } from './auth.js';

export const csvCell = value => `"${String(value ?? '').replace(/^[\s]*[=+@\-\t\r\n]/, "'$&").replaceAll('"', '""')}"`;
export function auditReport(db, params, csv = false) {
  const where = [], values = [];
  for (const [key, comparison] of [['from','>='],['to','<']]) {
    const value = params.get(key);
    if (!value) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value) fail('Enter valid Gregorian report dates.');
    const date = new Date(value);
    if (key === 'to') date.setUTCDate(date.getUTCDate() + 1);
    where.push(`a.created ${comparison} ?`); values.push(date.toISOString().slice(0,19).replace('T',' '));
  }
  if (params.get('from') && params.get('to') && params.get('from') > params.get('to')) fail('Start date must be before end date.');
  for (const key of ['actor','event','outcome']) {
    if (params.get(key)) { where.push(`a.${key}=?`); values.push(params.get(key)); }
  }
  if (params.get('campaign')) {
    const campaign = Number(params.get('campaign'));
    if (!Number.isSafeInteger(campaign) || campaign < 1) fail('Invalid campaign.');
    where.push('a.campaign=?'); values.push(campaign);
  }
  const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const total = db.prepare('SELECT COUNT(*) total FROM audit a' + clause).get(...values).total;
  const page = Number(params.get('page') || 1), pageSize = 50;
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000000) fail('Invalid report page.');
  if (csv && total > 100000) fail('Narrow the filters to export at most 100,000 audit records.');
  const rows = db.prepare(`SELECT a.*,c.name campaign_name FROM audit a LEFT JOIN campaigns c ON c.id=a.campaign${clause}
    ORDER BY a.id DESC LIMIT ? OFFSET ?`).all(...values, csv ? 100000 : pageSize, csv ? 0 : (page - 1) * pageSize);
  if (csv) return '\uFEFF' + [
    ['ID','Time (UTC)','Username','Source IP','Campaign','Action','Outcome','Details'],
    ...rows.map(a => [a.id,a.created,a.actor || 'Legacy / system',a.ip || '',a.campaign_name || '',a.event,a.outcome,a.detail])
  ].map(row => row.map(csvCell).join(',')).join('\r\n');
  return { rows, total, page, pageSize,
    actors:db.prepare('SELECT DISTINCT actor FROM audit WHERE actor IS NOT NULL ORDER BY actor').all().map(r => r.actor),
    events:db.prepare('SELECT DISTINCT event FROM audit ORDER BY event').all().map(r => r.event) };
}
