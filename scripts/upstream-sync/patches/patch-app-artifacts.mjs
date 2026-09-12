import { countOccurrences } from '../lib.mjs';
// Only the five reviewed merge artifacts; never fold whitespace globally.
const pairs = [
  [
    "\n\n\n        const removeVectorMemoriesForConversationTurn",
    "\n\n        const removeVectorMemoriesForConversationTurn"
  ],
  [
    "\n\n\n        const hasClassicMemoryForJob",
    "\n\n        const hasClassicMemoryForJob"
  ],
  [
    "            });\n\n            requestMessages.push({\n                role: 'user',\n                content: BUILTIN_PROMPTS.buildClassicSummaryFinalInstruction(job.turn)",
    "            });\n            requestMessages.push({\n                role: 'user',\n                content: BUILTIN_PROMPTS.buildClassicSummaryFinalInstruction(job.turn)"
  ],
  [
    "                        await waitForMemoryConversationIdle(batchController.signal);\n                        continue;\n\n                    }",
    "                        await waitForMemoryConversationIdle(batchController.signal);\n                        continue;\n                    }"
  ],
  [
    "        });\n\n        const classicMemoryPageCount =",
    "        });\n        const classicMemoryPageCount ="
  ]
];
export function removeAppMergeArtifacts(source) {
  for (const [before, after] of pairs) {
    const count = countOccurrences(source, before);
    if (count > 1) throw new Error('Ambiguous app whitespace artifact');
    if (count === 1) source = source.replace(before, after);
  }
  return source;
}
