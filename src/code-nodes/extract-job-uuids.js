// Each incoming item = one email
return items.map(item => {
  const text = item.json.text || "";
  const html = item.json.html || "";

  // Plain-text body has unencoded URLs; HTML body wraps links behind a
  // click-tracking redirect, embedding the real URL percent-encoded
  // (e.g. https://xxx.awstrack.me/L0/https:%2F%2Fwww.mycareersfuture.gov.sg%2F...)
  const plainRegex = /https:\/\/www\.mycareersfuture\.gov\.sg\/[^\s"'<>]*/gi;
  const encodedRegex = /https:%2F%2Fwww\.mycareersfuture\.gov\.sg%2F[^\s"'<>]*/gi;

  const plainMatches = text.match(plainRegex) || [];
  const encodedMatches = (html.match(encodedRegex) || []).map(m => decodeURIComponent(m));

  const decoded = [...plainMatches, ...encodedMatches];

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
