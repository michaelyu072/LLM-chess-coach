import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type ProxyOptions } from 'vite';

// Cross-origin isolation: lets the page use SharedArrayBuffer, which the
// multi-threaded browser Stockfish needs (lila sends the same two headers).
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

const DEFAULT_MODEL = {
  // Highest requests-per-minute on the Gemini API free tier.
  gemini: 'gemini-3.5-flash-lite',
  anthropic: 'claude-opus-5',
  none: '',
};

export default defineConfig(({ command, mode }) => {
  // Reads web/.env and web/.env.local, including non-VITE_ variables. These
  // stay on the dev server: only the booleans/strings in `define` reach the page.
  const env = loadEnv(mode, process.cwd(), '');
  const geminiKey = env.GEMINI_API_KEY;
  const anthropicKey = env.ANTHROPIC_API_KEY;
  // Gemini wins when both keys are set, unless COACH_PROVIDER says otherwise.
  const provider = (env.COACH_PROVIDER || (geminiKey ? 'gemini' : anthropicKey ? 'anthropic' : 'none')) as keyof typeof DEFAULT_MODEL;
  // A build for Cloudflare needs no key: the deployed Worker holds it (see
  // wrangler.jsonc and .env.production), and the app calls the same /api path.
  const enabled =
    command === 'build'
      ? provider === 'gemini'
      : provider === 'gemini'
        ? Boolean(geminiKey)
        : provider === 'anthropic'
          ? Boolean(anthropicKey)
          : false;

  // The coach talks to /api/<provider>; these dev-only proxies forward to the
  // provider's API and attach the key, so it never reaches the browser.
  const proxy: Record<string, ProxyOptions> = {};
  if (geminiKey)
    proxy['/api/gemini'] = {
      target: 'https://generativelanguage.googleapis.com',
      changeOrigin: true,
      rewrite: path => path.replace(/^\/api\/gemini/, ''),
      headers: { 'x-goog-api-key': geminiKey },
    };
  if (anthropicKey)
    proxy['/api/anthropic'] = {
      target: 'https://api.anthropic.com',
      changeOrigin: true,
      rewrite: path => path.replace(/^\/api\/anthropic/, ''),
      headers: { 'x-api-key': anthropicKey },
    };

  return {
    plugins: [react()],
    define: {
      __COACH_PROVIDER__: JSON.stringify(enabled ? provider : 'none'),
      __COACH_MODEL__: JSON.stringify(env.COACH_MODEL || DEFAULT_MODEL[provider] || ''),
      __COACH_EFFORT__: JSON.stringify(env.COACH_EFFORT || 'medium'),
    },
    server: {
      port: 5173,
      headers: isolation,
      proxy,
    },
    preview: { headers: isolation },
  };
});
