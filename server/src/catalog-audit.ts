/**
 * Coverage observed by scripts/audit-catalog.mjs against live official SWORD
 * repositories on 2026-08-24. Runtime matching is deliberately exact: a new
 * module version remains usable but is labelled unaudited until this manifest
 * is regenerated.
 */
export interface AuditedCoverage {
  repository: string
  name: string
  version: string
  books: string[]
  tradition: string
  collection: 'bible' | 'deuterocanon' | 'ancient-writings'
}

const KJV_APOCRYPHA = [
  '1Esd', '2Esd', 'Tob', 'Jdt', 'AddEsth', 'Wis', 'Sir', 'Bar', 'PrAzar',
  'Sus', 'Bel', 'PrMan', '1Macc', '2Macc'
]

const LXX_APOCRYPHA = [
  '1Esd', 'Jdt', 'Tob', '1Macc', '2Macc', '3Macc', '4Macc', 'PrMan', 'Wis',
  'Sir', 'Bar', 'EpJer', 'PrAzar', 'Sus', 'Bel'
]

const NRSVA_APOCRYPHA = [
  'Tob', 'Jdt', 'Wis', 'Sir', 'Bar', 'PrAzar', 'Sus', 'Bel', '1Macc', '2Macc',
  '1Esd', 'PrMan', '2Esd'
]

const BROAD_ENGLISH_APOCRYPHA = [...NRSVA_APOCRYPHA, 'AddPs', '3Macc', '4Macc']

export const CATALOG_AUDIT: AuditedCoverage[] = [
  { repository: 'CrossWire', name: 'KJVA', version: '3.1', books: KJV_APOCRYPHA, tradition: 'King James Apocrypha', collection: 'deuterocanon' },
  { repository: 'CrossWire', name: 'DRC', version: '2.0', books: ['Tob', 'Jdt', 'Wis', 'Sir', 'Bar', '1Macc', '2Macc'], tradition: 'Catholic deuterocanon', collection: 'deuterocanon' },
  { repository: 'eBible.org', name: 'engwebbe2025eb', version: '658.0', books: ['Tob', 'Jdt', 'Wis', 'Sir', 'Bar', '1Macc', '2Macc', '1Esd', 'PrMan', 'AddPs', '3Macc', '2Esd', '4Macc'], tradition: 'Ecumenical deuterocanon', collection: 'deuterocanon' },
  { repository: 'eBible.org', name: 'engLXX2012eb', version: '104.0', books: LXX_APOCRYPHA, tradition: 'Septuagint', collection: 'deuterocanon' },
  { repository: 'eBible.org', name: 'engUKLXX2012eb', version: '278.0', books: LXX_APOCRYPHA, tradition: 'Septuagint', collection: 'deuterocanon' },
  { repository: 'STEP Bible', name: 'RV_th', version: '15.9', books: NRSVA_APOCRYPHA, tradition: 'Revised Version with Deuterocanon', collection: 'deuterocanon' },
  { repository: 'eBible.org', name: 'engKJV1769eb', version: '71.2', books: NRSVA_APOCRYPHA, tradition: 'King James Apocrypha', collection: 'deuterocanon' },
  { repository: 'eBible.org', name: 'engRV1895eb', version: '113.0', books: NRSVA_APOCRYPHA, tradition: 'Revised Version with Deuterocanon', collection: 'deuterocanon' },
  { repository: 'eBible.org', name: 'engasvbt2021eb', version: '101.0', books: BROAD_ENGLISH_APOCRYPHA, tradition: 'American Standard Version with Deuterocanon', collection: 'deuterocanon' },
  { repository: 'eBible.org', name: 'engwyc2017eb', version: '3.75', books: LXX_APOCRYPHA.filter((book) => !['3Macc', '4Macc'].includes(book)), tradition: 'Wycliffe tradition', collection: 'deuterocanon' },
  { repository: 'eBible.org', name: 'engwyc2018eb', version: '7.87', books: LXX_APOCRYPHA.filter((book) => !['3Macc', '4Macc'].includes(book)), tradition: 'Wycliffe tradition', collection: 'deuterocanon' },
  { repository: 'CrossWire', name: 'Wycliffe', version: '2.4.1', books: ['Tob', 'Jdt', 'Wis', 'Sir', 'Bar', '1Macc', '2Macc', 'PrMan', '1Esd', 'EpLao'], tradition: 'Wycliffe and Vulgate tradition', collection: 'deuterocanon' },
  { repository: 'CrossWire', name: 'Jubilees', version: '1.0', books: [], tradition: 'Second Temple writing', collection: 'ancient-writings' },
  { repository: 'CrossWire', name: 'Enoch', version: '2.0', books: [], tradition: 'Ethiopian and Second Temple writing', collection: 'ancient-writings' }
]

export function auditedCoverage(repository: string | undefined, name: string, version: string | undefined): AuditedCoverage | undefined {
  if (!repository || !version) return undefined
  return CATALOG_AUDIT.find((entry) => entry.repository === repository && entry.name === name && entry.version === version)
}
