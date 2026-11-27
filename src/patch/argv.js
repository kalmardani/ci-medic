// Turn the --verify command string into an argument array. There is no shell:
// no pipes, redirects, command chaining, globbing or variable expansion. Quotes
// group words, a backslash outside quotes is a literal (Windows paths).

export class CommandParseError extends Error {}

/**
 * @param {string} input
 * @returns {string[]}
 */
export function parseCommand(input) {
  const s = String(input ?? '');
  const args = [];
  let cur = '';
  let has = false;
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && (s[i + 1] === '"' || s[i + 1] === '\\')) cur += s[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (has) args.push(cur);
      cur = '';
      has = false;
      continue;
    }
    if ('|&;<>`'.includes(c)) {
      throw new CommandParseError(`"${c}" needs a shell, and ci-medic runs the command without one. Put pipelines in a script and verify with that script`);
    }
    if (c === '$' && /[A-Za-z_{(]/.test(s[i + 1] ?? '')) {
      throw new CommandParseError('variables are not expanded because there is no shell. Write the value directly');
    }
    cur += c;
    has = true;
  }
  if (quote) throw new CommandParseError('unbalanced quote in the command');
  if (has) args.push(cur);
  if (args.length === 0) throw new CommandParseError('the command is empty');
  return args;
}
