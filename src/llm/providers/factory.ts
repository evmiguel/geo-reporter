import { AnthropicProvider } from './anthropic.ts'
import { GeminiProvider } from './gemini.ts'
import { OpenAIProvider } from './openai.ts'
import { PerplexityProvider } from './perplexity.ts'
import { OpenRouterProvider } from './openrouter.ts'
import { FallbackProvider } from './fallback.ts'
import type { Provider } from './types.ts'

export interface ProviderKeys {
  ANTHROPIC_API_KEY: string | undefined
  OPENAI_API_KEY: string | undefined
  GEMINI_API_KEY: string | undefined
  PERPLEXITY_API_KEY: string | undefined
  OPENROUTER_API_KEY?: string | undefined
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
  const claude = new AnthropicProvider({ apiKey: required('ANTHROPIC_API_KEY', env.ANTHROPIC_API_KEY) })
  const gpt = new OpenAIProvider({ apiKey: required('OPENAI_API_KEY', env.OPENAI_API_KEY) })
  const gemini = new GeminiProvider({ apiKey: required('GEMINI_API_KEY', env.GEMINI_API_KEY) })
  const perplexity = new PerplexityProvider({ apiKey: required('PERPLEXITY_API_KEY', env.PERPLEXITY_API_KEY) })

  const orKey = env.OPENROUTER_API_KEY
  if (!orKey) {
    return { claude, gpt, gemini, perplexity }
  }

  return {
    claude: new FallbackProvider({
      primary: claude,
      secondary: new OpenRouterProvider({ logicalProvider: 'claude', apiKey: orKey }),
    }),
    gpt: new FallbackProvider({
      primary: gpt,
      secondary: new OpenRouterProvider({ logicalProvider: 'gpt', apiKey: orKey }),
    }),
    gemini: new FallbackProvider({
      primary: gemini,
      secondary: new OpenRouterProvider({ logicalProvider: 'gemini', apiKey: orKey }),
    }),
    perplexity,
  }
}
