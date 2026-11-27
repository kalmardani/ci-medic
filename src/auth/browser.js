// Open a URL in the default browser. The URL is always printed as well, so a
// failure here only costs a copy and paste.
import { defaultRunner } from '../proc.js';

export function browserCommand(url, platform = process.platform) {
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  return ['xdg-open', [url]];
}

export async function openBrowser(url, { runner = defaultRunner, platform = process.platform } = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('refusing to open a non http URL');
  const [cmd, args] = browserCommand(parsed.toString(), platform);
  try {
    await runner.run(cmd, args, { timeoutMs: 10_000 });
  } catch {
    // Printing the URL is the fallback.
  }
}
