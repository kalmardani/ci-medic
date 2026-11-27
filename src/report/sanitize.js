// Neutralise untrusted text before it goes into markdown that GitHub renders.
// Outside code spans every markdown and HTML control character is escaped, so
// model or log text cannot create images (an exfiltration channel), links,
// HTML or headings. Mentions are broken with a zero width space.

const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f‪-‮⁦-⁩‎‏]/g;

export function stripControl(s) {
  return String(s ?? '').replace(CONTROL, '');
}

function escapePlain(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/[\\`*_{}[\]()<>#+!|~=:-]/g, (c) => `\\${c}`)
    .replace(/@/g, '@​');
}

/** Escape one line or paragraph of untrusted text. Single backtick spans stay as code. */
export function mdText(s) {
  const text = stripControl(s).replace(/\r?\n/g, ' ');
  const out = [];
  const re = /`([^`\n]{1,200})`/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push(escapePlain(text.slice(last, m.index)));
    out.push(`\`${m[1].replace(/@/g, '@​')}\``);
    last = m.index + m[0].length;
  }
  out.push(escapePlain(text.slice(last)));
  return out.join('');
}

/** Fenced block that untrusted content cannot close. */
export function mdFence(body, lang = '') {
  const s = stripControl(body).replace(/\r\n/g, '\n');
  let longest = 0;
  for (const m of s.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const f = '`'.repeat(Math.max(3, longest + 1));
  return `${f}${lang}\n${s.replace(/\n$/, '')}\n${f}`;
}

/** Terminal safe: no escape sequences or control characters from untrusted text. */
export function termText(s) {
  return String(s ?? '')
    .replace(/\x1b/g, '')
    .replace(CONTROL, '');
}
