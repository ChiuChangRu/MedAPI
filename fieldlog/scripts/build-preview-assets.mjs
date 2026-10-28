import { mkdir, copyFile, readFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);
const pkg = new URL('node_modules/@aiden0z/pptx-renderer/', root);
const metadata = JSON.parse(await readFile(new URL('package.json', pkg), 'utf8'));
if (metadata.version !== '1.2.4') throw new Error('Unexpected PPTX renderer version');
const dest = new URL('fieldlog/public/vendor/', root);
await mkdir(dest, { recursive: true });
await copyFile(new URL('dist/aiden0z-pptx-renderer.browser.es.js', pkg), new URL('pptx-renderer-1.2.4.js', dest));
await copyFile(new URL('LICENSE', pkg), new URL('pptx-renderer-LICENSE.txt', dest));
await copyFile(new URL('node_modules/echarts/NOTICE', root), new URL('echarts-NOTICE.txt', dest));
// The browser distribution bundles JSZip and ECharts; ship their notices too.
for (const [name, license] of [['jszip', 'LICENSE.markdown'], ['echarts', 'LICENSE'], ['zrender', 'LICENSE']]) {
  await copyFile(new URL(`node_modules/${name}/${license}`, root), new URL(`${name}-LICENSE.txt`, dest));
}
// Word 排版預覽（v221）：docx-preview 的 UMD 版本吃全域 JSZip，兩支都自架，不從外部 CDN 載入
const docx = new URL('node_modules/docx-preview/', root);
const docxMeta = JSON.parse(await readFile(new URL('package.json', docx), 'utf8'));
if (docxMeta.version !== '0.4.1') throw new Error('Unexpected docx-preview version');
await copyFile(new URL('dist/docx-preview.min.js', docx), new URL('docx-preview-0.4.1.min.js', dest));
await copyFile(new URL('LICENSE', docx), new URL('docx-preview-LICENSE.txt', dest));
await copyFile(new URL('node_modules/jszip/dist/jszip.min.js', root), new URL('jszip.min.js', dest));
console.log('Built self-hosted preview assets (PPTX renderer 1.2.4, docx-preview 0.4.1).');
