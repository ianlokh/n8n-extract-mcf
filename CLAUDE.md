# n8n Workflow Builder

Build and deploy n8n workflows to the connected n8n Cloud instance using MCP tools.

## Project Structure

```
docs/           API specs (swagger/OpenAPI JSON) and reference material
n8n/            Exported workflow JSON files (source of truth for versioning)
src/
  code-nodes/   JavaScript/Python code for n8n Code nodes (one file per node)
  prompts/      AI prompts for agent workflows
  sql/          SQL queries for database nodes
```

### Conventions

- **Code nodes**: Keep code in `src/code-nodes/` as standalone `.js`/`.py` files matching the node name. Copy the same code into the workflow JSON `jsCode`/`pythonCode` field. This allows IDE editing and linting outside n8n.
- **Workflow JSON**: After deploying via MCP, export the full workflow to `n8n/` so there's a local copy for version control.
- **Node IDs**: Use descriptive IDs like `node-extract-uuids`, `node-http-request` (not auto-generated UUIDs).
- **Node names**: Use clear, action-oriented names: "Fetch MCF Job Data", "Extract Job UUIDs", "Deduplicate Jobs".

## Building Workflows

### 1. Understand the API / Data Source

- Read any swagger/OpenAPI spec in `docs/` before writing code
- Note required fields, array formats, pagination, and auth requirements
- Pay attention to query parameter formats (repeated params vs comma-separated vs brackets)

### 2. Design Node Flow

Plan the sequence before building. Common patterns:

**Batched API requests** (used in MCF workflow):
```
Trigger → Prepare Data → Build API URLs (Code) → SplitInBatches
  Loop[1] → HTTP Request → back to SplitInBatches
  Loop[0/done] → Transform → Output
```

**SplitInBatches wiring** (critical to get right):
- Output 0 = "done" (fires after all items processed) → connect to downstream processing
- Output 1 = "loop" (fires for each batch) → connect to the work node (HTTP Request, etc.)
- The work node connects back to SplitInBatches input to continue the loop
- Data accumulates through the loop; the "done" output sends all accumulated results

**Google Sheets output**:
```
... → Transform Data → Deduplicate → Append to Google Sheets
```
- Use `resource: "spreadsheet"` + `operation: "create"` to create new spreadsheets
- Use `resource: "sheet"` + `operation: "append"` to add rows
- Reference created sheet dynamically: `={{ $('Create Sheet Node').first().json.spreadsheetId }}`
- Use `mappingMode: "autoMapInputData"` when input field names match desired column names

### 3. Build with MCP Tools

**Workflow lifecycle**:
```
n8n_create_workflow  →  n8n_update_full_workflow  →  n8n_validate_workflow  →  n8n_test_workflow
```

**Node type formats** (important - these differ by context):
- Search/validate tools: `nodes-base.httpRequest`, `nodes-base.googleSheets`
- Workflow node configs: `n8n-nodes-base.httpRequest`, `n8n-nodes-base.googleSheets`

**Useful tool patterns**:
- `get_node` with `mode: "search_properties"` to find specific config fields
- `get_node` with `detail: "full"` for complete property schema
- `validate_workflow` with `profile: "strict"` for thorough checking
- `search_templates` to find reference implementations

### 4. Code Node Patterns

**Code node v2 (JavaScript)** - two contexts:
- `items` variable: available in "Run Once for Each Item" mode (default for v2 `jsCode`)
- `$input.all()`: available in "Run Once for All Items" mode

**Return format** - always return array of `{ json: {} }` objects:
```javascript
return items.map(item => ({
  json: { ...item.json, newField: 'value' }
}));
```

**Filter items** by returning null and filtering:
```javascript
return items.map(item => {
  if (shouldSkip(item)) return null;
  return { json: { ... } };
}).filter(Boolean);
```

**Numeric fields** - use `!= null` not `||` to preserve valid zeroes:
```javascript
salaryMin: job.salary && job.salary.minimum != null ? job.salary.minimum : '',
```

**Reference earlier nodes** in expressions:
```
={{ $('Node Name').first().json.fieldName }}
{{ $json.fieldName }}
```

### 5. HTTP Request Node

- Build complex query strings in a Code node upstream, pass as `apiUrl` field
- Use expression in URL: `={{ $json.apiUrl }}`
- For repeated query params (arrays): `uuids=a&uuids=b` not `uuids[]=a`
- Always set `Accept: application/json` header for JSON APIs
- Set `timeout: 30000` for external APIs
- Use `onError: "continueRegularOutput"` to avoid workflow crashes on API failures

### 6. Validate and Deploy

Run `n8n_validate_workflow` after every update. Known false positives to ignore:
- "Cannot return primitive values directly" on Code nodes using `.filter(Boolean)` or conditional returns
- "URL expression missing http://" when URL is built dynamically via expression
- "Node connected to done output appears to be processing node" on SplitInBatches (Transform on done output is correct)
- "Code nodes can throw errors" (advisory, always true)

After validation, update the local JSON export in `n8n/`.

## Credentials

Credentials are stored in n8n Cloud. Reference them by ID and name:
```json
"credentials": {
  "gmailOAuth2": { "id": "O7pnZAPuEsmPCS91", "name": "Gmail OAuth" },
  "googleSheetsOAuth2Api": { "id": "uBda0hDvnDBh6LU0", "name": "Google Sheets OAuth" }
}
```

Never hardcode secrets. Credentials are managed in the n8n UI.

## Existing Workflows

| Workflow | ID | Description |
|----------|----|-------------|
| MCF Job Alerts - Email to Google Sheets | `O7qcFvuyhv1qJpMr` | Extracts job postings from MyCareersFuture email alerts, fetches details via API, saves to Google Sheets |
