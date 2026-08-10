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
