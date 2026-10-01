import { randomBytes } from 'node:crypto';
import { writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openStore, audit, transaction } from '../core.js';
import { initAuth, hashPassword } from '../auth.js';

const root=fileURLToPath(new URL('..',import.meta.url));
const credentialFile=process.argv[2];
if(!credentialFile || !existsSync(credentialFile))throw Error('Provide a pre-created, access-restricted credential file.');
const db=openStore(process.env.LOTTERY_DB || `${root}data/lottery.sqlite`);
initAuth(db);
try {
  if(db.prepare('SELECT COUNT(*) n FROM users').get().n){console.log('Users already exist; bootstrap skipped.');}
  else {
    const password=randomBytes(24).toString('base64url'),hash=await hashPassword(password);
    writeFileSync(credentialFile,`Festival Lottery initial administrator\r\n\r\nOpen: http://localhost:3010\r\nUsername: admin\r\nTemporary password: ${password}\r\n\r\nYou must change this password at first sign-in. Delete this file after changing it.\r\n`);
    transaction(db,()=>{
      db.prepare("INSERT INTO users(username,name,password_hash,role) VALUES('admin','Administrator',?,'administrator')").run(hash);
      audit(db,null,'administrator initialized','Initial administrator created by local Windows setup.');
    });
    console.log('Initial administrator created. Credentials are in the protected file.');
  }
} finally {db.close();}
