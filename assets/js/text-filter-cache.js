(function (global) {
    'use strict';
    // Cache only output-only calls. Logging and fragment collection must always run.
    function create(process, isEnabled) {
        const cache = new Map();
        return (text, options = {}) => {
            const source = String(text || '');
            if (!isEnabled() || options.log || Array.isArray(options.collect)) return process(source, options);
            if (cache.has(source)) return cache.get(source);
            const result = process(source, options);
            if (cache.size >= 2000) cache.delete(cache.keys().next().value);
            cache.set(source, result);
            return result;
        };
    }
    global.RPHubTextFilterCache = Object.freeze({ create });
})(window);
