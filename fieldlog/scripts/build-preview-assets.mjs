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
console.log('Built self-hosted PPTX preview assets (renderer 1.2.4).');
