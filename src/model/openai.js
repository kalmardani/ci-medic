// OpenAI compatible chat completions adapter. Works with hosted endpoints and
// local servers that speak the same wire format.
import { fetchWithRetry, readCapped } from '../http.js';

export function createOpenAIAdapter({ baseUrl, model, maxTokens, timeoutMs, auth, fetch }) {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  return {
    name: 'openai',
    model,
    async complete({ system, user }) {
      const body = {
        model,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      };
      const send = async (force) => {
        const headers = { 'content-type': 'application/json', 'user-agent': 'ci-medic' };
        const token = await auth.bearer({ forceRefresh: force });
        if (token) headers.authorization = `Bearer ${token}`;
        return fetchWithRetry(url, { method: 'POST', headers, body: JSON.stringify(body) }, { fetch, timeoutMs });
      };
      let res = await send(false);
      if (res.status === 401 && auth.canRefresh) res = await send(true);
      if (!res.ok) throw await providerError('openai', res);
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text !== 'string') throw new Error('openai response has no message content');
      return {
        text,
        model: typeof data.model === 'string' ? data.model : model,
        usage: { inputTokens: data.usage?.prompt_tokens ?? null, outputTokens: data.usage?.completion_tokens ?? null, costUsd: null },
        truncated: data?.choices?.[0]?.finish_reason === 'length',
      };
    },
  };
}

export async function providerError(name, res) {
  let code = '';
  try {
    const { text } = await readCapped(res, 4096);
    const j = JSON.parse(text);
    code = j?.error?.type || j?.error?.code || j?.type || '';
  } catch {}
  const hint = res.status === 401 || res.status === 403 ? ', check the key or token' : '';
  return new Error(`${name} returned HTTP ${res.status}${code ? ` (${String(code).slice(0, 60)})` : ''}${hint}`);
}
