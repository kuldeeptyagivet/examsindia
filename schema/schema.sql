-- ExamsIndia platform D1 schema
-- One D1 database for the entire platform. All content tables carry an
-- exam_code column to scope queries per exam. No data crosses between exams.

-- ============================================================
-- exams
-- ============================================================
CREATE TABLE exams (
  code                        TEXT PRIMARY KEY,
  name                        TEXT NOT NULL,
  exam_date                   TEXT,
  academic_year_start_month   INTEGER,
  min_schedule_days           INTEGER DEFAULT 30,
  marking_scheme_json         TEXT,
  is_active                   INTEGER DEFAULT 1,
  created_at                  TEXT DEFAULT (datetime('now'))
);

-- ============================================================
-- student_enrollments
-- ============================================================
CREATE TABLE student_enrollments (
  id                           TEXT PRIMARY KEY,
  student_email                TEXT NOT NULL,
  exam_code                    TEXT NOT NULL,
  class_entry                  TEXT NOT NULL,
  enrollment_date               TEXT NOT NULL,
  target_date                  TEXT NOT NULL,
  mobile_number                TEXT,
  city                         TEXT,
  state                        TEXT,
  last_schedule_generated_at   TEXT,
  rebase_used                  INTEGER DEFAULT 0,
  rebase_chapter_id            TEXT,
  created_at                   TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (exam_code) REFERENCES exams(code)
);

-- ============================================================
-- scheduled_tests
-- ============================================================
CREATE TABLE scheduled_tests (
  id                 TEXT PRIMARY KEY,
  exam_code          TEXT NOT NULL,
  class_entry        TEXT NOT NULL,
  title              TEXT NOT NULL,
  test_type          TEXT NOT NULL,  -- 'chapter' | 'pyp' | 'mock'
  chapter_id         TEXT,
  subject            TEXT,
  release_at         TEXT,
  close_at           TEXT,
  questions_json     TEXT,
  marks_total        INTEGER,
  negative_marking   INTEGER DEFAULT 0,
  allow_repeat_rank  INTEGER DEFAULT 1,
  -- 1 for chapter tests: two-pool ranking applies
  -- 0 for previous year papers and mock tests: first attempt rank only,
  --   subsequent attempts are practice with no rank computed
  is_published       INTEGER DEFAULT 0,
  created_at         TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (exam_code) REFERENCES exams(code)
);

-- ============================================================
-- student_schedules
-- ============================================================
CREATE TABLE student_schedules (
  id                  TEXT PRIMARY KEY,
  student_email       TEXT NOT NULL,
  exam_code           TEXT NOT NULL,
  scheduled_test_id   TEXT NOT NULL,
  planned_date        TEXT NOT NULL,
  completed_at        TEXT,
  is_completed        INTEGER DEFAULT 0,
  created_at          TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (exam_code) REFERENCES exams(code),
  FOREIGN KEY (scheduled_test_id) REFERENCES scheduled_tests(id)
);

-- ============================================================
-- aissee_attempts
-- ============================================================
CREATE TABLE aissee_attempts (
  id                        TEXT PRIMARY KEY,
  student_email             TEXT NOT NULL,
  exam_code                 TEXT NOT NULL,
  class_entry               TEXT NOT NULL,
  scheduled_test_id         TEXT NOT NULL,
  chapter_id                TEXT,
  academic_year             TEXT NOT NULL,   -- e.g. '2026-27'
  attempt_number             INTEGER NOT NULL DEFAULT 1,
  is_first_attempt          INTEGER DEFAULT 0,
  is_latest_attempt         INTEGER DEFAULT 0,
  is_practice_only          INTEGER DEFAULT 0,
  responses_json            TEXT,
  weighted_score             REAL,
  normalised_score_pool1    REAL,
  normalised_score_pool2    REAL,
  rank_pool1                INTEGER,
  rank_pool2                INTEGER,
  cohort_size                INTEGER,
  rank_provisional          INTEGER DEFAULT 1,
  time_taken_seconds        INTEGER,
  time_per_question_json    TEXT,
  tab_switch_count           INTEGER DEFAULT 0,
  time_away_seconds         INTEGER DEFAULT 0,
  submitted_at               TEXT,
  created_at                 TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (exam_code) REFERENCES exams(code),
  FOREIGN KEY (scheduled_test_id) REFERENCES scheduled_tests(id)
);

-- ============================================================
-- users
-- ============================================================
CREATE TABLE users (
  email        TEXT PRIMARY KEY,
  role         TEXT DEFAULT 'student',  -- 'student' | 'admin' | 'superadmin'
  exam_code    TEXT,
  class_entry  TEXT,
  is_active    INTEGER DEFAULT 1,
  created_at   TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (exam_code) REFERENCES exams(code)
);

-- ============================================================
-- announcements
-- ============================================================
CREATE TABLE announcements (
  id          TEXT PRIMARY KEY,
  exam_code   TEXT,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  is_active   INTEGER DEFAULT 1,
  created_at  TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (exam_code) REFERENCES exams(code)
);

-- ============================================================
-- messages
-- ============================================================
CREATE TABLE messages (
  id          TEXT PRIMARY KEY,
  exam_code   TEXT,
  from_email  TEXT NOT NULL,
  to_email    TEXT NOT NULL,
  subject     TEXT,
  body        TEXT NOT NULL,
  thread_id   TEXT,
  is_read     INTEGER DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (exam_code) REFERENCES exams(code)
);

-- ============================================================
-- syllabus
-- Chapter structure per exam and class. The schedule generator reads
-- this table rather than any hardcoded array, so adding a chapter means
-- inserting a row, not a code push.
-- ============================================================
CREATE TABLE syllabus (
  id                    TEXT PRIMARY KEY,
  exam_code             TEXT NOT NULL,
  class_entry           TEXT NOT NULL,
  subject               TEXT NOT NULL,
  chapter_number        INTEGER NOT NULL,
  chapter_name          TEXT NOT NULL,
  topic_headings_json   TEXT,
  is_active             INTEGER DEFAULT 1,
  sort_order            INTEGER NOT NULL,
  FOREIGN KEY (exam_code) REFERENCES exams(code)
);

-- ============================================================
-- platform_config
-- Key-value store for per-exam operational parameters the admin panel
-- controls (schedule window, provisional rank threshold, academic year
-- reset month, default language, scoring weights, etc). The Worker reads
-- these at request time and caches them for the duration of the request.
-- Adding a new configurable parameter means inserting a row, not
-- touching code. Security-critical constants (JWT validation, CORS
-- allowlist, stratified sampling ratios) are NOT stored here — they stay
-- in code.
-- ============================================================
CREATE TABLE platform_config (
  exam_code     TEXT NOT NULL,
  config_key    TEXT NOT NULL,
  config_value  TEXT NOT NULL,
  updated_at    TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (exam_code, config_key),
  FOREIGN KEY (exam_code) REFERENCES exams(code)
);

-- Seed the AISSEE exam row (platform_config.exam_code has a FK to exams.code)
INSERT INTO exams (code, name, academic_year_start_month, min_schedule_days) VALUES
  ('aissee', 'AISSEE', 2, 30);

-- Seed defaults for AISSEE
INSERT INTO platform_config (exam_code, config_key, config_value) VALUES
  ('aissee', 'min_schedule_days', '30'),
  ('aissee', 'provisional_rank_threshold', '50'),
  ('aissee', 'academic_year_reset_month', '2'),
  ('aissee', 'default_language', 'hi'),
  ('aissee', 'easy_weight', '1.0'),
  ('aissee', 'medium_weight', '1.25'),
  ('aissee', 'hard_weight', '1.5');

-- ============================================================
-- Indexes
-- ============================================================
CREATE INDEX idx_enrollments_exam_code ON student_enrollments(exam_code);
CREATE INDEX idx_enrollments_student_email ON student_enrollments(student_email);
CREATE INDEX idx_enrollments_class_entry ON student_enrollments(class_entry);

CREATE INDEX idx_scheduled_tests_exam_code ON scheduled_tests(exam_code);
CREATE INDEX idx_scheduled_tests_class_entry ON scheduled_tests(class_entry);

CREATE INDEX idx_student_schedules_student_email ON student_schedules(student_email);
CREATE INDEX idx_student_schedules_scheduled_test_id ON student_schedules(scheduled_test_id);
CREATE INDEX idx_student_schedules_planned_date ON student_schedules(planned_date);

CREATE INDEX idx_attempts_exam_code ON aissee_attempts(exam_code);
CREATE INDEX idx_attempts_student_email ON aissee_attempts(student_email);
CREATE INDEX idx_attempts_academic_year ON aissee_attempts(academic_year);
CREATE INDEX idx_attempts_is_first_attempt ON aissee_attempts(is_first_attempt);
CREATE INDEX idx_attempts_is_latest_attempt ON aissee_attempts(is_latest_attempt);
CREATE INDEX idx_attempts_scheduled_test_id ON aissee_attempts(scheduled_test_id);
CREATE INDEX idx_attempts_class_entry ON aissee_attempts(class_entry);

CREATE INDEX idx_users_exam_code ON users(exam_code);

CREATE INDEX idx_announcements_exam_code ON announcements(exam_code);

CREATE INDEX idx_messages_exam_code ON messages(exam_code);
CREATE INDEX idx_messages_to_email ON messages(to_email);
CREATE INDEX idx_messages_thread_id ON messages(thread_id);

CREATE INDEX idx_syllabus_exam_code ON syllabus(exam_code);
CREATE INDEX idx_syllabus_class_entry ON syllabus(class_entry);
