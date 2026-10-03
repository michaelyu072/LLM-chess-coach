// Cloudflare Worker for the deployed app.
//
// Static files (the Vite build in dist/) are served by Workers static assets,
// with the COOP/COEP headers Stockfish needs coming from public/_headers.
// Only /api/* reaches this code: /api/gemini/* is the production version of
// the Vite dev proxy. It adds GEMINI_API_KEY (a Wrangler secret, never sent
// to the browser), accepts only the coach's own requests, and caps how many
// Gemini calls each visitor can make so nobody can drain the free-tier quota.
import { DurableObject } from 'cloudflare:workers';

interface Env {
  ASSETS: Fetcher;
  LIMITER: DurableObjectNamespace<VisitorLimiter>;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL: string;
  VISITOR_PER_MINUTE: string;
  VISITOR_PER_DAY: string;
}

const GEMINI_ORIGIN = 'https://generativelanguage.googleapis.com';
// The only calls the coach makes: (streaming) text generation on one model.
const GEMINI_PATH = /^\/api\/gemini\/v1beta\/models\/([\w.-]+):(generateContent|streamGenerateContent)$/;
// A long chat resends its whole history; this is far above what the coach
// needs while still refusing to relay arbitrary uploads.
const MAX_BODY_BYTES = 512 * 1024;

const STATUS_NAMES: Record<number, string> = {
  400: 'INVALID_ARGUMENT',
  403: 'PERMISSION_DENIED',
  404: 'NOT_FOUND',
  405: 'INVALID_ARGUMENT',
  413: 'INVALID_ARGUMENT',
  429: 'RESOURCE_EXHAUSTED',
  503: 'UNAVAILABLE',
};

/** An error in Gemini's own format, so the app's SDK reports it like any API error. */
function apiError(code: number, message: string, headers: HeadersInit = {}): Response {
  return Response.json(
    { error: { code, message, status: STATUS_NAMES[code] ?? 'UNKNOWN' } },
    { status: code, headers: { 'Cache-Control': 'no-store', ...headers } },
  );
}

/**
 * Who counts as one visitor: the client IP, or its /64 for IPv6 (one
 * household or phone typically owns a whole /64 and can rotate within it).
 */
function visitorKey(request: Request): string {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (!ip.includes(':')) return ip;
  const groups = ip.split('::')[0].split(':');
  return `${groups.slice(0, 4).join(':')}::/64`;
}

async function proxyGemini(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== 'POST') return apiError(405, 'Only POST is supported.', { Allow: 'POST' });
  if (!env.GEMINI_API_KEY) return apiError(503, 'The coach is not configured on this deployment (GEMINI_API_KEY is missing).');

  const match = GEMINI_PATH.exec(url.pathname);
  if (!match) return apiError(404, 'Not a coach endpoint.');
  const [, model, method] = match;
  if (model !== env.GEMINI_MODEL) return apiError(403, `This deployment only serves ${env.GEMINI_MODEL}.`);

  // Browsers always send Origin on a POST; requiring our own stops other
  // websites from using this proxy from their visitors' browsers.
  if (request.headers.get('Origin') !== url.origin) return apiError(403, 'Requests must come from the app itself.');

  const declared = Number(request.headers.get('Content-Length') ?? 0);
  if (declared > MAX_BODY_BYTES) return apiError(413, 'Request too large.');
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) return apiError(413, 'Request too large.');

  const limiter = env.LIMITER.get(env.LIMITER.idFromName(visitorKey(request)));
  const verdict = await limiter.hit(Number(env.VISITOR_PER_MINUTE), Number(env.VISITOR_PER_DAY));
  if (!verdict.ok) {
    const message =
      verdict.window === 'minute'
        ? `Visitor limit reached: ${env.VISITOR_PER_MINUTE} coach requests per minute.`
        : `Visitor limit reached: ${env.VISITOR_PER_DAY} coach requests per day.`;
    return apiError(429, message, { 'Retry-After': String(verdict.retryAfter) });
  }

  const upstream = new URL(`/v1beta/models/${model}:${method}`, GEMINI_ORIGIN);
  if (url.searchParams.get('alt') === 'sse') upstream.searchParams.set('alt', 'sse');
  const response = await fetch(upstream, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body,
  });
  // Stream Gemini's reply straight through (the coach renders it as it arrives).
  return new Response(response.body, {
    status: response.status,
    headers: {
      'Content-Type': response.headers.get('Content-Type') ?? 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/gemini/')) return proxyGemini(request, env);
    if (pathname.startsWith('/api/')) return apiError(404, 'Not found.');
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// Per-visitor request counter: one Durable Object per visitor key, so counts
// are exact (no races between Cloudflare locations), using fixed UTC windows.

interface Counts {
  minute: number;
  minuteCount: number;
  day: number;
  dayCount: number;
}

type Verdict = { ok: true } | { ok: false; window: 'minute' | 'day'; retryAfter: number };

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export class VisitorLimiter extends DurableObject<Env> {
  async hit(perMinute: number, perDay: number): Promise<Verdict> {
    const now = Date.now();
    const minute = Math.floor(now / MINUTE_MS);
    const day = Math.floor(now / DAY_MS);
    const c = (await this.ctx.storage.get<Counts>('counts')) ?? { minute, minuteCount: 0, day, dayCount: 0 };
    if (c.minute !== minute) Object.assign(c, { minute, minuteCount: 0 });
    if (c.day !== day) Object.assign(c, { day, dayCount: 0 });

    const secondsUntil = (ms: number) => Math.max(1, Math.ceil((ms - now) / 1000));
    if (c.dayCount >= perDay) return { ok: false, window: 'day', retryAfter: secondsUntil((day + 1) * DAY_MS) };
    if (c.minuteCount >= perMinute) return { ok: false, window: 'minute', retryAfter: secondsUntil((minute + 1) * MINUTE_MS) };

    c.minuteCount++;
    c.dayCount++;
    await this.ctx.storage.put('counts', c);
    // Forget visitors a day after their last request, so storage doesn't grow forever.
    await this.ctx.storage.setAlarm(now + DAY_MS + MINUTE_MS);
    return { ok: true };
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
