// GitHub Actions source. Fetches the logs of the failed jobs of one run through
// the REST API. Only owner, repo, run id and attempt are taken from the user's
// URL, the request host is always the configured API base.
import { fetchWithRetry, readCapped, HttpError } from './http.js';

const MAX_TOTAL = 20 * 1024 * 1024;

export class GitHubError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GitHubError';
  }
}
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

/**
 * Accepts https://github.com/OWNER/REPO/actions/runs/ID[/attempts/N][/job/JOB]
 * or OWNER/REPO:ID.
 */
export function parseRunRef(ref) {
  const s = String(ref ?? '').trim();
  let m = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)(?:\/attempts\/(\d+))?(?:\/job\/(\d+))?\/?(?:[?#].*)?$/.exec(s);
  if (!m) m = /^([^/\s]+)\/([^/\s:]+):(\d+)$/.exec(s);
  if (!m) throw new GitHubError(`cannot read a GitHub Actions run from "${s.slice(0, 120)}". Use https://github.com/OWNER/REPO/actions/runs/ID or OWNER/REPO:ID`);
  const [, owner, repo, runId, attempt, jobId] = m;
  if (!NAME.test(owner) || !NAME.test(repo)) throw new GitHubError('owner or repository name has unexpected characters');
  return { owner, repo, runId, attempt: attempt ? Number(attempt) : null, jobId: jobId ?? null };
}

/**
 * @param {{owner:string, repo:string, runId:string, attempt:number|null, jobId:string|null}} ref
 * @param {{token?: string, apiBase?: string, fetch?: typeof fetch, timeoutMs?: number, sleep?: Function}} opts
 */
export async function fetchRunLogs(ref, opts = {}) {
  const apiBase = (opts.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
  if (!/^https:\/\//.test(apiBase) && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(apiBase)) {
    throw new GitHubError('GITHUB_API_URL must be an https URL');
  }
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'ci-medic',
  };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const http = { fetch: opts.fetch, timeoutMs: opts.timeoutMs ?? 30_000, sleep: opts.sleep };
  const base = `${apiBase}/repos/${ref.owner}/${ref.repo}/actions`;

  const getJson = async (url) => {
    const res = await fetchWithRetry(url, { headers }, http);
    if (!res.ok) throw await apiError(res, opts.token);
    return res.json();
  };

  const run = await getJson(`${base}/runs/${ref.runId}`);
  const attempt = ref.attempt ?? run.run_attempt ?? 1;
  const jobsUrl = ref.attempt
    ? `${base}/runs/${ref.runId}/attempts/${ref.attempt}/jobs?per_page=100`
    : `${base}/runs/${ref.runId}/jobs?filter=latest&per_page=100`;
  const jobsBody = await getJson(jobsUrl);
  let jobs = Array.isArray(jobsBody.jobs) ? jobsBody.jobs : [];
  if (ref.jobId) jobs = jobs.filter((j) => String(j.id) === String(ref.jobId));
  const failed = jobs.filter((j) => j.conclusion === 'failure' || j.conclusion === 'timed_out');
  const chosen = failed.length ? failed : ref.jobId ? jobs : [];
  if (chosen.length === 0) {
    throw new GitHubError(`run ${ref.runId} attempt ${attempt} has no failed job (run conclusion: ${run.conclusion ?? 'unknown'})`);
  }

  const parts = [];
  let total = 0;
  let truncated = false;
  for (const job of chosen.slice(0, 10)) {
    const res = await fetchWithRetry(`${base}/jobs/${job.id}/logs`, { headers, redirect: 'manual' }, http);
    let body;
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location || !/^https:\/\//.test(location)) throw new GitHubError('GitHub returned a log redirect without an https location');
      // The signed URL carries its own authorisation. The token is not forwarded.
      const logRes = await fetchWithRetry(location, { headers: { 'user-agent': 'ci-medic' } }, http);
      if (!logRes.ok) throw new HttpError(`downloading the log of job ${job.id} failed with HTTP ${logRes.status}`, logRes.status);
      body = await readCapped(logRes, MAX_TOTAL - total);
    } else if (res.ok) {
      body = await readCapped(res, MAX_TOTAL - total);
    } else {
      throw await apiError(res, opts.token);
    }
    total += Buffer.byteLength(body.text);
    truncated ||= body.truncated;
    const failedSteps = (job.steps ?? []).filter((s) => s.conclusion === 'failure').map((s) => s.name);
    parts.push(`##[group]ci-medic job: ${job.name}${failedSteps.length ? ` (failed step: ${failedSteps.join(', ')})` : ''}\n${body.text}`);
    if (total >= MAX_TOTAL) break;
  }

  const latestAttempt = run.run_attempt ?? attempt;
  return {
    text: parts.join('\n'),
    truncated,
    meta: {
      owner: ref.owner,
      repo: ref.repo,
      runId: String(ref.runId),
      attempt,
      latestAttempt,
      headSha: typeof run.head_sha === 'string' ? run.head_sha : null,
      htmlUrl: typeof run.html_url === 'string' ? run.html_url : null,
      workflow: typeof run.name === 'string' ? run.name.slice(0, 200) : null,
      jobs: chosen.map((j) => ({ id: j.id, name: String(j.name ?? '').slice(0, 200), conclusion: j.conclusion })),
      // A later attempt of the same run on the same commit succeeded.
      passedOnRerun: latestAttempt > attempt && run.conclusion === 'success',
    },
  };
}

async function apiError(res, token) {
  let message = '';
  try {
    const body = await res.json();
    message = typeof body.message === 'string' ? body.message.slice(0, 200) : '';
  } catch {}
  const hint =
    res.status === 401
      ? ' (check GITHUB_TOKEN)'
      : res.status === 404
        ? token
          ? ' (run not found, or the token cannot read this repository)'
          : ' (run not found, private repositories need GITHUB_TOKEN)'
        : res.status === 403
          ? ' (forbidden or rate limited, the token may need the actions:read permission)'
          : '';
  return new HttpError(`GitHub API returned HTTP ${res.status}${message ? `: ${message}` : ''}${hint}`, res.status);
}
