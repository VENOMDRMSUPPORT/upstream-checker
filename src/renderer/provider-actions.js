// Provider key and health actions; persistence and network remain injected.
window.VENOM_RENDERER = window.VENOM_RENDERER || {};
window.VENOM_RENDERER.providerActions = {
  create(deps) {
    'use strict';
    const {
      getProviders, getActiveProvider, getCurrentPage,
      getKeyDeleteArmed, setKeyDeleteArmed, getExpanded,
      keyProbe, keyTestAct, recheckAct, saveProviderConfig,
      renderKeysList, updateTestAllButton, renderProvidersPage,
      setStatus, isHealthyResponse, keyProbeResult, setAct,
      healthTimeoutMs, actionMinRunningMs,
    } = deps;
    const pvExpanded = getExpanded();
    const KX_ICON = deps.KX_ICON;
    const escapeHtml = deps.escapeHtml;
    let keyDeleteTimer = null;
async function copyKey(keyId, btn) {
  const key = getProviders()[getActiveProvider()].keys.find((k) => k.id === keyId);
  if (!key || key.locked) return;
  try {
    await window.electronAPI.copyKey(keyId);
    btn.classList.add('copied');
    btn.title = 'Copied';
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.title = 'Copy key';
    }, 1200);
  } catch (err) {
    setStatus('error', 'Could not copy the key to the clipboard');
  }
}

async function toggleKeyActive(keyId) {
  const p = getProviders()[getActiveProvider()];
  const key = p.keys.find((k) => k.id === keyId);
  if (!key) return;
  key.active = !key.active;
  await saveProviderConfig(getActiveProvider());
  renderKeysList();
  updateTestAllButton();
}

async function removeKey(keyId) {
  const p = getProviders()[getActiveProvider()];
  p.keys = p.keys.filter((k) => k.id !== keyId);
  await saveProviderConfig(getActiveProvider());
  renderKeysList();
  updateTestAllButton();
}

// Refresh the provider's cards after a manual reachability check starts.
function recheckProvider(id) {
  if (recheckAct.get(id)?.state === 'running') return;
  setAct(recheckAct, id, 'running');
  if (getCurrentPage() === 'providers') renderProvidersPage();
  // One unified pass for this provider: fresh verdicts and a fresh roster.
  if (window.CATALOG && window.CATALOG.syncAll) window.CATALOG.syncAll({ reason: 'manual', providerId: id });
  else setAct(recheckAct, id, 'fail');
  if (window.KEY_USAGE) KEY_USAGE.refreshProvider(id, { force: true });
}

function refreshAfterKeyChange(pid) {
  if (pid === getActiveProvider()) {
    renderKeysList();
    updateTestAllButton();
  }
  if (getCurrentPage() === 'providers') {
    const page = document.querySelector('.page-providers');
    const scrollPos = page ? page.scrollTop : window.scrollY;
    const activeEl = document.activeElement;
    const activeSelector = activeEl && activeEl.dataset ? (
      activeEl.dataset.kxDel ? `[data-kx-del="${activeEl.dataset.kxDel}"]` :
      activeEl.dataset.kxTest ? `[data-kx-test="${activeEl.dataset.kxTest}"]` :
      activeEl.dataset.kxActive ? `[data-kx-active="${activeEl.dataset.kxActive}"]` :
      activeEl.dataset.kxCopy ? `[data-kx-copy="${activeEl.dataset.kxCopy}"]` :
      null
    ) : null;

    renderProvidersPage();

    if (page) page.scrollTop = scrollPos;
    else window.scrollTo(window.scrollX, scrollPos);

    if (activeSelector) {
      const elToFocus = document.querySelector(activeSelector);
      if (elToFocus) elToFocus.focus({ preventScroll: true });
    }
  }
}

// Checks one key with the provider: a GET on its models endpoint, unless the
// module declares meta.keyCheck because that endpoint answers without a key
// and so says nothing about one. Never rejects: a failure comes back as a
// response.
async function probeKey(p, apiKey) {
  const check = p.keyCheck || { endpoint: p.modelsEndpoint || '/models' };
  try {
    return await window.electronAPI.apiRequest({
      url: `${p.baseUrl}${check.endpoint}`,
      method: check.method || 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: check.body ? JSON.stringify(check.body) : undefined,
      timeoutMs: healthTimeoutMs,
      source: 'key_check',
    });
  } catch (err) {
    return { status: 0, networkError: true, error: err.message };
  }
}

async function testKey(pid, kid) {
  const p = getProviders()[pid];
  const k = p && p.keys.find((x) => x.id === kid);
  if (!k || k.locked) return;
  const startedAt = Date.now();
  keyProbe.set(kid, { state: 'testing', text: 'Testing…', at: startedAt });
  refreshAfterKeyChange(pid);
  const res = await probeKey(p, k.key);
  // A models check can't see a spent quota. A module that reports usage is
  // read here, while the spinner still runs; the reading also settles the
  // key's spent-quota state (key-usage.js reconcileSpent).
  if (window.KEY_USAGE && isHealthyResponse(res)) await KEY_USAGE.refresh(pid, kid, { force: true });
  // Same minimum spinner time as Recheck, so an instant answer still reads.
  const hold = startedAt + actionMinRunningMs - Date.now();
  if (hold > 0) await new Promise((r) => setTimeout(r, hold));
  const result = keyProbeResult(res);
  keyProbe.set(kid, result);
  setAct(keyTestAct, kid, result.state);
  refreshAfterKeyChange(pid);
}

async function setKeyActive(pid, kid) {
  const p = getProviders()[pid];
  const k = p && p.keys.find((x) => x.id === kid);
  if (!k || k.locked) return;
  k.active = !k.active;
  if (!k.active) {
    keyProbe.delete(kid);
    if (window.KEY_USAGE) KEY_USAGE.forget(kid);
  }
  await saveProviderConfig(pid);
  refreshAfterKeyChange(pid);
}

// Two clicks to delete: the first arms the button for a few seconds.
async function deleteKey(pid, kid) {
  if (getKeyDeleteArmed() !== kid) {
    setKeyDeleteArmed(kid);
    clearTimeout(keyDeleteTimer);
    keyDeleteTimer = setTimeout(() => { setKeyDeleteArmed(null); refreshAfterKeyChange(pid); }, 3500);
    refreshAfterKeyChange(pid);
    return;
  }
  clearTimeout(keyDeleteTimer);
  setKeyDeleteArmed(null);
  const p = getProviders()[pid];
  const deletedIndex = p.keys.findIndex((x) => x.id === kid);
  const deletedKey = deletedIndex >= 0 ? { ...p.keys[deletedIndex] } : null;
  p.keys = p.keys.filter((x) => x.id !== kid);
  keyProbe.delete(kid);
  if (window.KEY_USAGE) KEY_USAGE.forget(kid);
  if (window.CATALOG) window.CATALOG.forgetKey(kid);
  if (!p.keys.length) pvExpanded.delete(pid);
  await saveProviderConfig(pid);
  refreshAfterKeyChange(pid);
  if (deletedKey) {
    showKeyDeletedToast(pid, deletedKey, deletedIndex);
  }
}

function showKeyDeletedToast(pid, deletedKey, deletedIndex) {
  const root = document.getElementById('mc-toasts');
  if (!root) return;
  const el = document.createElement('div');
  el.className = 'mc-toast mc-toast-warn';
  el.setAttribute('role', 'status');
  const keyLabel = deletedKey.name || deletedKey.hint || 'key';
  el.innerHTML = `<span class="mc-toast-ico">${KX_ICON.trash}</span><span class="mc-toast-msg">Deleted key <strong>${escapeHtml(keyLabel)}</strong></span><button class="mc-toast-undo" type="button">Undo</button>`;
  let undone = false;
  const undoBtn = el.querySelector('.mc-toast-undo');
  if (undoBtn) {
    undoBtn.onclick = async () => {
      if (undone) return;
      undone = true;
      const p = getProviders()[pid];
      if (p) {
        if (deletedIndex >= 0 && deletedIndex <= p.keys.length) {
          p.keys.splice(deletedIndex, 0, deletedKey);
        } else {
          p.keys.push(deletedKey);
        }
        await saveProviderConfig(pid);
        refreshAfterKeyChange(pid);
      }
      el.classList.remove('show');
      setTimeout(() => el.remove(), 240);
    };
  }
  root.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    if (!undone) {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 240);
    }
  }, 5000);
}

// Accordion: opening one provider closes whichever was open.
function togglePvExpanded(pid) {
  const wasOpen = pvExpanded.has(pid);
  pvExpanded.clear();
  if (!wasOpen) pvExpanded.add(pid);
  if (getCurrentPage() === 'providers') renderProvidersPage();
  // Opening a provider's keys brings their usage up to date (if it is stale).
  if (!wasOpen && window.KEY_USAGE) KEY_USAGE.refreshProvider(pid);
}

// ============================================
    return {
      copyKey, toggleKeyActive, removeKey, recheckProvider,
      refreshAfterKeyChange, probeKey, testKey, setKeyActive, deleteKey,
      showKeyDeletedToast, togglePvExpanded,
    };
  },
};
