import fs from 'node:fs';
import readline from 'node:readline';

const input = process.argv[2];
const output = process.argv[3];
if (!input || !output) {
  console.error('usage: node convert.mjs <input.jsonl> <output.jsonl>');
  process.exit(1);
}

// 2.8 "正则UI" ui:state 位置顺序（A-01 规范，40 个必填位置）。
const POSITIONS = [
  'loc', 'mapLocs', 'lv', 'cl', 'rank', 'hp', 'mp', 'xp', 'xpNext', 'ap', 'sp',
  'str', 'agi', 'mag', 'con', 'per', 'cha', 'gold', 'wt', 'equip', 'bag', 'bonds',
  'travel', 'shop', 'recActions', 'enemy', 'defaultTab', 'csk', 'time', 'weather',
  'season', 'day', 'learned', 'quests', 'acceptedQ', 'partyStats', 'cd', 'shenhai',
  'du', 'desireSkills'
];

const DEFAULTS = {
  mapLocs: '[]',
  equip: '{}',
  bag: '[]',
  bonds: '{}',
  travel: '{}',
  shop: 'null',
  recActions: '[]',
  enemy: 'null',
  csk: '[]',
  quests: '[]',
  acceptedQ: '[]',
  partyStats: '{}',
  shenhai: '0',
  du: 'false',
  desireSkills: ''
};

function convertStateLine(stateLine) {
  const body = stateLine.replace(/^ui:status\s*[=|]?/, '');
  const map = new Map();
  for (const seg of body.split('|')) {
    if (!seg) continue;
    const eq = seg.indexOf('=');
    if (eq < 0) {
      map.set(seg.trim(), '');
    } else {
      map.set(seg.slice(0, eq).trim(), seg.slice(eq + 1));
    }
  }
  const values = POSITIONS.map((key) => {
    if (map.has(key)) return map.get(key);
    if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) return DEFAULTS[key];
    return '';
  });
  return 'ui:state=|' + values.join('|') + '|';
}

function convertContent(content) {
  if (typeof content !== 'string') return content;
  const match = content.match(/ui:status[=|][^\r\n]*/);
  if (!match) return content;
  return content.replace(match[0], convertStateLine(match[0]));
}

let stats = { manifests: 0, branches: 0, messages: 0, converted: 0, untouched: 0, userMessages: 0, errors: 0 };
let maxLineLen = 0;

const rl = readline.createInterface({
  input: fs.createReadStream(input, { encoding: 'utf8' }),
  crlfDelay: Infinity
});
const ws = fs.createWriteStream(output, { encoding: 'utf8' });

rl.on('line', (line) => {
  if (!line.trim()) return;
  if (line.length > maxLineLen) maxLineLen = line.length;
  let rec;
  try {
    rec = JSON.parse(line);
  } catch (e) {
    stats.errors++;
    console.error('PARSE ERROR, writing line unchanged:', String(e.message).slice(0, 120));
    ws.write(line + '\n');
    return;
  }

  if (rec.type === 'rp-hub-branch-chat') {
    stats.manifests++;
    ws.write(JSON.stringify(rec) + '\n');
    return;
  }

  if (Array.isArray(rec.messages)) {
    stats.branches++;
    for (const m of rec.messages) {
      stats.messages++;
      if (m.role === 'assistant' && typeof m.content === 'string' && /ui:status[=|]/.test(m.content)) {
        m.content = convertContent(m.content);
        stats.converted++;
      } else {
        stats.untouched++;
      }
    }
    ws.write(JSON.stringify(rec) + '\n');
    return;
  }

  // unknown record: pass through
  ws.write(JSON.stringify(rec) + '\n');
});

rl.on('close', () => {
  ws.end();
  console.log('\n===== CONVERSION DONE =====');
  console.log(JSON.stringify(stats, null, 2));
  console.log('max line length:', maxLineLen);
});
