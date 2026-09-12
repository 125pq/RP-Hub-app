import { countOccurrences } from '../lib.mjs';

// Save-boundary substitutions only: preserve the upstream data mapping and UI flow.
const exports = [
  {
    "name": "downloadJsonFile",
    "start": "        const downloadJsonFile =",
    "end": "        const readJsonFileInput =",
    "pairs": [
      [
        "        const downloadJsonFile = (data, fileName, spacing = 2, options = {}) => {",
        "        const downloadJsonFile = async (data, fileName, spacing = 2, options = {}) => {"
      ],
      [
        "            const blob = new Blob([json], { type: 'application/json;charset=utf-8' });\n            cardUtils.downloadBlob(blob, fileName, options);\n            return blob;\n",
        "            return cardUtils.saveGeneratedFile(json, fileName, {\n                ...options,\n                mimeType: 'application/json'\n            });\n"
      ]
    ]
  },
  {
    "name": "exportCharacterJson",
    "start": "        const exportCharacterJson =",
    "end": "        const exportCharacterChat =",
    "pairs": [
      [
        "        const exportCharacterJson = (index) => {",
        "        const exportCharacterJson = async (index) => {"
      ],
      [
        "                const blob = new Blob([JSON.stringify(v2Data, null, 2)], { type: 'application/json' });\n                cardUtils.downloadBlob(blob, (char.name || 'character') + '.json');\n",
        "                const result = await cardUtils.saveGeneratedFile(\n                    JSON.stringify(v2Data, null, 2),\n                    (char.name || 'character') + '.json',\n                    { mimeType: 'application/json' }\n                );\n                if (result.cancelled) return;\n"
      ]
    ]
  },
  {
    "name": "exportCharacterPng",
    "start": "        const exportCharacterPng =",
    "end": "        // Preset Management",
    "pairs": [
      [
        "                cardUtils.downloadBlob(new Blob([finalPng], { type: 'image/png' }), (char.name || 'character') + '.png');\n",
        "                const result = await cardUtils.saveGeneratedFile(\n                    new Blob([finalPng], { type: 'image/png' }),\n                    (char.name || 'character') + '.png',\n                    { mimeType: 'image/png' }\n                );\n                if (result.cancelled) return;\n"
      ]
    ]
  },
  {
    "name": "confirmExport",
    "start": "            confirmExport:",
    "end": "            importPresets:",
    "pairs": [
      [
        "            confirmExport: () => {",
        "            confirmExport: async () => {"
      ],
      [
        "                downloadJsonFile(dataToExport, fileName);\n\n",
        "                let result;\n                try {\n                    result = await downloadJsonFile(dataToExport, fileName);\n                } catch (error) {\n                    showToast(`导出失败: ${error.message || '文件保存失败'}`, 'error');\n                    return;\n                }\n                if (result.cancelled) return;\n\n"
      ]
    ]
  }
];

export function patchAppFileExport(source) {
  for (const entry of exports) {
    if (countOccurrences(source, entry.start) !== 1 || countOccurrences(source, entry.end) !== 1) {
      throw new Error('App file export boundary missing or ambiguous: ' + entry.name);
    }
    const start = source.indexOf(entry.start);
    const end = source.indexOf(entry.end, start);
    if (end < 0) throw new Error('App file export order drifted: ' + entry.name);
    let body = source.slice(start, end);
    for (const [before, after] of entry.pairs) {
      if (countOccurrences(body, before) + countOccurrences(body, after) !== 1) {
        throw new Error('App file export save boundary drifted: ' + entry.name);
      }
      if (body.includes(before)) body = body.replace(before, after);
    }
    source = source.slice(0, start) + body + source.slice(end);
  }
  return source;
}
