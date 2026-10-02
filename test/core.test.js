import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore,importGroups,assign,phone,money } from '../core.js';
import { parseWorkbook } from '../importer.js';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';

function setup(){const db=openStore();db.prepare('INSERT INTO campaigns(name,start,end,threshold) VALUES(?,?,?,?)').run('Test','2083/05/01','2083/08/30',200000);return db;}
function ingest(db,reference,amount,kind='sale',date='2083/06/01'){return importGroups(db,{campaign:1,kind,filename:'test.xlsx',groups:[{reference,amount,phone:'9800000000',name:'Test',outlet:'PKR',date,errors:[],excluded:false}]},[reference]);}
test('carry balances, ignore repeated imports, retain tickets after returns and recover negative balances',()=>{
 const db=setup();ingest(db,'PKR-1',450000);assert.equal(ingest(db,'PKR-1',450000).count,0);
 assert.equal(assign(db,1,200000,2).count,2);assert.equal(db.prepare('SELECT balance FROM customers').get().balance,50000);
 ingest(db,'SR-PKR-1',150000,'return');assert.equal(db.prepare('SELECT balance FROM customers').get().balance,-100000);
 assert.equal(db.prepare('SELECT count(*) n FROM tickets').get().n,2);
 assert.equal(ingest(db,'SR-PKR-1',150000,'return').count,0);
 ingest(db,'PKR-2',300000);assert.equal(assign(db,1,200000,1).count,1);
 assert.throws(()=>assign(db,1,200000,1),/changed/);db.close();
});
test('changed threshold affects remaining balance only and stale preview cannot assign',()=>{
 const db=setup();ingest(db,'PKR-1',350000);assign(db,1,200000,1);
 db.prepare('UPDATE campaigns SET threshold=100000 WHERE id=1').run();
 assert.throws(()=>assign(db,1,200000,0),/changed/);assign(db,1,100000,1);
 assert.equal(db.prepare('SELECT balance FROM customers').get().balance,50000);
 assert.equal(db.prepare('SELECT SUM(threshold*count) n FROM batches').get().n,300000);db.close();
});
test('ticket records purchase data across two invoice dates',()=>{
 const db=setup();ingest(db,'PKR-1',150000,'sale','2083/06/01');ingest(db,'PKR-2',50000,'sale','2083/06/02');
 assign(db,1,200000,1);
 const rows=db.prepare(`SELECT i.reference,i.outlet,i.date,ts.amount FROM ticket_sources ts JOIN invoices i ON i.id=ts.invoice ORDER BY i.id`).all().map(r=>({...r}));
 assert.deepEqual(rows,[{reference:'PKR-1',outlet:'PKR',date:'2083/06/01',amount:150000},{reference:'PKR-2',outlet:'PKR',date:'2083/06/02',amount:50000}]);db.close();
});
test('invalid selected invoice rolls back import',()=>{
 const db=setup();assert.throws(()=>importGroups(db,{campaign:1,kind:'sale',groups:[{reference:'BAD',errors:['Missing phone']}]},['BAD']),/Invalid/);
 assert.equal(db.prepare('SELECT count(*) n FROM uploads').get().n,0);db.close();
});
test('phone normalization and money precision',()=>{assert.equal(phone('+977 9800000000'),'9800000000');assert.equal(phone('980-000-0000'),'9800000000');assert.equal(phone('123'),'');assert.equal(money('1,935.69'),193569);});
test('Excel date serial preserves BS components and Nepal Number identifies phone',async()=>{
 const db=setup(),wb=new ExcelJS.Workbook(),ws=wb.addWorksheet('Returns');
 ws.addRow(['Date BS','Invoice No','TotalNet Amount','Nepal Number']);
 ws.addRow([new Date(Date.UTC(2083,4,29)),'SR-WEB-1',1520,9800000000]);
 ws.getCell('A2').numFmt='yyyy/m/d';
 const p=await parseWorkbook(await wb.xlsx.writeBuffer(),db.prepare('SELECT * FROM campaigns').get(),'return',db);
 assert.equal(p.groups[0].date,'2083/05/29');assert.equal(p.groups[0].phone,'9800000000');assert.equal(p.missingPhone,false);assert.deepEqual(p.groups[0].errors,[]);db.close();
});
test('Excel finds shifted header, combines items, excludes outlet series, and validates phone and dates',async()=>{
 const db=setup(),wb=new ExcelJS.Workbook(),ws=wb.addWorksheet('Default');
 ws.addRow(['Company']);ws.addRow(['Date BS','Invoice No','Quotation Number','Customer','Item','Quantity','Rate','TotalNet Amount','Pay Mode','Phone Number']);
 ws.addRow(['2083/6/8','PKR-1','','Buyer','A',1,100,1970.72,'Cash','+9779800000000']);
 ws.addRow(['2083/6/8','PKR-1','','Buyer','B',1,100,1935.69,'Cash','9800000000']);
 ws.addRow(['2083/6/8','Ab/83/84/Ne-000001151','','Outlet','B',1,100,2000,'Cash','']);
 ws.addRow(['2083/1/1','PKR-2','','Buyer','B',1,100,2000,'Cash','9800000000']);
 const result=await parseWorkbook(await wb.xlsx.writeBuffer(),db.prepare('SELECT * FROM campaigns').get(),'sale',db);
 assert.equal(result.header,2);assert.equal(result.groups[0].amount,390641);assert.equal(result.groups[0].errors.length,0);
 assert.equal(result.groups[1].excluded,true);assert.ok(result.groups[2].errors.includes('Outside campaign dates'));db.close();
});
test('software exports with spreadsheet namespace prefixes load correctly',async()=>{
 const db=setup(),wb=new ExcelJS.Workbook(),ws=wb.addWorksheet('Default');
 ws.addRow(['Date BS','Invoice No','TotalNet Amount','Phone Number']);ws.addRow(['2083/6/8','SR-PKR-1',2000,'9800000000']);
 const zip=await JSZip.loadAsync(await wb.xlsx.writeBuffer());
 for(const name of ['xl/workbook.xml','xl/worksheets/sheet1.xml']){
  let xml=await zip.file(name).async('string');
  xml=xml.replace('xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"','xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"').replace(/(<\/?)([A-Za-z][\w]*)(?=[\s/>])/g,'$1x:$2');zip.file(name,xml);
 }
 const p=await parseWorkbook(await zip.generateAsync({type:'nodebuffer'}),db.prepare('SELECT * FROM campaigns').get(),'return',db);
 assert.equal(p.groups[0].amount,200000);assert.equal(p.groups[0].outlet,'PKR');assert.deepEqual(p.groups[0].errors,[]);db.close();
});
