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
