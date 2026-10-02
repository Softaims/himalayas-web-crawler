// Every field the user can ask for, where it comes from, and how to read it.
//   source 'job'     → already in the search API response (free)
//   source 'company' → needs one MCP `get_company_details` call per company

const salary = (j) =>
  j.minSalary == null && j.maxSalary == null
    ? null
    : { min: num(j.minSalary), max: num(j.maxSalary), currency: j.currency ?? null, period: j.salaryPeriod ?? null };

export const FIELDS = [
  // Required — always included.
  { key: 'companyName', label: 'Company name', source: 'job', required: true, get: (j) => j.companyName },
  { key: 'companyDomain', label: 'Company domain', source: 'company', required: true, get: (c) => c.domain },

  // Company (enrichment)
  { key: 'website', label: 'Company website URL', source: 'company', get: (c) => c.website },
  { key: 'linkedin', label: 'LinkedIn company page', source: 'company', checked: true, get: (c) => c.socials.linkedin ?? null },
  { key: 'socials', label: 'Other socials (Twitter, Facebook, Instagram…)', source: 'company', get: (c) => c.socials },
  { key: 'ceo', label: 'CEO name (only C-suite role available)', source: 'company', checked: true, get: (c) => c.ceo },
  { key: 'companySize', label: 'Company size', source: 'company', get: (c) => c.size },
  { key: 'founded', label: 'Founded year', source: 'company', get: (c) => c.founded },
  { key: 'hiringLocations', label: 'Countries the company hires in', source: 'company', get: (c) => c.locations },
  { key: 'markets', label: 'Markets / industries', source: 'company', get: (c) => c.markets },
  { key: 'techStack', label: 'Tech stack', source: 'company', get: (c) => c.techStack },
  { key: 'about', label: 'About the company', source: 'company', get: (c) => c.about },

  // Job (free)
  { key: 'jobTitle', label: 'Job title', source: 'job', checked: true, get: (j) => j.title },
  { key: 'jobLink', label: 'Job link', source: 'job', checked: true, get: (j) => j.applicationLink },
  { key: 'salary', label: 'Salary range', source: 'job', get: salary },
  { key: 'seniority', label: 'Seniority', source: 'job', get: (j) => j.seniority },
  { key: 'employmentType', label: 'Employment type', source: 'job', get: (j) => j.employmentType },
  { key: 'locationRestrictions', label: 'Job location restrictions', source: 'job', get: (j) => j.locationRestrictions },
  { key: 'timezoneRestrictions', label: 'Job timezone restrictions (UTC offsets)', source: 'job', get: (j) => j.timezoneRestrictions },
  { key: 'categories', label: 'Job categories', source: 'job', get: (j) => j.categories },
  { key: 'postedAt', label: 'Posted / expiry dates', source: 'job', get: (j) => ({ posted: toIso(j.pubDate), expires: toIso(j.expiryDate) }) },
  { key: 'excerpt', label: 'Job summary', source: 'job', get: (j) => j.excerpt },
  { key: 'description', label: 'Full job description (HTML, large)', source: 'job', get: (j) => j.description },
];

// Shown in the menu but not selectable, so it's clear what Himalayas can't provide.
export const UNAVAILABLE = [
  'Other C-suite executives (CTO, CFO…) — not provided by Himalayas',
  'HR / talent managers — not provided by Himalayas',
  'Personal emails or LinkedIn profiles — not provided by Himalayas',
];

export const fieldsByKey = new Map(FIELDS.map((f) => [f.key, f]));

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// The API returns unix seconds even though its docs say ISO 8601; handle both.
function toIso(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (Number.isFinite(n)) return new Date(n * 1000).toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
