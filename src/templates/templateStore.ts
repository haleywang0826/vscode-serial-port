import * as vscode from 'vscode';

export type SendFormat = 'hex' | 'ascii';

export interface SendTemplate {
  id: string;
  name: string;
  format: SendFormat;
  data: string;
}

const STORAGE_KEY = 'sendTemplates';

/** CRUD over `serialPort.sendTemplates` configuration, shared across all workspaces via User
 * scope like the other Default Settings — see `contributes.configuration` in package.json. */
export class TemplateStore {
  /** Serializes read-modify-write cycles against the config array so two near-simultaneous edits
   * (e.g. saving two already-open template forms back to back) can't both read the same stale
   * `list()` snapshot and silently overwrite each other's change. */
  private writeChain: Promise<void> = Promise.resolve();

  private config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('serialPort');
  }

  list(): SendTemplate[] {
    return this.config().get<SendTemplate[]>(STORAGE_KEY, []);
  }

  get(id: string): SendTemplate | undefined {
    return this.list().find((template) => template.id === id);
  }

  async add(template: Omit<SendTemplate, 'id'>): Promise<SendTemplate> {
    const full: SendTemplate = { ...template, id: generateId() };
    await this.mutate((templates) => [...templates, full]);
    return full;
  }

  async update(id: string, patch: Partial<Omit<SendTemplate, 'id'>>): Promise<void> {
    await this.mutate((templates) => templates.map((template) => (template.id === id ? { ...template, ...patch } : template)));
  }

  async remove(id: string): Promise<void> {
    await this.mutate((templates) => templates.filter((template) => template.id !== id));
  }

  private mutate(update: (templates: SendTemplate[]) => SendTemplate[]): Promise<void> {
    const next = this.writeChain.then(() =>
      this.config().update(STORAGE_KEY, update(this.list()), vscode.ConfigurationTarget.Global),
    );
    this.writeChain = next.catch(() => {});
    return next;
  }
}

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
