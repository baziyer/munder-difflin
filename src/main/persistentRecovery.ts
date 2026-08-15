import { isAbsolute } from 'node:path';
import type { RosterSnapshot } from './roster';

const RECOVERY_SPEC = 'munder-difflin/recover@1';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_REASON = 2_000;
const MAX_COMMAND = 8_192;

export interface PersistentRecoveryRequest {
  spec: typeof RECOVERY_SPEC;
  id: string;
  agentId: string;
  expectedSessionId: string;
  reason: string;
}

export interface PersistentRecoveryRecipe {
  id: string;
  name: string;
  provider?: string;
  cwd: string;
  worktreePath?: string;
  command: string;
  ptyId: string;
  description?: string;
  standingHire?: boolean;
}

interface RegistryAgentLike {
  id?: unknown;
  name?: unknown;
  provider?: unknown;
  sessionId?: unknown;
  archived?: unknown;
  standingHire?: unknown;
}

interface RegistryLike {
  godId?: unknown;
  agents?: unknown;
}

export type RecoveryParseResult =
  | { ok: true; request: PersistentRecoveryRequest }
  | { ok: false; error: string };

export type PersistentRecoveryPlan =
  | {
      ok: true;
      mode: 'restart' | 'restore';
      recipe: PersistentRecoveryRecipe;
      sessionId: string;
    }
  | { ok: false; error: string };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredString(
  value: unknown,
  field: string,
  options: { id?: boolean; max?: number } = {},
): { ok: true; value: string } | { ok: false; error: string } {
  const out = typeof value === 'string' ? value.trim() : '';
  if (!out) return { ok: false, error: `${field} is required` };
  if (options.id && !SAFE_ID.test(out)) return { ok: false, error: `${field} is invalid` };
  if (options.max && out.length > options.max) return { ok: false, error: `${field} is too long` };
  return { ok: true, value: out };
}

/** Parse a request authored by the orchestrator. Deliberately narrow: recovery
 * always targets one existing persistent id and one exact recorded session. */
export function parsePersistentRecoveryRequest(value: unknown): RecoveryParseResult {
  const input = record(value);
  if (!input || input.spec !== RECOVERY_SPEC) {
    return { ok: false, error: `spec must be ${RECOVERY_SPEC}` };
  }
  const id = requiredString(input.id, 'id', { id: true });
  if (!id.ok) return id;
  const agentId = requiredString(input.agentId, 'agentId', { id: true });
  if (!agentId.ok) return agentId;
  const expectedSessionId = requiredString(input.expectedSessionId, 'expectedSessionId', { max: 512 });
  if (!expectedSessionId.ok) return expectedSessionId;
  const reason = requiredString(input.reason, 'reason', { max: MAX_REASON });
  if (!reason.ok) return reason;
  return {
    ok: true,
    request: {
      spec: RECOVERY_SPEC,
      id: id.value,
      agentId: agentId.value,
      expectedSessionId: expectedSessionId.value,
      reason: reason.value,
    },
  };
}

function recipeFrom(value: unknown, expectedId: string): PersistentRecoveryRecipe | null {
  const input = record(value);
  if (!input || input.id !== expectedId) return null;
  const name = requiredString(input.name, 'name', { max: 256 });
  const cwd = requiredString(input.cwd, 'cwd', { max: 4_096 });
  const command = requiredString(input.command, 'command', { max: MAX_COMMAND });
  if (!name.ok || !cwd.ok || !command.ok || !isAbsolute(cwd.value)) return null;
  const worktreePath = typeof input.worktreePath === 'string' && isAbsolute(input.worktreePath.trim())
    ? input.worktreePath.trim()
    : undefined;
  const rawPtyId = typeof input.ptyId === 'string' && SAFE_ID.test(input.ptyId.trim())
    ? input.ptyId.trim()
    : `pty-${expectedId}`;
  return {
    id: expectedId,
    name: name.value,
    cwd: cwd.value,
    command: command.value,
    ptyId: rawPtyId,
    ...(worktreePath ? { worktreePath } : {}),
    ...(typeof input.provider === 'string' && input.provider.trim()
      ? { provider: input.provider.trim() }
      : {}),
    ...(typeof input.description === 'string' && input.description.trim()
      ? { description: input.description.trim() }
      : {}),
  };
}

function findRecipe(roster: RosterSnapshot, agentId: string): PersistentRecoveryRecipe | null {
  for (const slice of [roster.agents, roster.restorable, roster.archived]) {
    for (const item of slice) {
      const recipe = recipeFrom(item, agentId);
      if (recipe) return recipe;
    }
  }
  return null;
}

/** Compare the request with CURRENT registry/roster state before any process is
 * touched. expectedSessionId is the CAS: a delayed request cannot restart a
 * worker that has since moved onto a different session. */
export function planPersistentRecovery(input: {
  request: PersistentRecoveryRequest;
  registry: RegistryLike;
  roster: RosterSnapshot;
  livePtyOwners: ReadonlyMap<string, string>;
}): PersistentRecoveryPlan {
  const { request, registry, roster, livePtyOwners } = input;
  if (request.agentId === registry.godId) {
    return { ok: false, error: 'the orchestrator cannot recover itself through this channel' };
  }
  if (request.agentId.startsWith('worker-')) {
    return { ok: false, error: 'ephemeral workers use the worker lifecycle, not persistent recovery' };
  }
  const agents = record(registry.agents);
  const agent = agents ? record(agents[request.agentId]) as RegistryAgentLike | null : null;
  if (!agent) return { ok: false, error: 'agent is not present in the persistent registry' };
  const sessionId = typeof agent.sessionId === 'string' ? agent.sessionId.trim() : '';
  if (!sessionId) return { ok: false, error: 'agent has no recorded session to recover' };
  if (sessionId !== request.expectedSessionId) {
    return { ok: false, error: 'agent session changed after this request was authored' };
  }
  const savedRecipe = findRecipe(roster, request.agentId);
  if (!savedRecipe) return { ok: false, error: 'agent has no saved spawn recipe' };
  // Standing-hire status is main-owned registry state. Do not depend on the
  // renderer round-tripping an orchestration marker through its roster card.
  const recipe = agent.standingHire === true
    ? { ...savedRecipe, standingHire: true }
    : savedRecipe;
  const liveOwner = livePtyOwners.get(recipe.ptyId);
  if (livePtyOwners.has(recipe.ptyId) && liveOwner !== request.agentId) {
    return { ok: false, error: 'saved PTY belongs to a different agent' };
  }
  return {
    ok: true,
    mode: livePtyOwners.has(recipe.ptyId) ? 'restart' : 'restore',
    recipe,
    sessionId,
  };
}

/** Small argv tokenizer for the saved renderer command. It supports the quoting
 * forms the Add-Agent UI writes and rejects ambiguous/incomplete input. */
export function tokenizeSavedCommand(command: string): string[] {
  const out: string[] = [];
  let token = '';
  let quote: 'single' | 'double' | null = null;
  let escaping = false;
  let started = false;
  for (const ch of command.trim()) {
    if (escaping) {
      token += ch;
      escaping = false;
      started = true;
      continue;
    }
    if (ch === '\\' && quote !== 'single') {
      escaping = true;
      started = true;
      continue;
    }
    if (ch === "'" && quote !== 'double') {
      quote = quote === 'single' ? null : 'single';
      started = true;
      continue;
    }
    if (ch === '"' && quote !== 'single') {
      quote = quote === 'double' ? null : 'double';
      started = true;
      continue;
    }
    if (/\s/.test(ch) && !quote) {
      if (started) {
        out.push(token);
        token = '';
        started = false;
      }
      continue;
    }
    token += ch;
    started = true;
  }
  if (escaping || quote) throw new Error('saved command has an unterminated quote or escape');
  if (started) out.push(token);
  if (!out.length || !out[0]) throw new Error('saved command is empty');
  return out;
}
