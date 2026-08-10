# CLAUDE.md — ExamsIndia

## 1. What This App Does
ExamsIndia is a multi-exam test series platform for students preparing for
competitive entrance exams in India, hosted at examsindia.org with each exam
on its own subdomain. The first exam is AISSEE (All India Sainik School
Entrance Examination) at aissee.examsindia.org, offering chapter tests,
previous year papers, and mock tests on a personalised, target-date-driven
schedule.

---

## 2. Tech Stack
- **Frontend**: Vanilla JS, no build step, no framework. Each exam subdomain
  is a single HTML file containing all HTML, CSS, and JS.
- **Fonts**: Google Fonts — DM Serif Display, DM Sans, DM Mono. Noto Sans
  added conditionally for Indic script support when a non-Latin language is
  active.
- **Math rendering**: KaTeX via CDN.
- **Authentication**: Supabase Auth (one project for all exam subdomains).
  Email/password plus Google OAuth. JWTs signed with Supabase's asymmetric
  key (ES256); the Cloudflare Worker verifies them against Supabase's
  public JWKS — no shared secret involved.
- **Serverless API**: One Cloudflare Worker handling all exam subdomains.
  Origin header determines exam context. Validates the Supabase JWT on every
  request.
- **Database**: One Cloudflare D1 database for the entire platform. All
  tables carry an `exam_code` column to scope queries per exam.
- **File storage**: One Cloudflare R2 bucket, `examsindia-qbank`, organised
  by exam and class prefix.
- **Hosting**: Cloudflare Pages. Each subdomain is a separate Pages
  deployment.
- **Deployment**: GitHub Actions via Wrangler; Worker auto-deploys on
  changes to `worker.js` or `wrangler.toml`.
- **Payments**: Razorpay, deferred until monetisation begins.

---

## 3. Directory Structure
```
examsindia/
├── CLAUDE.md
├── DEVLOG.md
├── ARCHITECTURE.md
├── aissee/
│   └── index.html
├── admin/
│   └── index.html
├── worker/
│   ├── worker.js
│   └── wrangler.toml
├── schema/
│   └── schema.sql
└── .github/
    └── workflows/
        ├── deploy-worker.yml
        ├── deploy-pages.yml
        └── deploy-admin.yml
```

---

## 4. Data Format
Question bank files follow QB_QUESTION_SCHEMA. Key fields:

```
question_id       — unique identifier
source_type       — extracted | modified | created
type              — mcq_single | mcq_multi | assertion_reason
                    | statement_based | match_following
stem              — question text (LaTeX for math)
stem_figure       — CDN URL or null
options           — [{key, text, figure}]
correct           — answer key string
difficulty        — easy | medium | hard
marks             — integer
bloom_level       — remember | understand | apply | analyze | evaluate
concept_tags      — array of strings
topic_heading     — string or null
topic_subheading  — string or null
verified          — boolean
source            — {book, chapter, section, page}
hint              — string or null
solution          — string or null
assertion         — string or null
reason            — string or null
statements        — array or null
list_i            — array or null
list_ii           — array or null
parent_id         — parent question_id or null
modified_from     — parent question_id or null
```

---

## 5. Architecture and Key Patterns

**CONFIG-driven data layer**: Each exam's single-file frontend reads a
CONFIG object that points all data access at the shared Worker API. No
direct D1 or R2 access from the client — the Worker is the only data
boundary, and it resolves `exam_code` from the request's Origin header
rather than from anything the client sends explicitly.

**Translation system**: All UI strings render via a `t('key')` function
backed by a `LANG` object keyed by language code. Launch languages are `en`
and `hi`, default `hi` for the AISSEE audience. Changing language re-renders
the current view without a page reload. Question content itself is never
translated — only UI chrome (labels, navigation, instructions, results,
landing copy). New languages are added by extending `LANG`, not by
restructuring the render layer.

**Two-pool normalisation**: Chapter test scores are difficulty-weighted at
submission (easy 1x, medium 1.25x, hard 1.5x) and stored as
`weighted_score`. A daily cron then z-scores two independent pools per
chapter/academic year — first-attempt (`is_first_attempt`) and
latest-attempt (`is_latest_attempt`) — producing `normalised_score_pool1`/
`rank_pool1` ("Entry Level Standing") and `normalised_score_pool2`/
`rank_pool2` ("Current Preparation Level"). Fixed papers (PYP, mock) rank
on first attempt only; repeats are practice with no rank fields. See
[ARCHITECTURE.md](ARCHITECTURE.md) for the full formula and pool boundary
rules.

**Schedule generation**: At registration a student picks a target
completion date; the full syllabus (chapter tests → previous year papers →
mock tests, in that order) is distributed evenly across the days to that
date and stored as one row per planned test in `student_schedules`. When
the target date changes, only incomplete rows are redistributed across the
new remaining window — completed rows and their dates never move. One
algorithm handles both compression and expansion.

**Worker origin-based routing**: A single Worker serves every exam
subdomain. It validates the Supabase JWT against Supabase's public JWKS
(ES256, cached in-memory) on every request, checks the request Origin
against a CORS allowlist, and derives `exam_code` from that Origin to
scope every D1 query. Adding a new exam requires only an allowlist entry,
an R2 prefix, and a new Pages deployment — no Worker, database, or auth
changes.

**Admin routes are the one exception to Origin-derived `exam_code`**:
`/admin/*` paths are gated to requests from `ADMIN_ORIGIN`
(`https://admin.examsindia.org`) specifically, and every admin endpoint
requires `requireAdmin()` — JWT-authenticated plus a live `users.role`
lookup for `admin`/`superadmin` — in addition to the CORS allowlist check.
Since the admin console isn't tied to one exam, admin routes take
`exam_code` explicitly as a request parameter (validated against a live
`exams` lookup) rather than deriving it from Origin.

**Admin panel and operational config**: A standalone console at
`admin.examsindia.org` (separate Pages deployment, its own single-file
frontend at `admin/index.html`) is the operational control room — exam
configuration, test composition and publishing, syllabus editing, student
management, normalisation thresholds, announcements, messaging, and
(later) platform analytics and pricing, for every exam from one place.
Role read from D1 `users.role` (`admin`/`superadmin`), same underlying
pattern as CompetitionHub, but enforced by the Worker rather than by a
tab gate in a student-facing file — see the Worker origin-based routing
pattern below for how admin requests are authorized. This supersedes the
original 2026-08-09 decision to embed the admin panel as a gated tab
inside each exam's own HTML file; see the 2026-08-10 Decisions Log entry
for why. Anything that might change over the platform's lifetime and
shouldn't require a code push lives in D1, not in a hardcoded array or
constant:
- `syllabus` — chapter structure per exam/class; the schedule generator
  reads this table, not a hardcoded list.
- `platform_config` — key-value store of per-exam operational parameters
  (`min_schedule_days`, `provisional_rank_threshold`,
  `academic_year_reset_month`, `default_language`, scoring weights, etc),
  read by the Worker at request time and cached per-request.

Security-critical or academic-integrity-critical values are deliberately
excluded from this pattern and stay as constants in code: JWT validation
logic, the CORS allowlist, the stratified sampling ratios (30/50/20), and
the difficulty scoring weights (changing the weights mid-academic-year
would invalidate existing normalised scores, so that requires a
deliberate code change with a migration plan — see [DEVLOG.md](DEVLOG.md)
Decisions Log below).

**Backup and recovery**: Cloudflare D1 Time Travel gives free, automatic
point-in-time recovery for the last 7–30 days depending on plan, with no
setup — the first response to an operational fault noticed soon after it
happens. A daily Cron Trigger additionally exports the full database via
`wrangler d1 export` to a `backups/` prefix in R2, giving an immutable,
portable snapshot that outlives the Time Travel window — needed because
normalisation pools are academic-year-scoped and a fault may surface
long after Time Travel has rolled past it. See
[ARCHITECTURE.md](ARCHITECTURE.md) §8 for the full policy.

**Secrets management**: Three categories of secret/credential exist in
this architecture and each lives in exactly one place. There is no
Supabase JWT secret in this architecture — see below.
- `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` — GitHub repository
  secrets only (Settings → Secrets and Variables → Actions), injected
  into the GitHub Actions workflow at run time. Never in any committed
  file.
- D1 database ID and R2 bucket name — resource identifiers, not
  credentials. These live in `wrangler.toml` and are safe to commit.
- Supabase Project URL and anon/publishable key — intentionally public,
  embedded directly in `aissee/index.html`. Access control is enforced by
  Supabase Row Level Security and by the Worker's JWT validation, not by
  keeping the anon key secret. This is standard Supabase architecture.

No Supabase JWT secret is set or stored anywhere. New Supabase projects
sign Auth JWTs with an asymmetric key (ES256) by default; the Worker
verifies signatures against Supabase's public JWKS
(`/auth/v1/.well-known/jwks.json`), fetched and cached in-memory. The
JWKS is public by design, so this requires no `wrangler secret put` step
and removes a secret the original plan assumed would exist.

Future Razorpay key secrets follow the Worker-secret pattern for
credentials that do need protecting: `wrangler secret put`, read only via
`env.*`, never hardcoded or committed.

---

## 6. Current State

**Working:**
- Project structure initialised
- Documentation complete (CLAUDE.md, ARCHITECTURE.md, DEVLOG.md)
- D1 schema designed and deployed (schema/schema.sql; all 10 tables live,
  aissee exams row and platform_config defaults seeded)
- Supabase project created (`ExamsIndia`, ap-southeast-1); Project URL and
  publishable key captured; JWKS-based auth confirmed as the verification
  path (see §5)
- Cloudflare infra created: D1 database `examsindia-db`, R2 bucket
  `examsindia-qbank` with `aissee/class6/` and `aissee/class9/` folders
- GitHub repo `kuldeeptyagivet/examsindia` created (public) with
  `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` repo secrets
- `wrangler.toml` filled in with real D1 binding and R2 binding; Worker
  named `examsindia-worker`
- Deploy pipeline verified green end-to-end: push to `main` → GitHub
  Actions → Wrangler → Cloudflare, confirmed live at
  `examsindia-worker.kuldeeptyagi-vet.workers.dev`
- Worker auth/routing skeleton live (`worker/worker.js`): verifies
  Supabase JWTs against the public JWKS (ES256) using native Web Crypto
  only, no dependencies; enforces the `ALLOWED_ORIGINS` CORS allowlist;
  derives `exam_code` from Origin; `/whoami` test route exercises the
  auth path. Verified via curl for all negative paths, and via a real
  signed-in user for the success path too.
- Worker's first real D1 endpoints: `GET /enrollment` (checks whether
  the authenticated student has completed setup) and
  `POST /enrollment` (validates and writes it — class_entry per exam,
  future target_date, 10-digit Indian mobile format only/no OTP, city,
  state against a hardcoded India states/UTs list; upserts `users`
  alongside the `student_enrollments` insert via `env.DB.batch()`;
  rejects re-enrollment with 409 once a record exists). Verified
  end-to-end by a real user: submitted the setup form, confirmed both
  `student_enrollments` and `users` rows landed correctly in D1 via the
  dashboard console, and confirmed the row persists correctly across a
  page reload (enrollment check on load skips straight to the account
  view instead of re-showing the setup form).
- `aissee/index.html` page shell built: header with brand + language
  selector, `t()`/`LANG` translation system (en/hi, default hi), Sign
  In/Sign Up tabs, Supabase Auth wiring (email+password, Google
  Sign-In), client-side validation, post-auth account card with Sign
  Out and a "Verify Worker Auth" button that calls the Worker's
  `/whoami`. Verified at 375px mobile width: language switch re-renders
  without reload and correctly loads/unloads Noto Sans; tab switching;
  email/password validation blocks bad input before any Supabase call;
  touch targets ≥44px, input font 16px, `touch-action: manipulation`
  all confirmed via computed styles. Email/password sign-up/sign-in
  itself remains unverified with a real account (Google Sign-In was
  used for the full end-to-end test instead — see below); the code
  path is identical in shape to the verified Google one (same
  `state.session` handling, same `/whoami` call).
- Google Sign-In fully working end-to-end, real user verified. Uses a
  dedicated Google Cloud project (`examsindia`, app name "Exams India"
  — domain-wide, not "AISSEE", matching the shared-identity decision
  below) rather than an existing project that had unrelated "Claude
  Drive" branding on its shared OAuth consent screen. Consent screen
  published to production (no Google verification required: single
  domain, no logo, only email/profile/openid scopes). Implementation
  uses Google Identity Services (GSI) client-side + `signInWithIdToken`
  rather than Supabase's `signInWithOAuth` redirect flow — the redirect
  flow routes through Supabase's own callback domain
  (`knkmcpbyrgrbgpriztnj.supabase.co`), which Google surfaces to users
  on the permission-grant screen; the ID-token flow keeps everything on
  our own origin instead, at no cost (no Supabase Pro/custom-domain
  needed). Includes proper nonce handling (SHA-256 hashed nonce to GSI,
  raw nonce to Supabase) since nonce checks aren't skipped. Fully
  completed by a real user (a Google account distinct from the admin's)
  — signed in successfully, then called `/whoami` and got back
  `HTTP 200` with the correct email, Supabase user id, and
  `exam_code: "aissee"`. This is the full chain verified end-to-end:
  Google Sign-In → Supabase-issued JWT → Worker's JWKS verification →
  correct response. Client secret is regenerate-only after creation
  (Google never shows it twice); exactly one active secret exists after
  cleanup.
- One-time "complete your setup" screen live: shown after first
  sign-in if the student hasn't enrolled yet (checked via
  `GET /enrollment`), collecting class entry (toggle buttons, matching
  the tab-button pattern), target completion date (native date input,
  shows an inline non-blocking warning if under `MIN_SCHEDULE_DAYS`
  from today), mobile number, city (free text), and state (hardcoded
  dropdown, 28 states + 8 UTs, duplicated client-side from the Worker's
  list). Field values sync into `state.setupForm` on every input so a
  full-teardown re-render (needed to show/hide the date warning) never
  loses already-typed values. On success, the account view shows an
  enrollment summary instead of the setup form. Schedule-row generation
  (`student_schedules`) is intentionally not wired up yet — no
  `syllabus`/`scheduled_tests` content exists in D1 to schedule against.
- Landing page content added above the sign-in box: static bilingual
  (hi/en) hero, 4-tile "why ExamsIndia" feature grid, 3-step
  how-it-works, and FAQ. Toggled via the existing `lang-hi` CSS class
  mechanic rather than JS re-render, so it's real content in the
  initial HTML (crawlable, no flash-of-empty-content) — the `<html>`
  tag now carries `class="lang-hi"` from the start so pre-JS/no-JS
  visitors correctly see Hindi by default instead of a brief/permanent
  wrong-language flash. Hidden entirely once a user is signed in (not
  relevant to a returning user's own account view). Content is honest
  about what's actually built — free, full syllabus, personalised
  schedule, progress tracking, bilingual — deliberately not copying
  competitor patterns researched for this (sainikguru.com,
  garudsainikacademy.com) that use unverifiable stats ("5000+
  students," "95% success rate") or faculty credentials we don't have.
  `<head>` gained a real meta description, canonical URL, Open Graph
  tags, and `EducationalOrganization` JSON-LD. The single `#lang-select`
  moved out of the app's own header into a sticky top bar spanning both
  the landing and app sections — it used to live only inside the app
  box below all the marketing content, so a visitor had no way to
  switch language without scrolling past the whole landing page first.
  Wired once in `init()` rather than in `attachHandlers()`, since the
  element now persists across every `render()` call instead of being
  torn down and rebuilt with it — leaving it in `attachHandlers()`
  would have stacked a duplicate `change` listener on every re-render.
- `aissee.examsindia.org` live via Cloudflare Pages: project
  `examsindia-aissee` deploys automatically via GitHub Actions +
  Wrangler (`.github/workflows/deploy-pages.yml`, triggers on any push
  touching `aissee/**`; a separate idempotent "ensure project exists"
  step runs first since `wrangler pages deploy` doesn't auto-create the
  project). Custom domain added and active (DNS auto-configured since
  `examsindia.org` is already a Cloudflare zone — activation was
  near-instant, not the worst-case 48h Cloudflare warns about). Verified
  live: page loads correctly at the real domain, and the Worker's CORS
  allowlist now accepts requests from it — confirmed `/whoami` returns a
  proper `401` for an invalid token instead of being CORS-blocked like
  it was from localhost. Deployment used no Cloudflare-GitHub OAuth/App
  connection — deliberately kept on the same Wrangler-via-CI pattern as
  the Worker to avoid granting a new third-party permission.

- Admin console live at `admin.examsindia.org` (`examsindia-admin` Pages
  project, `.github/workflows/deploy-admin.yml`, same idempotent
  "ensure project exists" pattern as the aissee deploy). Google
  Sign-In only (no email/password, no sign-up flow — single-operator
  tool; the seeded superadmin's first Google sign-in auto-provisions
  their Supabase auth user) — verified end-to-end with the real
  superadmin account (`drtyagivet@gmail.com`), including the Google
  Cloud OAuth client's Authorized JavaScript origins update needed for
  the new subdomain. Gated by a new `GET /admin/whoami` Worker route
  backed by `requireAdmin()` (JWT + live `users.role` lookup for
  `admin`/`superadmin`) — a signed-in non-admin account sees "not
  authorized" instead of the console shell. Shell has a left-nav with
  "Syllabus" functional and Exam Config / Test Composition / Student
  Management / Announcements / Messaging stubbed as disabled
  "coming soon" items, so later parts extend the same shell instead of
  rebuilding it.
- Syllabus tab fully working: exam + class-entry selectors (from a new
  `GET /admin/meta` route), a table of chapters ordered by `sort_order`
  with Up/Down reorder (swaps `sort_order` between adjacent rows via two
  `PUT` calls), Edit, and Activate/Deactivate (soft-delete only — hard
  delete isn't safe once `scheduled_tests.chapter_id` starts referencing
  `syllabus` rows). Add/Edit uses a modal form with a repeatable
  topic-heading list. Backed by new Worker routes
  `GET/POST /admin/syllabus` and `PUT /admin/syllabus/:id`, all
  admin-gated and validated (`validateSyllabusInput`) the same way
  `/enrollment` is validated.
- Bulk syllabus import from a local question-bank folder: "Connect
  Folder" opens a native folder picker (`webkitdirectory`), reads
  `_index.json` entirely client-side (never uploads the folder itself —
  only chapter-level metadata: subject/chapter number/chapter name ever
  leaves the browser), and caches it in memory. "Scan & Compare" then
  diffs that against a fresh fetch of the current syllabus by
  `(subject, chapter_number)` and shows new / changed / unchanged counts
  plus chapters that exist in D1 but are no longer in the folder (each
  with an opt-in Deactivate checkbox) — nothing is written until
  "Apply Changes" is clicked. Backed by a new admin-gated
  `POST /admin/syllabus/import` route that upserts via
  `INSERT ... ON CONFLICT(exam_code, class_entry, subject, chapter_number)
  DO UPDATE`, requiring a new unique index on `syllabus` (added in
  `schema/schema.sql`, applied to live D1) to make that upsert possible.
  Verified end-to-end: imported all 66 chapters (5 subjects) of AISSEE
  Class 6 from a real question-bank folder, then re-ran Scan & Compare
  and confirmed it reported 0 new/0 changed/66 unchanged — proving the
  upsert is idempotent rather than duplicating on re-import. Deliberately
  reads the local Google Drive folder (the authoring source) rather than
  R2 (`examsindia-qbank`, the deployment target for actual question
  content, still empty) — see Decisions Log.
- `users` table seeded with the first superadmin
  (`drtyagivet@gmail.com`) directly in `schema/schema.sql`, applied to
  live D1 via the dashboard console.
- AISSEE Class 6 syllabus populated: all 66 chapters across Mathematics
  (17), Intelligence (13), English (19), General Knowledge (4), and
  General Science (13), imported from the question bank via the above.

**Not yet built:**
- R2 question bank content (Class 6 syllabus metadata now exists in D1,
  but the actual question JSON files are still only local — nothing
  uploaded to R2 yet), Class 9 and other exams' syllabus content,
  `scheduled_tests` content and the schedule-generation algorithm
  itself, remaining admin console tabs (Exam Config, Test Composition,
  Student Management, Announcements, Messaging), CBT attempt screen,
  normalisation cron, scheduled D1-to-R2 backup export cron route,
  ability to change exam/class after enrollment (by design requires
  admin intervention per the existing
  decision — now actionable once Student Management ships)

---

## 7. Decisions Log

2026-08-09 — One Supabase project for all exam subdomains, one JWT secret,
  one Worker validates all.
2026-08-09 — One D1 database for entire platform, exam_code scopes all
  queries.
2026-08-09 — One R2 bucket with exam-level prefixes, no per-exam buckets.
2026-08-09 — One Worker handles all subdomains, origin header determines
  exam context.
2026-08-09 — CompetitionHub at app.examsindia.org is independent, never
  touched by this codebase.
2026-08-09 — No fixed module tiers, all students get full content, target
  date drives schedule only.
2026-08-09 — Schedule recalculates on target date change for uncompleted
  tests only.
2026-08-09 — Stratified sampling enforces 30/50/20 difficulty distribution
  on chapter test draws.
2026-08-09 — Two independent normalisation pools: first attempt and last
  attempt, both z-scored.
2026-08-09 — Academic year is normalisation pool boundary, resets February
  after January exam.
2026-08-09 — Difficulty-weighted scoring: easy 1x, medium 1.25x, hard 1.5x.
2026-08-09 — Fixed papers (PYP and mock) rank on first attempt only,
  repeats are practice only.
2026-08-09 — Provisional rank until cohort reaches 50, final after that.
2026-08-09 — One rebase option per student per academic year for
  first-attempt pool.
2026-08-09 — Mobile-first 360px target viewport, 44px touch targets, 16px
  minimum input font.
2026-08-09 — Default language Hindi, English also available at launch,
  Noto Sans for Indic scripts.
2026-08-09 — Student accounts locked to one exam and one class entry at
  registration.
2026-08-09 — Razorpay deferred, enrollment flow built to accept payment
  step without restructuring.
2026-08-09 — Academic year stored as TEXT '2026-27' format.
2026-08-09 — Admin panel within same HTML file, role-gated via D1 user
  role field.
2026-08-10 — Admin panel is the operational control room: exam config,
  test composition/publishing, syllabus, student management,
  normalisation thresholds, announcements, messaging, and (later)
  analytics and pricing all live in D1 rather than hardcoded so
  operational changes don't require a code push.
2026-08-10 — Added `syllabus` table: chapter structure per exam/class,
  read by the schedule generator instead of a hardcoded array.
2026-08-10 — Added `platform_config` key-value table for per-exam
  operational parameters (schedule window, provisional rank threshold,
  academic year reset month, default language, scoring weights); seeded
  with AISSEE defaults. Chosen over adding columns to `exams` repeatedly
  because the parameter set will keep growing.
2026-08-10 — Scoring weights, stratified sampling ratios (30/50/20), CORS
  allowlist, and JWT validation logic stay as constants in code, not in
  `platform_config` — these are security- or integrity-critical and
  mid-cycle changes to scoring weights would invalidate existing
  normalised scores.
2026-08-10 — Secrets boundary fixed before any code is written:
  CLOUDFLARE_API_TOKEN/ACCOUNT_ID as GitHub repo secrets only; Supabase
  JWT secret as a Worker secret via `wrangler secret put`, read only via
  `env.SUPABASE_JWT_SECRET`, never hardcoded or committed; D1 database ID
  and R2 bucket name in `wrangler.toml` (safe to commit, not
  credentials); Supabase Project URL and anon key public in
  `aissee/index.html` by design (Supabase standard architecture, access
  controlled by RLS and Worker JWT validation, not key secrecy).
2026-08-10 — Backup policy set before any code is written: Cloudflare D1
  Time Travel (built-in, automatic, 7–30 day rolling window depending on
  plan) as the fast-recovery layer; daily Cron Trigger exporting D1 to a
  `backups/` prefix in R2 via `wrangler d1 export` as the long-term,
  portable fallback beyond the Time Travel window. Neither replaces the
  other. Scheduled-export Worker route not yet built.
2026-08-10 — Corrected JWT verification design after creating the actual
  Supabase project (`ExamsIndia`, ap-southeast-1): new projects default to
  asymmetric JWT signing keys (ECC P-256 / ES256), not the shared HS256
  secret assumed in the 2026-08-09 auth decision and the earlier
  2026-08-10 secrets-boundary entry. Worker now verifies JWTs against
  Supabase's public JWKS instead of a shared secret. This removes
  `SUPABASE_JWT_SECRET` from the architecture entirely — one fewer Worker
  secret to manage, and no `wrangler secret put` step for auth.
2026-08-10 — External infrastructure provisioned and deploy pipeline
  verified before any application code was written: Supabase project,
  Cloudflare D1 database + R2 bucket/folders, GitHub repo + CI secrets,
  `wrangler.toml` filled in with real bindings, and a placeholder Worker
  pushed through GitHub Actions → Wrangler → Cloudflare to confirm the
  whole chain works. Caught and fixed a real schema bug in the process:
  `platform_config`'s seed INSERT referenced `exam_code='aissee'` via FK
  but no `exams` row existed yet — added an `exams` seed row ahead of it
  in `schema/schema.sql`, verified against the live D1 database via the
  dashboard Console (which accepts a full semicolon-separated multi-
  statement batch in one execute, not just single statements).
2026-08-10 — First real application code: Worker auth/routing skeleton.
  JWT/JWKS verification implemented with native Web Crypto (ECDSA
  P-256/SHA-256 `crypto.subtle.verify`) rather than a library like
  `jose`, matching the project's no-build-step, no-dependency ethos
  established for the frontend. JWKS cached in-memory per Worker isolate
  with a 1-hour TTL rather than fetched on every request. Deployed and
  verified via curl for all negative paths (bad/missing origin, missing
  or malformed token); the valid-token success path is intentionally
  untested until a real signed-up account exists, since creating a test
  account isn't something to do outside the actual sign-up flow.
2026-08-10 — Frontend built via `supabase-js` loaded from esm.sh as an
  ES module import, no bundler, keeping the single-file/no-build-step
  rule intact while still using the official Supabase client rather than
  hand-rolling REST calls. Auth screen validates email format and
  minimum password length client-side before ever calling Supabase, to
  avoid burning API calls on obviously invalid input. Design tokens
  (--ink/--paper/--cream/--accent/--gold/etc.) follow the same CSS
  variable naming convention as CompetitionHub for consistency across
  the founder's apps, but with an independently chosen navy/gold palette
  fitting a Sainik School (military academy) theme — no shared values,
  since no specific palette was mandated for this project.
2026-08-10 — `aissee.examsindia.org` deployed via Cloudflare Pages using
  a second GitHub Actions + Wrangler workflow (deploy-pages.yml),
  reusing the existing CLOUDFLARE_API_TOKEN/ACCOUNT_ID secrets, rather
  than connecting Cloudflare's GitHub App/Git integration to the repo.
  Chosen specifically to avoid granting a new OAuth/App permission when
  an equivalent no-OAuth path already existed via the Worker's deploy
  pattern. `wrangler pages deploy` does not auto-create the Pages
  project on first run (confirmed by a failed first deploy: "Project
  not found"); fixed with a separate `pages project create` step marked
  `continue-on-error: true` so it's a no-op on every subsequent deploy
  once the project exists.
2026-08-10 — Confirmed explicitly (already implied by the shared
  Supabase project decision, but stated plainly now): the user identity
  pool is single and domain-wide, not subdomain-specific. One set of
  credentials (email/password or Google) authenticates a student on any
  exam subdomain, since there's one Supabase Auth project. This is
  identity only — access stays scoped to the student's own `exam_code`/
  `class_entry` from `users`, checked against the D1 record, not
  inferred from whichever subdomain's Origin the request came through.
  A student authenticated on the wrong subdomain for their enrollment
  is denied/shown a not-enrolled state, never served another exam's
  data. Affects the Worker's not-yet-built D1 authorization checks — see
  ARCHITECTURE.md §3.
2026-08-10 — Google OAuth uses a dedicated Google Cloud project
  (`examsindia`), not the pre-existing "My First Project" that already
  had an unrelated OAuth client ("Claude MCP") and shared consent-screen
  branding for something called "Claude Drive". Reusing it was tried
  first and caught live: the Google sign-in consent screen showed "to
  continue to Claude Drive" instead of any ExamsIndia branding, because
  Google's OAuth consent-screen branding is one-per-project, shared
  across every client in that project — editing it in place would have
  changed branding for that unrelated integration too. App name is
  "Exams India" (not "AISSEE — Exams India"), matching the domain-wide
  shared-identity decision above — the consent screen must read
  correctly regardless of which exam subdomain a student signs in from.
  Cleaned up afterward: deleted the wrongly-scoped "ExamsIndia AISSEE"
  client from "My First Project" (left "Claude MCP" untouched), and
  reduced the new client down to one active secret (an extra one was
  generated when the original creation dialog's one-time secret display
  was missed due to a tab-focus issue during setup).
2026-08-10 — Switched Google Sign-In from Supabase's `signInWithOAuth`
  redirect flow to Google Identity Services (GSI) client-side +
  `signInWithIdToken`, after fixing the consent-screen branding still
  left the underlying issue: the redirect flow's `redirect_uri` lives
  on Supabase's domain, so Google's permission-grant screen (a
  different screen from the account-picker one, styled differently)
  showed `knkmcpbyrgrbgpriztnj.supabase.co` regardless of app branding.
  GSI's client-side flow never redirects through Supabase at all — the
  ID token is obtained directly in-page via Google's own SDK, so Google
  shows our own origin throughout. Free (no Supabase Pro/custom-domain
  needed), but real code, not a config change: replaced the custom
  "Continue with Google" button with Google's own rendered button
  (`google.accounts.id.renderButton`, locale-matched to the active
  language) since `prompt()`-triggered One Tap is less reliable across
  browsers post-FedCM. Implemented proper nonce verification (SHA-256
  hash to GSI's `initialize()`, raw value to Supabase) rather than
  using Supabase's `Skip nonce checks` escape hatch. The GSI script tag
  uses `defer` without `async` specifically so it's guaranteed to load
  before our module script runs — `async` would race the two and
  intermittently leave `window.google` undefined when the button first
  tries to render.
2026-08-10 — Fixed a `google.accounts.id.initialize()` "called multiple
  times" warning by ignoring the `INITIAL_SESSION` event from
  `supabase.auth.onAuthStateChange()` — that event fires once
  immediately on subscribe with the session `getSession()` already
  provided, so acting on it caused a redundant second render (and
  second GSI init) on every page load.
2026-08-10 — Full auth chain verified end-to-end with a real user (not
  the admin's own account): Google Sign-In → Supabase-issued JWT →
  Worker's JWKS verification (`/whoami`) → `HTTP 200` with correct
  email, Supabase user id, and `exam_code`. This was the last
  unverified piece of the Worker/auth skeleton built earlier. Verified
  by the user themselves signing in — account creation and consent are
  not actions performed on a user's behalf.
2026-08-10 — Mobile number, city, and state will be collected as part
  of the same one-time "complete your setup" screen as
  exam/class/target-date registration, not a separate profile step —
  avoids a student clicking through two setup flows and avoids
  reshaping a standalone profile screen once enrollment fields join it
  anyway. State is a hardcoded dropdown (28 states + 8 UTs); city is
  free text, not a dropdown (a full India city dataset is large and
  still misses smaller towns). Real SMS OTP verification of the mobile
  number is deferred — format validation only for now. Reasoning: no
  free production-grade option exists (SMS has a real per-message
  telecom cost), and more importantly, TRAI requires DLT registration
  for any business SMS sender in India regardless of provider or
  method — unregistered messages get blocked by carriers, not just
  billed, so neither free trial credits nor a self-hosted
  phone-as-SMS-gateway approach actually solves this. Real
  verification via a DLT-registered gateway (e.g. MSG91) is a future
  paid-tier item, same deferral pattern as Razorpay. See
  ARCHITECTURE.md §5.
2026-08-10 — Admin panel moved from a gated tab inside each exam's own
  HTML file to a standalone console at `admin.examsindia.org`, a separate
  Pages deployment. Supersedes the 2026-08-09 same-file decision. Chosen
  because the Worker/D1/R2 layer is already shared across every exam by
  `exam_code` — a root-level console that can manage any exam from one
  place is a natural fit, and it keeps operator-only code out of the
  student-facing `aissee/index.html` (and every future exam's file)
  entirely rather than growing each one with an admin tab. Root domain
  `examsindia.org` itself was deliberately left free rather than used
  for the console, in case it's needed later for a public multi-exam
  landing page.
2026-08-10 — Admin console auth is Google Sign-In only, no email/password
  and no self-serve sign-up. It's a single-operator tool for now, so the
  email/password sign-up + email-confirmation flow the student app needs
  isn't worth the extra code; Google Sign-In auto-provisions a Supabase
  auth user on first sign-in, and since that email matches a seeded
  `users` row it's immediately recognized as admin/superadmin with no
  separate account-creation step.
2026-08-10 — First superadmin seeded directly in `schema/schema.sql`
  (`drtyagivet@gmail.com`) rather than bootstrapped through the app,
  since nothing could grant that role before any admin tooling existed.
  Applied to live D1 via the dashboard console, same pattern as the
  `mobile_number`/`city`/`state` migration.
2026-08-10 — Syllabus deletion from the admin console is soft-delete only
  (`is_active` toggle), no hard delete. `scheduled_tests.chapter_id` will
  reference `syllabus` rows once test composition ships, so removing a
  row outright risks orphaning references that don't exist yet but will
  soon.
2026-08-10 — Built and verified the one-time setup screen end-to-end:
  Worker's first real D1 reads/writes (`GET`/`POST /enrollment`), the
  frontend form, and a live D1 database check (via the dashboard
  console, not just the app's own report) confirming both
  `student_enrollments` and `users` rows were written correctly by a
  real signed-in user. `users` upsert uses `ON CONFLICT DO UPDATE` on
  `exam_code`/`class_entry` only, not `role` — safe because the
  enrollment-existence check already gates this code path to
  first-time student setup only, so it won't clobber an admin/
  superadmin row's role. Schedule-row generation deliberately excluded
  from this piece — `syllabus` and `scheduled_tests` are both empty in
  D1, so there's nothing yet to generate a schedule against.
2026-08-10 — Syllabus bulk import reads the local Google Drive question-
  bank folder (via the browser's native folder picker) rather than R2.
  R2 (`examsindia-qbank`) is the deployment target for actual question
  content, used only at test-composition time per ARCHITECTURE.md §1,
  and nothing has been uploaded there yet — requiring an R2 upload
  pipeline to exist before today's syllabus could be seeded would be
  backwards for what's a lightweight catalog operation (chapter names/
  order only, not question content). The local folder is the natural
  authoring source; R2 becomes the sync target once Test Composition
  needs to read real question content, at which point an "upload to R2"
  step gets added as its own piece of work, not this one.
2026-08-10 — Syllabus import is upsert-only, never destructive by
  default: re-running it against an unchanged folder updates nothing
  (verified: 0 new/0 changed/66 unchanged on a second run against the
  same folder). Chapters present in D1 but missing from the folder are
  surfaced in the Scan & Compare diff with an opt-in checkbox rather
  than being auto-deactivated — a chapter already referenced by a
  scheduled test shouldn't disappear without the admin explicitly
  choosing that.
2026-08-10 — Added a unique index on
  `syllabus(exam_code, class_entry, subject, chapter_number)` to make
  the import upsert (`INSERT ... ON CONFLICT ... DO UPDATE`) possible.
  Table was empty in live D1 at the time, so the migration couldn't
  fail on a pre-existing duplicate — confirmed via `SELECT COUNT(*)`
  before applying it.

---

## 8. Workflow

Every development part follows this sequence:

1. Open Claude Code with the session-opening prompt from the planning
   layer. Claude Code reads CLAUDE.md, confirms current state, awaits
   instruction.

2. Receive scoped part prompt from planning layer. Paste into Claude Code.
   Claude Code states understanding in two sentences, awaits confirmation
   before writing any code.

3. Claude Code builds the part. Push a wip: commit with the relevant files
   only (e.g. `aissee/index.html`, `worker/worker.js`, `schema/schema.sql`).

4. Verify live at the relevant exam subdomain (e.g.
   https://aissee.examsindia.org). Report back to planning layer.

5. Planning layer reviews. If fixes needed, a fix prompt is generated.
   Repeat steps 3-4 until clean.

6. Planning layer generates a single update prompt with new Current State
   text and any Decisions Log entries.

7. Claude Code updates CLAUDE.md, then runs:
   git add <changed files> CLAUDE.md
   git commit -m "docs: update after part N"
   git push
   Confirms with commit hash.

8. User copies updated CLAUDE.md into project knowledge.

---

## 9. Claude Code Menu

When I write "menu" in Claude Code, respond with exactly this and nothing
else:

1. Continue current part
2. Fix a bug
3. Update CLAUDE.md (Current State + Decisions Log)
4. Push to GitHub

When I write a number, execute that option immediately.

Option 1: Await the next instruction or scoped prompt.

Option 2: State the bug in one sentence and which file you will touch.
Await confirmation before making any change.

Option 3: Await the Current State text and any Decisions Log entries to be
pasted. Write exactly what is provided into CLAUDE.md. Make no other
changes.

Option 4: Run the following and confirm with commit hash:
git add <changed files> CLAUDE.md
git commit -m "docs: update after part"
git push
