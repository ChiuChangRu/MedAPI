import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

// Exercise the shipped browser renderer and controls against a real two-slide
// PPTX containing text, tables and embedded images. No browser pixel/layout claims.
const dom = new JSDOM('<!doctype html><div id="preview"></div>', { pretendToBeVisual: true, url: 'https://mywiki.test/' });
for (const key of ['window','document','DOMParser','XMLSerializer','HTMLElement','Element','Node','Event','EventTarget','CustomEvent','Image']) globalThis[key] = dom.window[key];
for (const key of ['getComputedStyle','requestAnimationFrame','cancelAnimationFrame']) globalThis[key] = dom.window[key].bind(dom.window);
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', { get() { return 800; } });
dom.window.HTMLCanvasElement.prototype.getContext = () => ({ measureText: (text) => ({ width: text.length * 8 }), font: '' });
dom.window.HTMLMediaElement.prototype.pause = function () {};
const { renderPptxPreview } = await import('../fieldlog/public/pptx-preview.js');
const fixture = Buffer.from(await readFile(new URL('./fixtures/visual-preview.pptx.b64', import.meta.url), 'utf8'), 'base64');
const body = document.querySelector('#preview');
const nativeFetch = globalThis.fetch;
const tick = () => new Promise(resolve => setTimeout(resolve, 30));
const stage = () => body.querySelector('.pptx-preview-stage').shadowRoot;
async function open() {
  body._previewCleanup?.();
  globalThis.fetch = async (url, options) => { assert.equal(options.credentials, 'same-origin'); return new Response(fixture); };
  await renderPptxPreview('/api/file/private.pptx', body, 'Example.pptx');
  await tick();
}

test('PPTX renders positioned slide objects, a table and embedded image; text is escaped', async () => {
  await open();
  assert.equal(body.querySelector('[data-count]').textContent, '2');
  assert.equal(body.querySelector('pre'), null);
  assert.match(stage().textContent, /Preview title <script>literal text<\/script>/);
  assert.equal(stage().querySelector('script'), null);
  assert.match(stage().textContent, /Devices12/);
  const image = stage().querySelector('img');
  assert.ok(image?.src.startsWith('blob:'));
  assert.ok((await nativeFetch(image.src)).ok);
  assert.ok(stage().querySelector('[style*="position: absolute"]'));
  body._previewCleanup();
});

test('navigation updates page boundaries, clamps page input and keeps the second slide visual', async () => {
  await open();
  const prev = body.querySelector('[data-prev]'), next = body.querySelector('[data-next]'), page = body.querySelector('[data-page]');
  assert.equal(prev.disabled, true); assert.equal(next.disabled, false);
  await next.onclick(); await tick();
  assert.equal(page.value, '2'); assert.equal(next.disabled, true);
  assert.match(stage().textContent, /Second slide/); assert.ok(stage().querySelector('img'));
  page.value = '999'; await page.onchange(); assert.equal(page.value, '2');
  await prev.onclick(); assert.equal(page.value, '1'); assert.equal(prev.disabled, true);
  body._previewCleanup();
});

test('disposing preview removes slide DOM and revokes image blob URLs', async () => {
  await open(); const imageUrl = stage().querySelector('img').src;
  const cleanup = body._previewCleanup; cleanup(); cleanup();
  assert.equal(body._previewCleanup, null);
  assert.equal(stage().querySelector('.slides').childElementCount, 0);
  await assert.rejects(nativeFetch(imageUrl));
});

test('failed file fetch shows a retry action, never OCR text; retry can recover', async () => {
  globalThis.fetch = async () => new Response('', { status: 404 });
  await renderPptxPreview('/api/file/missing.pptx', body, 'Missing.pptx');
  assert.match(body.querySelector('[role=status]').textContent, /無法產生投影片画面|無法產生投影片畫面/);
  assert.equal(body.querySelector('[data-next]').disabled, true);
  globalThis.fetch = async () => new Response(fixture);
  await body.querySelector('[role=status] button').onclick();
  assert.equal(body.querySelector('[data-count]').textContent, '2');
  body._previewCleanup();
});

test('closing an in-flight preview aborts it without replacing the new pane', async () => {
  let release;
  globalThis.fetch = (url, options) => new Promise((resolve, reject) => {
    release = () => resolve(new Response(fixture));
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted','AbortError')), { once:true });
  });
  const pending = renderPptxPreview('/api/file/slow.pptx', body, 'Slow.pptx');
  body._previewCleanup(); body.innerHTML = '<p>Different file</p>'; release(); await pending;
  assert.equal(body.textContent, 'Different file');
});

test.after(() => { globalThis.fetch = nativeFetch; dom.window.close(); });
