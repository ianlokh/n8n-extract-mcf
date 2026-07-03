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
