import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  renameSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const CODEX_REMOTE_SOCKET_RELATIVE =
  'app-server-control/app-server-control.sock';

/** macOS caps a Unix socket path at 104 bytes (`sun_path`), and Codex builds its
 *  control socket as `$CODEX_HOME/app-server-control/app-server-control.sock` —
 *  42 bytes of suffix. So the alias home itself must fit in ~61 bytes.
 *
 *  `$TMPDIR` cannot host it: macOS spells it
 *  `/var/folders/xx/<30-char-hash>/T/` (49 bytes) and the alias came out at 121
 *  — LONGER than the 118-byte real home it was introduced to shorten, so every
 *  daemon start failed with `path must be shorter than SUN_LEN`. Root the alias
 *  at a fixed short prefix instead and keep the digest to 8 hex chars: the whole
 *  socket path then lands at 60 bytes with room to spare. */
export const CODEX_REMOTE_HOME_ROOT = join(homedir(), '.mdc');

/** Longest socket path the platform will accept, minus a small safety margin. */
export const CODEX_REMOTE_SOCKET_MAX = 104;

/** Keep the CODEX_HOME spelling short enough for macOS's Unix-socket limit.
 *  `tempRoot` defaults to the short fixed root; callers may override it (tests). */
export function codexRemoteHomePath(
  realHome: string,
  agentId: string,
  durableRoot: string = CODEX_REMOTE_HOME_ROOT
): string {
  const digest = createHash('sha256')
    .update(`${realHome}\0${agentId}`)
    .digest('hex')
    .slice(0, 8);
  return join(durableRoot, digest);
}

export type CodexRemoteHomeResult =
  | { ok: true; home: string }
  | { ok: false; error: string };

/** Move a per-agent Codex home to a genuinely short, durable path.
 *
 * A symlink at the short path is insufficient: Codex canonicalizes CODEX_HOME
 * before it binds the app-server socket, restoring the long hive path and
 * exceeding macOS sun_path. The data must live at the short path. We leave a
 * compatibility symlink at the old hive location so hook installation and
 * session discovery keep one source of truth.
 *
 * Migration is fail-closed. If both locations contain state we do not merge or
 * delete either directory. If the compatibility link cannot be created, the
 * rename is rolled back before returning failure. */
export function ensureCodexRemoteHome(
  realHome: string,
  agentId: string,
  durableRoot: string = CODEX_REMOTE_HOME_ROOT
): CodexRemoteHomeResult {
  const shortHome = codexRemoteHomePath(realHome, agentId, durableRoot);
  if (!codexRemoteSocketFits(shortHome)) {
    return { ok: false, error: `socket path exceeds sun_path: ${shortHome}` };
  }
  try {
    mkdirSync(durableRoot, { recursive: true });
    if (lstatSync(durableRoot).isSymbolicLink()) {
      return { ok: false, error: 'short Codex home root must not be a symbolic link' };
    }
    if (existsSync(realHome)) {
      const realStat = lstatSync(realHome);
      if (realStat.isSymbolicLink()) {
        const target = resolve(dirname(realHome), readlinkSync(realHome));
        if (target !== resolve(shortHome)) {
          return { ok: false, error: 'existing Codex home link targets another location' };
        }
        if (!existsSync(shortHome)
          || lstatSync(shortHome).isSymbolicLink()
          || !statSync(shortHome).isDirectory()) {
          return { ok: false, error: 'short Codex home target is missing' };
        }
        return { ok: true, home: shortHome };
      }
      if (!realStat.isDirectory()) {
        return { ok: false, error: 'existing Codex home is not a directory' };
      }
      if (existsSync(shortHome)) {
        return { ok: false, error: 'both long and short Codex homes contain state' };
      }
      renameSync(realHome, shortHome);
      try {
        symlinkSync(shortHome, realHome, 'dir');
      } catch (error) {
        renameSync(shortHome, realHome);
        return {
          ok: false,
          error: `could not link migrated Codex home: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      return { ok: true, home: shortHome };
    }
    if (!existsSync(shortHome)
      || lstatSync(shortHome).isSymbolicLink()
      || !statSync(shortHome).isDirectory()) {
      return { ok: false, error: 'Codex home is missing at both locations' };
    }
    mkdirSync(dirname(realHome), { recursive: true });
    symlinkSync(shortHome, realHome, 'dir');
    return { ok: true, home: shortHome };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Whether a candidate home yields a control socket the platform can bind. */
export function codexRemoteSocketFits(shortHome: string): boolean {
  return join(shortHome, CODEX_REMOTE_SOCKET_RELATIVE).length < CODEX_REMOTE_SOCKET_MAX;
}

export function codexRemoteEndpoint(shortHome: string): string {
  return `unix://${join(shortHome, CODEX_REMOTE_SOCKET_RELATIVE)}`;
}

/** Global options must precede `resume`, so prepend the endpoint in all cases. */
export function withCodexRemoteArgs(args: string[], endpoint: string): string[] {
  if (args.includes('--remote')) return args;
  return ['--remote', endpoint, ...args];
}
