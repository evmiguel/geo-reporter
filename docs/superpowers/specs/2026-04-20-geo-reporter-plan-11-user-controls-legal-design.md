# GEO Reporter — Plan 11 (user controls + legal pages) design

> Sub-spec for Plan 11. Brainstormed 2026-04-20. Plan 11 addresses three items the soft-launch audience will notice immediately: the live grade page not showing which URL is being tested, the absence of any user-facing account controls, and the legal-page gap (privacy policy, terms of use, cookie policy). These aren't tightly coupled but they're all small-to-medium user-facing/account work; bundling keeps them in one review cycle instead of three.

## 1. Scope

**In scope**

- Domain + URL header on `LiveGradePage` so the page title answers "what am I looking at?" without needing to read the probe log.
- `/account` route rendered by a new `AccountPage` component, gated to verified users.
- `POST /auth/delete-account` endpoint with type-your-email confirmation, cascading DB cleanup, anonymized (not deleted) `stripe_payments` for 7-year tax retention, cookie reset on success.
- Three legal-copy pages — `/privacy`, `/terms`, `/cookies` — rendered from Termly HTML pasted into per-page copy files.
- Shared `<Footer>` component with Privacy · Terms · Cookies links, mounted in the SPA root layout.
- Single "View privacy policy" link added to the report Methodology section so SSR HTML + PDF artifacts don't dead-end users looking for the legal page.

**Out of scope (defer)**

- Data export / download-my-data endpoint. MVP deletion is sufficient; export is a nicer-to-have and most users don't ask for it. Track on production-checklist for later.
- Re-authentication via magic link before destructive account ops. Type-your-email is good enough; magic-link re-confirmation is gold-plating.
- Cookie consent banner (for GDPR-lite compliance). Not needed for soft launch; Termly's privacy copy can disclose cookies, which is what we're doing.
- Partial account deletion (e.g. delete specific grades but keep credits). All-or-nothing is simpler.
- Undo-delete window. Once deleted, it's deleted. A 30-day soft-delete would be safer but adds surface area; revisit if we hit a real "I didn't mean to" incident.
- Admin impersonation / support delete. Manual DB queries for the first few support cases are fine.

## 2. Decisions locked in on 2026-04-20

| # | Decision | Choice | Why |
|---|---|---|---|
| P11-1 | Delete-account friction | Type the exact email of the logged-in user to confirm | Standard pattern (GitHub, Stripe). Protects against fat-finger + provides weak protection against a stolen cookie whose holder doesn't know the user's email. Cheaper than magic-link re-auth; better than a single-click modal. |
| P11-2 | Stripe payment records on delete | Anonymize (NULL out `user_id` and `grade_id`), do NOT delete | Tax/accounting retention obligation (~7 years in US). Anonymization keeps the revenue row while erasing the PII link. `stripe_payments.grade_id` is already nullable; `user_id` will need to become nullable too (migration). |
| P11-3 | Legal-page copy source | Termly — privacy (received), terms (pending), cookies (pending) | User owns the content. Termly handles jurisdictional variations and keeps copy updated. App just renders. |
| P11-4 | Legal-page rendering | Paste Termly's raw HTML verbatim into `src/web/pages/legal/*-copy.ts` string exports; render via `dangerouslySetInnerHTML` inside a shared `<LegalPage>` wrapper | Termly's inline `<style>` block self-scopes via `data-custom-class` attributes — styles don't leak. The `<bdt>` template markers render as empty spans (harmless). Do NOT clean, sanitize, or Markdown-convert — source of truth is Termly. |
| P11-5 | Footer scope | SPA pages only — landing, live grade, email gate, account, 404. Report SSR HTML + PDF keep their existing methodology footer, with one new "View privacy policy" link added to the methodology section. | The report is the product; the methodology section already footers the legal context. A separate app footer on the SSR HTML would clash with the rendered-report aesthetic. |
| P11-6 | URL visibility header | Domain as title (22px sans), full URL as subtitle (muted, small) — shown on LiveGradePage above the status bar / letter grade | Matches the Plan 9 report cover aesthetic. Answers "what am I looking at?" before the user needs to read probe log rows. |
| P11-7 | Account page contents | Email, credits badge with conditional buy-link, sign-out, delete-account section | Minimal viable account page. No profile editing (there's nothing to edit). No activity log (grades are at `/g/:id` already). |
| P11-8 | Delete flow response | 204 No Content + clears `ggcookie` (same as logout). Frontend navigates to `/` with a `?deleted=1` param that triggers a landing-page toast. | Reuses the existing logout wiring. No new toast component needed — extend the existing verified/credits-toast logic to handle `?deleted=1`. |
| P11-9 | Legal page route gating | All three legal pages public — no auth required | Users may link to `/privacy` from the magic-link email or share URLs externally. Gating would break those flows. |

## 3. Architecture

```
src/web/pages/
├── AccountPage.tsx              NEW — authed page; credits + delete form
├── LiveGradePage.tsx            MODIFY — add domain title + URL subtitle header
├── LandingPage.tsx              MODIFY — handle ?deleted=1 toast
└── legal/
    ├── LegalPage.tsx            NEW — shared wrapper (max-width, title, updated date)
    ├── PrivacyPage.tsx          NEW — imports privacy-copy.ts + renders via LegalPage
    ├── TermsPage.tsx            NEW — same pattern
    ├── CookiesPage.tsx          NEW — same pattern
    └── copy/
        ├── privacy-copy.ts      NEW — Termly HTML as a string export
        ├── terms-copy.ts        NEW — pending content from user
        └── cookies-copy.ts      NEW — pending content from user

src/web/components/
├── Footer.tsx                   NEW — Privacy · Terms · Cookies small-text links
└── DeleteAccountForm.tsx        NEW — email-confirm input + delete button

src/web/
├── App.tsx                      MODIFY — add /account, /privacy, /terms, /cookies routes; mount <Footer/>
├── lib/api.ts                   MODIFY — add postAuthDeleteAccount() wrapper
└── hooks/useAuth.ts             MODIFY — add deleteAccount() method; clears state like logout does

src/report/components/
└── Methodology.tsx              MODIFY — add "View privacy policy" link

src/server/routes/
└── auth.ts                      MODIFY — add POST /delete-account handler

src/store/
├── types.ts                     MODIFY — add deleteUser(userId, email) method to GradeStore
└── postgres.ts                  MODIFY — implement deleteUser with transactional cleanup

src/db/
└── schema.ts                    MODIFY — make stripe_payments.user_id nullable (will need a migration)

tests/unit/web/
├── pages/AccountPage.test.tsx           NEW — 3 tests (renders when verified, delete requires email match, sign-out)
├── pages/legal/legal-pages.test.tsx     NEW — 3 tests (privacy/terms/cookies routes render their copy)
├── pages/LiveGradePage.url-header.test.tsx  NEW — renders domain + URL
└── components/DeleteAccountForm.test.tsx    NEW — 3 tests (typo disables button; exact match enables; submit calls API)

tests/unit/server/routes/
└── auth-delete-account.test.ts   NEW — 5 tests (happy path, wrong email, unauthenticated, etc.)

tests/integration/
└── delete-account.test.ts        NEW — end-to-end: seed grades + payments, delete, assert cascade + anonymization
```

## 4. Components

### 4.1 LiveGradePage URL header

Inside `LiveGradePage`'s existing `getGrade(id)` hydrate `useEffect`, store `url` + `domain` on local state. Render at the top of the page, ABOVE the existing "live grade" label:

```tsx
<div className="mb-6">
  <div className="text-xs tracking-wider text-[var(--color-fg-muted)] uppercase">live grade</div>
  {grade && (
    <>
      <h1 className="text-2xl text-[var(--color-fg)] mt-1">{grade.domain}</h1>
      <div className="text-sm text-[var(--color-fg-dim)] mt-1 break-all">{grade.url}</div>
    </>
  )}
</div>
```

Shown as soon as the grade row loads (typically within 100ms of mount). Pre-hydrate fallback: if the user navigates from the landing page, we can pass the URL via React Router's navigation state to paint the header instantly. If it's a cold refresh, the brief blank space (~100ms) is acceptable.

### 4.2 `/account` page

```tsx
function AccountPage(): JSX.Element {
  const { verified, email, credits, logout } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (!verified) navigate('/email?next=/account', { replace: true })
  }, [verified, navigate])

  if (!verified) return <div />  // brief flash; useEffect bounces

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
          {credits > 0 ? `${credits} remaining` : 'None — '}
          {credits === 0 && <a href="/buy-credits" className="text-[var(--color-brand)] underline">buy 10 for $29</a>}
        </div>
      </section>

      <section className="mb-8">
        <button onClick={() => void logout()} className="text-sm underline">Sign out</button>
      </section>

      <section className="border-t border-[var(--color-line)] pt-8">
        <h2 className="text-lg text-[var(--color-warn)]">Delete account</h2>
        <DeleteAccountForm email={email!} />
      </section>
    </div>
  )
}
```

### 4.3 `DeleteAccountForm`

```tsx
interface Props { email: string }

function DeleteAccountForm({ email }: Props): JSX.Element {
  const [typed, setTyped] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()
  const matches = typed.trim() === email

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (!matches) return
    setPending(true); setError(null)
    const result = await postAuthDeleteAccount(typed.trim())
    setPending(false)
    if (result.ok) { navigate('/?deleted=1'); return }
    setError(result.kind === 'email_mismatch'
      ? "Email doesn't match your account."
      : 'Something went wrong. Try again?')
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
          className="flex-1 bg-[var(--color-bg-elevated)] border border-[var(--color-line)] px-3 py-2"
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

### 4.4 Legal pages scaffold

**`LegalPage.tsx`** — shared wrapper:

```tsx
interface Props { title: string; lastUpdated: string; html: string }

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

**`PrivacyPage.tsx`**:

```tsx
import { LegalPage } from './LegalPage.tsx'
import { privacyHtml, privacyLastUpdated } from './copy/privacy-copy.ts'

export function PrivacyPage(): JSX.Element {
  return <LegalPage title="Privacy Policy" lastUpdated={privacyLastUpdated} html={privacyHtml} />
}
```

Same pattern for Terms and Cookies. When user provides updated copy, the only change is replacing the string export in `*-copy.ts`.

### 4.5 `<Footer>`

```tsx
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

Mounted in `App.tsx` AFTER the `<Routes />` so it renders below every page. Not shown inside `LegalPage` itself (redundant).

### 4.6 Methodology link

In `src/report/components/Methodology.tsx`, add a line to the "Report metadata" or footer section:

```tsx
<a href="https://geo.erikamiguel.com/privacy" className="small muted">View privacy policy</a>
```

Uses absolute URL because PDF renders don't have a router context.

## 5. Server & data layer

### 5.1 `POST /auth/delete-account`

Handler in `src/server/routes/auth.ts`:

```ts
const deleteSchema = z.object({ email: z.string().trim().toLowerCase() })

app.post('/delete-account', zValidator('json', deleteSchema), async (c) => {
  const { email } = c.req.valid('json')
  const row = await deps.store.getCookieWithUserAndCredits(c.var.cookie)
  if (!row.userId || !row.email) return c.json({ error: 'not_authenticated' }, 401)
  if (row.email.toLowerCase() !== email) return c.json({ error: 'email_mismatch' }, 400)

  await deps.store.deleteUser(row.userId, email)

  // Clear the cookie — same mechanism as logout
  setCookie(c, COOKIE_NAME, '', { maxAge: 0, path: '/', httpOnly: true, sameSite: 'Lax' })
  return c.body(null, 204)
})
```

No rate limit on this endpoint; it's an authenticated, user-initiated destructive op. If abuse emerges, we'll add one.

### 5.2 `GradeStore.deleteUser`

Transactional cleanup:

```ts
async deleteUser(userId: string, expectedEmail: string): Promise<void> {
  await this.db.transaction(async (tx) => {
    // Double-check email inside the transaction (race against Stripe webhook, etc.)
    const [user] = await tx.select().from(schema.users).where(eq(schema.users.id, userId))
    if (!user || user.email.toLowerCase() !== expectedEmail.toLowerCase()) {
      throw new Error('user not found or email mismatch')
    }

    // 1. Delete all grades — cascades to scrapes, probes, recommendations, reports, report_pdfs
    await tx.delete(schema.grades).where(eq(schema.grades.userId, userId))

    // 2. Unbind every cookie from this user
    await tx.update(schema.cookies)
      .set({ userId: null })
      .where(eq(schema.cookies.userId, userId))

    // 3. Remove magic tokens for this email
    await tx.delete(schema.magicTokens).where(eq(schema.magicTokens.email, user.email))

    // 4. Anonymize stripe_payments — keep for 7y tax, detach from user
    await tx.update(schema.stripePayments)
      .set({ userId: null, gradeId: null })
      .where(eq(schema.stripePayments.userId, userId))

    // 5. Finally delete the user row
    await tx.delete(schema.users).where(eq(schema.users.id, userId))
  })
}
```

### 5.3 Schema migration

`stripe_payments.user_id` must become nullable. New migration via `pnpm db:generate`.

## 6. Testing strategy

**Unit (new):**

- `AccountPage` — renders when verified; redirects to `/email?next=/account` when not.
- `DeleteAccountForm` — button disabled until typed email matches; submit calls API; error on 400.
- `LegalPage` + three legal routes — each renders its copy string.
- `LiveGradePage` URL header — domain + URL render once grade loads.
- `auth/delete-account` route — happy path, wrong email, unauthenticated.

**Integration (new):**

- End-to-end delete: seed a verified user with grades + stripe_payments + magic_tokens, POST /auth/delete-account with the right email, assert all grades gone, cookies.userId=null, magic_tokens deleted, stripe_payments userId=null + gradeId=null, users row gone, cookie cleared in response.

**Not covered:** real-email magic-link integration (already covered in existing test).

## 7. Rollout + risks

| Risk | Mitigation |
|---|---|
| A user deletes their account and immediately regrets it | Type-email friction + explicit "cannot be undone" copy. Soft-delete / undo window is a future improvement. |
| Termly HTML contains a script tag that renders unsafely | Termly's template doesn't emit `<script>`; the HTML we paste contains only tags + inline style blocks. If Termly ever adds scripts, we'd see them in the pasted copy before shipping. Still, code-review each paste manually. |
| The schema migration on `stripe_payments.user_id` is backfilled wrong | Migration is ALTER TABLE ... DROP NOT NULL only; existing rows unaffected. Forward-only, rollback-safe. |
| Concurrent Stripe webhook firing mid-delete (race) | `deleteUser` is a single DB transaction. Worst case: webhook fires first and inserts a new `stripe_payments` row referencing the user just before our transaction starts → we anonymize it correctly. If it fires mid-transaction, Postgres serializes; our transaction either sees it or doesn't, both safe. |
| User has active paid report being generated at delete time | `grades` cascade deletes the row before generate-report finishes. Worker will fail gracefully on the next DB write with "grade not found". Tolerable; rare. |

## 8. Success criteria

Plan 11 is done when:

1. LiveGradePage shows the domain + URL prominently at the top.
2. A verified user can navigate to `/account` and see their email + credits + sign-out + delete section.
3. Typing the correct email and clicking "Delete permanently" erases the account, redirects to `/?deleted=1`, shows a toast.
4. `stripe_payments` rows persist post-delete with `user_id = NULL`.
5. `/privacy`, `/terms`, `/cookies` render Termly HTML without script errors or layout leaks.
6. Every SPA page has Privacy / Terms / Cookies footer links.
7. The PDF/HTML report Methodology section links to the privacy page.
8. All new unit + integration tests pass.
