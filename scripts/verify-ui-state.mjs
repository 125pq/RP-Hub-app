import fs from 'node:fs';
import readline from 'node:readline';

const INPUT = '黎明之契2.71_全部分支_chat_2.8正则UI_精简_补UI.jsonl';
const ACTIVE = '4202e577-de08-4a29-bb86-550caa4620fa';
const idx = Number(process.argv[2] || 309);

const POSITIONS = [
  'loc', 'mapLocs', 'lv', 'cl', 'rank', 'hp', 'mp', 'xp', 'xpNext', 'ap', 'sp',
  'str', 'agi', 'mag', 'con', 'per', 'cha', 'gold', 'wt', 'equip', 'bag', 'bonds',
  'travel', 'shop', 'recActions', 'enemy', 'defaultTab', 'csk', 'time', 'weather',
  'season', 'day', 'learned', 'quests', 'acceptedQ', 'partyStats', 'cd', 'shenhai',
  'du', 'desireSkills'
];

const rl = readline.createInterface({ input: fs.createReadStream(INPUT, { encoding: 'utf8' }), crlfDelay: Infinity });
let rec = null;
rl.on('line', (line) => {
  if (!line.trim()) return;
  let r; try { r = JSON.parse(line); } catch { return; }
  if (r.branchId === ACTIVE) rec = r;
});
rl.on('close', () => {
  const m = rec.messages[idx];
  const c = m.content;
  const mm = c.match(/ui:state=\|([^\r\n<]+?)(?:\|)?\s*$/);
  if (!mm) { console.log('no ui:state line found at end'); process.exit(1); }
  const body = mm[1];
  // split respecting JSON depth
  const parts = [];
  let cur = '', depth = 0, str = false, esc = false;
  for (const ch of body) {
    if (esc) { cur += ch; esc = false; continue; }
    if (ch === '\\') { cur += ch; if (str) esc = true; continue; }
    if (ch === '"') { cur += ch; str = !str; continue; }
    if (!str) {
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') depth = Math.max(0, depth - 1);
      else if (ch === '|' && depth === 0) { parts.push(cur); cur = ''; continue; }
    }
    cur += ch;
  }
  parts.push(cur);
  console.log('message', idx, 'parsed fields:', parts.length);
  parts.forEach((p, i) => {
    const name = POSITIONS[i] || `#${i}`;
    let shown = p;
    if (p.length > 220) shown = p.slice(0, 220) + ' …[' + p.length + ' chars]';
    console.log(`${String(i + 1).padStart(2)}. ${name}: ${shown}`);
  });
  // validate JSON cells parse
  const jsonKeys = ['mapLocs','equip','bag','bonds','travel','shop','recActions','enemy','csk','quests','acceptedQ','partyStats'];
  for (const k of jsonKeys) {
    const i = POSITIONS.indexOf(k);
    const v = parts[i];
    try { const parsed = v === 'null' ? null : JSON.parse(v); const kind = Array.isArray(parsed) ? 'array[' + parsed.length + ']' : (parsed && typeof parsed === 'object' ? 'obj{' + Object.keys(parsed).join(',') + '}' : String(parsed)); console.log('  ✓ JSON ok', k, '->', kind); }
    catch (e) { console.log('  ✗ JSON FAIL', k, '->', v.slice(0, 80), e.message); }
  }
});
