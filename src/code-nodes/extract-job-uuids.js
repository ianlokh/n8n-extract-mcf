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
