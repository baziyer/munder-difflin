import type { HiveTask, Registry } from './hive';
import type {
  WebhookHumanAnswer,
  WebhookHumanAnswerResult,
  WebhookOperationalSnapshot,
} from './webhook';

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

const MAX_ACTIVE_TASKS = 100;
const MAX_RECENT_DONE = 12;
const MAX_TEXT = 4_000;
const MAX_TITLE = 240;

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

/** Apply one answer to the latest open human ask, preserving all earlier Q&A. */
export function applyHumanAnswer(
  tasks: HiveTask[],
  input: WebhookHumanAnswer,
  now = Date.now(),
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
  const questionIndex = task.humanQA!.lastIndexOf(question);
  const humanQA = task.humanQA!.map((entry, entryIndex) =>
    entryIndex === questionIndex
      ? { ...entry, a: input.answer, answeredAt }
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
