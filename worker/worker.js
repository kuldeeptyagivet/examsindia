const ADMIN_ORIGIN = 'https://admin.examsindia.org';

const ALLOWED_ORIGINS = [
  'https://aissee.examsindia.org',
  'https://neet.examsindia.org',
  'https://ncert.examsindia.org',
  ADMIN_ORIGIN,
];

const SUPABASE_PROJECT_URL = 'https://knkmcpbyrgrbgpriztnj.supabase.co';
const JWKS_URL = `${SUPABASE_PROJECT_URL}/auth/v1/.well-known/jwks.json`;
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000;

let cachedJWKS = null;
let cachedJWKSAt = 0;

function corsHeaders(origin) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
  if (ALLOWED_ORIGINS.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

function examCodeFromOrigin(origin) {
  try {
    return new URL(origin).hostname.split('.')[0];
  } catch {
    return null;
  }
}

function base64UrlToBytes(base64Url) {
  const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlToString(base64Url) {
  return new TextDecoder().decode(base64UrlToBytes(base64Url));
}

async function getJWKS() {
  const now = Date.now();
  if (cachedJWKS && now - cachedJWKSAt < JWKS_CACHE_TTL_MS) {
    return cachedJWKS;
  }
  const res = await fetch(JWKS_URL);
  if (!res.ok) {
    throw new Error('jwks_fetch_failed');
  }
  const data = await res.json();
  cachedJWKS = data.keys;
  cachedJWKSAt = now;
  return cachedJWKS;
}

// Verifies a Supabase Auth JWT against Supabase's public JWKS (ES256).
// Returns the decoded payload on success, throws on any failure.
async function verifySupabaseJWT(token) {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('malformed_token');
  }
  const [headerB64, payloadB64, signatureB64] = parts;

  const header = JSON.parse(base64UrlToString(headerB64));
  const payload = JSON.parse(base64UrlToString(payloadB64));

  if (header.alg !== 'ES256') {
    throw new Error('unsupported_alg');
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && payload.exp < now) {
    throw new Error('token_expired');
  }

  const jwks = await getJWKS();
  const jwk = jwks.find((k) => k.kid === header.kid);
  if (!jwk) {
    throw new Error('unknown_kid');
  }

  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );

  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = base64UrlToBytes(signatureB64);

  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    signature,
    signingInput
  );

  if (!valid) {
    throw new Error('invalid_signature');
  }

  return payload;
}

async function authenticate(request) {
  const authHeader = request.headers.get('Authorization') || '';
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) {
    return null;
  }
  try {
    return await verifySupabaseJWT(match[1]);
  } catch {
    return null;
  }
}

const CLASS_ENTRIES_BY_EXAM = {
  aissee: ['class6', 'class9'],
};

const INDIA_STATES = [
  'Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam',
  'Bihar', 'Chandigarh', 'Chhattisgarh', 'Dadra and Nagar Haveli and Daman and Diu',
  'Delhi', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu and Kashmir',
  'Jharkhand', 'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh',
  'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha',
  'Puducherry', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana',
  'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
];

function todayISODate() {
  return new Date().toISOString().slice(0, 10);
}

function validateEnrollmentInput(body, examCode) {
  const validClassEntries = CLASS_ENTRIES_BY_EXAM[examCode] || [];
  if (!validClassEntries.includes(body.class_entry)) {
    return 'invalid_class_entry';
  }
  if (typeof body.target_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.target_date)) {
    return 'invalid_target_date';
  }
  if (body.target_date <= todayISODate()) {
    return 'target_date_not_future';
  }
  if (typeof body.mobile_number !== 'string' || !/^[6-9]\d{9}$/.test(body.mobile_number)) {
    return 'invalid_mobile_number';
  }
  const city = typeof body.city === 'string' ? body.city.trim() : '';
  if (!city || city.length > 100) {
    return 'invalid_city';
  }
  if (!INDIA_STATES.includes(body.state)) {
    return 'invalid_state';
  }
  return null;
}

async function getEnrollment(env, email, examCode) {
  return env.DB.prepare(
    'SELECT * FROM student_enrollments WHERE student_email = ? AND exam_code = ?'
  )
    .bind(email, examCode)
    .first();
}

async function handleGetEnrollment(request, env, examCode) {
  const claims = await authenticate(request);
  if (!claims) {
    return { status: 401, body: { error: 'unauthorized' } };
  }
  const enrollment = await getEnrollment(env, claims.email, examCode);
  return enrollment
    ? { status: 200, body: { enrolled: true, enrollment } }
    : { status: 200, body: { enrolled: false } };
}

async function handlePostEnrollment(request, env, examCode) {
  const claims = await authenticate(request);
  if (!claims) {
    return { status: 401, body: { error: 'unauthorized' } };
  }

  const existing = await getEnrollment(env, claims.email, examCode);
  if (existing) {
    return { status: 409, body: { error: 'already_enrolled', enrollment: existing } };
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return { status: 400, body: { error: 'invalid_json' } };
  }

  const validationError = validateEnrollmentInput(body, examCode);
  if (validationError) {
    return { status: 400, body: { error: validationError } };
  }

  const id = crypto.randomUUID();
  const enrollmentDate = todayISODate();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (email, role, exam_code, class_entry, is_active)
       VALUES (?, 'student', ?, ?, 1)
       ON CONFLICT(email) DO UPDATE SET exam_code = excluded.exam_code, class_entry = excluded.class_entry, is_active = 1`
    ).bind(claims.email, examCode, body.class_entry),
    env.DB.prepare(
      `INSERT INTO student_enrollments
         (id, student_email, exam_code, class_entry, enrollment_date, target_date, mobile_number, city, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      claims.email,
      examCode,
      body.class_entry,
      enrollmentDate,
      body.target_date,
      body.mobile_number,
      body.city.trim(),
      body.state
    ),
  ]);

  const enrollment = await getEnrollment(env, claims.email, examCode);
  return { status: 201, body: { enrolled: true, enrollment } };
}

// ============================================================
// Admin console (admin.examsindia.org)
// ============================================================

async function requireAdmin(request, env) {
  const claims = await authenticate(request);
  if (!claims) return null;
  const user = await env.DB.prepare('SELECT role FROM users WHERE email = ?')
    .bind(claims.email)
    .first();
  if (!user || (user.role !== 'admin' && user.role !== 'superadmin')) {
    return null;
  }
  return { claims, role: user.role };
}

async function isValidExamCode(env, examCode) {
  if (typeof examCode !== 'string' || !examCode) return false;
  const row = await env.DB.prepare('SELECT 1 FROM exams WHERE code = ?').bind(examCode).first();
  return !!row;
}

async function handleAdminWhoami(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin) {
    return { status: 403, body: { error: 'not_authorized' } };
  }
  return { status: 200, body: { email: admin.claims.email, role: admin.role } };
}

async function handleAdminMeta(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin) {
    return { status: 403, body: { error: 'not_authorized' } };
  }
  const { results } = await env.DB.prepare(
    'SELECT code, name, is_active FROM exams ORDER BY code'
  ).all();
  return {
    status: 200,
    body: { exams: results, classEntriesByExam: CLASS_ENTRIES_BY_EXAM },
  };
}

function rowToSyllabusResponse(row) {
  let topicHeadings = [];
  try {
    topicHeadings = row.topic_headings_json ? JSON.parse(row.topic_headings_json) : [];
  } catch {
    topicHeadings = [];
  }
  const { topic_headings_json, ...rest } = row;
  return { ...rest, topic_headings: topicHeadings };
}

async function validateSyllabusInput(body, env) {
  if (!(await isValidExamCode(env, body.exam_code))) {
    return 'invalid_exam_code';
  }
  const validClassEntries = CLASS_ENTRIES_BY_EXAM[body.exam_code] || [];
  if (!validClassEntries.includes(body.class_entry)) {
    return 'invalid_class_entry';
  }
  const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
  if (!subject || subject.length > 100) {
    return 'invalid_subject';
  }
  if (!Number.isInteger(body.chapter_number) || body.chapter_number < 1) {
    return 'invalid_chapter_number';
  }
  const chapterName = typeof body.chapter_name === 'string' ? body.chapter_name.trim() : '';
  if (!chapterName || chapterName.length > 200) {
    return 'invalid_chapter_name';
  }
  if (!Number.isInteger(body.sort_order) || body.sort_order < 0) {
    return 'invalid_sort_order';
  }
  if (!Array.isArray(body.topic_headings) || body.topic_headings.length > 50) {
    return 'invalid_topic_headings';
  }
  for (const heading of body.topic_headings) {
    if (typeof heading !== 'string' || !heading.trim() || heading.length > 200) {
      return 'invalid_topic_headings';
    }
  }
  return null;
}

async function handleGetSyllabus(request, env, url) {
  const admin = await requireAdmin(request, env);
  if (!admin) {
    return { status: 403, body: { error: 'not_authorized' } };
  }
  const examCode = url.searchParams.get('exam_code');
  const classEntry = url.searchParams.get('class_entry');
  if (!(await isValidExamCode(env, examCode))) {
    return { status: 400, body: { error: 'invalid_exam_code' } };
  }
  const validClassEntries = CLASS_ENTRIES_BY_EXAM[examCode] || [];
  if (!validClassEntries.includes(classEntry)) {
    return { status: 400, body: { error: 'invalid_class_entry' } };
  }
  const { results } = await env.DB.prepare(
    'SELECT * FROM syllabus WHERE exam_code = ? AND class_entry = ? ORDER BY sort_order'
  )
    .bind(examCode, classEntry)
    .all();
  return { status: 200, body: { syllabus: results.map(rowToSyllabusResponse) } };
}

async function handlePostSyllabus(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin) {
    return { status: 403, body: { error: 'not_authorized' } };
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return { status: 400, body: { error: 'invalid_json' } };
  }
  const validationError = await validateSyllabusInput(body, env);
  if (validationError) {
    return { status: 400, body: { error: validationError } };
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO syllabus
       (id, exam_code, class_entry, subject, chapter_number, chapter_name, topic_headings_json, is_active, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
  )
    .bind(
      id,
      body.exam_code,
      body.class_entry,
      body.subject.trim(),
      body.chapter_number,
      body.chapter_name.trim(),
      JSON.stringify(body.topic_headings.map((h) => h.trim())),
      body.sort_order
    )
    .run();
  const row = await env.DB.prepare('SELECT * FROM syllabus WHERE id = ?').bind(id).first();
  return { status: 201, body: { syllabus: rowToSyllabusResponse(row) } };
}

async function handlePutSyllabus(request, env, id) {
  const admin = await requireAdmin(request, env);
  if (!admin) {
    return { status: 403, body: { error: 'not_authorized' } };
  }
  const existing = await env.DB.prepare('SELECT * FROM syllabus WHERE id = ?').bind(id).first();
  if (!existing) {
    return { status: 404, body: { error: 'not_found' } };
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return { status: 400, body: { error: 'invalid_json' } };
  }
  const validationError = await validateSyllabusInput(body, env);
  if (validationError) {
    return { status: 400, body: { error: validationError } };
  }
  const isActive = body.is_active ? 1 : 0;
  await env.DB.prepare(
    `UPDATE syllabus SET
       exam_code = ?, class_entry = ?, subject = ?, chapter_number = ?,
       chapter_name = ?, topic_headings_json = ?, sort_order = ?, is_active = ?
     WHERE id = ?`
  )
    .bind(
      body.exam_code,
      body.class_entry,
      body.subject.trim(),
      body.chapter_number,
      body.chapter_name.trim(),
      JSON.stringify(body.topic_headings.map((h) => h.trim())),
      body.sort_order,
      isActive,
      id
    )
    .run();
  const row = await env.DB.prepare('SELECT * FROM syllabus WHERE id = ?').bind(id).first();
  return { status: 200, body: { syllabus: rowToSyllabusResponse(row) } };
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (!ALLOWED_ORIGINS.includes(origin)) {
      return new Response('Forbidden origin', { status: 403 });
    }

    const examCode = examCodeFromOrigin(origin);
    const headers = {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    };
    const url = new URL(request.url);

    if (url.pathname.startsWith('/admin/') && origin !== ADMIN_ORIGIN) {
      return new Response('Forbidden origin', { status: 403 });
    }

    if (url.pathname === '/admin/whoami' && request.method === 'GET') {
      const { status, body } = await handleAdminWhoami(request, env);
      return new Response(JSON.stringify(body), { status, headers });
    }

    if (url.pathname === '/admin/meta' && request.method === 'GET') {
      const { status, body } = await handleAdminMeta(request, env);
      return new Response(JSON.stringify(body), { status, headers });
    }

    if (url.pathname === '/admin/syllabus' && request.method === 'GET') {
      const { status, body } = await handleGetSyllabus(request, env, url);
      return new Response(JSON.stringify(body), { status, headers });
    }

    if (url.pathname === '/admin/syllabus' && request.method === 'POST') {
      const { status, body } = await handlePostSyllabus(request, env);
      return new Response(JSON.stringify(body), { status, headers });
    }

    const syllabusIdMatch = url.pathname.match(/^\/admin\/syllabus\/([^/]+)$/);
    if (syllabusIdMatch && request.method === 'PUT') {
      const { status, body } = await handlePutSyllabus(request, env, syllabusIdMatch[1]);
      return new Response(JSON.stringify(body), { status, headers });
    }

    if (url.pathname === '/whoami') {
      const claims = await authenticate(request);
      if (!claims) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers,
        });
      }
      return new Response(
        JSON.stringify({ email: claims.email, sub: claims.sub, exam_code: examCode }),
        { status: 200, headers }
      );
    }

    if (url.pathname === '/enrollment' && request.method === 'GET') {
      const { status, body } = await handleGetEnrollment(request, env, examCode);
      return new Response(JSON.stringify(body), { status, headers });
    }

    if (url.pathname === '/enrollment' && request.method === 'POST') {
      const { status, body } = await handlePostEnrollment(request, env, examCode);
      return new Response(JSON.stringify(body), { status, headers });
    }

    return new Response(
      JSON.stringify({ ok: true, exam_code: examCode }),
      { status: 200, headers }
    );
  },
};
