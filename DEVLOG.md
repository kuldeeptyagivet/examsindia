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

Completed the three manual steps live in the browser: added
`admin.examsindia.org` as a custom domain on the `examsindia-admin`
Pages project (DNS auto-configured, active almost immediately — same as
`aissee.examsindia.org` earlier), added the same origin as an
Authorized JavaScript origin on the existing `examsindia` Google Cloud
OAuth client, and ran the superadmin seed INSERT against live D1.
Caught a real mismatch during sign-in testing: the browser's active
Google session was a different account than the seeded superadmin
email — switched accounts rather than seeding the wrong one. Full chain
then verified end-to-end with the real account: signed in, shell
rendered with only Syllabus enabled, `/admin/whoami` recognized
superadmin.

Reworked chapter entry after starting to add them by hand: rather than
89 manual "Add Chapter" round-trips, built bulk import from a real
question-bank folder (`SAINIK_CLA6`, matching `QB_QUESTION_SCHEMA` from
CLAUDE.md exactly, including a `topic_heading` per question). Confirmed
with the user that heading-level granularity is unnecessary since tests
are composed chapter-wise, not sub-topic-wise — so import only needs
`_index.json`'s chapter-level fields (subject/chapter number/chapter
name/count), not the full per-question files.

Discussed where the import should read from, since the same folder
will eventually be mirrored into R2 for test composition. Concluded
local disk is right for now: R2 is empty and only matters once Test
Composition needs actual question content, and requiring an R2 upload
pipeline before syllabus could even be seeded would be backwards for
what's lightweight catalog data. Local Drive folder is the authoring
source; R2 becomes the sync target later, as its own separate piece of
work.

First cut was a single "Import from Folder" button that just wrote
whatever was in `_index.json`. User pushed back before it shipped:
re-running it would need to update changed chapters and add new ones
without duplicating existing ones, and specifically asked to discuss
the design rather than have it built silently. Redesigned as two
explicit steps — "Connect Folder" (parse and cache, no writes) then
"Scan & Compare" (fresh-fetch current syllabus, diff by
`(subject, chapter_number)`, show new/changed/unchanged counts before
anything is written). Chapters in D1 but missing from the folder get
flagged with an opt-in Deactivate checkbox rather than being
auto-removed, per the user's choice — a chapter already referenced by
a scheduled test shouldn't silently disappear.

Backend: new `POST /admin/syllabus/import` Worker route, upserting via
`INSERT ... ON CONFLICT(exam_code, class_entry, subject,
chapter_number) DO UPDATE`. Needed a new unique index on that column
set (`schema/schema.sql`) to make the upsert possible — checked
`syllabus` was empty in live D1 first so the migration couldn't fail
on a pre-existing duplicate.

Verified live end-to-end: connected the real `SAINIK_CLA6` folder,
Scan & Compare correctly reported 66 new chapters across 5 subjects
(Mathematics 17, Intelligence 13, English 19, General Knowledge 4,
General Science 13 — matching `_index.json` exactly), applied them, and
confirmed all 66 rows in the syllabus table. Re-connected the same
folder and re-ran Scan & Compare: 0 new/0 changed/66 unchanged,
confirming the upsert is idempotent rather than duplicating on
re-import. Also fixed a CSS gap while testing at a narrower viewport:
the Syllabus tab's selector/button row had no `flex-wrap` and squished
at smaller widths.
