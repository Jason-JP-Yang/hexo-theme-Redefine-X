/**
 * Giscus CORS Proxy — Cloudflare Worker
 *
 * Proxies requests to giscus.app API with proper CORS headers.
 * giscus.app only allows CORS from its own origin (https://giscus.app).
 * This worker adds your blog's origin to Access-Control-Allow-Origin.
 *
 * Deployment:
 *   1. Create a Cloudflare Workers account (free tier: 100k req/day)
 *   2. Install Wrangler CLI: npm install -g wrangler
 *   3. wrangler login
 *   4. wrangler deploy
 *
 * After deployment, set the worker URL in _config.redefine-x.yml:
 *   comment.config.giscus.proxy: https://<your-worker>.workers.dev
 */

const GISCUS_ORIGIN = 'https://giscus.app';

// Allowed blog origins — add your domain(s) here
const ALLOWED_ORIGINS = [
  'https://blog.jason-yang.top',
  'http://localhost:4000',       // hexo server local dev
];

// Only proxy these API paths (security: don't proxy arbitrary giscus pages)
const ALLOWED_PATHS = [
  '/api/discussions',
  '/api/discussions/categories',
  '/api/oauth/token',
];

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    // --- CORS preflight ---
    if (request.method === 'OPTIONS') {
      return handlePreflight(origin);
    }

    // --- Validate path ---
    const path = url.pathname;
    if (!ALLOWED_PATHS.some(p => path.startsWith(p))) {
      return new Response('Not Found', { status: 404 });
    }

    // --- Build target URL ---
    const targetUrl = GISCUS_ORIGIN + path + url.search;

    // --- Forward request to giscus.app ---
    const headers = new Headers();
    // Copy safe headers from the original request
    for (const key of ['content-type', 'accept']) {
      const val = request.headers.get(key);
      if (val) headers.set(key, val);
    }
    // Copy authorization if present (for authenticated token exchange)
    const auth = request.headers.get('authorization');
    if (auth) headers.set('Authorization', auth);

    const init = {
      method: request.method,
      headers,
    };

    // Forward body for POST requests
    if (request.method === 'POST') {
      init.body = await request.text();
    }

    let response;
    try {
      response = await fetch(targetUrl, init);
    } catch (err) {
      return new Response(JSON.stringify({ error: 'Proxy fetch failed' }), {
        status: 502,
        headers: corsHeaders(origin),
      });
    }

    // --- Return response with CORS headers ---
    const responseHeaders = new Headers(response.headers);
    // Override giscus.app's restrictive CORS with our permissive one
    if (ALLOWED_ORIGINS.includes(origin)) {
      responseHeaders.set('Access-Control-Allow-Origin', origin);
    } else {
      responseHeaders.set('Access-Control-Allow-Origin', ALLOWED_ORIGINS[0]);
    }
    responseHeaders.set('Access-Control-Allow-Credentials', 'true');
    // Remove any existing CORS headers from giscus.app to avoid conflicts
    responseHeaders.delete('Access-Control-Allow-Methods');
    responseHeaders.delete('Access-Control-Allow-Headers');

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  },
};

function handlePreflight(origin) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(origin),
  });
}

function corsHeaders(origin) {
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}
