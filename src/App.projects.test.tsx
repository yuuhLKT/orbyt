import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from './types/domain';
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

function renderProjects(initialEntry = '/projects') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function fillNewProject() {
  fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'New project' } });
  fireEvent.change(screen.getByPlaceholderText('Select an existing folder'), {
    target: { value: '/work/new-project' },
  });
}

describe('project creation defaults', () => {
  beforeEach(() => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_projects') return Promise.resolve([]);
      if (command === 'list_tasks') return Promise.resolve([]);
      if (command === 'get_settings') return Promise.resolve({ max_concurrent_sessions: '5' });
      if (command === 'create_project') return Promise.resolve({ id: 'new-project' });
      return Promise.resolve({});
    });
  });

  it('uses the saved global concurrency default for a new project', async () => {
    renderProjects();

    fireEvent.click(await screen.findByRole('button', { name: 'Add your first project' }));
    expect(await screen.findByRole('dialog', { name: 'Add a project' })).toBeInTheDocument();
    fillNewProject();

    fireEvent.click(screen.getByRole('button', { name: 'Register project' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('create_project', {
        input: {
          name: 'New project',
          description: '',
          directory: '/work/new-project',
          maxConcurrentSessions: 5,
        },
      });
    });
  });

  it('lets the user override the default for one project', async () => {
    renderProjects();

    fireEvent.click(await screen.findByRole('button', { name: 'Add your first project' }));
    await screen.findByRole('dialog', { name: 'Add a project' });
    fillNewProject();
    fireEvent.change(screen.getByRole('combobox', { name: /Maximum concurrent sessions/ }), {
      target: { value: '3' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Register project' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'create_project',
        expect.objectContaining({
          input: expect.objectContaining({ maxConcurrentSessions: 3 }),
        }),
      );
    });
  });

  it('uses the documented default when no concurrency preference was saved', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_projects') return Promise.resolve([]);
      if (command === 'list_tasks') return Promise.resolve([]);
      if (command === 'get_settings') return Promise.resolve({});
      return Promise.resolve({});
    });
    renderProjects();

    fireEvent.click(await screen.findByRole('button', { name: 'Add your first project' }));

    expect(
      (await screen.findByRole('combobox', {
        name: /Maximum concurrent sessions/,
      })) as HTMLSelectElement,
    ).toHaveValue('3');
  });

  it('shows a loading state while project details are being fetched', () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_projects') return new Promise(() => undefined);
      if (command === 'list_tasks') return Promise.resolve([]);
      if (command === 'get_settings') return Promise.resolve({});
      return Promise.resolve({});
    });

    renderProjects('/projects/project-1');

    expect(screen.getByText('Loading project')).toBeInTheDocument();
    expect(screen.getByText(/Loading project details/)).toBeInTheDocument();
    expect(screen.queryByText('Project not found')).not.toBeInTheDocument();
  });

  it('shows the project query error instead of reporting a missing project', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_projects') return Promise.reject(new Error('database offline'));
      if (command === 'list_tasks') return Promise.resolve([]);
      if (command === 'get_settings') return Promise.resolve({});
      return Promise.resolve({});
    });

    renderProjects('/projects/project-1');

    expect(await screen.findByText('Could not load project')).toBeInTheDocument();
    expect(await screen.findByText('database offline')).toBeInTheDocument();
    expect(screen.queryByText('Project not found')).not.toBeInTheDocument();
  });

  it('does not show a zero scope count when the scope query fails', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_projects') return Promise.resolve([project]);
      if (command === 'list_tasks') return Promise.resolve([]);
      if (command === 'get_settings') return Promise.resolve({});
      if (command === 'list_scopes') return Promise.reject(new Error('scope lookup failed'));
      return Promise.resolve({});
    });

    renderProjects();

    expect(await screen.findByText('Scopes unavailable')).toBeInTheDocument();
    expect(screen.queryByText('0 scopes')).not.toBeInTheDocument();
  });
});
