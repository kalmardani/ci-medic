// Fake adapter for tests. Scripted responses, no network. Each response is a
// string, an object (sent as JSON), a function of the request, or {throw: msg}.
import fs from 'node:fs';

export function createFakeAdapter({ responses = [], model = 'fake-1' } = {}) {
  const requests = [];
  let i = 0;
  return {
    name: 'fake',
    model,
    requests,
    async complete(req) {
      requests.push(req);
      if (i >= responses.length) throw new Error('fake adapter has no scripted response left');
      let r = responses[i++];
      if (typeof r === 'function') r = r(req);
      if (r && typeof r === 'object' && 'throw' in r) throw new Error(String(r.throw));
      const text = typeof r === 'string' ? r : JSON.stringify(r);
      return { text, model, usage: { inputTokens: Math.ceil((req.system.length + req.user.length) / 4), outputTokens: Math.ceil(text.length / 4), costUsd: 0 }, truncated: false };
    },
  };
}

export function loadFakeResponses(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(data)) throw new Error('CI_MEDIC_FAKE_RESPONSES must point to a JSON array');
  return data;
}
