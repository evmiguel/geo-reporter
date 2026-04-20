# Plan 11 — User controls + legal pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the URL visibility header on LiveGradePage, a `/account` page with a type-email-to-confirm delete flow, three legal pages (`/privacy`, `/terms`, `/cookies`) rendering Termly HTML, and a shared footer with legal links.

**Architecture:** Delete flow is server-first — schema migration for nullable `stripe_payments.user_id`, new `GradeStore.deleteUser` with transactional cascade + anonymize, `POST /auth/delete-account` endpoint. Frontend layer: `postAuthDeleteAccount` API, `DeleteAccountForm` component with email-match gate, `AccountPage`, `/?deleted=1` toast. Legal pages are static HTML rendered via `dangerouslySetInnerHTML` inside a shared `<LegalPage>` wrapper; copy files are TypeScript string exports so Termly HTML drops in verbatim. Footer mounted once in `App.tsx`.

**Tech Stack:** React 18 + React Router, Drizzle ORM + postgres-js, Hono, Vitest 2. No new runtime deps.

**Spec:** `docs/superpowers/specs/2026-04-20-geo-reporter-plan-11-user-controls-legal-design.md`

---

## Phase A — URL header on LiveGradePage (isolated, quick win)

### Task 1: Show domain + URL header on LiveGradePage

**Files:**
- Modify: `src/web/pages/LiveGradePage.tsx`
- Test: `tests/unit/web/pages/LiveGradePage.url-header.test.tsx` (new)

- [ ] **Step 1: Read current `LiveGradePage.tsx`**

Run: `cat src/web/pages/LiveGradePage.tsx`

Identify where `getGrade(id)` is called (the existing hydrate `useEffect`) and where the "live grade" uppercase label lives (top of the returned JSX).

- [ ] **Step 2: Write the failing test**

Create `tests/unit/web/pages/LiveGradePage.url-header.test.tsx`:

```tsx
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { LiveGradePage } from '../../../../src/web/pages/LiveGradePage.tsx'

vi.mock('../../../../src/web/lib/api.ts', () => ({
  getGrade: vi.fn(async () => ({
    id: 'g1', url: 'https://stripe.com/pricing', domain: 'stripe.com',
    tier: 'free', status: 'done', overall: 80, letter: 'B',
    scores: {}, createdAt: 't', updatedAt: 't',
  })),
}))

vi.mock('../../../../src/web/hooks/useGradeEvents.ts', () => ({
  useGradeEvents: () => ({
    state: {
      phase: 'running', probes: new Map(), categoryScores: {},
      overall: null, letter: null, error: null, paidStatus: 'none',
      reportId: null, reportToken: null, scraped: null,
    },
    dispatch: vi.fn(),
    connected: true,
  }),
}))

vi.mock('../../../../src/web/hooks/useAuth.ts', () => ({
  useAuth: () => ({ verified: false, email: null, credits: 0, refresh: async () => {}, logout: async () => {} }),
}))

describe('LiveGradePage URL header', () => {
  it('shows the domain as title and the full URL as subtitle after hydration', async () => {
    render(
      <MemoryRouter initialEntries={['/g/g1']}>
        <Routes><Route path="/g/:id" element={<LiveGradePage />} /></Routes>
      </MemoryRouter>,
    )
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: 'stripe.com' })).toBeInTheDocument()
      expect(screen.getByText('https://stripe.com/pricing')).toBeInTheDocument()
    })
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test tests/unit/web/pages/LiveGradePage.url-header.test.tsx`
Expected: FAIL — domain not rendered as h1.

- [ ] **Step 4: Add local state for grade meta + render the header**

In `src/web/pages/LiveGradePage.tsx`:

1. At the top of the component (after the existing `const [params, setParams] = useSearchParams()` block), add:

```ts
const [gradeMeta, setGradeMeta] = useState<{ url: string; domain: string } | null>(null)
```

2. Inside the existing hydrate `useEffect` (the one that calls `getGrade(id)`), after `const grade = await getGrade(id)`, add:

```ts
if (grade) setGradeMeta({ url: grade.url, domain: grade.domain })
```

3. Replace the existing `<div className="text-xs tracking-wider text-[var(--color-fg-muted)] uppercase">live grade</div>` line at the top of the main returned JSX with:

```tsx
<div className="mb-6">
  <div className="text-xs tracking-wider text-[var(--color-fg-muted)] uppercase">live grade</div>
  {gradeMeta && (
    <>
      <h1 className="text-2xl text-[var(--color-fg)] mt-1">{gradeMeta.domain}</h1>
      <div className="text-sm text-[var(--color-fg-dim)] mt-1 break-all">{gradeMeta.url}</div>
    </>
  )}
</div>
```

Make sure `useState` is imported (likely already is).

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test tests/unit/web/pages/LiveGradePage.url-header.test.tsx`
Expected: PASS.

- [ ] **Step 6: Run existing LiveGradePage tests + full suite + typecheck**

Run: `pnpm test tests/unit/web/pages/LiveGradePage && pnpm typecheck`
Expected: all PASS — no existing assertions break (the new header is additive).

- [ ] **Step 7: Commit**

```bash
git add src/web/pages/LiveGradePage.tsx tests/unit/web/pages/LiveGradePage.url-header.test.tsx
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(web): show graded domain + URL at top of LiveGradePage"
```

---

## Phase B — Legal pages scaffold

### Task 2: Legal-page wrapper + copy files

**Files:**
- Create: `src/web/pages/legal/LegalPage.tsx`
- Create: `src/web/pages/legal/copy/privacy-copy.ts`
- Create: `src/web/pages/legal/copy/terms-copy.ts`
- Create: `src/web/pages/legal/copy/cookies-copy.ts`

- [ ] **Step 1: Create the `LegalPage` wrapper**

Create `src/web/pages/legal/LegalPage.tsx`:

```tsx
import React from 'react'
import { Link } from 'react-router-dom'

interface Props {
  title: string
  lastUpdated: string
  html: string
}

export function LegalPage({ title, lastUpdated, html }: Props): JSX.Element {
  return (
    <div className="max-w-3xl mx-auto px-4 py-16">
      <Link to="/" className="text-[var(--color-brand)] text-xs">← back to home</Link>
      <h1 className="text-3xl mt-4 mb-1">{title}</h1>
      <div className="text-sm text-[var(--color-fg-muted)] mb-8">Last updated {lastUpdated}</div>
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}
```

- [ ] **Step 2: Create the three copy files as placeholders**

Create `src/web/pages/legal/copy/privacy-copy.ts`:

```ts
// Replace `privacyHtml` with the verbatim Termly HTML when provided.
// Do NOT clean, sanitize, or Markdown-convert — Termly is source of truth.
// Update `privacyLastUpdated` to match the date shown at the top of the Termly copy.
export const privacyLastUpdated = '2026-04-20'

export const privacyHtml = `
<div data-custom-class="body_text">
  <p><strong>Placeholder privacy policy.</strong> Termly-generated copy lands here at deploy time.
  Until then, users see this notice instead of broken HTML.</p>
  <p>Questions? Contact <a href="mailto:erika@erikamiguel.com">erika@erikamiguel.com</a>.</p>
</div>
`
```

Create `src/web/pages/legal/copy/terms-copy.ts`:

```ts
export const termsLastUpdated = '2026-04-20'

export const termsHtml = `
<div data-custom-class="body_text">
  <p><strong>Placeholder terms of use.</strong> Termly-generated copy lands here at deploy time.</p>
</div>
`
```

Create `src/web/pages/legal/copy/cookies-copy.ts`:

```ts
export const cookiesLastUpdated = '2026-04-20'

export const cookiesHtml = `
<div data-custom-class="body_text">
  <p><strong>Placeholder cookie policy.</strong> Termly-generated copy lands here at deploy time.</p>
</div>
`
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/web/pages/legal/LegalPage.tsx src/web/pages/legal/copy/
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(web): LegalPage wrapper + placeholder copy for privacy/terms/cookies"
```

---

### Task 3: Privacy, Terms, Cookies pages + route wiring

**Files:**
- Create: `src/web/pages/legal/PrivacyPage.tsx`
- Create: `src/web/pages/legal/TermsPage.tsx`
- Create: `src/web/pages/legal/CookiesPage.tsx`
- Modify: `src/web/App.tsx`
- Test: `tests/unit/web/pages/legal/legal-pages.test.tsx` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/web/pages/legal/legal-pages.test.tsx`:

```tsx
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { PrivacyPage } from '../../../../../src/web/pages/legal/PrivacyPage.tsx'
import { TermsPage } from '../../../../../src/web/pages/legal/TermsPage.tsx'
import { CookiesPage } from '../../../../../src/web/pages/legal/CookiesPage.tsx'

describe('Legal pages', () => {
  it('PrivacyPage renders its copy under an h1 "Privacy Policy"', () => {
    render(
      <MemoryRouter><Routes><Route path="/" element={<PrivacyPage />} /></Routes></MemoryRouter>,
    )
    expect(screen.getByRole('heading', { level: 1, name: /privacy policy/i })).toBeInTheDocument()
    expect(screen.getByText(/last updated/i)).toBeInTheDocument()
  })

  it('TermsPage renders its copy under an h1 "Terms of Use"', () => {
    render(
      <MemoryRouter><Routes><Route path="/" element={<TermsPage />} /></Routes></MemoryRouter>,
    )
    expect(screen.getByRole('heading', { level: 1, name: /terms of use/i })).toBeInTheDocument()
  })

  it('CookiesPage renders its copy under an h1 "Cookie Policy"', () => {
    render(
      <MemoryRouter><Routes><Route path="/" element={<CookiesPage />} /></Routes></MemoryRouter>,
    )
    expect(screen.getByRole('heading', { level: 1, name: /cookie policy/i })).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/web/pages/legal/legal-pages.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Create `PrivacyPage.tsx`**

Create `src/web/pages/legal/PrivacyPage.tsx`:

```tsx
import React from 'react'
import { LegalPage } from './LegalPage.tsx'
import { privacyHtml, privacyLastUpdated } from './copy/privacy-copy.ts'

export function PrivacyPage(): JSX.Element {
  return <LegalPage title="Privacy Policy" lastUpdated={privacyLastUpdated} html={privacyHtml} />
}
```

- [ ] **Step 4: Create `TermsPage.tsx`**

Create `src/web/pages/legal/TermsPage.tsx`:

```tsx
import React from 'react'
import { LegalPage } from './LegalPage.tsx'
import { termsHtml, termsLastUpdated } from './copy/terms-copy.ts'

export function TermsPage(): JSX.Element {
  return <LegalPage title="Terms of Use" lastUpdated={termsLastUpdated} html={termsHtml} />
}
```

- [ ] **Step 5: Create `CookiesPage.tsx`**

Create `src/web/pages/legal/CookiesPage.tsx`:

```tsx
import React from 'react'
import { LegalPage } from './LegalPage.tsx'
import { cookiesHtml, cookiesLastUpdated } from './copy/cookies-copy.ts'

export function CookiesPage(): JSX.Element {
  return <LegalPage title="Cookie Policy" lastUpdated={cookiesLastUpdated} html={cookiesHtml} />
}
```

- [ ] **Step 6: Register the three routes in `App.tsx`**

Open `src/web/App.tsx`. Add imports:

```tsx
import { PrivacyPage } from './pages/legal/PrivacyPage.tsx'
import { TermsPage } from './pages/legal/TermsPage.tsx'
import { CookiesPage } from './pages/legal/CookiesPage.tsx'
```

Add the routes inside the existing `<Routes>` block (before the `*` catchall):

```tsx
<Route path="/privacy" element={<PrivacyPage />} />
<Route path="/terms" element={<TermsPage />} />
<Route path="/cookies" element={<CookiesPage />} />
```

- [ ] **Step 7: Run tests + typecheck**

Run: `pnpm test tests/unit/web/pages/legal && pnpm typecheck`
Expected: 3 tests pass, typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add src/web/pages/legal/ src/web/App.tsx tests/unit/web/pages/legal/
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(web): /privacy, /terms, /cookies routes rendering Termly HTML"
```

---

### Task 4: Global footer with legal links

**Files:**
- Create: `src/web/components/Footer.tsx`
- Modify: `src/web/App.tsx`
- Test: `tests/unit/web/components/Footer.test.tsx` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/web/components/Footer.test.tsx`:

```tsx
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Footer } from '../../../../src/web/components/Footer.tsx'

describe('Footer', () => {
  it('renders Privacy / Terms / Cookies links with correct hrefs', () => {
    render(<MemoryRouter><Footer /></MemoryRouter>)
    const privacy = screen.getByRole('link', { name: /privacy/i })
    const terms = screen.getByRole('link', { name: /terms/i })
    const cookies = screen.getByRole('link', { name: /cookies/i })
    expect(privacy).toHaveAttribute('href', '/privacy')
    expect(terms).toHaveAttribute('href', '/terms')
    expect(cookies).toHaveAttribute('href', '/cookies')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/web/components/Footer.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `Footer.tsx`**

Create `src/web/components/Footer.tsx`:

```tsx
import React from 'react'
import { Link } from 'react-router-dom'

export function Footer(): JSX.Element {
  return (
    <footer className="max-w-2xl mx-auto px-4 py-8 mt-16 text-xs text-[var(--color-fg-muted)] flex gap-4 justify-end">
      <Link to="/privacy">Privacy</Link>
      <Link to="/terms">Terms</Link>
      <Link to="/cookies">Cookies</Link>
    </footer>
  )
}
```

- [ ] **Step 4: Mount the footer in `App.tsx`**

Open `src/web/App.tsx`. Import:

```tsx
import { Footer } from './components/Footer.tsx'
```

Change the outer layout so the footer renders below `<main>`:

```tsx
return (
  <div className="min-h-full flex flex-col bg-[var(--color-bg)] text-[var(--color-fg)]">
    <Header />
    <main className="flex-1">
      <Routes>
        {/* ... existing routes ... */}
      </Routes>
    </main>
    <Footer />
  </div>
)
```

- [ ] **Step 5: Run test**

Run: `pnpm test tests/unit/web/components/Footer.test.tsx`
Expected: PASS.

- [ ] **Step 6: Typecheck + full suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/web/components/Footer.tsx src/web/App.tsx tests/unit/web/components/Footer.test.tsx
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(web): site footer with Privacy / Terms / Cookies links"
```

---

### Task 5: Privacy link in the report Methodology section

**Files:**
- Modify: `src/report/components/Methodology.tsx`
- Test: `tests/unit/report/components/methodology.test.tsx` (modify existing)

- [ ] **Step 1: Read current `Methodology.tsx`**

Run: `cat src/report/components/Methodology.tsx`

Find the "Report metadata" section at the bottom — that's where we add the privacy link.

- [ ] **Step 2: Write the failing test**

Open `tests/unit/report/components/methodology.test.tsx` and add a new `it(...)` block inside the existing `describe` (or append to whichever describe the tests for this component live in):

```tsx
it('includes an absolute-URL link to the privacy policy', () => {
  const html = renderToStaticMarkup(
    <Methodology
      models={[{ providerId: 'claude', modelId: 'claude-sonnet-4-6' }]}
      reportId="abc" gradeId="def"
      generatedAt={new Date('2026-04-20T12:00:00Z')}
    />,
  )
  expect(html).toContain('https://geo.erikamiguel.com/privacy')
  expect(html).toMatch(/privacy policy/i)
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test tests/unit/report/components/methodology.test.tsx`
Expected: FAIL — the URL isn't in the component.

- [ ] **Step 4: Add the privacy link to Methodology**

Open `src/report/components/Methodology.tsx`. In the "Report metadata" section (near the bottom), add a new paragraph after the existing timestamp:

```tsx
<p className="small muted" style={{ marginTop: 8 }}>
  <a href="https://geo.erikamiguel.com/privacy" className="small muted">View privacy policy</a>
</p>
```

- [ ] **Step 5: Run the test + full suite**

Run: `pnpm test tests/unit/report/components/methodology.test.tsx && pnpm test`
Expected: PASS. Snapshot in `tests/unit/report/__snapshots__/render.test.ts.snap` will change because the Methodology section gained a line; update with `pnpm test tests/unit/report -- -u` if needed, then re-run without `-u` to confirm the only diff is the new link.

- [ ] **Step 6: Commit**

```bash
git add src/report/components/Methodology.tsx tests/unit/report/
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(report): link to privacy policy from report Methodology"
```

---

## Phase C — Backend delete flow

### Task 6: Schema migration — make `stripe_payments.user_id` nullable

**Files:**
- Modify: `src/db/schema.ts`
- Generated: `src/db/migrations/<auto>.sql`
- Test: `tests/unit/db/schema-stripe-payments-userid-nullable.test.ts` (new)

- [ ] **Step 1: Read current schema for stripe_payments**

Run: `grep -A 15 "stripePayments = pgTable" src/db/schema.ts`

Find the `userId` column. It's currently `.notNull()` (or equivalent).

- [ ] **Step 2: Write the failing test**

Create `tests/unit/db/schema-stripe-payments-userid-nullable.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { getTableColumns } from 'drizzle-orm'
import * as schema from '../../../src/db/schema.ts'

describe('stripe_payments.user_id nullability', () => {
  it('is nullable (required for account deletion anonymization)', () => {
    const cols = getTableColumns(schema.stripePayments)
    // Drizzle exposes column notNull as a property; spot-check it's false.
    expect((cols.userId as { notNull: boolean }).notNull).toBe(false)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test tests/unit/db/schema-stripe-payments-userid-nullable.test.ts`
Expected: FAIL — userId is currently NOT NULL.

- [ ] **Step 4: Modify the schema**

In `src/db/schema.ts`, find the `userId` column in the `stripePayments` table. Remove `.notNull()`. If the column definition looks like:

```ts
userId: uuid('user_id').references(() => users.id).notNull(),
```

change to:

```ts
userId: uuid('user_id').references(() => users.id),
```

- [ ] **Step 5: Generate the migration**

Run: `pnpm db:generate`
Expected: new migration file under `src/db/migrations/` containing `ALTER TABLE "stripe_payments" ALTER COLUMN "user_id" DROP NOT NULL`.

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm test tests/unit/db/schema-stripe-payments-userid-nullable.test.ts`
Expected: PASS.

- [ ] **Step 7: Full suite + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/db/schema.ts src/db/migrations/ tests/unit/db/schema-stripe-payments-userid-nullable.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(db): allow stripe_payments.user_id to be NULL (for account deletion)"
```

---

### Task 7: `GradeStore.deleteUser`

**Files:**
- Modify: `src/store/types.ts`
- Modify: `src/store/postgres.ts`
- Modify: `tests/unit/_helpers/fake-store.ts`
- Test: `tests/integration/store-delete-user.test.ts` (new)

- [ ] **Step 1: Add method to the interface**

In `src/store/types.ts`, add to `GradeStore`:

```ts
  deleteUser(userId: string, expectedEmail: string): Promise<void>
```

- [ ] **Step 2: Write the failing integration test**

Create `tests/integration/store-delete-user.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgresStore } from '../../src/store/postgres.ts'
import { startTestDb, type TestDb } from './setup.ts'

describe('PostgresStore.deleteUser', () => {
  let testDb: TestDb
  let store: PostgresStore

  beforeAll(async () => {
    testDb = await startTestDb()
    store = new PostgresStore(testDb.db)
  }, 120_000)
  afterAll(async () => { await testDb.stop() })

  it('cascades grade delete + anonymizes stripe_payments + keeps cookies unbound', async () => {
    const user = await store.upsertUser('delete-me@example.com')
    const cookie = 'cookie-abc'
    await store.upsertCookie(cookie, user.id)
    const grade = await store.createGrade({
      url: 'https://x', domain: 'x', tier: 'free', cookie, userId: user.id, status: 'done',
    })
    await store.createScrape({ gradeId: grade.id, rendered: false, html: '<html/>', text: 't', structured: {} as never })
    await store.createProbe({ gradeId: grade.id, category: 'seo', provider: null, prompt: 'p', response: 'r', score: 100, metadata: {} })
    await store.createStripePayment({
      gradeId: grade.id, sessionId: 'cs_abc', amountCents: 1900, currency: 'usd',
    })
    await store.updateStripePaymentStatus('cs_abc', { status: 'paid' })
    // issue a magic token so we can verify deletion
    await store.issueMagicToken('delete-me@example.com', cookie)

    await store.deleteUser(user.id, 'delete-me@example.com')

    // Grade + cascades gone
    const probes = await store.listProbes(grade.id)
    expect(probes).toEqual([])
    // Cookie exists but unbound
    const row = await store.getCookieWithUserAndCredits(cookie)
    expect(row.userId).toBeNull()
    // Stripe payment anonymized
    const pay = await store.getStripePaymentBySessionId('cs_abc')
    expect(pay).not.toBeNull()
    expect(pay!.userId).toBeNull()
    expect(pay!.gradeId).toBeNull()
  })

  it('throws when expectedEmail does not match the user row', async () => {
    const user = await store.upsertUser('correct@example.com')
    await expect(store.deleteUser(user.id, 'wrong@example.com')).rejects.toThrow()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test:integration tests/integration/store-delete-user.test.ts`
Expected: FAIL — method not implemented.

- [ ] **Step 4: Implement `deleteUser` in `PostgresStore`**

In `src/store/postgres.ts`, add:

```ts
async deleteUser(userId: string, expectedEmail: string): Promise<void> {
  await this.db.transaction(async (tx) => {
    const [user] = await tx.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1)
    if (!user || user.email.toLowerCase() !== expectedEmail.toLowerCase()) {
      throw new Error('deleteUser: user not found or email mismatch')
    }

    // Grades cascade to scrapes, probes, recommendations, reports, report_pdfs via FK ON DELETE CASCADE.
    await tx.delete(schema.grades).where(eq(schema.grades.userId, userId))

    // Unbind every cookie tied to this user (cookies row itself is preserved — other tenants could be using it).
    await tx.update(schema.cookies).set({ userId: null }).where(eq(schema.cookies.userId, userId))

    // Purge pending magic-link tokens for this email.
    await tx.delete(schema.magicTokens).where(eq(schema.magicTokens.email, user.email))

    // Anonymize stripe_payments — keep row for tax retention, detach PII.
    await tx.update(schema.stripePayments)
      .set({ userId: null, gradeId: null })
      .where(eq(schema.stripePayments.userId, userId))

    // Finally, the user row itself.
    await tx.delete(schema.users).where(eq(schema.users.id, userId))
  })
}
```

- [ ] **Step 5: Add to fake-store**

In `tests/unit/_helpers/fake-store.ts`, find the `GradeStore` interface implementation. Add a minimal implementation that mirrors the Postgres semantics against in-memory maps:

```ts
async deleteUser(userId: string, expectedEmail: string): Promise<void> {
  const user = [...this.usersMap.values()].find((u) => u.id === userId)
  if (!user || user.email.toLowerCase() !== expectedEmail.toLowerCase()) {
    throw new Error('deleteUser: user not found or email mismatch')
  }
  // Collect grade ids for this user
  const userGradeIds = [...this.gradesMap.values()].filter((g) => g.userId === userId).map((g) => g.id)
  for (const gid of userGradeIds) {
    this.gradesMap.delete(gid)
    this.scrapesMap.delete(gid)
    // probes are keyed differently; filter out
  }
  this.probesMap = new Map([...this.probesMap].filter(([, p]) => !userGradeIds.includes(p.gradeId)))
  this.recommendationsMap = new Map([...this.recommendationsMap].filter(([, r]) => !userGradeIds.includes(r.gradeId)))
  // Unbind cookies
  for (const [k, c] of this.cookiesMap) {
    if (c.userId === userId) this.cookiesMap.set(k, { ...c, userId: null })
  }
  // Purge magic tokens by email
  this.magicTokensMap = new Map([...this.magicTokensMap].filter(([, t]) => t.email !== user.email))
  // Anonymize stripe_payments
  for (const [k, p] of this.stripePaymentsMap) {
    if (p.userId === userId) this.stripePaymentsMap.set(k, { ...p, userId: null, gradeId: null })
  }
  // Delete user
  this.usersMap.delete(user.email)
}
```

Adapt the map names (`usersMap`, `gradesMap`, etc.) to whatever the fake actually uses — read the file first. If some maps don't exist (e.g. no `magicTokensMap`), skip those lines.

- [ ] **Step 6: Run integration test**

Run: `pnpm test:integration tests/integration/store-delete-user.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Run unit suite + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/store/types.ts src/store/postgres.ts tests/unit/_helpers/fake-store.ts tests/integration/store-delete-user.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(store): GradeStore.deleteUser with transactional cascade + anonymize"
```

---

### Task 8: `POST /auth/delete-account` endpoint

**Files:**
- Modify: `src/server/routes/auth.ts`
- Test: `tests/unit/server/routes/auth-delete-account.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/server/routes/auth-delete-account.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { authRouter } from '../../../../src/server/routes/auth.ts'
import { cookieMiddleware, COOKIE_NAME } from '../../../../src/server/middleware/cookie.ts'
import { clientIp } from '../../../../src/server/middleware/client-ip.ts'
import { makeFakeStore } from '../../_helpers/fake-store.ts'
import { FakeMailer } from '../../_helpers/fake-mailer.ts'

const HMAC_KEY = 'test-key-exactly-32-chars-long-aa'

type AppType = Hono<{ Variables: { cookie: string; clientIp: string } }>

function build() {
  const store = makeFakeStore()
  const mailer = new FakeMailer()
  const redis = {} as never  // not used by delete-account
  const app: AppType = new Hono<{ Variables: { cookie: string; clientIp: string } }>()
  app.use('*', clientIp({ trustedProxies: [], isProduction: false }), cookieMiddleware(store, false, HMAC_KEY))
  app.route('/auth', authRouter({ store, redis, mailer, publicBaseUrl: 'http://localhost', nodeEnv: 'test' }))
  return { app, store }
}

async function issueCookie(app: AppType): Promise<string> {
  const res = await app.fetch(new Request('http://test/auth/me'))
  const raw = (res.headers.get('set-cookie') ?? '').split(`${COOKIE_NAME}=`)[1]?.split(';')[0]
  if (!raw) throw new Error('no cookie issued')
  return raw
}

describe('POST /auth/delete-account', () => {
  it('401 when cookie is not bound to a user', async () => {
    const { app } = build()
    const cookie = await issueCookie(app)
    const res = await app.fetch(new Request('http://test/auth/delete-account', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${cookie}` },
      body: JSON.stringify({ email: 'anyone@example.com' }),
    }))
    expect(res.status).toBe(401)
  })

  it('400 email_mismatch when typed email does not match logged-in user', async () => {
    const { app, store } = build()
    const cookie = await issueCookie(app)
    const uuid = cookie.split('.')[0]!
    const user = await store.upsertUser('real@example.com')
    await store.upsertCookie(uuid, user.id)
    const res = await app.fetch(new Request('http://test/auth/delete-account', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${cookie}` },
      body: JSON.stringify({ email: 'someone-else@example.com' }),
    }))
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('email_mismatch')
  })

  it('204 happy path; clears cookie and deletes user', async () => {
    const { app, store } = build()
    const cookie = await issueCookie(app)
    const uuid = cookie.split('.')[0]!
    const user = await store.upsertUser('gone@example.com')
    await store.upsertCookie(uuid, user.id)
    const res = await app.fetch(new Request('http://test/auth/delete-account', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${cookie}` },
      body: JSON.stringify({ email: 'gone@example.com' }),
    }))
    expect(res.status).toBe(204)
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toMatch(new RegExp(`${COOKIE_NAME}=;`))
    expect(setCookie).toMatch(/Max-Age=0/)
  })

  it('400 on malformed body (missing email)', async () => {
    const { app, store } = build()
    const cookie = await issueCookie(app)
    const uuid = cookie.split('.')[0]!
    const user = await store.upsertUser('u@example.com')
    await store.upsertCookie(uuid, user.id)
    const res = await app.fetch(new Request('http://test/auth/delete-account', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${cookie}` },
      body: JSON.stringify({}),
    }))
    expect(res.status).toBe(400)
  })

  it('email comparison is case-insensitive', async () => {
    const { app, store } = build()
    const cookie = await issueCookie(app)
    const uuid = cookie.split('.')[0]!
    const user = await store.upsertUser('case@example.com')
    await store.upsertCookie(uuid, user.id)
    const res = await app.fetch(new Request('http://test/auth/delete-account', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${cookie}` },
      body: JSON.stringify({ email: 'CASE@EXAMPLE.COM' }),
    }))
    expect(res.status).toBe(204)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/server/routes/auth-delete-account.test.ts`
Expected: FAIL — route not registered.

- [ ] **Step 3: Implement the handler**

In `src/server/routes/auth.ts`:

1. Add import at top:

```ts
import { setCookie } from 'hono/cookie'
import { COOKIE_NAME } from '../middleware/cookie.ts'
```

2. Add schema near the other `z.object` definitions:

```ts
const deleteAccountSchema = z.object({
  email: z.string().trim().toLowerCase(),
})
```

3. Add handler inside the `authRouter` function, alongside the existing `app.post('/magic', ...)` etc.:

```ts
app.post(
  '/delete-account',
  zValidator('json', deleteAccountSchema, (result, c) => {
    if (!result.success) return c.json({ error: 'invalid_body' }, 400)
  }),
  async (c) => {
    const { email } = c.req.valid('json')
    const row = await deps.store.getCookieWithUserAndCredits(c.var.cookie)
    if (row.userId === null || row.email === null) {
      return c.json({ error: 'not_authenticated' }, 401)
    }
    if (row.email.toLowerCase() !== email) {
      return c.json({ error: 'email_mismatch' }, 400)
    }

    await deps.store.deleteUser(row.userId, email)

    // Clear cookie
    setCookie(c, COOKIE_NAME, '', {
      httpOnly: true, sameSite: 'Lax', secure: false, path: '/', maxAge: 0,
    })
    return c.body(null, 204)
  },
)
```

Note: `secure: false` because `AuthRouterDeps` doesn't currently have `isProduction`. If you see that it does, pass it through. Otherwise this matches the existing logout handler's cookie-clearing behavior in test mode.

- [ ] **Step 4: Run tests**

Run: `pnpm test tests/unit/server/routes/auth-delete-account.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Run full unit suite + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/auth.ts tests/unit/server/routes/auth-delete-account.test.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(auth): POST /auth/delete-account with type-email-to-confirm"
```

---

## Phase D — Frontend delete + account page

### Task 9: `postAuthDeleteAccount` API wrapper

**Files:**
- Modify: `src/web/lib/api.ts`
- Test: Covered by Task 10's DeleteAccountForm test (API stubbed there)

- [ ] **Step 1: Add the API wrapper**

Open `src/web/lib/api.ts`. Add near the other `postAuth*` functions:

```ts
export type DeleteAccountResult =
  | { ok: true }
  | { ok: false; kind: 'email_mismatch' | 'not_authenticated' | 'unknown'; status?: number }

export async function postAuthDeleteAccount(email: string): Promise<DeleteAccountResult> {
  let res: Response
  try {
    res = await fetch('/auth/delete-account', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    })
  } catch {
    return { ok: false, kind: 'unknown', status: 0 }
  }

  if (res.status === 204) return { ok: true }
  if (res.status === 401) return { ok: false, kind: 'not_authenticated' }
  if (res.status === 400) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    if (body.error === 'email_mismatch') return { ok: false, kind: 'email_mismatch' }
  }
  return { ok: false, kind: 'unknown', status: res.status }
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/web/lib/api.ts
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(web): postAuthDeleteAccount API wrapper"
```

---

### Task 10: `DeleteAccountForm` component

**Files:**
- Create: `src/web/components/DeleteAccountForm.tsx`
- Test: `tests/unit/web/components/DeleteAccountForm.test.tsx` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/web/components/DeleteAccountForm.test.tsx`:

```tsx
import React from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { DeleteAccountForm } from '../../../../src/web/components/DeleteAccountForm.tsx'
import * as api from '../../../../src/web/lib/api.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('DeleteAccountForm', () => {
  it('button is disabled until typed email matches exactly', async () => {
    render(<MemoryRouter><DeleteAccountForm email="u@example.com" /></MemoryRouter>)
    const btn = screen.getByRole('button', { name: /delete permanently/i })
    expect(btn).toBeDisabled()

    const input = screen.getByPlaceholderText(/type u@example\.com/i)
    const user = userEvent.setup()
    await user.type(input, 'u@example.co')   // one char short
    expect(btn).toBeDisabled()

    await user.type(input, 'm')
    expect(btn).not.toBeDisabled()
  })

  it('submit calls postAuthDeleteAccount with the typed email', async () => {
    const spy = vi.spyOn(api, 'postAuthDeleteAccount').mockResolvedValue({ ok: true })
    render(<MemoryRouter><DeleteAccountForm email="u@example.com" /></MemoryRouter>)
    const user = userEvent.setup()
    await user.type(screen.getByPlaceholderText(/type u@example\.com/i), 'u@example.com')
    await user.click(screen.getByRole('button', { name: /delete permanently/i }))
    expect(spy).toHaveBeenCalledWith('u@example.com')
  })

  it('shows email_mismatch error from server', async () => {
    vi.spyOn(api, 'postAuthDeleteAccount').mockResolvedValue({ ok: false, kind: 'email_mismatch' })
    render(<MemoryRouter><DeleteAccountForm email="u@example.com" /></MemoryRouter>)
    const user = userEvent.setup()
    await user.type(screen.getByPlaceholderText(/type u@example\.com/i), 'u@example.com')
    await user.click(screen.getByRole('button', { name: /delete permanently/i }))
    expect(await screen.findByText(/doesn't match/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/web/components/DeleteAccountForm.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

Create `src/web/components/DeleteAccountForm.tsx`:

```tsx
import React, { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { postAuthDeleteAccount } from '../lib/api.ts'

interface Props { email: string }

export function DeleteAccountForm({ email }: Props): JSX.Element {
  const [typed, setTyped] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()
  const matches = typed.trim().toLowerCase() === email.toLowerCase()

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault()
    if (!matches) return
    setPending(true); setError(null)
    const result = await postAuthDeleteAccount(typed.trim())
    setPending(false)
    if (result.ok) { navigate('/?deleted=1'); return }
    if (result.kind === 'email_mismatch') { setError("Email doesn't match your account."); return }
    if (result.kind === 'not_authenticated') { setError('You were signed out. Please sign in again.'); return }
    setError('Something went wrong. Try again?')
  }

  return (
    <>
      <p className="text-sm text-[var(--color-fg-dim)] my-4">
        This erases every grade, report, and your email binding. Payment receipts are kept for
        tax/accounting but detached from your identity. This cannot be undone.
      </p>
      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="email"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={`Type ${email}`}
          className="flex-1 bg-[var(--color-bg-elevated)] border border-[var(--color-line)] px-3 py-2 text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:border-[var(--color-brand)]"
          disabled={pending}
        />
        <button
          type="submit"
          disabled={!matches || pending}
          className="bg-[var(--color-warn)] text-[var(--color-bg)] px-4 py-2 font-semibold disabled:opacity-50"
        >
          {pending ? '...' : 'Delete permanently'}
        </button>
      </form>
      {error !== null && <div className="text-xs text-[var(--color-brand)] mt-2">{error}</div>}
    </>
  )
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test tests/unit/web/components/DeleteAccountForm.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/web/components/DeleteAccountForm.tsx tests/unit/web/components/DeleteAccountForm.test.tsx
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(web): DeleteAccountForm with type-email-to-confirm"
```

---

### Task 11: `AccountPage` + route wiring

**Files:**
- Create: `src/web/pages/AccountPage.tsx`
- Modify: `src/web/App.tsx`
- Test: `tests/unit/web/pages/AccountPage.test.tsx` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/web/pages/AccountPage.test.tsx`:

```tsx
import React from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const useAuthMock = vi.fn(() => ({
  verified: false, email: null as string | null, credits: 0,
  refresh: async () => {}, logout: async () => {},
}))
vi.mock('../../../../src/web/hooks/useAuth.ts', () => ({
  useAuth: () => useAuthMock(),
}))

import { AccountPage } from '../../../../src/web/pages/AccountPage.tsx'

describe('AccountPage', () => {
  it('renders email + credits when verified', () => {
    useAuthMock.mockReturnValue({
      verified: true, email: 'u@example.com', credits: 7,
      refresh: async () => {}, logout: async () => {},
    })
    render(
      <MemoryRouter initialEntries={['/account']}>
        <Routes><Route path="/account" element={<AccountPage />} /></Routes>
      </MemoryRouter>,
    )
    expect(screen.getByText('u@example.com')).toBeInTheDocument()
    expect(screen.getByText(/7 remaining/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /delete account/i })).toBeInTheDocument()
  })

  it('shows "buy 10 for $29" link when credits === 0', () => {
    useAuthMock.mockReturnValue({
      verified: true, email: 'u@example.com', credits: 0,
      refresh: async () => {}, logout: async () => {},
    })
    render(
      <MemoryRouter initialEntries={['/account']}>
        <Routes><Route path="/account" element={<AccountPage />} /></Routes>
      </MemoryRouter>,
    )
    expect(screen.getByRole('link', { name: /buy 10 for \$29/i })).toBeInTheDocument()
  })

  it('redirects to /email?next=/account when not verified', () => {
    useAuthMock.mockReturnValue({
      verified: false, email: null, credits: 0,
      refresh: async () => {}, logout: async () => {},
    })
    render(
      <MemoryRouter initialEntries={['/account']}>
        <Routes>
          <Route path="/account" element={<AccountPage />} />
          <Route path="/email" element={<div>email gate</div>} />
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getByText(/email gate/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/web/pages/AccountPage.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `AccountPage`**

Create `src/web/pages/AccountPage.tsx`:

```tsx
import React, { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth.ts'
import { DeleteAccountForm } from '../components/DeleteAccountForm.tsx'

export function AccountPage(): JSX.Element {
  const { verified, email, credits, logout } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (!verified) navigate('/email?next=/account', { replace: true })
  }, [verified, navigate])

  if (!verified || !email) return <div />

  return (
    <div className="max-w-xl mx-auto px-4 py-16">
      <h1 className="text-2xl mb-6">Account</h1>

      <section className="mb-8">
        <div className="text-xs uppercase tracking-wider text-[var(--color-fg-muted)]">email</div>
        <div className="text-lg">{email}</div>
      </section>

      <section className="mb-8">
        <div className="text-xs uppercase tracking-wider text-[var(--color-fg-muted)]">credits</div>
        <div className="text-lg">
          {credits > 0 ? (
            <>{credits} remaining</>
          ) : (
            <>None — <a href="/billing/buy-credits" className="text-[var(--color-brand)] underline">buy 10 for $29</a></>
          )}
        </div>
      </section>

      <section className="mb-8">
        <button onClick={() => void logout()} className="text-sm underline">Sign out</button>
      </section>

      <section className="border-t border-[var(--color-line)] pt-8">
        <h2 className="text-lg text-[var(--color-warn)]">Delete account</h2>
        <DeleteAccountForm email={email} />
      </section>
    </div>
  )
}
```

- [ ] **Step 4: Register the `/account` route in `App.tsx`**

Open `src/web/App.tsx`. Import:

```tsx
import { AccountPage } from './pages/AccountPage.tsx'
```

Add the route inside `<Routes>` before the catchall:

```tsx
<Route path="/account" element={<AccountPage />} />
```

- [ ] **Step 5: Run tests**

Run: `pnpm test tests/unit/web/pages/AccountPage.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 6: Full suite + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/web/pages/AccountPage.tsx src/web/App.tsx tests/unit/web/pages/AccountPage.test.tsx
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(web): /account page with email, credits, sign out, delete"
```

---

### Task 12: `?deleted=1` toast on LandingPage

**Files:**
- Modify: `src/web/pages/LandingPage.tsx`
- Modify: existing LandingPage test (or add new test)

- [ ] **Step 1: Read current LandingPage + its test**

Run: `cat src/web/pages/LandingPage.tsx | head -40`

The existing page already handles `?verified=1` and `?credits=purchased/canceled` toasts via the same `useSearchParams` pattern. We'll extend it for `?deleted=1`.

- [ ] **Step 2: Write the failing test**

Add to `tests/unit/web/pages/LandingPage.test.tsx` inside the `describe('LandingPage — credits URL params', ...)` block (or create a new describe):

```tsx
it('renders deletion toast when ?deleted=1 is present', async () => {
  render(
    <MemoryRouter initialEntries={['/?deleted=1']}>
      <LandingPage />
    </MemoryRouter>,
  )
  expect(await screen.findByText(/account deleted/i)).toBeInTheDocument()
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test tests/unit/web/pages/LandingPage.test.tsx`
Expected: FAIL — no such toast.

- [ ] **Step 4: Add the toast logic**

Open `src/web/pages/LandingPage.tsx`. Find the existing toast-param-reading useState + useEffect block. Extend both:

1. Add a new state:

```ts
const [deletedToast, setDeletedToast] = useState<boolean>(params.get('deleted') === '1')
```

2. In the cleanup useEffect, add `'deleted'` to the list of params to strip:

```ts
const hasAny = ['verified', 'auth_error', 'credits', 'deleted'].some((k) => params.get(k) !== null)
// ... and inside the if block:
next.delete('deleted')
```

3. Also: if `deleted=1`, we want to clear any cached auth. Add to the same useEffect after the existing `if (params.get('credits') === 'purchased') void refresh()` line:

```ts
if (params.get('deleted') === '1') void refresh()
```

4. Render the toast alongside the existing toasts. Near the bottom of the returned JSX:

```tsx
{deletedToast && (
  <Toast
    message="Account deleted."
    onDismiss={() => setDeletedToast(false)}
  />
)}
```

- [ ] **Step 5: Run test**

Run: `pnpm test tests/unit/web/pages/LandingPage.test.tsx`
Expected: PASS.

- [ ] **Step 6: Full suite + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/web/pages/LandingPage.tsx tests/unit/web/pages/LandingPage.test.tsx
git -c user.email='erika@erikamiguel.com' -c user.name='Erika Miguel' commit -m "feat(web): ?deleted=1 toast on landing after account deletion"
```

---

## Self-review checklist (controller runs this)

**1. Spec coverage:**
- §4.1 URL header on LiveGradePage → Task 1 ✓
- §4.2 AccountPage → Task 11 ✓
- §4.3 DeleteAccountForm → Task 10 ✓
- §4.4 Legal pages scaffold + copy → Tasks 2, 3 ✓
- §4.5 Footer → Task 4 ✓
- §4.6 Methodology privacy link → Task 5 ✓
- §5.1 POST /auth/delete-account → Task 8 ✓
- §5.2 GradeStore.deleteUser → Task 7 ✓
- §5.3 Schema migration nullable user_id → Task 6 ✓
- P11-8 ?deleted=1 toast on landing → Task 12 ✓

**2. Placeholder scan:** All steps have complete code. No `TBD` / `similar to Task N` / `handle edge cases`. ✓

**3. Type consistency:**
- `GradeStore.deleteUser(userId, expectedEmail)` signature: declared Task 7 Step 1, implemented Task 7 Step 4, consumed Task 8 Step 3. ✓
- `DeleteAccountResult` union: declared Task 9, consumed Task 10. ✓
- `DeleteAccountForm` props shape `{ email }`: declared Task 10, consumed Task 11. ✓
- `/auth/delete-account` path: consistent across Tasks 8, 9, 10. ✓

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-20-geo-reporter-plan-11-user-controls-legal.md`. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, two-stage review between tasks.

**2. Inline Execution** — batch through in this session with checkpoints.

**Which approach?**
