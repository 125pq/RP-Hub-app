import fs from 'node:fs';
import readline from 'node:readline';

// ---- inputs ----
const TEMPLATE_FILE = 'D:/xwechat_files/wxid_9w4i2ar60u5t12_60a6/msg/file/2026-08/黎明之契2.71_ui_templates (1).json';
const INPUT_CHAT = '黎明之契2.71_全部分支_chat_2.8正则UI_精简.jsonl';
const OUTPUT_CHAT = '黎明之契2.71_全部分支_chat_2.8正则UI_精简_补UI.jsonl';
const ACTIVE = '4202e577-de08-4a29-bb86-550caa4620fa';
const TARGET_INDICES = [301, 303, 305, 307, 309]; // last 5 assistant messages (variable-UI tail)

// 2.8 A-01 40-position order
const POSITIONS = [
  'loc', 'mapLocs', 'lv', 'cl', 'rank', 'hp', 'mp', 'xp', 'xpNext', 'ap', 'sp',
  'str', 'agi', 'mag', 'con', 'per', 'cha', 'gold', 'wt', 'equip', 'bag', 'bonds',
  'travel', 'shop', 'recActions', 'enemy', 'defaultTab', 'csk', 'time', 'weather',
  'season', 'day', 'learned', 'quests', 'acceptedQ', 'partyStats', 'cd', 'shenhai',
  'du', 'desireSkills'
];

function sanitize(s) {
  return String(s).replace(/\|/g, '｜').replace(/</g, '〈').replace(/>/g, '〉');
}

function jsonCell(v) {
  if (v === null || v === undefined) return 'null';
  return sanitize(JSON.stringify(v));
}

function scalarCell(v) {
  if (v === null || v === undefined) return '';
  return sanitize(String(v));
}

// Build the 40 values for a state object.
function buildCells(state) {
  const cells = [];
  for (const key of POSITIONS) {
    let v = state[key];
    if (key === 'enemy' && Array.isArray(v) && v.length === 0) v = null; // 2.8: non-combat -> null
    if (key === 'du') {
      // 2.71 uses "" for not-activated; 2.8 expects false/true
      const s = String(v ?? '');
      v = (s === '' || s === 'false' || s === '0') ? 'false' : 'true';
    }
    if (key === 'shenhai') {
      const n = parseInt(v, 10);
      v = Number.isNaN(n) ? 0 : n;
    }
    const isJson = ['mapLocs', 'equip', 'bag', 'bonds', 'travel', 'shop', 'recActions', 'enemy', 'csk', 'quests', 'acceptedQ', 'partyStats'].includes(key);
    if (isJson) {
      cells.push(jsonCell(v));
    } else {
      cells.push(scalarCell(v));
    }
  }
  return cells;
}

function toStateLine(state) {
  return 'ui:state=|' + buildCells(state).join('|') + '|';
}

// apply a dotted-key patch ({'state.loc': x, 'state.bonds': y}) onto state (mutates)
function applyPatch(state, variables) {
  for (const [k, v] of Object.entries(variables)) {
    if (k.startsWith('state.')) {
      const sub = k.slice('state.'.length);
      state[sub] = v;
    } else {
      state[k] = v;
    }
  }
}

function deepClone(x) { return JSON.parse(JSON.stringify(x)); }

// ---- load base state ----
const tpl = JSON.parse(fs.readFileSync(TEMPLATE_FILE, 'utf8'));
const base = tpl.templates[0].initialVariableState.state;
console.log('base state loaded. loc=', base.loc, 'rank=', base.rank, 'learned=', base.learned, 'gold=', base.gold);

// ---- walk chat, extract patches, build per-message state ----
const messages = [];
const patches = new Map(); // index -> variables object (only for assistant messages with <ui_template_updates>)

async function main() {
  const rl = readline.createInterface({ input: fs.createReadStream(INPUT_CHAT, { encoding: 'utf8' }), crlfDelay: Infinity });
  let manifest = null;
  const branchRecords = [];
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let rec; try { rec = JSON.parse(line); } catch { return; }
    if (rec.type === 'rp-hub-branch-chat') { manifest = rec; branchRecords.push(rec); return; }
    branchRecords.push(rec);
    if (rec.branchId === ACTIVE) {
      for (let i = 0; i < rec.messages.length; i++) {
        const m = rec.messages[i];
        const c = typeof m.content === 'string' ? m.content : '';
        const p = extractPatch(c);
        if (p) patches.set(i, p);
      }
    }
  });
  await new Promise((res) => rl.on('close', res));

  // Build cumulative state at each target index.
  // base == state after message 301. Apply patches from message 302 onward.
  const targetSet = new Set(TARGET_INDICES);
  const stateAt = new Map(); // index -> state object

  // find max target index to know walk range
  let state = deepClone(base);
  // iterate assistant patches in order from 0..309; but only patches AFTER 301 change things relative to base.
  // Simpler: reconstruct from base@301 forward over messages 302..maxTarget.
  const maxT = Math.max(...TARGET_INDICES);
  for (let i = 302; i <= maxT; i++) {
    if (targetSet.has(i)) stateAt.set(i, deepClone(state)); // state BEFORE this message's patch = state at previous turn... 
    // hmm: we need state AT message i = state after applying message i's patch.
    // For target 301 the state is base. For 303+ we apply 303's patch first.
  }

  // Cleaner: walk messages 301..maxT in order; capture state BEFORE applying each message's own patch
  // but for message 301 there is no patch (base already includes it).
  state = deepClone(base);
  stateAt.set(301, deepClone(base));
  for (let i = 302; i <= maxT; i++) {
    const p = patches.get(i);
    if (p) {
      applyPatch(state, p);
      if (targetSet.has(i)) stateAt.set(i, deepClone(state));
    }
  }

  console.log('patches found:', patches.size);
  for (const i of TARGET_INDICES) {
    const s = stateAt.get(i);
    if (!s) { console.log(`[${i}] NO STATE`); continue; }
    const line = toStateLine(s);
    console.log(`\n[${i}] loc=${s.loc} time=${s.time} gold=${s.gold} rank=${s.rank} bonds=${JSON.stringify(s.bonds)} learned=${s.learned}`);
    console.log(line.slice(0, 600) + (line.length > 600 ? ' ...' : ''));
    console.log('  full line length:', line.length);
  }

  // ---- rewrite file: append ui:state to target messages ----
  const outWs = fs.createWriteStream(OUTPUT_CHAT, { encoding: 'utf8' });
  const rl2 = readline.createInterface({ input: fs.createReadStream(INPUT_CHAT, { encoding: 'utf8' }), crlfDelay: Infinity });
  let appended = 0;
  rl2.on('line', (line) => {
    if (!line.trim()) { outWs.write(line + '\n'); return; }
    let rec; try { rec = JSON.parse(line); } catch { outWs.write(line + '\n'); return; }
    if (rec.branchId === ACTIVE) {
      for (const i of TARGET_INDICES) {
        const s = stateAt.get(i);
        if (!s) continue;
        const m = rec.messages[i];
        if (typeof m.content === 'string' && !/ui:state[=|]/.test(m.content) && !/ui:status[=|]/.test(m.content)) {
          m.content = m.content.replace(/\s+$/, '') + '\n' + toStateLine(s);
          appended++;
        }
      }
    }
    outWs.write(JSON.stringify(rec) + '\n');
  });
  await new Promise((res) => rl2.on('close', res));
  outWs.end();
  console.log('\n===== DONE =====');
  console.log('appended ui:state to', appended, 'messages');
  console.log('output:', OUTPUT_CHAT);
}

function extractPatch(content) {
  const m = content.search(/<ui_template_updates>/);
  if (m < 0) return null;
  const body = content.slice(m + '<ui_template_updates>'.length);
  const end = body.indexOf('</ui_template_updates>');
  const jsonStr = body.slice(0, end >= 0 ? end : body.length).trim();
  if (!jsonStr) return null;
  let j; try { j = JSON.parse(jsonStr); } catch { return null; }
  const upds = j.updates || [];
  if (upds.length === 0) return null;
  // merge all updates' variables (usually 1)
  const merged = {};
  for (const u of upds) Object.assign(merged, u.variables || {});
  return merged;
}

main().catch((e) => { console.error(e); process.exit(1); });
