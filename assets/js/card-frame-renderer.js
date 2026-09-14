// Message cards explicitly support executable HTML in iframe srcdoc, just as
// the upstream renderer supports executable fenced HTML. Keep that document
// separate while sanitizing its outer HTML; never relax DOMPurify globally.
(function () {
    const upstream = window.RPHubMessageRenderer;
    const htmlNamespace = 'http://www.w3.org/1999/xhtml';
    function sanitizeCardHtml(purifier, source, config) {
        if (typeof source !== 'string' || !/\bsrcdoc\s*=/i.test(source)) {
            return purifier.sanitize(source, config);
        }
        const template = document.createElement('template');
        template.innerHTML = source;
        const documents = new Map();
        const prefix = `rphub-frame-${crypto.randomUUID()}-`;
        for (const frame of template.content.querySelectorAll('iframe[srcdoc]')) {
            if (frame.namespaceURI !== htmlNamespace) continue;
            const token = prefix + documents.size;
            documents.set(token, frame.getAttribute('srcdoc'));
            frame.setAttribute('srcdoc', token);
        }
        if (!documents.size) return purifier.sanitize(source, config);
        // The sanitizer still decides whether the iframe and srcdoc attribute
        // are allowed, and checks every other attribute and surrounding node.
        const clean = purifier.sanitize(template.innerHTML, config);
        const result = document.createElement('template');
        result.innerHTML = clean;
        for (const frame of result.content.querySelectorAll('iframe[srcdoc]')) {
            if (frame.namespaceURI !== htmlNamespace) continue;
            const token = frame.getAttribute('srcdoc');
            if (documents.has(token)) frame.setAttribute('srcdoc', documents.get(token));
        }
        return result.innerHTML;
    }
    window.RPHubMessageRenderer = Object.freeze({
        ...upstream,
        createMessageRenderer(options) {
            const purifier = options.DOMPurify;
            return upstream.createMessageRenderer({ ...options, DOMPurify: {
                sanitize: (source, config) => sanitizeCardHtml(purifier, source, config)
            } });
        }
    });
})();
