// Runs inside a real browser; no user card contents or storage are needed.
export async function testCardFrameRenderer() {
    const ensure = (value, message) => { if (!value) throw new Error(message); };
    const create = (purifier = DOMPurify) => RPHubMessageRenderer.createMessageRenderer({
        processRegex: text => text, replaceUserPlaceholder: text => text,
        createExecutableHtmlIframe: html => { const f = document.createElement('iframe'); f.srcdoc = html; return f; },
        marked, DOMPurify: purifier
    });
    const html = '<!doctype html><style>body{color:rgb(1,2,3)}</style><button id="next">Next</button><script>document.body.dataset.ready="yes";document.querySelector("button").onclick=()=>document.body.dataset.clicked="yes";</script>';
    const raw = document.createElement('iframe');
    raw.srcdoc = html;
    raw.setAttribute('sandbox', 'allow-scripts');
    raw.setAttribute('onload', 'window.outerEventRan=true');
    const source = '<div>' + raw.outerHTML + '<img src="x" onerror="window.outerEventRan=true"><a href="javascript:alert(1)">bad</a></div>';
    const renderer = create();
    const output = renderer.renderMarkdown(source);
    const parsed = document.createElement('template'); parsed.innerHTML = output;
    const frame = parsed.content.querySelector('iframe');
    ensure(frame?.srcdoc === html, 'full executable srcdoc was lost or changed');
    ensure(frame.getAttribute('sandbox') === 'allow-scripts', 'sandbox changed');
    ensure(!frame.hasAttribute('onload'), 'outer onload survived');
    ensure(!parsed.content.querySelector('img').hasAttribute('onerror'), 'outer onerror survived');
    ensure(!parsed.content.querySelector('a').hasAttribute('href'), 'javascript URL survived');
    ensure(renderer.renderMarkdown(source) === output, 'cached rendering changed');
    const denied = create({ sanitize: (value, config) => DOMPurify.sanitize(value, { ...config, FORBID_TAGS: ['iframe'] }) });
    ensure(!denied.renderMarkdown(source).includes('<iframe'), 'forbidden iframe resurrected');
    const deniedAttr = create({ sanitize: (value, config) => DOMPurify.sanitize(value, { ...config, FORBID_ATTR: ['srcdoc'] }) });
    ensure(!deniedAttr.renderMarkdown(source).includes('srcdoc='), 'forbidden srcdoc resurrected');
    ensure(create().renderMarkdown('hello **world**').includes('<strong>world</strong>'), 'ordinary Markdown regressed');
    // Script execution happens only after the caller mounts the resulting frame.
    const mounted = document.createElement('iframe');
    mounted.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    mounted.srcdoc = frame.srcdoc;
    try {
        const loaded = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('frame load timeout')), 5000);
            mounted.onload = () => { clearTimeout(timer); resolve(); };
        });
        document.body.append(mounted);
        await loaded;
        ensure(mounted.contentDocument.body.dataset.ready === 'yes', 'frame script did not initialize');
        mounted.contentDocument.querySelector('button').click();
        ensure(mounted.contentDocument.body.dataset.clicked === 'yes', 'frame interaction failed');
    } finally { mounted.remove(); }
    return 'Card frame: srcdoc/style/script/interaction, outer sanitization, deny rules, cache and Markdown PASS';
}
