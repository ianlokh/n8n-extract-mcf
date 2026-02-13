# Project Specification: MCF Job Data Extraction

Extract job postings from MyCareersFuture (MCF) email alerts, fetch details via the public API, and save to Google Sheets. Built as n8n workflows deployed to n8n Cloud.

## Data Source

**Emails**: `job-alerts@mycareersfuture.gov.sg` sends URL-encoded links containing 32-char hex job UUIDs:
```
https:%2F%2Fwww.mycareersfuture.gov.sg%2Fjob%2F<uuid>?utm_source=...
```

**API** (no auth, full spec in `docs/swagger_v2_jobs.json`):
```
GET https://api.mycareersfuture.gov.sg/v2/jobs?uuids=aaa&uuids=bbb&limit=100
```
- `uuids`: repeated query params (not brackets), max `limit` is 100
- Response: `{ results: Job[], total: int }`

## Job Object (key fields)

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

## Output Columns (Google Sheets)

All fields flattened to strings. Arrays become comma-separated. HTML is stripped (max 5000 chars). Numeric fields use `!= null` checks to preserve valid zeroes.

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
mcfUrl (constructed), jobDetailsUrl, extractedAt (runtime timestamp)
```

## Workflow: MCF Job Alerts - Email to Google Sheets

**ID**: `O7qcFvuyhv1qJpMr`

```
Manual Trigger
  → Create MCF Job Data Sheet       googleSheets v4.7: create spreadsheet "MCF Job Data"
  → Get MCF Alert Emails            gmail v2.2: getAll from MCF sender
  → Extract Job UUIDs               code v2: src/code-nodes/extract-job-uuids.js
  → Batch UUIDs & Build URLs        code v2: src/code-nodes/batch-uuids.js
  → Loop Over Batches               splitInBatches v3
      [loop/1] → Fetch MCF Job Data     httpRequest v4.4: GET {{ $json.apiUrl }}
                   → back to Loop
      [done/0] → Transform Job Data     code v2: src/code-nodes/transform-job-data.js
  → Deduplicate Jobs                code v2: src/code-nodes/deduplicate-jobs.js
  → Append to Google Sheets         googleSheets v4.7: append to "MCF Jobs" sheet
```

**Deduplication**: First by UUID (exact match), then by company+title (re-posted roles). First occurrence kept.

## Key Design Decisions

- **Batch by email**: One API call per email's UUIDs (M emails) instead of per-UUID (N jobs). M << N.
- **URL built in Code node**: MCF requires repeated params (`uuids=a&uuids=b`); n8n's HTTP Request UI doesn't support this natively.
- **autoMapInputData**: Transform output field names match column headers, so auto-mapping creates headers on first write without manual column definitions.

## Files

```
docs/swagger_v2_jobs.json                        API spec
n8n/mcf-job-alerts-email-to-sheets.json          Workflow JSON export
src/code-nodes/extract-job-uuids.js              Parse emails → job URLs per emailId
src/code-nodes/batch-uuids.js                    URLs → UUIDs → API URL per email
src/code-nodes/transform-job-data.js             API response → flat sheet records
src/code-nodes/deduplicate-jobs.js               Remove duplicate records
```
