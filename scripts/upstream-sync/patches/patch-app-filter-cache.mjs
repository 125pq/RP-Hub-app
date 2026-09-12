import { countOccurrences, replaceOnce } from '../lib.mjs';

const legacyIntro = "        // Per-message memoization of the blocked-style filter. filterBlockedStyleText is a pure\n        // function of its input (all patterns are constants), so caching by content string is\n        // byte-exact. This avoids re-filtering the whole stable history on every streaming flush:\n        // only messages whose content actually changed miss the cache. The `log` path is excluded\n        // from the cache so its diagnostic side effects (console + fragment dedup) stay intact.\n        const filteredContentCache = new Map();\n        const FILTERED_CONTENT_CACHE_MAX = 2000;\n";
const legacyHit = "            if (!log) {\n                const cached = filteredContentCache.get(source);\n                if (cached !== undefined) return cached;\n            }\n";
const legacyPut = "            } else {\n                if (filteredContentCache.size >= FILTERED_CONTENT_CACHE_MAX) {\n                    filteredContentCache.delete(filteredContentCache.keys().next().value);\n                }\n                filteredContentCache.set(source, result);\n            }\n";
const originalMessages = "        const getPostprocessedChatMessages = (messages = chatHistory.value, options = {}) => (\n            postprocessChatHistory(messages, options).map(message => message.role === 'assistant'\n                ? { ...message, content: filterBlockedStyleText(message.content) }\n                : message)\n        );\n";
const cachedMessages = "        const getPostprocessedChatMessages = (messages = chatHistory.value, options = {}) => {\n            const merged = postprocessChatHistory(messages, options);\n            // countOnly: callers that only need the merged-message count (e.g. floor stats)\n            // skip the blocked-style filter entirely. The merge result length depends only on\n            // the role sequence, never on content, so filtering is pure waste here.\n            if (options.countOnly) return merged;\n            return merged.map(message => message.role === 'assistant'\n                ? { ...message, content: filterBlockedStyleText(message.content) }\n                : message);\n        };\n";
const binding = "        const filterBlockedStyleText = window.RPHubTextFilterCache.create(filterBlockedStyleTextUncached, () => settings.styleFilterEnabled);\n";

function replaceLegacy(source, before, after, label) {
  if (countOccurrences(source, before) !== 1) {
    if (after && countOccurrences(source, after) === 1) return source;
    throw new Error('Legacy filter migration drifted: ' + label);
  }
  return source.replace(before, after);
}

export function patchAppFilterCache(source) {
  if (source.includes('const filteredContentCache =')) {
    if (source.includes(binding)) source = replaceLegacy(source, binding, '', 'partial cache binding');
    source = replaceLegacy(source, legacyIntro, '', 'legacy filter cache declaration');
    source = replaceLegacy(source, legacyHit, '', 'legacy filter cache hit');
    source = replaceLegacy(source, '            const result = filtered + source.slice(filterEnd);\n', '', 'legacy filter result');
    source = replaceLegacy(source, legacyPut, '            }\n', 'legacy filter cache write');
    source = replaceLegacy(source, '            return result;\n        };\n        const getPostprocessedChatMessages =', '            return filtered + source.slice(filterEnd);\n        };\n        const getPostprocessedChatMessages =', 'legacy filter return');
  }
  if (!source.includes(binding)) {
    source = replaceOnce(source, '        const filterBlockedStyleText = (text,', '        const filterBlockedStyleTextUncached = (text,', 'upstream filter declaration');
    source = replaceOnce(source, '        const getPostprocessedChatMessages =', binding + '        const getPostprocessedChatMessages =', 'filter cache binding');
  }
  if (countOccurrences(source, binding) !== 1 || countOccurrences(source, 'const filterBlockedStyleTextUncached =') !== 1) throw new Error('Filter cache binding ambiguous');
  if (countOccurrences(source, originalMessages) + countOccurrences(source, cachedMessages) !== 1) throw new Error('Postprocessed message wrapper drifted');
  if (source.includes(originalMessages)) source = source.replace(originalMessages, cachedMessages);
  for (const [text, expected] of [['chatHistory.value', 3], ['sourceChatHistory', 1]]) {
    const before = 'getPostprocessedChatMessages(' + text + ', { includeSystem: false }).length';
    const after = 'getPostprocessedChatMessages(' + text + ', { includeSystem: false, countOnly: true }).length';
    if (countOccurrences(source, before) + countOccurrences(source, after) !== expected) throw new Error('Count-only call sites drifted');
    source = source.split(before).join(after);
  }
  return source;
}
