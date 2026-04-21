// GEO Reporter v3 Cookie Policy. Short because the app only uses one
// strictly-necessary cookie and does not run analytics or advertising.
export const cookiesLastUpdated = '2026-04-20'

export const cookiesHtml = `
<style>
  .legal p { margin-bottom: 1rem; line-height: 1.6; }
  .legal h2 { font-size: 1.25rem; margin-top: 2.5rem; margin-bottom: 0.75rem; }
  .legal h3 { font-size: 1rem; margin-top: 1.5rem; margin-bottom: 0.5rem; font-weight: 600; }
  .legal ul { list-style: disc; padding-left: 1.5rem; margin-bottom: 1rem; }
  .legal ul li { margin-bottom: 0.25rem; }
  .legal a { color: var(--color-brand); text-decoration: underline; }
  .legal table { width: 100%; border-collapse: collapse; margin-bottom: 1rem; font-size: 0.875rem; }
  .legal th, .legal td { border: 1px solid var(--color-line); padding: 0.5rem; text-align: left; vertical-align: top; }
  .legal th { font-weight: 600; background: var(--color-bg-elevated); }
  .legal code { font-family: ui-monospace, monospace; background: var(--color-bg-elevated); padding: 0 0.25rem; border-radius: 3px; }
  .legal strong { font-weight: 600; }
</style>
<div class="legal">
<p>This Cookie Policy explains how <a href="https://geo.erikamiguel.com">geo.erikamiguel.com</a> (the "Service") uses cookies and similar technologies. It supplements our <a href="/privacy">Privacy Policy</a>.</p>

<h2>1. What is a cookie?</h2>
<p>A cookie is a small text file that a website stores in your browser. Cookies let sites remember things about your visit — like that you're signed in or how many grades you've already run today.</p>

<h2>2. The only cookie we set</h2>
<p>GEO Reporter sets exactly one cookie, and it is strictly necessary for the Service to work:</p>

<table>
  <thead>
    <tr><th>Name</th><th>Purpose</th><th>Type</th><th>Lifetime</th></tr>
  </thead>
  <tbody>
    <tr>
      <td><code>ggcookie</code></td>
      <td>Holds a random, cryptographically-signed session identifier. Used to (a) bind the grades you run to your session, (b) enforce rate limits (2 free grades per 24 hours; credits buy extras), and (c) keep you signed in after email verification.</td>
      <td>Strictly necessary (first-party, HMAC-signed, HttpOnly, SameSite=Lax, Secure in production)</td>
      <td>Persistent — cleared when you sign out or delete your account; otherwise retained for rate-limit and session purposes.</td>
    </tr>
  </tbody>
</table>

<p>Because <code>ggcookie</code> is strictly necessary to operate the Service, we do not require a cookie consent banner under EU/UK rules for this cookie. (Strictly-necessary cookies are exempt from the ePrivacy consent requirement.)</p>

<h2>3. Third-party cookies we do <em>not</em> set</h2>
<p>We do not use:</p>
<ul>
  <li>Cookie-based analytics (e.g. Google Analytics, Mixpanel). We use <a href="https://plausible.io/privacy-focused-web-analytics">Plausible Analytics</a>, which is cookieless and stores no personal data — see the Privacy Policy for details.</li>
  <li>Advertising or retargeting cookies.</li>
  <li>Social media tracking pixels.</li>
  <li>Any fingerprinting or cross-site tracking.</li>
</ul>

<p>If that changes in the future, we'll update this policy and add a consent banner before any non-essential cookie is set.</p>

<h2>4. Third-party cookies on other domains</h2>
<p>When you purchase a report or credits, you are redirected to Stripe's checkout page at <code>checkout.stripe.com</code>. Stripe sets its own cookies on its own domain to process the payment. We don't control those cookies; see <a href="https://stripe.com/cookies-policy/legal">Stripe's Cookie Policy</a>.</p>

<h2>5. Managing cookies</h2>
<p>Most browsers let you block or delete cookies via their settings. Blocking <code>ggcookie</code> will break the Service — you won't be able to run grades, stay signed in, or complete a purchase.</p>

<p>You can also clear the cookie by signing out (which unbinds it from your account) or by deleting your account from the <a href="/account">Account</a> page (which clears the cookie from your browser).</p>

<h2>6. Changes to this policy</h2>
<p>The "Last updated" date at the top of this page reflects the current version. If we add new cookies, we will update this policy and, where required, ask for your consent before setting them.</p>

<h2>7. Contact</h2>
<p>Questions: <a href="mailto:erika@erikamiguel.com">erika@erikamiguel.com</a>.</p>
</div>
`
