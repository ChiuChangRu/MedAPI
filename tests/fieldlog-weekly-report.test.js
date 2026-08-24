import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("首頁提供本週周報入口，並呼叫每週唯一模板 API", async () => {
  const [html, app] = await Promise.all([
    read("fieldlog/public/index.html"),
    read("fieldlog/public/app.js"),
  ]);
  assert.match(html, /id="btn-weekly-report"/);
  assert.match(app, /api\("\/weekly-reports\/current", \{ method: "POST" \}\)/);
  assert.match(app, /\$\("btn-weekly-report"\)\.onclick = openCurrentWeeklyReport/);
});

test("同一 ISO 週只建立一份週報，且固定放在工作週報資料夾", async () => {
  const worker = await read("fieldlog/src/worker.js");
  assert.match(worker, /WEEKLY_REPORT_FOLDER_ROLE = "weekly_reports"/);
  assert.match(worker, /json_extract\(fields_json, '\$\._kind'\) = 'weekly_report'/);
  assert.match(worker, /json_extract\(fields_json, '\$\.週次'\) = \?/);
  assert.match(worker, /_kind: "weekly_report"/);
  assert.match(worker, /const title = `\$\{report\.key\} 工作週報/);
});

test("週報編輯器保留固定規劃，提供本週／下週欄位與明確儲存按鈕", async () => {
  const app = await read("fieldlog/public/app.js");
  assert.match(app, /readonly>\$\{esc\(fields\["中長期規劃"\]/);
  assert.match(app, /data-key="本週工作報告"/);
  assert.match(app, /data-key="下週重要工作計畫"/);
  assert.match(app, /id="e-save">儲存<\/button>/);
  assert.match(app, /const patch = \{ title:[\s\S]*?fields: newFields \};[\s\S]*?if \(isWeeklyReport\) patch\.body_format = "text";/);
  assert.doesNotMatch(app, /class="e-field weekly-report-textarea fixed"/);
});

test("Claude MCP 只能更新 weekly_report 白名單欄位", async () => {
  const mcp = await read("mcp/src/worker.js");
  assert.match(mcp, /name: "update_weekly_report"/);
  assert.match(mcp, /if \(fields\._kind !== "weekly_report"\)/);
  assert.match(mcp, /fields\["本週工作報告"\] =/);
  assert.match(mcp, /args\.next_week_plan !== undefined/);
  assert.doesNotMatch(
    mcp.match(/name: "update_weekly_report"[\s\S]*?name: "create_fieldlog_attachment"/)?.[0] || "",
    /UPDATE entries SET title/
  );
});
