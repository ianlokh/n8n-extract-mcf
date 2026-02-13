# MCF Job Data Extraction

Automated extraction of job postings from Singapore's [MyCareersFuture](https://www.mycareersfuture.gov.sg) platform into Google Sheets, powered by [n8n](https://n8n.io) workflow automation.

## What It Does

1. Reads job alert emails from Gmail (`job-alerts@mycareersfuture.gov.sg`)
2. Extracts job UUIDs from the email links
3. Fetches full job details from the MCF public API (batched by email)
4. Transforms nested API responses into flat, readable records
5. Deduplicates and appends results to a Google Sheet

Each run produces a spreadsheet with 33 columns covering job title, company, salary range, skills, location, employment type, and more.

## Prerequisites

- An [n8n Cloud](https://n8n.io/cloud/) instance (or self-hosted n8n)
- Gmail account subscribed to MCF job alerts
- Google account for Sheets access
- The following OAuth credentials configured in n8n:
  - **Gmail OAuth** - for reading emails
  - **Google Sheets OAuth** - for creating/writing spreadsheets

## Deployment

### Option 1: Import the workflow JSON

1. Open your n8n instance
2. Go to **Workflows** > **Import from File**
3. Select `n8n/mcf-job-alerts-email-to-sheets.json`
4. Update the credential references in each Gmail and Google Sheets node to match your configured credentials
5. Click **Test workflow** to run

### Option 2: Deploy via n8n MCP (for AI-assisted development)

This project includes an MCP integration for programmatic workflow management. See `CLAUDE.md` for build instructions.

```
npx -y n8n-mcp@latest
```

Required environment variables:
```
N8N_API_URL=https://<your-instance>.app.n8n.cloud/api/v1
N8N_API_KEY=<your-api-key>
```

## Usage

1. **First run**: The workflow creates a new "MCF Job Data" spreadsheet with a "MCF Jobs" sheet. After the first run, disable the "Create MCF Job Data Sheet" node and set the Append node's Document ID to the created spreadsheet to reuse it on subsequent runs.

2. **Run the workflow**: Click "Test workflow" in n8n. It will fetch all MCF alert emails, extract job UUIDs, call the API, and write results to Sheets.

3. **Output**: A Google Sheet with one row per unique job posting, including salary, skills, company, location, and direct links back to the MCF listing.

## Project Structure

```
n8n-extract-mcf/
  README.md                              This file
  CLAUDE.md                              AI agent build instructions
  docs/
    SPECIFICATIONS.md                    Technical specification
    swagger_v2_jobs.json                 MCF Jobs API v2 swagger spec
  n8n/
    mcf-job-alerts-email-to-sheets.json  Workflow JSON (importable into n8n)
  src/
    code-nodes/
      extract-job-uuids.js              Parse email links into job URLs
      batch-uuids.js                    Build batched API request URLs
      transform-job-data.js             Flatten API responses for Sheets
      deduplicate-jobs.js               Remove duplicate job records
```

## Workflow Overview

```
Manual Trigger
  → Create MCF Job Data Sheet         Creates Google Spreadsheet
  → Get MCF Alert Emails              Fetches emails from Gmail
  → Extract Job UUIDs                 Parses job URLs from email body
  → Batch UUIDs & Build URLs          Groups UUIDs per email, builds API URL
  → Loop Over Batches                 Processes one email batch at a time
      → Fetch MCF Job Data            GET /v2/jobs?uuids=...&limit=100
  → Transform Job Data                Flattens nested JSON to sheet rows
  → Deduplicate Jobs                  Removes duplicates (by UUID, then company+title)
  → Append to Google Sheets           Writes records to "MCF Jobs" sheet
```

## API Reference

The MCF Jobs API is public (no authentication required):

```
GET https://api.mycareersfuture.gov.sg/v2/jobs?uuids=<uuid1>&uuids=<uuid2>&limit=100
```

Returns `{ results: Job[], total: int }`. Full swagger spec in `docs/swagger_v2_jobs.json`.

## Customisation

- **Change the trigger**: Replace the manual trigger with a Schedule node for daily automated runs
- **Filter by search**: Use the API's `search`, `categories`, or `salary` query params instead of email UUIDs
- **Add notifications**: Connect a Slack or Telegram node after deduplication to alert on new postings
- **Adjust output columns**: Edit `src/code-nodes/transform-job-data.js` to add or remove fields
