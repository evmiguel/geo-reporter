export { env, loadEnv } from './config/env.ts'
export { db, type Db } from './db/client.ts'
export * as schema from './db/schema.ts'
export * from './store/types.ts'
export { PostgresStore } from './store/postgres.ts'
export { createRedis } from './queue/redis.ts'
export {
  enqueueGrade,
  enqueueReport,
  enqueuePdf,
  getGradeQueue,
  getReportQueue,
  getPdfQueue,
  gradeQueueName,
  reportQueueName,
  pdfQueueName,
  type GradeJob,
  type ReportJob,
  type PdfJob,
} from './queue/queues.ts'
export { scrape, shutdownBrowserPool, FetchError } from './scraper/index.ts'
export type { ScrapeResult, ScrapeOptions, StructuredData } from './scraper/index.ts'
export { evaluateSeo, SIGNAL_WEIGHT } from './seo/index.ts'
export type { SeoResult, SignalResult, SignalName } from './seo/index.ts'

// Plan 4 — providers
export type { Provider, ProviderId, QueryOpts, QueryResult } from './llm/providers/types.ts'
export {
  AnthropicProvider,
  OpenAIProvider,
  GeminiProvider,
  PerplexityProvider,
  MockProvider,
  buildProviders,
  ProviderError,
  classifyStatus,
} from './llm/providers/index.ts'
export type {
  MockProviderOptions,
  MockResponses,
  MockCall,
  ProviderKeys,
  DirectProviders,
  ProviderErrorKind,
} from './llm/providers/index.ts'

// Plan 4 — ground truth + prompts + judge
export { toGroundTruth, isSparseGroundTruth } from './llm/ground-truth.ts'
export type { GroundTruth, ProbeForJudge } from './llm/ground-truth.ts'
export {
  promptRecognition,
  promptCoverage,
  promptCitation,
  promptDiscoverabilityGenerator,
  promptAccuracyGenerator,
  promptJudge,
  promptAccuracyVerifier,
} from './llm/prompts.ts'
export type { BuiltJudgePrompt, AccuracyVerifierInput } from './llm/prompts.ts'
export { runJudge } from './llm/judge.ts'
export type { JudgeResult, ProbeJudgement, RunJudgeInput } from './llm/judge.ts'

// Plan 4 — flows
export { runStaticProbe } from './llm/flows/static-probe.ts'
export type { StaticProbeResult, RunStaticProbeInput } from './llm/flows/static-probe.ts'
export { runSelfGenProbe } from './llm/flows/self-gen.ts'
export type { SelfGenProbeResult, SelfGenStage, RunSelfGenProbeInput } from './llm/flows/self-gen.ts'
export { runCoverageFlow } from './llm/flows/coverage.ts'
export type { CoverageFlowResult, CoverageProbe, RunCoverageFlowInput } from './llm/flows/coverage.ts'

// Plan 4 — pure scoring
export { scoreRecognition } from './scoring/recognition.ts'
export type { RecognitionInput } from './scoring/recognition.ts'
export { scoreCitation } from './scoring/citation.ts'
export type { CitationInput } from './scoring/citation.ts'
export { scoreDiscoverability, brandFromDomain } from './scoring/discoverability.ts'
export type { DiscoverabilityInput } from './scoring/discoverability.ts'
export { toLetterGrade } from './scoring/letter.ts'
export { DEFAULT_WEIGHTS } from './scoring/weights.ts'
export type { CategoryId } from './scoring/weights.ts'
export { weightedOverall } from './scoring/composite.ts'
export type { CategoryScores, OverallScore } from './scoring/composite.ts'

// Plan 4 — accuracy
export {
  runAccuracy,
  generateQuestion,
  verifyAnswer,
} from './accuracy/index.ts'
export type {
  AccuracyResult,
  AccuracyReason,
  GeneratedQuestion,
  VerificationResult,
  ProbeAnswer,
  RunAccuracyInput,
} from './accuracy/index.ts'
