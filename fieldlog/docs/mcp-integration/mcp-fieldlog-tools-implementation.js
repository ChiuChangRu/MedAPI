/**
 * Mywiki MCP Server - fieldlog 工具實現 (Node.js/TypeScript)
 * 用於 Mywiki MCP Server 端整合 fieldlog 附件 API
 *
 * 工具列表：
 * 1. get_fieldlog_attachment_raw - 取得附件原始檔案（圖片/PDF）
 * 2. process_fieldlog_batch - 批量自動轉文字（OCR + Whisper）
 */

// ============================================================================
// 環境配置
// ============================================================================

const FIELDLOG_API = process.env.FIELDLOG_API || "https://fieldlog.example.workers.dev";
const FIELD_PIN = process.env.FIELD_PIN;

if (!FIELD_PIN) {
  throw new Error("FIELD_PIN environment variable not set");
}

// 使用 node-fetch 或內建 fetch (Node 18+)
const fetch = globalThis.fetch || require("node-fetch");

// ============================================================================
// 工具 1：get_fieldlog_attachment_raw
// ============================================================================

/**
 * 取得 fieldlog 附件的原始檔案。
 *
 * @param {number} id - attachment ID
 * @param {string} mode - "inline" (base64) 或 "url" (簽名網址)，預設 "url"
 * @returns {Promise<{type: string, source?: object, text?: string, metadata: object}>}
 * @throws {Error} API 回應錯誤或參數無效
 */
async function getFieldlogAttachmentRaw(id, mode = "url") {
  if (!["inline", "url"].includes(mode)) {
    throw new Error(`Invalid mode: ${mode}. Must be 'inline' or 'url'`);
  }

  const url = `${FIELDLOG_API}/api/attachments/${id}/raw?mode=${mode}`;
  const headers = { "x-pin": FIELD_PIN };

  try {
    const response = await fetch(url, { headers, timeout: 10000 });
    if (!response.ok) {
      throw new Error(`fieldlog API error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();

    // ====== mode=inline: 直接回傳 base64 ======
    if (mode === "inline" && data.encoding === "base64") {
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: data.mime_type || "image/jpeg",
          data: data.data || ""
        },
        metadata: {
          id: data.id,
          filename: data.filename
        }
      };
    }

    // ====== mode=url: 回傳簽名網址 + 下載連結 ======
    const urlValue = data.url || "";
    const expiresAt = data.expires_at || "";
    const sizeBytes = data.size_bytes || 0;

    // 格式化大小
    let sizeStr;
    if (sizeBytes > 1024 * 1024) {
      sizeStr = `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
    } else if (sizeBytes > 1024) {
      sizeStr = `${(sizeBytes / 1024).toFixed(1)} KB`;
    } else {
      sizeStr = `${sizeBytes} B`;
    }

    const textContent = `## ${data.filename || "File"}

📎 **[下載檔案](${urlValue})** (${sizeStr})
⏰ **有效期**：${expiresAt}

簽名網址有效期 10 分鐘，超期後無法存取。`;

    return {
      type: "text",
      text: textContent,
      metadata: {
        id: data.id,
        filename: data.filename,
        url: urlValue,
        expires_at: expiresAt,
        size_bytes: sizeBytes,
        mime_type: data.mime_type
      }
    };
  } catch (error) {
    throw new Error(`Failed to get attachment: ${error.message}`);
  }
}

// ============================================================================
// 工具 2：process_fieldlog_batch
// ============================================================================

/**
 * 自動為資料夾或紀錄內未處理附件觸發 OCR 和語音轉文字。
 *
 * @param {number} folderId - 資料夾 ID（與 entryId 二選一）
 * @param {number} entryId - 紀錄 ID
 * @returns {Promise<{type: string, text: string, metadata: object}>}
 * @throws {Error} 參數錯誤或 API 錯誤
 */
async function processFieldlogBatch(folderId = null, entryId = null) {
  if (!folderId && !entryId) {
    throw new Error("Must provide either folderId or entryId");
  }

  if (folderId && entryId) {
    throw new Error("Cannot provide both folderId and entryId");
  }

  const url = `${FIELDLOG_API}/api/batch/process-attachments`;
  const headers = {
    "x-pin": FIELD_PIN,
    "content-type": "application/json"
  };
  const body = {};
  let context;

  if (folderId) {
    body.folder_id = folderId;
    context = `資料夾 #${folderId}`;
  } else {
    body.entry_id = entryId;
    context = `紀錄 #${entryId}`;
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      timeout: 30000
    });

    if (!response.ok) {
      throw new Error(`fieldlog batch API error: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();

    // ====== 整理結果 ======
    const processedCount = result.processed || 0;
    const results = result.results || [];

    // 統計成功/失敗
    const successCount = results.filter(r => r.success).length;
    const failCount = processedCount - successCount;

    // 構建摘要文字
    const lines = [
      `✅ **已處理 ${processedCount} 個附件** (${context})`,
      ""
    ];

    for (const r of results) {
      const kindEmoji = r.kind === "audio" ? "🎙️" : "📷";
      const statusIcon = r.success ? "✓" : "✗";
      const filename = r.filename || "unknown";
      const message = r.message || "";

      lines.push(`- ${kindEmoji} ${filename}: ${statusIcon} ${message}`);
    }

    if (failCount > 0) {
      lines.push("");
      lines.push(`⚠️ **${failCount} 個附件處理失敗**（見上方詳情）`);
    }

    lines.push("");
    lines.push("💡 **提示**：若附件過多（>20 個），建議分批處理以避免超時。");

    const textContent = lines.join("\n");

    return {
      type: "text",
      text: textContent,
      metadata: {
        processed_count: processedCount,
        success_count: successCount,
        fail_count: failCount,
        details: results
      }
    };
  } catch (error) {
    throw new Error(`Failed to process batch: ${error.message}`);
  }
}

// ============================================================================
// MCP 工具定義（JSON 格式，用於 MCP server 註冊）
// ============================================================================

const TOOLS_DEFINITIONS = [
  {
    name: "get_fieldlog_attachment_raw",
    description: "取得 fieldlog 附件的原始檔案（圖片或 PDF）。圖片小檔直接回傳 base64，大檔案回傳簽名 URL。",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "number",
          description: "attachment ID"
        },
        mode: {
          type: "string",
          enum: ["inline", "url"],
          description: "回傳模式：inline (base64) 或 url (簽名網址)。預設 url"
        }
      },
      required: ["id"]
    }
  },
  {
    name: "process_fieldlog_batch",
    description: "自動為 fieldlog 資料夾或紀錄內未處理的附件觸發 OCR（照片）和語音轉文字（錄音）。" +
                "注意：Worker 30 秒超時限制，建議一次最多 10-20 個附件。",
    inputSchema: {
      type: "object",
      properties: {
        folder_id: {
          type: "number",
          description: "資料夾 ID"
        },
        entry_id: {
          type: "number",
          description: "紀錄 ID"
        }
      }
    }
  }
];

// ============================================================================
// MCP 路由處理（以 MCP SDK 為例）
// ============================================================================

/**
 * 如果使用 @modelcontextprotocol/sdk，可以這樣集成：
 *
 * import { Server } from "@modelcontextprotocol/sdk/server/index.js";
 * import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
 * import { CallToolRequestSchema, TextContent, ImageContent } from "@modelcontextprotocol/sdk/types.js";
 *
 * const server = new Server({
 *   name: "fieldlog-tools",
 *   version: "1.0.0"
 * });
 *
 * // 列出工具定義
 * server.setRequestHandler(ListToolsRequestSchema, async () => ({
 *   tools: TOOLS_DEFINITIONS
 * }));
 *
 * // 調用工具
 * server.setRequestHandler(CallToolRequestSchema, async (request) => {
 *   const { name, arguments: args } = request;
 *
 *   try {
 *     if (name === "get_fieldlog_attachment_raw") {
 *       const result = await getFieldlogAttachmentRaw(args.id, args.mode || "url");
 *
 *       if (result.type === "image") {
 *         return {
 *           content: [
 *             {
 *               type: "image",
 *               data: result.source.data,
 *               mimeType: result.source.media_type
 *             }
 *           ]
 *         };
 *       } else {
 *         return {
 *           content: [
 *             {
 *               type: "text",
 *               text: result.text
 *             }
 *           ]
 *         };
 *       }
 *     }
 *
 *     if (name === "process_fieldlog_batch") {
 *       const result = await processFieldlogBatch(args.folder_id, args.entry_id);
 *       return {
 *         content: [
 *           {
 *             type: "text",
 *             text: result.text
 *           }
 *         ]
 *       };
 *     }
 *
 *     return {
 *       content: [
 *         {
 *           type: "text",
 *           text: `Unknown tool: ${name}`
 *         }
 *       ],
 *       isError: true
 *     };
 *   } catch (error) {
 *     return {
 *       content: [
 *         {
 *           type: "text",
 *           text: `Error: ${error.message}`
 *         }
 *       ],
 *       isError: true
 *     };
 *   }
 * });
 *
 * // 啟動 server
 * const transport = new StdioServerTransport();
 * await server.connect(transport);
 */

// ============================================================================
// 導出函數與定義
// ============================================================================

module.exports = {
  getFieldlogAttachmentRaw,
  processFieldlogBatch,
  TOOLS_DEFINITIONS,
  FIELDLOG_API,
  FIELD_PIN
};

// ============================================================================
// CLI 測試（直接執行此檔案）
// ============================================================================

if (require.main === module) {
  const args = process.argv.slice(2);

  (async () => {
    console.log("=".repeat(70));
    console.log("fieldlog MCP 工具測試");
    console.log("=".repeat(70));
    console.log();

    try {
      // 測試 1：取圖片 (inline 模式)
      if (args[0] === "test-inline") {
        console.log("測試 1：取圖片 (inline 模式)");
        console.log("-".repeat(70));
        const attId = parseInt(args[1]) || 266;
        const result = await getFieldlogAttachmentRaw(attId, "inline");
        console.log("✓ 成功");
        console.log(`  type: ${result.type}`);
        console.log(`  filename: ${result.metadata.filename}`);
        console.log(`  size: ${Math.round(result.source.data.length / 1024)} KB (base64)`);
      }

      // 測試 2：取檔案 (url 模式)
      else if (args[0] === "test-url") {
        console.log("測試 2：取檔案 (url 模式)");
        console.log("-".repeat(70));
        const attId = parseInt(args[1]) || 267;
        const result = await getFieldlogAttachmentRaw(attId, "url");
        console.log("✓ 成功");
        console.log(`  type: ${result.type}`);
        console.log(`  filename: ${result.metadata.filename}`);
        console.log(`  url: ${result.metadata.url.substring(0, 50)}...`);
        console.log(`  expires_at: ${result.metadata.expires_at}`);
      }

      // 測試 3：批量轉文字
      else if (args[0] === "test-batch") {
        console.log("測試 3：批量轉文字");
        console.log("-".repeat(70));
        const folderId = parseInt(args[1]) || 42;
        const result = await processFieldlogBatch(folderId);
        console.log("✓ 成功");
        console.log(result.text);
      }

      // 預設：列出工具定義
      else {
        console.log("可用工具定義（JSON）：");
        console.log("-".repeat(70));
        console.log(JSON.stringify(TOOLS_DEFINITIONS, null, 2));
        console.log();
        console.log("使用方法：");
        console.log("  node mcp-fieldlog-tools-implementation.js test-inline [attachment_id]");
        console.log("  node mcp-fieldlog-tools-implementation.js test-url [attachment_id]");
        console.log("  node mcp-fieldlog-tools-implementation.js test-batch [folder_id]");
      }
    } catch (error) {
      console.error(`✗ 失敗：${error.message}`);
      process.exit(1);
    }
  })();
}
