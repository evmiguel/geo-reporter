import type { GroundTruth } from './ground-truth.ts'

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
