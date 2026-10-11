import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

describe('OpenCode sessions screen', () => {
  beforeEach(() => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_projects') {
        return Promise.resolve([
          {
            id: 'project-1',
            name: 'Orbyt',
            description: '',
            directory: '/work/orbyt',
            maxConcurrentSessions: 2,
            approvalPolicy: 'manual',
            createdAt: '2026-10-10T00:00:00Z',
            updatedAt: '2026-10-10T00:00:00Z',
          },
        ]);
      }
      if (command === 'list_tasks') return Promise.resolve([]);
      if (command === 'list_opencode_sessions') {
        return Promise.resolve([
          {
            id: 'ses_123',
            projectId: 'project-1',
            projectName: 'Orbyt',
            projectDirectory: '/work/orbyt',
            title: 'Fix task flow',
            createdAt: 1_791_600_000_000,
            updatedAt: 1_791_600_100_000,
            parentId: null,
          },
        ]);
      }
      return Promise.resolve({});
    });
  });

  it('shows real session metadata and states that the view is read-only', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/sessions']}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const title = await screen.findByText('Fix task flow');
    expect(title).toBeInTheDocument();
    expect(within(title.closest('article')!).getByText('Orbyt')).toBeInTheDocument();
    expect(screen.getByText('Read-only session listing')).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith('list_opencode_sessions');
  });
});
