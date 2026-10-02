// Country codes accepted by the search API's `country` param.
// The API has no region filter (`country=Europe` → "Invalid country") and no
// multi-country filter (`country=US,CA` → "Invalid country"), so a region is
// expanded into one request stream per country.

export const NORTH_AMERICA = [
  { code: 'US', name: 'United States' },
  { code: 'CA', name: 'Canada' },
];

export const EUROPE = [
  { code: 'GB', name: 'United Kingdom' },
  { code: 'DE', name: 'Germany' },
  { code: 'FR', name: 'France' },
  { code: 'NL', name: 'Netherlands' },
  { code: 'ES', name: 'Spain' },
  { code: 'IT', name: 'Italy' },
  { code: 'IE', name: 'Ireland' },
  { code: 'PT', name: 'Portugal' },
  { code: 'PL', name: 'Poland' },
  { code: 'SE', name: 'Sweden' },
  { code: 'DK', name: 'Denmark' },
  { code: 'FI', name: 'Finland' },
  { code: 'NO', name: 'Norway' },
  { code: 'BE', name: 'Belgium' },
  { code: 'AT', name: 'Austria' },
  { code: 'CH', name: 'Switzerland' },
  { code: 'CZ', name: 'Czechia' },
  { code: 'RO', name: 'Romania' },
  { code: 'GR', name: 'Greece' },
  { code: 'HU', name: 'Hungary' },
  { code: 'BG', name: 'Bulgaria' },
  { code: 'HR', name: 'Croatia' },
  { code: 'SK', name: 'Slovakia' },
  { code: 'SI', name: 'Slovenia' },
  { code: 'LT', name: 'Lithuania' },
  { code: 'LV', name: 'Latvia' },
  { code: 'EE', name: 'Estonia' },
  { code: 'LU', name: 'Luxembourg' },
  { code: 'MT', name: 'Malta' },
  { code: 'CY', name: 'Cyprus' },
  { code: 'IS', name: 'Iceland' },
  { code: 'UA', name: 'Ukraine' },
  { code: 'RS', name: 'Serbia' },
];

export const EUROPE_ALL = 'EUROPE_ALL';

const BY_CODE = new Map([...NORTH_AMERICA, ...EUROPE].map((c) => [c.code, c]));

/** Turns the menu selection (codes + EUROPE_ALL) into a unique list of countries. */
export function expandRegions(selection) {
  const codes = new Set();
  for (const value of selection) {
    if (value === EUROPE_ALL) EUROPE.forEach((c) => codes.add(c.code));
    else codes.add(value);
  }
  return [...codes].map((code) => BY_CODE.get(code));
}
