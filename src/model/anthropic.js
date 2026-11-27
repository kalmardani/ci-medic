// Messages API adapter. With an API key it sends x-api-key; with OAuth (for a
// gateway that accepts bearer tokens) it sends Authorization: Bearer.
import { fetchWithRetry } from '../http.js';
import { providerError } from './openai.js';

export function createAnthropicAdapter({ baseUrl, model, maxTokens, timeoutMs, auth, fetch }) {
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/messages`;
  return {
    name: 'anthropic',
    model,
    async complete({ system, user }) {
      const body = { model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] };
      const send = async (force) => {
        const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'user-agent': 'ci-medic' };
        if (auth.kind === 'api-key') headers['x-api-key'] = await auth.bearer({});
        else headers.authorization = `Bearer ${await auth.bearer({ forceRefresh: force })}`;
        return fetchWithRetry(url, { method: 'POST', headers, body: JSON.stringify(body) }, { fetch, timeoutMs });
      };
      let res = await send(false);
      if (res.status === 401 && auth.canRefresh) res = await send(true);
      if (!res.ok) throw await providerError('anthropic', res);
      const data = await res.json();
      const text = Array.isArray(data?.content) ? data.content.filter((b) => b.type === 'text').map((b) => b.text).join('') : null;
      if (typeof text !== 'string' || !text) throw new Error('anthropic response has no text content');
      return {
        text,
        model: typeof data.model === 'string' ? data.model : model,
        usage: { inputTokens: data.usage?.input_tokens ?? null, outputTokens: data.usage?.output_tokens ?? null, costUsd: null },
        truncated: data.stop_reason === 'max_tokens',
      };
    },
  };
}
