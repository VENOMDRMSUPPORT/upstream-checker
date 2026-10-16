// Update badge, modal and inert release-note rendering; download state belongs to this controller.
window.VENOM_RENDERER = window.VENOM_RENDERER || {};
window.VENOM_RENDERER.updates = {
  create(deps) {
    'use strict';
    const { setStatus } = deps;
    const $ = s => document.querySelector(s);
    let updateInfo = null;
    let isUpdateDownloading = false;
    let isUpdateReady = false;
    function showUpdateModal(info) {
      updateInfo = info;
      $('#update-modal-version').textContent = info.version;

      // A release is published before its notes are written, so an app that checks in
      // that window receives an empty body. Rather than a blank panel, say which case
      // it is: nothing arrived, or something arrived that parsed to nothing.
      const notesEl = $('#update-modal-notes');
      const raw = Array.isArray(info.releaseNotes)
        ? info.releaseNotes.map((n) => (typeof n === 'string' ? n : n?.note || '')).join(String.fromCharCode(10))
        : info.releaseNotes || '';

      if (raw.trim()) {
        const list = buildReleaseNotes(raw);
        // Both shapes the notes can arrive in reduce to a list. If even that comes
        // out empty, the text itself goes straight into the panel: never a second
        // framed, scrolling box inside the first.
        if (list.childElementCount > 0) notesEl.replaceChildren(list);
        else notesEl.textContent = raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      } else {
        notesEl.textContent = 'Release notes were not published yet — see the release page on GitHub.';
      }

      $('#update-progress').style.display = 'none';
      $('#update-modal-download-btn').style.display = '';
      $('#update-modal-download-btn').disabled = false;
      $('#update-modal-download-btn').innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Download Update`;
      $('#update-modal-install-btn').style.display = 'none';
      $('#update-modal-later-btn').style.display = '';
      $('#update-modal-later-btn').textContent = 'Remind Later';
      $('#update-modal-title').textContent = 'Update Available';
      $('#update-ready-note').hidden = true;

      $('#update-modal').style.display = 'flex';
    }

    function hideUpdateModal() {
      $('#update-modal').style.display = 'none';
      updateInfo = null;
    }

    // Release notes come from GitHub, so they are remote text rendered inside the
    // app. They arrive in one of two shapes: the release body in Markdown (what
    // main.js fetches from the API), or GitHub's own HTML rendering of it (what
    // electron-updater reads from the releases feed, used when the API is out of
    // reach). Both are reduced to the same items, a heading or an entry, and every
    // item is built as DOM nodes with textContent: markup in a release can only
    // ever be read as characters, never run.
    function buildReleaseNotes(notes) {
      const items = /<(h[1-6]|ul|ol|li|p)\b[^>]*>/i.test(notes) ? notesFromHtml(notes) : notesFromMarkdown(notes);
      const list = document.createElement('ul');
      items.forEach((item) => {
        const li = document.createElement('li');
        if (item.heading) {
          li.className = `notes-heading ${item.level <= 2 ? 'notes-version' : 'notes-section'}`;
          li.textContent = item.text;
        } else {
          appendInlineMarkdown(li, item.text);
        }
        if (li.textContent.trim()) list.appendChild(li);
      });
      return list;
    }

    // Markdown: headings and bullets, with a bullet's wrapped lines joined back to
    // it (the CHANGELOG wraps at 80 columns, and a line-by-line reading used to
    // keep only the first line of every entry).
    function notesFromMarkdown(md) {
      const items = [];
      let open = null;
      md.split(/\r?\n/).forEach((raw) => {
        const line = raw.trim();
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        const bullet = /^[-*+]\s+(.*)$/.exec(line);
        if (heading) {
          open = null;
          items.push({ heading: true, level: heading[1].length, text: heading[2].replace(/[*_`]/g, '') });
        } else if (bullet) {
          open = { text: bullet[1] };
          items.push(open);
        } else if (!line || line === '---' || /^\[[^\]]+\]:\s/.test(line)) {
          open = null;
        } else if (open) {
          open.text += ` ${line}`;
        } else {
          // A plain paragraph still says something; keep it as an entry.
          open = { text: line };
          items.push(open);
        }
      });
      return items;
    }

    // HTML: parsed into an inert document (DOMParser runs no scripts and loads
    // nothing), then only headings and list items are read, as text, in order.
    function notesFromHtml(html) {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const items = [];
      doc.body.querySelectorAll('h1, h2, h3, h4, h5, h6, li, p').forEach((el) => {
        // A paragraph inside a list item is part of that item.
        if (el.tagName === 'P' && el.closest('li')) return;
        const text = el.tagName === 'LI' ? inlineMarkdownOf(el) : el.textContent;
        const clean = text.replace(/\s+/g, ' ').trim();
        if (!clean) return;
        if (/^H[1-6]$/.test(el.tagName)) items.push({ heading: true, level: Number(el.tagName[1]), text: clean });
        else items.push({ text: clean });
      });
      return items;
    }

    // An HTML list item back to the small Markdown subset rendered below, so both
    // shapes show bold and code the same way.
    function inlineMarkdownOf(el) {
      let out = '';
      el.childNodes.forEach((n) => {
        if (n.nodeType === Node.TEXT_NODE) out += n.textContent;
        else if (n.nodeType === Node.ELEMENT_NODE) {
          if (/^(UL|OL)$/.test(n.tagName)) return; // nested lists are their own items
          const inner = inlineMarkdownOf(n);
          if (n.tagName === 'STRONG' || n.tagName === 'B') out += `**${inner}**`;
          else if (n.tagName === 'CODE') out += `\`${n.textContent}\``;
          else if (n.tagName === 'BR') out += ' ';
          else out += inner;
        }
      });
      return out;
    }

    // **bold**, *em* and `code` as elements; everything else as plain text.
    function appendInlineMarkdown(parent, text) {
      const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g;
      let last = 0;
      for (const m of text.matchAll(re)) {
        if (m.index > last) parent.append(text.slice(last, m.index));
        const tok = m[0];
        const el = document.createElement(tok.startsWith('**') ? 'strong' : tok.startsWith('`') ? 'code' : 'em');
        el.textContent = tok.startsWith('**') ? tok.slice(2, -2) : tok.slice(1, -1);
        parent.append(el);
        last = m.index + tok.length;
      }
      if (last < text.length) parent.append(text.slice(last));
    }

    function showDownloadProgress(percent) {
      $('#update-progress').style.display = '';
      $('#update-progress-bar').style.width = `${percent}%`;
      $('#update-progress-percent').textContent = `${percent}%`;
    }

    // The ready state is shown as the modal, not only as the badge: a download
    // started from the badge never opened it, and the badge alone gave no hint that
    // one more click was needed.
    function showUpdateReady() {
      $('#update-modal-title').textContent = 'Update Ready';
      $('#update-ready-note').hidden = false;
      $('#update-progress').style.display = 'none';
      $('#update-modal-download-btn').style.display = 'none';
      $('#update-modal-later-btn').style.display = '';
      $('#update-modal-later-btn').textContent = 'Later';
      const install = $('#update-modal-install-btn');
      install.style.display = '';
      install.disabled = false;
      $('#update-modal').style.display = 'flex';
    }

    function installUpdateNow() {
      const install = $('#update-modal-install-btn');
      install.disabled = true;
      install.innerHTML = '<span class="spinner"></span> Restarting…';
      $('#update-modal-later-btn').style.display = 'none';
      window.electronAPI.updateAPI.installUpdate();
    }

    function setUpdateBadgeLabel(text) {
      const badge = $('#update-badge');
      badge.title = text;
      badge.setAttribute('aria-label', text);
    }

    function setupUpdateListeners() {
      if (!window.electronAPI || !window.electronAPI.updateAPI) return;
      const updateAPI = window.electronAPI.updateAPI;

      updateAPI.onUpdateChecking(() => {
        console.log('Checking for updates...');
        const note = $('#about-update-note');
        if (note) note.textContent = 'Checking for updates…';
      });

      updateAPI.onUpdateAvailable((info) => {
        const note = $('#about-update-note');
        if (note) note.textContent = `New version v${info.version} available!`;
        if (!isUpdateDownloading && !isUpdateReady) {
          const badge = $('#update-badge');
          badge.hidden = false;
          setUpdateBadgeLabel(`Update v${info.version} available — click to download`);
          // Also show modal
          showUpdateModal(info);
        }
      });

      updateAPI.onUpdateNotAvailable(() => {
        console.log('No updates available');
        const note = $('#about-update-note');
        if (note) {
          note.textContent = 'Up to date — latest version installed.';
          setTimeout(() => { if (note.textContent.includes('Up to date')) note.textContent = ''; }, 6000);
        }
      });

      updateAPI.onUpdateError((data) => {
        console.error('Update error:', data.message);
        const note = $('#about-update-note');
        if (note) {
          note.textContent = 'Could not reach update server.';
          setTimeout(() => { if (note.textContent.includes('Could not reach')) note.textContent = ''; }, 6000);
        }
        if (isUpdateDownloading) {
          setStatus('error', 'Update download failed');
          isUpdateDownloading = false;
          $('#update-badge').classList.remove('update-downloading');
          setUpdateBadgeLabel('Update download failed — click to retry');
        }
      });

      updateAPI.onDownloadProgress((progress) => {
        showDownloadProgress(progress.percent);
        // The download may have been started from the modal, so the badge is put
        // into its downloading state here too.
        const badge = $('#update-badge');
        badge.classList.add('update-downloading');
        badge.style.setProperty('--progress', progress.percent);
        setUpdateBadgeLabel(`Downloading update… ${progress.percent}%`);
      });

      updateAPI.onUpdateDownloaded(() => {
        isUpdateDownloading = false;
        isUpdateReady = true;
        const badge = $('#update-badge');
        badge.classList.remove('update-downloading');
        badge.classList.add('update-ready');
        setUpdateBadgeLabel('Update ready — click to restart and install');
        showUpdateReady();
      });

      // Badge click handler
      $('#update-badge')?.addEventListener('click', () => {
        if (isUpdateReady) {
          showUpdateReady();
        } else if (!isUpdateDownloading) {
          // Start download
          isUpdateDownloading = true;
          const badge = $('#update-badge');
          badge.classList.add('update-downloading');
          window.electronAPI.updateAPI.downloadUpdate();
        }
      });

      // Update modal button handlers
      $('#update-modal-download-btn')?.addEventListener('click', () => {
        isUpdateDownloading = true;
        const btn = $('#update-modal-download-btn');
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Downloading...';
        updateAPI.downloadUpdate();
      });

      $('#update-modal-install-btn')?.addEventListener('click', installUpdateNow);

      $('#update-modal-later-btn')?.addEventListener('click', () => {
        hideUpdateModal();
        isUpdateDownloading = false;
      });

      $('#update-modal')?.addEventListener('click', (e) => {
        if (e.target.id === 'update-modal') hideUpdateModal();
      });
    }
    return { setupUpdateListeners, showUpdateModal, hideUpdateModal, notesFromMarkdown };
  },
};
