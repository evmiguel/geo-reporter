import { AnthropicProvider } from './anthropic.ts'
import { GeminiProvider } from './gemini.ts'
import { OpenAIProvider } from './openai.ts'
import { PerplexityProvider } from './perplexity.ts'
import type { Provider } from './types.ts'

export interface ProviderKeys {
  ANTHROPIC_API_KEY: string | undefined
  OPENAI_API_KEY: string | undefined
  GEMINI_API_KEY: string | undefined
  PERPLEXITY_API_KEY: string | undefined
}

export interface DirectProviders {
  claude: Provider
  gpt: Provider
  gemini: Provider
  perplexity: Provider
}

function required(name: keyof ProviderKeys, value: string | undefined): string {
  if (!value || value.length === 0) {
    throw new Error(`buildProviders: ${name} is not set`)
  }
  return value
}

export function buildProviders(env: ProviderKeys): DirectProviders {
  return {
    claude: new AnthropicProvider({ apiKey: required('ANTHROPIC_API_KEY', env.ANTHROPIC_API_KEY) }),
    gpt: new OpenAIProvider({ apiKey: required('OPENAI_API_KEY', env.OPENAI_API_KEY) }),
    gemini: new GeminiProvider({ apiKey: required('GEMINI_API_KEY', env.GEMINI_API_KEY) }),
    perplexity: new PerplexityProvider({ apiKey: required('PERPLEXITY_API_KEY', env.PERPLEXITY_API_KEY) }),
  }
}
