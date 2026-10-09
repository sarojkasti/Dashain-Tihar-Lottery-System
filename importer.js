import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { money, phone, outlet } from './core.js';

const cellText = c => {
  const v=c.value;
  // Excel may store the displayed BS components as an ordinary date serial.
  // Preserve those components; this is not an AD-to-BS conversion.
  if(v instanceof Date && !Number.isNaN(v.getTime())) return `${v.getUTCFullYear()}/${String(v.getUTCMonth()+1).padStart(2,'0')}/${String(v.getUTCDate()).padStart(2,'0')}`;
  if(v && typeof v==='object') {
    if ('result' in v) return String(v.result ?? '');
    if ('richText' in v) return v.richText.map(t=>t.text).join('');
    if ('text' in v) return v.text;
  }
  return String(v ?? '').trim();
};
const key = s => s.toLowerCase().replace(/[^a-z0-9]/g,'');
const dateKey = s => { const m=String(s).trim().match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/); return m && +m[2]>=1 && +m[2]<=12 && +m[3]>=1 && +m[3]<=32 ? `${m[1]}/${m[2].padStart(2,'0')}/${m[3].padStart(2,'0')}` : ''; };
export { dateKey };
async function normalizeSpreadsheetNamespaces(buffer) {
  const zip=await JSZip.loadAsync(buffer);let changed=false,total=0;
  for(const entry of Object.values(zip.files)) {
    if(entry.dir || !entry.name.endsWith('.xml'))continue;
    total+=entry._data?.uncompressedSize||0;
    if(total>100*1024*1024)throw Error('Workbook expanded content exceeds 100 MB');
    let xml=await entry.async('string');
    const firstTag=xml.match(/<([A-Za-z_][\w.:-]*)(?:\s|>)/);
    const root=firstTag?.[1].match(/^([A-Za-z_][\w.-]*):/);
    if(!root)continue;
    const rootPrefix=root[1].replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const declaration=xml.match(new RegExp(`xmlns:(${rootPrefix})="(http://schemas.openxmlformats.org/[^\"]+)"`));
    if(!declaration)continue;
    if(!['http://schemas.openxmlformats.org/spreadsheetml/2006/main','http://schemas.openxmlformats.org/officeDocument/2006/extended-properties'].includes(declaration[2]))continue;
    const prefix=declaration[1].replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    xml=xml.replace(declaration[0],`xmlns="${declaration[2]}"`).replace(new RegExp(`(<\\/?)(?:${prefix}):`,'g'),'$1');
    zip.file(entry.name,xml);changed=true;
  }
  return changed?zip.generateAsync({type:'nodebuffer'}):buffer;
}
export async function parseWorkbook(buffer, campaign, kind, db) {
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(await normalizeSpreadsheetNamespaces(buffer));
  let sheet, header, columns;
  for(const candidate of workbook.worksheets) {
    for(let r=1;r<=Math.min(candidate.rowCount,30);r++) {
      const map={}; candidate.getRow(r).eachCell((c,i)=>map[key(cellText(c))]=i);
      if(map.invoiceno && map.totalnetamount && map.datebs) { sheet=candidate;header=r;columns=map;break; }
    }
    if(sheet) break;
  }
  if(!sheet) throw Error('Could not find Invoice No, Date BS and TotalNet Amount headers');
  if(sheet.rowCount>50000) throw Error('Maximum 50,000 rows per upload');
  const phoneColumn = columns.phonenumber || columns.phoneno || columns.phone || columns.mobile || columns.mobileno || columns.mobilenumber || columns.nepalnumber || columns.contactno || columns.contact;
  const groups=new Map(); let ignored=0;
  for(let r=header+1;r<=sheet.rowCount;r++) {
    const row=sheet.getRow(r), get=k=>columns[k]?cellText(row.getCell(columns[k])):'';
    const reference=get('invoiceno').trim().toUpperCase();
    if(!reference || /^(grand\s*total|total)$/i.test(reference)) {ignored++;continue;}
    const name=get('customer'), rawPhone=phoneColumn?cellText(row.getCell(phoneColumn)):'', p=phone(rawPhone), date=dateKey(get('datebs'));
    let g=groups.get(reference);
    if(!g) {g={reference,name,phone:p,date,outlet:outlet(reference),amount:0,rows:0,errors:[],warnings:[],excluded:/^AB\/83\/84\/NE-/i.test(reference)};groups.set(reference,g);}
    g.rows++;
    if(!p) g.errors.push('Missing or invalid Nepal mobile number');
    if(p!==g.phone) g.errors.push('Different phone numbers within invoice');
    if(!date || date!==g.date) g.errors.push('Invalid or inconsistent Date BS');
    if(date && (date<campaign.start || date>campaign.end)) g.errors.push('Outside campaign dates');
    if(name!==g.name) g.warnings.push('Different customer names within invoice');
    if(!name) g.warnings.push('Customer name missing');
    try {
      const raw=get('totalnetamount'); if(!raw) throw Error();
      const amount=money(raw);
      if(amount<0) g.errors.push('Negative amount: review this row before importing');
      g.amount+=amount;
    } catch {g.errors.push('Invalid TotalNet Amount');}
  }
  for(const g of groups.values()) {
    if(g.amount<=0) g.errors.push('Invoice total must be positive');
    if(db.prepare('SELECT id FROM invoices WHERE campaign=? AND kind=? AND reference=?').get(campaign.id,kind,g.reference)) g.errors.push('Already imported');
    if(kind==='return') g.warnings.push('Review and deselect outlet-level returns');
    g.errors=[...new Set(g.errors)];g.warnings=[...new Set(g.warnings)];
  }
  return {groups:[...groups.values()],sheet:sheet.name,header,ignored,missingPhone:!phoneColumn};
}
