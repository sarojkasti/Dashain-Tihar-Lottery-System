import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
const base=process.env.TEST_URL||'http://localhost:3001';
async function post(path,data){const r=await fetch(base+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const result=await r.json();assert.equal(r.status,200,JSON.stringify(result));return result;}
const c=await post('campaign',{name:'Smoke test',start:'2083/06/01',end:'2083/07/30',threshold:2000});
const wb=new ExcelJS.Workbook(),ws=wb.addWorksheet('Sales');
ws.addRow(['Date BS','Invoice No','Quotation Number','Customer','Item','Quantity','Rate','TotalNet Amount','Pay Mode','Phone Number']);
ws.addRow(['2083/6/8','PKR-SMOKE','','Test customer','Item',1,4500,4500,'Cash','9800000000']);
const p=await post('preview',{campaign:c.id,kind:'sale',filename:'smoke.xlsx',file:Buffer.from(await wb.xlsx.writeBuffer()).toString('base64')});
assert.equal(p.groups[0].amount,450000);
await post('import',{id:p.id,references:['PKR-SMOKE']});
const a=await post('assign',{campaign:c.id,threshold:200000,count:2});assert.equal(a.count,2);
let state=await (await fetch(base+'/api/state?campaign='+c.id)).json();assert.equal(state.customers[0].balance,50000);
assert.equal(state.messages.length,1);assert.equal(state.messages[0].status,'pending');
console.log('HTTP workflow passed: campaign, Excel preview/import, assignment, pending SMS ready for direct sending.');
