import type { HiveTask, Registry } from './hive';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import type {
  WebhookDocumentResult,
  WebhookHumanAnswer,
  WebhookHumanAnswerResult,
  WebhookOperationalSnapshot,
} from './webhook';
import { signHumanAnswerReceipt } from './humanAnswerReceipt';

/** Read through an already validated descriptor without allocating from a
 * mutable file size. One extra byte turns same-inode growth into a rejection. */
export function readBoundedUtf8(fd: number, maxBytes: number): string {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
    if (count === 0) break;
    offset += count;
  }
  if (offset > maxBytes) throw new Error('document exceeded the read limit');
  return buffer.subarray(0, offset).toString('utf8');
}

interface FleetAgent {
  id?: unknown;
  name?: unknown;
  role?: unknown;
  isGod?: unknown;
  breaker?: unknown;
  tokens?: unknown;
  usd?: unknown;
  lastActiveSecAgo?: unknown;
  inboxBacklog?: unknown;
}

export interface FleetSnapshot {
  ts?: unknown;
  agents?: unknown;
}

type PersistedHumanQA = NonNullable<HiveTask['humanQA']>[number] & {
  dismissedAt?: string;
};

type PersistedTask = HiveTask & {
  startedAt?: string;
  completedAt?: string;
  humanQA?: PersistedHumanQA[];
};

interface SnapshotInput {
  tasks: HiveTask[];
  registry: Registry;
  fleet: FleetSnapshot;
  now?: number;
  documentRoot?: string | null;
  redact: (value: string) => string;
}

export interface AppliedHumanAnswer {
  result: WebhookHumanAnswerResult;
  tasks: HiveTask[];
  notification?: {
    taskId: string;
    title: string;
    question: string;
    answer: string;
  };
}

export interface HumanAnswerProvenance {
  source: 'webhook' | 'desktop';
  endpointId: string;
  endpointSecret: string;
}

const MAX_ACTIVE_TASKS = 100;
const MAX_RECENT_DONE = 12;
const MAX_TEXT = 4_000;
const MAX_TITLE = 240;
const MAX_DOCUMENT_BYTES = 128 * 1024;
const DOCUMENT_PATH = /(?:^|[\s([`])((?:hive\/|agents\/|\/)[A-Za-z0-9._@+~\/-]+\.md)\b/g;

function text(value: unknown, redact: (value: string) => string, max = MAX_TEXT): string {
  if (typeof value !== 'string') return '';
  return redact(value).trim().slice(0, max);
}

function optionalText(
  value: unknown,
  redact: (value: string) => string,
  max = MAX_TEXT,
): string | undefined {
  const valueText = text(value, redact, max);
  return valueText || undefined;
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function nullableNonNegativeNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : nonNegativeNumber(value);
}

function openQuestion(task: PersistedTask): PersistedHumanQA | undefined {
  if (task.status !== 'blocked' || !Array.isArray(task.humanQA)) return undefined;
  for (let index = task.humanQA.length - 1; index >= 0; index -= 1) {
    const entry = task.humanQA[index];
    if (entry && typeof entry.q === 'string' && entry.q.trim() && !entry.a && !entry.dismissedAt) {
      return entry;
    }
  }
  return undefined;
}

function taskTimestamp(task: PersistedTask): string {
  return task.completedAt || task.startedAt || task.createdAt || '';
}

interface InternalDocumentRef {
  id: string;
  name: string;
  reference: string;
  path: string;
  dev: number;
  ino: number;
}

function documentRefs(
  taskId: string,
  question: string,
  documentRoot: string | null | undefined,
): InternalDocumentRef[] {
  if (!documentRoot || !existsSync(documentRoot)) return [];
  let root: string;
  try { root = realpathSync(documentRoot); } catch { return []; }
  const refs: InternalDocumentRef[] = [];
  const seen = new Set<string>();
  for (const match of question.matchAll(DOCUMENT_PATH)) {
    const written = match[1];
    const candidate = isAbsolute(written)
      ? written
      : written.startsWith('hive/')
        ? join(root, written.slice('hive/'.length))
        : join(root, written);
    let path: string;
    try { path = realpathSync(candidate); } catch { continue; }
    if (path !== root && !path.startsWith(`${root}${sep}`)) continue;
    let stat;
    try { stat = statSync(path); } catch { continue; }
    if (!stat.isFile() || stat.size > MAX_DOCUMENT_BYTES || !path.toLowerCase().endsWith('.md')) continue;
    const relativePath = relative(root, path).split(sep).join('/');
    const reference = `hive/${relativePath}`;
    if (seen.has(reference)) continue;
    seen.add(reference);
    refs.push({
      id: createHash('sha256').update(`${taskId}\0${reference}`).digest('hex').slice(0, 24),
      name: basename(path),
      reference,
      path,
      dev: stat.dev,
      ino: stat.ino,
    });
  }
  return refs.slice(0, 8);
}

/** Build the small, redacted read model exposed to a trusted webhook dashboard. */
export function buildOperationalSnapshot(input: SnapshotInput): WebhookOperationalSnapshot {
  const tasks = Array.isArray(input.tasks) ? input.tasks as PersistedTask[] : [];
  const counts = { todo: 0, doing: 0, blocked: 0, done: 0 };
  for (const task of tasks) {
    if (task?.status === 'todo' || task?.status === 'doing' || task?.status === 'blocked' || task?.status === 'done') {
      counts[task.status] += 1;
    }
  }

  const active = tasks
    .filter((task) => task?.status === 'todo' || task?.status === 'doing' || task?.status === 'blocked')
    .slice(0, MAX_ACTIVE_TASKS);
  const recentDone = tasks
    .filter((task) => task?.status === 'done')
    .sort((a, b) => taskTimestamp(b).localeCompare(taskTimestamp(a)))
    .slice(0, MAX_RECENT_DONE);

  const snapshotTasks = [...active, ...recentDone].flatMap((task) => {
    if (
      !task ||
      typeof task.id !== 'string' ||
      !task.id.trim() ||
      (task.status !== 'todo' && task.status !== 'doing' && task.status !== 'blocked' && task.status !== 'done')
    ) {
      return [];
    }
    const question = openQuestion(task);
    const documents = question
      ? documentRefs(task.id, question.q, input.documentRoot)
        .map(({ id, name, reference }) => ({ id, name, reference }))
      : [];
    const dependsOn = Array.isArray(task.dependsOn)
      ? task.dependsOn
        .filter((id): id is string => typeof id === 'string')
        .slice(0, 64)
        .map((id) => id.slice(0, 256))
      : [];
    const result = optionalText(task.result, input.redact);
    return [{
      id: task.id.slice(0, 256),
      title: text(task.title, input.redact, MAX_TITLE) || 'Untitled task',
      status: task.status,
      ...(typeof task.assignee === 'string' && task.assignee.trim()
        ? { assignee: task.assignee.trim().slice(0, 256) }
        : {}),
      dependsOn,
      priority: nonNegativeNumber(task.priority),
      createdAt: typeof task.createdAt === 'string' ? task.createdAt : '',
      ...(typeof task.startedAt === 'string' ? { startedAt: task.startedAt } : {}),
      ...(typeof task.completedAt === 'string' ? { completedAt: task.completedAt } : {}),
      ...(question
        ? {
            question: {
              text: text(question.q, input.redact),
              ...(typeof question.askedAt === 'string' ? { askedAt: question.askedAt } : {}),
              ...(documents.length ? { documents } : {}),
            },
          }
        : {}),
      ...(result ? { result } : {}),
    }];
  });

  const rawAgents = Array.isArray(input.fleet?.agents) ? input.fleet.agents as FleetAgent[] : [];
  const agents = rawAgents.flatMap((agent) => {
    if (!agent || typeof agent.id !== 'string' || !agent.id.trim()) return [];
    const id = agent.id.trim();
    const registered = input.registry?.agents?.[id];
    return [{
      id: id.slice(0, 256),
      name: text(agent.name ?? registered?.name ?? id, input.redact, 160) || id,
      role: text(agent.role ?? registered?.role ?? (registered?.isGod ? 'orchestrator' : 'agent'), input.redact, 500),
      ...(typeof registered?.provider === 'string' ? { provider: registered.provider } : {}),
      isGod: agent.isGod === true || input.registry?.godId === id || registered?.isGod === true,
      breaker: text(agent.breaker, input.redact, 80) || 'unknown',
      tokens: nonNegativeNumber(agent.tokens),
      usd: nonNegativeNumber(agent.usd),
      lastActiveSecAgo: nullableNonNegativeNumber(agent.lastActiveSecAgo),
      inboxBacklog: nonNegativeNumber(agent.inboxBacklog),
    }];
  });

  return {
    generatedAt: new Date(input.now ?? Date.now()).toISOString(),
    counts,
    tasks: snapshotTasks,
    agents,
  };
}

export function readOperationalDocument(input: {
  tasks: HiveTask[];
  taskId: string;
  documentId: string;
  documentRoot?: string | null;
  redact: (value: string) => string;
}): WebhookDocumentResult {
  const task = (Array.isArray(input.tasks) ? input.tasks : [])
    .find((candidate) => candidate?.id === input.taskId) as PersistedTask | undefined;
  const question = task ? openQuestion(task) : undefined;
  if (!task || !question) return { ok: false, status: 404, error: 'document not found' };
  const ref = documentRefs(task.id, question.q, input.documentRoot)
    .find((candidate) => candidate.id === input.documentId);
  if (!ref) return { ok: false, status: 404, error: 'document not found' };
  let fd: number | null = null;
  try {
    // Open the exact file without following a final symlink, then compare its
    // inode with the canonical file validated above. This closes the useful
    // symlink/replacement race between current-question validation and reading.
    fd = openSync(ref.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!opened.isFile()
      || opened.size > MAX_DOCUMENT_BYTES
      || opened.dev !== ref.dev
      || opened.ino !== ref.ino) {
      throw new Error('document changed during validation');
    }
    const raw = readBoundedUtf8(fd, MAX_DOCUMENT_BYTES);
    return {
      ok: true,
      document: {
        id: ref.id,
        name: ref.name,
        reference: ref.reference,
        revision: createHash('sha256').update(raw).digest('hex').slice(0, 12),
        content: input.redact(raw),
      },
    };
  } catch {
    return { ok: false, status: 503, error: 'document unavailable' };
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* already closed */ } }
  }
}

/** Apply one answer to the latest open human ask, preserving all earlier Q&A. */
export function applyHumanAnswer(
  tasks: HiveTask[],
  input: WebhookHumanAnswer,
  now = Date.now(),
  provenance?: HumanAnswerProvenance,
): AppliedHumanAnswer {
  const index = tasks.findIndex((task) => task?.id === input.taskId);
  if (index < 0) {
    return { result: { ok: false, status: 404, error: 'task not found' }, tasks };
  }
  const task = tasks[index] as PersistedTask;
  const question = openQuestion(task);
  if (!question) {
    return {
      result: { ok: false, status: 409, error: 'task has no open human question' },
      tasks,
    };
  }
  const answeredAt = new Date(now).toISOString();
  const answerProvenance = provenance
    ? {
        answerSource: provenance.source,
        answerEndpointId: provenance.endpointId,
        answerReceipt: signHumanAnswerReceipt(provenance.endpointSecret, {
          taskId: task.id,
          question: question.q,
          answer: input.answer,
          answeredAt,
          endpointId: provenance.endpointId,
        }),
      }
    : {};
  const questionIndex = task.humanQA!.lastIndexOf(question);
  const humanQA = task.humanQA!.map((entry, entryIndex) =>
    entryIndex === questionIndex
      ? { ...entry, a: input.answer, answeredAt, ...answerProvenance }
      : entry,
  );
  const nextTasks = tasks.map((item, taskIndex) =>
    taskIndex === index ? { ...item, humanQA } : item,
  );
  return {
    result: { ok: true },
    tasks: nextTasks,
    notification: {
      taskId: task.id,
      title: task.title,
      question: question.q,
      answer: input.answer,
    },
  };
}
