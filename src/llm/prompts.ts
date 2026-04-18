import type { GroundTruth, ProbeForJudge } from './ground-truth.ts'
import { isSparseGroundTruth } from './ground-truth.ts'
import type { ProviderId } from './providers/types.ts'

export function promptRecognition(domain: string): [string, string] {
  return [
    `What is ${domain}?`,
    `Have you heard of ${domain}? If so, what is it known for?`,
  ]
}

export function promptCoverage(domain: string): [string, string] {
  return [
    `What does ${domain} do? List their main products or services.`,
    `Who is the target audience for ${domain}?`,
  ]
}

export function promptCitation(domain: string): string {
  return `What is the official website for ${domain}? Provide the URL.`
}

export function promptDiscoverabilityGenerator(gt: GroundTruth): string {
  return [
    'Below is content from a website. Generate ONE specific question a',
    'potential customer might ask an AI assistant — a question this website',
    'would be a good answer to. Do NOT reference the website by name.',
    'Return ONLY the question, no preamble or explanation.',
    '',
    '--- Website content ---',
    `Title: ${gt.title}`,
    `Description: ${gt.description}`,
    `H1: ${gt.h1}`,
    'Body excerpt:',
    gt.bodyExcerpt,
    '--- End content ---',
  ].join('\n')
}

export function promptAccuracyGenerator(gt: GroundTruth): string {
  return [
    'Below is content scraped from a company website. Write one specific factual question',
    'a visitor would reasonably ask about this company that the scraped content clearly',
    'answers. Return only the question.',
    '',
    '--- Website content ---',
    `URL: ${gt.url}`,
    `Title: ${gt.title}`,
    `Description: ${gt.description}`,
    `H1: ${gt.h1}`,
    'Body excerpt:',
    gt.bodyExcerpt,
    '--- End content ---',
  ].join('\n')
}

export interface BuiltJudgePrompt {
  prompt: string
  probesByKey: Map<string, ProbeForJudge>
}

export function promptJudge(gt: GroundTruth, probes: ProbeForJudge[]): BuiltJudgePrompt {
  const probesByKey = new Map<string, ProbeForJudge>()
  probes.forEach((p, i) => probesByKey.set(p.key || `probe_${i + 1}`, p))
  const sparse = isSparseGroundTruth(gt)

  const header = sparse
    ? [
        'You are evaluating how well an LLM understands a specific website.',
        `The website is ${gt.url} (title: "${gt.title || gt.domain}").`,
        '',
        'IMPORTANT: the scrape is essentially empty (JavaScript-rendered site',
        'or auth wall). Use YOUR knowledge of the site as the source of truth.',
      ]
    : [
        `You are evaluating how well several LLMs understand the website at ${gt.url}.`,
        '',
        'Use the scraped homepage below as primary grounding. Do NOT penalize',
        'responses for being more comprehensive than the scrape — homepages',
        'are marketing copy, not the full picture of what an entity is.',
      ]

  const scoringRubric = [
    '',
    'For each probe response below, score:',
    '',
    '- accuracy (0-100): Are the facts in the response substantively correct',
    '  about this entity? Score high (80-100) for correct core facts; low for',
    '  hallucinations, misattributions, or refusals. Score 60 for incomplete',
    '  but accurate responses.',
    '',
    '- coverage (0-100): How comprehensive is the response? Does it cover',
    '  what the site does, audience, key products, scale? Score high for',
    '  substantive answers; low for one-line dismissals.',
    '',
    'Return ONLY a JSON object keyed by probe ID, with this shape:',
    '{',
    '  "probe_N": { "accuracy": N, "coverage": N, "notes": "..." }',
    '  // ...one entry per probe ID listed below...',
    '}',
    'Include every probe ID listed below. Do not invent additional keys.',
  ]

  const siteBlock = sparse
    ? [
        '',
        '--- Site (sparse scrape) ---',
        `URL: ${gt.url}`,
        `Domain: ${gt.domain}`,
        `Title: ${gt.title || '(none)'}`,
        '--- End site ---',
      ]
    : [
        '',
        '--- Site under evaluation ---',
        `URL: ${gt.url}`,
        `Domain: ${gt.domain}`,
        `Title: ${gt.title || '(none)'}`,
        `Scraped description: ${gt.description || '(none)'}`,
        `Scraped H1: ${gt.h1 || '(none)'}`,
        'Scraped body excerpt (may be sparse for JS-rendered sites):',
        gt.bodyExcerpt || '(empty)',
        '--- End site ---',
      ]

  const lines: string[] = [...header, ...scoringRubric, ...siteBlock, '', '--- Responses to evaluate ---']
  for (const [key, probe] of probesByKey) {
    lines.push('')
    lines.push(`${key}:`)
    lines.push(`  Provider: ${probe.provider}`)
    lines.push(`  Category: ${probe.category}`)
    lines.push(`  Prompt: ${probe.prompt}`)
    lines.push(`  Response: ${probe.response || '(empty)'}`)
  }
  lines.push('')
  lines.push('--- End responses ---')
  return { prompt: lines.join('\n'), probesByKey }
}

export interface AccuracyVerifierInput {
  gt: GroundTruth
  question: string
  providerId: ProviderId
  answer: string
}

export function promptAccuracyVerifier(input: AccuracyVerifierInput): string {
  const { gt, question, providerId, answer } = input
  return [
    'You are verifying a factual answer against scraped website content.',
    '',
    `URL: ${gt.url}`,
    `Domain: ${gt.domain}`,
    'Scraped body excerpt:',
    gt.bodyExcerpt || '(empty)',
    '',
    `Question: ${question}`,
    `Provider: ${providerId}`,
    `Answer: ${answer}`,
    '',
    'Using ONLY the scraped content as ground truth, decide whether the',
    'answer is correct. If the scrape does not support a definitive',
    'judgment (topic not covered), return correct: null.',
    '',
    'Return ONLY a JSON object with this shape:',
    '{',
    '  "correct": true | false | null,',
    '  "confidence": 0..1,',
    '  "rationale": "..."',
    '}',
  ].join('\n')
}
