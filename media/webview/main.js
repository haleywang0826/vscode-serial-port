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
    defaultConfig: { baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1 },
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

  function renderConfigControls(prefix, config, locked) {
    const showCustomBaud = ui.customBaud[prefix] || !BAUD_RATE_PRESETS.includes(config.baudRate);
    const lockedAttrs = locked ? 'disabled title="Reopen the port to change this"' : '';
    return `
      <div class="config-grid">
        <label>Baud Rate</label>
        <div class="row">
          <select data-action="setting" data-prefix="${prefix}" data-field="baudRate">
            ${BAUD_RATE_PRESETS.map(
              (rate) =>
                `<option value="${rate}" ${config.baudRate === rate && !showCustomBaud ? 'selected' : ''}>${rate}</option>`,
            ).join('')}
            <option value="custom" ${showCustomBaud ? 'selected' : ''}>Custom…</option>
          </select>
          ${
            showCustomBaud
              ? `<input type="number" min="1" data-action="setting-custom-baud" data-prefix="${prefix}" value="${config.baudRate}">`
              : ''
          }
        </div>
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
      </div>`;
  }

  function renderPortPicker() {
    const openPaths = new Set(lastState.sessions.map((session) => session.path));
    const options =
      lastState.ports.length === 0
        ? '<option value="">No ports found</option>'
        : lastState.ports
            .map((port) => {
              const label = port.description ? `${port.path} (${port.description})` : port.path;
              const suffix = openPaths.has(port.path) ? ' — opened' : '';
              const selected = lastState.selectedPort === port.path ? 'selected' : '';
              const disabled = openPaths.has(port.path) ? 'disabled' : '';
              return `<option value="${escapeHtml(port.path)}" ${selected} ${disabled}>${escapeHtml(label + suffix)}</option>`;
            })
            .join('');
    const isSelectedOpen = lastState.selectedPort ? openPaths.has(lastState.selectedPort) : false;
    const openDisabled = !lastState.selectedPort || isSelectedOpen;
    const openLabel = isSelectedOpen ? 'Already open' : 'Open';
    return `
      <section class="panel-section">
        <h3>Port</h3>
        <div class="row">
          <select id="port-select">${options}</select>
          <button data-action="refresh-ports" title="Refresh port list">&#8635;</button>
        </div>
        <div class="row">
          <button data-action="open-port" ${openDisabled ? 'disabled' : ''}>${openLabel}</button>
        </div>
      </section>`;
  }

  function renderSession(session) {
    const prefix = `session:${session.path}`;
    return `
      <div class="session-card">
        <div class="session-header">
          <strong>${escapeHtml(session.path)}</strong>
          <button data-action="close-port" data-path="${escapeHtml(session.path)}">Close</button>
        </div>
        ${renderConfigControls(prefix, session.config, true)}
        <div class="row checkboxes">
          <label><input type="checkbox" data-action="checkbox" data-path="${escapeHtml(session.path)}" data-checkbox="hexSend" ${session.hexSend ? 'checked' : ''}> Hex Send</label>
          <label><input type="checkbox" data-action="checkbox" data-path="${escapeHtml(session.path)}" data-checkbox="hexRecv" ${session.hexRecv ? 'checked' : ''}> Hex Recv</label>
          <label><input type="checkbox" data-action="checkbox" data-path="${escapeHtml(session.path)}" data-checkbox="record" ${session.recording ? 'checked' : ''}> Record to Output Channel</label>
        </div>
        <div class="stats muted">TX: ${session.stats.bytesSent} bytes &nbsp; RX: ${session.stats.bytesReceived} bytes</div>
      </div>`;
  }

  function renderSessions() {
    const body =
      lastState.sessions.length === 0
        ? '<p class="muted">No open ports.</p>'
        : lastState.sessions.map(renderSession).join('');
    return `
      <section class="panel-section">
        <h3>Sessions</h3>
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

  function renderTemplateRow(template) {
    if (ui.editingTemplateId === template.id) {
      return renderTemplateForm('edit', ui.editTemplateDraft, template.id);
    }
    const openSessions = lastState.sessions;
    const targetSelect =
      openSessions.length > 1
        ? `<select data-action="template-target" data-id="${template.id}">
            ${openSessions
              .map((session) => `<option value="${escapeHtml(session.path)}">${escapeHtml(session.path)}</option>`)
              .join('')}
          </select>`
        : '';
    const sendDisabled = openSessions.length === 0 ? 'disabled title="No ports are open"' : '';
    return `
      <div class="template-row">
        <div class="template-info">
          <strong>${escapeHtml(template.name)}</strong>
          <span class="badge">${template.format}</span>
          <span class="muted truncate">${escapeHtml(template.data)}</span>
        </div>
        <div class="row">
          ${targetSelect}
          <button data-action="send-template" data-id="${template.id}" ${sendDisabled}>Send</button>
          <button data-action="edit-template-toggle" data-id="${template.id}">Edit</button>
          <button data-action="delete-template" data-id="${template.id}">Delete</button>
        </div>
      </div>`;
  }

  function renderTemplates() {
    const addForm = ui.addingTemplate ? renderTemplateForm('add', ui.addTemplateDraft) : '';
    return `
      <section class="panel-section">
        <div class="section-header">
          <h3>Send Templates</h3>
          <button data-action="add-template-toggle">+ Add</button>
        </div>
        ${addForm}
        ${lastState.templates.map(renderTemplateRow).join('')}
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
      <section class="panel-section">
        <h3>Default Settings</h3>
        ${renderConfigControls('default', lastState.defaultConfig, false)}
      </section>
      ${renderSessions()}
      ${renderTemplates()}
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
    if (el.matches('.template-form select[name="format"]')) {
      const form = el.closest('.template-form');
      draftFor(form.dataset.draft === 'add' ? 'add' : 'edit').format = el.value;
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
      draft.data = el.value;
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
      case 'open-port':
        postMessage({ type: 'openPort' });
        break;
      case 'close-port':
        postMessage({ type: 'closePort', path: el.dataset.path });
        break;
      case 'add-template-toggle':
        ui.addingTemplate = !ui.addingTemplate;
        ui.addTemplateDraft = { name: '', format: 'hex', data: '' };
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
            ui.editTemplateDraft = { name: template.name, format: template.format, data: template.data };
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
      case 'send-template': {
        const id = el.dataset.id;
        const select = root.querySelector(`select[data-action="template-target"][data-id="${id}"]`);
        postMessage({ type: 'sendTemplate', id, path: select ? select.value : undefined });
        break;
      }
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
