# DEVLOG

## 2026-08-09

Project initialised from architecture planning session.

## 2026-08-10

External infrastructure provisioned: Supabase project (ExamsIndia),
Cloudflare D1 database and R2 bucket, GitHub repository and CI secrets.
Schema deployed to live D1 and verified. Deploy pipeline (GitHub Actions
→ Wrangler → Cloudflare Worker) confirmed green with a placeholder
Worker.

First application code: Worker auth/routing skeleton. JWKS-based
Supabase JWT verification (ES256, native Web Crypto, no dependencies),
CORS allowlist enforcement, exam_code derived from Origin, /whoami test
route. Verified negative paths via curl (bad origin, missing/invalid
token); valid-token path deferred until a real signed-up test account
exists.

aissee/index.html page shell built: header, language selector, t()/LANG
translation system (en/hi, default hi), Sign In/Sign Up tabs, Supabase
Auth wiring (email+password, Google OAuth button), post-auth account
card with a Worker /whoami verification button. Tested locally at 375px:
language switching, Noto Sans conditional load/unload, tab switching,
client-side validation, and mobile touch-target/font-size constraints
all confirmed. Real sign-up, Google OAuth, and the /whoami success path
remain unverified — the first two need a human to enter real
credentials, the third is blocked by CORS until deployed to the real
subdomain.

aissee.examsindia.org deployed via Cloudflare Pages (project
examsindia-aissee), auto-deploying through a new GitHub Actions +
Wrangler workflow rather than Cloudflare's GitHub App integration, to
avoid a new OAuth grant. Custom domain activated almost immediately
(examsindia.org already lives on Cloudflare). Confirmed live: page
loads at the real domain, and the Worker's CORS allowlist now accepts
requests from it — /whoami correctly returns 401 for an invalid token
instead of being CORS-blocked as it was from localhost. Still open: a
genuinely valid JWT success path, which needs a real sign-up.

Google OAuth configured in Supabase. First attempt reused the existing
"My First Project" in Google Cloud, which already had an unrelated
OAuth client and consent-screen branding for "Claude Drive" — caught
live when the Google sign-in screen said "to continue to Claude Drive"
instead of anything ExamsIndia-branded, since consent-screen branding
is shared per-project in Google Cloud. Fixed by creating a dedicated
`examsindia` project with its own consent screen (app name "Exams
India" — domain-wide per the shared-identity decision, not
AISSEE-specific), publishing it to production, and creating a fresh
OAuth client there. Confirmed fixed by triggering the real sign-in
redirect from the live site and seeing "to continue to Exams India".
Cleaned up the leftover wrongly-scoped client from the old project and
trimmed down to one active client secret.

Clarified: user identity (Supabase Auth) is one shared pool across all
exam subdomains — same credentials work anywhere — but content access
stays scoped to each user's own exam_code/class_entry in D1, never
inferred from which subdomain they signed in through. Logged as an
explicit requirement for the Worker's authorization checks, not yet
built.

Fixing consent-screen branding wasn't enough — the permission-grant
screen (separate from the account picker) still showed
knkmcpbyrgrbgpriztnj.supabase.co, since that's where signInWithOAuth's
redirect_uri actually lives. Switched to Google Identity Services (GSI)
client-side + signInWithIdToken instead, which never redirects through
Supabase at all — free, no Pro plan needed, but real frontend code:
replaced the custom button with Google's own rendered button, added
proper SHA-256 nonce handling, and made sure the GSI script tag loads
(defer, not async) before our module script runs. Also fixed a
"google.accounts.id.initialize() called multiple times" warning caused
by acting on Supabase's redundant INITIAL_SESSION auth event.

Full chain verified end-to-end by a real user (a Google account
distinct from the admin's, not something done on their behalf): signed
in via Google, then Verify Worker Auth returned HTTP 200 with the
correct email, Supabase user id, and exam_code. This was the last
unverified piece of the Worker/auth foundation built earlier in the
day.
