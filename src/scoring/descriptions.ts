import type { CategoryId } from './weights.ts'

export interface CategoryDescription {
  id: CategoryId
  label: string
  weight: number
  short: string
}

export const CATEGORY_DESCRIPTIONS: readonly CategoryDescription[] = [
  {
    id: 'discoverability',
    label: 'Discoverability',
    weight: 30,
    short: 'Can LLMs find you from generic queries in your category? (e.g., "best accounting software" → do they mention you?)',
  },
  {
    id: 'recognition',
    label: 'Recognition',
    weight: 20,
    short: 'Do LLMs correctly associate your brand name with your category? (e.g., "What does Acme Co. do?" → do they answer correctly?)',
  },
  {
    id: 'accuracy',
    label: 'Accuracy',
    weight: 20,
    short: 'When LLMs answer specific questions about you, are the facts right? We analyze your site\'s content, have an LLM write a verifiable question, then ask each target LLM to answer blind — a verifier LLM compares each answer against your site\'s real content.',
  },
  {
    id: 'coverage',
    label: 'Coverage',
    weight: 10,
    short: 'Do LLMs know the depth of your site, not just the homepage? (pricing, docs, product pages — not just the landing page)',
  },
  {
    id: 'citation',
    label: 'Citation',
    weight: 10,
    short: 'Do LLMs cite your domain when summarizing content from your site? (link attribution matters for referral traffic)',
  },
  {
    id: 'seo',
    label: 'SEO',
    weight: 10,
    short: '10 deterministic signals — llms.txt, robots.txt, sitemap, canonical, JSON-LD, OpenGraph, alt text, HTTPS, viewport, meta description.',
  },
]

export const ACCURACY_TIE_IN =
  'Discoverability asks "do LLMs know you exist?" — Accuracy asks "are the facts they tell people about you correct?" Both matter: being discoverable with wrong facts actively hurts you.'

export const ACCURACY_WHY_UNSCORED =
  'Accuracy may show "unscored" if your site has very little text (under 500 characters), if the generator LLM can\'t produce a verifiable question, or if the verifier can\'t reach a clear verdict.'
