export type FailKind = 'scrape_failed' | 'provider_outage' | 'other'

/**
 * Shared copy for grade-failure states shown on the landing page. Used by
 * both useCreateGrade's peek (fast failures caught before navigate) and
 * LiveGradePage's post-submit redirect (slow failures caught after navigate).
 * Keeping the mapping in one place so the user sees consistent copy no
 * matter which branch caught the failure.
 */
export function messageForFailKind(failKind: FailKind): string {
  if (failKind === 'scrape_failed') {
    return "We couldn't read that page. Some sites block automated tools — " +
      'marketing pages, blogs, and personal sites work best. Reddit, X, ' +
      "Facebook, and login-gated apps usually don't work."
  }
  if (failKind === 'provider_outage') {
    return "Claude or ChatGPT wasn't reachable. Give it a minute and try " +
      "again. This didn't count against your daily limit."
  }
  return "Something went wrong while grading that site. This didn't count " +
    'against your daily limit — try again, or pick a different URL.'
}
