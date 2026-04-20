const MAP: Record<string, string> = {
  'claude-sonnet-4-6': 'Claude Sonnet 4.6',
  'gpt-4.1-mini': 'GPT-4.1 mini',
  'gemini-2.5-flash': 'Gemini 2.5 Flash',
  'sonar': 'Perplexity Sonar',
}

export function friendlyModelName(modelId: string): string {
  return MAP[modelId] ?? modelId
}
