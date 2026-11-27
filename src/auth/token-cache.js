// OAuth token cache in the per user config directory. The file is written
// atomically with mode 0600 where the OS supports it. Token values are never
// printed; callers get them only through `get`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

export function configDir(env = process.env, platform = process.platform) {
  if (env.CI_MEDIC_CONFIG_DIR) return path.resolve(env.CI_MEDIC_CONFIG_DIR);
  const home = os.homedir();
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'ci-medic');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'ci-medic');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'ci-medic');
}

export function cacheKey({ tokenUrl, clientId, scope }) {
  return createHash('sha256').update(`${tokenUrl}\n${clientId}\n${scope ?? ''}`).digest('hex').slice(0, 16);
}

export function createTokenCache(dir = configDir()) {
  const file = path.join(dir, 'tokens.json');

  function readAll() {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch {
      return {};
    }
  }

  function writeAll(data) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `.tokens.${randomBytes(4).toString('hex')}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {}
    fs.renameSync(tmp, file);
  }

  return {
    file,
    get(key) {
      const entry = readAll()[key];
      return entry && typeof entry.access_token === 'string' ? entry : null;
    },
    set(key, entry) {
      const all = readAll();
      all[key] = entry;
      writeAll(all);
    },
    remove(key) {
      const all = readAll();
      if (!(key in all)) return false;
      delete all[key];
      if (Object.keys(all).length === 0) {
        try {
          fs.unlinkSync(file);
        } catch {}
      } else writeAll(all);
      return true;
    },
    /** File mode as an octal string, or null where the OS has no POSIX modes. */
    mode() {
      if (process.platform === 'win32') return null;
      try {
        return (fs.statSync(file).mode & 0o777).toString(8);
      } catch {
        return null;
      }
    },
  };
}
