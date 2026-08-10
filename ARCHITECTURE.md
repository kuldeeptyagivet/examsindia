# ARCHITECTURE

## 1. Infrastructure Components

- **Cloudflare Pages** — hosts the static frontend. Each exam subdomain (e.g. `aissee.examsindia.org`) is a separate Pages deployment serving a single self-contained HTML file (HTML + CSS + JS, no build step, no framework).
- **Cloudflare Worker** — one Worker serves all exam subdomains. It is the sole API surface: it validates the Supabase JWT on every authenticated request, determines exam context from the request `Origin` header, and reads/writes D1 and R2 on behalf of the client.
- **Cloudflare D1** — one database for the entire platform. Every content-bearing table carries an `exam_code` column so all queries are scoped per exam. No table or query is allowed to mix data across exams.
- **Cloudflare R2** — one bucket, `examsindia-qbank`, holding question bank JSON files organised by exam and class prefix (e.g. `aissee/class6/`, `aissee/class9/`). Used only at test-composition time; published tests are frozen into D1 and no longer depend on R2 at runtime.
- **Supabase Auth** — one Supabase project shared by all exam subdomains. Issues JWTs via email/password and Google OAuth, signed with Supabase's asymmetric signing key (ECC P-256 / ES256 by default on new projects). The Worker validates these JWTs itself by verifying against Supabase's public JWKS — no shared secret, no Supabase SDK call, no round-trip to Supabase at request time.
- **Razorpay** — not yet integrated. Reserved as a future step in the enrollment flow once monetisation begins.

`app.examsindia.org` (CompetitionHub) is a separate, independently authenticated product (Cloudflare Access) and is entirely out of scope for this codebase — no shared infrastructure, no shared code, no references.

## 2. Request Data Flow

1. Student loads `https://<exam>.examsindia.org` — a single HTML file served from that exam's Cloudflare Pages deployment.
2. Student authenticates via Supabase Auth (email/password or Google OAuth) directly from the browser. Supabase returns a JWT.
3. The frontend calls the shared Worker (a fixed API origin) for all data operations, attaching the JWT as a `Bearer` token and relying on the browser's `Origin` header to identify which exam subdomain is calling.
4. The Worker:
   a. Validates the JWT signature against Supabase's public JWKS (cached in-memory) and checks expiry.
   b. Checks the request `Origin` against the CORS allowlist and derives `exam_code` from it.
   c. Looks up the caller's role/enrollment in D1 (`users`, `student_enrollments`) to authorize the specific operation.
   d. Reads or writes D1 (enrollments, schedules, attempts, tests) and, only during admin test composition, R2 (question bank JSON).
5. The Worker returns JSON. The frontend re-renders the relevant view client-side (no page reload).

No Cloudflare Access is involved anywhere in this flow — Supabase JWT validation in the Worker is the entire auth boundary.

## 3. CORS and JWT Auth Flow

- The Worker maintains a static `ALLOWED_ORIGINS` allowlist (one entry per exam subdomain). Requests from origins outside this list are rejected before any auth or DB work happens.
- Every authenticated endpoint requires `Authorization: Bearer <supabase_jwt>`.
- Supabase signs Auth JWTs with an asymmetric key (ECC P-256 / ES256 by default on new projects — this superseded the older shared HS256 secret model). The Worker verifies the JWT signature against Supabase's public JWKS, fetched from `https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json` and cached in-memory for the life of the Worker instance so most requests don't trigger a fetch. Because the JWKS is public by design, no Worker secret is needed for JWT verification — this avoids a round-trip to Supabase on every request without requiring any shared credential.
- On success, the Worker extracts the student's email/subject claim and cross-references it against `users` and `student_enrollments` in D1 to determine role (`student` / `admin` / `superadmin`) and exam/class scope.
- A student's requests are always implicitly scoped to their own `exam_code` and `class_entry` as recorded at registration; the Worker enforces this regardless of what the client claims.
- Adding a new exam subdomain requires only appending its origin to `ALLOWED_ORIGINS` and deploying a new Pages site — no changes to auth, D1, or the Worker's routing logic.

## 4. Two-Pool Normalisation System

Chapter tests use difficulty-weighted scoring at submission time:

- Easy: face value marks (1x)
- Medium: 1.25x marks
- Hard: 1.5x marks

The result is stored as `weighted_score` on the attempt record immediately.

A daily cron trigger then normalises scores within a pool using a z-score:

```
normalised = 50 + 10 * (weighted_score - mean) / stdDev
```

This yields a distribution with mean 50 and standard deviation 10.

**Pool boundary**: exam_code + class_entry + chapter_id + academic_year. All attempts sharing these four values form one normalisation pool.

**Two independent pools per chapter test:**

- **Pool 1 (first attempt)** — exactly one row per student: their `is_first_attempt = 1` attempt. Normalised into `normalised_score_pool1`, ranked into `rank_pool1`. Displayed as "Entry Level Standing."
- **Pool 2 (last attempt)** — exactly one row per student: their `is_latest_attempt = 1` attempt. Normalised into `normalised_score_pool2`, ranked into `rank_pool2`. Displayed as "Current Preparation Level."

Every student appears in both pools exactly once, so cohort size (`cohort_size`) is identical across both pools for a given chapter/academic year. When a student submits a new attempt, their previous `is_latest_attempt` row is demoted to 0 and the new row becomes 1 — Pool 2 membership shifts, Pool 1 never changes (except via rebase).

**Fixed papers** (previous year papers, mock tests — `allow_repeat_rank = 0` on `scheduled_tests`) rank only on the first attempt. Later attempts are stored with `is_practice_only = 1` and no rank fields populated.

**Provisional vs. final**: `rank_provisional = 1` until a pool's cohort size reaches 50 attempts, after which ranks in that pool are labelled final.

**Rebase**: once per academic year per student (`rebase_used` on `student_enrollments`), a student may flag one chapter (`rebase_chapter_id`) to promote their most recent attempt into the first-attempt pool, demoting the original first attempt out of it. This only affects Pool 1 membership for that chapter.

## 5. Schedule Generation Algorithm

At registration, a student selects exam, class entry level, and a target completion date. There are no fixed module tiers — every student gets the complete syllabus (all chapter tests, all previous year papers, all mock tests) for their exam/class. The target date is the only scheduling parameter.

**Initial generation:**
1. Enumerate the complete content set for the student's `exam_code` + `class_entry` from `scheduled_tests`.
2. Order it: chapter tests first (in syllabus order), then previous year papers, then mock tests last, ending in the final weeks before the target date.
3. Distribute this ordered list evenly across the days between enrollment date and target date.
4. Insert one row per planned test into `student_schedules` with a `planned_date`.
5. If the target date is less than the exam's configured `min_schedule_days` (default 30, per-exam via `exams.min_schedule_days`) away, warn the student that the schedule will be intensive, but allow them to proceed if confirmed.

**Rescheduling on target date change:**
1. Partition the student's `student_schedules` rows into completed (`is_completed = 1`) and not-yet-completed.
2. Leave completed rows untouched entirely — their `planned_date` never changes.
3. Take the remaining not-yet-completed rows (preserving their existing chapter → PYP → mock order) and redistribute them evenly across the days between *today* and the new target date.
4. Update `planned_date` on those rows and stamp `last_schedule_generated_at` on the enrollment.

This single algorithm handles both compression (earlier target date) and expansion (later target date) — only the redistribution window changes.

## 6. Academic Year Boundary Logic

- Academic year is stored as `TEXT` in the form `'2026-27'`.
- Each exam's `academic_year_start_month` (on `exams`) defines when a new academic year begins for normalisation purposes — for AISSEE this is February, immediately after the January entrance exam.
- All normalisation pools are scoped by academic year, so scores from one exam cycle never mix with the next. Cohort size resets to zero at the start of each academic year.
- Rebase eligibility (`rebase_used`) also resets per academic year, per student.

## 7. Cron Trigger Responsibilities

A daily Cloudflare Cron Trigger invokes a Worker route responsible for:

1. For every (exam_code, class_entry, chapter_id, academic_year) combination with attempts since the last run, recompute mean and standard deviation of `weighted_score` separately for Pool 1 (first-attempt rows) and Pool 2 (latest-attempt rows).
2. Write `normalised_score_pool1` / `normalised_score_pool2` and `rank_pool1` / `rank_pool2` back onto the relevant `aissee_attempts` rows.
3. Update `cohort_size` on affected rows and flip `rank_provisional` to 0 once a pool crosses 50 attempts.
4. Leave `is_practice_only = 1` rows (repeat attempts on fixed papers) untouched — they never receive rank fields.

## 8. Backup and Recovery Policy

Two layers, covering different fault windows:

1. **Cloudflare D1 Time Travel** — built-in, automatic point-in-time
   recovery with no setup required. Every write to D1 is retained on a
   rolling window (30 days on Workers Paid, 7 days on Free), and the
   database can be restored to any minute within that window via
   `wrangler d1 time-travel restore`. This is the first response to an
   operational mistake (bad admin action, faulty migration, accidental
   delete) noticed shortly after it happens.
2. **Scheduled exports to R2** — a daily Cloudflare Cron Trigger invokes a
   Worker route that runs `wrangler d1 export` and writes the resulting
   SQL dump to a `backups/` prefix in the `examsindia-qbank` R2 bucket
   (or a dedicated backups bucket). This exists because Time Travel's
   window is short relative to the academic-year scope of the
   normalisation data — a fault discovered weeks later, after the Time
   Travel window has rolled past it, still needs a recoverable snapshot.
   Exports are immutable, portable SQL files independent of the live
   database, so they survive even a full D1 deletion.

Time Travel is the fast path for recent faults; R2 exports are the
long-term, portable fallback. Neither replaces the other. Export
retention (how many days of dumps to keep in R2 before pruning) is an
operational parameter, not a structural one.

## 9. Extensibility Pattern for New Exams

Adding a new exam (e.g. NEET, NCERT) requires only:

1. A new row in the `exams` table.
2. A new R2 prefix under `examsindia-qbank/` with question bank JSON files.
3. A new subdomain added to the Worker's `ALLOWED_ORIGINS` CORS allowlist.
4. A new Cloudflare Pages deployment for the subdomain's single-file frontend.

No new database, no new Worker, no new Supabase project — the platform's D1, R2 bucket, Worker, and Auth project are shared and scoped entirely by `exam_code`.
