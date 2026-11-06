# MinerU API snapshot (source: https://mineru.net/apiManage/docs, fetched 2026-11-06)

Base: `https://mineru.net`. All endpoints are HTTPS JSON. `Authorization: Bearer <token>` is
required for the standard API only. `code === 0` means success; `msg` carries the reason.

## A. 精准解析 API (standard, token required)

Limits: file ≤ 200 MB, ≤ 200 pages. Types: pdf, doc, docx, ppt, pptx, xls, xlsx, png, jpg,
jpeg, jp2, webp, gif, bmp, html. Async: submit → poll. 1000 high-priority pages/day/account.

### A1. Local-file batch upload (one file per request is fine)

```
POST /api/v4/file-urls/batch
Content-Type: application/json
Authorization: Bearer <token>

{
  "files": [{ "name": "paper.pdf", "data_id": "<docId>", "is_ocr": false, "page_ranges": "2,4-6" }],
  "model_version": "vlm",            // pipeline | vlm | MinerU-HTML (html requires MinerU-HTML)
  "language": "ch",
  "enable_formula": true,
  "enable_table": true,
  "extra_formats": ["docx", "html", "latex"]   // optional; md/json are always included
}
→ 200 { "code":0, "data": { "batch_id": "...", "file_urls": ["https://..."] }, "msg":"ok" }
```

Upload each file with `PUT <file_url>` and the raw bytes (no Content-Type header). The batch is
submitted automatically once the file is complete. URL valid 24 h. ≤ 50 files per request.

### A2. Poll batch

```
GET /api/v4/extract-results/batch/<batch_id>
Authorization: Bearer <token>
→ { "code":0, "data": {
      "batch_id": "...",
      "extract_result": [
        { "file_name":"paper.pdf", "state":"done",
          "full_zip_url":"https://cdn-mineru.openxlab.org.cn/pdf/<id>.zip",
          "data_id":"<docId>", "err_msg":"" },
        { "file_name":"x.pdf", "state":"running",
          "extract_progress": { "extracted_pages":1, "total_pages":2, "start_time":"..." } }
      ] } }
```

States: `waiting-file`, `pending`, `running`, `converting`, `done`, `failed`.
Match the row by `data_id`, fall back to `file_name`.

### A3. Result archive

Zip contains `full.md` (markdown), `*_content_list.json` (structured content list; also
`layout.json` = middle.json, `*_model.json`), and `images/*`. HTML sources produce `full.md` and
`main.html` instead.

`content_list.json` is an array of items like:

```json
{ "type":"text", "text":"...", "page_idx":0, "bbox":[x0,y0,x1,y1] }
{ "type":"title", "text":"...", "text_level":1, "page_idx":0 }
{ "type":"image", "img_path":"images/<hash>.jpg", "image_caption":["..."], "page_idx":1 }
{ "type":"table", "table_body":"<html>...</html>", "table_caption":["..."], "page_idx":2 }
{ "type":"equation", "text":"$$...$$", "page_idx":2 }
```

`page_idx` is zero-based.

### A4. Single URL task (alternative, no upload)

```
POST /api/v4/extract/task
{ "url": "https://...", "model_version": "vlm", "is_ocr": false, "enable_formula": true,
  "enable_table": true, "language": "ch", "page_ranges": "1-200", "data_id": "..." }
→ { "code":0, "data": { "task_id": "..." } }

GET /api/v4/extract/task/<task_id>
→ data: { task_id, data_id, state, full_zip_url, err_msg, extract_progress }
```

Not used by the plugin for parsing local files (we upload bytes), but useful when importing by
URL if we prefer remote parsing (we do not: the library keeps a local copy).

## B. Agent 轻量解析 API (no token, IP rate-limited)

Limits: file ≤ 10 MB, ≤ 20 pages. Types: pdf, png, jpg, jpeg, jp2, webp, gif, bmp, docx, pptx,
xlsx. Only Markdown output (CDN link). Single file.

### B1. Signed upload

```
POST /api/v1/agent/parse/file
Content-Type: application/json
{ "file_name":"paper.pdf", "language":"ch", "enable_table":true, "is_ocr":false,
  "enable_formula":true, "page_range":"1-10" }
→ { "code":0, "data": { "task_id":"...", "file_url":"https://oss...signed..." } }
```

Then `PUT <file_url>` with raw bytes. The backend detects completion and starts parsing.

### B2. Poll

```
GET /api/v1/agent/parse/<task_id>
→ { "code":0, "data": {
      "task_id":"...", "state":"done|waiting-file|uploading|pending|running|failed",
      "markdown_url":"https://cdn.../full.md",
      "err_msg":"", "err_code":-30003 } }
```

Download `markdown_url` with plain GET → markdown text. HTTP 429 = rate-limited.

## C. Common error codes

Standard API: `A0202` bad token, `A0211` expired token, `-500` bad params, `-10001` service error,
`-10002` param error, `-60001` upload-url failed, `-60002` type mismatch, `-60003` read failed,
`-60004` empty file, `-60005` file too large, `-60006` too many pages, `-60007` model unavailable,
`-60008` read timeout, `-60009` queue full, `-60010` parse failed, `-60011` no valid file,
`-60012` task not found, `-60013` not your task, `-60018` daily quota, `-60019` html quota,
`-60022` web fetch failed.

Agent API: `-30001` too large, `-30002` unsupported type, `-30003` too many pages,
`-30004` bad params. HTTP 429 rate-limited.

## D. `language` values (subset used by the UI)

`ch` (zh+en, default), `en`, `japan`, `korean`, `chinese_cht`, `latin`, `arabic`, `cyrillic`,
`east_slavic`, `devanagari`, `ta`, `te`, `ka`, `el`, `th`.
