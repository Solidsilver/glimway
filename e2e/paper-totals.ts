import papersContent from '../content/papers.json' with { type: 'json' }

// Totals as the Journal and Library panels show them, so new papers don't break specs.
const papers: { source: string }[] = papersContent.papers
export const ALL_PAPERS = papers.length
export const JOURNAL_PAPERS = papers.filter((p) => p.source !== 'library-start').length
