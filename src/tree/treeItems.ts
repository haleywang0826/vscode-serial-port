import * as vscode from 'vscode';

export type SettingField = 'baudRate' | 'dataBits' | 'parity' | 'stopBits';
export type SessionCheckbox = 'hexSend' | 'hexRecv' | 'record';

export type SerialTreeNodeKind =
  | 'portPicker'
  | 'defaultSettingsRoot'
  | 'defaultSettingRow'
  | 'session'
  | 'sessionConfigRow'
  | 'sessionCheckboxRow'
  | 'sessionStatsRow'
  | 'templatesRoot'
  | 'templateRow';

export interface SerialTreeNode {
  kind: SerialTreeNodeKind;
  field?: SettingField;
  checkbox?: SessionCheckbox;
  portPath?: string;
  templateId?: string;
}

/** A vscode.TreeItem carrying the domain data (`node`) needed to interpret clicks/checkboxes on it. */
export class SerialTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly node: SerialTreeNode,
  ) {
    super(label, collapsibleState);
  }
}

/** contextValue strings referenced by package.json's view/item/context menu `when` clauses. */
export const CONTEXT = {
  portPicker: 'serialPort.portPicker',
  portPickerOpen: 'serialPort.portPicker.open',
  defaultSettingsRoot: 'serialPort.defaultSettingsRoot',
  defaultSettingRow: 'serialPort.defaultSettingRow',
  session: 'serialPort.session',
  sessionConfigRowLive: 'serialPort.sessionConfigRow.live',
  sessionConfigRowLocked: 'serialPort.sessionConfigRow.locked',
  sessionCheckboxRow: 'serialPort.sessionCheckboxRow',
  sessionStatsRow: 'serialPort.sessionStatsRow',
  templatesRoot: 'serialPort.templatesRoot',
  templateRow: 'serialPort.templateRow',
} as const;

export const SETTING_FIELD_LABELS: Record<SettingField, string> = {
  baudRate: 'Baud Rate',
  dataBits: 'Data Bits',
  parity: 'Parity',
  stopBits: 'Stop Bits',
};

export const CHECKBOX_LABELS: Record<SessionCheckbox, string> = {
  hexSend: 'Hex Send',
  hexRecv: 'Hex Recv',
  record: 'Record to Output Channel',
};
