import { createHash } from 'node:crypto';
import { countOccurrences, replaceOnce } from '../lib.mjs';

const countHook = "                const { countFloors, countMessages } = window.RPHubChatExport;\n";
const streamHook = "                const chatLinesStream = window.RPHubChatExport.stream(manifest, branchChats, cloneForStorage);\n";
const browserSave = "                const chatLines = [manifest, ...branchChats].map(record => JSON.stringify(record)).join('\\n');\n                const chatBlob = new Blob([chatLines], { type: 'application/x-ndjson;charset=utf-8' });\n                cardUtils.downloadBlob(chatBlob, (char.name || 'character') + '_全部分支_chat.jsonl');\n";
const platformSave = "                const chatLinesStream = window.RPHubChatExport.stream(manifest, branchChats, cloneForStorage);\n                const result = await cardUtils.saveGeneratedFile(\n                    chatLinesStream,\n                    (char.name || 'character') + '_全部分支_chat.jsonl',\n                    { mimeType: 'application/jsonl' }\n                );\n                if (result.cancelled) return;\n";

function migrateBlock(source, startMarker, endMarker, sha, hook) {
  if (!source.includes(startMarker)) return source;
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (end < 0 || countOccurrences(source, startMarker) !== 1
    || createHash('sha256').update(source.slice(start, end)).digest('hex') !== sha) {
    throw new Error('Chat export legacy block drifted: ' + startMarker.trim());
  }
  return source.slice(0, start) + hook + source.slice(end);
}

export function patchChatExport(source) {
  const startMarker = '        const exportCharacterChat = async (index) => {';
  const endMarker = '        const exportCharacterPng = async (index) => {';
  if (countOccurrences(source, startMarker) !== 1 || countOccurrences(source, endMarker) !== 1) {
    throw new Error('Chat export boundaries are missing or ambiguous');
  }
  const start = source.indexOf(startMarker), end = source.indexOf(endMarker, start);
  if (end < 0) throw new Error('Chat export boundaries drifted');
  let body = source.slice(start, end);
  body = migrateBlock(body, '                const countFloors =', '                const branchMetadata =', 'a2a4a404bb8068d19e6c98564380491f9c3041ef5879dceec2fb1c3dba434076', countHook);
  body = migrateBlock(body, '                const chatLinesStream = (async function*', '                const result = await cardUtils.saveGeneratedFile(', 'bf4bb9ce23c17570f38cd1d145f24fa55af54ff2a1783b7f3c7229335f79fc3b', streamHook);
  if (!body.includes(countHook)) {
    body = replaceOnce(body, '                const branchMetadata =', countHook + '                const branchMetadata =', 'chat export counters');
  }
  for (const [before, after] of [
    ['messages = cloneForStorage(chatHistory.value);', 'messages = chatHistory.value;'],
    ['messages: Array.isArray(messages) ? cloneForStorage(messages) : []', 'messages: Array.isArray(messages) ? messages : []'],
    ['floorCount: getPostprocessedChatMessages(messages, { includeSystem: false }).length,', 'floorCount: countFloors(messages),'],
    ["messageCount: messages.filter(message => ['user', 'assistant'].includes(message?.role)).length,", 'messageCount: countMessages(messages),'],
    [browserSave, platformSave]
  ]) {
    if (countOccurrences(body, before) + countOccurrences(body, after) !== 1) throw new Error('Chat export anchor drifted: ' + before.slice(0, 70));
    if (body.includes(before)) body = body.replace(before, after);
  }
  if (countOccurrences(body, countHook) !== 1 || countOccurrences(body, streamHook) !== 1) throw new Error('Duplicate chat export hooks');
  return source.slice(0, start) + body + source.slice(end);
}
