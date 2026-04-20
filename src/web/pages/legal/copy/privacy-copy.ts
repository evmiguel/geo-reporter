// GEO Reporter v3 Privacy Policy — written for a NY-based sole operator running
// a public paywalled SaaS. Covers GDPR (EU) + CCPA (California) disclosures in
// plain language. Review with a lawyer before full launch.
export const privacyLastUpdated = '2026-04-20'

export const privacyHtml = `
<style>
  .legal p { margin-bottom: 1rem; line-height: 1.6; }
  .legal h2 { font-size: 1.25rem; margin-top: 2.5rem; margin-bottom: 0.75rem; }
  .legal h3 { font-size: 1rem; margin-top: 1.5rem; margin-bottom: 0.5rem; font-weight: 600; }
  .legal ul { list-style: disc; padding-left: 1.5rem; margin-bottom: 1rem; }
  .legal ul li { margin-bottom: 0.25rem; }
  .legal a { color: var(--color-brand); text-decoration: underline; }
  .legal strong { font-weight: 600; }
</style>
<div class="legal">
<p>This Privacy Policy explains how GEO Reporter ("we", "us", "our") collects, uses, and shares information when you use <a href="https://geo.erikamiguel.com">geo.erikamiguel.com</a> (the "Service"). We are a sole operator based in New York, USA. You can reach us at <a href="mailto:erika@erikamiguel.com">erika@erikamiguel.com</a>.</p>

<h2>1. What we collect</h2>

<h3>1.1 Information you give us</h3>
<ul>
  <li><strong>URLs you submit for grading.</strong> We fetch the content at that URL, extract text and metadata, and pass excerpts to third-party large language models (see §3) to produce a grade.</li>
  <li><strong>Email address</strong>, if you verify your email to unlock paid features. We use it for magic-link sign-in and for transactional email about your account.</li>
  <li><strong>Payment details</strong>, if you purchase a report or credit pack. Card numbers go directly to Stripe — we never see or store them. We store a record of the transaction (amount, date, Stripe session ID) for accounting.</li>
</ul>

<h3>1.2 Information we collect automatically</h3>
<ul>
  <li><strong>A random session identifier</strong> stored in a cryptographically-signed cookie called <code>ggcookie</code>. It is used for rate limiting and to bind anonymous grades to a session. See our <a href="/cookies">Cookie Policy</a>.</li>
  <li><strong>Your IP address</strong>, observed from the network connection. Used for rate limiting, fraud prevention, and debugging.</li>
  <li><strong>Request metadata</strong> — timestamps, request paths, response codes, and user agent — retained in server logs for up to 30 days.</li>
</ul>

<h3>1.3 Information from third parties</h3>
<p>Stripe notifies us (via webhook) when a payment you initiated succeeds, fails, or is refunded. We receive the Stripe session ID, amount, and status — not your card data.</p>

<h2>2. How we use your information</h2>
<ul>
  <li>To run the grading pipeline and deliver the report you requested.</li>
  <li>To authenticate you via magic-link email and keep you signed in.</li>
  <li>To enforce rate limits (e.g., 3 free grades per 24 hours for anonymous users, 10 for credit holders).</li>
  <li>To process payments and keep records required for tax and accounting.</li>
  <li>To detect and prevent abuse, fraud, and technical attacks (including server-side request forgery protections on URLs you submit).</li>
  <li>To respond to you when you contact support.</li>
  <li>To comply with legal obligations.</li>
</ul>

<p>We do <strong>not</strong> use your data to train machine-learning models. We do <strong>not</strong> sell your personal information.</p>

<h2>3. Who we share information with</h2>

<p>We use the following third-party service providers. Each receives only the data necessary to perform its function.</p>
<ul>
  <li><strong>Anthropic</strong> (Claude) — receives excerpts of the scraped content of URLs you submit, plus prompts, to generate grades. <a href="https://www.anthropic.com/legal/privacy">anthropic.com/legal/privacy</a></li>
  <li><strong>OpenAI</strong> (ChatGPT) — same purpose as Anthropic. <a href="https://openai.com/policies/privacy-policy">openai.com/policies/privacy-policy</a></li>
  <li><strong>Google</strong> (Gemini) — same purpose (paid tier only). <a href="https://policies.google.com/privacy">policies.google.com/privacy</a></li>
  <li><strong>Perplexity</strong> — same purpose (paid tier only). <a href="https://www.perplexity.ai/hub/legal/privacy-policy">perplexity.ai/hub/legal/privacy-policy</a></li>
  <li><strong>OpenRouter</strong> — may act as a fallback routing layer for the providers above if one experiences a transient error. <a href="https://openrouter.ai/privacy">openrouter.ai/privacy</a></li>
  <li><strong>Stripe</strong> — payment processing. Card data goes directly to Stripe; we receive only the transaction record. <a href="https://stripe.com/privacy">stripe.com/privacy</a></li>
  <li><strong>Resend</strong> — delivers transactional email (magic-links, receipts). <a href="https://resend.com/legal/privacy-policy">resend.com/legal/privacy-policy</a></li>
  <li><strong>Railway</strong> — application and database hosting. <a href="https://railway.com/legal/privacy">railway.com/legal/privacy</a></li>
</ul>

<p>We may also disclose information if required by law, subpoena, or court order, or to protect the rights, property, or safety of us or others.</p>

<h2>4. How long we keep your data</h2>
<ul>
  <li><strong>Grade reports and scraped content</strong> — retained indefinitely while your account is active, so you can return to historical reports. Delete your account to remove them (see §6).</li>
  <li><strong>Account email and credit balance</strong> — retained until you delete your account.</li>
  <li><strong>Payment records</strong> — retained for at least 7 years to meet tax and accounting obligations, even after account deletion. Your identity is detached (user ID and grade ID are nulled out) when you delete your account.</li>
  <li><strong>Server logs and rate-limit buckets</strong> — purged on a rolling 24-hour to 30-day window.</li>
</ul>

<h2>5. Security</h2>
<p>We use TLS for all traffic, HMAC-signed session cookies, and industry-standard password-less authentication. Payment processing runs entirely on Stripe's PCI-compliant infrastructure. No method of transmission or storage is 100% secure, and we cannot guarantee absolute security.</p>

<h2>6. Your rights</h2>

<h3>6.1 Everyone</h3>
<ul>
  <li><strong>Access</strong> — email us to request a copy of the personal data we hold about you.</li>
  <li><strong>Delete</strong> — sign in and visit <a href="/account">Account</a> to permanently delete your account and all associated grades. Payment records are anonymized (user ID removed) but not deleted, for tax retention.</li>
  <li><strong>Correct</strong> — email us to correct inaccurate personal data.</li>
  <li><strong>Object or restrict processing</strong> — email us.</li>
</ul>

<h3>6.2 California residents (CCPA / CPRA)</h3>
<p>You have the right to know what personal information we collect, disclose, or sell; to delete; to correct; and to non-discrimination for exercising your rights. We do not sell or share personal information for cross-context behavioral advertising. To exercise any right, email <a href="mailto:erika@erikamiguel.com">erika@erikamiguel.com</a>.</p>

<h3>6.3 European Economic Area, UK, and Switzerland (GDPR / UK GDPR)</h3>
<p>Our legal bases for processing are (a) performance of a contract with you (running the Service you purchased or requested), (b) our legitimate interests in securing and operating the Service, (c) your consent where you have given it, and (d) compliance with legal obligations. You have the rights of access, rectification, erasure, restriction, portability, and objection, and you may lodge a complaint with your local data protection authority.</p>

<h3>6.4 International transfers</h3>
<p>Our servers and most of our third-party providers are based in the United States. If you access the Service from outside the US, your data will be transferred to and processed in the US. By using the Service you consent to this transfer.</p>

<h2>7. Children</h2>
<p>The Service is not intended for anyone under 13. We do not knowingly collect personal information from children under 13. If you believe we have, email us and we'll delete it.</p>

<h2>8. Changes to this policy</h2>
<p>We may update this policy from time to time. The "Last updated" date at the top of this page reflects the current version. Material changes will be announced on the homepage or by email to account holders. Continued use of the Service after changes take effect constitutes acceptance.</p>

<h2>9. Contact</h2>
<p>Questions, requests, or complaints: <a href="mailto:erika@erikamiguel.com">erika@erikamiguel.com</a>.</p>
</div>
`
