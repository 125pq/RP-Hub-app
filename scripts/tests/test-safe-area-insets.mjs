import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../../assets/js/safe-area.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../../assets/css/safe-area.css', import.meta.url), 'utf8');
const backup = await readFile(new URL('../../assets/js/rphub-backup.js', import.meta.url), 'utf8');

assert.match(css, /--safe-top:\s*var\(--safe-area-inset-top,\s*env\(safe-area-inset-top,\s*0px\)\)/);
assert.match(css, /--safe-bottom:\s*var\(--safe-area-inset-bottom,\s*env\(safe-area-inset-bottom,\s*0px\)\)/);
assert.match(source, /var\(--safe-area-inset-top,env\(safe-area-inset-top,0px\)\)/);
assert.match(source, /if \(root !== document\.documentElement\)/);
assert.match(source, /if \(root !== document\.documentElement\) \{[\s\S]*root\.style\.setProperty\('--safe-top'/);
assert.match(backup, /var\(--safe-area-inset-bottom, env\(safe-area-inset-bottom, 0px\)\)/);

const createStyle = initial => {
  const values = new Map(Object.entries(initial));
  return {
    setProperty(name, value) { values.set(name, value); },
    getPropertyValue(name) { return values.get(name) || ''; },
    values
  };
};

const run = ({ insets, keyboardOpen = false, crossOrigin = false }) => {
  const root = { style: createStyle({ '--safe-area-inset-top': `${insets.top}px`, '--safe-area-inset-right': `${insets.right}px`, '--safe-area-inset-bottom': `${insets.bottom}px`, '--safe-area-inset-left': `${insets.left}px` }), classList: { toggle() {} } };
  const iframeRoot = { style: createStyle({}) };
  const iframe = { get contentDocument() { if (crossOrigin) throw new Error('cross origin'); return { documentElement: iframeRoot }; } };
  const probeStyle = { paddingTop: `${insets.top}px`, paddingRight: `${insets.right}px`, paddingBottom: `${insets.bottom}px`, paddingLeft: `${insets.left}px` };
  const document = {
    documentElement: root,
    body: { appendChild() {} },
    createElement() { return { style: {}, setAttribute() {} }; },
    querySelectorAll() { return [iframe]; }
  };
  const window = {
    document,
    innerHeight: 800,
    visualViewport: { height: keyboardOpen ? 500 : 800, offsetTop: 0, addEventListener() {} },
    addEventListener() {},
    requestAnimationFrame(callback) { callback(); return 1; },
    cancelAnimationFrame() {}
  };
  const context = vm.createContext({ window, document, requestAnimationFrame: window.requestAnimationFrame, cancelAnimationFrame: window.cancelAnimationFrame, getComputedStyle: () => probeStyle });
  vm.runInContext(source, context);
  return { root, iframeRoot, window };
};

let result = run({ insets: { top: 28, right: 9, bottom: 24, left: 7 } });
assert.equal(result.root.style.getPropertyValue('--safe-top'), '');
assert.equal(result.root.style.getPropertyValue('--safe-bottom'), '');
assert.equal(result.iframeRoot.style.getPropertyValue('--safe-top'), '28px');
assert.equal(result.iframeRoot.style.getPropertyValue('--safe-right'), '9px');
assert.equal(result.iframeRoot.style.getPropertyValue('--safe-bottom'), '24px');
assert.equal(result.iframeRoot.style.getPropertyValue('--safe-left'), '7px');

result = run({ insets: { top: 0, right: 0, bottom: 0, left: 0 } });
assert.equal(result.root.style.getPropertyValue('--safe-area-inset-top'), '0px');
assert.equal(result.root.style.getPropertyValue('--safe-top'), '');

result = run({ insets: { top: 0, right: 12, bottom: 34, left: 16 }, keyboardOpen: true });
assert.equal(result.root.style.getPropertyValue('--safe-area-keyboard-inset'), '300px');
assert.equal(result.iframeRoot.style.getPropertyValue('--safe-bottom-effective'), '0px');

result = run({ insets: { top: 0, right: 18, bottom: 0, left: 22 }, crossOrigin: true });
assert.equal(result.root.style.getPropertyValue('--safe-left'), '');
assert.equal(result.root.style.getPropertyValue('--safe-area-keyboard-inset'), '0px');

console.log('Capacitor 8 safe-area fallback, iframe, keyboard, and landscape contracts: PASS');
