// Shared provider-key status and rendering for cards and connected rows.
window.VENOM_RENDERER = window.VENOM_RENDERER || {};
window.VENOM_RENDERER.providerKeys = {
  create(deps) {
    'use strict';
    const {
      $$, getProviders, getSettings, getKeyDeleteArmed, pvCopied, keyProbe,
      keyTestAct, keyPolicy, isKeyFullySpent, isKeyPartiallySpent, spentHint,
      escapeHtml, formatAgo, formatIn, statusPillHTML, actIconHTML, KX_ICON,
      PV_ICON, scheduleInterval, onCatalogChanged, getCurrentPage,
      renderProvidersPage, refreshAfterKeyChange,
    } = deps;
    const KX_META_ICON = {
      models: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2 3 7l9 5 9-5-9-5Z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/></svg>',
      clock: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    };

    function keyState(k) {
      if (k.locked) return { id: 'locked', label: 'Locked', hint: 'Encrypted for another machine — re-add it' };
      if (!k.active) return { id: 'off', label: 'Off', hint: 'Switched off — not used in runs' };
      if (isKeyFullySpent(k)) return { id: 'spent', label: 'Quota used', hint: spentHint(k) };
      const partialHint = isKeyPartiallySpent(k) ? `${spentHint(k)}\n\nOther models still run on this key.` : null;
      const cool = keyPolicy.cooldownUntil(k.id);
      if (cool > Date.now()) return { id: 'cooling', label: 'Cooling down', hint: `Rate limited — free again in ${Math.ceil((cool - Date.now()) / 1000)} s` };
      const probe = keyProbe.get(k.id);
      if (probe && probe.state === 'testing') return { id: 'testing', label: 'Testing…', hint: 'Testing connection to endpoint…' };
      if (probe && probe.state === 'fail') return { id: 'fail', label: 'Failing', hint: probe.text };
      if (partialHint) return { id: 'active', label: 'Active', hint: partialHint };
      return { id: 'active', label: 'Active', hint: 'In use by test runs' };
    }

    function keyAddedLabel(k) {
      const ts = Number(String(k.id).replace(/^key_/, ''));
      if (!Number.isFinite(ts) || ts < 1e12) return '';
      return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    }

    function keyModelCount(p, k) {
      const km = window.CATALOG && window.CATALOG.keyModels(k.id);
      if (km) return km;
      if (!p.models || !p.models.length) return null;
      return { count: p.models.filter((m) => Array.isArray(m.keyIds) && m.keyIds.includes(k.id)).length, at: null };
    }

    function keyModelsHTML(p, k) {
      const km = keyModelCount(p, k);
      if (!km) return '';
      const total = p.keys.length > 1 && window.CATALOG ? window.CATALOG.providerModelCount(p.id) : null;
      const partial = total != null && km.count < total;
      const text = partial ? `${km.count} of ${total} models` : `${km.count} model${km.count === 1 ? '' : 's'}`;
      const title = (partial ? `This key sees ${km.count} of the ${total} models this provider's keys offer` : 'Models this key can use')
        + (km.at ? ` — listed ${new Date(km.at).toLocaleTimeString()}` : '');
      return `<span class="kx-meta-item${partial ? ' partial' : ''}" title="${escapeHtml(title)}">${KX_META_ICON.models}${escapeHtml(text)}</span>`;
    }

    function keyCheckedHTML(probe) {
      if (!probe || !probe.at || probe.state === 'testing') return '';
      return `<span class="kx-meta-item" title="Last checked ${escapeHtml(new Date(probe.at).toLocaleString())}">${KX_META_ICON.clock}Checked <span data-ago="${probe.at}">${escapeHtml(formatAgo(probe.at))}</span></span>`;
    }

    function keyResetHTML(k, { inline = false } = {}) {
      if (!isKeyFullySpent(k) || !k.active) return '';
      const until = k.quotaSpent.until;
      const title = escapeHtml(spentHint(k));
      if (inline) {
        return `<span class="kx-meta kx-reset" title="${title}"><span class="kx-meta-item">${KX_META_ICON.clock}<span>${until ? `Resets in <span data-in="${until}">${escapeHtml(formatIn(until))}</span>` : 'No reset time'}</span></span></span>`;
      }
      if (!until) return `<span class="ku-expiry" data-tone="low" title="${title}"><b>RESET: No reset time</b></span>`;
      const when = new Date(until).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      return `<span class="ku-expiry" data-tone="low" title="${title}"><b>RESET: Resets in <span data-in="${until}">${escapeHtml(formatIn(until))}</span></b><span class="ku-sub">${escapeHtml(when)}</span></span>`;
    }

    function refreshAgoLabels() {
      $$('[data-ago]').forEach((el) => { el.textContent = formatAgo(Number(el.dataset.ago)); });
      let lapsed = false;
      $$('[data-in]').forEach((el) => {
        const ts = Number(el.dataset.in);
        if (ts <= Date.now()) lapsed = true;
        else el.textContent = formatIn(ts);
      });
      if (lapsed) Object.keys(getProviders()).forEach(refreshAfterKeyChange);
    }

    scheduleInterval(refreshAgoLabels, 30000);
    onCatalogChanged(() => { if (getCurrentPage() === 'providers') renderProvidersPage(); });

    function keyStripHTML(p) {
      if (!p.keys.length) return '';
      return `<div class="kx-strip" aria-label="Key states">${p.keys.map((k) => {
        const state = keyState(k);
        return `<span class="kx-seg" data-state="${state.id}" title="${escapeHtml(k.name)} — ${escapeHtml(state.label)}"></span>`;
      }).join('')}</div>`;
    }

    function keyParts(p, k, i) {
      const pid = escapeHtml(p.id);
      const state = keyState(k);
      const kid = escapeHtml(k.id);
      const probe = keyProbe.get(k.id);
      const added = keyAddedLabel(k);
      const isTesting = probe && probe.state === 'testing';
      const testAct = isTesting ? 'running' : keyTestAct.get(k.id)?.state;
      const testTitle = { running: 'Testing…', ok: 'Key works', fail: 'Key failed' }[testAct] || 'Test key';
      let probeHTML;
      if (isTesting) {
        probeHTML = statusPillHTML('testing', 'Testing…');
      } else if (!k.active) {
        probeHTML = statusPillHTML('none', 'Disabled', 'Switched-off keys are excluded from routing and background checks');
      } else if (isKeyFullySpent(k)) {
        const spent = k.quotaSpent;
        probeHTML = statusPillHTML('spent', `Quota used · ${spent.status ? `HTTP ${spent.status}` : '—'}`, `${spentHint(k)}${spent.message ? `\n\n${spent.message}` : ''}`);
      } else if (probe) {
        const at = probe.at ? `Checked ${new Date(probe.at).toLocaleTimeString()}` : '';
        probeHTML = statusPillHTML(probe.state, probe.text, at);
      } else if (k.locked) {
        probeHTML = statusPillHTML('none', 'Unreadable', 'Encrypted on another machine — re-add the key');
      } else {
        probeHTML = getSettings().liveUpdates
          ? statusPillHTML('pending', 'Checking…')
          : statusPillHTML('none', 'Not checked', 'Live updates are paused — press Test to check this key');
      }
      const armed = getKeyDeleteArmed() === k.id;
      const isUnlocked = k.active && !k.locked;
      const lockTitle = k.locked
        ? 'Unreadable on this machine'
        : (k.active ? 'In use — click to disable' : 'Disabled — click to enable');
      const lockAria = isUnlocked ? 'Disable key' : 'Enable key';
      const hint = `${state.hint}${added ? ` · added ${added}` : ''}`;
      return {
        st: state,
        added,
        probe,
        index: `<span class="kx-index" title="${escapeHtml(hint)}">#${i + 1}</span>`,
        name: `<span class="kx-name-line"><span class="kx-name" title="${escapeHtml(hint)}">${escapeHtml(k.name)}</span>${
          k.locked
            ? `<span class="kx-flag warn" title="Unreadable on this machine — the key was encrypted elsewhere; re-add it">${KX_ICON.alert}</span>`
            : !k.active
              ? `<span class="kx-flag" title="Disabled by the admin — this key is not used in runs">${KX_ICON.lock}</span>`
              : ''
        }</span>`,
        secret: `<div class="kx-secret">
        ${k.locked ? '<code>encrypted</code>' : (k.hint ? `<code>${escapeHtml(k.hint)}</code>` : '<span class="kx-notsaved" title="WARNING: Key value was never saved — re-add it">NOT SAVED: not saved</span>')}
        ${k.locked ? '' : `<button class="pv-icon-btn${(pvCopied.get(`${p.id}|${k.id}`) || 0) > Date.now() ? ' copied' : ''}" type="button" data-kx-copy="${pid}|${kid}" title="${(pvCopied.get(`${p.id}|${k.id}`) || 0) > Date.now() ? 'Copied' : 'Copy key'}" aria-label="Copy key">${PV_ICON.copy}</button>`}
      </div>`,
        probeHTML,
        actions: `<button class="kx-btn icon-only kx-test-btn" type="button" data-kx-test="${pid}|${kid}"${testAct ? ` data-act="${testAct}"` : ''} ${k.locked || isTesting || testAct === 'running' ? 'disabled' : ''}${isTesting || testAct === 'running' ? ' aria-busy="true"' : ''} title="${testTitle}" aria-label="${testTitle}">${(isTesting || testAct === 'running') ? KX_ICON.test : actIconHTML(testAct, KX_ICON.test)}</button>
        <button class="kx-btn icon-only kx-lock-btn ${isUnlocked ? 'is-unlocked active' : 'is-locked'}" type="button" data-kx-active="${pid}|${kid}" ${k.locked ? 'disabled' : ''}
                title="${lockTitle}" aria-label="${lockAria}">${isUnlocked ? KX_ICON.unlock : KX_ICON.lock}</button>
        <button class="kx-btn icon-only danger ${armed ? 'armed' : ''}" type="button" data-kx-del="${pid}|${kid}" title="${armed ? `Click again to delete ${escapeHtml(k.name)} — or use Undo in toast` : `Delete ${escapeHtml(k.name)}`}" aria-label="${armed ? `Click again to delete ${escapeHtml(k.name)}` : `Delete ${escapeHtml(k.name)}`}">${KX_ICON.trash}${armed ? `<span class="kx-del-label">Delete ${escapeHtml(k.name)}?</span>` : ''}</button>`,
      };
    }

    function keysPanelHTML(p) {
      const rows = p.keys.map((k, i) => {
        const parts = keyParts(p, k, i);
        return `<div class="kx-row" data-state="${parts.st.id}">
      <div class="kx-id">
        ${parts.index}
        <div class="kx-id-text">
          ${parts.name}
          <span class="kx-meta">${parts.added ? `<span class="kx-meta-item">Added ${escapeHtml(parts.added)}</span>` : ''}${keyModelsHTML(p, k)}${keyCheckedHTML(parts.probe)}</span>
          ${keyResetHTML(k, { inline: true })}
          ${window.KEY_USAGE ? KEY_USAGE.inlineHTML(p, k) : ''}
        </div>
      </div>
      ${parts.secret}
      <div class="kx-probe-cell">${parts.probeHTML}</div>
      <div class="kx-actions">${parts.actions}</div>
    </div>`;
      }).join('');
      return `<div class="kx-panel" aria-label="API keys"><div class="kx-list">${rows}</div></div>`;
    }

    function keyRowsHTML(p) {
      return p.keys.map((k, i) => {
        const parts = keyParts(p, k, i);
        const modelsHTML = keyModelsHTML(p, k);
        const checked = parts.probe && parts.probe.at && parts.probe.state !== 'testing'
          ? `<span class="kx-checked-frame" title="Last checked ${escapeHtml(new Date(parts.probe.at).toLocaleString())}">${KX_META_ICON.clock}<span data-ago="${parts.probe.at}">${escapeHtml(formatAgo(parts.probe.at))}</span></span>`
          : '<span class="kx-checked-frame is-empty dt-muted" title="Not checked yet">—</span>';
        const last = i === p.keys.length - 1;
        return `<div class="pv-krow${last ? ' last' : ''}" data-state="${parts.st.id}">
      <div class="pv-cell col-provider"><div class="dt-key">
        ${parts.index}
        <div class="dt-key-text">${parts.name}${parts.secret}${modelsHTML ? `<span class="kx-meta">${modelsHTML}</span>` : ''}</div>
      </div></div>
      <div class="pv-cell col-status">${parts.probeHTML}</div>
      <div class="pv-cell col-rate">${window.KEY_USAGE ? KEY_USAGE.quotaCellHTML(p, k) : ''}</div>
      <div class="pv-cell col-last">${keyResetHTML(k) || (window.KEY_USAGE ? KEY_USAGE.expiryCellHTML(p, k) : '')}</div>
      <div class="pv-cell col-actions"><div class="kx-actions-stack"><div class="dt-row-actions">${parts.actions}</div>${checked}</div></div>
    </div>`;
      }).join('');
    }

    return { keyState, keyParts, keyStripHTML, keysPanelHTML, keyRowsHTML, refreshAgoLabels };
  },
};
