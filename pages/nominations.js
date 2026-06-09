const listEl  = document.getElementById('list');
const countEl = document.getElementById('count');

let nominations = [];

// Shared emoji palette (scripts/emoji.js loaded before this in nominations.html)
const { DEFAULT_EMOJI, buildEmojiPicker } = window.S2Emoji;

function load() {
  chrome.storage.local.get('s2_nominations', r => {
    nominations = Array.isArray(r.s2_nominations) ? r.s2_nominations : [];
    render();
  });
}

function persist() {
  chrome.storage.local.set({ s2_nominations: nominations });
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// Pan the Wayfarer map (in its tab) to a nomination.
function showOnMap(nom, btn) {
  chrome.tabs.query({ url: '*://wayfarer.nianticlabs.com/*' }, tabs => {
    if (!tabs || !tabs.length) {
      if (btn) flashBtn(btn, 'Open Wayfarer first');
      return;
    }
    const tab = tabs.find(t => t.active) || tabs[0];
    chrome.tabs.sendMessage(tab.id, { type: 'S2_ZOOM_TO', lat: nom.lat, lng: nom.lng }, () => {
      if (chrome.runtime.lastError && btn) flashBtn(btn, 'Reload Wayfarer tab');
    });
  });
}

function flashBtn(btn, msg) {
  const original = btn.textContent;
  btn.textContent = msg;
  setTimeout(() => { btn.textContent = original; }, 1600);
}

function render() {
  listEl.innerHTML = '';
  countEl.textContent = nominations.length
    ? `${nominations.length} saved`
    : '';

  if (!nominations.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = '<span class="icon">📍</span>No nominations yet.<br>Open the extension on the Wayfarer map and add one.';
    listEl.appendChild(empty);
    return;
  }

  // newest first
  [...nominations].reverse().forEach(nom => {
    const row = document.createElement('div');
    row.className = 'nom';

    const pin = document.createElement('button');
    pin.className = 'nom-pin';
    pin.title = 'Change emoji';
    pin.textContent = nom.emoji || DEFAULT_EMOJI;
    let palette = null;
    const closePalette = () => {
      if (palette) { palette.remove(); palette = null; }
      document.removeEventListener('click', onOutside);
    };
    const onOutside = ev => { if (palette && !palette.contains(ev.target) && ev.target !== pin) closePalette(); };
    pin.addEventListener('click', ev => {
      ev.stopPropagation();
      if (palette) { closePalette(); return; }
      palette = buildEmojiPicker(nom.emoji || DEFAULT_EMOJI, em => {
        nom.emoji = em;
        const idx = nominations.findIndex(n => n.id === nom.id);
        if (idx !== -1) nominations[idx].emoji = em;
        pin.textContent = em;
        persist();
        closePalette();
      });
      palette.classList.add('emoji-popover');
      pin.parentElement.appendChild(palette);
      setTimeout(() => document.addEventListener('click', onOutside), 0);
    });

    const main = document.createElement('div');
    main.className = 'nom-main';

    const title = document.createElement('textarea');
    title.className = 'nom-title';
    title.rows = 1;
    title.value = nom.desc || '';
    title.placeholder = '(no description)';
    const flash = document.createElement('span');
    flash.className = 'saved-flash';
    flash.textContent = '✓ saved';
    const commit = () => {
      const v = title.value.trim();
      if (v === (nom.desc || '')) return;
      nom.desc = v;
      const idx = nominations.findIndex(n => n.id === nom.id);
      if (idx !== -1) nominations[idx].desc = v;
      persist();
      flash.classList.add('show');
      setTimeout(() => flash.classList.remove('show'), 1200);
    };
    title.addEventListener('blur', commit);
    title.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); title.blur(); }
    });

    const meta = document.createElement('div');
    meta.className = 'nom-meta';
    const coord = document.createElement('a');
    coord.className = 'coord-link';
    coord.href = `https://www.google.com/maps?q=${nom.lat},${nom.lng}`;
    coord.target = '_blank';
    coord.rel = 'noopener';
    coord.textContent = `${nom.lat.toFixed(6)}, ${nom.lng.toFixed(6)}`;
    const date = document.createElement('span');
    date.className = 'nom-date';
    date.textContent = fmtDate(nom.createdAt);
    meta.appendChild(coord);
    meta.appendChild(date);
    meta.appendChild(flash);

    main.appendChild(title);
    main.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'nom-actions';

    const showBtn = document.createElement('button');
    showBtn.className = 'icon-btn';
    showBtn.textContent = '🗺 Show on map';
    showBtn.title = 'Pan the Wayfarer map to this nomination';
    showBtn.addEventListener('click', () => showOnMap(nom, showBtn));
    actions.appendChild(showBtn);

    const del = document.createElement('button');
    del.className = 'icon-btn del';
    del.textContent = '🗑 Delete';
    del.addEventListener('click', () => {
      nominations = nominations.filter(n => n.id !== nom.id);
      persist();
      render();
    });
    actions.appendChild(del);

    row.appendChild(pin);
    row.appendChild(main);
    row.appendChild(actions);
    listEl.appendChild(row);
  });
}

// Keep in sync if pins are added/removed elsewhere while this tab is open
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.s2_nominations) {
    nominations = Array.isArray(changes.s2_nominations.newValue) ? changes.s2_nominations.newValue : [];
    // Avoid clobbering a field the user is actively editing
    if (document.activeElement && document.activeElement.classList.contains('nom-title')) return;
    render();
  }
});

load();
