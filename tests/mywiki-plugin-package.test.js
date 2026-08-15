import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const json = async (path) => JSON.parse(await readFile(path, "utf8"));

test("MyWiki plugin packages its skill and remote MCP without embedding credentials", async () => {
  const manifest = await json("plugins/mywiki/.codex-plugin/plugin.json");
  const mcp = await json("plugins/mywiki/.mcp.json");
  const skill = await readFile("plugins/mywiki/skills/mywiki/SKILL.md", "utf8");

  assert.equal(manifest.name, "mywiki");
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.equal(mcp.mcp_servers.mywiki.url, "https://medapi-mcp.gogoyankee.workers.dev/mcp");
  assert.equal(mcp.mcp_servers.mywiki.bearer_token_env_var, "MYWIKI_MCP_TOKEN");
  assert.equal(mcp.mcp_servers.mywiki.default_tools_approval_mode, "writes");
  assert.doesNotMatch(JSON.stringify(mcp), /[?&]pin=|authorization\s*:/i);
  assert.match(skill, /get_fieldlog_attachment/);
  assert.match(skill, /Ask for explicit confirmation/);
});

test("MedAPI marketplace exposes the MyWiki plugin", async () => {
  const marketplace = await json(".agents/plugins/marketplace.json");
  const entry = marketplace.plugins.find((plugin) => plugin.name === "mywiki");

  assert.ok(entry);
  assert.equal(entry.source.path, "./plugins/mywiki");
  assert.equal(entry.policy.authentication, "ON_INSTALL");
});
