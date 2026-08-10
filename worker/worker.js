const ALLOWED_ORIGINS = [
  'https://aissee.examsindia.org',
  'https://neet.examsindia.org',
  'https://ncert.examsindia.org',
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

    return new Response(
      JSON.stringify({ ok: true, exam_code: examCode }),
      { status: 200, headers }
    );
  },
};
