import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ReportInput } from './types.ts'
import { Layout } from './components/Layout.tsx'
import { Toc } from './components/Toc.tsx'
import { Cover } from './components/Cover.tsx'
import { Scorecard } from './components/Scorecard.tsx'
import { RawResponses } from './components/RawResponses.tsx'
import { AccuracyAppendix } from './components/AccuracyAppendix.tsx'
import { SeoFindings } from './components/SeoFindings.tsx'
import { Recommendations } from './components/Recommendations.tsx'
import { Methodology } from './components/Methodology.tsx'

const cssPath = resolve(fileURLToPath(new URL('./report.css', import.meta.url)))
const CSS = readFileSync(cssPath, 'utf8')

export interface RenderOptions {
  /** URL to link from the "Download PDF" button. Pass `null` when rendering for PDF output to omit the link. */
  pdfUrl: string | null
}

export function renderReport(input: ReportInput, opts: RenderOptions): string {
  const title = `GEO Report — ${input.grade.domain}`
  const body = (
    <Layout title={title} css={CSS}>
      <Cover
        domain={input.grade.domain}
        letter={input.grade.letter}
        overall={input.grade.overall}
        generatedAt={input.generatedAt}
        pdfUrl={opts.pdfUrl}
      />
      <Toc />
      <Scorecard categories={input.scorecard} />
      <RawResponses groups={input.rawResponsesByProbe} />
      <AccuracyAppendix probes={input.accuracyProbes} />
      <SeoFindings signals={input.seoFindings} />
      <Recommendations cards={input.recommendations} />
      <Methodology
        models={input.models}
        reportId={input.reportId}
        gradeId={input.grade.id}
        generatedAt={input.generatedAt}
      />
    </Layout>
  )
  return '<!DOCTYPE html>' + renderToStaticMarkup(body)
}
