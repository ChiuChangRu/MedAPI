---
name: mywiki
description: Search, read, summarize, and safely manage the user's private MyWiki knowledge base through its MCP tools. Use for requests about Fieldlog records, attachments, ISO or other standards, wiki pages, Medtec exhibitors, related records, filing, moving, or adding knowledge to MyWiki.
---

# MyWiki

Use the MyWiki MCP as the source of truth. Prefer retrieval before mutation and keep every answer traceable to the records or attachments used.

## Retrieval workflow

1. Identify the target collection: Fieldlog, Wiki, or Medtec exhibitors.
2. Search before reading:
   - Fieldlog: start with `search_fieldlog`; use `list_fieldlog_folders`, `list_fieldlog_entries`, or `list_attachments` when the user asks what is present or the keywords are uncertain.
   - Wiki: use `search_wiki` or `list_wiki_pages`, then `read_wiki_page`.
   - Exhibitors: use `search_exhibitors`, `search_visit_notes`, or `search_exhibitor_files`, then the corresponding read/list tool.
3. Read the exact record or attachment. For long attachments, call `get_fieldlog_attachment` repeatedly with the returned next offset until the relevant content is complete.
4. Distinguish containers correctly:
   - A folder is a classification container.
   - A record is one complete data package.
   - Files, photos, recordings, transcripts, and extracted text attached to that record remain parts of the same package.
   - Multiple independent records in one folder remain independent even when their names share an ISO family.
5. Answer in Traditional Chinese unless the user asks otherwise. Include the folder path, record ID, attachment ID, and filename when available. State uncertainty when only a snippet was read.

## Write workflow

- Before creating a record, confirm the title and whether it should go to a known folder or `待分類`.
- Before uploading an attachment, resolve and state the exact destination record. External files that are not explicitly attached to an existing record belong in `待分類`.
- Before moving a record or folder, resolve the destination by ID and name. Moving a package must preserve all of its attachments and descendants.
- Never use merge behavior as a substitute for moving or nesting.
- Before adding a relation or synonym, show the resolved records or canonical term.

## Confirmation and safety

- Read-only search, listing, and retrieval do not require confirmation.
- Ask for explicit confirmation immediately before any action that creates, uploads, edits, moves, relates, classifies, trashes, restores, or permanently deletes data.
- For trash or permanent deletion, state the exact root item and that its full subtree or data package is affected. Deleting a folder behaves like Windows: all descendants move together.
- Do not expose authentication secrets, PINs, bearer tokens, or signed URLs in answers, files, logs, or source control.
- If a required tool is unavailable, say which capability is missing and do not invent results.
