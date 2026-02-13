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
