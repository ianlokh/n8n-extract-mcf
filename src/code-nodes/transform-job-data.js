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
