const statusDot    = document.getElementById('statusDot');
const statusText   = document.getElementById('statusText');
const mapTypeEl    = document.getElementById('mapType');
const mapFoundUI   = document.getElementById('mapFoundUI');
const noMapUI      = document.getElementById('noMapUI');
const retryBtn     = document.getElementById('retryBtn');
const masterToggle = document.getElementById('masterToggle');
const chkL14       = document.getElementById('chkL14');
const chkL17       = document.getElementById('chkL17');
const colorL14     = document.getElementById('colorL14');
const colorL17     = document.getElementById('colorL17');
const applyBtn     = document.getElementById('applyBtn');
const addNomBtn    = document.getElementById('addNomBtn');
const nomList      = document.getElementById('nomList');
const seeAllBtn    = document.getElementById('seeAllBtn');

let currentTab = null;
let isActive   = false;

function getSettings() {
  return { l14: chkL14.checked, l17: chkL17.checked, l14Color: colorL14.value, l17Color: colorL17.value };
}

function setStatus(state, text, type) {
  statusDot.className = 'status-dot' + (state ? ` ${state}` : '');
  statusText.textContent = text;
  mapTypeEl.textContent = type || '';
}

function showMapUI(overlayIsActive) {
  mapFoundUI.style.display = '';
  noMapUI.style.display = 'none';
  loadNominations();
  if (overlayIsActive) {
    setStatus('active', 'Overlay active', 'Wayfarer');
    masterToggle.checked = true;
    isActive = true;
  } else {
    setStatus('found', 'Map detected', 'Wayfarer');
    masterToggle.checked = false;
    isActive = false;
  }
}

function showNoMapUI(reason) {
  mapFoundUI.style.display = 'none';
  noMapUI.style.display = '';
  setStatus('missing', reason || 'No map found', '');
}

async function queryStatus() {
  setStatus('', 'Checking…', '');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;

  // Must be on Wayfarer
  if (!tab.url || !tab.url.includes('wayfarer.nianticlabs.com')) {
    showNoMapUI('Not on Wayfarer');
    return;
  }

  chrome.tabs.sendMessage(tab.id, { type: 'S2_GET_STATUS' }, resp => {
    if (chrome.runtime.lastError || !resp) {
      showNoMapUI('Content script not loaded – reload the page');
      return;
    }
    if (resp.mapFound) {
      showMapUI(resp.overlayActive);
      if (resp.settings) {
        chkL14.checked    = resp.settings.l14 !== false;
        chkL17.checked    = resp.settings.l17 !== false;
        colorL14.value    = resp.settings.l14Color || '#e040fb';
        colorL17.value    = resp.settings.l17Color || '#00bcd4';
      }
    } else {
      showNoMapUI('Map not ready yet');
    }
  });
}

function sendToggle() {
  const s = getSettings();
  chrome.storage.local.set({ s2_settings: s, s2_active: isActive });
  setStatus('', isActive ? 'Activating…' : 'Deactivating…', '');

  chrome.tabs.sendMessage(currentTab.id, { type: 'S2_TOGGLE', active: isActive, settings: s }, resp => {
    if (chrome.runtime.lastError || !resp) {
      setStatus('missing', 'Could not connect – reload the page', '');
      masterToggle.checked = false;
      isActive = false;
      return;
    }
    if (!resp.ok) {
      setStatus('missing', resp.error || 'Failed', '');
      masterToggle.checked = false;
      isActive = false;
      return;
    }
    if (isActive) setStatus('active', 'Overlay active', 'Wayfarer');
    else          setStatus('found',  'Map detected',   'Wayfarer');
  });
}

masterToggle.addEventListener('change', () => { isActive = masterToggle.checked; sendToggle(); });

applyBtn.addEventListener('click', () => {
  const s = getSettings();
  chrome.storage.local.set({ s2_settings: s });
  chrome.tabs.sendMessage(currentTab.id, { type: 'S2_UPDATE_SETTINGS', settings: s }, () => {
    applyBtn.textContent = '✓ Applied';
    setTimeout(() => { applyBtn.textContent = 'Apply changes'; }, 1200);
  });
});

// ── Future nominations ───────────────────────────────────────────────────────

function renderNomList(list) {
  nomList.innerHTML = '';
  const count = list ? list.length : 0;
  seeAllBtn.textContent = count ? `See all (${count})` : 'See all';

  if (!count) {
    const empty = document.createElement('div');
    empty.className = 'nom-empty';
    empty.textContent = 'No nominations yet.';
    nomList.appendChild(empty);
    return;
  }

  // Show only the most recent (last pushed)
  const nom = list[count - 1];
  const item = document.createElement('div');
  item.className = 'nom-item';

  const body = document.createElement('div');
  body.className = 'nom-body';
  body.title = 'Zoom to on map';
  const desc = document.createElement('div');
  desc.className = 'nom-desc';
  desc.textContent = nom.desc || '(no description)';
  const meta = document.createElement('div');
  meta.className = 'nom-meta';
  const when = nom.createdAt ? new Date(nom.createdAt).toLocaleDateString() : '';
  meta.textContent = `Latest · ${nom.lat.toFixed(5)}, ${nom.lng.toFixed(5)}${when ? ' · ' + when : ''}`;
  body.appendChild(desc);
  body.appendChild(meta);
  body.addEventListener('click', () => {
    if (!currentTab) return;
    chrome.tabs.sendMessage(currentTab.id, { type: 'S2_ZOOM_TO', lat: nom.lat, lng: nom.lng });
    window.close();
  });

  const del = document.createElement('button');
  del.className = 'nom-del';
  del.textContent = '✕';
  del.title = 'Delete';
  del.addEventListener('click', () => {
    chrome.tabs.sendMessage(currentTab.id, { type: 'S2_DELETE_NOMINATION', id: nom.id }, resp => {
      if (resp && resp.nominations) renderNomList(resp.nominations);
      else loadNominations();
    });
  });

  item.appendChild(body);
  item.appendChild(del);
  nomList.appendChild(item);
}

function loadNominations() {
  if (!currentTab) {
    chrome.storage.local.get('s2_nominations', r => renderNomList(r.s2_nominations || []));
    return;
  }
  chrome.tabs.sendMessage(currentTab.id, { type: 'S2_GET_NOMINATIONS' }, resp => {
    if (chrome.runtime.lastError || !resp) {
      chrome.storage.local.get('s2_nominations', r => renderNomList(r.s2_nominations || []));
      return;
    }
    renderNomList(resp.nominations || []);
  });
}

addNomBtn.addEventListener('click', () => {
  if (!currentTab) return;
  chrome.tabs.sendMessage(currentTab.id, { type: 'S2_START_PICK' }, () => {
    // Popup closes so the user can click the map; pick mode lives in the page.
    window.close();
  });
});

seeAllBtn.addEventListener('click', () => {
  // Must be called synchronously within this user gesture for the panel to open.
  const opts = currentTab ? { windowId: currentTab.windowId } : {};
  chrome.sidePanel.open(opts).catch(err => console.warn('Side panel open failed:', err));
  window.close();
});

// Collapsible "Cell levels" section (default expanded)
const cellHeader = document.getElementById('cellHeader');
const cellBody   = document.getElementById('cellBody');
cellHeader.addEventListener('click', () => {
  const open = cellBody.classList.toggle('open');
  cellHeader.classList.toggle('open', open);
});
// Hovering/clicking the "?" shows the tooltip without toggling the section
document.getElementById('tipWrap').addEventListener('click', e => e.stopPropagation());

retryBtn.addEventListener('click', queryStatus);

// Load saved settings before querying
chrome.storage.local.get(['s2_settings', 's2_active'], result => {
  if (result.s2_settings) {
    const s = result.s2_settings;
    chkL14.checked = s.l14 !== false;
    chkL17.checked = s.l17 !== false;
    colorL14.value = s.l14Color || '#e040fb';
    colorL17.value = s.l17Color || '#00bcd4';
  }
  isActive = !!result.s2_active;
  queryStatus();
});
