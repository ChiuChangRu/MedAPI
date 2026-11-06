import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { aiText, NO_THINKING, judgeRelation, RELATION_MODEL } from "../fieldlog/src/imageSkill.js";
import { aiText as aiTextCf, RELATION_MODEL as RELATION_MODEL_CF } from "../cloudflare/src/imageSkill.js";
import { AUTOFILING_DECISION_MODEL } from "../fieldlog/src/lib/autofile.js";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
const DEPRECATED = [
  "@cf/meta/llama-3.2-3b-instruct", "@cf/meta/llama-3.2-1b-instruct", "@cf/meta/llama-3.1-8b-instruct-fp8",
  "@cf/qwen/qwen3-30b-a3b-fp8", "@cf/qwen/qwq-32b", "@cf/openai/whisper-tiny-en", "@cf/google/embeddinggemma-300m",
  "@cf/llava-hf/llava-1.5-7b-hf", "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
];

test("Workers AI 2026-11 下架清單：專案原始碼不再引用已預定下架的模型", async () => {
  const files = [
    "../fieldlog/src/worker.js", "../fieldlog/src/imageSkill.js", "../fieldlog/src/lib/autofile.js",
    "../fieldlog/src/lib/ai-naming.js", "../fieldlog/src/lib/transcribe.js",
    "../cloudflare/src/worker.js", "../cloudflare/src/imageSkill.js", "../mcp/src/worker.js",
  ];
  for (const f of files) {
    const text = await read(f);
    for (const id of DEPRECATED) assert.ok(!text.includes(id), `${f} 仍引用即將下架的 ${id}`);
  }
  assert.equal(AUTOFILING_DECISION_MODEL, "@cf/google/gemma-4-26b-a4b-it");
  assert.equal(RELATION_MODEL, "@cf/google/gemma-4-26b-a4b-it");
  assert.equal(RELATION_MODEL_CF, "@cf/google/gemma-4-26b-a4b-it");
  assert.match(await read("../cloudflare/src/worker.js"), /HELP_SUGGEST_MODEL = "@cf\/google\/gemma-4-26b-a4b-it"/);
});

test("aiText：同時支援舊格式 response 與 OpenAI 格式 choices，並去掉 <think>", () => {
  for (const fn of [aiText, aiTextCf]) {
    assert.equal(fn({ response: " 舊格式 " }), "舊格式");
    assert.equal(fn({ result: { response: "巢狀" } }), "巢狀");
    assert.equal(fn({ choices: [{ message: { content: "新格式" } }] }), "新格式");
    assert.equal(fn({ choices: [{ message: { content: [{ type: "text", text: "分" }, { text: "段" }] } }] }), "分段");
    assert.equal(fn({ choices: [{ message: { content: "<think>想一想\n再想</think>答案" } }] }), "答案");
    assert.equal(fn({ response: null }), "");
    assert.equal(fn(undefined), "");
    // JSON mode 可能直接回物件：不當文字處理，避免 [object Object]
    assert.equal(fn({ response: { a: 1 } }), "");
  }
});

test("judgeRelation 對兩種回傳格式都能取到文字，並帶關閉思考的參數", async () => {
  let seen;
  const make = (reply) => ({ run: async (model, input) => { seen = { model, input }; return reply; } });
  assert.equal(await judgeRelation(make({ response: "跟鞘管有關" }), "逐字稿", "OCR"), "跟鞘管有關");
  assert.equal(seen.model, RELATION_MODEL);
  assert.deepEqual(seen.input.chat_template_kwargs, NO_THINKING.chat_template_kwargs);
  assert.equal(await judgeRelation(make({ choices: [{ message: { content: "跟導管有關" } }] }), "逐字稿", "OCR"), "跟導管有關");
});
