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
├── worker/
│   ├── worker.js
│   └── wrangler.toml
├── schema/
│   └── schema.sql
└── .github/
    └── workflows/
        └── deploy-worker.yml
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

**Admin panel and operational config**: A superadmin-gated tab within the
same single HTML file (role read from D1 `users.role`, same pattern as
CompetitionHub) is the operational control room — exam configuration,
test composition and publishing, syllabus editing, student management,
normalisation thresholds, announcements, messaging, and (later) platform
analytics and pricing. Anything that might change over the platform's
lifetime and shouldn't require a code push lives in D1, not in a
hardcoded array or constant:
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
- D1 schema designed (schema/schema.sql)

**Not yet built:**
- Everything else (frontend, Worker logic, Supabase project setup, D1
  deployment, R2 bucket and question bank content, admin panel, CBT attempt
  screen, scheduling engine, normalisation cron, CI/CD wiring, scheduled
  D1-to-R2 backup export cron route)

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
