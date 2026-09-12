import { countOccurrences } from '../lib.mjs';

const original = "        const getTimelineCharCount = (text) => Array.from(String(text || '')).length;";
const legacy = `        const timelineCharCountCache = new Map();
        const getTimelineCharCount = (text) => {
            const key = String(text || '');
            if (timelineCharCountCache.has(key)) return timelineCharCountCache.get(key);
            const value = Array.from(key).length;
            timelineCharCountCache.set(key, value);
            if (timelineCharCountCache.size > 600) {
                timelineCharCountCache.delete(timelineCharCountCache.keys().next().value);
            }
            return value;
        };`;
const binding = '        const getTimelineCharCount = window.RPHubTextMetrics.createCharCounter();';

export function patchTextMetrics(source) {
  const states = [original, legacy, binding];
  if (countOccurrences(source, 'const getTimelineCharCount =') !== 1
    || states.reduce((sum, state) => sum + countOccurrences(source, state), 0) !== 1) {
    throw new Error('Timeline character counter is missing, duplicated or drifted');
  }
  return source.replace(states.find(state => source.includes(state)), binding);
}
