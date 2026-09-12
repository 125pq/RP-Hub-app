(function (global) {
    'use strict';

    // Count Unicode code points like upstream Array.from(String(text || '')).length.
    // Keep both entry count and retained UTF-16 text bounded per app instance.
    function createCharCounter() {
        const cache = new Map();
        const maxEntries = 600;
        const maxKeyUnits = 512 * 1024;
        let keyUnits = 0;
        return (text) => {
            const key = String(text || '');
            if (cache.has(key)) return cache.get(key);
            let count = 0;
            for (const character of key) count += 1;
            if (key.length > maxKeyUnits) return count;
            while (cache.size >= maxEntries || keyUnits + key.length > maxKeyUnits) {
                const oldest = cache.keys().next().value;
                keyUnits -= oldest.length;
                cache.delete(oldest);
            }
            cache.set(key, count);
            keyUnits += key.length;
            return count;
        };
    }

    global.RPHubTextMetrics = Object.freeze({ createCharCounter });
})(window);
