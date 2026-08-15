import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { inferAgentProvider, providerPreset, type AgentProvider } from '../shared/agentProvider';
import { validateHireManifest, type HireManifest } from '../shared/hire';
import type { RosterSnapshot } from './roster';
import { tokenizeSavedCommand } from './persistentRecovery';
import { verifyHumanAnswerReceipt } from './humanAnswerReceipt';

export const PERSISTENT_HIRE_SPEC = 'munder-difflin/persistent-hire@1';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_TEXT = 8_192;

export interface PersistentHireRequest {
  spec: typeof PERSISTENT_HIRE_SPEC;
  id: string;
  agentId: string;
  cwd: string;
  approval: {
    taskId: string;
    answeredAt: string;
  };
  objective: string;
  manifest: HireManifest;
  /** Hash of the exact submitted manifest JSON plus normalized id/cwd. Kept
   * separately because validation intentionally normalizes the execution copy. */
  approvalDigest: string;
}

export interface PersistentHireRecipe {
  id: string;
  ptyId: string;
  name: string;
  provider: AgentProvider;
  model?: string;
  cwd: string;
  executable: string;
  args: string[];
  command: string;
  description?: string;
  goal?: string;
  character?: string;
  accent?: string;
  capabilities?: string[];
  isolate: boolean;
  tokenCap?: number;
}

interface RegistryLike {
  godId?: unknown;
  agents?: unknown;
}

export type PersistentHireParseResult =
  | { ok: true; request: PersistentHireRequest }
  | { ok: false; error: string };

export type PersistentHirePlan =
  | { ok: true; recipe: PersistentHireRecipe; objective: string; approvalEvidence: string }
  | { ok: false; error: string };

export function classifyPersistentHireEnvelope(value: unknown): 'current' | 'unknown' | 'none' {
  const input = record(value);
  const spec = input?.spec;
  if (spec === PERSISTENT_HIRE_SPEC) return 'current';
  if (typeof spec === 'string' && /^munder-difflin\/persistent-hire(?:@|$)/.test(spec)) {
    return 'unknown';
  }
  return 'none';
}

/** Standing identities never start in the approved source checkout. Their
 * terminal lives in Munder's non-repo app-data area; implementation work must
 * move into a task-specific worktree from the approved source repo's main. */
export function persistentHireControlCwd(userDataRoot: string, agentId: string): string | null {
  if (!isAbsolute(userDataRoot) || !SAFE_ID.test(agentId)) return null;
  const root = join(userDataRoot, 'standing-workers');
  const cwd = join(root, agentId);
  return resolve(cwd).startsWith(resolve(root) + sep) ? cwd : null;
}

/** Choose a durable assignment id from mailbox history, not process memory.
 * An unread retry survives restart and is reused; once handled, the next
 * monotonically increasing id is selected. */
export function persistentHireAssignmentId(
  baseId: string,
  messages: Array<{ id: string; handled: boolean }>,
  resumeSession: boolean,
): string {
  const base = messages.find((message) => message.id === baseId);
  if (!base?.handled || resumeSession) return baseId;
  const prefix = `${baseId}-retry-`;
  const retries = messages.flatMap((message) => {
    if (!message.id.startsWith(prefix)) return [];
    const value = Number(message.id.slice(prefix.length));
    return Number.isSafeInteger(value) && value > 0 ? [{ ...message, value }] : [];
  });
  const unread = retries.filter((message) => !message.handled).sort((a, b) => b.value - a.value)[0];
  if (unread) return unread.id;
  const highest = retries.reduce((max, message) => Math.max(max, message.value), 0);
  return `${prefix}${highest + 1}`;
}

interface ApprovalQuestionLike {
  q?: unknown;
  a?: unknown;
  answeredAt?: unknown;
  answerSource?: unknown;
  answerEndpointId?: unknown;
  answerReceipt?: unknown;
}

interface ApprovalTaskLike {
  id?: unknown;
  assignee?: unknown;
  humanQA?: unknown;
}

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

/** Parse the trusted local queue envelope. The nested manifest remains untrusted
 * and goes through the same strict validator as file/deep-link imports. */
export function parsePersistentHireRequest(value: unknown): PersistentHireParseResult {
  const input = record(value);
  if (!input || input.spec !== PERSISTENT_HIRE_SPEC) {
    return { ok: false, error: `spec must be ${PERSISTENT_HIRE_SPEC}` };
  }
  const id = requiredString(input.id, 'id', { id: true });
  if (!id.ok) return id;
  const agentId = requiredString(input.agentId, 'agentId', { id: true });
  if (!agentId.ok) return agentId;
  const cwd = requiredString(input.cwd, 'cwd', { max: 4_096 });
  if (!cwd.ok) return cwd;
  if (!isAbsolute(cwd.value)) return { ok: false, error: 'cwd must be an absolute path' };
  const approvalInput = record(input.approval);
  if (!approvalInput) return { ok: false, error: 'approval is required' };
  const approvalTaskId = requiredString(approvalInput.taskId, 'approval.taskId', { id: true });
  if (!approvalTaskId.ok) return approvalTaskId;
  const approvalAnsweredAt = requiredString(approvalInput.answeredAt, 'approval.answeredAt', { max: 128 });
  if (!approvalAnsweredAt.ok || !Number.isFinite(Date.parse(approvalAnsweredAt.value))) {
    return { ok: false, error: 'approval.answeredAt must be an ISO timestamp' };
  }
  const objective = requiredString(input.objective, 'objective', { max: MAX_TEXT });
  if (!objective.ok) return objective;
  const approvalDigest = createHash('sha256')
    .update(JSON.stringify(canonical({
      agentId: agentId.value,
      cwd: cwd.value,
      manifest: input.manifest,
    })))
    .digest('hex');
  const validated = validateHireManifest(input.manifest);
  if (!validated.ok || !validated.manifest) {
    return { ok: false, error: `manifest is invalid: ${validated.errors.join('; ')}` };
  }
  if (!validated.manifest.provider || !validated.manifest.model
    || typeof validated.manifest.isolate !== 'boolean') {
    return {
      ok: false,
      error: 'persistent-hire manifest must explicitly set provider, model, and isolate for approval scoping',
    };
  }
  if (validated.manifest.commandFlags?.some((flag) => flag.toLowerCase().split('=', 1)[0] === '--model')) {
    return { ok: false, error: 'persistent-hire commandFlags cannot override the explicitly approved model' };
  }
  if (validated.consentRequired?.length) {
    return { ok: false, error: 'manifest requests integrations that still require interactive consent' };
  }
  return {
    ok: true,
    request: {
      spec: PERSISTENT_HIRE_SPEC,
      id: id.value,
      agentId: agentId.value,
      cwd: cwd.value,
      approval: {
        taskId: approvalTaskId.value,
        answeredAt: approvalAnsweredAt.value,
      },
      objective: objective.value,
      manifest: validated.manifest,
      approvalDigest,
    },
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]),
  );
}

/** Digest of every behavior/cost-bearing standing-hire field the human approves.
 * The first assignment is intentionally excluded: Baz delegates task scoping to
 * Michael after approving the standing identity and its execution envelope. */
export function persistentHireApprovalDigest(request: PersistentHireRequest): string {
  return request.approvalDigest;
}

function normalized(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** Approval must be unqualified. If the human adds a provider/worktree/model
 * change, Michael must issue a new digest-bound question instead of guessing
 * which part of the signed answer should win. */
function isUnqualifiedAffirmative(value: unknown): boolean {
  const answer = normalized(value).replace(/[^a-z0-9]+/g, ' ').trim();
  return new Set([
    'a',
    'approve',
    'approved',
    'approved please',
    'go ahead',
    'implement',
    'implement please',
    'option a',
    'this works',
    'this works implement',
    'this works implement please',
    'yes',
    'yes please',
  ]).has(answer);
}

/** Bind the standing hire to a real answer on the task board. Human answers
 * reach the board through the secret-gated webhook/UI path; Michael can author a
 * question, but cannot manufacture its matching affirmative answer. */
function approvedQuestion(
  request: PersistentHireRequest,
  tasks: readonly ApprovalTaskLike[],
  approvalSecrets: ReadonlyMap<string, string>,
): { ok: true; evidence: string } | { ok: false; error: string } {
  const task = tasks.find((candidate) => candidate?.id === request.approval.taskId);
  if (!task) return { ok: false, error: 'approval task was not found' };
  if (task.assignee !== request.agentId) {
    return { ok: false, error: 'approval task assignee does not match the requested agent' };
  }
  const entries = Array.isArray(task.humanQA) ? task.humanQA as ApprovalQuestionLike[] : [];
  const entry = entries.find((candidate) => candidate?.answeredAt === request.approval.answeredAt);
  if (!entry) return { ok: false, error: 'the referenced approval answer was not found' };
  const endpointId = typeof entry.answerEndpointId === 'string' ? entry.answerEndpointId : '';
  const receipt = typeof entry.answerReceipt === 'string' ? entry.answerReceipt : '';
  const questionText = typeof entry.q === 'string' ? entry.q : '';
  const answerText = typeof entry.a === 'string' ? entry.a : '';
  const secret = approvalSecrets.get(endpointId) ?? '';
  if ((entry.answerSource !== 'webhook' && entry.answerSource !== 'desktop')
    || !endpointId || !receipt || !secret) {
    return { ok: false, error: 'approval is not backed by an authenticated human-answer receipt' };
  }
  if (!verifyHumanAnswerReceipt(secret, {
    taskId: request.approval.taskId,
    question: questionText,
    answer: answerText,
    answeredAt: request.approval.answeredAt,
    endpointId,
  }, receipt)) {
    return { ok: false, error: 'approval webhook receipt is invalid' };
  }
  if (!isUnqualifiedAffirmative(entry.a)) {
    return { ok: false, error: 'the referenced answer is not an unqualified affirmative' };
  }
  const question = normalized(entry.q);
  const provider = request.manifest.provider ?? '';
  const required = [
    request.agentId,
    request.manifest.name,
    request.cwd,
    provider,
    request.manifest.model ?? '',
  ].map((value) => value.toLowerCase()).filter(Boolean);
  const isolateScope = request.manifest.isolate === false
    ? /isolate\s+(off|false)/
    : /isolate\s+(on|true)/;
  const digest = persistentHireApprovalDigest(request);
  if (!/\b(hire|spawn|import)\b/.test(question)
    || required.some((value) => !question.includes(value))
    || !isolateScope.test(question)
    || !question.includes(`sha256:${digest}`)) {
    return { ok: false, error: 'approval question does not describe this exact hire' };
  }
  return {
    ok: true,
    evidence: `${request.approval.taskId} answered ${request.approval.answeredAt}: ${String(entry.a).trim()}`,
  };
}

function rosterContains(roster: RosterSnapshot, id: string): boolean {
  return [roster.agents, roster.archived, roster.restorable].some((slice) =>
    slice.some((entry) => record(entry)?.id === id)
  );
}

/** Preserve the main-authored provisioning marker across stale renderer-floor
 * roster writes, and strip markers whose request/registry transaction is over. */
export function protectPersistentHireRosterWrite(input: {
  incoming: unknown;
  current: RosterSnapshot | null;
  registry: RegistryLike;
  requestQueued: (requestId: string) => boolean;
}): unknown {
  if (!input.incoming || typeof input.incoming !== 'object' || Array.isArray(input.incoming)) return input.incoming;
  const incoming = input.incoming as Record<string, unknown>;
  if (!Array.isArray(incoming.agents)
    || !Array.isArray(incoming.archived)
    || !Array.isArray(incoming.restorable)
    || !input.current) return input.incoming;
  const agents = record(input.registry.agents);
  const sections = ['agents', 'archived', 'restorable'] as const;
  const protectedCards = new Map<string, { section: typeof sections[number]; card: unknown }>();
  for (const section of sections) {
    for (const entry of input.current[section]) {
      const card = record(entry);
      const id = typeof card?.id === 'string' ? card.id : '';
      const requestId = typeof card?.standingHireRequestId === 'string' ? card.standingHireRequestId : '';
      if (!id || !requestId) continue;
      if (record(agents?.[id])?.standingHireRequestId === requestId || input.requestQueued(requestId)) {
        protectedCards.set(id, { section, card: entry });
      }
    }
  }
  const sanitize = (entries: unknown[], section: typeof sections[number]): unknown[] => {
    const clean = entries.flatMap((entry) => {
      const card = record(entry);
      if (!card) return [entry];
      const id = typeof card.id === 'string' ? card.id : '';
      if (id && protectedCards.has(id)) return [];
      if (card.standingHireRequestId === undefined) return [entry];
      const { standingHireRequestId: _stale, ...withoutStaleMarker } = card;
      void _stale;
      return [withoutStaleMarker];
    });
    for (const protectedCard of protectedCards.values()) {
      if (protectedCard.section === section) clean.push(protectedCard.card);
    }
    return clean;
  };
  return {
    ...incoming,
    agents: sanitize(incoming.agents, 'agents'),
    archived: sanitize(incoming.archived, 'archived'),
    restorable: sanitize(incoming.restorable, 'restorable'),
  };
}

function commandDisplay(executable: string, args: readonly string[]): string {
  const quote = (value: string): string => /\s/.test(value) ? JSON.stringify(value) : value;
  return [executable, ...args].map(quote).join(' ');
}

/** Build one fresh persistent identity using local provider presets only. A
 * request can choose a validated provider/model/flags, never its executable. */
export function planPersistentHire(input: {
  request: PersistentHireRequest;
  registry: RegistryLike;
  roster: RosterSnapshot;
  livePtyOwners: ReadonlyMap<string, string>;
  tasks: readonly ApprovalTaskLike[];
  approvalSecrets: ReadonlyMap<string, string>;
  defaultCommand: string;
  autoMode: boolean;
  maxStandingAgents?: number;
}): PersistentHirePlan {
  const { request, registry, roster, livePtyOwners } = input;
  if (request.agentId === registry.godId) {
    return { ok: false, error: 'the orchestrator cannot hire itself through this channel' };
  }
  if (request.agentId.startsWith('worker-')) {
    return { ok: false, error: 'ephemeral worker identities use the existing worker lifecycle' };
  }
  const agents = record(registry.agents);
  const maxStandingAgents = Math.max(1, Math.floor(input.maxStandingAgents ?? 12));
  const standingCount = agents
    ? Object.entries(agents).filter(([id, value]) => {
        const agent = record(value);
        return id !== registry.godId && !id.startsWith('worker-') && agent?.archived !== true;
      }).length
    : 0;
  if (standingCount >= maxStandingAgents) {
    return { ok: false, error: `standing-agent limit reached (${maxStandingAgents})` };
  }
  if (agents && record(agents[request.agentId])) {
    return { ok: false, error: 'agent already exists; use persistent recovery for the same identity' };
  }
  if (rosterContains(roster, request.agentId)) {
    return { ok: false, error: 'agent already exists in the saved roster; use persistent recovery for the same identity' };
  }
  const ptyId = `pty-${request.agentId}`;
  if (livePtyOwners.has(ptyId)) {
    return { ok: false, error: 'the requested persistent PTY id is already in use' };
  }
  const manifest = request.manifest;
  if (manifest.isolate !== false) {
    return {
      ok: false,
      error: 'standing hires require isolate off; implementation work belongs in a fresh task-specific worktree/PR',
    };
  }
  const approval = approvedQuestion(request, input.tasks, input.approvalSecrets);
  if (!approval.ok) return approval;
  const inferred = manifest.provider ?? inferAgentProvider(input.defaultCommand);
  if (inferred !== 'claude' && inferred !== 'codex' && inferred !== 'antigravity') {
    return { ok: false, error: 'persistent hires require a validated built-in provider' };
  }
  const provider: AgentProvider = inferred;
  const preset = providerPreset(provider);
  const base = provider === 'claude'
    ? (input.defaultCommand.trim() || preset.defaultCommand)
    : preset.defaultCommand;
  let tokens: string[];
  try {
    tokens = tokenizeSavedCommand(base);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const [executable, ...baseArgs] = tokens;
  if (!executable) return { ok: false, error: 'local provider command is empty' };
  if (provider === 'claude' && inferAgentProvider(executable) !== 'claude') {
    return { ok: false, error: 'local Claude command does not resolve to the approved Claude provider' };
  }
  const args = [...baseArgs];
  if (preset.supportsModel && manifest.model && preset.modelFlag) {
    args.push(preset.modelFlag, manifest.model);
  }
  if (input.autoMode && preset.autoFlag) {
    try { args.push(...tokenizeSavedCommand(preset.autoFlag)); }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  }
  if (manifest.commandFlags) args.push(...manifest.commandFlags);

  return {
    ok: true,
    objective: request.objective,
    approvalEvidence: approval.evidence,
    recipe: {
      id: request.agentId,
      ptyId,
      name: manifest.name,
      provider,
      ...(manifest.model ? { model: manifest.model } : {}),
      cwd: request.cwd,
      executable,
      args,
      command: commandDisplay(executable, args),
      ...(manifest.description ? { description: manifest.description } : {}),
      ...(manifest.goal ? { goal: manifest.goal } : {}),
      ...(manifest.character ? { character: manifest.character } : {}),
      ...(manifest.accent ? { accent: manifest.accent } : {}),
      ...(manifest.capabilities ? { capabilities: manifest.capabilities } : {}),
      isolate: manifest.isolate ?? true,
      ...(manifest.tokenCap ? { tokenCap: manifest.tokenCap } : {}),
    },
  };
}
