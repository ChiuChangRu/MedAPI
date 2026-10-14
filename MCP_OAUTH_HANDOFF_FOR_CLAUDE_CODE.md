# MyWiki / Fieldlog MCP handoff for Claude Code

> **Status: STOP CHANGING PRODUCTION until the failure is reproduced and verified.**
>
> This file is an operational handoff written after multiple OAuth changes failed to make Claude connect. Treat current production data and the v200 web application as protected.

## Repository and production endpoints

- Repository: `ChiuChangRu/MedAPI`
- Branch: `main`
- Handoff baseline commit: `b30c29a2e51dfbf9d317fc01c9e45bf56af6cc63`
- Fieldlog web application: **v200** (must remain unchanged)
- MCP endpoint: `https://medapi-mcp.gogoyankee.workers.dev/mcp`
- MCP Worker: `medapi-mcp`
- Fieldlog Worker/database service: `fieldlog` / `DB_FIELDLOG`
- Deployment platform: Cloudflare Workers, via GitHub Actions

## System overview

This repository has at least two independent production surfaces:

1. **Fieldlog / MyWiki web app** in `fieldlog/`
   - Stores entries, folders, attachments, recordings, transcripts, and AI notes.
   - Uses a D1 binding named `DB_FIELDLOG`.
   - Its protected API uses the `FIELD_PIN` secret.
   - The requested web baseline is v200. Do not change its source, UI, database schema, data, or deployment configuration during OAuth work.

2. **MCP Worker** in `mcp/`
   - Streamable HTTP endpoint: `POST /mcp`.
   - OAuth routes and authorization logic: `mcp/src/oauth.js`.
   - MCP routing/tools: `mcp/src/worker.js`.
   - It reads/writes Fieldlog through the configured service/binding and uses a separate `FIELD_PIN` to authenticate calls to Fieldlog.
   - It has its own `MCP_PIN` for its OAuth consent page and legacy PIN compatibility.

## Secrets: do not expose, rotate, delete, or copy into Git

| Worker | Secret | Role | Required relationship |
|---|---|---|---|
| `fieldlog` | `FIELD_PIN` | protects Fieldlog API and signed URLs | User changed this value during this incident. |
| `medapi-mcp` | `FIELD_PIN` | MCP-to-Fieldlog internal/API calls | **Must equal the current `fieldlog` value.** |
| `medapi-mcp` | `MCP_PIN` | OAuth consent PIN; HMAC signing key for dynamic client IDs, codes and tokens | Must remain unchanged unless intentionally revoking every OAuth client/token. |

Never request a secret in chat, log it, commit it, or add it as a URL/query parameter.

## Current user-visible OAuth failure

Claude Desktop/custom connector was configured against the MCP endpoint.

Observed sequence:

1. Claude's default OAuth option **Use Claude's published identity** (CIMD) returned:
   ```json
   {"error":"invalid_client","error_description":"unknown or expired client_id"}
   ```
2. The user switched to **Register automatically** (dynamic client registration, DCR).
3. The actual authorization page appeared and showed **Claude requests access to your private MyWiki**. The `client_id` in the browser URL begins with `eyJ...`, consistent with a server-issued signed DCR client ID.
4. Entering MCP PIN and selecting Allow did not complete. Repeating the submission returned:
   ```json
   {"error":"invalid_request","error_description":"CSRF validation failed"}
   ```
5. A targeted DCR CSRF patch was deployed from this branch, but the user reports the visible behavior/error remained unchanged. Do **not** assume deployment success proves the browser flow works.

This means the problem has moved past CIMD/client registration and is currently in the consent form POST / browser callback phase.

## OAuth history and current code state

Relevant commits:

| Commit | Date / purpose | Notes |
|---|---|---|
| `0e92cd0893` | 2026-08-15 OAuth cookie fix era | DCR-only client handling: only accepts server-signed client IDs. |
| `f407280bbae55de23d684e77d1e7b3e4990805df` | 2026-08-21 ChatGPT OAuth hardening | Added ChatGPT-only CIMD allow-list and CSRF fallback. The ChatGPT-only allow-list rejects Claude CIMD. |
| `81367c286817dfc9ae0754d6569e3ac64d5847ed` | restore v200 tree/config | Web app back to v200. |
| `6b111ae07fb9cf9e3e7420ba576002e9394cd419` | OAuth reverted to 8/15 | Restored `mcp/src/oauth.js` from `0e92cd0893`. |
| `b30c29a2e51dfbf9d317fc01c9e45bf56af6cc63` | current baseline | Keeps DCR-only behavior and adds a narrow CSRF signed-nonce + same-origin fallback; no Claude/ChatGPT CIMD support was reintroduced. |

The current `mcp/src/oauth.js` intentionally does **not** contain `CHATGPT_CIMD_PATTERN`. Claude must use **Register automatically**, not published identity, until a separately designed and tested Claude CIMD implementation exists.

## Current targeted CSRF implementation

At the current baseline:

- The authorize GET creates a random `csrf` value.
- The signed short-lived `request_token` includes `csrf_hash: sha256(csrf)`.
- Consent POST checks the signed nonce plus either:
  - matching CSRF cookie, or
  - a same-origin `Origin` header.

The failure suggests one or more of these assumptions is false in the real Claude/browser flow. Possibilities that must be measured, not guessed:

- Claude/browser omits the `Origin` header on this navigation POST.
- A cached/stale authorization page or connector state is being submitted.
- The deployed Worker differs from the code assumed by the UI test.
- Browser callback/redirect behavior is misclassified as the form POST failure.
- The failure report comes from an earlier attempt; timestamps/correlation are absent.

## Mandatory diagnostic approach

Before any production code change:

1. Check out this exact baseline and inspect `mcp/src/oauth.js`, `mcp/src/worker.js`, and `mcp/wrangler.jsonc`.
2. Reproduce with Claude using a **newly created** connector:
   - MCP URL exactly `https://medapi-mcp.gogoyankee.workers.dev/mcp`
   - OAuth client: **Register automatically**
   - Request headers: none
   - Do not use Published Identity/CIMD.
3. Add only privacy-safe, temporary observability if needed:
   - request method, route, boolean presence of `Origin`, `Sec-Fetch-Site`, and cookie (never their values)
   - a random attempt/correlation ID generated server-side
   - response status and coarse failure branch
   - no PIN, tokens, authorization codes, client IDs, cookie values, query strings, or request bodies.
4. Verify the real browser response before claiming a fix.
5. Remove temporary debug logging after confirmation.

A secure compatible CSRF rule must require a server-signed nonce and a browser-origin signal. Do not simply disable CSRF or accept arbitrary POSTs.

## Deployment constraints

- `.github/workflows/deploy-mcp.yml` in v200 listens to `codex/kiwi-integration`, not `main`, plus `workflow_dispatch`.
- During this incident, temporary commits added `main` only to trigger deploys and then restored the v200 workflow configuration. Do not leave `main` auto-deploy enabled accidentally.
- Preferred future deployment: use `workflow_dispatch` or a reviewed branch/PR. Confirm the exact commit deployed from the Actions run before browser testing.
- The latest known successful MCP deployment action for the CSRF patch was run `35612335606`; it proves Cloudflare deployment completed, **not** that OAuth succeeded in Claude.

## Guardrails

Do not:

- modify `fieldlog/` source, data, schema, migrations, recordings, transcripts, attachments, or AI notes;
- rotate or replace `MCP_PIN`;
- change `FIELD_PIN` again unless explicitly instructed; if changed, synchronize it in both Workers;
- force-push, reset history, delete branches, or remove the preserved feature branch `feat-mywiki-mcp-ai-notes-v201`;
- merge the v201 AI-note work into v200;
- broaden accepted CIMD URLs or fetch arbitrary client metadata URLs (SSRF risk);
- claim success until Claude completes authorization and successfully runs a harmless read-only MCP tool.

## Acceptance criteria

The task is done only when all are true:

1. Claude uses DCR and reaches the consent page.
2. A correct MCP PIN completes exactly one consent submission without `invalid_client` or `CSRF validation failed`.
3. Claude returns to the connector and lists MCP tools.
4. A harmless read-only Fieldlog/MCP query succeeds.
5. The Fieldlog website remains v200 and existing content remains intact.
6. `medapi-mcp.FIELD_PIN` and `fieldlog.FIELD_PIN` are verified equal without exposing their values.

## Separate future work

The v201 AI-note feature is intentionally preserved on remote branch:

`feat-mywiki-mcp-ai-notes-v201`

It is out of scope for this OAuth repair. Do not touch it while diagnosing the connector.
