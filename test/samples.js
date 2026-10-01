import { readFile } from 'node:fs/promises';
import { openStore } from '../core.js';
import { parseWorkbook } from '../importer.js';
const db=openStore();
db.prepare('INSERT INTO campaigns(name,start,end,threshold) VALUES(?,?,?,?)').run('Sample review','2083/01/01','2083/12/32',200000);
for(const [path,kind] of [['D:/Invoice List Report (5).xlsx','sale'],['D:/Invoice List Report (6).xlsx','return']]){
 const p=await parseWorkbook(await readFile(path),db.prepare('SELECT * FROM campaigns').get(),kind,db);
 console.log(JSON.stringify({kind,sheet:p.sheet,header:p.header,invoices:p.groups.length,excluded:p.groups.filter(g=>g.excluded).length,missingPhone:p.missingPhone,missingDate:p.groups.filter(g=>g.errors.includes('Invalid or inconsistent Date BS')).length}));
}
db.close();
