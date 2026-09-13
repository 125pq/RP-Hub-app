// Backup/import tests isolate snapshot policy from the IndexedDB chunk store.
// The actual store is exercised against a real browser by check-browser.mjs.
export function recoveryFixture(onSave) {
  let saved;
  return {
    async save(stream, filename) {
      const parts = [];
      for await (const part of stream) parts.push(part);
      await onSave?.(parts, filename);
      saved = { metadata: { filename, local: true }, parts };
      return saved.metadata;
    },
    async withLatest(consume) {
      if (!saved) throw new Error('No recovery');
      return consume(saved.metadata, (async function* () { yield* saved.parts; })());
    }
  };
}
