import { webFixturePath, readUpstreamSource } from './web-fixture.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { composeApp } from '../compose/app-transform.mjs';
import { patchAppFilterCache } from '../upstream-sync/patches/patch-app-filter-cache.mjs';
const current = readFileSync(webFixturePath('assets/js/app.js'),'utf8').replace(/\r\n/g,'\n');
const upstream = readUpstreamSource('assets/js/app.js');
const legacy = execFileSync('git',['show','4afa9a5:assets/js/app.js'],{encoding:'utf8'}).replace(/\r\n/g,'\n');
assert.equal(composeApp(upstream), current);
assert.equal(composeApp(current), current);
assert.equal(composeApp(upstream + '\n// new feature'), current + '\n// new feature');
assert.ok(!patchAppFilterCache(legacy).includes('filteredContentCache'));
const cut = (source, start, end) => source.slice(source.indexOf(start),source.indexOf(end, source.indexOf(start)));
const originalBody = cut(upstream, '        const filterBlockedStyleText =', '        const getPostprocessedChatMessages =');
const rawBody = cut(current, '        const filterBlockedStyleTextUncached =', '        const filterBlockedStyleText =');
assert.equal(rawBody.replace('filterBlockedStyleTextUncached', 'filterBlockedStyleText'), originalBody, 'Upstream filtering algorithm stays exact');
const definitions = cut(upstream, '        const blockedStyleSentencePattern =', '        const styleFilterHighlightPattern =');
const cachedBody = cut(current, '        const filterBlockedStyleTextUncached =', '        const getPostprocessedChatMessages =');
function load(body) {
  const logs = [], settings = { styleFilterEnabled: true }; let transforms = 0;
  const context = vm.createContext({window:{},settings,ref:value=>({value}),console:{ info: (...args)=>logs.push(args) },
    findUiTemplateUpdateBlock: text => { const index=text.indexOf('[UI]'); return index<0 ? null : {index}; },
    cardUtils: { transformUnprotectedText:(text,fn)=>{transforms++;return fn(text);} }
  });
  vm.runInContext(readFileSync(webFixturePath('assets/js/text-filter-cache.js'),'utf8'),context);
  const run=vm.runInContext(definitions+body+'\nfilterBlockedStyleText;',context);
  return {run,logs,settings,get transforms(){return transforms;}};
}
const raw=load(originalBody),cached=load(cachedBody);
for(const text of ['', null, '普通文字😀', '极其安静。', '“极其安静。”正常。', '<div>极其安静</div>', '普通。\n\n极其安静。', '极其安静。[UI]极其']) {
  assert.equal(cached.run(text),raw.run(text));
  assert.equal(cached.run(text),raw.run(text));
  const a=[],b=[];
  assert.equal(cached.run(text,{collect:a}),raw.run(text,{collect:b}));assert.deepEqual(a,b);
  assert.equal(cached.run(text,{log:true}),raw.run(text,{log:true}));
}
assert.equal(JSON.stringify(cached.logs),JSON.stringify(raw.logs));
const before=cached.transforms;cached.run('缓存测试');cached.run('缓存测试');assert.equal(cached.transforms,before+1);
cached.settings.styleFilterEnabled=false;raw.settings.styleFilterEnabled=false;
assert.equal(cached.run('极其安静。'),raw.run('极其安静。'));
cached.settings.styleFilterEnabled=true;raw.settings.styleFilterEnabled=true;
assert.equal(cached.run('极其安静。'),raw.run('极其安静。'));
console.log('App composition: complete reconstruction and exact upstream filter body; cache hits, logging, collection and toggle behavior PASS');
