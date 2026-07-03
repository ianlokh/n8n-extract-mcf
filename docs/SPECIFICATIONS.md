# Project Specification: MCF Job Data Extraction

Automated extraction of job postings from Singapore's [MyCareersFuture](https://www.mycareersfuture.gov.sg) (MCF) platform into Google Sheets. Reads MCF job-alert emails from Gmail, resolves the job UUIDs they link to, fetches full job details from the public MCF API, flattens and deduplicates the results, and appends them to a Google Sheet. Runs daily on a schedule and is idempotent — safe to re-run without creating duplicate sheets or reprocessing the same emails.

Built and deployed as an n8n workflow on n8n Cloud. This document is the complete specification: a coding agent or engineer should be able to rebuild this project from this file alone (plus the referenced source files, which are also described in full below).

## 1. Prerequisites

- An [n8n Cloud](https://n8n.io/cloud/) instance (or self-hosted n8n) with the **official n8n MCP server** enabled (instance Settings → MCP Server) for AI-assisted building — see §9.
- A Gmail account subscribed to MCF job alerts (sender `job-alerts@mycareersfuture.gov.sg`), with:
  - **Gmail OAuth2** credential configured in n8n.
  - A Gmail label created (any name, e.g. "MCF Processed") for idempotency bookkeeping — note its label ID.
- A Google account for Sheets access, with **Google Sheets OAuth2** credential configured in n8n.
- No credential/auth needed for the MCF API itself — it's public.

## 2. Architecture Overview

```
┌─ Manual Trigger ──────┐
│                       ├─→ Search files and folders (Google Drive: find "MCF Job Data")
└─ Schedule Trigger ────┘         → If Data Sheet Exists?
                                       ├─ true  → Get MCF Alert Emails
                                       └─ false → Create MCF Job Data Sheet → Get MCF Alert Emails

Get MCF Alert Emails (unlabeled MCF emails only)
  ├─→ Extract Job UUIDs → Batch UUIDs & Build URLs → Loop Over Batches
  │       [loop]  → Fetch MCF Job Data → back to Loop Over Batches
  │       [done]  → Transform Job Data → Deduplicate Jobs → Append to Google Sheets ──┐
  │                                                                                   ├→ Merge (passthrough: Edit Fields data) → Add label to message
  └─→ Edit Fields (extracts email .id) ───────────────────────────────────────────────┘
```

Two triggers feed the same graph: a Manual Trigger (testing) and a Schedule Trigger (`06:00` daily, production). Both converge on a Google Drive search that makes spreadsheet creation idempotent, and the pipeline ends with a Gmail-label step that makes email processing idempotent across daily runs.

## 3. Data Source

### 3.1 Email source

`job-alerts@mycareersfuture.gov.sg` sends HTML/text emails containing **URL-encoded links** to job postings, each embedding a 32-character hex job UUID:

```
https:%2F%2Fwww.mycareersfuture.gov.sg%2Fjob%2F<32-char-hex-uuid>?utm_source=...
```

### 3.2 MCF Jobs API

Public, no authentication required. Full spec in `docs/swagger_v2_jobs.json`.

```
GET https://api.mycareersfuture.gov.sg/v2/jobs?uuids=<uuid1>&uuids=<uuid2>...
```

- `uuids`: **repeated query params**, not brackets or comma-separated (`uuids=a&uuids=b`, not `uuids[]=a` or `uuids=a,b`). n8n's HTTP Request node UI doesn't support repeated params natively, so the URL is pre-built as a string in a Code node upstream (see §6.2).
- `limit`: int, 1–100, default 20 (not set by this workflow — see §8, known deviation from an earlier draft of this spec that included `&limit=100`).
- `page`: int, default 0 (not used — this workflow fetches by UUID, not by paging a general listing).
- Response: `{ results: Job[], total: int }`.

### 3.3 Job object (key fields, from `docs/swagger_v2_jobs.json`)

```
uuid*, title*, description* (HTML), sourceCode*, numberOfVacancies*
status*          { jobStatus }
postedCompany*   { uen, name }
hiringCompany    { uen, name }                    (nullable)
categories*      [{ category }]
employmentTypes* [{ employmentType }]
positionLevels*  [{ position }]
skills*          [{ skill }]
salary           { minimum, maximum, type: { salaryType } }  (nullable)
address          { districts: [{ location }], postalCode, street, building }  (nullable)
schemes          [{ scheme: { scheme }, subScheme: { programme } }]
metadata*        { jobPostId, createdAt, newPostingDate, originalPostingDate,
                   totalNumberOfView, totalNumberJobApplication, jobDetailsUrl }
minimumYearsExperience (nullable), workingHours (nullable),
otherRequirements (nullable, HTML), flexibleWorkArrangements [{ flexibleWorkArrangement }]
```

## 4. Workflow: "MCF Job Alerts - Email to Google Sheets"

**Workflow ID**: `O7qcFvuyhv1qJpMr` (n8n Cloud instance `https://ianlokh.app.n8n.cloud`)

### 4.1 Node inventory

| Node | Type | Version | Purpose |
|---|---|---|---|
| `When clicking 'Test workflow'` | `manualTrigger` | 1 | Manual/test entry point |
| `Schedule Trigger` | `scheduleTrigger` | 1.3 | Daily entry point, `triggerAtHour: 6` |
| `Search files and folders` | `googleDrive` (resource `fileFolder`) | 3 | Searches Drive for a file named "MCF Job Data"; `alwaysOutputData: true` so the empty case (no file found) still emits an item for the IF check below |
| `If Data Sheet Exists` | `if` | 2.3 | Condition: `{{ $json.id }}` string `exists` — true if the Drive search found a file |
| `Create MCF Job Data Sheet` | `googleSheets` (resource `spreadsheet`, op `create`) | 4.7 | Creates spreadsheet titled "MCF Job Data" with sheet tab "MCF Jobs" — only runs when no existing file was found |
| `Get MCF Alert Emails` | `gmail` (op `getAll`) | 2.2 | `returnAll: true`, `simple: false`, filter `sender: job-alerts@mycareersfuture.gov.sg` AND `q: -label:"MCF Processed"` (excludes already-processed emails) |
| `Extract Job UUIDs` | `code` (JS) | 2 | Parses job URLs out of each email body — see §6.1 |
| `Edit Fields` | `set` | 3.4 | Parallel branch off `Get MCF Alert Emails`: assigns `id = {{ $json.id }}`, isolating just the Gmail message ID for the labeling side-path |
| `Batch UUIDs & Build URLs` | `code` (JS) | 2 | Extracts UUIDs from URLs, builds one MCF API URL per email — see §6.2 |
| `Loop Over Batches` | `splitInBatches` | 3 | One batch (one email's UUIDs) per iteration; default `batchSize` |
| `Fetch MCF Job Data` | `httpRequest` | 4.4 | `GET {{ $json.apiUrl }}`, `Accept: application/json` header, `timeout: 30000`, `onError: continueRegularOutput` |
| `Transform Job Data` | `code` (JS) | 2 | Flattens nested API JSON into sheet-row records — see §6.3 |
| `Deduplicate Jobs` | `code` (JS) | 2 | Removes duplicate job records — see §6.4 |
| `Append to Google Sheets` | `googleSheets` (resource `sheet`, op `append`) | 4.7 | Appends to "MCF Jobs" tab, `mappingMode: autoMapInputData` |
| `Merge` | `merge` (mode `chooseBranch`) | 3.2 | `useDataOfInput: 2` (1-indexed) — passes through input index 1 (the `Edit Fields` branch's email-id data), used purely as a **synchronization barrier**: waits for both the sheet-append branch and the id-extraction branch to complete before labeling |
| `Add label to message` | `gmail` (op `addLabels`) | 2.2 | `messageId: {{ $json.id }}`, applies label ID `Label_5161189671814561547` ("MCF Processed") — marks the email as processed so it's excluded on the next run |
| `Sticky Note - Overview` / `- API` / `- Dedup` / `- Sheets` | `stickyNote` | 1 | Canvas documentation (see content in the live workflow / local JSON export) |

### 4.2 Connections (authoritative — matches the live n8n Cloud instance)

```
When clicking 'Test workflow'  → Search files and folders
Schedule Trigger                → Search files and folders

Search files and folders        → If Data Sheet Exists
If Data Sheet Exists (true)     → Get MCF Alert Emails
If Data Sheet Exists (false)    → Create MCF Job Data Sheet
Create MCF Job Data Sheet       → Get MCF Alert Emails

Get MCF Alert Emails            → Extract Job UUIDs        (branch 1: main pipeline)
Get MCF Alert Emails            → Edit Fields               (branch 2: id-extraction for labeling)

Extract Job UUIDs               → Batch UUIDs & Build URLs
Batch UUIDs & Build URLs        → Loop Over Batches
Loop Over Batches (done/0)      → Transform Job Data
Loop Over Batches (loop/1)      → Fetch MCF Job Data
Fetch MCF Job Data              → Loop Over Batches          (continues the loop)
Transform Job Data              → Deduplicate Jobs
Deduplicate Jobs                → Append to Google Sheets
Append to Google Sheets         → Merge (input 0 / index 0)

Edit Fields                     → Merge (input 1 / index 1)
Merge                           → Add label to message
```

**A note on `Get MCF Alert Emails`'s fan-out**: this node has a single output that connects to two downstream nodes (`Extract Job UUIDs` and `Edit Fields`), both receiving the full email list. This is a plain one-to-many fan-out, not an error-output split (`Fetch MCF Job Data` is the only node using `onError: continueRegularOutput`/error-output in this graph).

**`SplitInBatches` wiring** (standard n8n loop pattern): output 0 = "done" (fires once, after all batches — feeds the downstream `Transform Job Data`); output 1 = "loop" (fires per-batch — feeds `Fetch MCF Job Data`, which wires back into `Loop Over Batches`'s input to continue).

### 4.3 Idempotency design

Two independent mechanisms prevent duplicate work across the daily schedule:

1. **Spreadsheet reuse**: `Search files and folders` looks up a file named "MCF Job Data" in Google Drive before every run. If found, its file ID feeds `Append to Google Sheets`'s `documentId` directly (`{{ $("Search files and folders").first().json.id ?? $("Create MCF Job Data Sheet").item.json.spreadsheetId }}`); if not found, `Create MCF Job Data Sheet` makes a new one and its ID is used instead. No manual "disable the create node after first run" step is needed (this was a manual workaround in an earlier version of the project; the current graph automates it).
2. **Email bookmarking**: `Get MCF Alert Emails` excludes any email already labeled "MCF Processed" (`q: -label:"MCF Processed"`). After a successful run, `Add label to message` applies that label to every email that was processed, so the next scheduled run only sees new alert emails.

## 5. Output Schema (Google Sheets)

Sheet tab: **"MCF Jobs"**, in spreadsheet **"MCF Job Data"**. All fields flattened to strings via `autoMapInputData` (field names in the Code node output match column headers exactly, so headers are created automatically on first write — no manual column mapping). Arrays become comma-separated strings. HTML is stripped and truncated to 5000 chars. Numeric fields use `!= null` checks (not `||`) to preserve valid zero values.

33 columns, in the order emitted by `transform-job-data.js`:

```
uuid, jobPostId, title, sourceCode, status,
postedCompanyName, hiringCompanyName, postedCompanyUen,
categories, employmentType, positionLevel,
salaryMinimum, salaryMaximum, salaryType, minimumYearsExperience,
skills, description, otherRequirements,
numberOfVacancies, workingHours, flexibleWorkArrangements,
schemes, district, postalCode, street, building,
createdAt, originalPostingDate, newPostingDate,
totalViews, totalApplications,
mcfUrl (constructed as https://www.mycareersfuture.sg/job/<uuid>),
jobDetailsUrl, extractedAt (runtime ISO timestamp)
```

## 6. Code Nodes

Each is kept as a standalone file in `src/code-nodes/`, matching the node name, so it can be edited/linted outside n8n; the same code is pasted into the corresponding node's `jsCode` parameter.

### 6.1 `src/code-nodes/extract-job-uuids.js` — node "Extract Job UUIDs"

One incoming item per email. Regex-matches every URL-encoded `mycareersfuture.gov.sg` link in the email body (`text` or `html`), decodes it, keeps only `/job/...` links (excludes `/jobalert...`), trims query strings, and de-duplicates. Emits `{ emailId, urls: string[] }` per email.

```javascript
// Each incoming item = one email
return items.map(item => {
  const text = item.json.text || item.json.html || "";

  // Match full encoded URLs under mycareersfuture.gov.sg
  const regex = /https:%2F%2Fwww\.mycareersfuture\.gov\.sg%2F[^\s"'<>]*/gi;
  const encodedMatches = text.match(regex) || [];

  const decoded = encodedMatches.map(m => decodeURIComponent(m));

  // Keep only /job..., exclude /jobalert...
  const jobUrls = decoded.filter(url =>
    url.startsWith("https://www.mycareersfuture.gov.sg/job") &&
    !url.startsWith("https://www.mycareersfuture.gov.sg/jobalert")
  );

  // Trim everything after the first "?"
  const trimmedJobUrls = jobUrls.map(url => {
    const qIndex = url.indexOf("?");
    return qIndex === -1 ? url : url.slice(0, qIndex);
  });

  // De-duplicate after trimming
  const uniqueJobUrls = Array.from(new Set(trimmedJobUrls));

  const emailId = item.json.id || item.json.messageId || null;

  return {
    json: {
      emailId,
      urls: uniqueJobUrls
    }
  };
});
```

### 6.2 `src/code-nodes/batch-uuids.js` — node "Batch UUIDs & Build URLs"

One item per email (from §6.1). Extracts the 32-hex-char UUID from each job URL, then builds **one MCF API URL per email** with all its UUIDs as repeated `uuids=` params. Emails with zero resolvable UUIDs are dropped.

```javascript
// Extract UUIDs from job URLs and build MCF API URLs per email
// Each item = one email with its job URLs (batched by emailId)
// Swagger: GET /v2/jobs?uuids=uuid1&uuids=uuid2
return items
  .map(item => {
    const urls = item.json.urls || [];

    const uuids = urls
      .map(url => {
        // Match 32 hex chars at the end of the URL path
        const m = url.match(/[0-9a-fA-F]{32}$/);
        return m ? m[0] : null;
      })
      .filter(Boolean);

    if (uuids.length === 0) return null;

    // Build MCF API URL with repeated uuids params per swagger spec
    const queryParams = uuids.map(uuid => `uuids=${uuid}`).join('&');
    const apiUrl = `https://api.mycareersfuture.gov.sg/v2/jobs?${queryParams}`;

    return {
      json: {
        emailId: item.json.emailId,
        uuids,
        uuidCount: uuids.length,
        apiUrl
      }
    };
  })
  .filter(Boolean);
```

**Design rationale — batch by email, not by job**: one API call per email's UUIDs (M emails) instead of one per UUID (N jobs), where M ≪ N. The URL is built here rather than in the HTTP Request node's UI because MCF requires repeated query params, which n8n's UI doesn't support natively.

### 6.3 `src/code-nodes/transform-job-data.js` — node "Transform Job Data"

Runs once per completed loop (`$input.all()` — batch results accumulated by `Loop Over Batches`'s "done" output). Flattens every job in every API response's `results` array into one flat record per job, matching the 33-column schema in §5. Falls back to treating the whole response as a single job if `results` is absent. Skips entries with neither `uuid` nor `title`. Emits a single `{ warning, extractedAt }` item if nothing survived (so downstream steps don't error on an empty array).

```javascript
// Transform raw MCF API responses into flat records for Google Sheets
// Compliant with swagger_v2_jobs.json schema

const jobs = [];

for (const item of $input.all()) {
  const apiResponse = item.json;
  const results = apiResponse.results || [apiResponse];

  for (const job of results) {
    if (!job.uuid && !job.title) continue;

    const record = {
      uuid: job.uuid || '',
      jobPostId: (job.metadata && job.metadata.jobPostId) || '',
      title: job.title || '',
      sourceCode: job.sourceCode || '',
      status: (job.status && job.status.jobStatus) || '',
      postedCompanyName: (job.postedCompany && job.postedCompany.name) || '',
      hiringCompanyName: (job.hiringCompany && job.hiringCompany.name) || '',
      postedCompanyUen: (job.postedCompany && job.postedCompany.uen) || '',
      categories: extractArray(job.categories, 'category'),
      employmentType: extractArray(job.employmentTypes, 'employmentType'),
      positionLevel: extractArray(job.positionLevels, 'position'),
      salaryMinimum: job.salary && job.salary.minimum != null ? job.salary.minimum : '',
      salaryMaximum: job.salary && job.salary.maximum != null ? job.salary.maximum : '',
      salaryType: (job.salary && job.salary.type && job.salary.type.salaryType) || '',
      minimumYearsExperience: job.minimumYearsExperience != null ? job.minimumYearsExperience : '',
      skills: extractArray(job.skills, 'skill'),
      description: stripHtml(job.description || ''),
      otherRequirements: stripHtml(job.otherRequirements || ''),
      numberOfVacancies: job.numberOfVacancies || '',
      workingHours: job.workingHours || '',
      flexibleWorkArrangements: extractArray(job.flexibleWorkArrangements, 'flexibleWorkArrangement'),
      schemes: extractSchemes(job.schemes),
      district: extractDistricts(job.address),
      postalCode: (job.address && job.address.postalCode) || '',
      street: (job.address && job.address.street) || '',
      building: (job.address && job.address.building) || '',
      createdAt: (job.metadata && job.metadata.createdAt) || '',
      originalPostingDate: (job.metadata && job.metadata.originalPostingDate) || '',
      newPostingDate: (job.metadata && job.metadata.newPostingDate) || '',
      totalViews: job.metadata && job.metadata.totalNumberOfView != null ? job.metadata.totalNumberOfView : '',
      totalApplications: job.metadata && job.metadata.totalNumberJobApplication != null ? job.metadata.totalNumberJobApplication : '',
      mcfUrl: job.uuid ? `https://www.mycareersfuture.sg/job/${job.uuid}` : '',
      jobDetailsUrl: (job.metadata && job.metadata.jobDetailsUrl) || '',
      extractedAt: new Date().toISOString()
    };

    jobs.push({ json: record });
  }
}

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 5000);
}

function extractArray(arr, key) {
  if (!Array.isArray(arr)) return '';
  return arr.map(item => item[key] || '').filter(Boolean).join(', ');
}

function extractSchemes(schemes) {
  if (!Array.isArray(schemes)) return '';
  return schemes
    .map(s => {
      const name = (s.scheme && s.scheme.scheme) || '';
      const sub = (s.subScheme && s.subScheme.programme) || '';
      return sub ? `${name} - ${sub}` : name;
    })
    .filter(Boolean)
    .join(', ');
}

function extractDistricts(address) {
  if (!address || !Array.isArray(address.districts)) return '';
  return address.districts.map(d => d.location || '').filter(Boolean).join(', ');
}

if (jobs.length === 0) {
  return [{
    json: {
      warning: 'No job data returned from API',
      extractedAt: new Date().toISOString()
    }
  }];
}

return jobs;
```

### 6.4 `src/code-nodes/deduplicate-jobs.js` — node "Deduplicate Jobs"

Two-strategy dedup, first occurrence wins:

1. **Primary**: exact `uuid` match (the same posting appeared in more than one email/batch).
2. **Secondary**: same `postedCompanyName` + `title` (case-insensitive, trimmed) — catches a role that was re-posted under a new UUID.

Items with a `warning` field (from §6.3's empty-result case) or missing `uuid` are skipped entirely. If everything gets filtered out, emits a single `{ warning, totalDuplicates, extractedAt }` item.

```javascript
// Deduplicate jobs using two strategies:
// 1. Primary: Same UUID (exact same posting)
// 2. Secondary: Same company name + same title (same role re-posted)

const seen = new Map();
const companyTitleSet = new Set();
const duplicates = [];
const kept = [];

for (const item of $input.all()) {
  const job = item.json;

  if (job.warning || !job.uuid) {
    continue;
  }

  const uuid = job.uuid;
  const companyTitleKey = `${(job.postedCompanyName || '').toLowerCase().trim()}|||${(job.title || '').toLowerCase().trim()}`;

  // Primary dedup: exact UUID match
  if (seen.has(uuid)) {
    duplicates.push({ uuid, title: job.title, reason: 'duplicate_uuid' });
    continue;
  }

  // Secondary dedup: same company + same title
  if (companyTitleSet.has(companyTitleKey)) {
    duplicates.push({ uuid, title: job.title, company: job.postedCompanyName, reason: 'duplicate_company_title' });
    continue;
  }

  seen.set(uuid, true);
  companyTitleSet.add(companyTitleKey);
  kept.push(item);
}

console.log(`Deduplication: ${kept.length} kept, ${duplicates.length} removed`);
console.log(`Duplicates by UUID: ${duplicates.filter(d => d.reason === 'duplicate_uuid').length}`);
console.log(`Duplicates by Company+Title: ${duplicates.filter(d => d.reason === 'duplicate_company_title').length}`);

if (kept.length === 0) {
  return [{
    json: {
      warning: 'All jobs were duplicates or no valid jobs found',
      totalDuplicates: duplicates.length,
      extractedAt: new Date().toISOString()
    }
  }];
}

return kept;
```

## 7. Error Handling

- `Fetch MCF Job Data` uses `onError: continueRegularOutput` — a failed batch (network error, bad UUID, MCF API 4xx/5xx) doesn't crash the run; it's swallowed and the loop continues to the next batch. Any resulting malformed item is filtered out downstream by `Transform Job Data`'s `if (!job.uuid && !job.title) continue`.
- `Transform Job Data` and `Deduplicate Jobs` both guard against an empty result set by emitting a single `{ warning, ... }` item rather than an empty array, so `Append to Google Sheets` never receives zero items in a way that would look like a silent failure — the warning row is visible in the sheet/execution log instead.
- `Search files and folders` sets `alwaysOutputData: true` so a "no existing sheet" result still produces an item for `If Data Sheet Exists` to evaluate (otherwise 0 items would skip that IF entirely and the whole branch below it).

## 8. Known Issues / Follow-ups

- **Gmail label ID is instance-specific**: `Label_5161189671814561547` is this Gmail account's label ID for "MCF Processed." A fresh deployment must create an equivalent label and substitute its own ID (the MCP cannot create Gmail labels — see `n8n-extending-mcp` skill if that gap needs closing).

Resolved as of 2026-07-04: the live n8n Cloud workflow, `n8n/mcf-job-alerts-email-to-sheets.json`, and `src/code-nodes/*.js` are now all in sync — `batch-uuids.js` no longer references `&limit=100` (confirmed intentional; each call is already scoped to one email's UUIDs), and the JSON export reflects the live `Extract Job UUIDs` code (plain-text vs. HTML-encoded link parsing) and current connection graph.

## 9. Credentials

Never hardcode secrets; reference credentials by ID via n8n's credential system.

| Type | Label | ID |
|------|-------|----|
| `gmailOAuth2` | Gmail OAuth | `O7pnZAPuEsmPCS91` |
| `googleSheetsOAuth2Api` | Google Sheets OAuth | `uBda0hDvnDBh6LU0` |

A fresh deployment must create its own Gmail OAuth2 and Google Sheets OAuth2 credentials in the n8n UI (the MCP cannot create credentials) and bind them by ID.

## 10. Build & Maintenance Process

This project is built and maintained using the **official n8n MCP server** (instance-level, `n8n-mcp` in `.claude.json`) and the **official `n8n-skills` plugin** (`n8n-io/skills`). Workflows are built as `@n8n/workflow-sdk` code, not hand-written JSON.

**Before any n8n action** (writing SDK code, configuring a node, wiring a connection, handling errors): invoke the matching skill via the Skill tool. Start with `using-n8n-skills` (the router) if unsure which applies — err on the side of loading more skills, not fewer. n8n's tool surface and defaults drift between versions; trust the skills and live MCP tools (`get_node_types`, `get_sdk_reference`, `get_workflow_best_practices`) over anything remembered from a prior session.

### 10.1 Project structure

```
docs/           API specs (swagger/OpenAPI JSON) and reference material
n8n/            @n8n/workflow-sdk source files (.js) — source of truth for versioning
src/
  code-nodes/   JavaScript/Python code for n8n Code nodes (last-resort only, one file per node)
  prompts/      AI prompts for agent workflows
  sql/          SQL queries for database nodes
```

### 10.2 Conventions

- **SDK workflow files**: one `.js` file per workflow in `n8n/`, written against `@n8n/workflow-sdk` (`workflow()`, `node()`, `trigger()`, `.add()`/`.to()`). This file *is* what gets passed to `create_workflow_from_code`/`update_workflow` — it's the versioned source of truth, not an exported JSON blob.
- **Code nodes**: last resort (see §10.6). When one is genuinely needed, mirror it in `src/code-nodes/` as a standalone `.js`/`.py` file matching the node name, and paste the same code into the SDK node's `parameters.jsCode`/`parameters.pythonCode`.
- **Node names**: clear, action-oriented ("Fetch MCF Job Data", "Extract Job UUIDs", "Deduplicate Jobs"), never generic ("HTTP Request1", "Set2").
- **Variable names in SDK code**: unique per node; never reuse builder function names (`node`, `trigger`, `merge`, etc.) as variable names.

### 10.3 Plan

- Call `get_workflow_best_practices` with the relevant technique(s) (`scheduling`, `data_extraction`, `notification`, etc. — pass `"list"` if unsure) before picking nodes.
- `search_workflows` for existing sub-workflows that already solve part of the problem before building new ones.
- Read any swagger/OpenAPI spec in `docs/` before writing code against that API. Note required fields, array formats, pagination, auth.

### 10.4 Discover nodes and read the SDK reference

- Call `get_sdk_reference` once per session before writing SDK code (sections: `patterns`, `rules`, `expressions`, `guidelines` — omit `section` for everything).
- `search_nodes` for the services/utilities needed (e.g. `["gmail", "google drive", "google sheets", "schedule trigger", "if", "merge", "split in batches"]`).
- `get_node_types` with every node ID (plus discriminators from search results) for exact parameter shapes — never guess parameter names. This is required before configuring any node in this workflow, including the ones already documented in §4.1 — parameter shapes drift between n8n versions.
- For resource-locator/load-options fields (Slack channel picker, Sheets tab, Drive folder, etc.), call `explore_node_resources` with the method name and a real `credentialId` from `list_credentials`.

### 10.5 SDK code conventions

Node type format is consistent everywhere in SDK code — always the full id (`n8n-nodes-base.httpRequest`, `n8n-nodes-base.gmail`). No split between search-tool and workflow-config formats.

```javascript
import { workflow, node, trigger, expr } from '@n8n/workflow-sdk';

const startTrigger = trigger({ type: 'n8n-nodes-base.manualTrigger', version: 1, config: { name: 'Start' } });
const fetchData = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: { name: 'Fetch MCF Job Data', parameters: { url: expr('{{ $json.apiUrl }}') } }
});

export default workflow('mcf-job-alerts', 'MCF Job Alerts - Email to Google Sheets')
  .add(startTrigger)
  .to(fetchData);
```

Rules that matter (full detail lives in `get_sdk_reference` — don't re-derive from memory):
- Every node needs an `output` property with sample data — downstream expressions depend on it.
- `expr()` wraps all `{{ }}` — never backtick template literals; variables go *inside* `{{ }}`, not string-concatenated outside it.
- `.input(n)`/`.output(n)` are 0-based — `.input(0)` is the first input, not `.input(1)`. Merge's `useDataOfInput` parameter, by contrast, is 1-indexed: translate `useDataOfInput: N` → wire to `.input(N - 1)`.
- `executeOnce: true` on a node chained after a multi-item source that should only run once (summary, shared lookup, non-per-item API call) — otherwise it multiplies N×M.
- Don't add `alwaysOutputData: true` or an IF-gate before a loop just to "keep the chain alive" on 0 items — 0 items flowing into a no-op downstream is correct behavior for scheduled/polling triggers. (`Search files and folders` in this workflow is the deliberate exception — see §7.)

**Batch loop pattern** (used in this workflow's "Loop Over Batches"):
```javascript
const sib = splitInBatches({ version: 3, config: { name: 'Loop Over Batches', parameters: {} } });

workflow('id', 'name')
  .add(startTrigger)
  .to(batchUuids)
  .to(sib.onDone(transformJobData).onEachBatch(fetchMcfJobData.to(nextBatch(sib))));
```

**Google Sheets output**:
- `resource: "spreadsheet"` + `operation: "create"` to create a new spreadsheet.
- `resource: "sheet"` + `operation: "append"` to add rows.
- Reference a just-created (or found) sheet with a fallback: `expr('{{ $("Search files and folders").first().json.id ?? $("Create MCF Job Data Sheet").item.json.spreadsheetId }}')`.
- `mappingMode: "autoMapInputData"` when input field names already match desired columns.

### 10.6 Code nodes — last resort

Decision order: expression (`{{ }}`) → arrow function inside Edit Fields → Code node. Code earns its place for multi-source aggregation (`$('Node').all()` across several upstreams), external libraries (lodash/crypto/luxon allowlist), or genuinely stateful multi-step logic — not for what a native node (Crypto, XML, Set) already does. This workflow's four Code nodes (§6) are justified: batch/URL-building and multi-field flattening logic that's meaningfully harder to express as inline expressions.

- Default mode: **Run Once for All Items** (`$input.all()`), not per-item — loop inside the function if needed.
- Return format: array of `{ json: {} }` objects.
- Numeric fields: use `!= null`, not `||`, to preserve valid zeroes (see §6.3 for the pattern used throughout `transform-job-data.js`).

### 10.7 HTTP Request Node

- Build complex query strings upstream when the HTTP Request UI can't express them (see §6.2), reference via `expr('{{ $json.apiUrl }}')`.
- For repeated array params: `uuids=a&uuids=b`, not `uuids[]=a`.
- `Accept: application/json` header for JSON APIs; `timeout: 30000` for external calls; `onError: "continueRegularOutput"` to avoid crashing the workflow on API failures.

### 10.8 Validate, verify, test, publish

```
validate_workflow  →  create_workflow_from_code / update_workflow  →  get_workflow_details (verify connections)  →  prepare_test_pin_data + test_workflow  →  publish_workflow
```

- `validate_workflow` is necessary but **not sufficient** — it doesn't catch dropped `.to()` wiring, collapsed fan-outs, or merge index-off-by-one. Always pull `get_workflow_details` after create/update and check the `connections` object matches intent.
- `test_workflow` auto-pins triggers, credentialed nodes, and HTTP Request; everything else (Code, Edit Fields, If, Data Tables, Execute Command, sub-workflow calls) runs for real — ask the user before testing if any of those have side effects. In this workflow, that means: real Gmail label writes and a real Google Sheets append unless pinned.
- Pass `skillsUsed: [...]` on `create_workflow_from_code`/`update_workflow` calls (qualified skill names, e.g. `"n8n-skills:n8n-workflow-lifecycle"`).
- Only call `publish_workflow` after validate + verify + test are clean.
- After exporting/saving, update the SDK source file in `n8n/` so it stays the versioned source of truth.

## 11. Files

```
docs/swagger_v2_jobs.json                        MCF Jobs API v2 swagger spec
docs/SPECIFICATIONS.md                            This document
n8n/mcf-job-alerts-email-to-sheets.json          Workflow JSON export (see §8 re: drift from live)
src/code-nodes/extract-job-uuids.js              Parse emails → job URLs per emailId
src/code-nodes/batch-uuids.js                    URLs → UUIDs → API URL per email
src/code-nodes/transform-job-data.js             API response → flat sheet records
src/code-nodes/deduplicate-jobs.js               Remove duplicate records
```
