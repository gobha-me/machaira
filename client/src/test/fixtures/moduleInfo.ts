import type { ModuleInfo } from '../../services/api'

export const pathologicalModule: ModuleInfo = {
  id: 'Regression fixture:eng_Unbroken_Translation_Module_Identifier_With_An_Excessively_Long_Name_2026',
  name: 'eng_Unbroken_Translation_Module_Identifier_With_An_Excessively_Long_Name_2026',
  type: 'BIBLE',
  description:
    'A deliberately long human-readable SWORD module description covering a complete translation, extensive study annotations, morphology, cross-references, and the Apocrypha',
  language: 'en-US-PATHOLOGICALLY-LONG',
  abbreviation: 'EXTREMELY-LONG-ABBREVIATION',
  distributionLicense:
    'CreativeCommonsAttributionShareAlikeInternationalUnbrokenLicenseIdentifier',
  repository: 'Regression fixture',
  version: '2026.08.20',
  size: 1,
  about: 'Used to exercise module metadata layout boundaries.',
  hasStrongs: true,
  hasGreekStrongsKeys: true,
  hasHebrewStrongsKeys: true,
  hasFootnotes: true,
  hasHeadings: true,
  hasRedLetterWords: false,
  hasCrossReferences: true,
  locked: false,
  installed: false,
  kind: 'scripture',
  collection: 'deuterocanon',
  tradition: 'Regression tradition',
  coverage: ['Tob', 'Jdt'],
  coverageSource: 'audit',
  format: 'bundled',
  coverageSummary: 'Regression coverage summary',
  aiEligibility: 'review-required'
}
