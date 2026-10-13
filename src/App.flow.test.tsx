import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

const tasks = [
  { id: 'a', title: 'Ticket waiting', status: 'awaiting_context', updatedAt: 'now' },
  { id: 'b', title: 'Ready to approve', status: 'awaiting_approval', updatedAt: 'now' },
  { id: 'c', title: 'Review implementation', status: 'awaiting_review', updatedAt: 'now' },
];

function renderFlow() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/flow']}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('GLPI workflow flow screen', () => {
  beforeEach(() => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_tasks') return Promise.resolve(tasks);
      if (command === 'list_projects')
        return Promise.resolve([{ id: 'project-1', name: 'GLPI', directory: '/workspace/glpi' }]);
      if (command === 'list_project_workflow_resources')
        return Promise.resolve({
          workingDirectory: '/workspace/glpi',
          discoveryNote:
            'These files were found and checked by Orbyt; this does not prove an ACP session loaded each resource.',
          counts: { skills: 1, commands: 1, agents: 0, instructions: 1, configs: 0 },
          skills: [
            {
              name: 'glpi-plugin-development',
              relativePath: '.opencode/skills/glpi-plugin-development/SKILL.md',
              description: 'Develop a GLPI plugin.',
              readable: true,
              parseable: true,
            },
          ],
          commands: [],
          agents: [],
          instructions: [],
          configs: [],
        });
      if (command === 'list_source_connections') return Promise.resolve([]);
      if (command === 'get_settings') return Promise.resolve({});
      return Promise.resolve([]);
    });
  });

  it('explains GLPI intake, branches, approval, executor and current stage counts', async () => {
    renderFlow();
    expect(await screen.findByRole('heading', { name: 'Flow' })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: /Stateless triage/ }));
    expect(screen.getByText(/does not inspect repository files/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Context needed/ }));
    expect(screen.getByText(/public follow-up question/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Approval gate/ }));
    expect(screen.getByText(/explicit user approval/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /OpenCode ACP/ }));
    expect(
      screen.getByText(/OpenCode’s effective permissions remain authoritative/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Context needed, 1 current task' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Awaiting review/ }));
    expect(await screen.findByText(/1 current tasks in this stage/)).toBeInTheDocument();
  });

  it('lists observed project resources without inventing named agents and warns about scope', async () => {
    renderFlow();
    expect((await screen.findAllByText(/glpi-plugin-development/)).length).toBeGreaterThan(0);
    expect(screen.getByText('Skills identified · 1')).toBeInTheDocument();
    expect(screen.getByText('Commands identified · 0')).toBeInTheDocument();
    expect(screen.getByText(/Recent project sessions observed the/i)).toBeInTheDocument();
    expect(
      screen.getByText(/not proof that a resource loaded in every ACP run/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent(/plugins\/ write scope is broad/i);
  });
});
