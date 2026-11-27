// HTTP with a timeout per attempt and bounded retries with exponential backoff
// and jitter on network errors, 429 and 5xx. Retry-After is honoured up to 30 s.

export class HttpError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code ?? null;
  }
}

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {string} url
 * @param {RequestInit} init
 * @param {{timeoutMs?: number, retries?: number, baseMs?: number, fetch?: typeof fetch, sleep?: (ms:number)=>Promise<void>}} [opts]
 * @returns {Promise<Response>}
 */
export async function fetchWithRetry(url, init = {}, opts = {}) {
  const f = opts.fetch ?? globalThis.fetch;
  const retries = opts.retries ?? 3;
  const baseMs = opts.baseMs ?? 500;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const sleep = opts.sleep ?? sleepReal;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await f(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
      await sleep(backoff(attempt, baseMs));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = new HttpError(`HTTP ${res.status}`, res.status);
      if (attempt === retries) return res;
      const ra = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30_000) : backoff(attempt, baseMs);
      await res.body?.cancel().catch(() => {});
      await sleep(wait);
      continue;
    }
    return res;
  }
  const name = lastErr?.name === 'TimeoutError' ? 'timed out' : 'failed';
  throw new HttpError(`request to ${safeOrigin(url)} ${name}: ${lastErr?.message ?? 'unknown error'}`, null, 'network');
}

function backoff(attempt, baseMs) {
  const ms = baseMs * 2 ** attempt;
  return Math.min(ms + Math.floor(Math.random() * baseMs), 15_000);
}

/** Origin only, so error messages never carry query strings with secrets. */
export function safeOrigin(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '<invalid url>';
  }
}

/** Read a response body as text with a byte cap. */
export async function readCapped(res, maxBytes) {
  if (!res.body) return { text: '', truncated: false };
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.length > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  return { text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8'), truncated };
}
