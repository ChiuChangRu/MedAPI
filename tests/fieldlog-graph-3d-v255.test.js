/**
 * v255 3D 關聯圖：文件關聯圖與實體關聯圖共用的 Canvas 3D 引擎。
 * 排版、旋轉矩陣、視角挑選屬純計算，這裡直接在 node 驗證；畫面與互動另用瀏覽器實測。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

async function loadEngine() {
  const sandbox = { window: {}, globalThis: {}, Math, Map, Set, console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(await read("../fieldlog/public/graph3d.js"), sandbox);
  return sandbox.Graph3D;
}

test("3D 排版：中心在原點、節點散在三維空間、連線長度被彈簧拉向目標、固定種子結果可重現", async () => {
  const G = await loadEngine();
  const nodes = [{ id: "c", kind: "doc" }, ...Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, kind: i % 2 ? "doc" : "entity" }))];
  const edges = nodes.slice(1).map((n) => ({ source: "c", target: n.id, length: 140 }));
  const a = G.createSim(nodes, edges, "c"); a.settle(380);
  const b = G.createSim(nodes, edges, "c"); b.settle(380);
  assert.deepEqual([...a.pos.get("n3").x.toFixed(3)].join(""), [...b.pos.get("n3").x.toFixed(3)].join(""), "固定亂數種子：每次排出來一樣");
  assert.equal(a.pos.get("c").x, 0); assert.equal(a.pos.get("c").y, 0); assert.equal(a.pos.get("c").z, 0);
  const zs = nodes.slice(1).map((n) => a.pos.get(n.id).z);
  assert.ok(Math.max(...zs) - Math.min(...zs) > 100, "節點在深度方向也有分佈，不是貼在一個平面上");
  const dists = nodes.slice(1).map((n) => { const p = a.pos.get(n.id); return Math.hypot(p.x, p.y, p.z); });
  const mean = dists.reduce((x, y) => x + y, 0) / dists.length;
  assert.ok(mean > 80 && mean < 260, `與中心的平均距離接近連線長度（實際 ${Math.round(mean)}）`);
  // 沿用舊座標：只換篩選時畫面不跳動
  const keep = new Map([...a.pos].map(([k, v]) => [k, { x: v.x, y: v.y, z: v.z }]));
  const c = G.createSim(nodes, edges, "c", keep); c.settle(10);
  assert.ok(Math.hypot(c.pos.get("n5").x - a.pos.get("n5").x, c.pos.get("n5").y - a.pos.get("n5").y) < 15);
});

test("旋轉與反旋轉互為反運算：拖節點時螢幕位移能換算回正確的世界座標", async () => {
  const G = await loadEngine();
  for (const [yaw, pitch] of [[0.3, -0.4], [-1.2, 0.9], [2.5, -1.3]]) {
    const p = { x: 31, y: -17, z: 83 };
    const q = G.unrotate(G.rotate(p, yaw, pitch), yaw, pitch);
    assert.ok(Math.abs(q.x - p.x) < 1e-9 && Math.abs(q.y - p.y) < 1e-9 && Math.abs(q.z - p.z) < 1e-9);
  }
});

test("兩張圖都改用共用 3D 引擎；選取只換樣式不重新排版；關閉時暫停動畫、重開時恢復", async () => {
  const html = await read("../fieldlog/public/index.html");
  const gv = await read("../fieldlog/public/graph-view.js");
  const kg = await read("../fieldlog/public/entity-graph.js");
  const css = await read("../fieldlog/public/style.css");
  const sw = await read("../fieldlog/public/sw.js");
  const engine = await read("../fieldlog/public/graph3d.js");
  assert.match(html, /<script src="graph3d\.js\?v=\d+"><\/script>\s*<script src="graph-view\.js/, "引擎要在兩張圖之前載入");
  assert.match(html, /id="graph-stage" class="g3d-stage"/);
  assert.match(html, /id="kg-stage" class="g3d-stage"/);
  assert.doesNotMatch(html, /<svg id="(graph|kg)-svg"/);
  for (const [name, src] of [["graph-view", gv], ["entity-graph", kg]]) {
    assert.match(src, /Graph3D\.create\(/, `${name} 用共用引擎`);
    assert.match(src, /state\.g3d\?\.pause\(\)/, `${name} 關閉時暫停`);
    assert.match(src, /state\.g3d\?\.resume\(\)/, `${name} 重開時恢復`);
    assert.match(src, /state\.g3d\?\.setSelected\(/, `${name} 換選取不重新排版`);
  }
  assert.match(gv, /onActivate: \(id\) => recenter\(id\)/);
  assert.match(kg, /onActivate: \(id\) => recenter\(id\)/);
  for (const need of ["pointerdown", "pointermove", "wheel", "setPointerCapture", "ResizeObserver", "devicePixelRatio", "ArrowLeft", "prefers-reduced-motion", "bestView", "unrotate"]) {
    assert.ok(engine.includes(need), `引擎要有 ${need}`);
  }
  assert.match(css, /\.g3d-canvas \{[^}]*touch-action: none/, "手機上拖曳旋轉不能被頁面捲動搶走");
  assert.match(sw, /"graph3d\.js\?v=\d+"/);
});

test("版本 255 四處一致", async () => {
  const worker = await read("../fieldlog/src/worker.js");
  const app = await read("../fieldlog/public/app.js");
  const sw = await read("../fieldlog/public/sw.js");
  const html = await read("../fieldlog/public/index.html");
  const version = worker.match(/const UI_VERSION = "(\d+)";/)[1];
  assert.ok(Number(version) >= 255);
  assert.match(app, new RegExp(`const APP_VERSION = "${version}";`));
  assert.match(sw, new RegExp(`fieldlog-v${version}-`));
  assert.match(html, new RegExp(`graph3d\\.js\\?v=${version}`));
});
