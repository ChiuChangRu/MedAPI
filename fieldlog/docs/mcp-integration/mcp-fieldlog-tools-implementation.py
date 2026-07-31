"""
Mywiki MCP Server - fieldlog 工具實現
用於 Mywiki MCP Server 端整合 fieldlog 附件 API

工具列表：
1. get_fieldlog_attachment_raw - 取得附件原始檔案（圖片/PDF）
2. process_fieldlog_batch - 批量自動轉文字（OCR + Whisper）
"""

import os
import json
import base64
import httpx
from datetime import datetime
from typing import Optional, Union

# ============================================================================
# 環境配置
# ============================================================================

FIELDLOG_API = os.getenv("FIELDLOG_API", "https://fieldlog.example.workers.dev")
FIELD_PIN = os.getenv("FIELD_PIN")  # 從環境變數或密鑰管理取得

if not FIELD_PIN:
    raise RuntimeError("FIELD_PIN environment variable not set")

# ============================================================================
# 工具 1：get_fieldlog_attachment_raw
# ============================================================================

def get_fieldlog_attachment_raw(id: int, mode: str = "url") -> dict:
    """
    取得 fieldlog 附件的原始檔案。

    Args:
        id: attachment ID
        mode: "inline" (base64) 或 "url" (簽名網址)，預設 "url"

    Returns:
        Dict with 'type' (image/text) 和對應的 Claude content block

    Raises:
        HTTPError: API 回應錯誤
        ValueError: 參數無效
    """

    if mode not in ("inline", "url"):
        raise ValueError(f"Invalid mode: {mode}. Must be 'inline' or 'url'")

    url = f"{FIELDLOG_API}/api/attachments/{id}/raw?mode={mode}"
    headers = {"x-pin": FIELD_PIN}

    try:
        response = httpx.get(url, headers=headers, timeout=10)
        response.raise_for_status()
        data = response.json()
    except httpx.HTTPError as e:
        raise RuntimeError(f"fieldlog API error: {e.response.status_code} - {e}")

    # ====== mode=inline: 直接回傳 base64 ======
    if mode == "inline" and data.get("encoding") == "base64":
        return {
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": data.get("mime_type", "image/jpeg"),
                "data": data.get("data", "")
            },
            "metadata": {
                "id": data.get("id"),
                "filename": data.get("filename")
            }
        }

    # ====== mode=url: 回傳簽名網址 + 下載連結 ======
    url_value = data.get("url", "")
    expires_at = data.get("expires_at", "")
    size_bytes = data.get("size_bytes", 0)

    # 格式化大小
    if size_bytes > 1024 * 1024:
        size_str = f"{size_bytes / (1024 * 1024):.1f} MB"
    elif size_bytes > 1024:
        size_str = f"{size_bytes / 1024:.1f} KB"
    else:
        size_str = f"{size_bytes} B"

    text_content = f"""## {data.get('filename', 'File')}

📎 **[下載檔案]({url_value})** ({size_str})
⏰ **有效期**：{expires_at}

簽名網址有效期 10 分鐘，超期後無法存取。"""

    return {
        "type": "text",
        "text": text_content,
        "metadata": {
            "id": data.get("id"),
            "filename": data.get("filename"),
            "url": url_value,
            "expires_at": expires_at,
            "size_bytes": size_bytes,
            "mime_type": data.get("mime_type")
        }
    }


# ============================================================================
# 工具 2：process_fieldlog_batch
# ============================================================================

def process_fieldlog_batch(
    folder_id: Optional[int] = None,
    entry_id: Optional[int] = None
) -> dict:
    """
    自動為資料夾或紀錄內未處理附件觸發 OCR 和語音轉文字。

    Args:
        folder_id: 資料夾 ID（與 entry_id 二選一）
        entry_id: 紀錄 ID

    Returns:
        Dict with 'type': 'text', 含處理結果摘要

    Raises:
        ValueError: 參數錯誤
        RuntimeError: API 錯誤
    """

    if not folder_id and not entry_id:
        raise ValueError("Must provide either folder_id or entry_id")

    if folder_id and entry_id:
        raise ValueError("Cannot provide both folder_id and entry_id")

    url = f"{FIELDLOG_API}/api/batch/process-attachments"
    headers = {
        "x-pin": FIELD_PIN,
        "content-type": "application/json"
    }
    body = {}

    if folder_id:
        body["folder_id"] = folder_id
        context = f"資料夾 #{folder_id}"
    else:
        body["entry_id"] = entry_id
        context = f"紀錄 #{entry_id}"

    try:
        response = httpx.post(url, headers=headers, json=body, timeout=30)
        response.raise_for_status()
        result = response.json()
    except httpx.HTTPError as e:
        raise RuntimeError(f"fieldlog batch API error: {e.response.status_code} - {e}")

    # ====== 整理結果 ======
    processed_count = result.get("processed", 0)
    results = result.get("results", [])

    # 統計成功/失敗
    success_count = sum(1 for r in results if r.get("success"))
    fail_count = processed_count - success_count

    # 構建摘要文字
    lines = [
        f"✅ **已處理 {processed_count} 個附件** ({context})",
        ""
    ]

    for r in results:
        kind_emoji = "🎙️" if r.get("kind") == "audio" else "📷"
        status_icon = "✓" if r.get("success") else "✗"
        filename = r.get("filename", "unknown")
        message = r.get("message", "")

        lines.append(f"- {kind_emoji} {filename}: {status_icon} {message}")

    if fail_count > 0:
        lines.append("")
        lines.append(f"⚠️ **{fail_count} 個附件處理失敗**（見上方詳情）")

    lines.append("")
    lines.append("💡 **提示**：若附件過多（>20 個），建議分批處理以避免超時。")

    text_content = "\n".join(lines)

    return {
        "type": "text",
        "text": text_content,
        "metadata": {
            "processed_count": processed_count,
            "success_count": success_count,
            "fail_count": fail_count,
            "details": results
        }
    }


# ============================================================================
# MCP 工具定義（JSON 格式，用於 MCP server 註冊）
# ============================================================================

TOOLS_DEFINITIONS = [
    {
        "name": "get_fieldlog_attachment_raw",
        "description": "取得 fieldlog 附件的原始檔案（圖片或 PDF）。圖片小檔直接回傳 base64，大檔案回傳簽名 URL。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {
                    "type": "number",
                    "description": "attachment ID"
                },
                "mode": {
                    "type": "string",
                    "enum": ["inline", "url"],
                    "description": "回傳模式：inline (base64) 或 url (簽名網址)。預設 url"
                }
            },
            "required": ["id"]
        }
    },
    {
        "name": "process_fieldlog_batch",
        "description": "自動為 fieldlog 資料夾或紀錄內未處理的附件觸發 OCR（照片）和語音轉文字（錄音）。" +
                      "注意：Worker 30 秒超時限制，建議一次最多 10-20 個附件。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "folder_id": {
                    "type": "number",
                    "description": "資料夾 ID"
                },
                "entry_id": {
                    "type": "number",
                    "description": "紀錄 ID"
                }
            }
        }
    }
]


# ============================================================================
# MCP 路由處理（以 FastAPI 為例）
# ============================================================================

"""
如果使用 FastAPI + MCP SDK，可以這樣集成：

from mcp.server import Server
from mcp.types import Tool, TextContent, ImageContent

app = Server("fieldlog-tools")

@app.call_tool
async def call_tool(name: str, arguments: dict):
    if name == "get_fieldlog_attachment_raw":
        result = get_fieldlog_attachment_raw(
            id=arguments.get("id"),
            mode=arguments.get("mode", "url")
        )
        if result["type"] == "image":
            return ImageContent(
                source=result["source"],
                metadata=result["metadata"]
            )
        else:
            return TextContent(
                text=result["text"],
                metadata=result["metadata"]
            )

    elif name == "process_fieldlog_batch":
        result = process_fieldlog_batch(
            folder_id=arguments.get("folder_id"),
            entry_id=arguments.get("entry_id")
        )
        return TextContent(
            text=result["text"],
            metadata=result["metadata"]
        )

    else:
        raise ValueError(f"Unknown tool: {name}")


# 在 app 啟動時註冊工具定義
for tool_def in TOOLS_DEFINITIONS:
    app.register_tool(Tool(**tool_def))
"""


# ============================================================================
# 測試與驗證
# ============================================================================

if __name__ == "__main__":
    import sys

    print("=" * 70)
    print("fieldlog MCP 工具測試")
    print("=" * 70)
    print()

    # 測試 1：取圖片 (inline 模式)
    if len(sys.argv) > 1 and sys.argv[1] == "test-inline":
        try:
            print("測試 1：取圖片 (inline 模式)")
            print("-" * 70)
            att_id = int(sys.argv[2]) if len(sys.argv) > 2 else 266
            result = get_fieldlog_attachment_raw(id=att_id, mode="inline")
            print(f"✓ 成功")
            print(f"  type: {result['type']}")
            print(f"  filename: {result['metadata'].get('filename')}")
            print(f"  size: {len(result['source'].get('data', '')) // 1024} KB (base64)")
        except Exception as e:
            print(f"✗ 失敗：{e}")

    # 測試 2：取檔案 (url 模式)
    elif len(sys.argv) > 1 and sys.argv[1] == "test-url":
        try:
            print("測試 2：取檔案 (url 模式)")
            print("-" * 70)
            att_id = int(sys.argv[2]) if len(sys.argv) > 2 else 267
            result = get_fieldlog_attachment_raw(id=att_id, mode="url")
            print(f"✓ 成功")
            print(f"  type: {result['type']}")
            print(f"  filename: {result['metadata'].get('filename')}")
            print(f"  url: {result['metadata'].get('url')[:50]}...")
            print(f"  expires_at: {result['metadata'].get('expires_at')}")
        except Exception as e:
            print(f"✗ 失敗：{e}")

    # 測試 3：批量轉文字
    elif len(sys.argv) > 1 and sys.argv[1] == "test-batch":
        try:
            print("測試 3：批量轉文字")
            print("-" * 70)
            folder_id = int(sys.argv[2]) if len(sys.argv) > 2 else 42
            result = process_fieldlog_batch(folder_id=folder_id)
            print(f"✓ 成功")
            print(result["text"])
        except Exception as e:
            print(f"✗ 失敗：{e}")

    # 預設：列出工具定義
    else:
        print("可用工具定義（JSON）：")
        print("-" * 70)
        print(json.dumps(TOOLS_DEFINITIONS, indent=2, ensure_ascii=False))
        print()
        print("使用方法：")
        print("  python mcp-fieldlog-tools-implementation.py test-inline [attachment_id]")
        print("  python mcp-fieldlog-tools-implementation.py test-url [attachment_id]")
        print("  python mcp-fieldlog-tools-implementation.py test-batch [folder_id]")
