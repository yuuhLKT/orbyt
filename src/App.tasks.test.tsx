import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionScope, Project, Task, TaskRun } from './types/domain';
import App from './App';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

const project: Project = {
  id: 'project-1',
  name: 'Orbyt',
  description: '',
  directory: '/work/orbyt',
  maxConcurrentSessions: 2,
  approvalPolicy: 'manual',
  createdAt: '2026-10-10T00:00:00Z',
  updatedAt: '2026-10-10T00:00:00Z',
};

const task: Task = {
  id: 'task-1',
  projectId: project.id,
  scopeId: null,
  title: 'Add a settings screen',
  description: 'Show saved settings and validation errors.',
  source: 'manual',
  externalReference: null,
  externalUrl: null,
  externalStatus: null,
  externalUpdatedAt: null,
  linkedGlpiTicketId: null,
  priority: 'medium',
  status: 'pending',
  createdAt: '2026-10-10T00:00:00Z',
  updatedAt: '2026-10-10T00:00:00Z',
};

const triageResult = {
  contextSufficiency: 'sufficient',
  complexity: 'low',
  requirements: ['Render the current settings.'],
  missingInformation: [],
  relevantFiles: ['src/App.tsx'],
  proposedExecutionScope: 'src',
  implementationPlan: ['Add a settings view.'],
  risks: [],
  dependencies: ['React'],
  recommendedAction: 'await_approval',
};

const run: TaskRun = {
  id: 'run-1',
  taskId: 'task-1',
  projectId: project.id,
  taskRevision: 1,
  state: 'running',
  scopeDirectory: '/work/orbyt',
  broadScope: false,
  sessionId: 'opencode-session-1',
  progress: 'Reading the task',
  output: '',
  pendingPermissions: [],
  error: null,
  createdAt: '2026-10-10T00:00:00Z',
  updatedAt: '2026-10-10T00:00:01Z',
};

let listedTask: Task = task;
let listedRuns: TaskRun[] = [];
let listedScopes: ExecutionScope[] = [];

function renderTasks() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/tasks']}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('task triage and workflow controls', () => {
  beforeEach(() => {
    listedTask = task;
    listedRuns = [];
    listedScopes = [];
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_projects') return Promise.resolve([project]);
      if (command === 'list_tasks') return Promise.resolve([listedTask]);
      if (command === 'list_scopes') return Promise.resolve(listedScopes);
      if (command === 'list_task_runs') return Promise.resolve(listedRuns);
      if (command === 'get_task_triage') return Promise.resolve(null);
      if (command === 'triage_task')
        return Promise.resolve({
          task: { ...task, status: 'awaiting_approval' },
          result: triageResult,
        });
      if (command === 'queue_task_execution') return Promise.resolve(run);
      if (command === 'respond_to_run_permission') return Promise.resolve(run);
      if (command === 'cancel_task_run')
        return Promise.resolve({ ...run, state: 'cancel_requested' });
      if (command === 'reconcile_task_run') return Promise.resolve({ ...run, state: 'canceled' });
      if (command === 'transition_task') return Promise.resolve({ ...task, status: 'canceled' });
      return Promise.resolve({});
    });
  });

  it('runs triage and renders its report without exposing generic execution state changes', async () => {
    renderTasks();

    expect(await screen.findByText('Add a settings screen')).toBeInTheDocument();
    expect(
      screen.getByText(/rules that already allow a tool action can let it run/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark queued' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark running' })).not.toBeInTheDocument();
    expect(
      screen.getByText(
        /Issue text and linked GLPI ticket text, public follow-ups, and attachment metadata to the configured model/i,
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText('Actions'));
    fireEvent.click(await screen.findByRole('button', { name: 'Run triage' }));

    expect(await screen.findByRole('region', { name: 'Triage report' })).toBeInTheDocument();
    expect(screen.getByText('Render the current settings.')).toBeInTheDocument();
    expect(screen.getByText(/Await manual approval/)).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith('triage_task', { taskId: 'task-1' });
  });

  it('exposes only legal state actions for the current status', async () => {
    renderTasks();

    fireEvent.click(await screen.findByText('Actions'));
    expect(screen.queryByRole('button', { name: /mark queued/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /mark running/i })).not.toBeInTheDocument();
    const cancel = await screen.findByRole('button', { name: 'Cancel task' });
    expect(screen.queryByRole('button', { name: 'Mark triaging' })).not.toBeInTheDocument();
    fireEvent.click(cancel);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('transition_task', {
        taskId: 'task-1',
        toStatus: 'canceled',
      });
    });
  });

  it('loads the latest saved triage report when reopening the task list', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_projects') return Promise.resolve([project]);
      if (command === 'list_tasks')
        return Promise.resolve([{ ...task, status: 'awaiting_approval' }]);
      if (command === 'list_scopes') return Promise.resolve([]);
      if (command === 'list_task_runs') return Promise.resolve([]);
      if (command === 'get_task_triage') return Promise.resolve(triageResult);
      return Promise.resolve({});
    });

    renderTasks();

    expect(await screen.findByRole('region', { name: 'Triage report' })).toBeInTheDocument();
    expect(screen.getByText('Add a settings screen')).toBeInTheDocument();
  });

  it('queues an approved task with a selected scope without asking for broad-scope confirmation', async () => {
    listedTask = { ...task, scopeId: 'scope-1', status: 'awaiting_approval' };
    listedScopes = [
      {
        id: 'scope-1',
        projectId: project.id,
        name: 'Source',
        relativeDirectory: 'src',
        readAccess: true,
        writeAccess: true,
        conflictPolicy: 'serialize',
      },
    ];
    renderTasks();

    fireEvent.click(await screen.findByText('Actions'));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Approve and start implementation' }),
    );

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('queue_task_execution', {
        taskId: 'task-1',
        confirmBroadScope: false,
      });
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('requires explicit confirmation before queueing a project-wide run', async () => {
    listedTask = { ...task, status: 'awaiting_approval' };
    renderTasks();

    fireEvent.click(await screen.findByText('Actions'));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Approve and start implementation' }),
    );

    expect(
      await screen.findByRole('dialog', { name: 'Confirm project-wide write scope' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/entire project directory will be the scheduler write lock/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/does not sandbox filesystem access/i)).toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalledWith('queue_task_execution', expect.anything());

    fireEvent.click(screen.getByRole('button', { name: 'Confirm broad scope and start' }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('queue_task_execution', {
        taskId: 'task-1',
        confirmBroadScope: true,
      });
    });
  });

  it('prevents starting an approved task assigned to a read-only scope', async () => {
    listedTask = {
      ...task,
      scopeId: 'scope-read-only',
      status: 'awaiting_approval',
    };
    listedScopes = [
      {
        id: 'scope-read-only',
        projectId: project.id,
        name: 'Documentation',
        relativeDirectory: 'docs',
        readAccess: true,
        writeAccess: false,
        conflictPolicy: 'serialize',
      },
    ];
    renderTasks();

    fireEvent.click(await screen.findByText('Actions'));

    expect(await screen.findByText(/scope is read-only.*write-enabled scope/i)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Approve and start implementation' }),
    ).not.toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalledWith('queue_task_execution', expect.anything());
  });

  it('offers only one-time permission or rejection for pending OpenCode requests', async () => {
    listedTask = { ...task, status: 'running' };
    listedRuns = [
      {
        ...run,
        state: 'waiting_permission',
        pendingPermissions: [
          {
            id: 'permission-1',
            title: 'Run a project command',
            kind: 'execute',
            details: { command: 'bun run build' },
            options: ['allow_once', 'reject', 'always'],
          },
        ],
      },
    ];
    renderTasks();

    expect(await screen.findByText('Run a project command')).toBeInTheDocument();
    expect(screen.getByText(/bun run build/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /always/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('respond_to_run_permission', {
        runId: 'run-1',
        permissionId: 'permission-1',
        decision: 'allow_once',
      });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('respond_to_run_permission', {
        runId: 'run-1',
        permissionId: 'permission-1',
        decision: 'reject',
      });
    });
  });

  it('requests cancellation for active work and reports that stop is pending', async () => {
    listedTask = { ...task, status: 'running' };
    listedRuns = [run];
    renderTasks();

    fireEvent.click(await screen.findByRole('button', { name: 'Stop work' }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('cancel_task_run', { runId: 'run-1' });
    });
  });

  it('requires confirmation that external work stopped before reconciliation', async () => {
    listedTask = { ...task, status: 'needs_reconciliation' };
    listedRuns = [
      { ...run, state: 'needs_reconciliation', error: 'The process could not be observed.' },
    ];
    renderTasks();

    fireEvent.click(await screen.findByRole('button', { name: 'Resolve stopped work…' }));
    expect(
      await screen.findByRole('dialog', { name: 'Confirm external work has stopped' }),
    ).toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalledWith('reconcile_task_run', expect.anything());

    fireEvent.click(
      screen.getByRole('checkbox', { name: /checked that the external work has stopped/i }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'I stopped the external work' }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('reconcile_task_run', {
        runId: 'run-1',
        confirmStopped: true,
      });
    });
  });
});
