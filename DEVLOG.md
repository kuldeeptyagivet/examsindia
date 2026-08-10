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

Decided mobile/city/state profile fields fold into a single one-time
"complete your setup" screen alongside exam/class/target-date
registration, rather than a separate profile step. Real SMS OTP
verification deferred (TRAI DLT registration required for any business
SMS sender in India regardless of provider/method — not just a cost
problem). State is a hardcoded India states/UTs dropdown; city is free
text.

Built and deployed the setup screen: schema gains mobile_number/city/
state on student_enrollments (ALTER TABLE against live D1); Worker
gains its first real D1 endpoints, GET and POST /enrollment; frontend
shows the setup form after sign-in until enrolled, then an enrollment
summary. Verified fully end-to-end with the same real test account:
submitted the form, confirmed both student_enrollments and users rows
in D1 directly via the dashboard console (not just the app's own
report), and confirmed reload correctly skips back to the account view
instead of re-showing the setup form. Schedule-row generation not
included - no syllabus/scheduled_tests content exists yet to schedule
against.

Researched two competitor sites (sainikguru.com, garudsainikacademy.com
blog) before building landing page content. Added a static bilingual
hero, feature grid, how-it-works, and FAQ above the sign-in box, plus
meta description/canonical/OG tags and EducationalOrganization JSON-LD.
Deliberately didn't copy competitors' unverifiable stats or faculty
credential claims - led with what's actually true instead (free, full
syllabus, personalised schedule, progress tracking, bilingual). Landing
content is real static HTML (toggled via CSS class, not JS render) so
it's crawlable and doesn't flash empty on load; hidden once signed in.

Caught and fixed a UX gap right after: the language toggle only lived
inside the app's own header, below all the new landing content, so a
visitor had no way to switch language without scrolling past the whole
page first. Moved it to a sticky top bar spanning the full page and
rewired it to fire once in init() instead of attachHandlers(), since it
no longer gets torn down and rebuilt on every render().

Started the admin console: `syllabus` and `scheduled_tests` are still
empty in D1, blocking schedule generation, test composition, and the
CBT screen, so syllabus editing was the highest-leverage first admin
piece. Reworked the plan mid-design: rather than the originally-decided
gated tab inside `aissee/index.html`, built a standalone console at
`admin.examsindia.org` (new `admin/index.html`, new Pages deployment,
new `deploy-admin.yml` workflow mirroring the existing pattern) since
the Worker/D1 layer is already shared across exams by `exam_code` — a
root-level console naturally manages every exam from one place instead
of growing each exam's own file with operator-only code.

Worker gained an admin authorization path distinct from the
Origin-derived `exam_code` model every other route uses: `/admin/*`
requires the request to originate from `ADMIN_ORIGIN` specifically, and
`requireAdmin()` checks the JWT plus a live `users.role` lookup for
`admin`/`superadmin`. Admin routes take `exam_code` as an explicit,
validated parameter instead, since the console isn't tied to one exam.
New routes: `GET /admin/whoami` (auth gate for the console shell),
`GET /admin/meta` (exams + class entries for the selector), and full
CRUD on `syllabus` (`GET`/`POST /admin/syllabus`,
`PUT /admin/syllabus/:id`) — validated the same way `/enrollment`
already is. Delete is soft (`is_active` toggle) only, since
`scheduled_tests.chapter_id` will reference these rows once test
composition exists.

Admin console auth is Google Sign-In only — no email/password, no
sign-up flow. It's a single-operator tool, so skipped the
confirmation-email complexity the student app needs; Google Sign-In
auto-provisions a Supabase auth user on first sign-in, and a seeded
`users` row (`drtyagivet@gmail.com`, role `superadmin`, added directly
to `schema/schema.sql` and applied to live D1 via the dashboard console)
means that first sign-in is immediately recognized as superadmin with
no separate bootstrap step.

Built the console shell: sign-in screen, a left-nav with "Syllabus"
functional and Exam Config / Test Composition / Student Management /
Announcements / Messaging stubbed as disabled "coming soon" entries so
later parts extend this shell instead of rebuilding it. Syllabus tab:
exam + class-entry selectors, a chapter table with Up/Down reorder
(swaps `sort_order` between adjacent rows via two `PUT` calls), Edit,
and Activate/Deactivate, plus a modal Add/Edit form with a repeatable
topic-heading list. Not yet verified live — needs the manual Google
Cloud (authorized JavaScript origin) and Cloudflare Pages (custom
domain) steps before it can be signed into at the real subdomain.
