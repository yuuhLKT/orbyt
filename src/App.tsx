import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, NavLink, Route, Routes, useParams } from 'react-router-dom';
import { open } from '@tauri-apps/plugin-dialog';
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AlertCircle,
  ArrowLeft,
  ArrowDownLeft,
  ArrowRight,
  Bot,
  Check,
  ChevronDown,
  CircleHelp,
  CirclePlus,
  Command,
  FolderKanban,
  FolderOpen,
  Gauge,
  GitBranch,
  GitPullRequest,
  Paperclip,
  ExternalLink,
  Layers3,
  LoaderCircle,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';
import { api, errorMessage } from './lib/commands';
import { availableTransitions } from './lib/task-rules';
import type {
  ExecutionScope,
  OpenCodeSession,
  Project,
  Task,
  TaskRun,
  TaskRunState,
  TaskStatus,
  TriageResult,
} from './types/domain';

const keys = {
  projects: ['projects'],
  tasks: ['tasks'],
  settings: ['settings'],
  sessions: ['sessions'],
};
const DEFAULT_MAX_CONCURRENT_SESSIONS = 3;

function transitionLabel(status: TaskStatus) {
  const labels: Partial<Record<TaskStatus, string>> = {
    pending: 'Return to pending',
    triaging: 'Mark triaging',
    awaiting_context: 'Request more context',
    awaiting_approval: 'Request approval',
    awaiting_review: 'Mark ready for review',
    completed: 'Mark completed',
    blocked: 'Mark blocked',
    failed: 'Mark failed',
    canceled: 'Cancel task',
  };
  return labels[status] ?? `Mark ${formatStatus(status)}`;
}

function useProjects() {
  return useQuery({ queryKey: keys.projects, queryFn: api.projects });
}
function useTasks() {
  return useQuery({
    queryKey: keys.tasks,
    queryFn: () => api.tasks(),
    // Also lets the backend reconcile triage work interrupted by an app restart.
    refetchInterval: 30_000,
  });
}
function useAppSettings() {
  return useQuery({ queryKey: keys.settings, queryFn: api.settings });
}

const FIRST_RUN_PROGRESS_KEY = 'orbyt.first-run.progress.v1';
const FIRST_RUN_DISMISSED_KEY = 'orbyt.first-run.dismissed';

type FirstRunProgress = { step: number; projectId?: string };

function readFirstRunProgress(): FirstRunProgress | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(FIRST_RUN_PROGRESS_KEY) ?? 'null');
    if (typeof value !== 'object' || value === null) return null;
    const record = value as Record<string, unknown>;
    if (
      typeof record.step === 'number' &&
      Number.isInteger(record.step) &&
      record.step >= 0 &&
      record.step <= 3 &&
      (record.projectId === undefined || typeof record.projectId === 'string')
    ) {
      return {
        step: record.step,
        projectId: typeof record.projectId === 'string' ? record.projectId : undefined,
      };
    }
  } catch {
    // Storage is optional; onboarding can still run in memory.
  }
  return null;
}

function writeFirstRunProgress(progress: FirstRunProgress | null) {
  try {
    if (progress) localStorage.setItem(FIRST_RUN_PROGRESS_KEY, JSON.stringify(progress));
    else localStorage.removeItem(FIRST_RUN_PROGRESS_KEY);
  } catch {
    // Storage is optional; onboarding can still run in memory.
  }
}

function readFirstRunDismissed() {
  try {
    return sessionStorage.getItem(FIRST_RUN_DISMISSED_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeFirstRunDismissed(dismissed: boolean) {
  try {
    if (dismissed) sessionStorage.setItem(FIRST_RUN_DISMISSED_KEY, 'true');
    else sessionStorage.removeItem(FIRST_RUN_DISMISSED_KEY);
  } catch {
    // Storage is optional; onboarding can still run in memory.
  }
}

function App() {
  return (
    <div className="app-shell">
      <ReviewNotifications />
      <GlpiSyncScheduler />
      <Sidebar />
      <div className="app-main">
        <Topbar />
        <main className="page-area">
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/projects" element={<Projects />} />
            <Route path="/projects/:projectId" element={<ProjectDetail />} />
            <Route path="/tasks" element={<Tasks />} />
            <Route path="/flow" element={<Flow />} />
            <Route path="/sessions" element={<Sessions />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

function ReviewNotifications() {
  const { data: tasks, isSuccess } = useTasks();
  const hasBaseline = useRef(false);

  useEffect(() => {
    if (!isSuccess || !tasks) return;
    const notificationKey = 'orbyt.review-notification-task-ids';
    let notifiedIds: Set<string>;
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(notificationKey) ?? '[]');
      notifiedIds = new Set(
        Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [],
      );
    } catch {
      notifiedIds = new Set();
    }
    if (!hasBaseline.current) {
      hasBaseline.current = true;
    }

    const completedRuns = tasks.filter(
      (task) =>
        task.status === 'awaiting_review' && !notifiedIds.has(`${task.id}:${task.updatedAt}`),
    );
    if (completedRuns.length === 0) return;
    for (const task of completedRuns) notifiedIds.add(`${task.id}:${task.updatedAt}`);
    try {
      localStorage.setItem(notificationKey, JSON.stringify([...notifiedIds].slice(-1000)));
    } catch {
      // Notification delivery remains best-effort when local storage is unavailable.
    }

    void (async () => {
      try {
        let granted = await isPermissionGranted();
        if (!granted) granted = (await requestPermission()) === 'granted';
        if (!granted) return;

        for (const task of completedRuns) {
          sendNotification({
            title: 'Orbyt: revisão pronta',
            body: task.title,
          });
        }
      } catch {
        // Notifications are a convenience; a platform permission failure must not affect tasks.
      }
    })();
  }, [isSuccess, tasks]);

  return null;
}

function Sidebar() {
  const { data: projects = [] } = useProjects();
  const { data: tasks = [] } = useTasks();
  const links = [
    { to: '/', label: 'Overview', icon: Gauge, end: true },
    { to: '/projects', label: 'Projects', icon: FolderKanban },
    { to: '/tasks', label: 'Tasks', icon: Layers3 },
    { to: '/flow', label: 'Flow', icon: GitPullRequest },
    { to: '/sessions', label: 'Sessions', icon: SquareTerminal },
  ];
  return (
    <aside className="sidebar">
      <Link to="/" className="brand">
        <span className="brand-mark">
          <Sparkles size={17} />
        </span>
        <span>orbyt</span>
        <span className="brand-version">0.1</span>
      </Link>
      <div className="workspace-switch">
        <span className="workspace-avatar">Y</span>
        <span className="workspace-copy">
          <strong>Local workspace</strong>
          <small>Personal environment</small>
        </span>
        <ChevronDown size={15} />
      </div>
      <div className="side-section-label">WORKSPACE</div>
      <nav className="side-nav">
        {links.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
          >
            <Icon size={17} strokeWidth={1.8} />
            <span>{label}</span>
            {label === 'Tasks' && tasks.length > 0 && (
              <span className="nav-count">{tasks.length}</span>
            )}
          </NavLink>
        ))}
      </nav>
      <div className="side-project-heading">
        <span className="side-section-label">YOUR PROJECTS</span>
        <Link to="/projects" aria-label="Add project">
          <Plus size={15} />
        </Link>
      </div>
      <div className="project-nav-list">
        {projects.slice(0, 5).map((project) => (
          <Link className="project-nav-item" key={project.id} to={`/projects/${project.id}`}>
            <span className="project-dot" />
            {project.name}
          </Link>
        ))}
        {projects.length === 0 && <span className="sidebar-muted">No projects yet</span>}
      </div>
      <div className="sidebar-bottom">
        <div className="sidebar-tip">
          <span className="tip-icon">
            <ShieldCheck size={16} />
          </span>
          <strong>You're in control</strong>
          <p>Every implementation requires your approval.</p>
        </div>
        <NavLink
          to="/settings"
          className={({ isActive }) => `nav-link settings-link${isActive ? ' active' : ''}`}
        >
          <Settings2 size={17} />
          <span>Settings</span>
        </NavLink>
        <div className="sidebar-footer">
          <span className="online-dot" /> Local-first by design{' '}
          <span className="footer-shortcut">⌘ K</span>
        </div>
      </div>
    </aside>
  );
}

function Topbar() {
  const { data: settings = {} } = useAppSettings();
  const connected = settings['opencode_last_connected'] === 'true';
  return (
    <header className="topbar">
      <div className="breadcrumb">
        <span>Orbyt</span>
        <span className="crumb-slash">/</span>
        <span className="crumb-current">Development control center</span>
      </div>
      <div className="topbar-actions">
        <Link to="/settings" className={`connection-pill ${connected ? 'is-connected' : ''}`}>
          <span className="connection-dot" />
          OpenCode {connected ? 'connected' : 'not verified'}
        </Link>
        <button className="icon-button" aria-label="Help">
          <CircleHelp size={17} />
        </button>
        <div className="user-avatar">Y</div>
      </div>
    </header>
  );
}

function PageHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {action && <div className="heading-action">{action}</div>}
    </div>
  );
}

function Overview() {
  const projectsQuery = useProjects();
  const { data: projects = [], isLoading: loadingProjects, error: projectsError } = projectsQuery;
  const { data: tasks = [], isLoading: loadingTasks, error: tasksError } = useTasks();
  const [onboardingProgress, setOnboardingProgress] = useState(readFirstRunProgress);
  const [onboardingDismissed, setOnboardingDismissed] = useState(readFirstRunDismissed);
  const isLoading = loadingProjects || loadingTasks;
  const effectiveProgress = onboardingProgress
    ? onboardingProgress.projectId &&
      projects.some((project) => project.id === onboardingProgress.projectId)
      ? onboardingProgress
      : onboardingProgress.step === 0 && !onboardingProgress.projectId
        ? onboardingProgress
        : { step: 0 }
    : null;
  const displayProgress =
    effectiveProgress ?? (projectsQuery.isSuccess && projects.length === 0 ? { step: 0 } : null);
  const showOnboarding =
    projectsQuery.isSuccess &&
    !projectsError &&
    !onboardingDismissed &&
    (Boolean(displayProgress) || projects.length === 0);
  const updateOnboarding = (progress: FirstRunProgress | null) => {
    writeFirstRunProgress(progress);
    setOnboardingProgress(progress);
  };
  const dismissOnboarding = () => {
    writeFirstRunDismissed(true);
    setOnboardingDismissed(true);
  };
  const startOnboarding = () => {
    writeFirstRunDismissed(false);
    setOnboardingDismissed(false);
    if (!effectiveProgress) updateOnboarding({ step: 0 });
  };
  const finishOnboarding = () => {
    updateOnboarding(null);
    dismissOnboarding();
  };
  const counts = useMemo(
    () => ({
      pending: tasks.filter((task) =>
        ['pending', 'triaging', 'awaiting_context', 'needs_reconciliation'].includes(task.status),
      ).length,
      approval: tasks.filter((task) => task.status === 'awaiting_approval').length,
      sessions: tasks.filter((task) => task.status === 'running').length,
      queued: tasks.filter((task) => task.status === 'queued').length,
      review: tasks.filter((task) => task.status === 'awaiting_review').length,
    }),
    [tasks],
  );
  if (showOnboarding && displayProgress) {
    return (
      <FirstRunOnboarding
        projects={projects}
        progress={displayProgress}
        onProgress={updateOnboarding}
        onDismiss={dismissOnboarding}
        onFinish={finishOnboarding}
      />
    );
  }
  return (
    <>
      <PageHeading
        eyebrow="DEVELOPMENT CONTROL CENTER"
        title="Your workspace"
        description="Here's what's happening across your development workspace."
        action={
          onboardingProgress ? (
            <button className="button button-primary" onClick={startOnboarding}>
              <RefreshCw size={15} />
              Finish setup
            </button>
          ) : projects.length === 0 ? (
            <button className="button button-primary" onClick={startOnboarding}>
              <Sparkles size={15} />
              Start setup
            </button>
          ) : (
            <Link className="button button-primary" to="/tasks">
              <Plus size={16} />
              New task
            </Link>
          )
        }
      />
      {(projectsError || tasksError) && (
        <ErrorBanner message={errorMessage(projectsError ?? tasksError)} />
      )}
      <section className="metrics-grid" aria-label="Workspace summary">
        <MetricCard
          icon={<FolderKanban size={17} />}
          label="Projects"
          value={projects.length}
          note="Registered workspaces"
          tone="blue"
        />
        <MetricCard
          icon={<Layers3 size={17} />}
          label="Needs attention"
          value={counts.pending}
          note="Tasks to triage"
          tone="amber"
        />
        <MetricCard
          icon={<ShieldCheck size={17} />}
          label="Needs approval"
          value={counts.approval}
          note="Waiting for your approval"
          tone="amber"
        />
        <MetricCard
          icon={<Bot size={17} />}
          label="Active sessions"
          value={counts.sessions}
          note="OpenCode sessions"
          tone="violet"
        />
        <MetricCard
          icon={<Activity size={17} />}
          label="Queued"
          value={counts.queued}
          note="Approved tasks"
          tone="blue"
        />
        <MetricCard
          icon={<Check size={17} />}
          label="Ready for review"
          value={counts.review}
          note="Awaiting your review"
          tone="green"
        />
      </section>
      {isLoading ? (
        <LoadingState label="Loading your workspace" />
      ) : (
        <div className="overview-grid">
          <section className="panel activity-panel">
            <div className="panel-heading">
              <div>
                <h2>Task queue</h2>
                <p>Your work, at a glance</p>
              </div>
              <Link className="text-link" to="/tasks">
                All tasks <ArrowRight size={14} />
              </Link>
            </div>
            {tasks.length ? (
              <TaskTable tasks={tasks.slice(0, 5)} projects={projects} />
            ) : (
              <EmptyState
                icon={<Layers3 size={20} />}
                title="Your queue is clear"
                description="Create a task to start organizing your development work."
                action={
                  <Link to="/tasks" className="button button-secondary button-small">
                    <Plus size={15} />
                    Create a task
                  </Link>
                }
              />
            )}
          </section>
          <aside className="overview-right">
            <section className="panel project-panel">
              <div className="panel-heading">
                <div>
                  <h2>Projects</h2>
                  <p>Local workspaces</p>
                </div>
                <Link to="/projects" className="icon-button subtle" aria-label="Manage projects">
                  <ArrowRight size={16} />
                </Link>
              </div>
              {projects.length ? (
                <div className="mini-project-list">
                  {projects.slice(0, 4).map((project) => (
                    <Link to={`/projects/${project.id}`} className="mini-project" key={project.id}>
                      <div className="mini-project-icon">
                        <GitBranch size={16} />
                      </div>
                      <div className="mini-project-copy">
                        <strong>{project.name}</strong>
                        <span>{project.directory}</span>
                      </div>
                      <ArrowRight size={14} />
                    </Link>
                  ))}
                </div>
              ) : (
                <div className="mini-empty">
                  <p>No project directories registered.</p>
                  <Link className="text-link" to="/projects">
                    Add your first project <ArrowRight size={14} />
                  </Link>
                </div>
              )}
              <Link className="project-add-link" to="/projects">
                <CirclePlus size={15} />
                Add a project
              </Link>
            </section>
            <OpenCodeCard />
          </aside>
        </div>
      )}
    </>
  );
}

const FIRST_RUN_STEPS = ['Project', 'Execution scope', 'OpenCode', 'Sources'];

function FirstRunOnboarding({
  projects,
  progress,
  onProgress,
  onDismiss,
  onFinish,
}: {
  projects: Project[];
  progress: FirstRunProgress;
  onProgress: (progress: FirstRunProgress | null) => void;
  onDismiss: () => void;
  onFinish: () => void;
}) {
  const project = projects.find((item) => item.id === progress.projectId);
  const [projectToUseId, setProjectToUseId] = useState(progress.projectId ?? projects[0]?.id ?? '');
  const [showProjectForm, setShowProjectForm] = useState(false);
  const [showScopeForm, setShowScopeForm] = useState(false);
  const [scopeMessage, setScopeMessage] = useState('');
  const [executable, setExecutable] = useState<string | null>(null);
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const [verification, setVerification] = useState<{
    connected: boolean;
    message: string;
    version?: string | null;
  } | null>(null);
  const [verifyError, setVerifyError] = useState('');
  const { data: settings = {}, isLoading: settingsLoading } = useAppSettings();
  const queryClient = useQueryClient();
  const scopesQuery = useQuery({
    queryKey: ['scopes', project?.id],
    queryFn: () => api.scopes(project!.id),
    enabled: Boolean(project),
  });
  const scopes = scopesQuery.data ?? [];
  const writableScopes = scopes.filter((scope) => scope.writeAccess);
  const step = Math.max(0, Math.min(progress.step, FIRST_RUN_STEPS.length - 1));

  const goTo = (nextStep: number) =>
    onProgress({
      step: Math.max(0, Math.min(nextStep, FIRST_RUN_STEPS.length - 1)),
      projectId: project?.id ?? progress.projectId,
    });

  async function verifyOpenCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setVerifyError('');
    setVerification(null);
    setIsVerifying(true);
    const nextExecutable = executable ?? settings['opencode_executable'] ?? 'opencode';
    const nextEndpoint = endpoint ?? settings['opencode_endpoint'] ?? '';
    try {
      await Promise.all([
        api.saveSetting('opencode_executable', nextExecutable),
        api.saveSetting('opencode_endpoint', nextEndpoint),
      ]);
      const result = await api.verifyOpenCode();
      setVerification(result);
      await api.saveSetting('opencode_last_connected', String(result.connected));
      await queryClient.invalidateQueries({ queryKey: keys.settings });
    } catch (cause) {
      const message = errorMessage(cause);
      setVerifyError(message);
      await api.saveSetting('opencode_last_connected', 'false').catch(() => undefined);
      await queryClient.invalidateQueries({ queryKey: keys.settings });
    } finally {
      setIsVerifying(false);
    }
  }

  return (
    <div className="first-run-page">
      <PageHeading
        eyebrow="FIRST RUN"
        title="Set up Orbyt"
        description="Connect a local project, then configure the tools you want Orbyt to use. You can skip optional steps and finish them later in Settings."
        action={
          <button className="button button-secondary" onClick={onDismiss}>
            Do this later
          </button>
        }
      />
      <section className="first-run-card" aria-labelledby="first-run-step-title">
        <nav className="first-run-steps" aria-label="Setup progress">
          {FIRST_RUN_STEPS.map((label, index) => (
            <button
              className={`first-run-step${index === step ? ' active' : ''}${index < step ? ' complete' : ''}`}
              type="button"
              key={label}
              aria-current={index === step ? 'step' : undefined}
              disabled={index > step}
              onClick={() => goTo(index)}
            >
              <span className="first-run-step-number">
                {index < step ? <Check size={13} /> : index + 1}
              </span>
              {label}
            </button>
          ))}
        </nav>

        <div className="first-run-content">
          {step === 0 && (
            <>
              <div className="first-run-icon">
                <FolderKanban size={20} />
              </div>
              <h2 id="first-run-step-title">Choose a project folder</h2>
              <p>
                Register the local repository Orbyt should work with. Orbyt stores its path and does
                not move or copy your files.
              </p>
              {projects.length > 0 && (
                <div className="first-run-existing-project">
                  <label className="field-label">
                    Use an existing project
                    <select
                      value={projectToUseId || progress.projectId || projects[0]?.id || ''}
                      onChange={(event) => setProjectToUseId(event.target.value)}
                    >
                      {projects.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name} · {item.directory}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="button button-secondary"
                    disabled={projects.length === 0}
                    onClick={() =>
                      onProgress({
                        step: 1,
                        projectId: projectToUseId || progress.projectId || projects[0].id,
                      })
                    }
                  >
                    Continue with project <ArrowRight size={14} />
                  </button>
                </div>
              )}
              <button className="button button-primary" onClick={() => setShowProjectForm(true)}>
                <FolderOpen size={15} />
                Register a project folder
              </button>
            </>
          )}

          {step === 1 && (
            <>
              <div className="first-run-icon">
                <ShieldCheck size={20} />
              </div>
              <h2 id="first-run-step-title">Choose a writable execution scope</h2>
              <p>
                A scope identifies the part of this project where OpenCode may make changes. It is
                the scheduler boundary for approved implementation work, not an operating-system
                sandbox.
              </p>
              {!project ? (
                <LoadingState label="Loading your project" />
              ) : scopesQuery.isLoading ? (
                <LoadingState label="Checking execution scopes" />
              ) : scopesQuery.error ? (
                <ErrorBanner message={errorMessage(scopesQuery.error)} />
              ) : writableScopes.length > 0 ? (
                <div className="first-run-success" role="status">
                  <Check size={16} />
                  {writableScopes.length} writable{' '}
                  {writableScopes.length === 1 ? 'scope is' : 'scopes are'} available for{' '}
                  {project.name}.
                </div>
              ) : (
                <div className="first-run-note">
                  <TriangleAlert size={16} />
                  <span>
                    No writable scope yet. You can continue and add one later before implementation.
                  </span>
                </div>
              )}
              {scopeMessage && (
                <p className="field-hint" role="status">
                  {scopeMessage}
                </p>
              )}
              <div className="first-run-actions">
                <button
                  className="button button-secondary"
                  onClick={() => {
                    setScopeMessage('');
                    setShowScopeForm(true);
                  }}
                  disabled={!project}
                >
                  <Plus size={15} /> Add writable scope
                </button>
                <button
                  className="button button-primary"
                  onClick={() => goTo(2)}
                  disabled={!project || scopesQuery.isLoading}
                >
                  {writableScopes.length > 0 ? 'Continue' : 'Continue without a scope'}{' '}
                  <ArrowRight size={14} />
                </button>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div className="first-run-icon">
                <Command size={20} />
              </div>
              <h2 id="first-run-step-title">Connect OpenCode</h2>
              <p>
                Orbyt uses your installed OpenCode CLI and its existing provider login. Verify the
                connection now or configure it later in Settings.
              </p>
              {settingsLoading ? (
                <LoadingState label="Loading OpenCode settings" />
              ) : (
                <form
                  className="first-run-opencode"
                  onSubmit={(event) => void verifyOpenCode(event)}
                >
                  <label className="field-label">
                    OpenCode executable
                    <input
                      value={executable ?? settings['opencode_executable'] ?? 'opencode'}
                      onChange={(event) => setExecutable(event.target.value)}
                      placeholder="opencode"
                      autoComplete="off"
                    />
                  </label>
                  <label className="field-label">
                    Optional local API endpoint
                    <input
                      value={endpoint ?? settings['opencode_endpoint'] ?? ''}
                      onChange={(event) => setEndpoint(event.target.value)}
                      placeholder="http://127.0.0.1:4096"
                      autoComplete="url"
                    />
                  </label>
                  <div className="first-run-actions">
                    <button
                      className="button button-secondary"
                      type="submit"
                      disabled={isVerifying}
                    >
                      {isVerifying ? (
                        <LoaderCircle className="spin" size={14} />
                      ) : (
                        <RefreshCw size={14} />
                      )}{' '}
                      Verify connection
                    </button>
                    <button className="button button-primary" type="button" onClick={() => goTo(3)}>
                      Continue <ArrowRight size={14} />
                    </button>
                  </div>
                </form>
              )}
              {verification && (
                <div
                  className={verification.connected ? 'first-run-success' : 'first-run-note'}
                  role="status"
                >
                  {verification.connected ? <Check size={16} /> : <TriangleAlert size={16} />}
                  <span>
                    {verification.connected
                      ? `Connected${verification.version ? ` · ${verification.version}` : ''}.`
                      : 'OpenCode could not be verified.'}{' '}
                    {verification.message}
                  </span>
                </div>
              )}
              {verifyError && <ErrorBanner message={verifyError} />}
            </>
          )}

          {step === 3 && (
            <>
              <div className="first-run-icon">
                <GitBranch size={20} />
              </div>
              <h2 id="first-run-step-title">Connect GLPI</h2>
              <p>
                Connect a GLPI 10 instance to import tickets and load linked ticket context. This is
                optional and can be configured later in Settings.
              </p>
              {project ? (
                <SourceIntegrations lockedProjectId={project.id} />
              ) : (
                <ErrorBanner message="The project selected for setup is no longer available. Go back and choose a project." />
              )}
              <div className="first-run-finish">
                <button className="button button-secondary" onClick={onFinish}>
                  Configure sources later
                </button>
                <button className="button button-primary" onClick={onFinish}>
                  <Check size={15} /> Finish setup
                </button>
              </div>
            </>
          )}
        </div>

        {step > 0 && (
          <div className="first-run-footer">
            <button className="button button-secondary" onClick={() => goTo(step - 1)}>
              <ArrowLeft size={14} /> Back
            </button>
            {project && (
              <span>
                Project: <strong>{project.name}</strong>
              </span>
            )}
          </div>
        )}
      </section>
      {showProjectForm && (
        <ProjectForm
          onClose={() => setShowProjectForm(false)}
          onCreated={(createdProject) => {
            setProjectToUseId(createdProject.id);
            onProgress({ step: 1, projectId: createdProject.id });
          }}
        />
      )}
      {showScopeForm && project && (
        <ScopeForm
          project={project}
          onClose={() => setShowScopeForm(false)}
          onCreated={(scope) => {
            setScopeMessage(
              scope.writeAccess
                ? `Writable scope “${scope.name}” added.`
                : 'This scope is read-only. Add a writable scope before starting implementation.',
            );
            if (scope.writeAccess) goTo(2);
          }}
        />
      )}
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
  note,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  note: string;
  tone: string;
}) {
  return (
    <article className="metric-card">
      <div className="metric-top">
        <span className={`metric-icon ${tone}`}>{icon}</span>
        <span className="metric-label">{label}</span>
        <MoreHorizontal size={17} className="metric-more" />
      </div>
      <div className="metric-value">{value.toString().padStart(2, '0')}</div>
      <div className="metric-note">{note}</div>
    </article>
  );
}

function OpenCodeCard() {
  const { data: settings = {} } = useAppSettings();
  const connected = settings['opencode_last_connected'] === 'true';
  return (
    <section className="opencode-card">
      <div className="opencode-card-top">
        <span className="opencode-orbit">
          <Bot size={18} />
        </span>
        <span className={`status-tag ${connected ? 'success' : 'neutral'}`}>
          <span />
          {connected ? 'Connected' : 'Not verified'}
        </span>
      </div>
      <h3>OpenCode</h3>
      <p>
        {connected
          ? 'Your existing OpenCode installation is ready to connect.'
          : 'Connect your existing installation to power future agent workflows.'}
      </p>
      <Link to="/settings" className="opencode-link">
        {connected ? 'Connection settings' : 'Set up connection'}
        <ArrowRight size={14} />
      </Link>
      <div className="opencode-decoration decoration-one" />
      <div className="opencode-decoration decoration-two" />
    </section>
  );
}

function Projects() {
  const queryClient = useQueryClient();
  const { data: projects = [], isLoading, error } = useProjects();
  const [showForm, setShowForm] = useState(false);
  const [filter, setFilter] = useState('');
  const filtered = projects.filter((p) =>
    `${p.name} ${p.directory}`.toLowerCase().includes(filter.toLowerCase()),
  );
  const remove = useMutation({
    mutationFn: api.deleteProject,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.projects });
      void queryClient.invalidateQueries({ queryKey: keys.tasks });
    },
  });
  return (
    <>
      <PageHeading
        eyebrow="WORKSPACE"
        title="Projects"
        description="Manage local directories and define safe execution scopes."
        action={
          <button className="button button-primary" onClick={() => setShowForm(true)}>
            <Plus size={16} />
            Add project
          </button>
        }
      />
      {error && <ErrorBanner message={errorMessage(error)} />}
      {remove.error && <ErrorBanner message={errorMessage(remove.error)} />}
      <div className="toolbar">
        <div className="search-box">
          <Search size={16} />
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Search projects..."
            aria-label="Search projects"
          />
        </div>
        <span className="result-count">
          {projects.length} {projects.length === 1 ? 'project' : 'projects'}
        </span>
      </div>
      {isLoading ? (
        <LoadingState label="Loading projects" />
      ) : filtered.length === 0 ? (
        <EmptyState
          className="large-empty"
          icon={<FolderKanban size={22} />}
          title={projects.length ? 'No matching projects' : 'No projects yet'}
          description={
            projects.length
              ? 'Try a different search term.'
              : 'Register a local workspace to start organizing development tasks.'
          }
          action={
            !projects.length ? (
              <button className="button button-primary" onClick={() => setShowForm(true)}>
                <Plus size={16} />
                Add your first project
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="projects-grid">
          {filtered.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              onDelete={() => {
                if (confirm(`Remove ${project.name} from Orbyt? Its files will not be deleted.`))
                  remove.mutate(project.id);
              }}
            />
          ))}
        </div>
      )}
      {showForm && <ProjectForm onClose={() => setShowForm(false)} />}
    </>
  );
}

function ProjectCard({ project, onDelete }: { project: Project; onDelete: () => void }) {
  const {
    data: scopes,
    isLoading: scopesLoading,
    error: scopesError,
  } = useQuery({
    queryKey: ['scopes', project.id],
    queryFn: () => api.scopes(project.id),
  });
  return (
    <article className="project-card">
      <div className="project-card-top">
        <div className="project-icon">
          <GitBranch size={19} />
        </div>
        <button
          className="icon-button subtle"
          onClick={onDelete}
          aria-label={`Remove ${project.name}`}
        >
          <Trash2 size={15} />
        </button>
      </div>
      <Link className="project-card-title" to={`/projects/${project.id}`}>
        {project.name}
        <ArrowRight size={15} />
      </Link>
      <p className="project-description">{project.description || 'No description added yet.'}</p>
      <div className="project-path">
        <FolderOpen size={14} />
        <span title={project.directory}>{project.directory}</span>
      </div>
      <div className="project-card-footer">
        <span title={scopesError ? errorMessage(scopesError) : undefined}>
          <Layers3 size={14} />
          {scopes !== undefined
            ? `${scopes.length} ${scopes.length === 1 ? 'scope' : 'scopes'}`
            : scopesLoading
              ? 'Loading scopes…'
              : 'Scopes unavailable'}
        </span>
        <span>
          <Activity size={14} />
          Up to {project.maxConcurrentSessions} sessions
        </span>
      </div>
    </article>
  );
}

function ProjectForm({
  onClose,
  project,
  onCreated,
}: {
  onClose: () => void;
  project?: Project;
  onCreated?: (project: Project) => void;
}) {
  const queryClient = useQueryClient();
  const { data: settings = {} } = useAppSettings();
  const [directory, setDirectory] = useState(project?.directory ?? '');
  const [concurrencyOverride, setConcurrencyOverride] = useState<number | null>(
    project?.maxConcurrentSessions ?? null,
  );
  const [message, setMessage] = useState('');
  const concurrency =
    concurrencyOverride ??
    Number(settings['max_concurrent_sessions'] ?? String(DEFAULT_MAX_CONCURRENT_SESSIONS));
  const save = useMutation({
    mutationFn: (input: {
      name: string;
      description: string;
      directory: string;
      maxConcurrentSessions: number;
    }) => (project ? api.updateProject(project.id, input) : api.createProject(input)),
    onSuccess: (savedProject) => {
      void queryClient.invalidateQueries({ queryKey: keys.projects });
      if (!project) onCreated?.(savedProject);
      onClose();
    },
    onError: (error) => setMessage(errorMessage(error)),
  });
  async function chooseDirectory() {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Choose a project directory',
      });
      if (typeof selected === 'string') setDirectory(selected);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    save.mutate({
      name: String(data.get('name')).trim(),
      description: String(data.get('description')).trim(),
      directory,
      maxConcurrentSessions: Number(data.get('concurrency')),
    });
  }
  return (
    <Modal
      title={project ? 'Edit project' : 'Add a project'}
      subtitle="Connect a local workspace. Orbyt never moves or copies your source files."
      onClose={onClose}
    >
      <form onSubmit={submit} className="form-stack">
        <label className="field-label">
          Project name
          <input
            name="name"
            required
            maxLength={100}
            defaultValue={project?.name}
            placeholder="e.g. GLPI"
          />
        </label>
        <label className="field-label">
          Description <span className="optional">Optional</span>
          <textarea
            name="description"
            rows={2}
            maxLength={500}
            defaultValue={project?.description}
            placeholder="What are you building?"
          />
        </label>
        <div className="field-label">
          Project directory
          <div className="directory-input">
            <input
              value={directory}
              onChange={(event) => setDirectory(event.target.value)}
              required
              placeholder="Select an existing folder"
            />
            <button
              className="button button-secondary"
              type="button"
              onClick={() => void chooseDirectory()}
            >
              <FolderOpen size={15} />
              Browse
            </button>
          </div>
          <span className="field-hint">
            Select the actual local project root. Files remain in place.
          </span>
        </div>
        <label className="field-label">
          Maximum concurrent sessions
          <select
            name="concurrency"
            value={concurrency}
            onChange={(event) => setConcurrencyOverride(Number(event.target.value))}
          >
            {[1, 2, 3, 4, 5, 6, 8].map((n) => (
              <option key={n} value={n}>
                {n} {n === 1 ? 'session' : 'sessions'}
              </option>
            ))}
          </select>
          <span className="field-hint">Tasks targeting overlapping scopes will be serialized.</span>
        </label>
        {message && (
          <div className="form-error">
            <AlertCircle size={15} />
            {message}
          </div>
        )}
        <div className="modal-actions">
          <button className="button button-secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button button-primary" disabled={save.isPending || !directory}>
            {save.isPending ? (
              <LoaderCircle className="spin" size={15} />
            ) : project ? (
              <Check size={15} />
            ) : (
              <Plus size={15} />
            )}
            {project ? 'Save project' : 'Register project'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ProjectDetail() {
  const { projectId = '' } = useParams();
  const queryClient = useQueryClient();
  const {
    data: projects = [],
    isLoading: projectsLoading,
    isFetching: projectsFetching,
    error: projectsError,
  } = useProjects();
  const project = projects.find((p) => p.id === projectId);
  const {
    data: scopes = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ['scopes', projectId],
    queryFn: () => api.scopes(projectId),
    enabled: Boolean(projectId),
  });
  const [showForm, setShowForm] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const remove = useMutation({
    mutationFn: api.deleteScope,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['scopes', projectId] }),
  });
  if (!project && (projectsLoading || projectsFetching))
    return (
      <>
        <PageHeading title="Loading project" />
        <LoadingState label="Loading project details" />
      </>
    );
  if (!project && projectsError)
    return (
      <>
        <PageHeading
          title="Could not load project"
          description="Orbyt could not retrieve the registered projects."
        />
        <ErrorBanner message={errorMessage(projectsError)} />
        <Link className="button button-secondary" to="/projects">
          Back to projects
        </Link>
      </>
    );
  if (!project)
    return (
      <>
        <PageHeading
          title="Project not found"
          description="This project may have been removed from Orbyt."
        />
        <Link className="button button-secondary" to="/projects">
          Back to projects
        </Link>
      </>
    );
  return (
    <>
      <div className="back-link-row">
        <Link to="/projects" className="text-link">
          <ArrowDownLeft size={14} />
          All projects
        </Link>
      </div>
      <PageHeading
        eyebrow="PROJECT SETTINGS"
        title={project.name}
        description={project.directory}
        action={
          <div className="button-row">
            <button className="button button-secondary" onClick={() => setShowEdit(true)}>
              <Settings2 size={15} />
              Edit project
            </button>
            <button className="button button-primary" onClick={() => setShowForm(true)}>
              <Plus size={16} />
              Add execution scope
            </button>
          </div>
        }
      />
      <div className="detail-summary">
        <div>
          <span className="summary-label">Concurrency limit</span>
          <strong>{project.maxConcurrentSessions} sessions</strong>
        </div>
        <div>
          <span className="summary-label">Approval policy</span>
          <strong>
            <ShieldCheck size={15} /> Explicit approval required before implementation
          </strong>
        </div>
        <div>
          <span className="summary-label">Execution mode</span>
          <strong>Existing workspace · no copies</strong>
        </div>
      </div>
      <section className="panel scopes-panel">
        <div className="panel-heading">
          <div>
            <h2>Execution scopes</h2>
            <p>
              Directories an approved task may target. Scope selection does not itself isolate agent
              writes.
            </p>
          </div>
        </div>
        {error && <ErrorBanner message={errorMessage(error)} />}
        {remove.error && <ErrorBanner message={errorMessage(remove.error)} />}
        {isLoading ? (
          <LoadingState label="Loading execution scopes" />
        ) : scopes.length ? (
          <div className="scope-list">
            {scopes.map((scope) => (
              <ScopeRow
                key={scope.id}
                scope={scope}
                onDelete={() => {
                  if (confirm(`Remove the “${scope.name}” scope?`)) remove.mutate(scope.id);
                }}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<ShieldCheck size={20} />}
            title="No execution scopes defined"
            description="Add target directories such as plugins/monitoring. Shared core files stay outside task scope."
            action={
              <button
                className="button button-secondary button-small"
                onClick={() => setShowForm(true)}
              >
                <Plus size={15} />
                Add a scope
              </button>
            }
          />
        )}
      </section>
      {showForm && <ScopeForm project={project} onClose={() => setShowForm(false)} />}
      {showEdit && <ProjectForm project={project} onClose={() => setShowEdit(false)} />}
    </>
  );
}

function ScopeRow({ scope, onDelete }: { scope: ExecutionScope; onDelete: () => void }) {
  return (
    <div className="scope-row">
      <div className="scope-icon">
        <FolderOpen size={16} />
      </div>
      <div className="scope-name">
        <strong>{scope.name}</strong>
        <span>{scope.relativeDirectory}</span>
      </div>
      <div className="scope-access">
        <span className={scope.readAccess ? 'access-enabled' : ''}>
          <Search size={13} />
          Read
        </span>
        <span className={scope.writeAccess ? 'access-write' : ''}>
          <GitBranch size={13} />
          Write
        </span>
      </div>
      <span className="scope-policy">
        <span className="online-dot" />
        Serialize conflicts
      </span>
      <button className="icon-button subtle" onClick={onDelete} aria-label={`Remove ${scope.name}`}>
        <Trash2 size={15} />
      </button>
    </div>
  );
}

function ScopeForm({
  project,
  onClose,
  onCreated,
}: {
  project: Project;
  onClose: () => void;
  onCreated?: (scope: ExecutionScope) => void;
}) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState('');
  const create = useMutation({
    mutationFn: api.createScope,
    onSuccess: (scope) => {
      void queryClient.invalidateQueries({ queryKey: ['scopes', project.id] });
      onCreated?.(scope);
      onClose();
    },
    onError: (error) => setMessage(errorMessage(error)),
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    create.mutate({
      projectId: project.id,
      name: String(data.get('name')).trim(),
      relativeDirectory: String(data.get('directory')).trim(),
      readAccess: true,
      writeAccess: data.get('write') === 'on',
    });
  }
  return (
    <Modal
      title="Add execution scope"
      subtitle="Scopes are relative to this project and must resolve to an existing directory."
      onClose={onClose}
    >
      <form className="form-stack" onSubmit={submit}>
        <label className="field-label">
          Scope name
          <input name="name" required maxLength={100} placeholder="e.g. Monitoring plugin" />
        </label>
        <label className="field-label">
          Relative directory
          <input name="directory" required placeholder="plugins/monitoring" />
          <span className="field-hint">
            Path traversal and symlink escapes are rejected by the native backend.
          </span>
        </label>
        <label className="check-field">
          <input type="checkbox" checked readOnly />
          <span>
            <strong>Read access</strong>
            <small>Agents may need to inspect the shared project source.</small>
          </span>
        </label>
        <label className="check-field">
          <input type="checkbox" name="write" defaultChecked />
          <span>
            <strong>Write access</strong>
            <small>This is the approved target for future implementation sessions.</small>
          </span>
        </label>
        <div className="scope-security-note">
          <TriangleAlert size={15} />
          <span>
            An approved task can start an OpenCode implementation in this scope. Scope boundaries
            coordinate Orbyt runs but do not isolate filesystem access at the operating-system
            level.
          </span>
        </div>
        {message && (
          <div className="form-error">
            <AlertCircle size={15} />
            {message}
          </div>
        )}
        <div className="modal-actions">
          <button className="button button-secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button button-primary" disabled={create.isPending}>
            {create.isPending ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}Add
            scope
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Tasks() {
  const queryClient = useQueryClient();
  const { data: tasks = [], isLoading, error } = useTasks();
  const { data: projects = [] } = useProjects();
  const [showForm, setShowForm] = useState(false);
  const [editingTask, setEditingTask] = useState<Task>();
  const [projectFilter, setProjectFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const remove = useMutation({
    mutationFn: api.deleteTask,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: keys.tasks }),
  });
  const visible = tasks.filter(
    (task) =>
      (projectFilter === 'all' || task.projectId === projectFilter) &&
      (statusFilter === 'all' || task.status === statusFilter),
  );
  return (
    <>
      <PageHeading
        eyebrow="WORK QUEUE"
        title="Tasks"
        description="Keep development requests organized across your local projects."
        action={
          <button
            className="button button-primary"
            onClick={() => {
              setEditingTask(undefined);
              setShowForm(true);
            }}
          >
            <Plus size={16} />
            New task
          </button>
        }
      />
      {(error || remove.error) && <ErrorBanner message={errorMessage(error ?? remove.error)} />}
      <div className="toolbar task-toolbar">
        <div className="filter-group">
          <label className="select-filter">
            <span>Project</span>
            <select
              aria-label="Filter by project"
              value={projectFilter}
              onChange={(event) => setProjectFilter(event.target.value)}
            >
              <option value="all">All projects</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <label className="select-filter">
            <span>Status</span>
            <select
              aria-label="Filter by status"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="all">All statuses</option>
              {[
                'pending',
                'triaging',
                'awaiting_context',
                'awaiting_approval',
                'needs_reconciliation',
                'queued',
                'running',
                'awaiting_review',
                'completed',
                'blocked',
                'failed',
                'canceled',
              ].map((status) => (
                <option value={status} key={status}>
                  {formatStatus(status)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <span className="result-count">
          {visible.length} {visible.length === 1 ? 'task' : 'tasks'}
        </span>
      </div>
      {isLoading ? (
        <LoadingState label="Loading tasks" />
      ) : visible.length === 0 ? (
        <EmptyState
          className="large-empty"
          icon={<Layers3 size={22} />}
          title={tasks.length ? 'No tasks match these filters' : 'Start with a task'}
          description={
            tasks.length
              ? 'Try changing the selected filters.'
              : 'Add a manual development task and attach it to a project and execution scope.'
          }
          action={
            tasks.length ? undefined : (
              <button
                className="button button-primary"
                onClick={() => {
                  setEditingTask(undefined);
                  setShowForm(true);
                }}
              >
                <Plus size={16} />
                Create your first task
              </button>
            )
          }
        />
      ) : (
        <section className="panel task-list-panel">
          <div className="task-list-head">
            <span>TASK</span>
            <span>PROJECT / SCOPE</span>
            <span>PRIORITY</span>
            <span>STATUS</span>
            <span />
          </div>
          {visible.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              projects={projects}
              onEdit={() => {
                setEditingTask(task);
                setShowForm(true);
              }}
              onDelete={() => {
                if (confirm(`Delete task “${task.title}”?`)) remove.mutate(task.id);
              }}
            />
          ))}
        </section>
      )}
      {showForm && (
        <TaskForm
          task={editingTask}
          projects={projects}
          onClose={() => {
            setShowForm(false);
            setEditingTask(undefined);
          }}
        />
      )}
    </>
  );
}

const FLOW_STAGES = [
  {
    id: 'intake',
    title: 'GLPI intake',
    statuses: ['pending'] as TaskStatus[],
    detail:
      'A connected GLPI 10 source is polled while Orbyt is open (on startup and every five minutes). Imported ticket text is stored as a task; automatic triage is separately opt-in.',
  },
  {
    id: 'triage',
    title: 'Stateless triage',
    statuses: ['triaging'] as TaskStatus[],
    detail:
      'Triage sends task text plus linked GLPI ticket text, public follow-ups, and attachment metadata to the configured OpenCode model. It does not inspect repository files, invoke tools, create a session, or send attachment bytes.',
  },
  {
    id: 'context',
    title: 'Context needed',
    statuses: ['awaiting_context'] as TaskStatus[],
    detail:
      'When the task lacks context, Orbyt can prepare a public follow-up question from the triage report. You review the exact message and explicitly confirm before it is posted to GLPI; replies can then be triaged again.',
  },
  {
    id: 'approval',
    title: 'Approval gate',
    statuses: ['awaiting_approval'] as TaskStatus[],
    detail:
      'Sufficient context leads here. Starting implementation always requires explicit user approval; GLPI auto-triage never auto-starts ACP execution.',
  },
  {
    id: 'executor',
    title: 'OpenCode ACP',
    statuses: ['queued', 'running', 'needs_reconciliation'] as TaskStatus[],
    detail:
      'After approval, the private ACP executor starts in the registered project root so project-wide context remains available. The writable scope coordinates Orbyt runs but is not an OS sandbox; OpenCode’s effective permissions remain authoritative.',
  },
  {
    id: 'review',
    title: 'Awaiting review',
    statuses: ['awaiting_review'] as TaskStatus[],
    detail:
      'A finished implementation returns to Orbyt for your review. Inspect the outcome before marking the task complete.',
  },
] as const;

function Flow() {
  const { data: tasks, isLoading, error } = useTasks();
  const { data: projects = [] } = useProjects();
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const projectId = selectedProjectId || projects[0]?.id || '';
  const {
    data: resources,
    isLoading: resourcesLoading,
    error: resourcesError,
  } = useQuery({
    queryKey: ['project-workflow-resources', projectId],
    queryFn: () => api.projectWorkflowResources(projectId),
    enabled: Boolean(projectId),
  });
  const [selected, setSelected] = useState<string>('intake');
  const [syncWarning, setSyncWarning] = useState('');
  const selectedStage = FLOW_STAGES.find((stage) => stage.id === selected) ?? FLOW_STAGES[0];
  useEffect(() => {
    const handleWarning = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      if (detail) setSyncWarning(detail);
    };
    window.addEventListener('orbyt:glpi-sync-warning', handleWarning);
    return () => window.removeEventListener('orbyt:glpi-sync-warning', handleWarning);
  }, []);
  return (
    <>
      <PageHeading
        eyebrow="WORKFLOW"
        title="Flow"
        description="How GLPI tickets move through Orbyt, from intake to your review."
      />
      {error && <ErrorBanner message={errorMessage(error)} />}
      {syncWarning && (
        <div className="settings-note" role="status">
          {syncWarning}
        </div>
      )}
      {isLoading || !tasks ? (
        <LoadingState label="Loading workflow task counts" />
      ) : (
        <>
          <section className="panel" aria-label="Task workflow stages" style={{ padding: 22 }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                gap: 14,
                alignItems: 'stretch',
              }}
            >
              {FLOW_STAGES.map((stage, index) => {
                const count = tasks.filter((task) => stage.statuses.includes(task.status)).length;
                return (
                  <div key={stage.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button
                      type="button"
                      className={`metric-card${selected === stage.id ? ' active' : ''}`}
                      aria-pressed={selected === stage.id}
                      aria-label={`${stage.title}, ${count} current ${count === 1 ? 'task' : 'tasks'}`}
                      onClick={() => setSelected(stage.id)}
                      style={{ textAlign: 'left', width: '100%', cursor: 'pointer' }}
                    >
                      <span className="metric-label">{stage.title}</span>
                      <span className="metric-value">{count.toString().padStart(2, '0')}</span>
                      <span className="metric-note">current tasks</span>
                    </button>
                    {index < FLOW_STAGES.length - 1 && (
                      <ArrowRight aria-hidden="true" size={17} style={{ flex: '0 0 auto' }} />
                    )}
                  </div>
                );
              })}
            </div>
            <p className="field-hint" style={{ marginTop: 14 }}>
              Triage branches: missing context → reviewed public GLPI question; sufficient context →
              explicit approval → ACP. A do-not-proceed recommendation becomes blocked.
            </p>
            <div
              aria-label="Triage decision branches"
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                gap: 12,
                marginTop: 12,
              }}
            >
              <div className="mini-empty">
                <strong>
                  Needs context ·{' '}
                  {tasks.filter((task) => task.status === 'awaiting_context').length}
                </strong>
                <p>Review a proposed public follow-up, then wait for a ticket reply.</p>
              </div>
              <div className="mini-empty">
                <strong>
                  Sufficient · {tasks.filter((task) => task.status === 'awaiting_approval').length}
                </strong>
                <p>Wait at the user approval gate before an ACP run can start.</p>
              </div>
              <div className="mini-empty">
                <strong>
                  Do not proceed · {tasks.filter((task) => task.status === 'blocked').length}
                </strong>
                <p>Triage may recommend blocking instead of continuing.</p>
              </div>
            </div>
          </section>
          <section className="panel" aria-live="polite" style={{ padding: 22, marginTop: 16 }}>
            <div className="panel-heading">
              <div>
                <h2>{selectedStage.title}</h2>
                <p>
                  {tasks.filter((task) => selectedStage.statuses.includes(task.status)).length}{' '}
                  current tasks in this stage
                </p>
              </div>
            </div>
            <p>{selectedStage.detail}</p>
            {tasks.filter((task) => selectedStage.statuses.includes(task.status)).length === 0 ? (
              <p className="empty-copy">No tasks are currently in this stage.</p>
            ) : (
              <ul>
                {tasks
                  .filter((task) => selectedStage.statuses.includes(task.status))
                  .map((task) => (
                    <li key={task.id}>
                      {task.title} · {formatStatus(task.status)}
                    </li>
                  ))}
              </ul>
            )}
          </section>
          <section className="panel" style={{ padding: 22, marginTop: 16 }}>
            <h2>Observed project resources</h2>
            {projects.length > 1 && (
              <label className="field-label">
                Project root
                <select
                  value={projectId}
                  onChange={(event) => setSelectedProjectId(event.target.value)}
                >
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name} · {project.directory}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {resourcesLoading ? (
              <LoadingState label="Checking project resources" />
            ) : resourcesError ? (
              <ErrorBanner message={errorMessage(resourcesError)} />
            ) : resources ? (
              <>
                <p>
                  Working directory: <code>{resources.workingDirectory}</code>
                </p>
                <p>{resources.discoveryNote}</p>
                {(
                  [
                    ['Skills', resources.skills],
                    ['Commands', resources.commands],
                    ['Agents', resources.agents],
                    ['Instructions', resources.instructions],
                    ['OpenCode configs', resources.configs],
                  ] as const
                ).map(([label, items]) => (
                  <div key={label}>
                    <strong>
                      {label} identified · {items.length}
                    </strong>
                    {items.length === 0 ? (
                      <p className="empty-copy">None detected in the supported project paths.</p>
                    ) : (
                      <ul>
                        {items.map((item) => (
                          <li key={item.relativePath}>
                            <code>{item.name}</code> · <code>{item.relativePath}</code>
                            {item.description ? ` — ${item.description}` : ''}
                            {!item.readable && ' · unreadable or over the inspection limit'}
                            {item.readable && !item.parseable && ' · not parseable'}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </>
            ) : (
              <p className="empty-copy">Add a project to inspect its project-level resources.</p>
            )}
            <p>
              Recent project sessions observed the <code>build</code> command; that is session
              history, not proof that a resource loaded in every ACP run or a named Orbyt
              triage/executor agent.
            </p>
            <div className="scope-security-note" role="note">
              <TriangleAlert size={15} />
              <span>
                The configured <code>plugins/</code> write scope is broad. Scheduler scopes
                coordinate Orbyt work; they are not an OS sandbox, and OpenCode’s effective
                permissions still apply.
              </span>
            </div>
          </section>
        </>
      )}
    </>
  );
}

function TaskRow({
  task,
  projects,
  onDelete,
  onEdit,
}: {
  task: Task;
  projects: Project[];
  onDelete: () => void;
  onEdit: () => void;
}) {
  const queryClient = useQueryClient();
  const project = projects.find((item) => item.id === task.projectId);
  const {
    data: scopes = [],
    isLoading: scopesLoading,
    error: scopesError,
  } = useQuery({
    queryKey: ['scopes', task.projectId],
    queryFn: () => api.scopes(task.projectId),
    enabled: Boolean(task.projectId),
  });
  const scope = scopes.find((item) => item.id === task.scopeId);
  const { data: triageResult = null, error: triageLoadError } = useQuery({
    queryKey: ['task-triage', task.id],
    queryFn: () => api.taskTriage(task.id),
  });
  const triage = useMutation({
    mutationFn: () => api.triageTask(task.id),
    onSuccess: ({ task: updatedTask, result }) => {
      queryClient.setQueryData(['task-triage', task.id], result);
      queryClient.setQueryData<Task[]>(keys.tasks, (current) =>
        current?.map((item) => (item.id === updatedTask.id ? updatedTask : item)),
      );
      void queryClient.invalidateQueries({ queryKey: keys.tasks });
    },
    onError: () => void queryClient.invalidateQueries({ queryKey: keys.tasks }),
  });
  const transition = useMutation({
    mutationFn: (toStatus: TaskStatus) => api.transitionTask(task.id, toStatus),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: keys.tasks }),
  });
  const [confirmBroadScope, setConfirmBroadScope] = useState(false);
  const startExecution = useMutation({
    mutationFn: (confirmScope: boolean) => api.queueTaskExecution(task.id, confirmScope),
    onSuccess: (run) => {
      queryClient.setQueryData<TaskRun[]>(['task-runs', task.id], (current) => {
        const runs = current ?? [];
        return [run, ...runs.filter((item) => item.id !== run.id)];
      });
      setConfirmBroadScope(false);
      void queryClient.invalidateQueries({ queryKey: ['task-runs', task.id] });
      void queryClient.invalidateQueries({ queryKey: keys.tasks });
    },
    onError: () => void queryClient.invalidateQueries({ queryKey: keys.tasks }),
  });
  const canTriage = ['pending', 'awaiting_context', 'failed'].includes(task.status);
  const canStartExecution =
    task.status === 'awaiting_approval' && (task.scopeId === null || Boolean(scope?.writeAccess));
  return (
    <>
      <div className="task-row">
        <div className="task-title-cell">
          <span className="task-source-icon">
            {task.source === 'github' ? <GitBranch size={15} /> : <Layers3 size={15} />}
          </span>
          <div>
            <strong>{task.title}</strong>
            <span>{task.description || 'No additional description'}</span>
            {task.source !== 'manual' && (
              <small className="task-source-reference">
                {task.source === 'github' ? 'Legacy source' : 'GLPI'} · {task.externalReference}
                {task.externalStatus ? ` · remote: ${task.externalStatus}` : ''}
              </small>
            )}
            {task.externalUrl && task.source !== 'github' && (
              <a
                className="task-source-reference"
                href={task.externalUrl}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open external link for ${task.title} (opens in a new tab)`}
              >
                <ExternalLink size={13} /> Open linked GLPI ticket
              </a>
            )}
          </div>
        </div>
        <div className="task-project-cell">
          <strong>{project?.name ?? 'Unknown project'}</strong>
          <span>{scope?.relativeDirectory ?? 'No scope selected'}</span>
        </div>
        <span className={`priority priority-${task.priority}`}>
          <i />
          {task.priority}
        </span>
        <span className={`task-status status-${task.status}`}>
          <i />
          {formatStatus(task.status)}
        </span>
        <div className="task-row-actions">
          <button
            className="icon-button subtle task-delete"
            onClick={onEdit}
            aria-label={`Edit ${task.title}`}
          >
            <Settings2 size={14} />
          </button>
          <button
            className="icon-button subtle task-delete"
            onClick={onDelete}
            aria-label={`Delete ${task.title}`}
          >
            <Trash2 size={14} />
          </button>
          <details>
            <summary aria-label={`Actions for ${task.title}`}>Actions</summary>
            <div className="form-stack" style={{ minWidth: 230, padding: 10 }}>
              {canTriage && (
                <button
                  className="button button-primary button-small"
                  disabled={triage.isPending || transition.isPending}
                  onClick={() => triage.mutate()}
                >
                  {triage.isPending ? (
                    <LoaderCircle className="spin" size={14} />
                  ) : (
                    <Sparkles size={14} />
                  )}
                  {triage.isPending ? 'Triaging…' : 'Run triage'}
                </button>
              )}
              {canStartExecution && (
                <button
                  className="button button-primary button-small"
                  disabled={startExecution.isPending || triage.isPending || transition.isPending}
                  onClick={() => {
                    if (task.scopeId === null) setConfirmBroadScope(true);
                    else startExecution.mutate(false);
                  }}
                >
                  {startExecution.isPending ? (
                    <LoaderCircle className="spin" size={14} />
                  ) : (
                    <SquareTerminal size={14} />
                  )}
                  {startExecution.isPending ? 'Starting…' : 'Approve and start implementation'}
                </button>
              )}
              {task.status === 'awaiting_approval' &&
                task.scopeId !== null &&
                !canStartExecution &&
                !scopesError && (
                  <p className="field-hint" role="status">
                    {scopesLoading
                      ? 'Checking the assigned execution scope…'
                      : scope
                        ? 'This scope is read-only. Choose a write-enabled scope before starting implementation.'
                        : 'The assigned scope is unavailable. Edit this task and choose an available scope.'}
                  </p>
                )}
              {availableTransitions(task.status)
                .filter((nextStatus) => !['triaging', 'queued', 'running'].includes(nextStatus))
                .map((nextStatus) => (
                  <button
                    className="button button-secondary button-small"
                    key={nextStatus}
                    disabled={triage.isPending || transition.isPending || startExecution.isPending}
                    onClick={() => transition.mutate(nextStatus)}
                  >
                    {transition.isPending && transition.variables === nextStatus ? (
                      <LoaderCircle className="spin" size={14} />
                    ) : null}
                    {transitionLabel(nextStatus)}
                  </button>
                ))}
            </div>
          </details>
        </div>
      </div>
      {(scopesError ||
        triageLoadError ||
        triage.error ||
        transition.error ||
        startExecution.error) && (
        <div style={{ padding: '0 13px 10px' }}>
          <ErrorBanner
            message={errorMessage(
              scopesError ??
                triageLoadError ??
                triage.error ??
                transition.error ??
                startExecution.error,
            )}
          />
        </div>
      )}
      {triageResult && (
        <TriageReport result={triageResult} taskStatus={task.status as TaskStatus} />
      )}
      {task.linkedGlpiTicketId && <LinkedGlpiTicket task={task} triage={triageResult} />}
      <TaskExecutionRuns task={task} />
      {confirmBroadScope && (
        <Modal
          title="Confirm project-wide write scope"
          subtitle="This task does not have a specific execution scope selected."
          onClose={() => {
            if (!startExecution.isPending) setConfirmBroadScope(false);
          }}
        >
          <div className="form-stack">
            <div className="scope-security-note" role="note">
              <TriangleAlert size={16} />
              <span>
                The entire project directory will be the scheduler write lock for this run. A scope
                is a scheduling boundary only; it does not sandbox filesystem access or restrict
                OpenCode at the operating-system level.
              </span>
            </div>
            {startExecution.error && <ErrorBanner message={errorMessage(startExecution.error)} />}
            <div className="modal-actions">
              <button
                className="button button-secondary"
                type="button"
                disabled={startExecution.isPending}
                onClick={() => setConfirmBroadScope(false)}
              >
                Cancel
              </button>
              <button
                className="button button-primary"
                type="button"
                disabled={startExecution.isPending}
                onClick={() => startExecution.mutate(true)}
              >
                {startExecution.isPending ? (
                  <LoaderCircle className="spin" size={15} />
                ) : (
                  <SquareTerminal size={15} />
                )}
                Confirm broad scope and start
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

function LinkedGlpiTicket({ task, triage }: { task: Task; triage: TriageResult | null }) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [questionDraftState, setQuestionDraftState] = useState<{
    key: string;
    value: string;
  } | null>(null);
  const [notice, setNotice] = useState('');
  const [downloadedUrls, setDownloadedUrls] = useState<Record<number, string>>({});
  const downloadedUrlsRef = useRef(downloadedUrls);
  const ownFollowupIds = useRef(new Set<number>());
  const seenFollowupIds = useRef(new Set<number>());
  const hasFollowupBaseline = useRef(false);
  const draftKey = `${task.id}:${task.updatedAt}:${JSON.stringify(triage?.missingInformation ?? [])}`;
  const generatedQuestionDraft =
    task.status === 'awaiting_context' && triage?.missingInformation.length
      ? `Para conseguirmos iniciar esta solicitação, poderia esclarecer:\n${triage.missingInformation
          .map((item) => `- ${item}`)
          .join('\n')}`
      : '';
  const questionDraft =
    questionDraftState?.key === draftKey ? questionDraftState.value : generatedQuestionDraft;

  useEffect(() => {
    downloadedUrlsRef.current = downloadedUrls;
  }, [downloadedUrls]);

  const contextQuery = useQuery({
    queryKey: ['task-glpi-context', task.id],
    queryFn: () => api.taskGlpiContext(task.id),
    enabled: expanded,
    refetchInterval: expanded && task.status === 'awaiting_context' ? 30_000 : false,
  });
  const download = useMutation({
    mutationFn: (documentId: number) => api.downloadTaskGlpiDocument(task.id, documentId),
    onSuccess: (file) => {
      const oldUrl = downloadedUrlsRef.current[file.documentId];
      if (oldUrl) URL.revokeObjectURL(oldUrl);
      const url = URL.createObjectURL(
        new Blob([new Uint8Array(file.bytes)], { type: file.mimeType }),
      );
      setDownloadedUrls((current) => ({ ...current, [file.documentId]: url }));
    },
  });
  const postQuestion = useMutation({
    mutationFn: () => api.postGlpiContextQuestion(task.id, questionDraft),
    onSuccess: (followupId) => {
      ownFollowupIds.current.add(followupId);
      seenFollowupIds.current.add(followupId);
      setNotice(
        `Public GLPI follow-up #${followupId} posted. Orbyt will refresh this ticket while it is open.`,
      );
      void queryClient.invalidateQueries({ queryKey: ['task-glpi-context', task.id] });
    },
  });
  const triageReply = useMutation({
    mutationFn: () => api.triageTask(task.id),
    onSuccess: ({ task: updatedTask, result }) => {
      queryClient.setQueryData(['task-triage', task.id], result);
      queryClient.setQueryData<Task[]>(keys.tasks, (current) =>
        current?.map((item) => (item.id === updatedTask.id ? updatedTask : item)),
      );
      setNotice('New public GLPI reply received and triaged. Review the updated task state.');
      void queryClient.invalidateQueries({ queryKey: keys.tasks });
    },
    onError: (cause) => setNotice(`Could not triage the GLPI reply: ${errorMessage(cause)}`),
  });

  useEffect(() => {
    const followups = contextQuery.data?.context.publicFollowups;
    if (!followups) return;
    if (!hasFollowupBaseline.current) {
      followups.forEach((followup) => seenFollowupIds.current.add(followup.id));
      hasFollowupBaseline.current = true;
      return;
    }
    const newReply = followups.some(
      (followup) =>
        !seenFollowupIds.current.has(followup.id) && !ownFollowupIds.current.has(followup.id),
    );
    followups.forEach((followup) => seenFollowupIds.current.add(followup.id));
    if (newReply && task.status === 'awaiting_context' && !triageReply.isPending) {
      triageReply.mutate();
    }
  }, [contextQuery.data, task.status, triageReply]);

  useEffect(() => () => {
    Object.values(downloadedUrlsRef.current).forEach((url) => URL.revokeObjectURL(url));
  });

  const linked = contextQuery.data;
  const context = linked?.context;
  return (
    <section className="task-glpi-context" style={{ padding: '10px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <strong>GLPI ticket #{task.linkedGlpiTicketId}</strong>
        <button
          className="button button-secondary button-small"
          type="button"
          onClick={() => {
            setExpanded((current) => !current);
            setNotice('');
          }}
        >
          {expanded ? 'Hide ticket details' : 'Load ticket details'}
        </button>
        {linked?.ticketUrl && (
          <a href={linked.ticketUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={13} /> Open in GLPI
          </a>
        )}
      </div>
      {expanded && (
        <div className="form-stack" style={{ marginTop: 10 }}>
          {contextQuery.isLoading && <LoadingState label="Loading GLPI ticket context" />}
          {contextQuery.error && <ErrorBanner message={errorMessage(contextQuery.error)} />}
          {context && (
            <>
              <div>
                <strong>{context.ticket.title}</strong>
                <div style={{ whiteSpace: 'pre-wrap', marginTop: 6 }}>{context.ticket.content}</div>
              </div>
              <div>
                <strong>Public follow-ups</strong>
                {context.publicFollowups.length === 0 ? (
                  <p className="empty-copy">No public follow-ups.</p>
                ) : (
                  <div className="form-stack" style={{ marginTop: 6 }}>
                    {[...context.publicFollowups].reverse().map((followup) => (
                      <div className="panel" key={followup.id} style={{ padding: 10 }}>
                        <small>{followup.date ?? 'Date unavailable'}</small>
                        <div style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>
                          {followup.content}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <strong>Attachments</strong>
                {context.documents.length === 0 ? (
                  <p className="empty-copy">No attachments found.</p>
                ) : (
                  <div className="form-stack" style={{ marginTop: 6 }}>
                    {context.documents.map((document) => (
                      <div key={document.id} className="source-connection-row">
                        <span>
                          <Paperclip size={14} /> {document.filename || document.name}
                          {document.mimeType ? ` · ${document.mimeType}` : ''}
                          {document.sizeBytes
                            ? ` · ${Math.ceil(document.sizeBytes / 1024)} KB`
                            : ''}
                        </span>
                        {downloadedUrls[document.id] ? (
                          document.mimeType?.startsWith('image/') ? (
                            <a href={downloadedUrls[document.id]} target="_blank" rel="noreferrer">
                              Preview image
                            </a>
                          ) : (
                            <a href={downloadedUrls[document.id]} download={document.filename}>
                              Download
                            </a>
                          )
                        ) : (
                          <button
                            className="button button-secondary button-small"
                            type="button"
                            disabled={download.isPending}
                            onClick={() => download.mutate(document.id)}
                          >
                            {download.isPending && download.variables === document.id
                              ? 'Loading…'
                              : 'Load attachment'}
                          </button>
                        )}
                        {downloadedUrls[document.id] && document.mimeType?.startsWith('image/') && (
                          <img
                            src={downloadedUrls[document.id]}
                            alt={document.filename || document.name}
                            style={{ maxWidth: '100%', maxHeight: 360, objectFit: 'contain' }}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                )}
                <p className="field-hint">
                  Triage currently reads ticket text, public follow-ups, and attachment metadata.
                  Use the preview above to inspect images or files before approving work.
                </p>
              </div>
              {task.status === 'awaiting_context' && triage && (
                <div className="form-stack">
                  <label className="field-label">
                    Context request preview · public GLPI follow-up
                    <textarea
                      rows={5}
                      value={questionDraft}
                      onChange={(event) =>
                        setQuestionDraftState({ key: draftKey, value: event.target.value })
                      }
                    />
                  </label>
                  <span className="field-hint">
                    Review the exact text. Posting makes it visible to the ticket requester.
                  </span>
                  <button
                    className="button button-primary button-small"
                    type="button"
                    disabled={!questionDraft.trim() || postQuestion.isPending}
                    onClick={() => postQuestion.mutate()}
                  >
                    {postQuestion.isPending ? (
                      <LoaderCircle className="spin" size={14} />
                    ) : (
                      <ArrowRight size={14} />
                    )}
                    Post context request publicly
                  </button>
                  {postQuestion.error && (
                    <ErrorBanner
                      message={`${errorMessage(postQuestion.error)} If GLPI already shows the message, do not submit it again.`}
                    />
                  )}
                  {notice && (
                    <p className="field-hint" role="status">
                      {notice}
                    </p>
                  )}
                </div>
              )}
              {task.status === 'awaiting_context' && (
                <p className="field-hint">
                  Orbyt refreshes public follow-ups every 30 seconds while this panel is open and
                  reruns triage when a new reply arrives.
                </p>
              )}
              {context.followupsTruncated && (
                <p className="field-hint">
                  Some public follow-ups were omitted by the safety limit.
                </p>
              )}
              {context.documentsTruncated && (
                <p className="field-hint">
                  Some attachment metadata was omitted by the safety limit.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

const activeRunStates: TaskRunState[] = [
  'queued',
  'running',
  'waiting_permission',
  'cancel_requested',
];

function TaskExecutionRuns({ task }: { task: Task }) {
  const {
    data: runs = [],
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ['task-runs', task.id],
    queryFn: () => api.taskRuns(task.id),
    refetchInterval: (query) =>
      query.state.data?.some((run) => activeRunStates.includes(run.state)) ? 1500 : false,
  });
  const taskIndicatesActiveRun = task.status === 'queued' || task.status === 'running';

  if (error) {
    return (
      <div className="task-run-wrap">
        <ErrorBanner message={`Could not load implementation runs: ${errorMessage(error)}`} />
      </div>
    );
  }
  if (isLoading && taskIndicatesActiveRun) {
    return (
      <div className="task-run-wrap" role="status" aria-live="polite">
        <LoaderCircle className="spin" size={14} /> Loading implementation status…
      </div>
    );
  }
  if (runs.length === 0) {
    if (!taskIndicatesActiveRun) return null;
    return (
      <div className="task-run-wrap">
        <div className="error-banner" role="alert">
          <AlertCircle size={15} />
          <span>No run record is available for this active task state.</span>
          <button className="button button-secondary button-small" onClick={() => void refetch()}>
            Refresh status
          </button>
        </div>
      </div>
    );
  }
  return (
    <section className="task-run-wrap" aria-label={`Implementation runs for ${task.title}`}>
      {runs.map((run) => (
        <TaskRunCard key={run.id} run={run} />
      ))}
    </section>
  );
}

function TaskRunCard({ run }: { run: TaskRun }) {
  const queryClient = useQueryClient();
  const [showReconcile, setShowReconcile] = useState(false);
  const [confirmedStopped, setConfirmedStopped] = useState(false);
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['task-runs', run.taskId] });
    void queryClient.invalidateQueries({ queryKey: keys.tasks });
  };
  const permission = useMutation({
    mutationFn: ({
      permissionId,
      decision,
    }: {
      permissionId: string;
      decision: 'allow_once' | 'reject';
    }) => api.respondToRunPermission(run.id, permissionId, decision),
    onSuccess: invalidate,
  });
  const cancel = useMutation({
    mutationFn: () => api.cancelTaskRun(run.id),
    onSuccess: invalidate,
  });
  const reconcile = useMutation({
    mutationFn: () => api.reconcileTaskRun(run.id, true),
    onSuccess: () => {
      setShowReconcile(false);
      setConfirmedStopped(false);
      invalidate();
    },
  });
  const isWorking = permission.isPending || cancel.isPending || reconcile.isPending;
  const permissionRequests = run.pendingPermissions ?? [];
  const canStop = ['queued', 'running', 'waiting_permission'].includes(run.state);
  const progressText = safeRunText(run.progress, 500);
  const outputText = safeRunText(run.output, 1000);

  return (
    <article className={`task-run-card run-${run.state}`}>
      <div className="task-run-heading">
        <div>
          <strong>Implementation run</strong>
          <span className={`task-status run-status-${run.state}`}>
            <i /> {formatStatus(run.state)}
          </span>
        </div>
        {canStop && (
          <button
            className="button button-secondary button-small"
            disabled={isWorking}
            onClick={() => cancel.mutate()}
          >
            {cancel.isPending ? <LoaderCircle className="spin" size={14} /> : <X size={14} />}
            Stop work
          </button>
        )}
      </div>
      <div className="task-run-meta">
        {run.scopeDirectory && <span>Scheduler scope: {safeRunText(run.scopeDirectory, 500)}</span>}
        {run.broadScope && <span className="run-broad-scope">Entire project scope</span>}
        {run.sessionId && <span>OpenCode session: {safeRunText(run.sessionId, 160)}</span>}
      </div>
      {progressText && (
        <p className="task-run-progress" aria-live="polite">
          <strong>Progress:</strong> {progressText}
        </p>
      )}
      {outputText && (
        <p className="task-run-output">
          <strong>Latest output:</strong> <code>{outputText}</code>
        </p>
      )}
      {run.state === 'cancel_requested' && (
        <p className="task-run-note" role="status">
          Stop requested. Waiting for OpenCode to confirm that the run has stopped.
        </p>
      )}
      {run.state === 'waiting_permission' && permissionRequests.length > 0 && (
        <div className="run-permission-list">
          {permissionRequests.slice(0, 10).map((request) => {
            const title = safeRunText(request.title, 160) || 'OpenCode is requesting permission';
            const kind = safeRunText(request.kind, 80);
            const details = safeRunText(request.details, 1000);
            return (
              <div
                className="run-permission"
                key={request.id}
                role="group"
                aria-label="OpenCode tool permission"
              >
                <div>
                  <strong>{title}</strong>
                  {kind && <span className="run-detail-label">{kind}</span>}
                  {details && (
                    <p>
                      <code>{details}</code>
                    </p>
                  )}
                </div>
                <div className="run-permission-actions">
                  <button
                    className="button button-primary button-small"
                    disabled={isWorking || !request.id}
                    onClick={() =>
                      permission.mutate({ permissionId: request.id, decision: 'allow_once' })
                    }
                  >
                    {permission.isPending && permission.variables?.decision === 'allow_once' ? (
                      <LoaderCircle className="spin" size={14} />
                    ) : null}
                    Allow once
                  </button>
                  <button
                    className="button button-secondary button-small"
                    disabled={isWorking || !request.id}
                    onClick={() =>
                      permission.mutate({ permissionId: request.id, decision: 'reject' })
                    }
                  >
                    {permission.isPending && permission.variables?.decision === 'reject' ? (
                      <LoaderCircle className="spin" size={14} />
                    ) : null}
                    Reject
                  </button>
                </div>
              </div>
            );
          })}
          {permissionRequests.length > 10 && (
            <p className="task-run-note" role="status">
              Showing the first 10 of {permissionRequests.length} pending requests. Resolve these to
              load the next requests.
            </p>
          )}
        </div>
      )}
      {run.state === 'waiting_permission' && permissionRequests.length === 0 && (
        <div className="error-banner" role="alert">
          <AlertCircle size={15} />
          <span>OpenCode is waiting for permission, but no permission details were returned.</span>
        </div>
      )}
      {run.state === 'needs_reconciliation' && (
        <div className="run-reconciliation" role="alert">
          <TriangleAlert size={16} />
          <div>
            <strong>External work needs reconciliation</strong>
            <p>
              Orbyt could not confirm a graceful OpenCode shutdown. Check whether any OpenCode or
              tool process is still working before resolving this run. Orbyt will not retry it
              automatically.
            </p>
            <button
              className="button button-secondary button-small"
              disabled={isWorking}
              onClick={() => setShowReconcile(true)}
            >
              Resolve stopped work…
            </button>
          </div>
        </div>
      )}
      {run.error && <ErrorBanner message={safeRunText(run.error, 2000)} />}
      {(permission.error || cancel.error || reconcile.error) && (
        <ErrorBanner message={errorMessage(permission.error ?? cancel.error ?? reconcile.error)} />
      )}
      {showReconcile && (
        <Modal
          title="Confirm external work has stopped"
          subtitle="Resolve this run only after checking that its OpenCode process is no longer working."
          onClose={() => {
            if (!reconcile.isPending) {
              setShowReconcile(false);
              setConfirmedStopped(false);
            }
          }}
        >
          <div className="form-stack">
            <div className="scope-security-note" role="note">
              <TriangleAlert size={16} />
              <span>
                This records your confirmation and reconciles the run state. It does not stop an
                external process or start another run.
              </span>
            </div>
            {reconcile.error && <ErrorBanner message={errorMessage(reconcile.error)} />}
            <label className="run-confirm-check">
              <input
                type="checkbox"
                checked={confirmedStopped}
                onChange={(event) => setConfirmedStopped(event.target.checked)}
              />
              I have checked that the external work has stopped.
            </label>
            <div className="modal-actions">
              <button
                className="button button-secondary"
                type="button"
                disabled={reconcile.isPending}
                onClick={() => {
                  setShowReconcile(false);
                  setConfirmedStopped(false);
                }}
              >
                Keep unresolved
              </button>
              <button
                className="button button-primary"
                type="button"
                disabled={!confirmedStopped || reconcile.isPending}
                onClick={() => reconcile.mutate()}
              >
                {reconcile.isPending ? <LoaderCircle className="spin" size={15} /> : null}I stopped
                the external work
              </button>
            </div>
          </div>
        </Modal>
      )}
    </article>
  );
}

function safeRunText(value: unknown, maxLength: number): string {
  const seen = new WeakSet<object>();
  const serialize = (item: unknown, budget: number, depth: number): string => {
    if (budget <= 0) return '';
    if (typeof item === 'string') return item.slice(0, budget);
    if (typeof item === 'number' || typeof item === 'boolean') return String(item).slice(0, budget);
    if (!item || typeof item !== 'object') return '';
    if (seen.has(item)) return '[circular]'.slice(0, budget);
    if (depth >= 2) return '[…]'.slice(0, budget);

    seen.add(item);
    const parts: string[] = [];
    let used = 0;
    const entries: Array<[string, unknown]> = [];
    let hasMore = false;
    if (Array.isArray(item)) {
      item.slice(0, 8).forEach((entry, index) => entries.push([String(index), entry]));
      hasMore = item.length > 8;
    } else {
      for (const key in item) {
        if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
        if (entries.length === 8) {
          hasMore = true;
          break;
        }
        entries.push([key, (item as Record<string, unknown>)[key]]);
      }
    }
    for (const [key, entry] of entries) {
      if (used >= budget - 4) break;
      const pairBudget = Math.min(180, budget - used - 4);
      const pair = `${key.slice(0, 50)}: ${serialize(entry, pairBudget - key.length - 2, depth + 1)}`;
      parts.push(pair);
      used += pair.length + 2;
    }
    if (hasMore && used < budget - 5) parts.push('…');
    return `{ ${parts.join(', ')} }`.slice(0, budget);
  };
  const text = serialize(value, maxLength + 1, 0);
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function TriageReport({ result, taskStatus }: { result: TriageResult; taskStatus: TaskStatus }) {
  const sections: Array<[string, string[]]> = [
    ['Requirements', result.requirements],
    ['Missing information', result.missingInformation],
    ['Relevant files', result.relevantFiles],
    ['Implementation plan', result.implementationPlan],
    ['Risks', result.risks],
    ['Dependencies', result.dependencies],
  ];
  const actionLabel =
    result.recommendedAction === 'await_approval'
      ? ['queued', 'running', 'awaiting_review'].includes(taskStatus)
        ? 'Implementation started automatically'
        : 'Await manual approval'
      : result.recommendedAction === 'request_context'
        ? 'Request more context'
        : 'Do not proceed';
  return (
    <section
      className="panel"
      aria-label="Triage report"
      style={{ margin: '0 13px 12px', padding: 14 }}
    >
      <div className="panel-heading">
        <div>
          <h2>Triage report</h2>
          <p>
            {formatStatus(result.contextSufficiency)} context · {result.complexity} complexity ·{' '}
            {actionLabel}
          </p>
          <p>
            Suggestions use task text and linked GLPI text, public follow-ups, and attachment
            metadata; Orbyt did not inspect project files or send attachment bytes.
          </p>
        </div>
      </div>
      {result.proposedExecutionScope && (
        <p>
          <strong>Proposed scope:</strong> {result.proposedExecutionScope}
        </p>
      )}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 12,
        }}
      >
        {sections.map(([title, items]) =>
          items.length ? (
            <div key={title}>
              <strong>{title}</strong>
              <ul>
                {items.map((item, index) => (
                  <li key={`${title}-${index}`}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null,
        )}
      </div>
    </section>
  );
}

function TaskForm({
  projects,
  onClose,
  task,
}: {
  projects: Project[];
  onClose: () => void;
  task?: Task;
}) {
  const queryClient = useQueryClient();
  const [projectId, setProjectId] = useState(task?.projectId ?? projects[0]?.id ?? '');
  const [scopeId, setScopeId] = useState(task?.scopeId ?? '');
  const [message, setMessage] = useState('');
  const {
    data: sourceConnections = [],
    isLoading: sourceConnectionsLoading,
    error: sourceConnectionsError,
  } = useQuery({
    queryKey: ['source-connections', projectId],
    queryFn: () => api.sourceConnections(projectId),
    enabled: Boolean(projectId),
  });
  const configuredProviders = [
    ...new Set(sourceConnections.map((connection) => connection.provider)),
  ];
  const { data: scopeData } = useQuery({
    queryKey: ['scopes', projectId],
    queryFn: () => api.scopes(projectId),
    enabled: Boolean(projectId),
  });
  const scopes = Array.isArray(scopeData) ? scopeData : [];
  const selectedScope = scopes.find((scope) => scope.id === scopeId);
  const save = useMutation({
    mutationFn: (input: {
      projectId: string;
      scopeId: string | null;
      title: string;
      description: string;
      priority: Task['priority'];
      externalUrl: string | null;
    }) => (task ? api.updateTask(task.id, input) : api.createTask(input)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.tasks });
      if (task) {
        queryClient.setQueryData(['task-triage', task.id], null);
        void queryClient.invalidateQueries({ queryKey: ['task-triage', task.id] });
      }
      onClose();
    },
    onError: (error) => setMessage(errorMessage(error)),
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    save.mutate({
      projectId,
      scopeId: scopeId || null,
      title: String(data.get('title')).trim(),
      description: String(data.get('description')).trim(),
      priority: String(data.get('priority')) as Task['priority'],
      externalUrl: String(data.get('externalUrl') ?? '').trim() || null,
    });
  }
  return (
    <Modal
      title={task ? 'Edit task' : 'Create a task'}
      subtitle="Manual tasks are saved locally and start in the pending state. Run triage from a task's actions."
      onClose={onClose}
    >
      <form className="form-stack" onSubmit={submit}>
        <label className="field-label">
          Title
          <input
            name="title"
            required
            maxLength={200}
            defaultValue={task?.title}
            placeholder="What needs to be done?"
          />
        </label>
        <label className="field-label">
          Description
          <textarea
            name="description"
            rows={4}
            maxLength={10000}
            defaultValue={task?.description}
            placeholder="Add requirements, context, or acceptance criteria..."
          />
        </label>
        {sourceConnectionsError && (
          <ErrorBanner
            message={`Could not check configured task sources: ${errorMessage(sourceConnectionsError)}`}
          />
        )}
        {sourceConnectionsLoading && (
          <span className="field-hint">Checking connected ticket sources…</span>
        )}
        {configuredProviders.includes('glpi') && (
          <label className="field-label">
            GLPI ticket URL <span className="optional">Optional</span>
            <input
              name="externalUrl"
              type="url"
              defaultValue={task?.externalUrl ?? ''}
              placeholder="https://…"
              aria-describedby="external-url-hint"
            />
            <span className="field-hint" id="external-url-hint">
              Use a supported ticket link from the connected GLPI instance. Orbyt validates its
              origin and ticket number before using it for context.
            </span>
          </label>
        )}
        <label className="field-label">
          Project
          <select
            required
            value={projectId}
            onChange={(event) => {
              setProjectId(event.target.value);
              setScopeId('');
            }}
          >
            {projects.length ? (
              projects.map((project) => (
                <option value={project.id} key={project.id}>
                  {project.name}
                </option>
              ))
            ) : (
              <option value="">Add a project first</option>
            )}
          </select>
        </label>
        <label className="field-label">
          Execution scope <span className="optional">Optional</span>
          <select
            name="scopeId"
            value={scopeId}
            onChange={(event) => setScopeId(event.target.value)}
          >
            <option value="">No scope selected</option>
            {scopes.map((scope) => (
              <option key={scope.id} value={scope.id}>
                {scope.name} · {scope.relativeDirectory}
                {scope.writeAccess ? '' : ' · read-only'}
              </option>
            ))}
          </select>
          {selectedScope && !selectedScope.writeAccess && (
            <span className="field-hint">
              This scope is read-only. Select a write-enabled scope before starting implementation.
            </span>
          )}
        </label>
        <label className="field-label">
          Priority
          <select name="priority" defaultValue={task?.priority ?? 'medium'}>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </select>
        </label>
        {message && (
          <div className="form-error">
            <AlertCircle size={15} />
            {message}
          </div>
        )}
        <div className="modal-actions">
          <button className="button button-secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button button-primary" disabled={save.isPending || !projects.length}>
            {save.isPending ? (
              <LoaderCircle className="spin" size={15} />
            ) : task ? (
              <Check size={15} />
            ) : (
              <Plus size={15} />
            )}
            {task ? 'Save changes' : 'Create task'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Sessions() {
  const { data: projects = [], isLoading: projectsLoading, error: projectsError } = useProjects();
  const {
    data: sessions = [],
    isLoading: sessionsLoading,
    error: sessionsError,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: [...keys.sessions, projects.map((project) => project.directory)],
    queryFn: api.openCodeSessions,
    enabled: !projectsLoading && projects.length > 0,
    staleTime: 30_000,
  });

  return (
    <>
      <PageHeading
        eyebrow="AGENT ACTIVITY"
        title="Sessions"
        description="Browse existing OpenCode sessions in your registered projects."
        action={
          <button
            className="button button-secondary"
            onClick={() => void refetch()}
            disabled={projects.length === 0 || isFetching}
          >
            {isFetching ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
            Refresh
          </button>
        }
      />
      {(projectsError || sessionsError) && (
        <ErrorBanner message={errorMessage(projectsError ?? sessionsError)} />
      )}
      <div className="session-notice">
        <span>
          <ShieldCheck size={18} />
        </span>
        <div>
          <strong>Read-only session listing</strong>
          <p>
            Orbyt checks the latest 15 sessions across your registered projects and displays at most
            15. It does not start, prompt, or schedule sessions from this screen.
          </p>
          <Link className="text-link" to="/settings">
            Check OpenCode connection <ArrowRight size={14} />
          </Link>
        </div>
      </div>
      {projectsLoading || sessionsLoading ? (
        <LoadingState label="Loading OpenCode sessions" />
      ) : projectsError ? null : projects.length === 0 ? (
        <EmptyState
          className="large-empty"
          icon={<FolderKanban size={22} />}
          title="Register a project first"
          description="Orbyt only looks for sessions in project folders that you have added."
          action={
            <Link to="/projects" className="button button-primary">
              View projects <ArrowRight size={15} />
            </Link>
          }
        />
      ) : sessions.length === 0 && !sessionsError ? (
        <EmptyState
          className="large-empty"
          icon={<SquareTerminal size={22} />}
          title="No OpenCode sessions found"
          description="Verify your OpenCode connection or refresh after opening a session in one of these projects."
          action={
            <Link to="/settings" className="button button-secondary">
              Open settings <ArrowRight size={15} />
            </Link>
          }
        />
      ) : sessions.length > 0 ? (
        <section className="panel session-list">
          {sessions.slice(0, 15).map((session) => (
            <OpenCodeSessionRow session={session} key={session.id} />
          ))}
        </section>
      ) : null}
    </>
  );
}

function OpenCodeSessionRow({ session }: { session: OpenCodeSession }) {
  const updatedDate = new Date(session.updatedAt);
  const hasValidDate = Number.isFinite(session.updatedAt) && !Number.isNaN(updatedDate.getTime());
  const updated = hasValidDate ? updatedDate.toLocaleString() : 'Unknown';
  return (
    <article className="session-row">
      <div className="session-row-icon">
        <SquareTerminal size={17} />
      </div>
      <div className="session-row-main">
        <strong>{session.title.trim() || 'Untitled OpenCode session'}</strong>
        <span>{session.projectName}</span>
      </div>
      <div className="session-row-meta">
        {session.parentId && <span className="session-child-badge">Child session</span>}
        <time dateTime={hasValidDate ? updatedDate.toISOString() : undefined}>{updated}</time>
        <small>{session.id}</small>
      </div>
    </article>
  );
}

function Settings() {
  const queryClient = useQueryClient();
  const { data: settings = {}, isLoading, error } = useAppSettings();
  const [executable, setExecutable] = useState<string | null>(null);
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [verification, setVerification] = useState<{
    connected: boolean;
    message: string;
    version?: string | null;
  } | null>(null);
  const save = useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) => api.saveSetting(key, value),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.settings });
      setNotice('Settings saved locally.');
      window.setTimeout(() => setNotice(''), 3000);
    },
    onError: (error) => setNotice(errorMessage(error)),
  });
  const verify = useMutation({
    mutationFn: async (input: { executable: string; endpoint: string }) => {
      await Promise.all([
        api.saveSetting('opencode_executable', input.executable),
        api.saveSetting('opencode_endpoint', input.endpoint),
      ]);
      return api.verifyOpenCode();
    },
    onSuccess: (result) => {
      setVerification(result);
      void api.saveSetting('opencode_last_connected', String(result.connected)).then(
        () => queryClient.invalidateQueries({ queryKey: keys.settings }),
        () => undefined,
      );
    },
    onError: (error) => {
      setVerification({ connected: false, message: errorMessage(error) });
      void api.saveSetting('opencode_last_connected', 'false').then(
        () => queryClient.invalidateQueries({ queryKey: keys.settings }),
        () => undefined,
      );
    },
  });
  const saveAll = () => {
    setNotice('');
    void Promise.all([
      api.saveSetting('opencode_executable', executable ?? settings['opencode_executable'] ?? ''),
      api.saveSetting('opencode_endpoint', endpoint ?? settings['opencode_endpoint'] ?? ''),
      api.saveSetting(
        'max_concurrent_sessions',
        settings['max_concurrent_sessions'] ?? String(DEFAULT_MAX_CONCURRENT_SESSIONS),
      ),
      api.saveSetting('approval_policy', 'manual'),
    ])
      .then(() => queryClient.invalidateQueries({ queryKey: keys.settings }))
      .then(() => setNotice('Settings saved locally.'))
      .catch((error) => setNotice(errorMessage(error)));
  };
  return (
    <>
      <PageHeading
        eyebrow="PREFERENCES"
        title="Settings"
        description="Configure how Orbyt connects to your local development tools."
      />
      {error && <ErrorBanner message={errorMessage(error)} />}
      {isLoading ? (
        <LoadingState label="Loading settings" />
      ) : (
        <div className="settings-layout">
          <div className="settings-main">
            <section className="panel settings-section">
              <div className="settings-section-heading">
                <div className="settings-heading-icon purple">
                  <Bot size={18} />
                </div>
                <div>
                  <h2>OpenCode connection</h2>
                  <p>Use your existing installation, configuration, and authentication.</p>
                </div>
              </div>
              <label className="field-label">
                Executable path or command
                <input
                  value={executable ?? settings['opencode_executable'] ?? 'opencode'}
                  onChange={(event) => setExecutable(event.target.value)}
                  placeholder="opencode"
                />
                <span className="field-hint">
                  The connection check invokes only the fixed `api get /api/info` command.
                </span>
              </label>
              <label className="field-label">
                Local service endpoint <span className="optional">Optional</span>
                <input
                  value={endpoint ?? settings['opencode_endpoint'] ?? ''}
                  onChange={(event) => setEndpoint(event.target.value)}
                  placeholder="Auto-detect through OpenCode CLI"
                />
                <span className="field-hint">
                  Connection checks, session listing, and triage use this service when set. Triage
                  sends the task title, description, and linked GLPI text/history to its configured
                  model provider. Leave blank to use OpenCode's service discovery and
                  authentication.
                </span>
              </label>
              {verification && (
                <div
                  className={`connection-result ${verification.connected ? 'connected' : 'disconnected'}`}
                >
                  <span>
                    {verification.connected ? <Check size={15} /> : <AlertCircle size={15} />}
                  </span>
                  <div>
                    <strong>
                      {verification.connected
                        ? `Connected${verification.version ? ` · v${verification.version}` : ''}`
                        : 'Could not connect'}
                    </strong>
                    <p>{verification.message}</p>
                  </div>
                </div>
              )}
              <div className="settings-actions">
                <button
                  className="button button-secondary"
                  onClick={() =>
                    verify.mutate({
                      executable: executable ?? settings['opencode_executable'] ?? '',
                      endpoint: endpoint ?? settings['opencode_endpoint'] ?? '',
                    })
                  }
                  disabled={verify.isPending}
                >
                  {verify.isPending ? (
                    <LoaderCircle className="spin" size={15} />
                  ) : (
                    <Activity size={15} />
                  )}
                  Save and verify connection
                </button>
                <button
                  className="button button-primary"
                  onClick={saveAll}
                  disabled={save.isPending}
                >
                  <Check size={15} />
                  Save settings
                </button>
              </div>
            </section>
            <SourceIntegrations />
            <section className="panel settings-section">
              <div className="settings-section-heading">
                <div className="settings-heading-icon blue">
                  <Gauge size={18} />
                </div>
                <div>
                  <h2>Execution defaults</h2>
                  <p>Initial safety policy for all registered projects.</p>
                </div>
              </div>
              <label className="field-label">
                Default maximum concurrent sessions
                <select
                  value={
                    settings['max_concurrent_sessions'] ?? String(DEFAULT_MAX_CONCURRENT_SESSIONS)
                  }
                  onChange={(event) =>
                    save.mutate({ key: 'max_concurrent_sessions', value: event.target.value })
                  }
                >
                  {[1, 2, 3, 4, 5, 6, 8].map((n) => (
                    <option value={n} key={n}>
                      {n} sessions
                    </option>
                  ))}
                </select>
                <span className="field-hint">
                  This is the starting value for new projects. Each project can use a lower limit.
                </span>
              </label>
              <div className="policy-display">
                <div className="policy-icon">
                  <ShieldCheck size={16} />
                </div>
                <div>
                  <strong>Context-gated execution</strong>
                  <span>All implementation runs require your explicit approval after triage.</span>
                </div>
                <span className="required-badge">Scope-bound</span>
              </div>
            </section>
            <section className="panel settings-section">
              <div className="settings-section-heading">
                <div className="settings-heading-icon amber">
                  <Command size={18} />
                </div>
                <div>
                  <h2>Appearance</h2>
                  <p>Customize your Orbyt workspace.</p>
                </div>
              </div>
              <div className="appearance-row">
                <div>
                  <strong>Color theme</strong>
                  <span>Dark mode is the default. More options coming later.</span>
                </div>
                <div className="theme-choice">
                  <span className="theme-swatch" />
                  Dark <Check size={14} />
                </div>
              </div>
            </section>
          </div>
          <aside className="settings-aside">
            <div className="settings-note">
              <ShieldCheck size={18} />
              <strong>Your credentials stay yours</strong>
              <p>
                Orbyt uses OpenCode's existing login and provider configuration. No model
                credentials are copied into this app.
              </p>
            </div>
            <div className="settings-note subtle-note">
              <CircleHelp size={17} />
              <strong>Local-first storage</strong>
              <p>
                Projects, tasks, and preferences are saved in an SQLite database on this device.
              </p>
            </div>
          </aside>
        </div>
      )}
      {notice && (
        <div className="toast-message">
          <Check size={15} />
          {notice}
          <button aria-label="Dismiss" onClick={() => setNotice('')}>
            <X size={14} />
          </button>
        </div>
      )}
    </>
  );
}

function SourceIntegrations({ lockedProjectId }: { lockedProjectId?: string } = {}) {
  const queryClient = useQueryClient();
  const { data: settings = {}, isLoading: settingsLoading } = useAppSettings();
  const { data: projects = [] } = useProjects();
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [glpiEndpoint, setGlpiEndpoint] = useState('');
  const [glpiUserToken, setGlpiUserToken] = useState('');
  const [glpiAppToken, setGlpiAppToken] = useState('');
  const [message, setMessage] = useState('');
  const projectId = lockedProjectId || selectedProjectId || projects[0]?.id || '';
  const {
    data: connections = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ['source-connections'],
    queryFn: () => api.sourceConnections(),
  });
  const glpiConnections = connections.filter((connection) => connection.provider === 'glpi');
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['source-connections'] });
    void queryClient.invalidateQueries({ queryKey: keys.tasks });
  };
  const connectGlpi = useMutation({
    mutationFn: () =>
      api.connectGlpi({
        projectId,
        apiEndpoint: glpiEndpoint,
        userToken: glpiUserToken,
        appToken: glpiAppToken,
      }),
    onSuccess: (connection) => {
      setGlpiUserToken('');
      setGlpiAppToken('');
      setMessage(`Connected to GLPI at ${connection.displayName}.`);
      refresh();
    },
    onError: () => setMessage(''),
  });
  const disconnect = useMutation({
    mutationFn: api.deleteSourceConnection,
    onSuccess: () => {
      setMessage('Source disconnected. Imported tasks remain in Orbyt.');
      refresh();
    },
    onError: (cause) => setMessage(errorMessage(cause)),
  });

  return (
    <section className="panel settings-section">
      <div className="settings-section-heading">
        <div className="settings-heading-icon blue">
          <GitBranch size={18} />
        </div>
        <div>
          <h2>GLPI ticket source</h2>
          <p>Import GLPI 10 tickets and load linked ticket context.</p>
        </div>
      </div>
      {projects.length === 0 ? (
        <EmptyState
          icon={<FolderKanban size={18} />}
          title="Add a project first"
          description="Imported GLPI tickets need a local Orbyt project to belong to."
        />
      ) : (
        <>
          {lockedProjectId ? (
            <p className="field-hint">
              Sources will be connected to{' '}
              {projects.find((project) => project.id === projectId)?.name ?? 'the selected project'}
              .
            </p>
          ) : (
            <label className="field-label">
              Import into project
              <select
                value={projectId}
                onChange={(event) => setSelectedProjectId(event.target.value)}
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="settings-subsection">
            <h3>GLPI 10 instance</h3>
            <label className="field-label">
              REST API base URL
              <input
                value={glpiEndpoint}
                onChange={(event) => setGlpiEndpoint(event.target.value)}
                placeholder="https://glpi.example.com/apirest.php"
                autoComplete="url"
              />
            </label>
            <label className="field-label">
              User API token
              <input
                type="password"
                autoComplete="off"
                value={glpiUserToken}
                onChange={(event) => setGlpiUserToken(event.target.value)}
              />
            </label>
            <label className="field-label">
              App token <span className="optional">Optional</span>
              <input
                type="password"
                autoComplete="off"
                value={glpiAppToken}
                onChange={(event) => setGlpiAppToken(event.target.value)}
              />
              <span className="field-hint">
                Enable the GLPI REST API and use a user token. Credentials are stored in the
                operating system credential store; only the endpoint and connection metadata are
                saved in Orbyt.
              </span>
            </label>
            <label className="check-field">
              <input
                type="checkbox"
                checked={settings['glpi_auto_triage'] === 'true'}
                disabled={settingsLoading}
                onChange={(event) => {
                  setMessage('');
                  void api
                    .saveSetting('glpi_auto_triage', String(event.target.checked))
                    .then(() => queryClient.invalidateQueries({ queryKey: keys.settings }))
                    .then(() =>
                      setMessage(
                        event.target.checked
                          ? 'GLPI auto-triage enabled.'
                          : 'GLPI auto-triage disabled.',
                      ),
                    )
                    .catch((cause: unknown) => setMessage(errorMessage(cause)));
                }}
              />
              <span>
                <strong>Automatically triage newly imported GLPI tasks</strong>
                <small>
                  Off by default. When enabled, ticket text, public follow-ups, and attachment
                  metadata are sent to the model configured in OpenCode for triage. Attachment bytes
                  are never sent. This does not automatically start implementation or an ACP
                  session.
                </small>
              </span>
            </label>
            <button
              className="button button-secondary"
              onClick={() => connectGlpi.mutate()}
              disabled={
                !projectId || !glpiEndpoint.trim() || !glpiUserToken.trim() || connectGlpi.isPending
              }
            >
              {connectGlpi.isPending ? (
                <LoaderCircle className="spin" size={15} />
              ) : (
                <Check size={15} />
              )}
              Connect GLPI
            </button>
            {connectGlpi.error && <ErrorBanner message={errorMessage(connectGlpi.error)} />}
          </div>
          {message && (
            <p className="field-hint" role="status">
              {message}
            </p>
          )}
          {error && <ErrorBanner message={errorMessage(error)} />}
          <div className="source-connections">
            <h3>Connected sources</h3>
            {isLoading ? (
              <LoadingState label="Loading source connections" />
            ) : glpiConnections.length === 0 ? (
              <p className="empty-copy">No external sources connected yet.</p>
            ) : (
              glpiConnections.map((connection) => (
                <div className="source-connection-row" key={connection.id}>
                  <div>
                    <strong>{connection.displayName}</strong>
                    <span>GLPI 10 ticket intake and linked-ticket context</span>
                  </div>
                  <div className="source-connection-actions">
                    <button
                      className="icon-button subtle"
                      onClick={() => disconnect.mutate(connection.id)}
                      disabled={disconnect.isPending}
                      aria-label={`Disconnect ${connection.displayName}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </section>
  );
}

function GlpiSyncScheduler() {
  const queryClient = useQueryClient();
  const { data: sourceData } = useQuery({
    queryKey: ['source-connections'],
    queryFn: () => api.sourceConnections(),
  });
  const { data: settings = {} } = useAppSettings();
  const sources = (Array.isArray(sourceData) ? sourceData : []).filter(
    (source) => source.provider === 'glpi',
  );
  const running = useRef(false);
  const sourceIds = sources.map((source) => source.id).join('\u0000');
  const autoTriage = settings['glpi_auto_triage'] === 'true';
  const autoTriageRef = useRef(autoTriage);

  useEffect(() => {
    autoTriageRef.current = autoTriage;
  }, [autoTriage]);

  useEffect(() => {
    if (!sourceIds) return;
    const connectionIds = sourceIds.split('\u0000');
    let active = true;
    const syncAll = async () => {
      if (running.current) return;
      running.current = true;
      let changed = false;
      try {
        for (const connectionId of connectionIds) {
          if (!active) break;
          try {
            const result = await api.syncSourceConnection(connectionId);
            if (result.truncated) {
              window.dispatchEvent(
                new CustomEvent('orbyt:glpi-sync-warning', {
                  detail: `GLPI intake reached its ${result.limit}-ticket safety limit; more unresolved tickets may remain to import.`,
                }),
              );
            }
            if (autoTriageRef.current) {
              const { triageTaskIds = [] } = result as typeof result & { triageTaskIds?: string[] };
              for (const taskId of triageTaskIds) {
                if (!active) break;
                try {
                  await api.triageTask(taskId);
                } catch {
                  // A failed triage remains visible on the task and may be retried manually.
                }
              }
            }
            changed = true;
          } catch {
            // Retry the GLPI connection on the next scheduled cycle.
          }
        }
      } finally {
        running.current = false;
        if (active && changed) {
          void queryClient.invalidateQueries({ queryKey: keys.tasks });
          void queryClient.invalidateQueries({ queryKey: ['source-connections'] });
        }
      }
    };
    void syncAll();
    const timer = window.setInterval(() => void syncAll(), 5 * 60 * 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [sourceIds, queryClient]);

  return null;
}

function TaskTable({ tasks, projects }: { tasks: Task[]; projects: Project[] }) {
  return (
    <div className="compact-task-list">
      {tasks.map((task) => (
        <div className="compact-task-row" key={task.id}>
          <span className={`compact-priority priority-${task.priority}`} />
          <div className="compact-task-copy">
            <strong>{task.title}</strong>
            <span>{projects.find((p) => p.id === task.projectId)?.name ?? 'Unknown project'}</span>
          </div>
          <span className={`task-status status-${task.status}`}>
            <i />
            {formatStatus(task.status)}
          </span>
        </div>
      ))}
    </div>
  );
}

function Modal({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div className="modal-heading">
          <div>
            <h2 id="modal-title">{title}</h2>
            <p>{subtitle}</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close dialog">
            <X size={18} />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

function EmptyState({
  icon,
  title,
  description,
  action,
  className = '',
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`empty-state ${className}`}>
      <span className="empty-icon">{icon}</span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

function LoadingState({ label }: { label: string }) {
  return (
    <div className="loading-state">
      <LoaderCircle className="spin" size={18} />
      {label}…
    </div>
  );
}
function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="error-banner">
      <AlertCircle size={16} />
      <span>{message}</span>
    </div>
  );
}
function formatStatus(status: string) {
  return status.replaceAll('_', ' ');
}

export default App;
