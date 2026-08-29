import * as vscode from 'vscode';

export type SendFormat = 'hex' | 'ascii';

export interface SendTemplate {
  id: string;
  name: string;
  format: SendFormat;
  data: string;
}

const STORAGE_KEY = 'serialPort.templates';

/** CRUD over global state for reusable send payloads, shared across all workspaces. */
export class TemplateStore {
  constructor(private readonly memento: vscode.Memento) {}

  list(): SendTemplate[] {
    return this.memento.get<SendTemplate[]>(STORAGE_KEY, []);
  }

  get(id: string): SendTemplate | undefined {
    return this.list().find((template) => template.id === id);
  }

  async add(template: Omit<SendTemplate, 'id'>): Promise<SendTemplate> {
    const full: SendTemplate = { ...template, id: generateId() };
    await this.memento.update(STORAGE_KEY, [...this.list(), full]);
    return full;
  }

  async update(id: string, patch: Partial<Omit<SendTemplate, 'id'>>): Promise<void> {
    const templates = this.list().map((template) => (template.id === id ? { ...template, ...patch } : template));
    await this.memento.update(STORAGE_KEY, templates);
  }

  async remove(id: string): Promise<void> {
    await this.memento.update(
      STORAGE_KEY,
      this.list().filter((template) => template.id !== id),
    );
  }
}

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
