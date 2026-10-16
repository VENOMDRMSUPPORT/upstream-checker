// Update UI state machine through a fake IPC boundary; never downloads or installs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererModules } = require('./module-loader');

function setup() {
  const events = {};
  const nodes = new Map();
  const calls = { downloads: 0, installs: 0 };
  const node = () => ({
    textContent: '', innerHTML: '', style: { setProperty(k, v) { this[k] = v; } }, hidden: false, disabled: false, children: [], handlers: {},
    classList: { values: new Set(), add(v) { this.values.add(v); }, remove(v) { this.values.delete(v); } },
    setAttribute(k, v) { this[k] = v; }, addEventListener(type, fn) { this.handlers[type] = fn; },
    append(value) { this.children.push(value); if (typeof value === 'string') this.textContent += value; else this.textContent += value.textContent; },
    appendChild(value) { this.append(value); }, replaceChildren(...children) { this.children = children; },
    get childElementCount() { return this.children.length; },
  });
  const get = s => { if (!nodes.has(s)) nodes.set(s, node()); return nodes.get(s); };
  const updateAPI = { downloadUpdate: () => { calls.downloads++; }, installUpdate: () => { calls.installs++; } };
  for (const name of ['onUpdateChecking', 'onUpdateAvailable', 'onUpdateNotAvailable', 'onUpdateError', 'onDownloadProgress', 'onUpdateDownloaded']) updateAPI[name] = fn => { events[name] = fn; };
  const window = { electronAPI: { updateAPI } };
  const document = { querySelector: get, createElement: node };
  const statuses = [];
  const modules = loadRendererModules(['updates'], { window, document, setTimeout: () => 0, console: { log() {}, error() {} } });
  const updates = modules.updates.create({ setStatus: (kind, text) => statuses.push({ kind, text }) });
  updates.setupUpdateListeners();
  return { updates, events, nodes, calls, statuses, get };
}

test('release Markdown keeps wrapped bullets and headings as text items', () => {
  const { updates } = setup();
  const items = updates.notesFromMarkdown('## Version\n- First line\n  continues here\n\n- Second **item**');
  assert.deepEqual(JSON.parse(JSON.stringify(items)), [{ heading: true, level: 2, text: 'Version' }, { text: 'First line continues here' }, { text: 'Second **item**' }]);
});

test('available, download, progress and ready transitions update modal and badge', () => {
  const { events, get, calls } = setup();
  events.onUpdateAvailable({ version: '9.9.9', releaseNotes: '## Release\n- Better routing' });
  assert.equal(get('#update-modal').style.display, 'flex');
  assert.equal(get('#update-modal-version').textContent, '9.9.9');
  get('#update-modal-download-btn').handlers.click();
  assert.equal(calls.downloads, 1);
  assert.equal(get('#update-modal-download-btn').disabled, true);
  events.onDownloadProgress({ percent: 42 });
  assert.equal(get('#update-progress-bar').style.width, '42%');
  events.onUpdateDownloaded();
  assert.equal(get('#update-modal-title').textContent, 'Update Ready');
  assert.equal(get('#update-ready-note').hidden, false);
  assert.ok(get('#update-badge').classList.values.has('update-ready'));
  get('#update-badge').handlers.click();
  assert.equal(calls.downloads, 1);
  assert.equal(calls.installs, 0);
});

test('download failure resets downloading state so badge can retry', () => {
  const { events, get, calls, statuses } = setup();
  get('#update-badge').handlers.click();
  events.onUpdateError({ message: 'offline' });
  assert.equal(statuses[0].kind, 'error');
  assert.match(get('#update-badge')['aria-label'], /retry/);
  get('#update-badge').handlers.click();
  assert.equal(calls.downloads, 2);
});

test('Later closes the modal without installing or discarding ready behavior', () => {
  const { events, get, calls } = setup();
  events.onUpdateDownloaded();
  get('#update-modal-later-btn').handlers.click();
  assert.equal(get('#update-modal').style.display, 'none');
  get('#update-badge').handlers.click();
  assert.equal(get('#update-modal').style.display, 'flex');
  assert.equal(calls.installs, 0);
});
