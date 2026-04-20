import type { GradeStore } from '../../../store/types.ts'

export async function detectClaudeOrOpenAIOutage(
  gradeId: string,
  store: GradeStore,
): Promise<{ message: string } | null> {
  const hasFailure = await store.hasTerminalProviderFailures(gradeId)
  return hasFailure
    ? { message: 'An LLM provider (Claude or OpenAI) returned a terminal error after fallback retries.' }
    : null
}
