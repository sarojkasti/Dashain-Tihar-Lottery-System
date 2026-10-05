import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = new DatabaseSync(process.env.LOTTERY_DB || join(root, 'data/lottery.sqlite'));

const pending = db.prepare("SELECT id, message FROM messages WHERE status='pending'").all();
let updated = 0;

for (const row of pending) {
  const match = row.message.match(/^Your festival lottery tickets: (.+)\. Thank you/);
  if (!match) continue;
  const codes = match[1].split(', ');
  for (const code of codes) {
    const newMsg = `You are in! Your Newmew Dashain Giveaway voucher code is ${code.trim()}. Keep this code safe for your chance to win a 2 Nights / 3 Days stay at Rupakot Resort for two, including dinner & breakfast. While you are here, explore more of our latest designs and exclusive offers at the Newmew website. www.newmew.com Good luck!`;
    if (codes.length === 1) {
      db.prepare("UPDATE messages SET message=? WHERE id=?").run(newMsg, row.id);
    } else {
      db.prepare("UPDATE messages SET message=? WHERE id=?").run(newMsg, row.id);
      break; // only update first code if batched; new assigns are now 1-per-code
    }
  }
  updated++;
}

console.log(`Updated ${updated} pending messages to new format.`);
