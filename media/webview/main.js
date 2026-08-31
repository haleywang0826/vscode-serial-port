// @ts-nocheck
(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');

  const BAUD_RATE_PRESETS = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
  const DATA_BITS_OPTIONS = [5, 6, 7, 8];
  const PARITY_OPTIONS = ['none', 'even', 'odd', 'mark', 'space'];
  const STOP_BITS_OPTIONS = [1, 1.5, 2];

  let lastState = {
    ports: [],
    selectedPort: undefined,
    defaultConfig: { baudRate: 115200, dataBits: 8, parity: 'none', stopBits: 1 },
    defaultHexSend: false,
    defaultHexRecv: false,
    defaultShowTimestamp: false,
    compactTimestamps: true,
    messageGapMs: 20,
    txColor: '#00cccc',
    rxColor: '#33cc33',
    saveLogAt: '${workspaceFolder}/serial_logs',
    saveLogAtIsCustom: false,
    sessions: [],
    templates: [],
  };

  // Local, not-yet-sent UI state. Kept separate from lastState so an unrelated host
  // state push (e.g. another port's byte counter tick) doesn't wipe out in-progress edits.
  const ui = {
    addingTemplate: false,
    addTemplateDraft: { name: '', format: 'hex', data: '' },
    editingTemplateId: null,
    editTemplateDraft: { name: '', format: 'hex', data: '' },
    customBaud: {},
    advancedCollapsed: {},
    portCollapsed: false,
    sessionsCollapsed: false,
    defaultSettingsCollapsed: true,
    collapsedSessions: new Set(),
    templatesCollapsed: true,
    templateTargetPath: undefined,
  };

  function postMessage(message) {
    vscode.postMessage(message);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[ch]);
  }

  function capitalize(value) {
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  function draftFor(prefix) {
    return prefix === 'add' ? ui.addTemplateDraft : ui.editTemplateDraft;
  }

  /** True if `ch` is a hex digit; mirrors `isHexDigitChar` in src/serial/format.ts. */
  function isHexDigitChar(ch) {
    return /^[0-9a-fA-F]$/.test(ch);
  }

  /** Strips non-hex characters and regroups the rest into "AA BB CC" byte pairs — the same
   * auto-spacing rule the terminal applies while hex-send is on (see appendHexInputChar in
   * src/serial/format.ts), applied here to the whole field instead of one keystroke at a time. */
  function formatHexInput(raw) {
    const digits = raw.replace(/[^0-9a-fA-F]/g, '');
    const pairs = [];
    for (let i = 0; i < digits.length; i += 2) {
      pairs.push(digits.slice(i, i + 2));
    }
    return pairs.join(' ');
  }

  /** Maps "N hex digits were before the cursor" back to a caret offset in the reformatted
   * string, so reformatting on every keystroke doesn't jump the cursor to the end. */
  function hexCursorForDigitCount(formatted, digitCount) {
    if (digitCount <= 0) {
      return 0;
    }
    let seen = 0;
    for (let i = 0; i < formatted.length; i++) {
      if (isHexDigitChar(formatted[i])) {
        seen++;
        if (seen === digitCount) {
          return i + 1;
        }
      }
    }
    return formatted.length;
  }

  function renderConfigControls(prefix, config, locked, lockBaud) {
    const showCustomBaud = ui.customBaud[prefix] || !BAUD_RATE_PRESETS.includes(config.baudRate);
    const lockedAttrs = locked ? 'disabled title="Reopen the port to change this"' : '';
    const baudLockedAttrs = lockBaud ? 'disabled title="Reopen the port to change this"' : '';
    const advancedCollapsed = ui.advancedCollapsed[prefix] !== false;
    return `
      <div class="config-grid">
        <label>Baud Rate</label>
        <div class="row">
          <select data-action="setting" data-prefix="${prefix}" data-field="baudRate" ${baudLockedAttrs}>
            ${BAUD_RATE_PRESETS.map(
              (rate) =>
                `<option value="${rate}" ${config.baudRate === rate && !showCustomBaud ? 'selected' : ''}>${rate}</option>`,
            ).join('')}
            <option value="custom" ${showCustomBaud ? 'selected' : ''}>Custom…</option>
          </select>
          ${
            showCustomBaud
              ? `<input type="number" min="1" data-action="setting-custom-baud" data-prefix="${prefix}" value="${config.baudRate}" ${baudLockedAttrs}>`
              : ''
          }
        </div>
      </div>
      <div class="section-header collapsible-header advanced-toggle" data-action="toggle-advanced" data-prefix="${prefix}">
        <span class="twisty ${advancedCollapsed ? '' : 'expanded'}"></span>
        <span class="muted">Advanced</span>
      </div>
      ${
        advancedCollapsed
          ? ''
          : `
      <div class="config-grid">
        <label>Data Bits</label>
        <select data-action="setting" data-prefix="${prefix}" data-field="dataBits" ${lockedAttrs}>
          ${DATA_BITS_OPTIONS.map(
            (bits) => `<option value="${bits}" ${config.dataBits === bits ? 'selected' : ''}>${bits}</option>`,
          ).join('')}
        </select>
        <label>Parity</label>
        <select data-action="setting" data-prefix="${prefix}" data-field="parity" ${lockedAttrs}>
          ${PARITY_OPTIONS.map(
            (parity) =>
              `<option value="${parity}" ${config.parity === parity ? 'selected' : ''}>${capitalize(parity)}</option>`,
          ).join('')}
        </select>
        <label>Stop Bits</label>
        <select data-action="setting" data-prefix="${prefix}" data-field="stopBits" ${lockedAttrs}>
          ${STOP_BITS_OPTIONS.map(
            (bits) => `<option value="${bits}" ${config.stopBits === bits ? 'selected' : ''}>${bits}</option>`,
          ).join('')}
        </select>
      </div>`
      }`;
  }

  function renderLogFolderRow() {
    const saveLogAt = lastState.saveLogAt;
    return `
      <div class="row">
        <label>Save log at</label>
      </div>
      <div class="row">
        <span class="muted truncate" title="${escapeHtml(saveLogAt ?? '')}">${escapeHtml(saveLogAt ?? '')}</span>
        ${lastState.saveLogAtIsCustom ? '<button class="icon-button" data-action="clear-log-folder" title="Reset to Default"><i class="codicon codicon-discard"></i></button>' : ''}
        <button class="icon-button" data-action="browse-log-folder" title="Change Log Folder"><i class="codicon codicon-folder-opened"></i></button>
      </div>`;
  }

  function renderPortPicker() {
    const options =
      lastState.ports.length === 0
        ? '<option value="">No ports found</option>'
        : lastState.ports
            .map((port) => {
              const label = port.description ? `${port.path} (${port.description})` : port.path;
              const selected = lastState.selectedPort === port.path ? 'selected' : '';
              return `<option value="${escapeHtml(port.path)}" ${selected}>${escapeHtml(label)}</option>`;
            })
            .join('');
    return `
      <section class="panel-section">
        <div class="section-header collapsible-header" data-action="toggle-port-section">
          <span class="twisty ${ui.portCollapsed ? '' : 'expanded'}"></span>
          <h3>Ports</h3>
        </div>
        ${
          ui.portCollapsed
            ? ''
            : `
              <div class="section-body">
                <div class="row port-row">
                  <select id="port-select">${options}</select>
                  <button class="icon-button" data-action="add-port" ${lastState.selectedPort ? '' : 'disabled'} title="Add to Sessions"><i class="codicon codicon-add"></i></button>
                  <button class="icon-button" data-action="refresh-ports" title="Refresh Port List"><i class="codicon codicon-refresh"></i></button>
                </div>
              </div>`
        }
      </section>`;
  }

  function renderSession(session) {
    const prefix = `session:${session.path}`;
    const collapsed = ui.collapsedSessions.has(session.path);
    const body = collapsed
      ? ''
      : `
        <div class="session-body">
          ${renderConfigControls(prefix, session.config, session.connected, false)}
          <div class="row checkboxes">
            <div class="checkbox-grid">
              <div class="checkbox-line">
                <label><input type="checkbox" data-action="checkbox" data-path="${escapeHtml(session.path)}" data-checkbox="rts" ${session.rts ? 'checked' : ''}> RTS</label>
                <label><input type="checkbox" data-action="checkbox" data-path="${escapeHtml(session.path)}" data-checkbox="dtr" ${session.dtr ? 'checked' : ''}> DTR</label>
              </div>
              <div class="checkbox-line">
                <label><input type="checkbox" data-action="checkbox" data-path="${escapeHtml(session.path)}" data-checkbox="hexSend" ${session.hexSend ? 'checked' : ''}> Hex Send</label>
                <label><input type="checkbox" data-action="checkbox" data-path="${escapeHtml(session.path)}" data-checkbox="hexRecv" ${session.hexRecv ? 'checked' : ''}> Hex Receive</label>
              </div>
            </div>
            <label><input type="checkbox" data-action="checkbox" data-path="${escapeHtml(session.path)}" data-checkbox="record" ${session.recording ? 'checked' : ''}> Record to File</label>
            <label><input type="checkbox" data-action="checkbox" data-path="${escapeHtml(session.path)}" data-checkbox="showTimestamp" ${session.showTimestamp ? 'checked' : ''}> Show Timestamp</label>
          </div>
          ${
            session.recording || session.logFilePath
              ? `<div class="log-line muted">
                  <span class="truncate" title="${escapeHtml(session.logFilePath ?? '')}">${
                    session.logFilePath ? escapeHtml(session.logFilePath) : 'Log file will be created once the port is opened.'
                  }</span>
                  <button class="icon-button" data-action="open-log-file" data-uri="${escapeHtml(session.logFileUri ?? '')}" title="Open Log File"><i class="codicon codicon-link-external"></i></button>
                </div>`
              : ''
          }
          <div class="stats muted">TX: ${session.stats.bytesSent} bytes &nbsp; RX: ${session.stats.bytesReceived} bytes</div>
        </div>`;
    const toggleButton = session.connected
      ? `<button class="icon-button toggle-button is-open" data-action="toggle-port" data-path="${escapeHtml(session.path)}" title="Close Port"><i class="codicon codicon-debug-stop"></i></button>`
      : `<button class="icon-button toggle-button is-closed" data-action="toggle-port" data-path="${escapeHtml(session.path)}" title="Open Port"><i class="codicon codicon-debug-start"></i></button>`;
    return `
      <div class="session-card">
        <div class="session-header collapsible-header" data-action="toggle-session" data-path="${escapeHtml(session.path)}">
          <div class="session-title">
            <span class="twisty ${collapsed ? '' : 'expanded'}"></span>
            <strong class="truncate session-name">${escapeHtml(session.path)}</strong>
          </div>
          <div class="row session-actions">
            ${toggleButton}
            <button class="icon-button" data-action="remove-session" data-path="${escapeHtml(session.path)}" title="Remove"><i class="codicon codicon-close"></i></button>
          </div>
        </div>
        ${body}
      </div>`;
  }

  function renderSessions() {
    const body = ui.sessionsCollapsed
      ? ''
      : `<div class="section-body">${
          lastState.sessions.length === 0
            ? '<p class="muted">No ports added.</p>'
            : lastState.sessions.map(renderSession).join('')
        }</div>`;
    return `
      <section class="panel-section">
        <div class="section-header collapsible-header" data-action="toggle-sessions-section">
          <span class="twisty ${ui.sessionsCollapsed ? '' : 'expanded'}"></span>
          <h3>Sessions</h3>
        </div>
        ${body}
      </section>`;
  }

  function renderTemplateForm(kind, draft, id) {
    const submitAction = kind === 'add' ? 'add-template-submit' : 'edit-template-submit';
    const cancelAction = kind === 'add' ? 'add-template-cancel' : 'edit-template-cancel';
    const idAttr = id ? `data-id="${escapeHtml(id)}"` : '';
    return `
      <div class="template-form" data-draft="${kind === 'add' ? 'add' : escapeHtml(id)}">
        <input name="name" placeholder="Name" value="${escapeHtml(draft.name)}">
        <select name="format">
          <option value="hex" ${draft.format === 'hex' ? 'selected' : ''}>Hex</option>
          <option value="ascii" ${draft.format === 'ascii' ? 'selected' : ''}>ASCII</option>
        </select>
        <textarea name="data" placeholder="Payload" rows="2">${escapeHtml(draft.data)}</textarea>
        <div class="row">
          <button data-action="${submitAction}" ${idAttr}>Save</button>
          <button data-action="${cancelAction}">Cancel</button>
        </div>
      </div>`;
  }

  function renderTemplateTargetSelect() {
    const connected = lastState.sessions.filter((session) => session.connected);
    if (connected.length === 0) {
      ui.templateTargetPath = undefined;
      return '<p class="muted">No ports are open.</p>';
    }
    if (!connected.some((session) => session.path === ui.templateTargetPath)) {
      ui.templateTargetPath = connected[0].path;
    }
    return `
      <div class="row">
        <label class="muted">Send to</label>
        <select data-action="template-target-select">
          ${connected
            .map(
              (session) =>
                `<option value="${escapeHtml(session.path)}" ${session.path === ui.templateTargetPath ? 'selected' : ''}>${escapeHtml(session.path)}</option>`,
            )
            .join('')}
        </select>
      </div>`;
  }

  function renderTemplateRow(template) {
    if (ui.editingTemplateId === template.id) {
      return renderTemplateForm('edit', ui.editTemplateDraft, template.id);
    }
    const sendDisabled = ui.templateTargetPath ? '' : 'disabled title="No ports are open"';
    return `
      <div class="template-row">
        <div class="template-row-main">
          <strong>${escapeHtml(template.name)}</strong>
          <span class="badge">${template.format}</span>
        </div>
        <div class="template-row-sub">
          <span class="muted truncate">${escapeHtml(template.data)}</span>
          <div class="row template-actions">
            <button class="icon-button" data-action="send-template" data-id="${template.id}" ${sendDisabled} title="Send"><i class="codicon codicon-send"></i></button>
            <button class="icon-button" data-action="edit-template-toggle" data-id="${template.id}" title="Edit"><i class="codicon codicon-edit"></i></button>
            <button class="icon-button" data-action="delete-template" data-id="${template.id}" title="Delete"><i class="codicon codicon-trash"></i></button>
          </div>
        </div>
      </div>`;
  }

  function renderTemplates() {
    const addForm = ui.addingTemplate ? renderTemplateForm('add', ui.addTemplateDraft) : '';
    const body = ui.templatesCollapsed
      ? ''
      : `
        <div class="section-body">
          ${renderTemplateTargetSelect()}
          ${addForm}
          ${lastState.templates.map(renderTemplateRow).join('')}
        </div>`;
    return `
      <section class="panel-section">
        <div class="section-header collapsible-header" data-action="toggle-templates">
          <span class="twisty ${ui.templatesCollapsed ? '' : 'expanded'}"></span>
          <h3>Send Templates</h3>
          <button class="icon-button" data-action="add-template-toggle" title="Add Template"><i class="codicon codicon-add"></i></button>
        </div>
        ${body}
      </section>`;
  }

  function render() {
    const active = document.activeElement;
    const focusInfo =
      active && active.id
        ? { id: active.id, selStart: active.selectionStart, selEnd: active.selectionEnd }
        : null;

    root.innerHTML = `
      ${renderPortPicker()}
      ${renderSessions()}
      ${renderTemplates()}
      <section class="panel-section">
        <div class="section-header collapsible-header" data-action="toggle-default-settings">
          <span class="twisty ${ui.defaultSettingsCollapsed ? '' : 'expanded'}"></span>
          <h3>Default Settings</h3>
        </div>
        ${
          ui.defaultSettingsCollapsed
            ? ''
            : `
              <div class="section-body">
                ${renderLogFolderRow()}
                ${renderConfigControls('default', lastState.defaultConfig, false, false)}
                <div class="row">
                  <label><input type="checkbox" data-action="default-checkbox" data-checkbox="hexSend" ${lastState.defaultHexSend ? 'checked' : ''}> Hex Send</label>
                  <label><input type="checkbox" data-action="default-checkbox" data-checkbox="hexRecv" ${lastState.defaultHexRecv ? 'checked' : ''}> Hex Receive</label>
                </div>
                <div class="row">
                  <label><input type="checkbox" data-action="default-checkbox" data-checkbox="showTimestamp" ${lastState.defaultShowTimestamp ? 'checked' : ''}> Show Timestamp</label>
                  <label><input type="checkbox" data-action="default-checkbox" data-checkbox="compactTimestamps" ${lastState.compactTimestamps ? 'checked' : ''}> Compact Timestamps</label>
                </div>
                <div class="row">
                  <label>Message Gap (ms)</label>
                  <input type="number" min="0" data-action="message-gap-ms" value="${lastState.messageGapMs}">
                </div>
                <div class="row">
                  <label>TX Color</label>
                  <input type="color" data-action="terminal-color" data-which="tx" value="${lastState.txColor}">
                  <label>RX Color</label>
                  <input type="color" data-action="terminal-color" data-which="rx" value="${lastState.rxColor}">
                </div>
              </div>`
        }
      </section>
    `;

    if (focusInfo) {
      const el = document.getElementById(focusInfo.id);
      if (el && typeof el.setSelectionRange === 'function' && focusInfo.selStart !== null) {
        el.focus();
        try {
          el.setSelectionRange(focusInfo.selStart, focusInfo.selEnd);
        } catch {
          // ignore: not all input types support selection ranges
        }
      } else if (el) {
        el.focus();
      }
    }
  }

  root.addEventListener('change', (event) => {
    const el = event.target;
    if (el.id === 'port-select') {
      postMessage({ type: 'selectPort', path: el.value });
      return;
    }
    if (el.matches('[data-action="setting"]')) {
      const prefix = el.dataset.prefix;
      const field = el.dataset.field;
      if (field === 'baudRate') {
        if (el.value === 'custom') {
          ui.customBaud[prefix] = true;
          render();
          return;
        }
        ui.customBaud[prefix] = false;
      }
      if (prefix === 'default') {
        postMessage({ type: 'updateDefaultSetting', field, value: el.value });
      } else if (prefix.startsWith('session:') && field === 'baudRate') {
        postMessage({
          type: 'updateSessionBaudRate',
          path: prefix.slice('session:'.length),
          baudRate: Number(el.value),
        });
      } else if (prefix.startsWith('session:')) {
        postMessage({
          type: 'updateSessionSetting',
          path: prefix.slice('session:'.length),
          field,
          value: el.value,
        });
      }
      return;
    }
    if (el.matches('[data-action="setting-custom-baud"]')) {
      const prefix = el.dataset.prefix;
      const value = Number(el.value);
      if (!Number.isFinite(value) || value <= 0) {
        return;
      }
      if (prefix === 'default') {
        postMessage({ type: 'updateDefaultSetting', field: 'baudRate', value: String(value) });
      } else if (prefix.startsWith('session:')) {
        postMessage({ type: 'updateSessionBaudRate', path: prefix.slice('session:'.length), baudRate: value });
      }
      return;
    }
    if (el.matches('[data-action="checkbox"]')) {
      postMessage({
        type: 'setCheckbox',
        path: el.dataset.path,
        checkbox: el.dataset.checkbox,
        value: el.checked,
      });
      return;
    }
    if (el.matches('[data-action="default-checkbox"]')) {
      postMessage({ type: 'updateDefaultCheckbox', checkbox: el.dataset.checkbox, value: el.checked });
      return;
    }
    if (el.matches('[data-action="message-gap-ms"]')) {
      const value = Number(el.value);
      if (!Number.isFinite(value) || value < 0) {
        return;
      }
      postMessage({ type: 'updateMessageGapMs', value });
      return;
    }
    if (el.matches('[data-action="terminal-color"]')) {
      postMessage({ type: 'updateTerminalColor', which: el.dataset.which, value: el.value });
      return;
    }
    if (el.matches('[data-action="template-target-select"]')) {
      ui.templateTargetPath = el.value;
      return;
    }
    if (el.matches('.template-form select[name="format"]')) {
      const form = el.closest('.template-form');
      const draft = draftFor(form.dataset.draft === 'add' ? 'add' : 'edit');
      draft.format = el.value;
      if (el.value === 'hex') {
        draft.data = formatHexInput(draft.data);
        const textarea = form.querySelector('textarea[name="data"]');
        if (textarea) {
          textarea.value = draft.data;
        }
      }
    }
  });

  root.addEventListener('input', (event) => {
    const el = event.target;
    const form = el.closest('.template-form');
    if (!form) {
      return;
    }
    const draft = draftFor(form.dataset.draft === 'add' ? 'add' : 'edit');
    if (el.name === 'name') {
      draft.name = el.value;
    } else if (el.name === 'data') {
      if (draft.format === 'hex') {
        const cursor = el.selectionStart;
        const digitsBeforeCursor = el.value.slice(0, cursor).replace(/[^0-9a-fA-F]/g, '').length;
        const formatted = formatHexInput(el.value);
        draft.data = formatted;
        if (formatted !== el.value) {
          el.value = formatted;
          const newCursor = hexCursorForDigitCount(formatted, digitsBeforeCursor);
          el.setSelectionRange(newCursor, newCursor);
        }
      } else {
        draft.data = el.value;
      }
    }
  });

  root.addEventListener('click', (event) => {
    const el = event.target.closest('[data-action]');
    if (!el) {
      return;
    }
    switch (el.dataset.action) {
      case 'refresh-ports':
        postMessage({ type: 'refreshPorts' });
        break;
      case 'browse-log-folder':
        postMessage({ type: 'browseLogFolder' });
        break;
      case 'clear-log-folder':
        postMessage({ type: 'clearLogFolder' });
        break;
      case 'open-log-file':
        postMessage({ type: 'openLogFile', uri: el.dataset.uri || undefined });
        break;
      case 'toggle-default-settings':
        ui.defaultSettingsCollapsed = !ui.defaultSettingsCollapsed;
        render();
        break;
      case 'toggle-port-section':
        ui.portCollapsed = !ui.portCollapsed;
        render();
        break;
      case 'toggle-advanced': {
        const prefix = el.dataset.prefix;
        ui.advancedCollapsed[prefix] = !(ui.advancedCollapsed[prefix] !== false);
        render();
        break;
      }
      case 'toggle-sessions-section':
        ui.sessionsCollapsed = !ui.sessionsCollapsed;
        render();
        break;
      case 'toggle-session': {
        const path = el.dataset.path;
        if (ui.collapsedSessions.has(path)) {
          ui.collapsedSessions.delete(path);
        } else {
          ui.collapsedSessions.add(path);
        }
        render();
        break;
      }
      case 'add-port':
        postMessage({ type: 'addPort' });
        break;
      case 'toggle-port':
        postMessage({ type: 'togglePort', path: el.dataset.path });
        break;
      case 'remove-session':
        postMessage({ type: 'removeSession', path: el.dataset.path });
        break;
      case 'toggle-templates':
        ui.templatesCollapsed = !ui.templatesCollapsed;
        render();
        break;
      case 'add-template-toggle':
        ui.addingTemplate = !ui.addingTemplate;
        ui.addTemplateDraft = { name: '', format: 'hex', data: '' };
        if (ui.addingTemplate) {
          ui.templatesCollapsed = false;
        }
        render();
        break;
      case 'add-template-cancel':
        ui.addingTemplate = false;
        render();
        break;
      case 'add-template-submit': {
        const { name, format, data } = ui.addTemplateDraft;
        if (!name.trim() || !data.trim()) {
          return;
        }
        postMessage({ type: 'addTemplate', name: name.trim(), format, data: data.trim() });
        ui.addingTemplate = false;
        render();
        break;
      }
      case 'edit-template-toggle': {
        const id = el.dataset.id;
        if (ui.editingTemplateId === id) {
          ui.editingTemplateId = null;
        } else {
          const template = lastState.templates.find((t) => t.id === id);
          if (template) {
            ui.editingTemplateId = id;
            ui.editTemplateDraft = {
              name: template.name,
              format: template.format,
              data: template.format === 'hex' ? formatHexInput(template.data) : template.data,
            };
          }
        }
        render();
        break;
      }
      case 'edit-template-cancel':
        ui.editingTemplateId = null;
        render();
        break;
      case 'edit-template-submit': {
        const { name, format, data } = ui.editTemplateDraft;
        if (!name.trim() || !data.trim()) {
          return;
        }
        postMessage({ type: 'updateTemplate', id: el.dataset.id, name: name.trim(), format, data: data.trim() });
        ui.editingTemplateId = null;
        render();
        break;
      }
      case 'delete-template':
        postMessage({ type: 'deleteTemplate', id: el.dataset.id });
        break;
      case 'send-template':
        postMessage({ type: 'sendTemplate', id: el.dataset.id, path: ui.templateTargetPath });
        break;
    }
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'state') {
      lastState = message.state;
      render();
    }
  });

  render();
  postMessage({ type: 'ready' });
})();
