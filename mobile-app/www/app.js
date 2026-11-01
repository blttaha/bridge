(function () {
  'use strict';

  const STORAGE_DEVICES_KEY = 'tahablt_saved_devices_v1';
  const STORAGE_ACTIVE_ID_KEY = 'tahablt_active_device_id_v1';
  const STORAGE_WORKSPACE_CACHE_KEY = 'tahablt_workspace_cache_v1';

  const ZONE_LABELS = {
    fullscreen: 'Tam Ekran',
    'left-half': 'Sol Yarı',
    'right-half': 'Sağ Yarı',
    'top-half': 'Üst Yarı',
    'bottom-half': 'Alt Yarı',
    'top-left': 'Sol Üst',
    'top-right': 'Sağ Üst',
    'bottom-left': 'Sol Alt',
    'bottom-right': 'Sağ Alt',
    'left-third': 'Sol 1/3',
    'center-third': 'Orta 1/3',
    'right-third': 'Sağ 1/3',
    custom: 'Özel Konum'
  };

  const ZONE_COORDS = {
    fullscreen: { x: 0, y: 0, w: 1, h: 1, state: 'maximized' },
    'left-half': { x: 0, y: 0, w: 0.5, h: 1, state: 'normal' },
    'right-half': { x: 0.5, y: 0, w: 0.5, h: 1, state: 'normal' },
    'top-half': { x: 0, y: 0, w: 1, h: 0.5, state: 'normal' },
    'bottom-half': { x: 0, y: 0.5, w: 1, h: 0.5, state: 'normal' },
    'top-left': { x: 0, y: 0, w: 0.5, h: 0.5, state: 'normal' },
    'top-right': { x: 0.5, y: 0, w: 0.5, h: 0.5, state: 'normal' },
    'bottom-left': { x: 0, y: 0.5, w: 0.5, h: 0.5, state: 'normal' },
    'bottom-right': { x: 0.5, y: 0.5, w: 0.5, h: 0.5, state: 'normal' }
  };

  // Canvas is kept at the PC's native resolution (capped here); motion quality adapts on the PC side
  const STREAM_PRESETS = {
    balanced: { label: 'Kalite: Dengeli (Yerel Çözünürlük)', fps: 60, maxCanvasWidth: 2560 },
    hd: { label: 'Kalite: Ultra HD (4K)', fps: 60, maxCanvasWidth: 3840 },
    saver: { label: 'Kalite: Mobil Veri', fps: 30, maxCanvasWidth: 1600 }
  };

  const USER_SETTINGS_KEY = 'tahablt_user_settings_v1';
  const AUDIT_LOG_STORAGE_KEY = 'tahablt_audit_log_v1';

  function loadUserSettings() {
    try {
      const raw = localStorage.getItem(USER_SETTINGS_KEY);
      if (raw) return JSON.parse(raw);
    } catch {}
    return {
      mediaNotification: true,
      connNotification: true,
      virtualCursor: true,
      doubleTapZoom: true,
      hapticFeedback: true,
      autoReconnect: true
    };
  }

  function saveUserSettings(s) {
    try {
      localStorage.setItem(USER_SETTINGS_KEY, JSON.stringify(s));
    } catch {}
  }

  const userSettings = loadUserSettings();

  const state = {
    devices: loadSavedDevices(),
    discoveredDevices: [],
    activeDeviceId: localStorage.getItem(STORAGE_ACTIVE_ID_KEY) || null,
    showingHubView: false,
    activeHubTab: 'hub-tab-devices',
    userSettings,
    ws: null,
    isAuthenticated: false,
    isInitialConnecting: false,
    wasAuthenticatedOnce: false,
    isReconnecting: false,
    reconnectAttempts: 0,
    reconnectTimer: null,
    consecutivePingFails: 0,
    connectedRoute: null,
    latencyMs: null,
    lastAliveTs: 0,
    reqSeq: 1,
    pendingReqs: new Map(),
    pingTimer: null,
    bootWatchTimer: null,
    bootWatchStartedAt: 0,
    clipboardHistory: [],

    // Live PC state (populated ONLY when connected)
    monitors: [],
    windows: [],
    scenes: [],
    macros: [],
    quickActions: [],
    installedApps: [],
    audio: { masterVolume: 100, masterMuted: false, sessions: [] },
    stats: { cpuPercent: 0, memoryPercent: 0, usedRamGb: 0, totalRamGb: 0, isLocked: false },
    isPcLocked: false,
    powerTimer: { active: false, mode: 'sleep', targetTs: 0, remainingSec: 0 },
    selectedTimerMode: 'sleep',

    // Dedicated Applications Catalog ("Uygulamalar" Tab) state
    customApps: [],
    appsSearchQuery: '',
    appsFilterMode: 'all',
    appsLaunchMonitor: 0,
    quickLaunchMonitor: 0,
    lastMediaNotifHash: '',

    // Quick Action Composer state
    editingQaId: null,
    qaExecMode: 'parallel',
    qaItemSource: 'file',
    qaItems: [],
    qaSelectedFileMeta: null,

    // Macro Composer state
    editingMacroId: null,
    macroSteps: [],
    macroActiveMods: [],

    // PC File System Browser state
    fsBrowserMode: 'browse', // 'browse' or 'pick_for_qa'
    fsCurrentPath: '',
    fsParentPath: '',
    fsRoots: [],
    fsEntries: [],

    // Universal Properties Inspector state
    activePropContext: null,

    // Scene composer state
    editingSceneId: null,
    composerAppSource: 'installed',
    composerTargetMonitor: 0,
    composerTargetZone: 'fullscreen',
    composerItems: [],

    // Quick window snap modal state
    snapTargetWindow: null,
    snapTargetMonitor: 0,

    // Remote Desktop Workstation state (60 FPS Low-Latency Engine)
    activeTab: 'tab-scenes',
    remoteMonitorIndex: 0, // 0, 1, ... or -1 for All Monitors
    remoteInputMode: 'trackpad', // 'trackpad' (Mouse Cursor Mode) or 'direct' (Touch Mode)
    isStreaming: false,
    isFullscreen: false,
    streamPresetKey: 'balanced',
    cursorNormX: 0.5,
    cursorNormY: 0.5,
    cursorSensitivity: 1.35,
    isLeftButtonHeld: false,
    zoomScale: 1.0,
    panX: 0,
    panY: 0,
    frameCounter: 0,
    lastFpsCalcTs: performance.now(),
    measuredFps: 0,
    hasReceivedFrameOnce: false,
    streamBounds: { width: 1920, height: 1080 },
    pingCycleCount: 0,
    isSeekingMedia: false,
    lastMediaSyncWallTs: 0,
    mediaTimelineTickTimer: null
  };

  const TAB_ORDER = ['tab-scenes', 'tab-macros', 'tab-apps', 'tab-remote', 'tab-system'];
  const HUB_TAB_ORDER = ['hub-tab-devices', 'hub-tab-settings'];
  const modalCloseTimers = new Map();

  function syncModalBodyState() {
    const backdrops = Array.from(document.querySelectorAll('.modal-backdrop'));
    const anyOpen = backdrops.some((el) => el.classList.contains('is-open') && !el.classList.contains('hidden'));
    document.body.classList.toggle('modal-open', anyOpen);
    syncAndroidNavBarColor();
  }

  function openModal(id) {
    const el = typeof id === 'string' ? document.getElementById(id) : id;
    if (!el) return;
    const modalId = el.id || String(id);
    if (modalCloseTimers.has(modalId)) {
      clearTimeout(modalCloseTimers.get(modalId));
      modalCloseTimers.delete(modalId);
    }
    el.classList.remove('hidden');
    void el.offsetWidth;
    el.classList.add('is-open');
    syncModalBodyState();
  }

  function closeModal(id) {
    const el = typeof id === 'string' ? document.getElementById(id) : id;
    if (!el) return;
    const modalId = el.id || String(id);
    el.classList.remove('is-open');
    syncModalBodyState();
    if (modalCloseTimers.has(modalId)) {
      clearTimeout(modalCloseTimers.get(modalId));
    }
    const timer = setTimeout(() => {
      modalCloseTimers.delete(modalId);
      if (!el.classList.contains('is-open')) {
        el.classList.add('hidden');
      }
      syncModalBodyState();
    }, 290);
    modalCloseTimers.set(modalId, timer);
  }

  function switchToTab(targetTab, animate = true) {
    if (targetTab === 'tab-monitors') targetTab = 'tab-remote';
    const idx = TAB_ORDER.indexOf(targetTab);
    if (idx < 0) return;

    if (state.showingHubView) {
      state.showingHubView = false;
      syncConnectionViewState();
    }

    if (state.isFullscreen && targetTab !== 'tab-remote') {
      setRemoteFullscreen(false);
    }

    const prevTab = state.activeTab;
    state.activeTab = targetTab;

    if (prevTab !== targetTab) {
      const appsSearchEl = document.getElementById('appsTabSearchInput');
      if ((appsSearchEl && appsSearchEl.value) || state.appsSearchQuery) {
        if (appsSearchEl) appsSearchEl.value = '';
        state.appsSearchQuery = '';
        renderAppsTab();
      }
    }

    const stepPercent = 100 / TAB_ORDER.length;
    const track = document.getElementById('workspaceTabsTrack');
    if (track) {
      if (!animate) track.classList.add('is-dragging');
      else track.classList.remove('is-dragging');
      track.style.transform = `translate3d(-${(idx * stepPercent).toFixed(4)}%, 0, 0)`;
      if (!animate) {
        void track.offsetWidth;
        track.classList.remove('is-dragging');
      }
    }

    const navIndicator = document.getElementById('navActiveIndicator');
    if (navIndicator) {
      navIndicator.style.transform = `translate3d(${idx * 100}%, 0, 0)`;
    }

    document.querySelectorAll('#bottomNav .nav-item').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === targetTab);
    });

    document.querySelectorAll('.tab-panel').forEach((panel) => {
      panel.classList.toggle('active', panel.id === targetTab);
    });

    if (prevTab !== targetTab && window.scrollY > 120) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    if (targetTab !== 'tab-remote' && state.isStreaming) {
      stopRemoteStream();
    }

    if (targetTab === 'tab-system' && state.isAuthenticated) {
      refreshWirelessStatus(true);
    }
  }

  function switchToHubTab(targetHubTab, animate = true) {
    const idx = HUB_TAB_ORDER.indexOf(targetHubTab);
    if (idx < 0) return;

    state.activeHubTab = targetHubTab;
    if (!state.showingHubView && getActiveDevice()) {
      state.showingHubView = true;
      syncConnectionViewState();
    }

    const hubTrack = document.getElementById('hubTabsTrack');
    if (hubTrack) {
      if (!animate) hubTrack.classList.add('is-dragging');
      else hubTrack.classList.remove('is-dragging');
      hubTrack.style.transform = `translate3d(-${idx * 50}%, 0, 0)`;
      if (!animate) {
        void hubTrack.offsetWidth;
        hubTrack.classList.remove('is-dragging');
      }
    }

    const hubIndicator = document.getElementById('hubNavActiveIndicator');
    if (hubIndicator) {
      hubIndicator.style.transform = `translate3d(${idx * 100}%, 0, 0)`;
    }

    document.querySelectorAll('#hubBottomNav .hub-nav-item').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-hub-tab') === targetHubTab);
    });

    document.querySelectorAll('.hub-tab-panel').forEach((panel) => {
      panel.classList.toggle('active', panel.id === targetHubTab);
      panel.classList.remove('hidden');
    });

    if (targetHubTab === 'hub-tab-devices') {
      renderSavedDevicesList();
    }

    if (window.scrollY > 80) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  // Android Hardware Back Button hook
  window.__handleAndroidBack = function () {
    if (document.body.classList.contains('layout-edit-mode')) {
      exitPageLayoutEditMode();
      return true;
    }
    if (state.isFullscreen) {
      setRemoteFullscreen(false);
      return true;
    }
    const openModals = Array.from(document.querySelectorAll('.modal-backdrop')).filter(
      (el) => el.classList.contains('is-open') || !el.classList.contains('hidden')
    );
    if (openModals.length > 0) {
      closeModal(openModals[openModals.length - 1]);
      return true;
    }
    if (state.showingHubView) {
      if (state.activeHubTab === 'hub-tab-settings') {
        switchToHubTab('hub-tab-devices');
        return true;
      }
      if (getActiveDevice() && (state.isAuthenticated || state.isInitialConnecting)) {
        state.showingHubView = false;
        syncConnectionViewState();
        return true;
      }
    }
    if ((state.isAuthenticated || state.isInitialConnecting) && state.activeTab !== 'tab-scenes') {
      switchToTab('tab-scenes', true);
      return true;
    }
    return false;
  };

  function triggerHaptic(ms) {
    try {
      if (window.TahaNative && typeof window.TahaNative.haptic === 'function') {
        window.TahaNative.haptic(ms || 12);
        return;
      }
      if (navigator.vibrate) {
        navigator.vibrate(ms || 10);
      }
    } catch {}
  }

  let toastTimeout = null;
  function showToast(message) {
    const bar = document.getElementById('toastBar');
    const txt = document.getElementById('toastText');
    if (!bar || !txt) return;
    txt.textContent = message;
    bar.classList.remove('hidden');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      bar.classList.add('hidden');
    }, 2400);
  }

  function loadSavedDevices() {
    try {
      const raw = localStorage.getItem(STORAGE_DEVICES_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {}
    return [];
  }

  function syncActiveDeviceToNative() {
    try {
      const dev = state.devices.find((d) => d.deviceId === state.activeDeviceId) || state.devices[0] || null;
      if (window.TahaNative && typeof window.TahaNative.syncActiveDeviceForQuickControls === 'function') {
        window.TahaNative.syncActiveDeviceForQuickControls(dev ? JSON.stringify(dev) : '');
      }
      if (window.TahaNative && typeof window.TahaNative.syncAllDevicesForQuickControls === 'function') {
        window.TahaNative.syncAllDevicesForQuickControls(JSON.stringify(state.devices || []));
      }
    } catch {}
  }

  window.__onNativeActiveDeviceCycled = function (nextDeviceId) {
    try {
      if (!nextDeviceId || state.activeDeviceId === nextDeviceId) return;
      const found = state.devices.find((d) => d.deviceId === nextDeviceId);
      if (!found) return;
      state.activeDeviceId = nextDeviceId;
      resetActiveDeviceWorkspaceState(nextDeviceId);
      saveDevicesToStorage();
      renderSavedDevicesList();
      syncConnectionViewState();
      connectToActiveDevice();
      showToast(`Hedef bilgisayar: ${found.deviceName || found.lanIp}`);
    } catch {}
  };

  function saveDevicesToStorage() {
    localStorage.setItem(STORAGE_DEVICES_KEY, JSON.stringify(state.devices));
    if (state.activeDeviceId) {
      localStorage.setItem(STORAGE_ACTIVE_ID_KEY, state.activeDeviceId);
    } else {
      localStorage.removeItem(STORAGE_ACTIVE_ID_KEY);
    }
    syncActiveDeviceToNative();
  }

  function getActiveDevice() {
    if (!state.devices.length) return null;
    const found = state.devices.find((d) => d.deviceId === state.activeDeviceId);
    if (found) return found;
    state.activeDeviceId = state.devices[0].deviceId;
    saveDevicesToStorage();
    return state.devices[0];
  }

  function logAuditEvent(type, message, details = {}) {
    try {
      const raw = localStorage.getItem(AUDIT_LOG_STORAGE_KEY);
      const list = raw ? JSON.parse(raw) : [];
      const now = new Date();
      const item = {
        id: String(Date.now()) + '-' + Math.random().toString(36).slice(2, 6),
        ts: Date.now(),
        timeStr: now.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        dateStr: now.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit' }),
        type, // 'connect' | 'disconnect' | 'lock' | 'unlock' | 'power' | 'scene' | 'app' | 'security'
        message,
        deviceName: (getActiveDevice() && getActiveDevice().deviceName) || 'PC',
        details
      };
      list.unshift(item);
      if (list.length > 250) list.length = 250;
      localStorage.setItem(AUDIT_LOG_STORAGE_KEY, JSON.stringify(list));
      renderAuditLogModal();
    } catch {}
  }

  function getAuditIconSvg(type) {
    switch (type) {
      case 'connect':
        return '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l3 3 7-7"/></svg>';
      case 'disconnect':
        return '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l8 8M14 6l-8 8"/></svg>';
      case 'lock':
        return '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="9" width="11" height="8" rx="2"/><path d="M7 9V6.5a3 3 0 0 1 6 0V9"/></svg>';
      case 'unlock':
        return '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="9" width="11" height="8" rx="2"/><path d="M7 9V6.5a3 3 0 0 1 5.6-1.5"/></svg>';
      case 'power':
        return '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3v6.5"/><path d="M14.2 5.4a6 6 0 1 1-8.4 0"/></svg>';
      case 'scene':
        return '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="6" height="6" rx="1.2"/><rect x="11" y="3" width="6" height="6" rx="1.2"/><rect x="3" y="11" width="14" height="6" rx="1.2"/></svg>';
      case 'app':
        return '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M11 3L5 11h5l-1 6 6-8h-5l1-6z"/></svg>';
      case 'clipboard':
        return '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="4.5" width="10" height="12.5" rx="1.8"/><path d="M7.5 4.5V3.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1"/></svg>';
      case 'monitor':
        return '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="3.5" width="15" height="10" rx="1.6"/><path d="M7 16.5h6M10 13.5v3"/></svg>';
      case 'audio':
        return '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5L5.5 8H3v4h2.5L9 15V5z"/><path d="M12.5 7.5a3.5 3.5 0 0 1 0 5"/></svg>';
      case 'security':
      default:
        return '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2.5L4 5v4.5c0 4 2.6 7 6 8 3.4-1 6-4 6-8V5l-6-2.5z"/></svg>';
    }
  }

  function renderAuditLogModal() {
    const listEl = document.getElementById('auditLogTimeline');
    const countEl = document.getElementById('auditLogCountCaption');
    if (!listEl) return;

    let items = [];
    try {
      const raw = localStorage.getItem(AUDIT_LOG_STORAGE_KEY);
      items = raw ? JSON.parse(raw) : [];
    } catch { items = []; }

    if (countEl) countEl.textContent = `${items.length} kayıt`;

    if (!items.length) {
      listEl.innerHTML = `
        <div class="sub-panel" style="text-align: center; padding: 32px 16px;">
          <p class="section-subtitle">Henüz bir denetim kaydı bulunmuyor.</p>
          <span class="mono-caption">Cihaz bağlantıları, kilit ve güç işlemleri burada zaman damgasıyla listelenir.</span>
        </div>
      `;
      return;
    }

    listEl.innerHTML = items
      .map((it) => {
        const typeKey = it.type || 'connect';
        return `
          <div class="audit-log-item">
            <div class="audit-icon-box icon-${escapeHtml(typeKey)}">
              ${getAuditIconSvg(typeKey)}
            </div>
            <div class="audit-content">
              <div class="audit-title-row">
                <span class="audit-msg">${escapeHtml(it.message)}</span>
                <span class="audit-time">${it.dateStr} ${it.timeStr}</span>
              </div>
              <div class="audit-device-badge">
                <span>${escapeHtml(it.deviceName || 'PC')}</span>
                ${it.details && it.details.route ? ` · <span class="mono-caption">${escapeHtml(it.details.route)}</span>` : ''}
              </div>
            </div>
          </div>
        `;
      })
      .join('');
  }

  function clearRemoteScreenFrameBuffer() {
    state.hasReceivedFrameOnce = false;
    remoteRender.queue = [];
    remoteRender.cursorVisible = false;
    resetVideoDecoder();
    const canvas = getRemoteCanvas();
    if (canvas) {
      // Resizing wipes the previous PC's picture so it never flashes on another device
      canvas.width = 16;
      canvas.height = 9;
      remoteRender.ctx = null;
      canvas.classList.add('hidden');
    }
    updateVirtualCursorVisual();
    const placeholder = document.getElementById('remotePlaceholder');
    if (placeholder) {
      placeholder.classList.remove('hidden');
    }
  }

  function resetActiveDeviceWorkspaceState(targetDeviceId) {
    if (state.isStreaming && state.ws && state.ws.readyState === WebSocket.OPEN) {
      try {
        state.ws.send(JSON.stringify({ id: state.reqSeq++, action: 'stop_stream', params: {} }));
      } catch {}
    }
    disconnectWebSocket();
    clearRemoteScreenFrameBuffer();

    state.remoteMonitorIndex = 0;
    state.zoomScale = 1.0;
    state.panX = 0;
    state.panY = 0;
    applyStageZoomAndPan();

    state.monitors = [];
    state.windows = [];
    state.scenes = [];
    state.macros = [];
    state.quickActions = [];
    state.installedApps = [];
    state.customApps = [];
    state.clipboardHistory = [];
    state.fsEntries = [];
    state.fsCurrentPath = '';
    state.fsParentPath = '';
    state.audio = { masterVolume: 100, masterMuted: false, sessions: [] };
    state.stats = { cpuPercent: 0, memoryPercent: 0, usedRamGb: 0, totalRamGb: 0, isLocked: false };
    state.isPcLocked = false;
    state.powerTimer = { active: false, mode: 'sleep', targetTs: 0, remainingSec: 0 };

    if (targetDeviceId) {
      loadWorkspaceCache(targetDeviceId);
    }

    updateStreamUiState();
    renderLockStateUi();
    renderAllConnectedViews();
    syncAndroidMediaNotification();
  }

  function getClientIdentity() {
    let clientId = '';
    try {
      clientId = localStorage.getItem('tahablt_client_id') || '';
      if (!clientId) {
        clientId = 'mob_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
        localStorage.setItem('tahablt_client_id', clientId);
      }
    } catch {}
    let clientName = '';
    try {
      if (window.TahaNative && typeof window.TahaNative.getClientDeviceName === 'function') {
        clientName = String(window.TahaNative.getClientDeviceName() || '').trim();
      }
    } catch {}
    if (!clientName) {
      const ua = navigator.userAgent || '';
      const m = ua.match(/Android\s+[\d.]+;\s*([^;)]+?)(?:\s+Build\/|\))/i);
      if (m && m[1] && m[1].trim() !== 'K') {
        clientName = m[1].trim();
      } else {
        clientName = 'Android Telefon';
      }
    }
    return { clientId, clientName };
  }

  function upsertDevice(dev) {
    const prevActiveId = state.activeDeviceId;
    const idx = state.devices.findIndex((d) => d.deviceId === dev.deviceId);
    const merged = idx >= 0 ? { ...state.devices[idx], ...dev } : { ...dev };
    if (merged.authToken) {
      merged.connectionRevoked = false;
      merged.revokedAt = 0;
    }
    if (idx >= 0) {
      state.devices[idx] = merged;
    } else {
      state.devices.push(merged);
    }
    state.activeDeviceId = dev.deviceId;
    if (prevActiveId && prevActiveId !== dev.deviceId) {
      resetActiveDeviceWorkspaceState(dev.deviceId);
    }
    saveDevicesToStorage();
    syncConnectionViewState();
    renderSavedDevicesList();
  }

  function removeDevice(deviceId) {
    state.devices = state.devices.filter((d) => d.deviceId !== deviceId);
    try {
      localStorage.removeItem(`${STORAGE_WORKSPACE_CACHE_KEY}_${deviceId}`);
    } catch {}
    const wasActive = state.activeDeviceId === deviceId;
    if (wasActive) {
      state.activeDeviceId = state.devices.length ? state.devices[0].deviceId : null;
      resetActiveDeviceWorkspaceState(state.activeDeviceId);
    }
    saveDevicesToStorage();
    stopBootWatcher();
    if (wasActive) {
      disconnectWebSocket();
    }
    syncConnectionViewState();
    renderSavedDevicesList();
    if (state.activeDeviceId) {
      if (wasActive || !state.isAuthenticated) {
        connectToActiveDevice();
      }
    } else {
      scanNetworkForDevices();
    }
  }

  function syncAndroidNavBarColor() {
    try {
      const bottomNav = document.getElementById('bottomNav');
      const hubBottomNav = document.getElementById('hubBottomNav');
      const modalOpen = document.body.classList.contains('modal-open');
      const navVisible =
        (bottomNav && !bottomNav.classList.contains('hidden')) ||
        (hubBottomNav && !hubBottomNav.classList.contains('hidden'));
      const targetHex = modalOpen || navVisible ? '#121216' : '#09090B';
      if (window.TahaNative && typeof window.TahaNative.setNavBarColor === 'function') {
        window.TahaNative.setNavBarColor(targetHex);
      }
    } catch {}
  }

  function saveWorkspaceCache() {
    try {
      const dev = getActiveDevice();
      if (!dev || !dev.deviceId) return;
      const snapshot = {
        deviceId: dev.deviceId,
        monitors: state.monitors,
        scenes: state.scenes,
        macros: state.macros,
        quickActions: state.quickActions,
        customApps: state.customApps,
        installedApps: (state.installedApps || []).slice(0, 120)
      };
      localStorage.setItem(`${STORAGE_WORKSPACE_CACHE_KEY}_${dev.deviceId}`, JSON.stringify(snapshot));
    } catch {}
  }

  function loadWorkspaceCache(targetDeviceId) {
    try {
      const devId = targetDeviceId || state.activeDeviceId || (getActiveDevice() && getActiveDevice().deviceId);
      if (!devId) return false;
      const raw = localStorage.getItem(`${STORAGE_WORKSPACE_CACHE_KEY}_${devId}`);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || (parsed.deviceId && parsed.deviceId !== devId)) return false;
      if (Array.isArray(parsed.monitors) && parsed.monitors.length) state.monitors = parsed.monitors;
      if (Array.isArray(parsed.scenes)) state.scenes = parsed.scenes;
      if (Array.isArray(parsed.macros)) state.macros = parsed.macros;
      if (Array.isArray(parsed.quickActions)) state.quickActions = parsed.quickActions;
      if (Array.isArray(parsed.customApps)) state.customApps = parsed.customApps;
      if (Array.isArray(parsed.installedApps)) state.installedApps = parsed.installedApps;
      return true;
    } catch {
      return false;
    }
  }

  // STRICT VIEW CONTROLLER: Show device controls when connected or during initial instant handshake
  function syncConnectionViewState() {
    const dev = getActiveDevice();
    renderFunctionPrefs();
    const hubView = document.getElementById('view-device-hub');
    const offlineView = document.getElementById('view-device-offline');
    const connectedView = document.getElementById('view-connected-workspace');
    const bottomNav = document.getElementById('bottomNav');
    const hubBottomNav = document.getElementById('hubBottomNav');
    const homeBtn = document.getElementById('homeHubBtn');

    renderDeviceTopBar();

    const isRevoked = Boolean(dev && (dev.connectionRevoked || !dev.authToken));
    if (homeBtn) {
      homeBtn.classList.toggle('active', Boolean(!dev || state.showingHubView || isRevoked));
    }

    if (!dev || state.showingHubView || isRevoked) {
      hubView.classList.remove('hidden');
      offlineView.classList.add('hidden');
      connectedView.classList.add('hidden');
      bottomNav.classList.add('hidden');
      if (hubBottomNav) hubBottomNav.classList.remove('hidden');
      renderSavedDevicesList();
      syncAndroidNavBarColor();
      return;
    }

    if (!state.isAuthenticated && !state.isInitialConnecting && !state.isReconnecting) {
      hubView.classList.add('hidden');
      offlineView.classList.remove('hidden');
      connectedView.classList.add('hidden');
      bottomNav.classList.add('hidden');
      if (hubBottomNav) hubBottomNav.classList.remove('hidden');

      document.getElementById('offlineDeviceTitle').textContent = dev.deviceName || dev.lanIp;
      document.getElementById('offlineDeviceMac').textContent = dev.macAddress
        ? `MAC: ${dev.macAddress}`
        : `IP: ${dev.lanIp || '--'}`;
      syncAndroidNavBarColor();
      return;
    }

    stopBootWatcher();
    hubView.classList.add('hidden');
    offlineView.classList.add('hidden');
    connectedView.classList.remove('hidden');
    bottomNav.classList.remove('hidden');
    if (hubBottomNav) hubBottomNav.classList.add('hidden');
    syncAndroidNavBarColor();
  }

  // WEBSOCKET CONNECTION & ZERO-DROP AUTO-RECONNECT ENGINE
  function closeSocketOnly() {
    clearInterval(state.pingTimer);
    if (state.ws) {
      try {
        state.ws.onclose = null;
        state.ws.onerror = null;
        state.ws.onmessage = null;
        state.ws.close();
      } catch {}
      state.ws = null;
    }
    for (const [, pending] of state.pendingReqs.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Bağlantı yenileniyor'));
    }
    state.pendingReqs.clear();
  }

  function disconnectWebSocket() {
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    closeSocketOnly();
    state.isAuthenticated = false;
    state.wasAuthenticatedOnce = false;
    state.isReconnecting = false;
    state.reconnectAttempts = 0;
    state.connectedRoute = null;
    state.latencyMs = null;
    state.isStreaming = false;
    state.isLeftButtonHeld = false;
    updateDragHoldUi();
    updateStreamUiState();
  }

  function scheduleSilentReconnect() {
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    const dev = getActiveDevice();
    if (!dev) return;

    if (!dev.authToken) return; // needs a new pairing code, retrying would only be rejected
    state.reconnectAttempts++;
    const delays = [150, 600, 1400, 2600, 3800, 5000, 6000, 8000, 10000, 15000, 20000, 30000];
    const delayMs = delays[Math.min(state.reconnectAttempts - 1, delays.length - 1)];

    // Keep user in the Connected Workspace during the first 4 fast recovery attempts (Zero-Drop Grace Period)
    if (state.wasAuthenticatedOnce && state.reconnectAttempts <= 4) {
      state.isReconnecting = true;
      renderDeviceTopBar();
    } else {
      state.isReconnecting = false;
      state.isAuthenticated = false;
      state.connectedRoute = null;
      syncConnectionViewState();
    }

    state.reconnectTimer = setTimeout(async () => {
      state.reconnectTimer = null;
      if (state.ws && state.ws.readyState === WebSocket.OPEN) return;
      const ok = await connectToActiveDevice(true);
      if (!ok && getActiveDevice()) {
        scheduleSilentReconnect();
      }
    }, delayMs);
  }

  function tryOpenSocketUrl(wsUrl, routeLabel, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!wsUrl) return reject(new Error('Invalid URL'));
      let settled = false;
      let sock;
      try {
        sock = new WebSocket(wsUrl);
        sock.binaryType = 'arraybuffer';
      } catch (e) {
        return reject(e);
      }

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { sock.close(); } catch {}
          reject(new Error('Timeout'));
        }
      }, timeoutMs);

      sock.onopen = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ sock, routeLabel, wsUrl });
        }
      };

      sock.onerror = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          try { sock.close(); } catch {}
          reject(new Error('Socket error'));
        }
      };
    });
  }

  // NON-BLOCKING ASYNC NATIVE BRIDGE & PARALLEL HTTP ENGINE (ZERO UI FREEZE)
  const nativeAsyncCallbacks = new Map();
  let nativeAsyncSeq = 1;

  window.__onNativeAsyncCallback = function (cbId, payloadStr) {
    const entry = nativeAsyncCallbacks.get(cbId);
    if (!entry) return;
    nativeAsyncCallbacks.delete(cbId);
    clearTimeout(entry.timer);
    entry.resolve(payloadStr);
  };

  function callNativeAsync(methodName, args = [], timeoutMs = 2500) {
    return new Promise((resolve) => {
      if (!window.TahaNative || typeof window.TahaNative[methodName] !== 'function') {
        resolve('');
        return;
      }
      const cbId = `cb_${Date.now()}_${nativeAsyncSeq++}`;
      const timer = setTimeout(() => {
        if (nativeAsyncCallbacks.has(cbId)) {
          nativeAsyncCallbacks.delete(cbId);
          resolve('');
        }
      }, timeoutMs);
      nativeAsyncCallbacks.set(cbId, { resolve, timer });
      try {
        window.TahaNative[methodName](cbId, ...args);
      } catch {
        clearTimeout(timer);
        nativeAsyncCallbacks.delete(cbId);
        resolve('');
      }
    });
  }

  async function asyncHttpPostJson(url, bodyStr, timeoutMs = 2000) {
    const fetchPromise = (async () => {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: bodyStr,
          signal: controller.signal
        });
        clearTimeout(t);
        const data = await resp.json().catch(() => null);
        if (data && typeof data === 'object') {
          data._httpStatus = resp.status;
          return data;
        }
      } catch {
        clearTimeout(t);
      }
      return null;
    })();

    if (window.TahaNative && typeof window.TahaNative.httpPostAsync === 'function') {
      const nativePromise = callNativeAsync('httpPostAsync', [url, bodyStr, timeoutMs], timeoutMs + 600).then((raw) => {
        try {
          return raw ? JSON.parse(raw) : null;
        } catch {
          return null;
        }
      });
      const first = await Promise.race([fetchPromise, nativePromise]);
      if (first && first.ok) return first;
      const [a, b] = await Promise.all([fetchPromise, nativePromise]);
      if (a && a.ok) return a;
      if (b && b.ok) return b;
      if (a && (a._httpStatus === 401 || a.httpStatus === 401)) return a;
      if (b && (b._httpStatus === 401 || b.httpStatus === 401)) return b;
      return a || b || null;
    }

    return fetchPromise;
  }

  async function nativeDiscoverDevicesAsync() {
    if (window.TahaNative && typeof window.TahaNative.discoverDevicesAsync === 'function') {
      const raw = await callNativeAsync('discoverDevicesAsync', [], 2400);
      try {
        const parsed = JSON.parse(raw || '[]');
        if (Array.isArray(parsed)) return parsed;
      } catch {}
    }
    return [];
  }

  async function verifyDirectHostDeviceId(ip, port, expectedDeviceId, timeoutMs) {
    if (!expectedDeviceId) return true;
    const discUrl = `http://${ip}:${port}/api/discover`;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), Math.min(timeoutMs || 1100, 1100));
    try {
      const resp = await fetch(discUrl, { signal: controller.signal });
      clearTimeout(t);
      if (!resp.ok) return false;
      const info = await resp.json().catch(() => null);
      if (info && info.deviceId) {
        return info.deviceId === expectedDeviceId;
      }
    } catch {
      clearTimeout(t);
      if (window.TahaNative && typeof window.TahaNative.httpGetAsync === 'function') {
        try {
          const raw = await callNativeAsync('httpGetAsync', [discUrl, 900], 1100);
          if (raw) {
            const info = JSON.parse(raw);
            if (info && info.deviceId) {
              return info.deviceId === expectedDeviceId;
            }
          }
        } catch {}
      }
    }
    // If multiple devices are saved, require positive deviceId confirmation on LAN so two PCs sharing a virtual IP (e.g. 192.168.137.1) never cross-connect
    return state.devices.length <= 1;
  }

  function raceDirectSocketRoutes(dev, timeoutMs) {
    const port = dev.port || 4850;
    const seenUrls = new Set();
    const candidates = [];

    const addCandidate = (ip, label) => {
      if (!ip || ip === '-') return;
      const wsUrl = `ws://${ip}:${port}`;
      if (seenUrls.has(wsUrl)) return;
      seenUrls.add(wsUrl);
      candidates.push({ ip, port, wsUrl, routeLabel: label });
    };

    addCandidate(dev.lanIp, 'YEREL AĞ');
    if (Array.isArray(dev.lanIps)) {
      dev.lanIps.forEach((ip) => addCandidate(ip, 'YEREL AĞ'));
    }
    addCandidate(dev.tailscaleIp, 'DOĞRUDAN P2P');

    if (!candidates.length) return Promise.resolve(null);

    return new Promise((resolve) => {
      let winner = null;
      let remaining = candidates.length;
      const openSockets = [];

      const onCandFailed = () => {
        remaining--;
        if (remaining === 0 && !winner) {
          resolve(null);
        }
      };

      candidates.forEach((cand) => {
        Promise.all([
          tryOpenSocketUrl(cand.wsUrl, cand.routeLabel, timeoutMs),
          verifyDirectHostDeviceId(cand.ip, cand.port, dev.deviceId, timeoutMs)
        ])
          .then(([res, idMatched]) => {
            if (!idMatched) {
              try { res.sock.close(); } catch {}
              onCandFailed();
              return;
            }
            if (!winner) {
              winner = res;
              openSockets.forEach((s) => {
                if (s !== res.sock) {
                  try { s.close(); } catch {}
                }
              });
              resolve(res);
            } else {
              try { res.sock.close(); } catch {}
            }
          })
          .catch(() => {
            onCandFailed();
          });
      });
    });
  }

  const wanSyncCache = new Map();

  // HMAC-SHA256 over byte strings (sha256HexAscii works on chars 0-255)
  function hmacSha256Hex(keyStr, msgStr) {
    let key = unescape(encodeURIComponent(String(keyStr)));
    const msg = unescape(encodeURIComponent(String(msgStr)));
    if (key.length > 64) key = hexToByteString(sha256HexAscii(key));
    while (key.length < 64) key += '\x00';
    let ipad = '';
    let opad = '';
    for (let i = 0; i < 64; i++) {
      ipad += String.fromCharCode(key.charCodeAt(i) ^ 0x36);
      opad += String.fromCharCode(key.charCodeAt(i) ^ 0x5c);
    }
    return sha256HexAscii(opad + hexToByteString(sha256HexAscii(ipad + msg)));
  }

  function hexToByteString(hex) {
    let out = '';
    for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
    return out;
  }

  function isTryCloudflareUrl(url) {
    return /^https:\/\/[a-z0-9-]+\.trycloudflare\.com\/?$/i.test(String(url || ''));
  }

  // ntfy.sh topics are public: anyone can post a fake endpoint. Only updates signed by the PC with the key it
  // gave this phone at pairing (or, for pairing-code topics, keyed by the code) are followed.
  function isTrustedWanSync(msg, key) {
    if (!msg || typeof msg !== 'object') return false;
    if (msg.tunnelUrl && !isTryCloudflareUrl(msg.tunnelUrl)) return false;
    if (!key) return true; // paired before signing existed; the key arrives on the next LAN connection
    if (!msg.sig) return false;
    const canonical = [msg.deviceId || '', msg.tunnelUrl || '', (Array.isArray(msg.lanIps) ? msg.lanIps : []).join(','), msg.tailscaleIp || '', msg.ts].join('|');
    return hmacSha256Hex(key, canonical) === String(msg.sig).toLowerCase();
  }

  function sanitizeWanSync(msg, key) {
    if (!isTrustedWanSync(msg, key)) return null;
    // wsTunnelUrl is not covered by the signature; always derive it
    if (msg.tunnelUrl) msg.wsTunnelUrl = msg.tunnelUrl.replace(/^https:/i, 'wss:');
    return msg;
  }

  function parseNtfyLinesToSyncObj(text, key) {
    if (!text) return null;
    const lines = text.trim().split('\n');
    let latest = null;
    let latestWithTunnel = null;
    const recentTunnels = [];
    for (const line of lines) {
      try {
        const evt = JSON.parse(line);
        if (evt.event === 'message' && evt.message && evt.message.includes('TAHABLT_WAN_SYNC')) {
          const parsedMsg = sanitizeWanSync(JSON.parse(evt.message), key);
          if (!parsedMsg) continue;
          latest = parsedMsg;
          if (parsedMsg.tunnelUrl) {
            latestWithTunnel = parsedMsg;
            const idx = recentTunnels.indexOf(parsedMsg.tunnelUrl);
            if (idx >= 0) recentTunnels.splice(idx, 1);
            recentTunnels.push(parsedMsg.tunnelUrl);
          }
        }
      } catch {}
    }
    const chosen = latestWithTunnel || latest;
    if (!chosen) return null;
    if (latest && chosen !== latest) {
      if (latest.lanIp) chosen.lanIp = latest.lanIp;
      if (Array.isArray(latest.lanIps)) chosen.lanIps = latest.lanIps;
      if (latest.tailscaleIp) chosen.tailscaleIp = latest.tailscaleIp;
    }
    if (recentTunnels.length) {
      chosen.recentTunnelUrls = recentTunnels.slice(-3).reverse();
    }
    return chosen;
  }

  async function fetchWanSyncInfo(syncTopic, forceFresh = false, verifyKey = '') {
    if (!syncTopic) return null;
    const now = Date.now();
    const cached = wanSyncCache.get(syncTopic);
    if (!forceFresh && cached && now - cached.ts < 12000) {
      return cached.data;
    }

    const ntfyUrl = `https://ntfy.sh/${encodeURIComponent(syncTopic)}/json?poll=1&since=12h`;

    const browserPromise = (async () => {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 5200);
      try {
        const resp = await fetch(ntfyUrl, {
          signal: controller.signal
        });
        clearTimeout(t);
        if (!resp.ok) return null;
        const text = await resp.text();
        return parseNtfyLinesToSyncObj(text, verifyKey);
      } catch {
        clearTimeout(t);
        return null;
      }
    })();

    const nativePromise = (async () => {
      if (window.TahaNative && typeof window.TahaNative.resolveWanSyncAsync === 'function') {
        const raw = await callNativeAsync('resolveWanSyncAsync', [syncTopic], 5400);
        try {
          const parsed = sanitizeWanSync(JSON.parse(raw || '{}'), verifyKey);
          if (parsed && (parsed.tunnelUrl || parsed.lanIp)) return parsed;
        } catch {}
      }
      if (window.TahaNative && typeof window.TahaNative.httpGetAsync === 'function') {
        const rawText = await callNativeAsync('httpGetAsync', [ntfyUrl, 5000], 5400);
        if (rawText) {
          const parsed = parseNtfyLinesToSyncObj(rawText, verifyKey);
          if (parsed && (parsed.tunnelUrl || parsed.lanIp)) return parsed;
        }
      }
      return null;
    })();

    let result = await Promise.race([browserPromise, nativePromise]);
    if (!result || (!result.tunnelUrl && !result.lanIp)) {
      const [bRes, nRes] = await Promise.all([browserPromise, nativePromise]);
      result = (bRes && bRes.tunnelUrl ? bRes : null) || (nRes && nRes.tunnelUrl ? nRes : null) || bRes || nRes || null;
    }

    if (result) {
      wanSyncCache.set(syncTopic, { ts: Date.now(), data: result });
    }
    return result;
  }

  let connectInFlightPromise = null;
  let connectInFlightDeviceId = null;

  async function connectToActiveDevice(silentReconnect) {
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }

    const dev = getActiveDevice();
    if (!dev) return false;
    if (dev.connectionRevoked || !dev.authToken) {
      state.isInitialConnecting = false;
      state.isReconnecting = false;
      state.isAuthenticated = false;
      state.showingHubView = true;
      syncConnectionViewState();
      return false;
    }

    // Never tear down an already open and authenticated socket during a background silent check
    if (silentReconnect && state.ws && state.ws.readyState === WebSocket.OPEN && state.isAuthenticated) {
      return true;
    }

    // Single-flight guard: avoid stacking overlapping connection attempts that cancel each other
    if (connectInFlightPromise && connectInFlightDeviceId === dev.deviceId) {
      return connectInFlightPromise;
    }

    connectInFlightDeviceId = dev.deviceId;
    connectInFlightPromise = (async () => {
      try {
        closeSocketOnly();
        if (!silentReconnect && !state.wasAuthenticatedOnce) {
          syncConnectionViewState();
        } else {
          renderDeviceTopBar();
        }

        let connected = null;

        // 1. Race direct LAN Wi-Fi / USB Tethering / Hotspot + direct Tailscale P2P first (1-5ms latency)
        connected = await raceDirectSocketRoutes(dev, 1250);

        // 2. If direct LAN didn't answer immediately, race LAN Discovery + Cached Tunnel + WAN Sync in parallel without blocking LAN behind a 5.6s tunnel timeout!
        if (!connected) {
          let settledWinner = null;
          const claimWinner = (cand) => {
            if (!cand || !cand.sock) return null;
            if (!settledWinner) {
              settledWinner = cand;
              return cand;
            }
            try {
              cand.sock.close();
            } catch {}
            return settledWinner;
          };

          const lanDiscoveryBranch = (async () => {
            try {
              const discList = await nativeDiscoverDevicesAsync();
              if (settledWinner) return null;
              if (Array.isArray(discList)) {
                const match = discList.find((item) => item && item.deviceId === dev.deviceId);
                if (match) {
                  if (match.lanIp) dev.lanIp = match.lanIp;
                  if (Array.isArray(match.lanIps)) dev.lanIps = match.lanIps;
                  if (match.tailscaleIp && match.tailscaleIp !== '-') dev.tailscaleIp = match.tailscaleIp;
                  if (match.subnetBroadcast) dev.subnetBroadcast = match.subnetBroadcast;
                  if (Array.isArray(match.subnetBroadcasts)) dev.subnetBroadcasts = match.subnetBroadcasts;
                  if (match.macAddress) dev.macAddress = match.macAddress;
                  if (Array.isArray(match.macAddresses)) dev.macAddresses = match.macAddresses;
                  if (match.tunnelUrl) dev.tunnelUrl = match.tunnelUrl;
                  if (match.wsTunnelUrl) dev.wsTunnelUrl = match.wsTunnelUrl;
                  if (match.syncTopic) dev.syncTopic = match.syncTopic;
                  saveDevicesToStorage();
                  const directHit = await raceDirectSocketRoutes(dev, 1200);
                  if (directHit) return claimWinner(directHit);
                }
              }
            } catch {}
            return null;
          })();

          const cachedTunnelBranch = (async () => {
            if (dev.wsTunnelUrl || dev.tunnelUrl) {
              const wsTunnel = dev.wsTunnelUrl || dev.tunnelUrl.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
              try {
                const tunHit = await tryOpenSocketUrl(wsTunnel, 'MOBİL TÜNEL', 5200);
                if (tunHit) return claimWinner(tunHit);
              } catch {}
            }
            return null;
          })();

          const wanSyncBranch = (async () => {
            if (!dev.syncTopic) return null;
            try {
              // Always read the latest endpoint: after a PC restart the cached tunnel URL is dead
              const synced = await fetchWanSyncInfo(dev.syncTopic, true, dev.syncKey || '');
              if (settledWinner || !synced) return null;
              if (synced.lanIp) dev.lanIp = synced.lanIp;
              if (Array.isArray(synced.lanIps)) dev.lanIps = synced.lanIps;
              if (synced.tailscaleIp && synced.tailscaleIp !== '-') dev.tailscaleIp = synced.tailscaleIp;
              if (synced.tunnelUrl) {
                dev.tunnelUrl = synced.tunnelUrl;
                dev.wsTunnelUrl = synced.tunnelUrl.replace(/^https:/i, 'wss:');
              }
              if (Array.isArray(synced.recentTunnelUrls)) {
                dev.recentTunnelUrls = synced.recentTunnelUrls;
              }
              saveDevicesToStorage();

              const directHit = await raceDirectSocketRoutes(dev, 950);
              if (directHit) return claimWinner(directHit);

              if (!settledWinner && dev.wsTunnelUrl) {
                try {
                  const tunHit = await tryOpenSocketUrl(dev.wsTunnelUrl, 'MOBİL TÜNEL', 5500);
                  if (tunHit) return claimWinner(tunHit);
                } catch {}
              }
              if (!settledWinner && Array.isArray(dev.recentTunnelUrls)) {
                for (const rUrl of dev.recentTunnelUrls) {
                  if (settledWinner || !rUrl) break;
                  const wsCand = rUrl.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
                  if (wsCand === dev.wsTunnelUrl) continue;
                  try {
                    const fbHit = await tryOpenSocketUrl(wsCand, 'MOBİL TÜNEL', 4200);
                    if (fbHit) {
                      dev.tunnelUrl = rUrl;
                      dev.wsTunnelUrl = wsCand;
                      saveDevicesToStorage();
                      return claimWinner(fbHit);
                    }
                  } catch {}
                }
              }
            } catch {}
            return null;
          })();

          await Promise.all([lanDiscoveryBranch, cachedTunnelBranch, wanSyncBranch]);
          connected = settledWinner;
        }

        if (!connected) {
          state.isInitialConnecting = false;
          if (!state.wasAuthenticatedOnce || state.reconnectAttempts >= 4) {
            state.isAuthenticated = false;
            state.isReconnecting = false;
            state.connectedRoute = null;
            syncConnectionViewState();
          }
          return false;
        }

        state.ws = connected.sock;
        state.connectedRoute = connected.routeLabel;
        state.lastAliveTs = Date.now();
        setupSocketHandlers(state.ws, dev);
        return true;
      } finally {
        connectInFlightPromise = null;
        connectInFlightDeviceId = null;
      }
    })();

    return connectInFlightPromise;
  }

  function setupSocketHandlers(ws, dev) {
    ws.binaryType = 'arraybuffer';

    ws.onmessage = (event) => {
      if (state.ws !== ws || (dev && dev.deviceId && state.activeDeviceId !== dev.deviceId)) {
        return;
      }
      state.lastAliveTs = Date.now();
      // Fast-path: Raw Binary JPEG frame for 60 FPS Remote Desktop
      if (event.data instanceof ArrayBuffer || event.data instanceof Blob) {
        handleIncomingBinaryFrame(event.data);
        return;
      }

      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      if (typeof msg.id === 'number' && state.pendingReqs.has(msg.id)) {
        const pending = state.pendingReqs.get(msg.id);
        clearTimeout(pending.timer);
        state.pendingReqs.delete(msg.id);
        if (msg.ok) pending.resolve(msg.data);
        else pending.reject(new Error(msg.error || 'İşlem başarısız'));
        return;
      }

      if (msg.type === 'monitors_updated') {
        state.monitors = Array.isArray(msg.payload) ? msg.payload : [];
        renderDeviceTopBar();
        renderMonitorsTab();
        renderMonitorsBrightnessList();
        renderScenesList();
        renderRemoteMonitorPills();
        renderAppsTab();
      } else if (msg.type === 'windows_updated') {
        state.windows = Array.isArray(msg.payload) ? msg.payload : [];
        renderOpenWindowsList();
        renderAppsTab();
      } else if (msg.type === 'scenes_updated') {
        state.scenes = Array.isArray(msg.payload) ? msg.payload : [];
        renderScenesList();
      } else if (msg.type === 'macros_updated') {
        state.macros = Array.isArray(msg.payload) ? msg.payload : [];
        renderMacrosList();
      } else if (msg.type === 'quick_actions_updated') {
        state.quickActions = Array.isArray(msg.payload) ? msg.payload : [];
        renderQuickActionsList();
      } else if (msg.type === 'apps_updated' && msg.payload) {
        if (Array.isArray(msg.payload.installed)) state.installedApps = msg.payload.installed;
        if (Array.isArray(msg.payload.customApps)) state.customApps = msg.payload.customApps;
        renderAppsTab();
        renderScenesList();
        renderQuickActionsList();
      } else if (msg.type === 'audio_updated' && msg.payload) {
        state.audio = reconcileMediaIntent(msg.payload);
        state.lastMediaSyncWallTs = Date.now();
        renderAudioTab();
        syncAndroidMediaNotification();
      } else if (msg.type === 'lock_state_updated' && msg.payload) {
        state.isPcLocked = Boolean(msg.payload.isLocked);
        if (state.stats) state.stats.isLocked = state.isPcLocked;
        renderLockStateUi();
      } else if (msg.type === 'function_prefs_updated' && msg.payload) {
        state.functionPrefs = msg.payload;
        renderFunctionPrefs();
      } else if (msg.type === 'power_timer_updated') {
        state.powerTimer = msg.payload || { active: false };
        renderPowerTimerStatus();
      } else if (msg.type === 'tunnel_updated' && msg.payload) {
        const currentDev = getActiveDevice();
        if (currentDev && currentDev.deviceId === dev.deviceId) {
          upsertDevice({ ...currentDev, ...msg.payload });
        }
      } else if (msg.type === 'session_revoked') {
        if (state.reconnectTimer) {
          clearTimeout(state.reconnectTimer);
          state.reconnectTimer = null;
        }
        const activeDev = getActiveDevice();
        if (activeDev && activeDev.deviceId === dev.deviceId) {
          activeDev.authToken = '';
          activeDev.connectionRevoked = true;
          activeDev.revokedAt = Date.now();
          saveDevicesToStorage();
        }
        state.isAuthenticated = false;
        state.isInitialConnecting = false;
        state.isReconnecting = false;
        state.connectedRoute = null;
        state.showingHubView = true;
        logAuditEvent('security', 'Bilgisayar görev çubuğundan bağlantı sonlandırıldı');
        closeSocketOnly();
        syncConnectionViewState();
        renderSavedDevicesList();
        showToast('Bilgisayar üzerinden bu cihazın bağlantısı koparıldı');
        return;
      } else if (msg.type === 'screen_frame' && msg.payload && msg.payload.jpeg) {
        handleIncomingScreenFrame(msg.payload);
      } else if (msg.type === 'stream_stats' && msg.payload) {
        remoteStats.server = msg.payload;
      } else if (msg.type === 'stream_ended') {
        // Bridge restarted on the PC: resume shortly instead of leaving a frozen picture
        setTimeout(() => {
          if (state.isStreaming && state.activeTab === 'tab-remote' && state.ws === ws) startRemoteStream();
        }, 800);
      }
    };

    ws.onclose = () => {
      if (state.ws !== ws) {
        return;
      }
      state.ws = null;
      if (state.isAuthenticated) {
        logAuditEvent('disconnect', 'Bilgisayar bağlantısı kesildi');
      }
      clearInterval(state.pingTimer);
      state.isLeftButtonHeld = false;
      updateDragHoldUi();
      scheduleSilentReconnect();
    };

    sendCommand('auth', { authToken: dev.authToken, ...getClientIdentity() }, 9500)
      .then(async (res) => {
        if (state.ws !== ws || (dev && dev.deviceId && state.activeDeviceId !== dev.deviceId)) {
          return;
        }
        if (res && res.device && res.device.deviceId && dev.deviceId && res.device.deviceId !== dev.deviceId) {
          try { ws.close(); } catch {}
          throw new Error('Hedef cihaz kimliği uyuşmuyor');
        }
        const wasStreamingBefore = state.isStreaming;
        const firstAuthNow = !state.isAuthenticated;
        state.isAuthenticated = true;
        state.isInitialConnecting = false;
        state.wasAuthenticatedOnce = true;
        state.isReconnecting = false;
        state.reconnectAttempts = 0;
        state.consecutivePingFails = 0;
        state.lastAliveTs = Date.now();
        if (firstAuthNow) {
          logAuditEvent('connect', 'Bilgisayara bağlandı', { route: state.connectedRoute });
        }

        if (res && res.device) {
          upsertDevice({ ...dev, ...res.device });
        }
        state.monitors = Array.isArray(res.monitors) ? res.monitors : [];
        state.windows = Array.isArray(res.windows) ? res.windows : [];
        state.scenes = Array.isArray(res.scenes) ? res.scenes : [];
        state.macros = Array.isArray(res.macros) ? res.macros : [];
        state.quickActions = Array.isArray(res.quickActions) ? res.quickActions : [];
        if (Array.isArray(res.customApps)) state.customApps = res.customApps;
        if (res.audio) {
          state.audio = reconcileMediaIntent(res.audio);
          state.lastMediaSyncWallTs = Date.now();
        }
        if (res.stats) {
          state.stats = res.stats;
          if (typeof res.stats.isLocked === 'boolean') {
            state.isPcLocked = res.stats.isLocked;
          }
        }
        if (res.powerTimer) state.powerTimer = res.powerTimer;
        // Older PC agents do not know these preferences: keep the section disabled for them
        state.functionPrefs = res.functionPrefs || null;
        renderFunctionPrefs();

        saveWorkspaceCache();
        if (!state.showingHubView) {
          syncConnectionViewState();
          switchToTab(state.activeTab || 'tab-scenes', false);
        } else {
          renderSavedDevicesList();
        }
        renderAllConnectedViews();
        syncAndroidMediaNotification();
        ensureMediaTimelineTicker();
        measureLatency();
        clearInterval(state.pingTimer);
        state.pingTimer = setInterval(measureLatency, 3500);

        if (wasStreamingBefore && state.activeTab === 'tab-remote') {
          startRemoteStream();
        } else {
          state.isStreaming = false;
          state.hasReceivedFrameOnce = false;
          updateStreamUiState();
        }
        refreshWirelessStatus(true);

        // Fetch installed apps with real high-res icons in background
        try {
          const appRes = await sendCommand('get_installed_apps', {}, 9000);
          if (state.ws === ws && state.activeDeviceId === dev.deviceId && appRes && Array.isArray(appRes.installed) && appRes.installed.length > 0) {
            state.installedApps = appRes.installed;
            if (Array.isArray(appRes.customApps)) state.customApps = appRes.customApps;
            saveWorkspaceCache();
            renderAppsTab();
            renderScenesList();
            renderQuickActionsList();
            renderAudioTab();
            syncAndroidMediaNotification();
          }
        } catch {}
      })
      .catch((err) => {
        if (state.ws !== ws) return;
        const msg = String((err && err.message) || '');
        if (/Yetkisiz|süresi dolmuş|eşleştirmesi yapılmalı/i.test(msg)) {
          // The PC no longer knows this phone (sessions ended / token expired): retrying cannot succeed and only
          // trips the PC's rate limit, so stop and ask for a new pairing code
          handleRejectedSession(dev);
          return;
        }
        // Slow tunnel / socket replaced mid-handshake: drop this socket, the close handler retries with backoff
        try {
          ws.close();
        } catch {}
      });
  }

  function handleRejectedSession(dev) {
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    const activeDev = getActiveDevice();
    if (activeDev && dev && activeDev.deviceId === dev.deviceId) {
      activeDev.authToken = '';
      activeDev.connectionRevoked = true;
      activeDev.revokedAt = Date.now();
      saveDevicesToStorage();
    }
    closeSocketOnly();
    state.isAuthenticated = false;
    state.isInitialConnecting = false;
    state.wasAuthenticatedOnce = false;
    state.isReconnecting = false;
    state.connectedRoute = null;
    state.showingHubView = true;
    syncConnectionViewState();
    renderSavedDevicesList();
    showToast('Bu bilgisayarla bağlantı koparılmış. Görev çubuğundan yeni kod alıp tekrar eşleştirin.');
  }

  async function sendHttpCommandFallback(action, params = {}) {
    const dev = getActiveDevice();
    if (!dev || !dev.authToken) {
      throw new Error('Bilgisayar bağlantısı aktif değil');
    }

    const port = dev.port || 4850;
    const lanUrls = [];
    const seen = new Set();
    const pushLanUrl = (u) => {
      if (!u) return;
      const clean = u.replace(/\/+$/, '');
      if (!seen.has(clean)) {
        seen.add(clean);
        lanUrls.push(clean);
      }
    };

    if (dev.lanIp && dev.lanIp !== '-') pushLanUrl(`http://${dev.lanIp}:${port}`);
    if (Array.isArray(dev.lanIps)) {
      dev.lanIps.forEach((ip) => {
        if (ip && ip !== '-') pushLanUrl(`http://${ip}:${port}`);
      });
    }
    if (dev.tailscaleIp && dev.tailscaleIp !== '-') pushLanUrl(`http://${dev.tailscaleIp}:${port}`);

    const tunnelUrl = dev.tunnelUrl ? dev.tunnelUrl.replace(/\/+$/, '') : '';
    const payloadStr = JSON.stringify({
      authToken: dev.authToken,
      ...getClientIdentity(),
      action,
      params
    });

    const raceUrlGroup = (urls, timeoutMs) => {
      if (!urls.length) return Promise.resolve(undefined);
      return new Promise((resolve) => {
        let resolved = false;
        let remaining = urls.length;
        urls.forEach((base) => {
          asyncHttpPostJson(`${base}/api/command`, payloadStr, timeoutMs)
            .then((parsed) => {
              if (!resolved && parsed && parsed.ok) {
                resolved = true;
                resolve(parsed.data);
              } else {
                remaining--;
                if (remaining === 0 && !resolved) resolve(undefined);
              }
            })
            .catch(() => {
              remaining--;
              if (remaining === 0 && !resolved) resolve(undefined);
            });
        });
      });
    };

    // If not currently on Mobile Tunnel, try fast direct LAN first (1300ms) so we never send duplicate requests to both LAN and Tunnel
    if (state.connectedRoute !== 'MOBİL TÜNEL' && lanUrls.length) {
      const lanWin = await raceUrlGroup(lanUrls, 1300);
      if (lanWin !== undefined) return lanWin;
    }

    if (tunnelUrl) {
      const tunWin = await raceUrlGroup([tunnelUrl], 5500);
      if (tunWin !== undefined) return tunWin;
    }

    if (state.connectedRoute === 'MOBİL TÜNEL' && lanUrls.length) {
      const lanFallback = await raceUrlGroup(lanUrls, 1300);
      if (lanFallback !== undefined) return lanFallback;
    }

    throw new Error('Bilgisayar bağlantısı yenileniyor, lütfen tekrar dokunun');
  }

  const NON_IDEMPOTENT_ACTIONS = new Set([
    'run_scene',
    'launch_app',
    'run_quick_action',
    'run_single_item',
    'snapshot_scene',
    'save_scene',
    'delete_scene',
    'save_macro',
    'delete_macro',
    'run_macro',
    'save_quick_action',
    'delete_quick_action',
    'duplicate_quick_action',
    'save_custom_app',
    'delete_custom_app',
    'get_installed_apps',
    'get_full_state',
    'browse_fs',
    'capture_frame'
  ]);

  function sendCommand(action, params = {}, timeoutMs = 6000) {
    return new Promise((resolve, reject) => {
      const canFallbackHttp = action !== 'auth' && action !== 'ping' && action !== 'start_stream' && action !== 'stop_stream';

      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        let settled = false;
        const id = state.reqSeq++;
        let fastWatchdogTimer = null;

        const finishResolve = (val) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (fastWatchdogTimer) clearTimeout(fastWatchdogTimer);
          state.pendingReqs.delete(id);
          resolve(val);
        };

        const finishReject = (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (fastWatchdogTimer) clearTimeout(fastWatchdogTimer);
          state.pendingReqs.delete(id);
          reject(err);
        };

        const timer = setTimeout(() => {
          finishReject(new Error('Komut zaman aşımına uğradı'));
        }, timeoutMs);

        state.pendingReqs.set(id, {
          resolve: finishResolve,
          reject: finishReject,
          timer
        });

        try {
          state.ws.send(JSON.stringify({ id, action, params }));
        } catch {
          if (canFallbackHttp) {
            connectToActiveDevice(true).catch(() => {});
            sendHttpCommandFallback(action, params).then(finishResolve).catch(finishReject);
            return;
          }
        }

        // Idle Watchdog ONLY when socket has been idle (>5.5s) AND action is idempotent (never duplicate run_scene or launch_app!)
        const idleMs = Date.now() - (state.lastAliveTs || 0);
        if (canFallbackHttp && !NON_IDEMPOTENT_ACTIONS.has(action) && idleMs > 5500) {
          fastWatchdogTimer = setTimeout(() => {
            if (settled) return;
            sendHttpCommandFallback(action, params)
              .then((httpRes) => {
                finishResolve(httpRes);
                connectToActiveDevice(true).catch(() => {});
              })
              .catch(() => {});
          }, 260);
        }
        return;
      }

      if (!canFallbackHttp) {
        return reject(new Error('Bilgisayar bağlantısı aktif değil'));
      }

      // Auto-heal when phone wakes from sleep/idle: reconnect WebSocket AND fire stateless HTTP fallback immediately!
      connectToActiveDevice(true).catch(() => {});
      sendHttpCommandFallback(action, params).then(resolve).catch(reject);
    });
  }

  window.__onNativeAppResume = function () {
    const dev = getActiveDevice();
    if (!dev) return;
    const idleMs = Date.now() - (state.lastAliveTs || 0);
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN || idleMs > 5000) {
      connectToActiveDevice(true).catch(() => {});
    } else {
      measureLatency();
    }
  };

  function sendFastInput(params) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    if (params.type === 'mouse_move_rel' || params.type === 'mouse_move_abs') {
      // Numbered so frames can tell us when the PC has applied our last move (see cursor reconciliation)
      remoteRender.inputSeq = (remoteRender.inputSeq + 1) & 0xffff || 1;
      remoteRender.lastPointerSeq = remoteRender.inputSeq;
      params.seq = remoteRender.inputSeq;
    }
    try {
      state.ws.send(JSON.stringify({ id: 0, action: 'input_fast', params }));
    } catch {}
  }

  // fastFail: after the app comes back to the foreground or the network changes, a socket that still says OPEN
  // is often already dead; one missed ping is enough to reconnect instead of waiting ~10 s for three.
  async function measureLatency(fastFail = false) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    const t0 = performance.now();
    try {
      await sendCommand('ping', {}, 2200);
      state.consecutivePingFails = 0;
      state.latencyMs = Math.max(1, Math.round(performance.now() - t0));
      renderDeviceTopBar();

      // Auto-upgrade from trycloudflare (MOBİL TÜNEL) to Direct LAN / P2P if reachable
      state.pingCycleCount = (state.pingCycleCount || 0) + 1;
      if (state.connectedRoute === 'MOBİL TÜNEL' && state.pingCycleCount % 4 === 0) {
        const dev = getActiveDevice();
        if (dev) {
          const direct = await raceDirectSocketRoutes(dev, 650);
          if (direct && direct.sock) {
            try { direct.sock.close(); } catch {}
            connectToActiveDevice(true);
          }
        }
      }
    } catch {
      state.consecutivePingFails++;
      if ((fastFail || state.consecutivePingFails >= 3) && state.ws) {
        try {
          state.ws.close();
        } catch {}
      }
    }
  }

  function renderLockStateUi() {
    const locked = Boolean(state.isPcLocked);
    const quickLbl = document.getElementById('quickLockLabel');
    const quickIcon = document.getElementById('quickLockIcon');
    const powerTitle = document.getElementById('powerLockTitle');
    const powerSub = document.getElementById('powerLockSub');
    const powerIcon = document.getElementById('powerLockIcon');

    const lockPathHtml = locked
      ? `<rect x="4" y="9" width="12" height="8" rx="1.5" /><path d="M7 9V6.5a3 3 0 0 1 5.6-1.5" stroke-linecap="round" />`
      : `<rect x="4" y="9" width="12" height="8" rx="1.5" /><path d="M7 9V6.5a3 3 0 0 1 6 0V9" stroke-linecap="round" />`;

    if (quickLbl) quickLbl.textContent = locked ? 'Kilidi Aç' : 'Kilitle';
    if (quickIcon) quickIcon.innerHTML = lockPathHtml;
    if (powerTitle) powerTitle.textContent = locked ? 'Kilidi Aç' : 'Kilitle';
    if (powerSub) powerSub.textContent = locked ? 'Ekran kilidini aç' : 'Ekranları kilitle ve kapat';
    if (powerIcon) powerIcon.innerHTML = lockPathHtml;
  }

  // One lock button for every lock style: with the Windows lock the PC cannot be unlocked from the phone,
  // so the button stays "Kilitle" and the PC's own message is shown instead of a guessed one.
  function applyLockResult(res) {
    if (res && typeof res.isLocked === 'boolean') {
      state.isPcLocked = res.isLocked;
    } else {
      state.isPcLocked = !state.isPcLocked;
    }
    renderLockStateUi();
    const text = (res && res.message) || (state.isPcLocked ? 'Bilgisayar kilitlendi' : 'Bilgisayar kilidi açıldı');
    logAuditEvent(state.isPcLocked || (res && res.windowsLocked) ? 'lock' : 'unlock', text);
    showToast(text);
  }

  // Per-PC function preferences (stored on the PC itself)
  const FUNCTION_PREF_DEFS = [
    {
      key: 'lock',
      title: 'Kilitle',
      desc: 'Kilitle butonuna basınca ne olsun',
      options: [
        ['custom', 'Bridge kilit ekranı (telefondan açılır)'],
        ['windows', 'Windows kilidi (Win+L, PC şifresiyle açılır)'],
        ['both', 'İkisi birden (Windows kilidi + Bridge ekranı)']
      ]
    },
    {
      key: 'sleep',
      title: 'Uyku',
      desc: 'Uyku butonu ve uyku zamanlayıcısı',
      options: [
        ['sleep', 'Uyku modu'],
        ['hibernate', 'Hazırda beklet'],
        ['monitors_off', 'Sadece ekranları kapat (PC açık kalır)']
      ]
    },
    {
      key: 'shutdown',
      title: 'Kapat',
      desc: 'Bilgisayarı kapat komutu',
      options: [
        ['normal', 'Normal kapat'],
        ['force', 'Zorla kapat (açık uygulamaları bekleme)'],
        ['hybrid', 'Hızlı başlatma ile kapat']
      ]
    },
    {
      key: 'restart',
      title: 'Yeniden Başlat',
      desc: 'Yeniden başlat komutu',
      options: [
        ['normal', 'Normal yeniden başlat'],
        ['force', 'Zorla yeniden başlat']
      ]
    },
    {
      key: 'monitorsOff',
      title: 'Ekranları Kapat',
      desc: 'Ekranları kapat butonu',
      options: [
        ['power', 'Monitör sinyalini kes (uyku)'],
        ['blackout', 'Siyah perde (monitör açık, anında geri döner)']
      ]
    },
    {
      key: 'showDesktop',
      title: 'Masaüstü',
      desc: 'Masaüstü butonu',
      options: [
        ['win_d', 'Win+D (tekrar basınca pencereler geri gelir)'],
        ['win_m', 'Win+M (tüm pencereleri küçült)']
      ]
    },
    {
      key: 'media',
      title: 'Medya Tuşları',
      desc: 'Oynat/duraklat, ileri ve geri',
      options: [
        ['session', 'Ekranda görünen oynatıcıya gönder'],
        ['global', 'Klavye medya tuşu gibi (Windows hangisini seçerse)']
      ]
    }
  ];

  function renderFunctionPrefs() {
    const rowsEl = document.getElementById('functionPrefsRows');
    const subEl = document.getElementById('functionPrefsSubtitle');
    if (!rowsEl) return;
    const dev = getActiveDevice();
    const online = Boolean(state.isAuthenticated && state.functionPrefs && dev);
    if (subEl) {
      subEl.textContent = online
        ? `${dev.deviceName || 'Bu bilgisayar'} için geçerli; her bilgisayar kendi ayarlarını saklar`
        : 'Düzenlemek için bu bilgisayara bağlı olun';
    }
    const prefs = state.functionPrefs || {};
    rowsEl.classList.toggle('is-disabled', !online);
    rowsEl.innerHTML = FUNCTION_PREF_DEFS.map(
      (def) => `
        <div class="function-pref-row">
          <div class="setting-meta">
            <span class="setting-title">${escapeHtml(def.title)}</span>
            <span class="setting-desc">${escapeHtml(def.desc)}</span>
          </div>
          <select class="input-field" data-function-pref="${def.key}" ${online ? '' : 'disabled'}>
            ${def.options
              .map(([val, label]) => `<option value="${val}" ${prefs[def.key] === val ? 'selected' : ''}>${escapeHtml(label)}</option>`)
              .join('')}
          </select>
        </div>`
    ).join('');
  }

  async function saveFunctionPref(key, value) {
    const previous = state.functionPrefs ? state.functionPrefs[key] : undefined;
    state.functionPrefs = { ...(state.functionPrefs || {}), [key]: value };
    try {
      const res = await sendCommand('save_function_prefs', { prefs: { [key]: value } }, 5000);
      if (res && res.prefs) state.functionPrefs = res.prefs;
      showToast('Ayar bu bilgisayar için kaydedildi');
    } catch (err) {
      state.functionPrefs = { ...(state.functionPrefs || {}), [key]: previous };
      showToast(err.message || 'Ayar kaydedilemedi');
    }
    renderFunctionPrefs();
  }

  // RENDER FUNCTIONS
  function renderAllConnectedViews() {
    renderDeviceTopBar();
    renderSavedDevicesList();
    renderLockStateUi();
    renderQuickActionsList();
    renderScenesList();
    renderMacrosList();
    renderAppsTab();
    renderMonitorsTab();
    renderMonitorsBrightnessList();
    renderOpenWindowsList();
    renderRemoteMonitorPills();
    renderAudioTab();
    renderPowerTimerStatus();
    if (state.wirelessStatus) {
      renderWirelessStatus(state.wirelessStatus);
    } else if (state.isAuthenticated) {
      refreshWirelessStatus(true);
    }
  }

  function renderDeviceTopBar() {
    const dev = getActiveDevice();
    const dot = document.getElementById('connStatusDot');
    const nameEl = document.getElementById('activeDeviceName');
    const routeEl = document.getElementById('connRouteBadge');
    const latEl = document.getElementById('connLatencyBadge');
    const cpuEl = document.getElementById('cpuRamReadout');

    if (!dev) {
      if (dot) dot.setAttribute('data-state', 'offline');
      if (nameEl) nameEl.textContent = 'Bridge';
      if (routeEl) routeEl.textContent = 'HAZIR';
      if (latEl) latEl.textContent = 'Eşleştirin';
      return;
    }

    if (nameEl) nameEl.textContent = dev.deviceName || dev.lanIp;

    if (state.isReconnecting || state.isInitialConnecting) {
      if (dot) dot.setAttribute('data-state', 'connecting');
      if (routeEl) routeEl.textContent = state.isInitialConnecting ? 'BAĞLANIYOR...' : 'YENİDEN BAĞLANIYOR...';
      if (latEl) latEl.textContent = state.latencyMs !== null ? `${state.latencyMs} ms` : '...';
    } else if (state.isAuthenticated && state.connectedRoute) {
      if (dot) dot.setAttribute('data-state', state.connectedRoute === 'YEREL AĞ' ? 'online' : 'tailscale');
      const monCount = state.monitors.length || dev.monitorCount || 1;
      if (routeEl) routeEl.textContent = `${state.connectedRoute} · ${monCount} Ekran`;
      if (latEl) latEl.textContent = state.latencyMs !== null ? `${state.latencyMs} ms` : '1 ms';
    } else {
      if (dot) dot.setAttribute('data-state', 'offline');
      if (routeEl) routeEl.textContent = dev.authToken ? 'KAPALI / ÇEVRİMDIŞI' : 'Cihaz Eşleştirmesi İptal Edildi';
      if (latEl) latEl.textContent = dev.lanIp || '--';
    }

    if (cpuEl && state.stats) {
      const cpu = typeof state.stats.cpuPercent === 'number' ? state.stats.cpuPercent : 0;
      const ram = typeof state.stats.memoryPercent === 'number' ? state.stats.memoryPercent : 0;
      cpuEl.textContent = ram > 0 ? `CPU ${cpu}% · RAM ${ram}%` : `CPU ${cpu}%`;
    }
  }

  // TAB 1: QUICK ACTION BUTTONS, SCENES LIST & QUICK LAUNCHER
  function getAppMonogram(label) {
    const clean = String(label || 'APP')
      .replace(/\.[^/.]+$/, '')
      .trim();
    if (!clean) return 'AP';
    const parts = clean.split(/[\s._-]+/).filter(Boolean);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return clean.slice(0, 2).toUpperCase();
  }

  const SHARED_LAUNCHER_NAMES = new Set([
    'riotclientservices',
    'riotclientservices.exe',
    'steam',
    'steam.exe',
    'epicgameslauncher',
    'epicgameslauncher.exe',
    'update',
    'update.exe',
    'explorer',
    'explorer.exe',
    'cmd',
    'cmd.exe',
    'powershell',
    'powershell.exe',
    'pwsh',
    'pwsh.exe',
    'javaw',
    'javaw.exe'
  ]);

  function isSharedLauncherValue(val) {
    if (!val) return false;
    const base = String(val).toLowerCase().split(/[\\/]/).pop() || '';
    return SHARED_LAUNCHER_NAMES.has(base);
  }

  function findIconForItem(it) {
    if (!it) return '';
    if (it.icon && it.icon.startsWith('data:image/')) return it.icon;

    const appNameLower = String(it.appName || it.name || '').trim().toLowerCase();
    const pName = String(it.processName || '').trim().toLowerCase();
    const lPath = String(it.launchPath || it.exePath || it.targetPath || '').trim().toLowerCase();
    const lArgs = String(it.launchArgs || it.arguments || '').trim().toLowerCase();

    // 1. Exact appName match in installedApps (distinguishes Valorant vs LoL sharing RiotClientServices.exe)
    if (appNameLower) {
      for (const a of state.installedApps || []) {
        if (a.icon && a.name && a.name.trim().toLowerCase() === appNameLower) {
          return a.icon;
        }
      }
    }

    // 2. Exact launchPath + launchArgs match in installedApps
    if (lPath && lArgs) {
      for (const a of state.installedApps || []) {
        if (
          a.icon &&
          a.launchPath &&
          a.launchPath.trim().toLowerCase() === lPath &&
          String(a.launchArgs || '').trim().toLowerCase() === lArgs
        ) {
          return a.icon;
        }
      }
    }

    // 3. Open windows match (ignoring shared launchers by path/process unless title matches appName)
    for (const w of state.windows || []) {
      if (w.icon) {
        if (lPath && !isSharedLauncherValue(lPath) && w.exePath && w.exePath.toLowerCase() === lPath) return w.icon;
        if (pName && !isSharedLauncherValue(pName) && w.processName && w.processName.toLowerCase() === pName) return w.icon;
      }
    }

    // 4. Non-shared launchPath or processName match in installedApps
    for (const a of state.installedApps || []) {
      if (a.icon) {
        if (lPath && !isSharedLauncherValue(lPath) && a.launchPath && a.launchPath.toLowerCase() === lPath) return a.icon;
        if (
          pName &&
          !isSharedLauncherValue(pName) &&
          ((a.processName && a.processName.toLowerCase() === pName) || (a.name && a.name.toLowerCase() === pName))
        ) {
          return a.icon;
        }
      }
    }

    return '';
  }

  function renderAppIconHtml(iconDataUrl, label) {
    if (iconDataUrl && iconDataUrl.startsWith('data:image/')) {
      return `<img class="app-real-icon" src="${safeImageSrc(iconDataUrl)}" alt="${escapeHtml(label || '')}" loading="lazy" />`;
    }
    return `<span class="app-fallback-monogram">${escapeHtml(getAppMonogram(label))}</span>`;
  }

  function formatZoneShort(zone) {
    const map = {
      none: 'Varsayılan Konum',
      full: 'Tam Ekran',
      fullscreen: 'Tam Ekran',
      'left-half': 'Sol Yarı',
      'right-half': 'Sağ Yarı',
      center: 'Ortala',
      'top-half': 'Üst Yarı',
      'bottom-half': 'Alt Yarı',
      'top-left': 'Sol Üst',
      'top-right': 'Sağ Üst',
      'bottom-left': 'Sol Alt',
      'bottom-right': 'Sağ Alt'
    };
    return map[zone] || 'Özel Konum';
  }

  function formatTargetTypeBadge(t) {
    if (t === 'folder') return 'KLASÖR';
    if (t === 'app') return 'UYGULAMA';
    if (t === 'url') return 'WEB URL';
    if (t === 'macro') return 'MAKRO';
    if (t === 'scene') return 'SAHNE';
    if (t === 'system_action') return 'SİSTEM İŞLEVİ';
    return 'DOSYA';
  }

  function renderQuickActionIconInnerHtml(qa) {
    const items = Array.isArray(qa.items) ? qa.items : [];
    const first = items[0] || null;
    if (first) {
      const iconUrl = first.icon || findIconForItem(first);
      if (iconUrl && iconUrl.startsWith('data:image/')) {
        return `<img class="app-real-icon" src="${safeImageSrc(iconUrl)}" alt="${escapeHtml(qa.name || '')}" loading="lazy" />`;
      }
      if (first.targetType === 'macro') {
        return `
          <svg class="qa-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
            <rect x="3" y="4.5" width="18" height="15" rx="2.2" />
            <path d="M7.5 9.5l3 2.5-3 2.5M12.5 14.5H16.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        `;
      }
      if (first.targetType === 'scene') {
        return `
          <svg class="qa-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
            <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
            <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
            <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
            <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
          </svg>
        `;
      }
      if (first.targetType === 'system_action') {
        return `
          <svg class="qa-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
            <path d="M13 2.5L4.5 13.5h6.5l-1 8 8.5-11h-6.5l1-8z" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        `;
      }
      if (first.targetType === 'folder') {
        return `
          <svg class="qa-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
            <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.3l2 2.2H19.5A1.5 1.5 0 0 1 21 8.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5v-12z" stroke-linejoin="round" />
          </svg>
        `;
      }
      if (first.targetType === 'url') {
        return `
          <svg class="qa-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
            <circle cx="12" cy="12" r="8.5" />
            <path d="M3.8 12h16.4M12 3.5c2.4 2.5 3.7 5.5 3.7 8.5s-1.3 6-3.7 8.5c-2.4-2.5-3.7-5.5-3.7-8.5s1.3-6 3.7-8.5z" stroke-linecap="round" />
          </svg>
        `;
      }
      if (first.targetType === 'file') {
        return `
          <svg class="qa-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
            <path d="M6.5 3.5h7.5L18.5 8v12.5h-12V3.5z" stroke-linejoin="round" />
            <path d="M14 3.5V8h4.5M9 12.5h6M9 16h4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        `;
      }
    }
    return `<span class="app-fallback-monogram">${escapeHtml(getAppMonogram(qa.name))}</span>`;
  }

  function renderQuickActionsList() {
    const emptyEl = document.getElementById('quickActionsEmptyState');
    const listEl = document.getElementById('quickActionsListContainer');
    if (!emptyEl || !listEl) return;

    const list = Array.isArray(state.quickActions) ? state.quickActions : [];
    if (!list.length) {
      emptyEl.classList.remove('hidden');
      listEl.classList.add('hidden');
      listEl.innerHTML = '';
      return;
    }

    emptyEl.classList.add('hidden');
    listEl.classList.remove('hidden');

    listEl.innerHTML = list
      .map((qa) => {
        const items = Array.isArray(qa.items) ? qa.items : [];
        const badgeHtml = items.length > 1 ? `<span class="qa-count-badge">${items.length}</span>` : '';
        return `
          <button
            type="button"
            class="qa-icon-btn"
            data-qa-tile="${escapeHtml(qa.id)}"
            title="${escapeHtml(qa.name)} (Düzenlemek için basılı tutun)"
          >
            <div class="qa-icon-box">
              ${renderQuickActionIconInnerHtml(qa)}
              ${badgeHtml}
            </div>
            <span class="qa-icon-label">${escapeHtml(qa.name)}</span>
          </button>
        `;
      })
      .join('');
  }

  function renderScenesList() {
    const countBadge = document.getElementById('scenesNavCountBadge');
    if (countBadge) {
      const n = Array.isArray(state.scenes) ? state.scenes.length : 0;
      countBadge.textContent = `${n} Sahne`;
    }
    const emptyBox = document.getElementById('scenesEmptyState');
    const wfBox = document.getElementById('emptyWireframeMonitors');
    const listBox = document.getElementById('scenesListContainer');
    if (!emptyBox || !listBox) return;

    const connectedMonCount = Math.max(1, state.monitors.length || 1);
    if (wfBox) {
      const wfHtml = [];
      for (let i = 0; i < connectedMonCount; i++) {
        wfHtml.push(`
          <div class="wireframe-mon">
            <span class="wireframe-label">EKRAN ${i + 1}</span>
            <div class="wireframe-win"></div>
          </div>
        `);
      }
      wfBox.innerHTML = wfHtml.join('');
    }

    if (!state.scenes || state.scenes.length === 0) {
      emptyBox.classList.remove('hidden');
      listBox.classList.add('hidden');
      listBox.innerHTML = '';
      return;
    }

    emptyBox.classList.add('hidden');
    listBox.classList.remove('hidden');

    const monCount = Math.max(
      1,
      connectedMonCount,
      ...state.scenes.flatMap((s) => (s.items || []).map((i) => Number(i.monitorIndex || 0) + 1))
    );

    listBox.innerHTML = state.scenes
      .map((scene) => {
        const items = Array.isArray(scene.items) ? scene.items : [];
        const monitorsHtml = [];
        for (let m = 0; m < monCount; m++) {
          const monItems = items.filter((it) => Number(it.monitorIndex || 0) === m);
          const iconsHtml = monItems.length
            ? monItems
                .map((it) => {
                  const label = it.appName || it.processName || 'Uygulama';
                  const isMin = Boolean(
                    it.state === 'minimized' ||
                      it.windowStyle === 'minimized' ||
                      it.windowStyle === 'hidden'
                  );
                  const isBehind = Boolean(!isMin && it.isBackground);
                  const isBg = isMin || isBehind;
                  const badgeText = isMin ? 'SİMGE' : isBehind ? 'ARKA' : '';
                  const iconUrl = findIconForItem(it);
                  const statusLabel = isMin
                    ? 'Simge Durumunda'
                    : isBehind
                    ? `Arkada Açık (${ZONE_LABELS[it.zonePreset] || 'Tam Ekran'})`
                    : ZONE_LABELS[it.zonePreset] || 'Ön Planda';
                  const tip = `${label} · ${statusLabel}`;
                  return `
                    <div class="scene-app-icon-tile ${isBg ? 'is-bg' : ''}" title="${escapeHtml(tip)}">
                      ${renderAppIconHtml(iconUrl, label)}
                      ${badgeText ? `<span class="scene-bg-badge">${badgeText}</span>` : ''}
                    </div>
                  `;
                })
                .join('')
            : `<span class="scene-empty-mon-hint">Boş</span>`;

          monitorsHtml.push(`
            <div class="mini-monitor-frame">
              <div class="mini-monitor-top">
                <span class="mini-monitor-tag">EKRAN ${m + 1}</span>
              </div>
              <div class="scene-mon-icons-row">
                ${iconsHtml}
              </div>
            </div>
          `);
        }

        const bgCount = items.filter(
          (it) => it.isBackground || it.state === 'minimized' || it.windowStyle === 'minimized'
        ).length;
        const metaText = `${items.length} Uygulama${bgCount > 0 ? ` · ${bgCount} Arka Planda` : ''}`;

        return `
          <article class="scene-card" data-scene-id="${escapeHtml(scene.id)}">
            <div class="scene-card-top">
              <div>
                <h3 class="scene-card-title">${escapeHtml(scene.name)}</h3>
                <p class="scene-card-meta">${escapeHtml(metaText)}</p>
              </div>
              <div class="scene-card-actions">
                <button
                  type="button"
                  class="icon-action-btn"
                  data-prop-scene="${escapeHtml(scene.id)}"
                  title="Sahne Özellikleri"
                  aria-label="Sahne Özellikleri"
                >
                  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6">
                    <circle cx="10" cy="10" r="2.5" />
                    <path d="M10 3v2M10 15v2M3 10h2M15 10h2M5.05 5.05l1.4 1.4M13.55 13.55l1.4 1.4M14.95 5.05l-1.4 1.4M6.45 13.55l-1.4 1.4" stroke-linecap="round" />
                  </svg>
                </button>
                <button
                  type="button"
                  class="icon-action-btn"
                  data-edit-scene="${escapeHtml(scene.id)}"
                  title="Sahneyi Düzenle"
                  aria-label="Sahneyi Düzenle"
                >
                  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6">
                    <path d="M13.5 3.8a1.8 1.8 0 0 1 2.5 2.5L7.2 15.1 3.5 16l.9-3.7 9.1-8.5z" stroke-linejoin="round" />
                  </svg>
                </button>
                <button
                  type="button"
                  class="icon-action-btn danger"
                  data-delete-scene="${escapeHtml(scene.id)}"
                  title="Sahneyi Sil"
                  aria-label="Sahneyi Sil"
                >
                  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6">
                    <path d="M4.5 6h11M8 6V4.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1V6m-5.5 0l.6 9.5a1.5 1.5 0 0 0 1.5 1.4h2.8a1.5 1.5 0 0 0 1.5-1.4L13.5 6" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </button>
              </div>
            </div>
            <div class="scene-mini-monitors">
              ${monitorsHtml.join('')}
            </div>
            <button type="button" class="scene-run-btn" data-run-scene="${escapeHtml(scene.id)}">
              <span>Sahneyi Uygula</span>
            </button>
          </article>
        `;
      })
      .join('');
  }

  function formatMacroStepBadge(step) {
    if (!step) return '';
    if (step.type === 'text') {
      const txt = String(step.value || '');
      return `METİN: "${txt.length > 18 ? txt.slice(0, 18) + '…' : txt}"`;
    }
    if (step.type === 'delay') {
      return `BEKLE: ${Number(step.delayMs || step.value || 100)} ms`;
    }
    if (step.type === 'system_action') {
      return `SİSTEM: ${String(step.label || step.value || '')}`;
    }
    return String(step.value || '').toUpperCase();
  }

  function renderMacrosList() {
    const emptyEl = document.getElementById('macrosEmptyState');
    const listEl = document.getElementById('macrosListContainer');
    if (!emptyEl || !listEl) return;

    const list = Array.isArray(state.macros) ? state.macros : [];
    if (!list.length) {
      emptyEl.classList.remove('hidden');
      listEl.classList.add('hidden');
      listEl.innerHTML = '';
      return;
    }

    emptyEl.classList.add('hidden');
    listEl.classList.remove('hidden');

    listEl.innerHTML = list
      .map((m) => {
        const steps = Array.isArray(m.steps) ? m.steps : [];
        const badges = steps
          .slice(0, 4)
          .map((s) => formatMacroStepBadge(s))
          .filter(Boolean)
          .join(' → ');
        const moreTxt = steps.length > 4 ? ` +${steps.length - 4}` : '';
        return `
          <div class="macro-card" data-macro-id="${escapeHtml(m.id)}">
            <div class="macro-card-left" data-run-macro="${escapeHtml(m.id)}">
              <div class="macro-key-icon">
                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" style="width: 18px; height: 18px;">
                  <rect x="2.5" y="4.5" width="15" height="11" rx="2" />
                  <path d="M6 8h1.5M9.25 8h1.5M12.5 8H14M6 12h8" />
                </svg>
              </div>
              <div class="macro-card-info">
                <span class="macro-card-title">${escapeHtml(m.name || 'Makro')}</span>
                <span class="macro-card-seq">${escapeHtml((badges || `${steps.length} adım`) + moreTxt)}</span>
              </div>
            </div>
            <div class="macro-card-actions">
              <button
                type="button"
                class="icon-action-btn"
                data-edit-macro="${escapeHtml(m.id)}"
                title="Makroyu Düzenle"
                aria-label="Makroyu Düzenle"
              >
                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6">
                  <path d="M13.5 3.8a1.8 1.8 0 0 1 2.5 2.5L7.2 15.1 3.5 16l.9-3.7 9.1-8.5z" stroke-linejoin="round" />
                </svg>
              </button>
              <button
                type="button"
                class="btn-primary btn-compact"
                data-run-macro="${escapeHtml(m.id)}"
              >
                Çalıştır
              </button>
            </div>
          </div>
        `;
      })
      .join('');
  }

  function openMacroComposer(existingMacro) {
    state.editingMacroId = existingMacro ? existingMacro.id : null;
    state.macroSteps =
      existingMacro && Array.isArray(existingMacro.steps)
        ? JSON.parse(JSON.stringify(existingMacro.steps))
        : [];
    state.macroActiveMods = [];

    const titleEl = document.getElementById('macroModalTitle');
    if (titleEl) {
      titleEl.textContent = existingMacro ? 'Makroyu Düzenle' : 'Makro Oluştur';
    }
    const nameInput = document.getElementById('macroNameInput');
    if (nameInput) nameInput.value = existingMacro ? existingMacro.name || '' : '';

    const keyInput = document.getElementById('macroBaseKeySelect') || document.getElementById('macroCustomKeyInput');
    if (keyInput) keyInput.value = '';

    const textInput = document.getElementById('macroTextStepInput');
    if (textInput) textInput.value = '';

    const delBtn = document.getElementById('deleteMacroModalBtn');
    if (delBtn) delBtn.classList.toggle('hidden', !existingMacro);

    document.querySelectorAll('#macroModPills .macro-mod-pill').forEach((b) => b.classList.remove('active'));
    renderMacroComposerSteps();
    openModal('macroComposerModal');
  }

  function renderMacroComposerSteps() {
    const badge = document.getElementById('macroStepsCountBadge');
    const listEl = document.getElementById('macroStepsListContainer') || document.getElementById('macroStepsEditorList');
    if (badge) badge.textContent = `${state.macroSteps.length} Adım`;
    if (!listEl) return;

    if (!state.macroSteps.length) {
      listEl.innerHTML = `<p class="section-subtitle">Henüz adım eklenmedi. Yukarıdan tuş kombinasyonu, metin veya bekleme ekleyin.</p>`;
      return;
    }

    listEl.innerHTML = state.macroSteps
      .map((step, idx) => {
        const typeLabel =
          step.type === 'text'
            ? 'METİN'
            : step.type === 'delay'
            ? 'BEKLE'
            : step.type === 'system_action'
            ? 'SİSTEM'
            : 'TUŞ';
        const valLabel =
          step.type === 'delay'
            ? `${Number(step.delayMs || step.value || 100)} ms`
            : step.type === 'system_action'
            ? String(step.label || step.value || '')
            : String(step.value || '');
        return `
          <div class="macro-step-row">
            <div class="macro-step-row-left">
              <span class="macro-step-badge">${typeLabel}</span>
              <span class="macro-step-val">${escapeHtml(valLabel)}</span>
            </div>
            <button
              type="button"
              class="icon-action-btn danger"
              data-remove-macro-step="${idx}"
              title="Adımı Sil"
              aria-label="Adımı Sil"
            >
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6">
                <path d="M4.5 6h11M8 6V4.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1V6m-5.5 0l.6 9.5a1.5 1.5 0 0 0 1.5 1.4h2.8a1.5 1.5 0 0 0 1.5-1.4L13.5 6" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
          </div>
        `;
      })
      .join('');
  }

  // TAB 1.5: DEDICATED APPLICATIONS CATALOG ("UYGULAMALAR")
  function isAppCurrentlyRunning(app) {
    if (!app || !Array.isArray(state.windows) || !state.windows.length) return false;
    const pLow = String(app.processName || '').toLowerCase();
    const lLow = String(app.launchPath || '').toLowerCase();
    for (const w of state.windows) {
      if (lLow && w.exePath && String(w.exePath).toLowerCase() === lLow) return true;
      if (pLow && w.processName && String(w.processName).toLowerCase() === pLow) return true;
    }
    return false;
  }

  function renderAppsTab() {
    const gridEl = document.getElementById('appsCatalogGrid');
    const subEl = document.getElementById('appsCountSubtitle');

    const allApps = Array.isArray(state.installedApps) ? state.installedApps : [];
    const runningCount = allApps.filter((a) => isAppCurrentlyRunning(a)).length;

    if (subEl) {
      subEl.textContent = `${allApps.length} yüklü uygulama · ${runningCount} açık`;
    }

    if (!gridEl) return;

    const query = String(state.appsSearchQuery || '').trim().toLowerCase();

    const filtered = allApps
      .map((app, idx) => ({ app, idx, running: isAppCurrentlyRunning(app) }))
      .filter(({ app }) => {
        if (!query) return true;
        return (
          String(app.name || '').toLowerCase().includes(query) ||
          String(app.processName || '').toLowerCase().includes(query) ||
          String(app.launchPath || '').toLowerCase().includes(query)
        );
      });

    if (!filtered.length) {
      gridEl.innerHTML = `
        <div class="sub-panel" style="grid-column: 1 / -1;">
          <p class="section-subtitle">Aramayla eşleşen uygulama bulunamadı.</p>
        </div>
      `;
      return;
    }

    gridEl.innerHTML = filtered
      .map(({ app, idx, running }) => {
        const iconUrl = app.icon || findIconForItem(app);
        const iconHtml =
          iconUrl && iconUrl.startsWith('data:image/')
            ? `<img class="app-catalog-icon-img" src="${safeImageSrc(iconUrl)}" alt="${escapeHtml(app.name || '')}" loading="lazy" />`
            : `<span class="app-fallback-monogram">${escapeHtml(getAppMonogram(app.name))}</span>`;
        return `
          <div
            class="app-catalog-card ${running ? 'is-running' : ''}"
            data-app-card-idx="${idx}"
            title="${escapeHtml(app.name)} (Başlatmak için dokunun, özellikler için basılı tutun)"
          >
            ${running ? '<span class="app-catalog-running-dot" title="Şu an açık"></span>' : ''}
            <button
              type="button"
              class="app-catalog-info-btn"
              data-app-info-idx="${idx}"
              aria-label="Uygulama Özellikleri"
              title="Özellikler"
            >
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7">
                <circle cx="10" cy="4.5" r="1" fill="currentColor" />
                <circle cx="10" cy="10" r="1" fill="currentColor" />
                <circle cx="10" cy="15.5" r="1" fill="currentColor" />
              </svg>
            </button>
            <div class="app-catalog-icon-wrap">
              ${iconHtml}
            </div>
            <span class="app-catalog-name">${escapeHtml(app.name)}</span>
          </div>
        `;
      })
      .join('');
  }

  // TAB 2: MONITORS (SIDE-BY-SIDE GREEN/RED ICON TILES) & LIVE WINDOW MANAGER
  function renderMonitorsTab() {
    const container = document.getElementById('monitorsContainer');
    if (!container) return;

    if (!state.monitors.length) {
      container.innerHTML = '';
      return;
    }

    container.innerHTML = state.monitors
      .map((m) => {
        const isBlack = Boolean(m.isBlackedOut);
        const stateCls = isBlack ? 'is-off' : 'is-on';
        return `
          <button
            type="button"
            class="monitor-icon-tile ${stateCls}"
            data-toggle-blackout="${m.index}"
            title="Ekran ${m.index + 1} (${isBlack ? 'Kapalı - Açmak için dokunun' : 'Açık - Kapatmak için dokunun'})"
          >
            <svg class="monitor-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
              <rect x="2.5" y="4" width="19" height="12.5" rx="2" />
              <path d="M8 20h8M12 16.5V20" stroke-linecap="round" />
              ${isBlack ? '<path d="M5 6.5l14 7.5" stroke-linecap="round" />' : ''}
            </svg>
            <span class="monitor-icon-label">Ekran ${m.index + 1}</span>
            <span class="monitor-icon-res">${m.width}×${m.height}</span>
          </button>
        `;
      })
      .join('');
  }

  function renderMonitorsBrightnessList() {
    const listEl = document.getElementById('monitorsBrightnessList');
    if (!listEl) return;

    // Guard: Never destroy DOM while user is actively touching or dragging any slider
    if (listEl.querySelector('.monitor-brightness-slider:active') || (document.activeElement && document.activeElement.classList.contains('monitor-brightness-slider'))) {
      return;
    }

    const mons = state.monitors && state.monitors.length ? state.monitors : [{ index: 0, brightness: 100 }];
    listEl.innerHTML = mons
      .map((m, idx) => {
        const monIdx = typeof m.index === 'number' ? m.index : idx;
        const level = typeof m.brightness === 'number' ? Math.max(10, Math.min(100, m.brightness)) : 100;
        return `
          <div class="monitor-brightness-item" data-monitor-brightness-row="${monIdx}">
            <div class="audio-row-top">
              <div class="audio-label-group">
                <svg class="sys-pack-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6">
                  <circle cx="10" cy="10" r="3.5" />
                  <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4" stroke-linecap="round" />
                </svg>
                <span class="audio-label">Ekran ${monIdx + 1}</span>
              </div>
              <span class="mono-stat" id="monitorBrightnessLabel-${monIdx}">${level}%</span>
            </div>
            <input
              type="range"
              class="volume-slider monitor-brightness-slider"
              data-monitor-index="${monIdx}"
              min="10"
              max="100"
              value="${level}"
            />
          </div>
        `;
      })
      .join('');
  }

  function renderOpenWindowsList() {
    const container = document.getElementById('openWindowsContainer');
    if (!container) return;

    if (!state.windows.length) {
      container.innerHTML = `<div class="sub-panel"><p class="section-subtitle">Açık uygulama penceresi bulunamadı.</p></div>`;
      return;
    }

    container.innerHTML = state.windows
      .map((w) => {
        const curMon = Number(w.monitorIndex || 0);
        const isBg = Boolean(w.isBackground || w.state === 'minimized');
        const badgeTxt = `E${curMon + 1}${isBg ? ' · ARKA' : ''}${w.isTopMost ? ' · ÜSTTE' : ''}`;
        return `
          <div class="window-row-card" data-snap-hwnd="${w.hwnd}">
            <div class="window-row-left">
              <div class="window-row-icon-box">
                ${renderAppIconHtml(w.icon || findIconForItem(w), w.processName)}
              </div>
              <div class="window-row-info">
                <div class="window-row-proc">${escapeHtml(w.processName)}</div>
                <div class="window-row-title">${escapeHtml(w.title)}</div>
              </div>
            </div>
            <div class="window-row-badges">
              <span class="win-loc-badge">${escapeHtml(badgeTxt)}</span>
            </div>
          </div>
        `;
      })
      .join('');
  }

  // =========================================================================
  // TAB 3: 60 FPS LOW-LATENCY REMOTE DESKTOP ENGINE (REAL PC CURSOR ON SCREEN)
  // =========================================================================
  function renderRemoteMonitorPills() {
    const container = document.getElementById('remoteMonitorSelector');
    const hudMonBtn = document.getElementById('hudMonitorCycleBtn');
    if (!container) return;

    const count = Math.max(1, state.monitors.length || 1);
    const html = [];
    for (let i = 0; i < count; i++) {
      html.push(`
        <button
          type="button"
          class="mode-pill ${state.remoteMonitorIndex === i ? 'active' : ''}"
          data-remote-mon="${i}"
          aria-label="Ekran ${i + 1}"
          title="Ekran ${i + 1}"
        >
          <svg class="remote-mon-pill-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8">
            <rect x="2.5" y="3.5" width="15" height="10" rx="1.6" />
            <path d="M6.5 16.5h7M10 13.5v3" stroke-linecap="round" />
          </svg>
          <span>${i + 1}</span>
        </button>
      `);
    }
    if (count > 1) {
      html.push(`
        <button
          type="button"
          class="mode-pill ${state.remoteMonitorIndex === -1 ? 'active' : ''}"
          data-remote-mon="-1"
          aria-label="Tüm Ekranlar"
          title="Tüm Ekranlar"
        >
          <svg class="remote-mon-pill-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8">
            <rect x="1.8" y="4.5" width="10.5" height="7.5" rx="1.2" />
            <rect x="7.7" y="8" width="10.5" height="7.5" rx="1.2" />
          </svg>
          <span>Tümü</span>
        </button>
      `);
    }
    container.innerHTML = html.join('');

    if (hudMonBtn) {
      hudMonBtn.textContent = state.remoteMonitorIndex === -1 ? 'TÜMÜ' : `EKRAN ${state.remoteMonitorIndex + 1}`;
    }
  }

  // =========================================================================
  // REMOTE DESKTOP RENDERER (protocol v2: dirty rects + top-off + client cursor)
  // Frames carry only changed rectangles; each is decoded off the main thread with
  // createImageBitmap, painted onto a canvas kept at the PC's native resolution, and
  // acked so the PC sends the next one (Chrome Remote Desktop style pacing).
  // =========================================================================
  const REMOTE_FRAME_MAGIC = 0x32464254;
  const REMOTE_ACK_OPCODE = 0xa1;
  const remoteRender = {
    inputSeq: 0,
    lastPointerSeq: 0,
    seqSupported: false,
    queue: [],
    busy: false,
    ctx: null,
    canvasW: 0,
    canvasH: 0,
    srcW: 1920,
    srcH: 1080,
    cursorVisible: false,
    cursorHotX: 0,
    cursorHotY: 0,
    cursorW: 32,
    cursorH: 32,
    cursorUrl: null,
    serverCursorX: 0.5,
    serverCursorY: 0.5,
    lastLocalCursorMoveTs: 0,
    cursorEnabled: loadUserSettings().virtualCursor !== false
  };

  function getRemoteCanvas() {
    return document.getElementById('remoteScreenCanvas');
  }

  // Visible picture rectangle of the canvas (object-fit: contain) in stage-local, untransformed pixels
  function getRemoteContentBox() {
    const canvas = getRemoteCanvas();
    if (!canvas) return null;
    const boxW = canvas.clientWidth || 1;
    const boxH = canvas.clientHeight || 1;
    const natW = canvas.width || remoteRender.srcW;
    const natH = canvas.height || remoteRender.srcH;
    const scale = Math.min(boxW / natW, boxH / natH);
    const w = natW * scale;
    const h = natH * scale;
    return {
      left: (canvas.offsetLeft || 0) + (boxW - w) / 2,
      top: (canvas.offsetTop || 0) + (boxH - h) / 2,
      width: w,
      height: h
    };
  }

  function updateVirtualCursorVisual() {
    const cursorEl = document.getElementById('remoteCursorLayer');
    if (!cursorEl) return;
    const show = remoteRender.cursorEnabled && remoteRender.cursorVisible && state.hasReceivedFrameOnce && !!remoteRender.cursorUrl;
    cursorEl.classList.toggle('hidden', !show);
    if (!show) return;
    const box = getRemoteContentBox();
    if (!box) return;
    const pxPerSrc = box.width / Math.max(1, remoteRender.srcW);
    // Never let the cursor become unreadably tiny on a phone screen
    const cursorScale = Math.max(pxPerSrc, 0.55);
    const x = box.left + state.cursorNormX * box.width - remoteRender.cursorHotX * cursorScale;
    const y = box.top + state.cursorNormY * box.height - remoteRender.cursorHotY * cursorScale;
    cursorEl.style.width = `${Math.round(remoteRender.cursorW * cursorScale)}px`;
    cursorEl.style.height = `${Math.round(remoteRender.cursorH * cursorScale)}px`;
    cursorEl.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
  }

  function noteLocalCursorMove() {
    remoteRender.lastLocalCursorMoveTs = performance.now();
    remoteRender.cursorVisible = true;
    updateVirtualCursorVisual();
  }

  function flashCursorClick() {}

  function showTouchRippleAtNormalized(normX, normY) {
    const ripple = document.getElementById('remoteTouchRipple');
    const box = getRemoteContentBox();
    if (!ripple || !box) return;
    ripple.style.left = `${Math.round(box.left + normX * box.width)}px`;
    ripple.style.top = `${Math.round(box.top + normY * box.height)}px`;
    ripple.classList.remove('hidden');
    setTimeout(() => ripple.classList.add('hidden'), 260);
  }

  function applyStageZoomAndPan() {
    const stage = document.getElementById('remoteCanvasStage');
    if (!stage) return;

    if (state.zoomScale <= 1.01) {
      state.zoomScale = 1.0;
      state.panX = 0;
      state.panY = 0;
      stage.style.transform = 'translate3d(0px, 0px, 0px) scale(1)';
    } else {
      const box = document.getElementById('remoteViewportBox');
      const maxPanX = ((box ? box.clientWidth : 360) * (state.zoomScale - 1)) / 1.1;
      const maxPanY = ((box ? box.clientHeight : 240) * (state.zoomScale - 1)) / 1.1;
      state.panX = Math.max(-maxPanX, Math.min(maxPanX, state.panX));
      state.panY = Math.max(-maxPanY, Math.min(maxPanY, state.panY));
      stage.style.transform = `translate3d(${Math.round(state.panX)}px, ${Math.round(state.panY)}px, 0px) scale(${state.zoomScale.toFixed(2)})`;
    }
  }

  function updateDragHoldUi() {
    const badgeEl = document.getElementById('remoteDragStateBadge');
    const lockBtn = document.getElementById('mouseBtnDragLock');
    const hudLockBtn = document.getElementById('hudDragLockBtn');
    const tpLeftBtn = document.querySelector('#laptopTouchpadButtons [data-mouse-btn="left"]');

    if (badgeEl) badgeEl.classList.toggle('hidden', !state.isLeftButtonHeld);
    if (tpLeftBtn) tpLeftBtn.classList.toggle('is-holding', state.isLeftButtonHeld);
    if (lockBtn) {
      lockBtn.classList.toggle('is-holding', state.isLeftButtonHeld);
      lockBtn.textContent = state.isLeftButtonHeld ? 'Bırak (Sürükleniyor)' : 'Basılı Tut (Sürükle)';
    }
    if (hudLockBtn) {
      hudLockBtn.classList.toggle('is-holding', state.isLeftButtonHeld);
      hudLockBtn.textContent = state.isLeftButtonHeld ? 'Bırak' : 'Sürükle';
    }
  }

  async function setLeftButtonHold(hold, normX, normY) {
    state.isLeftButtonHeld = Boolean(hold);
    updateDragHoldUi();
    triggerHaptic(hold ? 22 : 10);
    const payload = {
      type: hold ? 'mouse_down' : 'mouse_up',
      button: 'left',
      monitorIndex: state.isStreaming ? state.remoteMonitorIndex : -1
    };
    if (typeof normX === 'number' && typeof normY === 'number') {
      payload.x = normX;
      payload.y = normY;
    }
    sendFastInput(payload);
  }

  function setRemoteInputMode(mode) {
    const nextMode = mode === 'direct' ? 'direct' : 'trackpad';
    state.remoteInputMode = nextMode;
    const tpBtn = document.getElementById('modeTrackpadBtn');
    const dtBtn = document.getElementById('modeDirectTouchBtn');
    const hudModeBtn = document.getElementById('hudModeToggleBtn');
    const fpsBadge = document.getElementById('remoteFpsBadge');

    if (tpBtn) tpBtn.classList.toggle('active', state.remoteInputMode === 'trackpad');
    if (dtBtn) dtBtn.classList.toggle('active', state.remoteInputMode === 'direct');
    if (hudModeBtn) {
      hudModeBtn.textContent = state.remoteInputMode === 'trackpad' ? 'Fare Modu' : 'Dokunmatik';
    }
    if (fpsBadge && state.isStreaming) {
      const modeTxt = state.remoteInputMode === 'trackpad' ? 'FARE' : 'DOKUNMATİK';
      fpsBadge.textContent = `${modeTxt} · ${streamCodecLabel()}${state.measuredFps > 0 ? `${state.measuredFps} FPS` : 'CANLI'}`;
    }
    updateVirtualCursorVisual();
  }

  function setRemoteFullscreen(enable) {
    state.isFullscreen = Boolean(enable);
    const wsEl = document.getElementById('remoteWorkstation');
    const hudEl = document.getElementById('remoteFloatingHud');
    const remoteTabEl = document.getElementById('tab-remote');

    if (wsEl) {
      if (state.isFullscreen) {
        if (wsEl.parentElement && wsEl.parentElement !== document.body) {
          wsEl.__originLayoutContainer = wsEl.parentElement;
          document.body.appendChild(wsEl);
        }
      } else if (wsEl.parentElement === document.body) {
        const targetContainer = wsEl.__originLayoutContainer || remoteTabEl;
        if (targetContainer) {
          targetContainer.insertBefore(wsEl, targetContainer.firstChild);
        }
        applyAllSavedPageLayouts();
      }
      wsEl.classList.toggle('is-fullscreen', state.isFullscreen);
    }
    if (hudEl) hudEl.classList.toggle('hidden', !state.isFullscreen);
    requestAnimationFrame(updateVirtualCursorVisual);

    try {
      if (window.TahaNative && typeof window.TahaNative.setLandscapeFullscreen === 'function') {
        window.TahaNative.setLandscapeFullscreen(Boolean(state.isFullscreen && state.isStreaming));
      }
    } catch {}
  }

  function updateFpsCounterReadout() {
    state.frameCounter++;
  }

  // Phone-side numbers for the stats panel (reset every second)
  const remoteStats = { received: 0, bytes: 0, video: 0, cursorOnly: 0, decodeMs: 0, decoded: 0, drawMs: 0, maxDecodeQueue: 0, server: null };

  function renderRemoteStatsPanel(elapsedMs) {
    const panel = document.getElementById('remoteStatsPanel');
    if (!panel || panel.classList.contains('hidden')) return;
    const per = (n) => Math.round((n * 1000) / Math.max(1, elapsedMs));
    const sv = remoteStats.server;
    const lines = [
      `Bağlantı : ${state.connectedRoute || '-'} · ping ${state.latencyMs !== null ? state.latencyMs + ' ms' : '-'}`,
      `Codec    : ${streamCodecLabel().replace(' · ', '') || 'JPEG'} ${remoteRender.canvasW}×${remoteRender.canvasH}`,
      `PC       : ${sv ? `${sv.sentFps} kare/s gönderdi · ${sv.sentMbps} Mbps · yakalama ${sv.captureMs} ms` : 'bekleniyor'}`,
      `Akış     : ${sv ? `hedef ${Math.round(sv.targetKbps / 1000)} Mbps (seviye ${sv.level}) · RTT ${sv.rttMs} ms · gecikme ${sv.latencyMs} ms · pencere ${sv.inFlight}/${sv.window} · sınır ${sv.fpsCap} FPS` : '-'}`,
      `Telefon  : ${per(remoteStats.received)} kare/s aldı (video ${per(remoteStats.video)}, imleç ${per(remoteStats.cursorOnly)}) · ${(
        (remoteStats.bytes * 8) /
        Math.max(1, elapsedMs) /
        1000
      ).toFixed(1)} Mbps`,
      `Çözücü   : ${remoteStats.decoded ? (remoteStats.decodeMs / remoteStats.decoded).toFixed(1) : '-'} ms/kare · kuyruk ≤${remoteStats.maxDecodeQueue} · çizim ${
        remoteStats.decoded ? (remoteStats.drawMs / remoteStats.decoded).toFixed(1) : '-'
      } ms`
    ];
    panel.textContent = lines.join('\n');
  }

  // Frames only arrive when the PC screen changes, so the badge is refreshed on a timer
  setInterval(() => {
    const now = performance.now();
    const elapsed = now - state.lastFpsCalcTs;
    state.measuredFps = Math.round((state.frameCounter * 1000) / Math.max(1, elapsed));
    state.frameCounter = 0;
    state.lastFpsCalcTs = now;
    renderRemoteStatsPanel(elapsed);
    Object.assign(remoteStats, { received: 0, bytes: 0, video: 0, cursorOnly: 0, decodeMs: 0, decoded: 0, drawMs: 0, maxDecodeQueue: 0 });
    const fpsBadge = document.getElementById('remoteFpsBadge');
    if (!fpsBadge || !state.isStreaming) return;
    const modeTxt = state.remoteInputMode === 'trackpad' ? 'FARE' : 'DOKUNMATİK';
    fpsBadge.textContent = `${modeTxt} · ${streamCodecLabel()}${state.measuredFps > 0 ? `${state.measuredFps} FPS` : 'CANLI'}`;
  }, 1000);

  function handleIncomingBinaryFrame(data) {
    if (!(data instanceof ArrayBuffer) || data.byteLength < 28) return;
    remoteStats.received++;
    remoteStats.bytes += data.byteLength;
    remoteRender.queue.push({ buf: data, ws: state.ws });
    // Frames are deltas: never drop one, the PC limits frames in flight so this queue stays tiny
    if (!remoteRender.busy) pumpRemoteFrames();
  }

  function sendRemoteAck(ws, frameId) {
    if (!ws || ws !== state.ws || ws.readyState !== WebSocket.OPEN) return;
    const ack = new Uint8Array(5);
    ack[0] = REMOTE_ACK_OPCODE;
    new DataView(ack.buffer).setUint32(1, frameId, true);
    try {
      ws.send(ack);
    } catch {}
  }

  async function pumpRemoteFrames() {
    remoteRender.busy = true;
    try {
      while (remoteRender.queue.length) {
        const item = remoteRender.queue.shift();
        let frameId = null;
        try {
          // Video frames return null: they are acked from the decoder's output callback
          frameId = await applyRemoteFrame(item.buf, item.ws);
        } catch {}
        if (frameId !== null) sendRemoteAck(item.ws, frameId);
      }
    } finally {
      remoteRender.busy = false;
    }
  }

  // ---- H.264 motion path (WebCodecs) -------------------------------------
  const remoteVideo = {
    supported: null,
    decoder: null,
    codec: '',
    awaitingKey: true,
    pending: new Map(),
    lastKeyRequestTs: 0
  };

  async function detectVideoSupport() {
    if (remoteVideo.supported !== null) return remoteVideo.supported;
    remoteVideo.supported = false;
    remoteVideo.av1 = false;
    remoteVideo.av1Hardware = false;
    try {
      if (typeof VideoDecoder === 'function' && typeof EncodedVideoChunk === 'function') {
        const res = await VideoDecoder.isConfigSupported({ codec: 'avc1.64002a', optimizeForLatency: true });
        remoteVideo.supported = Boolean(res && res.supported);
        const av1 = { codec: 'av01.0.09M.08', optimizeForLatency: true };
        remoteVideo.av1 = Boolean((await VideoDecoder.isConfigSupported(av1)).supported);
        if (remoteVideo.av1) {
          remoteVideo.av1Hardware = Boolean((await VideoDecoder.isConfigSupported({ ...av1, hardwareAcceleration: 'prefer-hardware' })).supported);
        }
      }
    } catch {}
    return remoteVideo.supported;
  }

  // Codec the PC should use. "auto" takes AV1 only when this phone decodes it in hardware (software AV1 at
  // 60 FPS drains the battery and drops frames on mid-range phones); H.264 is the fallback everywhere.
  function preferredVideoCodec() {
    const choice = userSettings.videoCodec || 'auto';
    if (choice === 'h264' || !remoteVideo.av1) return 'h264';
    if (choice === 'av1') return 'av1';
    return remoteVideo.av1Hardware ? 'av1' : 'h264';
  }

  // av01.<profile>.<level><tier>.<bitdepth>: profile 0 (Main), 8-bit, level picked from the picture size
  function streamCodecLabel() {
    const c = remoteVideo.codec || '';
    return c.startsWith('av01') ? 'AV1 · ' : c.startsWith('avc1') ? 'H.264 · ' : '';
  }

  function av1CodecString(width, height) {
    const pixels = width * height;
    const level = pixels <= 2228224 ? '09' : pixels <= 8912896 ? '13' : '17';
    return `av01.0.${level}M.08`;
  }

  function spsCodecString(bytes) {
    for (let i = 0; i + 7 < bytes.length; i++) {
      if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1 && (bytes[i + 3] & 0x1f) === 7) {
        const hex = (n) => n.toString(16).padStart(2, '0');
        return `avc1.${hex(bytes[i + 4])}${hex(bytes[i + 5])}${hex(bytes[i + 6])}`;
      }
    }
    return null;
  }

  function requestVideoKeyframe() {
    const now = Date.now();
    if (now - remoteVideo.lastKeyRequestTs < 600) return;
    remoteVideo.lastKeyRequestTs = now;
    sendCommand('stream_keyframe', {}, 2000).catch(() => {});
  }

  function dropPendingVideoFrames() {
    for (const [, p] of remoteVideo.pending) {
      clearTimeout(p.timer);
      sendRemoteAck(p.ws, p.frameId);
    }
    remoteVideo.pending.clear();
  }

  function resetVideoDecoder() {
    dropPendingVideoFrames();
    if (remoteVideo.decoder) {
      try {
        remoteVideo.decoder.close();
      } catch {}
    }
    remoteVideo.decoder = null;
    remoteVideo.codec = '';
    remoteVideo.awaitingKey = true;
  }

  function ensureVideoDecoder(codec) {
    const dec = remoteVideo.decoder;
    if (dec && dec.state === 'configured' && remoteVideo.codec === codec) return true;
    resetVideoDecoder();
    try {
      const decoder = new VideoDecoder({
        output: onDecodedVideoFrame,
        error: () => {
          // Lost sync or hardware decoder reset: recover with a fresh IDR
          if (remoteVideo.decoder === decoder) resetVideoDecoder();
          requestVideoKeyframe();
        }
      });
      decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
      remoteVideo.decoder = decoder;
      remoteVideo.codec = codec;
      return true;
    } catch {
      remoteVideo.decoder = null;
      return false;
    }
  }

  function onDecodedVideoFrame(videoFrame) {
    const p = remoteVideo.pending.get(videoFrame.timestamp);
    if (!p) {
      videoFrame.close();
      return;
    }
    remoteVideo.pending.delete(videoFrame.timestamp);
    clearTimeout(p.timer);
    const drawStart = performance.now();
    remoteStats.decodeMs += drawStart - p.decodeStart;
    remoteStats.decoded++;
    try {
      if (state.isStreaming) {
        const ctx = ensureRemoteCanvas(p.canvasW, p.canvasH);
        if (ctx) {
          ctx.save();
          if (!p.full) {
            // Only the regions that changed are painted, so sharp top-off tiles elsewhere survive
            ctx.beginPath();
            for (const r of p.rects) ctx.rect(r.x, r.y, r.w, r.h);
            ctx.clip();
          }
          ctx.drawImage(videoFrame, 0, 0, p.canvasW, p.canvasH);
          ctx.restore();
          remoteStats.drawMs += performance.now() - drawStart;
          markRemoteFramePainted();
        }
      }
    } finally {
      videoFrame.close();
      sendRemoteAck(p.ws, p.frameId);
    }
  }

  function waitForVideoDrain(maxMs) {
    if (!remoteVideo.pending.size) return Promise.resolve();
    return new Promise((resolve) => {
      const started = performance.now();
      const check = () => {
        if (!remoteVideo.pending.size) return resolve();
        if (performance.now() - started > maxMs) {
          dropPendingVideoFrames();
          return resolve();
        }
        setTimeout(check, 4);
      };
      check();
    });
  }

  function ensureRemoteCanvas(w, h) {
    const canvas = getRemoteCanvas();
    if (!canvas) return null;
    if (canvas.width !== w || canvas.height !== h || !remoteRender.ctx) {
      canvas.width = w;
      canvas.height = h;
      remoteRender.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true }) || canvas.getContext('2d');
    }
    const ctx = remoteRender.ctx;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    return ctx;
  }

  function markRemoteFramePainted() {
    if (!state.hasReceivedFrameOnce) {
      state.hasReceivedFrameOnce = true;
      const canvas = getRemoteCanvas();
      if (canvas) canvas.classList.remove('hidden');
      const placeholder = document.getElementById('remotePlaceholder');
      if (placeholder) placeholder.classList.add('hidden');
    }
    updateFpsCounterReadout();
  }

  let imageBitmapOptionsSupported = true;
  async function decodeJpeg(bytes) {
    const blob = new Blob([bytes], { type: 'image/jpeg' });
    if (typeof createImageBitmap === 'function') {
      if (imageBitmapOptionsSupported) {
        try {
          return await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
        } catch {
          imageBitmapOptionsSupported = false;
        }
      }
      return createImageBitmap(blob);
    }
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function applyRemoteFrame(buf, ws) {
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== REMOTE_FRAME_MAGIC) return null;
    const frameId = dv.getUint32(4, true);
    const flags = dv.getUint16(8, true);
    const rectCount = dv.getUint16(10, true);
    const canvasW = dv.getUint16(12, true);
    const canvasH = dv.getUint16(14, true);
    const srcW = dv.getUint16(16, true);
    const srcH = dv.getUint16(18, true);
    const curX = dv.getUint16(20, true) / 65535;
    const ackSeq = dv.getUint16(26, true);
    const curY = dv.getUint16(22, true) / 65535;
    let off = 28;

    if (flags & 0x08) {
      const hotX = dv.getUint16(off, true);
      const hotY = dv.getUint16(off + 2, true);
      const w = dv.getUint16(off + 4, true);
      const h = dv.getUint16(off + 6, true);
      const len = dv.getUint32(off + 8, true);
      const png = new Blob([new Uint8Array(buf, off + 12, len)], { type: 'image/png' });
      off += 12 + len;
      if (remoteRender.cursorUrl) URL.revokeObjectURL(remoteRender.cursorUrl);
      remoteRender.cursorUrl = URL.createObjectURL(png);
      remoteRender.cursorHotX = hotX;
      remoteRender.cursorHotY = hotY;
      remoteRender.cursorW = w;
      remoteRender.cursorH = h;
      const cursorEl = document.getElementById('remoteCursorLayer');
      if (cursorEl) cursorEl.src = remoteRender.cursorUrl;
    }

    let videoBytes = null;
    let videoW = 0;
    let videoH = 0;
    if (flags & 0x80) {
      videoW = dv.getUint16(off, true);
      videoH = dv.getUint16(off + 2, true);
      const len = dv.getUint32(off + 4, true);
      videoBytes = new Uint8Array(buf, off + 8, len);
      off += 8 + len;
    }

    const rects = [];
    for (let i = 0; i < rectCount; i++) {
      const len = dv.getUint32(off + 8, true);
      rects.push({
        x: dv.getUint16(off, true),
        y: dv.getUint16(off + 2, true),
        w: dv.getUint16(off + 4, true),
        h: dv.getUint16(off + 6, true),
        bytes: new Uint8Array(buf, off + 12, len)
      });
      off += 12 + len;
    }

    remoteRender.canvasW = canvasW;
    remoteRender.canvasH = canvasH;
    remoteRender.srcW = srcW || canvasW;
    remoteRender.srcH = srcH || canvasH;
    state.streamBounds = { width: remoteRender.srcW, height: remoteRender.srcH };
    remoteRender.cursorVisible = (flags & 0x04) !== 0;
    remoteRender.serverCursorX = curX;
    remoteRender.serverCursorY = curY;
    // While the user is steering the cursor the predicted position wins. It hands back to the PC only once the PC
    // reports (ackSeq) that it applied our last move, so stale frames in flight can no longer pull the cursor back.
    // PC agents without input sequence numbers fall back to a quiet-time rule.
    if (ackSeq && !remoteRender.seqSupported) {
      remoteRender.seqSupported = true;
      // Continue the PC's numbering (it outlives this connection) so our next move compares as newer
      remoteRender.inputSeq = ackSeq;
      remoteRender.lastPointerSeq = 0;
    } else if (!ackSeq && remoteRender.seqSupported) {
      // Bridge restarted (numbering back to 0) or an agent without sequence numbers: use the timer rule again
      remoteRender.seqSupported = false;
    }
    const quietMs = performance.now() - remoteRender.lastLocalCursorMoveTs;
    const caughtUp = remoteRender.seqSupported && remoteRender.lastPointerSeq
      ? ((ackSeq - remoteRender.lastPointerSeq) & 0xffff) < 0x8000 && quietMs > 40
      : quietMs > 180;
    if (caughtUp) {
      state.cursorNormX = curX;
      state.cursorNormY = curY;
    }
    updateVirtualCursorVisual();

    if (videoBytes) {
      if (!state.isStreaming) return frameId;
      const isKey = (flags & 0x100) !== 0;
      if (isKey) {
        const codec = (flags & 0x200) !== 0 ? av1CodecString(videoW, videoH) : spsCodecString(videoBytes) || 'avc1.64002a';
        if (!ensureVideoDecoder(codec)) return frameId;
        remoteVideo.awaitingKey = false;
      }
      const decoder = remoteVideo.decoder;
      if (!decoder || decoder.state !== 'configured' || remoteVideo.awaitingKey) {
        requestVideoKeyframe();
        return frameId;
      }
      const entry = {
        frameId,
        ws,
        rects,
        full: (flags & 0x01) !== 0 || isKey,
        canvasW,
        canvasH,
        decodeStart: performance.now(),
        timer: setTimeout(() => {
          if (remoteVideo.pending.get(frameId) === entry) {
            remoteVideo.pending.delete(frameId);
            sendRemoteAck(ws, frameId);
          }
        }, 1200)
      };
      remoteVideo.pending.set(frameId, entry);
      remoteStats.video++;
      remoteStats.maxDecodeQueue = Math.max(remoteStats.maxDecodeQueue, remoteVideo.pending.size);
      try {
        // The chunk owns a copy; the socket buffer can be released immediately
        decoder.decode(new EncodedVideoChunk({ type: isKey ? 'key' : 'delta', timestamp: frameId, data: videoBytes }));
      } catch {
        remoteVideo.pending.delete(frameId);
        clearTimeout(entry.timer);
        resetVideoDecoder();
        requestVideoKeyframe();
        return frameId;
      }
      return null;
    }

    if (rects.length === 0) {
      // Cursor-only frame: the cursor layer already moved, which is a visible update like a painted frame
      remoteStats.cursorOnly++;
      updateFpsCounterReadout();
      return frameId;
    }

    // JPEG tiles (top-off / fallback) must land after any video frame still in the decoder
    await waitForVideoDrain(200);
    const images = await Promise.all(rects.map((r) => (r.bytes.length ? decodeJpeg(r.bytes).catch(() => null) : null)));
    if (!state.isStreaming) {
      images.forEach((im) => im && im.close && im.close());
      return frameId;
    }
    const ctx = ensureRemoteCanvas(canvasW, canvasH);
    if (!ctx) return frameId;
    for (let i = 0; i < rects.length; i++) {
      const im = images[i];
      if (!im) continue;
      const r = rects[i];
      ctx.drawImage(im, r.x, r.y, r.w, r.h);
      if (im.close) im.close();
    }
    markRemoteFramePainted();
    return frameId;
  }

  // Legacy single-JPEG snapshot (used for the preview before the live stream starts)
  function handleIncomingScreenFrame(frame) {
    if (!frame || !frame.jpeg) return;
    const bin = atob(frame.jpeg);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    decodeJpeg(bytes)
      .then((im) => {
        const canvas = getRemoteCanvas();
        if (!canvas || !im) return;
        // A live v2 stream owns the canvas; ignore late snapshots
        if (state.isStreaming && state.hasReceivedFrameOnce && remoteRender.canvasW) {
          if (im.close) im.close();
          return;
        }
        const w = im.width || frame.width;
        const h = im.height || frame.height;
        if (canvas.width !== w || canvas.height !== h || !remoteRender.ctx) {
          canvas.width = w;
          canvas.height = h;
          remoteRender.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true }) || canvas.getContext('2d');
        }
        remoteRender.ctx.drawImage(im, 0, 0, w, h);
        if (im.close) im.close();
        state.hasReceivedFrameOnce = true;
        canvas.classList.remove('hidden');
        const placeholder = document.getElementById('remotePlaceholder');
        if (placeholder) placeholder.classList.add('hidden');
        updateFpsCounterReadout();
      })
      .catch(() => {});
  }

  function updateStreamUiState() {
    const wsEl = document.getElementById('remoteWorkstation');
    const placeholder = document.getElementById('remotePlaceholder');
    const canvas = getRemoteCanvas();
    const fpsBadge = document.getElementById('remoteFpsBadge');
    const toggleBtn = document.getElementById('toggleStreamHeaderBtn');

    if (wsEl) {
      wsEl.classList.toggle('is-screen-off', !state.isStreaming);
    }
    const remoteTabEl = document.getElementById('tab-remote');
    if (remoteTabEl) {
      remoteTabEl.classList.toggle('is-remote-screen-off', !state.isStreaming);
    }

    if (toggleBtn) {
      toggleBtn.textContent = state.isStreaming ? 'Ekranı Kapat' : 'Ekranı Aç';
      toggleBtn.classList.toggle('is-live', Boolean(state.isStreaming));
    }

    if (state.isStreaming && state.hasReceivedFrameOnce) {
      if (placeholder) placeholder.classList.add('hidden');
      if (canvas) canvas.classList.remove('hidden');
    } else if (!state.isStreaming) {
      if (placeholder) placeholder.classList.remove('hidden');
      if (canvas) canvas.classList.add('hidden');
    }

    if (!state.isStreaming && fpsBadge) {
      fpsBadge.textContent = 'TRACKPAD · HAZIR';
    }
  }

  async function startRemoteStream() {
    if (!state.isAuthenticated) return;
    const isTunnel = state.connectedRoute === 'MOBİL TÜNEL';
    // Like Chrome Remote Desktop the picture stays at the PC's native resolution on every network; on mobile
    // data only the starting bitrate is lower and the PC adapts it to the measured latency
    const profile = STREAM_PRESETS[state.streamPresetKey] ? state.streamPresetKey : 'balanced';
    const preset = STREAM_PRESETS[profile] || STREAM_PRESETS.balanced;
    remoteRender.queue = [];
    resetVideoDecoder();

    try {
      // Mark streaming before the reply so the first frames (which can beat the reply) are painted
      state.isStreaming = true;
      updateStreamUiState();
      const video = await detectVideoSupport();
      await sendCommand('start_stream', {
        protocol: 2,
        video,
        codec: video ? preferredVideoCodec() : 'jpeg',
        tunnel: isTunnel,
        profile,
        monitorIndex: state.remoteMonitorIndex,
        maxFps: preset.fps,
        maxCanvasWidth: preset.maxCanvasWidth,
        // legacy fields for older PC agents
        fps: preset.fps,
        maxWidth: Math.min(1600, preset.maxCanvasWidth),
        quality: 70,
        drawCursor: true,
        binary: true
      });
      updateStreamUiState();
    } catch (e) {
      state.isStreaming = false;
      updateStreamUiState();
      showToast(e.message);
    }
  }

  async function stopRemoteStream() {
    if (state.isLeftButtonHeld) {
      await setLeftButtonHold(false);
    }
    state.isStreaming = false;
    state.hasReceivedFrameOnce = false;
    remoteRender.queue = [];
    resetVideoDecoder();
    updateStreamUiState();
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      try {
        await sendCommand('stop_stream', {});
      } catch {}
    }
  }

  // ANDROID NOTIFICATION BAR MEDIA SESSION BRIDGE & NOW-PLAYING BANNER
  function formatMediaTime(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const mins = Math.floor(s / 60);
    const rem = s % 60;
    return `${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
  }

  function getEffectiveNowPlaying() {
    const np = state.audio && state.audio.nowPlaying ? state.audio.nowPlaying : null;
    if (np && (np.active || np.title)) {
      const basePos = Math.max(0, Number(np.positionSec || 0));
      const dur = Math.max(0, Number(np.durationSec || 0));
      const elapsedSinceSync =
        np.isPlaying && state.lastMediaSyncWallTs > 0
          ? Math.max(0, Math.floor((Date.now() - state.lastMediaSyncWallTs) / 1000))
          : 0;
      const livePos = dur > 0 ? Math.min(dur, basePos + elapsedSinceSync) : basePos + elapsedSinceSync;
      return {
        active: true,
        isPlaying: Boolean(np.isPlaying),
        processName: np.processName || np.appName || 'PC Medya',
        appName: np.appName || np.processName || 'PC Medya',
        title: np.title || np.appName || np.processName || 'Medya Oynatılıyor',
        positionSec: livePos,
        durationSec: dur
      };
    }
    const sessions = state.audio && Array.isArray(state.audio.sessions) ? state.audio.sessions : [];
    const playingSession = sessions.find((s) => s && s.isPlaying && !s.muted);
    if (playingSession) {
      return {
        active: true,
        isPlaying: true,
        processName: playingSession.processName || 'PC Medya',
        appName: playingSession.displayName || playingSession.processName || 'PC Medya',
        title: playingSession.displayName || playingSession.processName || 'Ses Oynatılıyor',
        positionSec: 0,
        durationSec: 0
      };
    }
    return null;
  }

  function updateMediaTimelineDom() {
    if (state.isSeekingMedia) return;
    const curEl = document.getElementById('mediaCurrentTime');
    const totEl = document.getElementById('mediaTotalTime');
    const seekEl = document.getElementById('mediaSeekSlider');
    if (!curEl || !totEl || !seekEl) return;

    const np = getEffectiveNowPlaying();
    if (!np || !np.active) {
      curEl.textContent = '00:00';
      totEl.textContent = '00:00';
      seekEl.max = 100;
      seekEl.value = 0;
      return;
    }

    const dur = Math.max(0, Number(np.durationSec || 0));
    const pos = Math.max(0, Math.min(dur > 0 ? dur : 99999, Number(np.positionSec || 0)));
    curEl.textContent = formatMediaTime(pos);
    totEl.textContent = formatMediaTime(dur);
    seekEl.max = dur > 0 ? dur : 100;
    seekEl.value = dur > 0 ? pos : 0;
  }

  function ensureMediaTimelineTicker() {
    if (state.mediaTimelineTickTimer) return;
    state.mediaTimelineTickTimer = setInterval(() => {
      if (!state.isAuthenticated) return;
      updateMediaTimelineDom();
    }, 1000);
  }

  function performMediaSeek(targetSec) {
    const posSec = Math.max(0, Math.round(Number(targetSec) || 0));
    if (state.audio && state.audio.nowPlaying) {
      state.audio.nowPlaying.positionSec = posSec;
      state.lastMediaSyncWallTs = Date.now();
    }
    updateMediaTimelineDom();
    state.lastMediaNotifHash = '';
    syncAndroidMediaNotification();

    sendCommand('audio_control', { action: 'seek', positionSec: posSec }, 3000)
      .then((audio) => {
        if (audio) {
          state.audio = reconcileMediaIntent(audio);
          state.lastMediaSyncWallTs = Date.now();
          renderAudioTab();
          syncAndroidMediaNotification();
        }
      })
      .catch(() => {});
  }

  window.__onAndroidMediaSeek = function (posSec) {
    performMediaSeek(posSec);
  };

  let lastMediaKeyActionTs = 0;
  // After a play/pause tap, status pushes that were captured before Windows applied the change must not
  // flip the button back. The intended state wins until the PC confirms it (or 3 s pass).
  let mediaPlayIntent = null;

  function reconcileMediaIntent(audio) {
    if (!audio || !audio.nowPlaying || !mediaPlayIntent) return audio;
    const np = audio.nowPlaying;
    if (Date.now() > mediaPlayIntent.until || Boolean(np.isPlaying) === mediaPlayIntent.isPlaying) {
      mediaPlayIntent = null;
      return audio;
    }
    return { ...audio, nowPlaying: { ...np, isPlaying: mediaPlayIntent.isPlaying } };
  }

  function triggerMediaKeyCommand(key) {
    if (!key) return;
    triggerHaptic(10);
    const now = Date.now();
    lastMediaKeyActionTs = now;

    // Optimistic instant Play/Pause toggle in UI + Notification Bar
    if (key === 'MEDIA_PLAY_PAUSE' && state.audio) {
      if (!state.audio.nowPlaying) {
        const eff = getEffectiveNowPlaying();
        if (eff) state.audio.nowPlaying = { ...eff };
      }
      if (state.audio.nowPlaying && (state.audio.nowPlaying.active || state.audio.nowPlaying.title)) {
        const effNow = getEffectiveNowPlaying();
        if (effNow) state.audio.nowPlaying.positionSec = effNow.positionSec;
        state.audio.nowPlaying.active = true;
        state.audio.nowPlaying.isPlaying = !state.audio.nowPlaying.isPlaying;
        mediaPlayIntent = { isPlaying: state.audio.nowPlaying.isPlaying, until: now + 3000 };
        state.lastMediaSyncWallTs = now;
        state.lastMediaNotifHash = '';
        renderAudioTab();
        syncAndroidMediaNotification();
      }
    }

    // The PC applies the command to the exact session shown here and replies with the settled state
    sendCommand('audio_control', { action: 'media_command', key }, 4000)
      .then((audio) => {
        if (audio && audio.nowPlaying) {
          state.audio = reconcileMediaIntent(audio);
          state.lastMediaSyncWallTs = Date.now();
          state.lastMediaNotifHash = '';
          renderAudioTab();
          syncAndroidMediaNotification();
        }
      })
      .catch(() => {});
  }

  window.__onAndroidMediaAction = function (key) {
    triggerMediaKeyCommand(key);
  };

  window.__triggerNativeQuickActionFast = function (quickAction, cmdId, targetDeviceId) {
    try {
      if (!state.ws || state.ws.readyState !== WebSocket.OPEN || !state.isAuthenticated) {
        return 'NO_WS';
      }
      if (targetDeviceId && state.activeDeviceId && state.activeDeviceId !== targetDeviceId) {
        return 'WRONG_DEVICE';
      }
      if (quickAction === 'monitors_on') {
        sendCommand('monitor_power', { action: 'on', clearBlackouts: true, cmdId }, 2000).catch(() => {});
      } else if (quickAction === 'monitors_off') {
        sendCommand('monitor_power', { action: 'off', cmdId }, 2000).catch(() => {});
      } else if (quickAction === 'toggle_lock') {
        sendCommand('system_control', { action: 'toggle_lock', cmdId }, 2000).catch(() => {});
      } else if (quickAction === 'sleep') {
        sendCommand('system_control', { action: 'sleep', cmdId }, 2000).catch(() => {});
      } else if (quickAction === 'shutdown') {
        sendCommand('system_control', { action: 'shutdown', cmdId }, 2000).catch(() => {});
      } else {
        return 'UNKNOWN';
      }
      return 'WS_DISPATCHED';
    } catch {
      return 'ERR';
    }
  };

  window.__onNativeQuickActionResult = function (quickAction, rawResponse) {
    try {
      let res = null;
      if (rawResponse && typeof rawResponse === 'string') {
        const parsed = JSON.parse(rawResponse);
        res = parsed && parsed.data !== undefined ? parsed.data : parsed;
      }
      if (quickAction === 'monitors_on') {
        const mons = Array.isArray(res) ? res : res && Array.isArray(res.monitors) ? res.monitors : null;
        if (mons) {
          state.monitors = mons;
          renderMonitorsTab();
        }
        showToast('Ekranlar açıldı');
      } else if (quickAction === 'monitors_off') {
        const mons = Array.isArray(res) ? res : res && Array.isArray(res.monitors) ? res.monitors : null;
        if (mons) {
          state.monitors = mons;
          renderMonitorsTab();
        }
        showToast('Ekranlar kapatıldı');
      } else if (quickAction === 'toggle_lock') {
        applyLockResult(res);
      } else if (quickAction === 'sleep') {
        showToast('Uyku modu komutu gönderildi');
      } else if (quickAction === 'shutdown') {
        showToast('Kapatma komutu gönderildi');
      }
    } catch {}
  };

  function syncAndroidMediaNotification() {
    try {
      if (userSettings && userSettings.mediaNotification === false) {
        if (state.lastMediaNotifHash !== 'CLEAR') {
          state.lastMediaNotifHash = 'CLEAR';
          if (window.TahaNative && typeof window.TahaNative.clearMediaNotification === 'function') {
            window.TahaNative.clearMediaNotification();
          }
        }
        return;
      }
      const np = getEffectiveNowPlaying();
      const dev = getActiveDevice();
      if (!state.isAuthenticated || !np || !np.active) {
        if (state.lastMediaNotifHash !== 'CLEAR') {
          state.lastMediaNotifHash = 'CLEAR';
          if (window.TahaNative && typeof window.TahaNative.clearMediaNotification === 'function') {
            window.TahaNative.clearMediaNotification();
          }
        }
        return;
      }

      const iconData = findIconForItem({ processName: np.processName, name: np.appName }) || '';
      const payload = {
        active: true,
        isPlaying: Boolean(np.isPlaying),
        appName: np.appName || np.processName || 'PC Medya',
        title: np.title || np.appName || 'Medya',
        deviceName: (dev && dev.deviceName) || 'Bilgisayar',
        positionSec: Math.max(0, Math.round(Number(np.positionSec || 0))),
        durationSec: Math.max(0, Math.round(Number(np.durationSec || 0))),
        icon: iconData
      };
      const hash = `${payload.isPlaying}|${payload.appName}|${payload.title}|${payload.durationSec}|${Math.floor(payload.positionSec / 4)}|${iconData.length}`;
      if (hash === state.lastMediaNotifHash) return;
      state.lastMediaNotifHash = hash;

      if (window.TahaNative && typeof window.TahaNative.updateMediaNotification === 'function') {
        window.TahaNative.updateMediaNotification(JSON.stringify(payload));
      }
    } catch {}
  }

  // TAB 4: AUDIO MIXER, NOW PLAYING & POWER TIMER
  function renderAudioTab() {
    const slider = document.getElementById('masterVolumeSlider');
    const valEl = document.getElementById('masterVolumeValue');
    const muteBtn = document.getElementById('masterMuteBtn');
    const listEl = document.getElementById('appAudioSessionsContainer');
    const npBanner = document.getElementById('nowPlayingBanner');

    if (npBanner) {
      const np = getEffectiveNowPlaying();
      const npTitleEl = document.getElementById('nowPlayingTitle');
      const npIconBox = document.getElementById('nowPlayingIconBox');
      const playPauseBtn = document.querySelector('[data-key="MEDIA_PLAY_PAUSE"]');

      if (np && np.active) {
        if (npTitleEl) {
          npTitleEl.textContent = np.title || np.appName || 'Medya Oynatılıyor';
        }
        if (npIconBox) {
          const iconUrl = findIconForItem({ processName: np.processName, name: np.appName });
          if (iconUrl && iconUrl.startsWith('data:image/')) {
            npIconBox.innerHTML = `<img class="app-real-icon" src="${safeImageSrc(iconUrl)}" alt="${escapeHtml(np.appName || '')}" />`;
          } else {
            npIconBox.innerHTML = `
              <svg class="sys-pack-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6">
                <circle cx="10" cy="10" r="7" />
                ${
                  np.isPlaying
                    ? '<path d="M8 7v6M12 7v6" stroke-linecap="round" />'
                    : '<path d="M8.5 7.5l4.5 2.5-4.5 2.5v-5z" stroke-linejoin="round" />'
                }
              </svg>
            `;
          }
        }
        if (playPauseBtn) {
          playPauseBtn.innerHTML = np.isPlaying
            ? `<svg class="transport-svg" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7.5 5v10M12.5 5v10" stroke-linecap="round" /></svg>`
            : `<svg class="transport-svg" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6.5 4.5l8 5.5-8 5.5V4.5z" stroke-linejoin="round" /></svg>`;
        }
      } else {
        if (npTitleEl) npTitleEl.textContent = 'Medya Bekleniyor';
        if (npIconBox) {
          npIconBox.innerHTML = `
            <svg class="sys-pack-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6">
              <circle cx="10" cy="10" r="7" />
              <path d="M8.5 7.5l4.5 2.5-4.5 2.5v-5z" stroke-linejoin="round" />
            </svg>
          `;
        }
        if (playPauseBtn) {
          playPauseBtn.innerHTML = `
            <svg class="transport-svg" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7">
              <path d="M5.5 4.5l7 5.5-7 5.5V4.5z" stroke-linejoin="round" />
              <path d="M15 5v10" stroke-linecap="round" />
            </svg>
          `;
        }
      }
      updateMediaTimelineDom();
    }

    if (slider && valEl && muteBtn) {
      slider.value = state.audio.masterVolume ?? 100;
      valEl.textContent = `${state.audio.masterVolume ?? 100}%`;
      muteBtn.innerHTML = state.audio.masterMuted
        ? `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 5L5.5 8H3v4h2.5L9 15V5z" stroke-linejoin="round" /><path d="M13 8l4 4M17 8l-4 4" stroke-linecap="round" /></svg>`
        : `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 5L5.5 8H3v4h2.5L9 15V5z" stroke-linejoin="round" /><path d="M12.5 7.5a3.5 3.5 0 0 1 0 5M15 5a7 7 0 0 1 0 10" stroke-linecap="round" /></svg>`;
    }

    const micMuteBtn = document.getElementById('micMuteBtn');
    if (micMuteBtn) {
      const micMuted = Boolean(state.audio && state.audio.micMuted);
      micMuteBtn.classList.toggle('is-muted', micMuted);
      micMuteBtn.innerHTML = micMuted
        ? `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="7" y="2.5" width="6" height="9.5" rx="3" /><path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5M7 17.5h6M3.5 3.5l13 13" stroke-linecap="round" /></svg>`
        : `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="7" y="2.5" width="6" height="9.5" rx="3" /><path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5M7 17.5h6" stroke-linecap="round" /></svg>`;
    }

    const devRow = document.getElementById('audioOutputDeviceRow');
    const devSelect = document.getElementById('audioOutputDeviceSelect');
    if (devRow && devSelect) {
      const outDevs = Array.isArray(state.audio && state.audio.outputDevices) ? state.audio.outputDevices : [];
      if (outDevs.length > 0) {
        devRow.classList.remove('hidden');
        devSelect.innerHTML = outDevs
          .map((d) => `<option value="${escapeHtml(d.id)}" ${d.isDefault ? 'selected' : ''}>${escapeHtml(d.name || d.id)}</option>`)
          .join('');
      } else {
        devRow.classList.add('hidden');
      }
    }

    if (!listEl) return;
    const sessions = Array.isArray(state.audio.sessions) ? state.audio.sessions : [];
    if (!sessions.length) {
      listEl.innerHTML = `<div class="sub-panel"><p class="section-subtitle">Aktif ses çalan uygulama tespit edilmedi.</p></div>`;
      return;
    }

    listEl.innerHTML = sessions
      .map(
        (s) => `
        <div class="app-audio-card">
          <div class="audio-row-top">
            <span class="audio-label">${escapeHtml(s.displayName || s.processName)}</span>
            <div class="audio-row-right">
              <span class="mono-stat" id="appVolLabel-${s.pid}">${s.volume}%</span>
              <button
                type="button"
                class="icon-btn icon-btn-sm"
                data-app-mute-pid="${s.pid}"
                data-app-muted="${s.muted ? '1' : '0'}"
                title="${s.muted ? 'Sesi Aç' : 'Sessiz'}"
              >
                ${
                  s.muted
                    ? '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 5L5.5 8H3v4h2.5L9 15V5z" stroke-linejoin="round" /><path d="M13 8l4 4M17 8l-4 4" stroke-linecap="round" /></svg>'
                    : '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 5L5.5 8H3v4h2.5L9 15V5z" stroke-linejoin="round" /><path d="M13 8a3 3 0 0 1 0 4" stroke-linecap="round" /></svg>'
                }
              </button>
            </div>
          </div>
          <input
            type="range"
            class="volume-slider"
            min="0"
            max="100"
            value="${s.volume}"
            data-app-vol-pid="${s.pid}"
          />
        </div>
      `
      )
      .join('');
  }

  function renderPowerTimerStatus() {
    const badge = document.getElementById('powerTimerStatusBadge');
    if (!badge) return;
    if (!state.powerTimer || !state.powerTimer.active) {
      badge.textContent = 'KAPALI';
      return;
    }
    const mins = Math.max(1, Math.ceil((state.powerTimer.remainingSec || 0) / 60));
    const targetMs =
      state.powerTimer.targetTs && state.powerTimer.targetTs > Date.now()
        ? state.powerTimer.targetTs
        : Date.now() + (state.powerTimer.remainingSec || mins * 60) * 1000;
    const targetDate = new Date(targetMs);
    const hh = String(targetDate.getHours()).padStart(2, '0');
    const mm = String(targetDate.getMinutes()).padStart(2, '0');
    const modeNames = {
      sleep: 'UYKU',
      monitors_off: 'EKRAN',
      shutdown: 'KAPATMA'
    };
    badge.textContent = `${modeNames[state.powerTimer.mode] || 'SAYAÇ'} · ${mins} DK (${hh}:${mm})`;
  }

  // DEVICE SWITCHER & PURE DYNAMIC LAN + WAN RENDEZVOUS DISCOVERY
  function renderSavedDevicesList() {
    const container = document.getElementById('savedDevicesList');
    const hubContainer = document.getElementById('hubSavedDevicesList');
    const hubSection = document.getElementById('hubSavedDevicesSection');

    if (hubSection) {
      hubSection.classList.toggle('hidden', state.devices.length === 0);
    }

    if (!state.devices.length) {
      if (container) {
        container.innerHTML = `<div class="sub-panel"><p class="section-subtitle">Kayıtlı bilgisayar bulunmuyor.</p></div>`;
      }
      if (hubContainer) {
        hubContainer.innerHTML = '';
      }
      return;
    }

    const activePairedDevices = state.devices.filter((d) => Boolean(d.authToken && !d.connectionRevoked));
    const revokedDevices = state.devices.filter((d) => Boolean(!d.authToken || d.connectionRevoked));

    const renderSingleRow = (d, isHub) => {
      const isRevoked = Boolean(!d.authToken || d.connectionRevoked);
      const isSel = d.deviceId === state.activeDeviceId && !isRevoked;
      const isOnlineNow = isSel && state.isAuthenticated && state.connectedRoute;
      const routeHint = isRevoked
        ? 'Bilgisayar üzerinden bağlantı koparıldı · Yeni kod ile eşleştirin'
        : isOnlineNow
        ? `AKTİF · ${state.connectedRoute}`
        : d.syncTopic
        ? 'LAN + Bulut Tüneli'
        : `IP: ${d.lanIp || '-'}`;
      const pillClass = isRevoked ? 'is-revoked' : isOnlineNow ? 'is-online' : '';
      const pillText = isRevoked ? 'BAĞLANTI KOPARILDI' : isOnlineNow ? 'AKTİF' : 'KAYITLI';
      return `
        <div class="device-row-card ${isSel ? 'is-selected' : ''} ${isRevoked ? 'is-revoked' : ''}" data-select-device="${escapeHtml(d.deviceId)}" ${
        isHub ? `data-hub-device-id="${escapeHtml(d.deviceId)}"` : ''
      }>
          <div class="device-row-main">
            <div class="device-row-title">${escapeHtml(d.deviceName || d.lanIp)}</div>
            <div class="device-row-sub">${escapeHtml(routeHint)}${
        isHub && !isRevoked ? ' · Detay için basılı tutun' : ''
      }</div>
          </div>
          <div class="device-row-right">
            <span class="device-row-status-pill ${pillClass}">${pillText}</span>
            <svg class="device-row-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
          </div>
        </div>
      `;
    };

    const buildRowsHtml = (isHub) => {
      let html = activePairedDevices.map((d) => renderSingleRow(d, isHub)).join('');
      if (revokedDevices.length > 0) {
        if (activePairedDevices.length > 0) {
          html += `<div class="revoked-devices-divider"><span>Bağlantısı Koparılan Bilgisayarlar</span></div>`;
        }
        html += revokedDevices.map((d) => renderSingleRow(d, isHub)).join('');
      }
      return html;
    };

    if (container) container.innerHTML = buildRowsHtml(false);
    if (hubContainer) hubContainer.innerHTML = buildRowsHtml(true);
  }

  function openDeviceDetailModal(dev) {
    if (!dev) return;
    state.inspectingDeviceId = dev.deviceId;
    const titleEl = document.getElementById('deviceDetailModalTitle');
    const subEl = document.getElementById('deviceDetailModalSubtitle');
    const gridEl = document.getElementById('deviceDetailInfoGrid');
    const wolBtn = document.getElementById('detailModalWolBtn');
    const discBtn = document.getElementById('detailModalDisconnectBtn');

    const isRevoked = Boolean(!dev.authToken || dev.connectionRevoked);
    const isSel = dev.deviceId === state.activeDeviceId && !isRevoked;
    const isOnlineNow = isSel && state.isAuthenticated && state.connectedRoute;

    if (titleEl) titleEl.textContent = dev.deviceName || dev.lanIp || 'Bilgisayar';
    if (subEl) {
      subEl.textContent = isRevoked
        ? 'Bağlantı Koparıldı (Oturum Sonlandırıldı)'
        : isOnlineNow
        ? `Şu an bağlı (${state.connectedRoute})`
        : 'Kayıtlı Bilgisayar';
    }

    if (gridEl) {
      const rows = [
        {
          label: 'Durum',
          val: isRevoked ? 'Bağlantı Koparıldı (Yeni Kod Gerekli)' : isOnlineNow ? 'Çevrimiçi (Aktif)' : 'Bağlı Değil'
        },
        { label: 'Bağlantı Kanalı', val: isOnlineNow ? state.connectedRoute : dev.syncTopic ? 'LAN + Bulut Tüneli' : 'Yerel Ağ' },
        { label: 'Yerel IP Adresi', val: dev.lanIp || '-' },
        { label: 'MAC Adresi (WoL)', val: dev.macAddress || 'Bilinmiyor' },
        { label: 'Ekran Sayısı', val: dev.monitorCount ? `${dev.monitorCount} Monitör` : '2 Monitör' },
      ];
      gridEl.innerHTML = rows
        .map(
          (r) => `
          <div class="device-detail-row">
            <span class="device-detail-label">${escapeHtml(r.label)}</span>
            <span class="device-detail-val">${escapeHtml(String(r.val))}</span>
          </div>
        `
        )
        .join('');
    }

    if (wolBtn) {
      wolBtn.classList.toggle('hidden', !dev.macAddress || isRevoked);
    }
    if (discBtn) {
      discBtn.classList.toggle('hidden', !isOnlineNow);
    }

    openModal('deviceDetailModal');
  }

  let scanInFlightPromise = null;

  async function scanNetworkForDevices() {
    if (scanInFlightPromise) return scanInFlightPromise;

    const hubList = document.getElementById('hubDiscoveredList');
    const modalList = document.getElementById('discoveredDevicesList');
    const loadingHtml = `<div class="sub-panel"><p class="section-subtitle">Ağdaki bilgisayarlar taranıyor...</p></div>`;
    if (hubList && !state.discoveredDevices.length) hubList.innerHTML = loadingHtml;
    if (modalList && !state.discoveredDevices.length) modalList.innerHTML = loadingHtml;

    scanInFlightPromise = (async () => {
      try {
        const foundMap = new Map();

        // Probe saved device LAN IPs + common local / hotspot / Tailscale IPs in parallel with async Native UDP/TCP scan
        const dynamicHosts = new Set();
        if (
          window.location.hostname &&
          !window.location.hostname.startsWith('file') &&
          window.location.hostname !== 'localhost'
        ) {
          dynamicHosts.add(window.location.hostname);
        }
        for (const d of state.devices) {
          if (d.lanIp && d.lanIp !== '-') dynamicHosts.add(d.lanIp);
          if (Array.isArray(d.lanIps)) {
            d.lanIps.forEach((ip) => {
              if (ip && ip !== '-') dynamicHosts.add(ip);
            });
          }
          if (d.tailscaleIp && d.tailscaleIp !== '-') dynamicHosts.add(d.tailscaleIp);
        }

        const httpProbePromise = Promise.all(
          Array.from(dynamicHosts).map(async (host) => {
            try {
              const controller = new AbortController();
              const t = setTimeout(() => controller.abort(), 950);
              const resp = await fetch(`http://${host}:4850/api/discover`, { signal: controller.signal });
              clearTimeout(t);
              if (resp.ok) {
                const info = await resp.json();
                if (info && info.deviceId) foundMap.set(info.deviceId, info);
              }
            } catch {}
          })
        );

        const nativeScanPromise = nativeDiscoverDevicesAsync().then((arr) => {
          if (Array.isArray(arr)) {
            for (const item of arr) {
              if (item && item.deviceId) foundMap.set(item.deviceId, item);
            }
          }
        });

        await Promise.all([httpProbePromise, nativeScanPromise]);

        const discovered = Array.from(foundMap.values());
        state.discoveredDevices = discovered;

        const emptyHtml = `<div class="sub-panel"><p class="section-subtitle">Yerel Wi-Fi üzerinde bilgisayar bulunamadı. Mobil verideyseniz (4.5G/5G) sadece aşağıya güvenlik kodunu (XXX-XXX) girerek doğrudan eşleştirebilirsiniz.</p></div>`;

        if (!discovered.length) {
          if (hubList) hubList.innerHTML = emptyHtml;
          if (modalList) modalList.innerHTML = emptyHtml;
          return discovered;
        }

        for (const disc of discovered) {
          const saved = state.devices.find((d) => d.deviceId === disc.deviceId);
          if (saved) {
            saved.lanIp = disc.lanIp || saved.lanIp;
            if (Array.isArray(disc.lanIps)) saved.lanIps = disc.lanIps;
            if (disc.tailscaleIp && disc.tailscaleIp !== '-') saved.tailscaleIp = disc.tailscaleIp;
            saved.subnetBroadcast = disc.subnetBroadcast || saved.subnetBroadcast;
            if (Array.isArray(disc.subnetBroadcasts)) saved.subnetBroadcasts = disc.subnetBroadcasts;
            saved.macAddress = disc.macAddress || saved.macAddress;
            if (Array.isArray(disc.macAddresses)) saved.macAddresses = disc.macAddresses;
            saved.tunnelUrl = disc.tunnelUrl || saved.tunnelUrl;
            saved.wsTunnelUrl = disc.wsTunnelUrl || saved.wsTunnelUrl;
            saved.syncTopic = disc.syncTopic || saved.syncTopic;
            saveDevicesToStorage();
          }
        }

        const cardsHtml = discovered
          .map(
            (d) => `
            <div class="device-row-card">
              <div class="device-row-main">
                <div class="device-row-title">${escapeHtml(d.deviceName)}</div>
                <div class="device-row-sub">Yerel Ağ: ${escapeHtml(d.lanIp)}${d.monitorCount ? ' · ' + d.monitorCount + ' Ekran' : ''}</div>
              </div>
              <button
                type="button"
                class="btn-primary btn-compact"
                data-fill-pair-ip="${escapeHtml(d.lanIp)}"
              >
                Seç
              </button>
            </div>
          `
          )
          .join('');

        if (hubList) hubList.innerHTML = cardsHtml;
        if (modalList) modalList.innerHTML = cardsHtml;
        return discovered;
      } finally {
        scanInFlightPromise = null;
      }
    })();

    return scanInFlightPromise;
  }

  function sha256HexAscii(ascii) {
    const rightRotate = (value, amount) => (value >>> amount) | (value << (32 - amount));
    const mathPow = Math.pow;
    const maxWord = mathPow(2, 32);
    let result = '';
    const words = [];
    const asciiBitLength = ascii.length * 8;
    let hash = [];
    const k = [];
    let primeCounter = 0;
    const isComposite = {};
    for (let candidate = 2; primeCounter < 64; candidate++) {
      if (!isComposite[candidate]) {
        for (let i = 0; i < 313; i += candidate) isComposite[i] = candidate;
        hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0;
        k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
      }
    }
    ascii += '\x80';
    while ((ascii.length % 64) - 56) ascii += '\x00';
    for (let i = 0; i < ascii.length; i++) {
      const j = ascii.charCodeAt(i);
      words[i >> 2] |= j << (((3 - i) % 4) * 8);
    }
    words[words.length] = (asciiBitLength / maxWord) | 0;
    words[words.length] = asciiBitLength;
    for (let j = 0; j < words.length; ) {
      const w = words.slice(j, (j += 16));
      const oldHash = hash.slice(0);
      for (let i = 0; i < 64; i++) {
        const w15 = w[i - 15];
        const w2 = w[i - 2];
        const a = hash[0];
        const e = hash[4];
        const temp1 =
          hash[7] +
          (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25)) +
          ((e & hash[5]) ^ (~e & hash[6])) +
          k[i] +
          (w[i] =
            i < 16
              ? w[i]
              : (w[i - 16] +
                  (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3)) +
                  w[i - 7] +
                  (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))) |
                0);
        const temp2 =
          (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22)) +
          ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
        hash = [(temp1 + temp2) | 0].concat(hash);
        hash[4] = (hash[4] + temp1) | 0;
        hash.pop();
      }
      for (let i = 0; i < 8; i++) hash[i] = (hash[i] + oldHash[i]) | 0;
    }
    for (let i = 0; i < 8; i++) {
      for (let j = 3; j + 1; j--) {
        const b = (hash[i] >> (j * 8)) & 255;
        result += (b < 16 ? 0 : '') + b.toString(16);
      }
    }
    return result;
  }

  async function resolvePinRendezvousNonBlocking(pin) {
    const cleanPin = String(pin || '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
    if (!cleanPin) return null;
    const topic = 'tahablt_pin_' + sha256HexAscii('tahablt_v2_' + cleanPin).slice(0, 20);

    const attemptOnce = async () => {
      const browserPromise = fetchWanSyncInfo(topic, true, cleanPin);
      const nativePromise = (async () => {
        if (window.TahaNative && typeof window.TahaNative.resolvePinRendezvousAsync === 'function') {
          const raw = await callNativeAsync('resolvePinRendezvousAsync', [cleanPin], 4500);
          try {
            const parsed = sanitizeWanSync(JSON.parse(raw || '{}'), cleanPin);
            if (parsed && (parsed.tunnelUrl || parsed.lanIp)) return parsed;
          } catch {}
        }
        return null;
      })();

      const first = await Promise.race([browserPromise, nativePromise]);
      if (first && (first.tunnelUrl || first.lanIp)) return first;
      const [bRes, nRes] = await Promise.all([browserPromise, nativePromise]);
      return (bRes && bRes.tunnelUrl ? bRes : null) || (nRes && nRes.tunnelUrl ? nRes : null) || bRes || nRes || null;
    };

    let res = await attemptOnce();
    if (!res || (!res.tunnelUrl && !res.lanIp)) {
      await new Promise((r) => setTimeout(r, 650));
      res = await attemptOnce();
    }
    return res;
  }

  function racePairCandidates(baseUrls, pin) {
    const unique = Array.from(new Set(baseUrls.map((u) => String(u || '').replace(/\/+$/, '')).filter(Boolean)));
    if (!unique.length) return Promise.resolve({ device: null, codeRejected: false });

    const bodyStr = JSON.stringify({ pin, ...getClientIdentity() });
    return new Promise((resolve) => {
      let settled = false;
      let remaining = unique.length;
      let codeRejected = false;
      let responded = false;

      unique.forEach((cleanBase) => {
        const isTunnel = cleanBase.includes('.trycloudflare.com');
        const timeoutMs = isTunnel ? 7000 : 1500;
        asyncHttpPostJson(`${cleanBase}/api/pair`, bodyStr, timeoutMs)
          .then((data) => {
            if (settled) return;
            if (data) responded = true;
            if (data && data.ok && data.device) {
              settled = true;
              resolve({ device: data.device, codeRejected: false, responded: true });
              return;
            }
            if (
              data &&
              (data._httpStatus === 401 ||
                data.httpStatus === 401 ||
                data._httpStatus === 429 ||
                data.httpStatus === 429 ||
                (data.error &&
                  (String(data.error).includes('Geçersiz') ||
                    String(data.error).includes('süresi dolmuş') ||
                    String(data.error).includes('Çok fazla'))))
            ) {
              codeRejected = true;
            }
            remaining--;
            if (remaining === 0 && !settled) {
              settled = true;
              resolve({ device: null, codeRejected, responded });
            }
          })
          .catch(() => {
            remaining--;
            if (remaining === 0 && !settled) {
              settled = true;
              resolve({ device: null, codeRejected, responded });
            }
          });
      });
    });
  }

  let isPairingInFlight = false;

  async function performDevicePairing(rawHostInput, rawPinInput) {
    if (isPairingInFlight) return;
    const pin = String(rawPinInput || '')
      .trim()
      .toUpperCase();
    const host = String(rawHostInput || '').trim();
    if (!pin) {
      showToast('Lütfen güvenlik kodunu girin');
      return;
    }

    isPairingInFlight = true;
    const submitBtns = document.querySelectorAll('#hubPairForm button[type="submit"], #pairDeviceForm button[type="submit"]');
    const origTexts = Array.from(submitBtns).map((b) => b.textContent);
    submitBtns.forEach((b) => {
      b.disabled = true;
      b.textContent = 'Bağlanıyor...';
    });

    try {
      showToast('Bilgisayar eşleştiriliyor...');

      const addDeviceEndpointsToSet = (targetSet, d, includeTunnels = true) => {
        if (!d) return;
        const p = d.port || 4850;
        if (d.lanIp && d.lanIp !== '-') targetSet.add(`http://${d.lanIp}:${p}`);
        if (Array.isArray(d.lanIps)) {
          d.lanIps.forEach((ip) => {
            if (ip && ip !== '-') targetSet.add(`http://${ip}:${p}`);
          });
        }
        if (d.tailscaleIp && d.tailscaleIp !== '-') targetSet.add(`http://${d.tailscaleIp}:${p}`);
        if (includeTunnels) {
          if (d.tunnelUrl) targetSet.add(d.tunnelUrl);
          if (Array.isArray(d.recentTunnelUrls)) {
            d.recentTunnelUrls.forEach((tu) => {
              if (tu) targetSet.add(tu);
            });
          }
        }
      };

      const savedDeviceEndpoints = new Set();
      for (const d of state.devices) addDeviceEndpointsToSet(savedDeviceEndpoints, d, true);

      const wave1Set = new Set();

      // 1. Explicit IP or Tunnel URL if provided
      if (host) {
        if (host.startsWith('http://') || host.startsWith('https://')) {
          wave1Set.add(host);
        } else if (host.includes('.trycloudflare.com')) {
          wave1Set.add(`https://${host}`);
        } else {
          wave1Set.add(host.includes(':') ? `http://${host}` : `http://${host}:4850`);
        }
      }

      // 2. Discovered LAN devices & fast LAN-only endpoints (never block Wave 1 on old saved Cloudflare tunnels)
      for (const d of state.discoveredDevices) addDeviceEndpointsToSet(wave1Set, d, false);
      for (const d of state.devices) addDeviceEndpointsToSet(wave1Set, d, false);

      const completePairingSuccess = (pairedDev) => {
        upsertDevice(pairedDev);
        const p1 = document.getElementById('pairPinInput');
        const p2 = document.getElementById('hubPinInput');
        if (p1) p1.value = '';
        if (p2) p2.value = '';
        closeModal('deviceSheetModal');
        logAuditEvent('security', `${pairedDev.deviceName} tek kullanımlık 8 haneli kod ile eşleştirildi`);
        showToast(`${pairedDev.deviceName} başarıyla eşleştirildi`);
        connectToActiveDevice(false);
      };

      // Start all 3 tracks in parallel from millisecond 0 so 4.5G/Tunnel never waits behind LAN timeouts!
      let completedWinner = null;
      let anyTargetRejected = false;
      // Which step failed, so the error tells the user what to fix instead of a generic "unreachable"
      let rendezvousTunnelUrl = '';
      let tunnelAnswered = false;

      const trackLanDirect = (async () => {
        const r1 = await racePairCandidates(Array.from(wave1Set), pin);
        if (r1 && r1.device && !completedWinner) {
          completedWinner = r1.device;
        }
        return r1;
      })();

      const trackPinRendezvous = (async () => {
        const pinSynced = await resolvePinRendezvousNonBlocking(pin);
        if (completedWinner) return { device: completedWinner, codeRejected: false };
        if (pinSynced) {
          if (pinSynced.tunnelUrl) rendezvousTunnelUrl = pinSynced.tunnelUrl;
          const pinUrls = new Set();
          addDeviceEndpointsToSet(pinUrls, pinSynced, true);
          const rPin = await racePairCandidates(Array.from(pinUrls), pin);
          if (rPin && rPin.device && !completedWinner) {
            completedWinner = rPin.device;
          }
          if (rPin && rPin.responded) tunnelAnswered = true;
          if (rPin && rPin.codeRejected) anyTargetRejected = true;
          return rPin;
        }
        return { device: null, codeRejected: false };
      })();

      const trackSubnetScan = (async () => {
        const scannedDevices = await nativeDiscoverDevicesAsync();
        if (completedWinner) return { device: completedWinner, codeRejected: false };
        if (Array.isArray(scannedDevices) && scannedDevices.length > 0) {
          const scanUrls = new Set();
          for (const d of scannedDevices) addDeviceEndpointsToSet(scanUrls, d, true);
          const rScan = await racePairCandidates(Array.from(scanUrls), pin);
          if (rScan && rScan.device && !completedWinner) {
            completedWinner = rScan.device;
          }
          if (rScan && rScan.codeRejected) anyTargetRejected = true;
          return rScan;
        }
        return { device: null, codeRejected: false };
      })();

      // Resolve as soon as ANY of the 3 parallel tracks finds and pairs the device!
      const raceWinnerDevice = await new Promise((resolve) => {
        let pendingCount = 3;
        const checkTrack = (trackPromise) => {
          trackPromise
            .then((res) => {
              if (res && res.device) {
                resolve(res.device);
                return;
              }
              pendingCount--;
              if (pendingCount === 0) resolve(completedWinner || null);
            })
            .catch(() => {
              pendingCount--;
              if (pendingCount === 0) resolve(completedWinner || null);
            });
        };
        checkTrack(trackLanDirect);
        checkTrack(trackPinRendezvous);
        checkTrack(trackSubnetScan);
      });

      if (raceWinnerDevice) {
        completePairingSuccess(raceWinnerDevice);
        return;
      }

      const [r1Final] = await Promise.all([trackLanDirect, trackPinRendezvous, trackSubnetScan]);

      // Final fallback: fresh PIN Rendezvous + saved tunnels in case cloudflared tunnel just finished registering
      const freshPinSynced = await resolvePinRendezvousNonBlocking(pin);
      if (freshPinSynced && freshPinSynced.tunnelUrl) rendezvousTunnelUrl = freshPinSynced.tunnelUrl;
      const wave3Set = new Set();
      if (freshPinSynced) addDeviceEndpointsToSet(wave3Set, freshPinSynced, true);
      for (const d of state.devices) {
        if (d.tunnelUrl) wave3Set.add(d.tunnelUrl);
      }
      const wave3Urls = Array.from(wave3Set);
      if (wave3Urls.length > 0) {
        const wave3Result = await racePairCandidates(wave3Urls, pin);
        if (wave3Result.device) {
          completePairingSuccess(wave3Result.device);
          return;
        }
        if (wave3Result.responded) tunnelAnswered = true;
        if (freshPinSynced) {
          anyTargetRejected = anyTargetRejected || wave3Result.codeRejected;
        }
      }

      const onlyOneTarget = state.devices.length === 0 && r1Final && r1Final.codeRejected;
      if (anyTargetRejected || onlyOneTarget) {
        showToast('Eşleştirme kodu hatalı veya süresi doldu.');
      } else if (rendezvousTunnelUrl && !tunnelAnswered) {
        let host = rendezvousTunnelUrl;
        try {
          host = new URL(rendezvousTunnelUrl).host;
        } catch {}
        showToast(`Bilgisayar bulundu ama tünel adresine (${host}) bu ağdan ulaşılamadı. DNS/reklam engelleyici veya VPN trycloudflare.com'u engelliyor olabilir.`);
      } else if (!rendezvousTunnelUrl && !state.discoveredDevices.length) {
        showToast('Bu kod için bilgisayar bulunamadı. Kodun süresi dolmuş olabilir ya da PC internete bağlı değil; yeni kod alıp tekrar deneyin.');
      } else {
        showToast('Yeni bilgisayara ulaşılamadı. Aynı ağda olduğunuzdan veya PC internetinin açık olduğundan emin olun.');
      }
    } finally {
      isPairingInFlight = false;
      submitBtns.forEach((b, i) => {
        b.disabled = false;
        b.textContent = origTexts[i] || 'Cihazı Eşleştir ve Bağlan';
      });
    }
  }

  // POWER-ON (WAKE-ON-LAN) & LIVE BOOT WATCHER
  function stopBootWatcher() {
    if (state.bootWatchTimer) {
      clearInterval(state.bootWatchTimer);
      state.bootWatchTimer = null;
    }
    const box = document.getElementById('bootWatcherBox');
    if (box) box.classList.add('hidden');
  }

  async function triggerPowerOn(device) {
    if (!device) {
      showToast('Cihaz seçilmedi');
      return;
    }
    triggerHaptic(24);

    const allMacs = Array.from(
      new Set([device.macAddress, ...(Array.isArray(device.macAddresses) ? device.macAddresses : [])].filter(Boolean))
    );
    if (!allMacs.length) {
      showToast('MAC adresi kayıtlı değil. Bilgisayar açıkken bir kez bağlanın.');
      return;
    }

    const macListStr = allMacs.join(',');
    const bcastListStr = Array.from(
      new Set([
        device.subnetBroadcast || '255.255.255.255',
        ...(Array.isArray(device.subnetBroadcasts) ? device.subnetBroadcasts : [])
      ].filter(Boolean))
    ).join(',');
    const hostListStr = Array.from(
      new Set([device.lanIp || '', ...(Array.isArray(device.lanIps) ? device.lanIps : [])].filter((x) => x && x !== '-'))
    ).join(',');

    const sendWolPacketsNow = () => {
      if (window.TahaNative && typeof window.TahaNative.powerOnDevice === 'function') {
        try {
          window.TahaNative.powerOnDevice(macListStr, bcastListStr, hostListStr, 9);
        } catch {}
      } else if (window.TahaNative && typeof window.TahaNative.wakeOnLan === 'function') {
        try {
          window.TahaNative.wakeOnLan(macListStr);
        } catch {}
      }
    };

    sendWolPacketsNow();

    stopBootWatcher();
    const box = document.getElementById('bootWatcherBox');
    const timerEl = document.getElementById('bootWatcherTimer');
    const descEl = document.getElementById('bootWatcherDesc');
    if (box) box.classList.remove('hidden');

    state.bootWatchStartedAt = Date.now();
    showToast(`${device.deviceName} için Power-On sinyali gönderildi`);

    state.bootWatchTimer = setInterval(async () => {
      const elapsedSec = Math.round((Date.now() - state.bootWatchStartedAt) / 1000);
      if (timerEl) timerEl.textContent = `${elapsedSec}s`;

      if (elapsedSec > 65) {
        stopBootWatcher();
        return;
      }

      if (elapsedSec === 4 || elapsedSec === 9 || elapsedSec === 15) {
        sendWolPacketsNow();
      }

      if (descEl) {
        descEl.textContent = elapsedSec < 10
          ? 'Anakart ağ kartına Magic Packet iletildi, sistem başlatılıyor...'
          : 'Windows servisinin ağa veya bulut tüneline katılması bekleniyor...';
      }

      const ok = await connectToActiveDevice(true);
      if (ok) {
        stopBootWatcher();
      }
    }, 2200);
  }

  function renderCustomAppPickerList(listElId, hiddenInputId, filterQuery) {
    const listEl = document.getElementById(listElId);
    const hiddenInput = document.getElementById(hiddenInputId);
    if (!listEl) return;

    const apps = state.installedApps || [];
    if (!apps.length) {
      listEl.innerHTML = `<p class="section-subtitle">Uygulama bulunamadı.</p>`;
      return;
    }

    const q = String(filterQuery || '').trim().toLowerCase();
    const selectedIdx = Number(hiddenInput ? hiddenInput.value : 0);

    const matched = apps
      .map((app, idx) => ({ app, idx }))
      .filter(({ app }) => {
        if (!q) return true;
        return (
          String(app.name || '').toLowerCase().includes(q) ||
          String(app.processName || '').toLowerCase().includes(q)
        );
      });

    if (!matched.length) {
      listEl.innerHTML = `<p class="section-subtitle">Aramayla eşleşen uygulama yok.</p>`;
      return;
    }

    listEl.innerHTML = matched
      .map(({ app, idx }) => {
        const isSel = idx === selectedIdx;
        return `
          <button
            type="button"
            class="app-picker-item ${isSel ? 'is-selected' : ''}"
            data-picker-app-idx="${idx}"
          >
            <div class="app-picker-icon-box">
              ${renderAppIconHtml(app.icon || findIconForItem(app), app.name)}
            </div>
            <span class="app-picker-name">${escapeHtml(app.name)}</span>
          </button>
        `;
      })
      .join('');
  }

  // VISUAL SCENE COMPOSER LOGIC
  function openSceneComposer(existingScene) {
    state.editingSceneId = existingScene ? existingScene.id : null;
    state.composerItems = existingScene && Array.isArray(existingScene.items)
      ? JSON.parse(JSON.stringify(existingScene.items))
      : [];
    state.composerTargetMonitor = 0;
    state.composerTargetZone = 'fullscreen';
    state.composerTargetVisibility = 'foreground';

    document.querySelectorAll('#ruleVisibilityPills .segment-btn').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-scene-vis') === 'foreground');
    });

    document.getElementById('sceneModalTitle').textContent = existingScene ? 'Sahneyi Düzenle' : 'Sıfırdan Sahne Oluştur';
    document.getElementById('sceneNameInput').value = existingScene ? existingScene.name : '';
    const otherSel = document.getElementById('sceneOtherWindowsSelect');
    if (otherSel) {
      otherSel.value = (existingScene && existingScene.otherWindowsMode) || 'keep';
    }

    populateAppDropdown();
    renderComposerMonitorPills();
    renderComposerBlueprintAndList();
    openModal('sceneComposerModal');

    if (!state.installedApps || state.installedApps.length === 0) {
      sendCommand('get_installed_apps')
        .then((res) => {
          if (res && Array.isArray(res.installed) && res.installed.length > 0) {
            state.installedApps = res.installed;
            populateAppDropdown();
          }
        })
        .catch(() => {});
    }
  }

  function populateAppDropdown() {
    const sel = document.getElementById('appSelectDropdown');
    const searchInput = document.getElementById('sceneAppSearchInput');
    if (sel) sel.value = '0';
    if (searchInput) searchInput.value = '';
    renderCustomAppPickerList('sceneAppPickerList', 'appSelectDropdown', '');
  }

  function renderComposerMonitorPills() {
    const row = document.getElementById('ruleMonitorPills');
    if (!row) return;
    const monCount = Math.max(1, state.monitors.length || 1);
    const html = [];
    for (let i = 0; i < monCount; i++) {
      html.push(`
        <button
          type="button"
          class="mon-pill-btn ${state.composerTargetMonitor === i ? 'active' : ''}"
          data-composer-mon="${i}"
        >
          Ekran ${i + 1}
        </button>
      `);
    }
    row.innerHTML = html.join('');
  }

  function renderComposerBlueprintAndList() {
    const countEl = document.getElementById('composerItemCount');
    const bpEl = document.getElementById('composerBlueprintMonitors');
    const listEl = document.getElementById('sceneEditorItemsList');

    if (countEl) countEl.textContent = `${state.composerItems.length} Uygulama`;

    const monCount = Math.max(
      1,
      state.monitors.length || 1,
      ...state.composerItems.map((i) => Number(i.monitorIndex || 0) + 1)
    );
    if (bpEl) {
      const monsHtml = [];
      for (let m = 0; m < monCount; m++) {
        const itemsOnMon = state.composerItems.filter((it) => Number(it.monitorIndex || 0) === m);
        const iconsHtml = itemsOnMon.length
          ? itemsOnMon
              .map((it) => {
                const label = it.appName || it.processName || 'Uygulama';
                const isMin = Boolean(it.state === 'minimized' || it.windowStyle === 'minimized');
                const isBehind = Boolean(!isMin && it.isBackground);
                const isBg = isMin || isBehind;
                const badgeText = isMin ? 'SİMGE' : isBehind ? 'ARKA' : '';
                return `
                  <div class="scene-app-icon-tile ${isBg ? 'is-bg' : ''}" title="${escapeHtml(label)}">
                    ${renderAppIconHtml(findIconForItem(it), label)}
                    ${badgeText ? `<span class="scene-bg-badge">${badgeText}</span>` : ''}
                  </div>
                `;
              })
              .join('')
          : `<span class="scene-empty-mon-hint">Boş</span>`;

        monsHtml.push(`
          <div class="mini-monitor-frame">
            <div class="mini-monitor-top">
              <span class="mini-monitor-tag">EKRAN ${m + 1}</span>
            </div>
            <div class="scene-mon-icons-row">
              ${iconsHtml}
            </div>
          </div>
        `);
      }
      bpEl.innerHTML = monsHtml.join('');
    }

    if (listEl) {
      if (!state.composerItems.length) {
        listEl.innerHTML = `<p class="section-subtitle">Henüz bu sahneye uygulama eklenmedi.</p>`;
      } else {
        listEl.innerHTML = state.composerItems
          .map((it, idx) => {
            const isMin = Boolean(it.state === 'minimized' || it.windowStyle === 'minimized');
            const isBehind = Boolean(!isMin && it.isBackground);
            const visLabel = isMin ? 'Simge Durumu' : isBehind ? 'Arkada Açık' : 'Ön Planda';
            return `
            <div class="editor-item-row">
              <div style="min-width: 0; flex: 1;">
                <div class="window-row-proc">${escapeHtml(it.appName || it.processName)}</div>
                <div class="mono-stat">Ekran ${Number(it.monitorIndex || 0) + 1} · ${escapeHtml(ZONE_LABELS[it.zonePreset] || 'Özel')} · ${visLabel}</div>
              </div>
              <div style="display: flex; align-items: center; gap: 6px; flex-shrink: 0;">
                <button type="button" class="btn-secondary btn-xs" data-cycle-composer-vis="${idx}" title="Pencere Görünümünü Değiştir">
                  ${visLabel}
                </button>
                <button type="button" class="icon-action-btn danger" data-remove-composer-item="${idx}" title="Kaldır" aria-label="Kaldır">
                  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6">
                    <path d="M4.5 6h11M8 6V4.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1V6m-5.5 0l.6 9.5a1.5 1.5 0 0 0 1.5 1.4h2.8a1.5 1.5 0 0 0 1.5-1.4L13.5 6" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </button>
              </div>
            </div>
          `;
          })
          .join('');
      }
    }
  }

  // Only allow inline raster images from the PC; anything else (quotes, javascript:, remote URLs) is dropped
  function safeImageSrc(url) {
    const u = String(url || '');
    return /^data:image\/(png|jpeg|jpg|gif|webp|bmp|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/=\s]+$/i.test(u) ? u : '';
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // =========================================================================
  // QUICK ACTION COMPOSER, LIVE PC FILE BROWSER & UNIVERSAL PROPERTIES ("ÖZELLİKLER")
  // =========================================================================
  async function ensureInstalledAppsLoaded() {
    if (state.installedApps && state.installedApps.length > 0) return;
    try {
      const res = await sendCommand('get_installed_apps');
      if (res && Array.isArray(res.installed)) {
        state.installedApps = res.installed;
      }
    } catch {}
  }

  function buildTargetMonitorOptionsHtml(selectedMon) {
    const monCount = Math.max(1, state.monitors.length || 1);
    const opts = [
      `<option value="-1" ${Number(selectedMon) === -1 ? 'selected' : ''}>Varsayılan Ekran (Taşıma Yapma)</option>`
    ];
    for (let i = 0; i < monCount; i++) {
      opts.push(
        `<option value="${i}" ${Number(selectedMon) === i ? 'selected' : ''}>Ekran ${i + 1}${i === 0 ? ' (Ana Ekran)' : ''}</option>`
      );
    }
    return opts.join('');
  }

  function syncQaActionTypeVisibility(sourceType) {
    const src = sourceType || 'app';
    state.qaItemSource = src;
    const typeSel = document.getElementById('qaActionTypeSelect');
    if (typeSel && typeSel.value !== src) typeSel.value = src;

    const gFile = document.getElementById('qaSourceFileGroup');
    const gApp = document.getElementById('qaSourceAppGroup');
    const gCustom = document.getElementById('qaSourceCustomGroup');
    const gMacro = document.getElementById('qaSourceMacroGroup');
    const gScene = document.getElementById('qaSourceSceneGroup');
    const gSys = document.getElementById('qaSourceSystemActionGroup');
    const advDetails = document.getElementById('qaAdvancedDetails');

    if (gFile) gFile.classList.toggle('hidden', src !== 'file');
    if (gApp) gApp.classList.toggle('hidden', src !== 'app');
    if (gCustom) gCustom.classList.toggle('hidden', src !== 'custom');
    if (gMacro) gMacro.classList.toggle('hidden', src !== 'macro');
    if (gScene) gScene.classList.toggle('hidden', src !== 'scene');
    if (gSys) gSys.classList.toggle('hidden', src !== 'system_action');

    const supportsWinProps = src === 'app' || src === 'file' || src === 'custom';
    if (advDetails) {
      advDetails.classList.toggle('hidden', !supportsWinProps);
      if (!supportsWinProps) advDetails.open = false;
    }
  }

  function populateQaDynamicSelects() {
    const macSel = document.getElementById('qaMacroSelect');
    if (macSel) {
      const macs = Array.isArray(state.macros) ? state.macros : [];
      if (!macs.length) {
        macSel.innerHTML = `<option value="">Henüz kayıtlı makro yok (Sahneler & Makrolar sekmesinden ekleyin)</option>`;
      } else {
        macSel.innerHTML = macs
          .map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)} (${(m.steps || []).length} adım)</option>`)
          .join('');
      }
    }

    const scSel = document.getElementById('qaSceneSelect');
    if (scSel) {
      const scs = Array.isArray(state.scenes) ? state.scenes : [];
      if (!scs.length) {
        scSel.innerHTML = `<option value="">Henüz kayıtlı sahne yok (Sahneler & Makrolar sekmesinden ekleyin)</option>`;
      } else {
        scSel.innerHTML = scs
          .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)} (${(s.items || []).length} uygulama)</option>`)
          .join('');
      }
    }
  }

  function openQuickActionComposer(existingQa, prefillItem) {
    state.editingQaId = existingQa ? existingQa.id : null;
    state.qaExecMode = existingQa && existingQa.executionMode === 'sequential' ? 'sequential' : 'parallel';
    state.qaItems =
      existingQa && Array.isArray(existingQa.items)
        ? JSON.parse(JSON.stringify(existingQa.items))
        : prefillItem
        ? [prefillItem]
        : [];

    document.getElementById('qaModalTitle').textContent = existingQa
      ? 'Hızlı Erişim Butonunu Düzenle'
      : 'Hızlı Erişim Butonu Oluştur';
    document.getElementById('qaNameInput').value = existingQa
      ? existingQa.name
      : prefillItem
      ? prefillItem.name
      : '';
    const catSel = document.getElementById('qaCategorySelect');
    if (catSel) {
      catSel.value = existingQa && existingQa.category ? existingQa.category : 'Genel';
    }

    const delBtn = document.getElementById('deleteQaModalBtn');
    const inspBtn = document.getElementById('inspectQaModalBtn');
    if (delBtn) delBtn.classList.toggle('hidden', !existingQa);
    if (inspBtn) inspBtn.classList.toggle('hidden', !existingQa);

    document.querySelectorAll('#qaExecModeRow .segment-btn').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-qa-exec') === state.qaExecMode);
    });

    populateQaDynamicSelects();

    // Populate Searchable Custom App Picker
    const appSel = document.getElementById('qaInstalledAppSelect');
    const qaSearchInput = document.getElementById('qaAppSearchInput');
    if (appSel) appSel.value = '0';
    if (qaSearchInput) qaSearchInput.value = '';
    renderCustomAppPickerList('qaAppPickerList', 'qaInstalledAppSelect', '');
    if (!state.installedApps || state.installedApps.length === 0) {
      ensureInstalledAppsLoaded().then(() => {
        renderCustomAppPickerList('qaAppPickerList', 'qaInstalledAppSelect', qaSearchInput ? qaSearchInput.value : '');
      });
    }

    const monSel = document.getElementById('qaTargetMonitorSelect');
    if (monSel) {
      monSel.innerHTML = buildTargetMonitorOptionsHtml(-1);
    }

    const selFileInput = document.getElementById('qaSelectedFilePathInput');
    if (selFileInput) selFileInput.value = '';
    const custNameInput = document.getElementById('qaCustomItemNameInput');
    if (custNameInput) custNameInput.value = '';
    const custPathInput = document.getElementById('qaCustomItemPathInput');
    if (custPathInput) custPathInput.value = '';
    const zoneSel = document.getElementById('qaTargetZoneSelect');
    if (zoneSel) zoneSel.value = 'none';
    const winStyleSel = document.getElementById('qaWindowStyleSelect');
    if (winStyleSel) winStyleSel.value = 'normal';
    const ifRunSel = document.getElementById('qaIfRunningSelect');
    if (ifRunSel) ifRunSel.value = 'new';
    const delaySel = document.getElementById('qaDelaySelect');
    if (delaySel) delaySel.value = '0';
    const adminCheck = document.getElementById('qaRunAsAdminCheck');
    if (adminCheck) adminCheck.checked = false;
    const topMostCheck = document.getElementById('qaAlwaysOnTopCheck');
    if (topMostCheck) topMostCheck.checked = false;

    const advDetails = document.getElementById('qaAdvancedDetails');
    if (advDetails) advDetails.open = false;

    const initialType =
      existingQa && existingQa.items && existingQa.items[0] && existingQa.items[0].targetType
        ? existingQa.items[0].targetType === 'folder' || existingQa.items[0].targetType === 'url'
          ? 'custom'
          : existingQa.items[0].targetType
        : 'app';
    syncQaActionTypeVisibility(initialType);

    renderQaComposerItemsList();
    openModal('quickActionComposerModal');
  }

  function renderQaComposerItemsList() {
    const badge = document.getElementById('qaItemsCountBadge');
    const listEl = document.getElementById('qaEditorItemsList');
    if (badge) badge.textContent = `${state.qaItems.length} Öğe`;
    if (!listEl) return;

    if (!state.qaItems.length) {
      listEl.innerHTML = `<p class="section-subtitle">Henüz öğe eklenmedi. Yukarıdaki menüden hızlı erişim türünü seçip ekleyin.</p>`;
      return;
    }

    listEl.innerHTML = state.qaItems
      .map((it, idx) => {
        const tType = String(it.targetType || 'file');
        let subTxt = '';
        if (tType === 'macro') {
          subTxt = 'Klavye Makrosu';
        } else if (tType === 'scene') {
          subTxt = 'Çalışma Sahnesi';
        } else if (tType === 'system_action') {
          subTxt = 'Sistem İşlemi';
        } else {
          const monTxt =
            typeof it.monitorIndex === 'number' && it.monitorIndex >= 0
              ? `Ekran ${it.monitorIndex + 1}`
              : 'Varsayılan Ekran';
          const zoneTxt = it.zone && it.zone !== 'none' ? ` · ${formatZoneShort(it.zone)}` : '';
          subTxt = monTxt + zoneTxt;
        }
        const canInspectSub = tType !== 'macro' && tType !== 'scene' && tType !== 'system_action';
        return `
          <div class="editor-item-row">
            <div style="min-width:0;flex:1;">
              <div class="window-row-proc">${escapeHtml(it.name || it.targetPath)}</div>
              <div class="mono-stat">${escapeHtml(subTxt)}</div>
            </div>
            <div class="qa-card-actions">
              ${
                canInspectSub
                  ? `<button type="button" class="icon-action-btn" data-qa-edit-subitem="${idx}" title="Özellikler" aria-label="Özellikler">
                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6">
                  <circle cx="10" cy="10" r="2.5" />
                  <path d="M10 3v2M10 15v2M3 10h2M15 10h2M5.05 5.05l1.4 1.4M13.55 13.55l1.4 1.4M14.95 5.05l-1.4 1.4M6.45 13.55l-1.4 1.4" stroke-linecap="round" />
                </svg>
              </button>`
                  : ''
              }
              <button type="button" class="icon-action-btn danger" data-qa-remove-subitem="${idx}" title="Kaldır" aria-label="Kaldır">
                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6">
                  <path d="M4.5 6h11M8 6V4.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1V6m-5.5 0l.6 9.5a1.5 1.5 0 0 0 1.5 1.4h2.8a1.5 1.5 0 0 0 1.5-1.4L13.5 6" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
            </div>
          </div>
        `;
      })
      .join('');
  }

  // PC FILE & FOLDER BROWSER ENGINE
  async function openPcFileBrowser(mode = 'browse', initialPath = '') {
    state.fsBrowserMode = mode;
    const titleEl = document.getElementById('fsBrowserTitle');
    const subEl = document.getElementById('fsBrowserSubtitle');
    if (titleEl && subEl) {
      if (mode === 'pick_for_qa') {
        titleEl.textContent = 'Hızlı Buton İçin Dosya / Klasör Seçin';
        subEl.textContent = 'İstediğiniz dosya veya klasörün yanındaki "Seç" butonuna dokunun';
      } else if (mode === 'pick_for_custom_app') {
        titleEl.textContent = 'Uygulama Dosyası (.exe / .lnk) Seçin';
        subEl.textContent = 'Kataloğa eklenecek çalıştırılabilir dosyanın yanındaki "Seç" butonuna dokunun';
      } else if (mode === 'download_to_phone') {
        titleEl.textContent = 'PC Dosyalarını Telefona İndir';
        subEl.textContent = 'İndirmek istediğiniz dosyanın yanındaki "İndir" butonuna dokunun';
      } else {
        titleEl.textContent = 'PC Dosya ve Klasör Gezgini';
        subEl.textContent = 'Dosyaları PC üzerinde açın, telefona indirin veya özelliklerini inceleyin';
      }
    }
    document.getElementById('fsSearchFilterInput').value = '';
    openModal('pcFileBrowserModal');
    await loadPcDirectory(initialPath || state.fsCurrentPath || 'quick:desktop', '');
  }

  async function loadPcDirectory(targetPath, searchQuery = '') {
    const listEl = document.getElementById('fsEntriesListContainer');
    const rootsEl = document.getElementById('fsRootsPillRow');
    const pathInput = document.getElementById('fsCurrentPathInput');

    if (listEl) {
      listEl.innerHTML = `<div class="sub-panel"><p class="section-subtitle">PC klasör içeriği yükleniyor...</p></div>`;
    }

    try {
      const res = await sendCommand('browse_fs', { path: targetPath, query: searchQuery }, 6000);
      state.fsCurrentPath = res.currentPath || '';
      state.fsParentPath = res.parentPath || '';
      state.fsRoots = Array.isArray(res.roots) ? res.roots : [];
      state.fsEntries = Array.isArray(res.entries) ? res.entries : [];

      if (pathInput) pathInput.value = state.fsCurrentPath;

      if (rootsEl) {
        rootsEl.innerHTML = state.fsRoots
          .map((r) => {
            const active = r.path === state.fsCurrentPath;
            return `<button type="button" class="mon-pill-btn ${active ? 'active' : ''}" data-fs-root-path="${escapeHtml(r.path)}">${escapeHtml(r.label)}</button>`;
          })
          .join('');
      }

      renderFsEntriesList();
    } catch (err) {
      if (listEl) {
        listEl.innerHTML = `<div class="sub-panel"><p class="section-subtitle">Klasör okunamadı: ${escapeHtml(err.message)}</p></div>`;
      }
    }
  }

  function renderFsEntriesList() {
    const listEl = document.getElementById('fsEntriesListContainer');
    if (!listEl) return;

    if (!state.fsEntries.length) {
      listEl.innerHTML = `<div class="sub-panel"><p class="section-subtitle">Bu konumda eşleşen dosya veya klasör bulunamadı.</p></div>`;
      return;
    }

    const isPicker = state.fsBrowserMode === 'pick_for_qa' || state.fsBrowserMode === 'pick_for_custom_app';

    listEl.innerHTML = state.fsEntries
      .map((entry, idx) => {
        const subInfo = entry.isDir
          ? `Klasör · ${entry.modifiedAt || ''}`
          : `${entry.sizeFormatted || ''}`;
        const downloadBtnHtml =
          !isPicker && !entry.isDir
            ? `<button type="button" class="btn-secondary btn-compact" data-fs-entry-download="${idx}" title="Telefona İndir">İndir</button>`
            : '';
        return `
          <div class="fs-entry-row">
            <div class="fs-entry-info" data-fs-entry-tap="${idx}">
              <div class="fs-entry-title-row">
                <span class="qa-type-badge">${escapeHtml(entry.ext || 'DOSYA')}</span>
                <span class="fs-entry-name">${escapeHtml(entry.name)}</span>
              </div>
              <span class="fs-entry-sub">${escapeHtml(subInfo)}</span>
            </div>
            <div class="fs-entry-actions">
              <button
                type="button"
                class="icon-action-btn"
                data-fs-entry-prop="${idx}"
                title="Özellikler"
                aria-label="Özellikler"
              >
                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6">
                  <circle cx="10" cy="10" r="2.5" />
                  <path d="M10 3v2M10 15v2M3 10h2M15 10h2M5.05 5.05l1.4 1.4M13.55 13.55l1.4 1.4M14.95 5.05l-1.4 1.4M6.45 13.55l-1.4 1.4" stroke-linecap="round" />
                </svg>
              </button>
              ${downloadBtnHtml}
              <button
                type="button"
                class="btn-primary btn-compact"
                data-fs-entry-primary="${idx}"
              >
                ${isPicker ? 'Seç' : entry.isDir ? 'Aç' : 'PC\'de Aç'}
              </button>
            </div>
          </div>
        `;
      })
      .join('');
  }

  async function downloadFileFromPc(entry) {
    if (!entry || entry.isDir) return;
    showToast(`İndiriliyor: ${entry.name}...`);
    try {
      const res = await sendCommand('download_file', { path: entry.path }, 25000);
      if (!res || !res.base64Data) {
        throw new Error('Dosya verisi alınamadı');
      }
      const fileName = res.fileName || entry.name;
      if (window.TahaNative && typeof window.TahaNative.saveBase64File === 'function') {
        const savedPath = window.TahaNative.saveBase64File(fileName, res.base64Data);
        if (savedPath && !String(savedPath).startsWith('ERR')) {
          logAuditEvent('file', `PC'den telefona dosya indirildi: ${fileName}`);
          showToast(`İndirilenler klasörüne kaydedildi: ${fileName}`);
          return;
        }
      }
      const byteCharacters = atob(res.base64Data);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const blob = new Blob([new Uint8Array(byteNumbers)], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      logAuditEvent('file', `PC'den telefona dosya indirildi: ${fileName}`);
      showToast(`Dosya indirildi: ${fileName}`);
    } catch (err) {
      showToast(err.message || 'Dosya indirilemedi');
    }
  }

  // WIRELESS CONNECTIONS ENGINE (Wi-Fi, Mobile Hotspot, Bluetooth)
  async function refreshWirelessStatus(silent = false) {
    if (!state.isAuthenticated) return;
    try {
      const res = await sendCommand('wireless_control', { action: 'status' }, 8000);
      if (res) {
        state.wirelessStatus = res;
        renderWirelessStatus(res);
      }
    } catch (err) {
      if (!silent) showToast(err.message || 'Kablosuz bağlantı durumu alınamadı');
    }
  }

  function renderWirelessStatus(w) {
    if (!w) return;
    const wifiSub = document.getElementById('wifiCurrentStatusText');
    const wifiSw = document.getElementById('wifiToggleSwitch');
    const wifiBadge = document.getElementById('wifiIconBadge');
    if (wifiSub && w.wifi) {
      if (!w.wifi.supported) {
        wifiSub.textContent = 'Wi-Fi adaptörü bulunamadı';
      } else if (!w.wifi.enabled) {
        wifiSub.textContent = 'Kapalı';
      } else if (w.wifi.connected && w.wifi.ssid) {
        wifiSub.textContent = `Bağlı: ${w.wifi.ssid}${w.wifi.signal ? ` (%${w.wifi.signal})` : ''}`;
      } else {
        wifiSub.textContent = 'Açık · Bir ağa bağlı değil';
      }
    }
    if (wifiSw && w.wifi) {
      wifiSw.checked = Boolean(w.wifi.enabled);
      wifiSw.disabled = !w.wifi.supported;
    }
    if (wifiBadge && w.wifi) {
      wifiBadge.classList.toggle('is-active', Boolean(w.wifi.enabled && w.wifi.connected));
    }

    const hsSub = document.getElementById('hotspotCurrentStatusText');
    const hsSw = document.getElementById('hotspotToggleSwitch');
    const hsBadge = document.getElementById('hotspotIconBadge');
    if (hsSub && w.hotspot) {
      if (!w.hotspot.supported) {
        hsSub.textContent = 'Desteklenmiyor';
      } else if (w.hotspot.enabled) {
        const ssidPart = w.hotspot.ssid ? ` (${w.hotspot.ssid})` : '';
        hsSub.textContent =
          typeof w.hotspot.clients === 'number' && w.hotspot.clients > 0
            ? `Açık${ssidPart} · ${w.hotspot.clients} cihaz bağlı`
            : `Açık${ssidPart} · Paylaşımda`;
      } else {
        hsSub.textContent = 'Kapalı';
      }
    }
    if (hsSw && w.hotspot) {
      hsSw.checked = Boolean(w.hotspot.enabled);
      hsSw.disabled = !w.hotspot.supported;
    }
    if (hsBadge && w.hotspot) {
      hsBadge.classList.toggle('is-active', Boolean(w.hotspot.enabled));
    }

    const btSub = document.getElementById('btCurrentStatusText');
    const btSw = document.getElementById('btToggleSwitch');
    const btBadge = document.getElementById('btIconBadge');
    if (btSub && w.bluetooth) {
      if (!w.bluetooth.supported) {
        btSub.textContent = 'Bluetooth adaptörü yok';
      } else {
        btSub.textContent = w.bluetooth.enabled ? 'Açık' : 'Kapalı';
      }
    }
    if (btSw && w.bluetooth) {
      btSw.checked = Boolean(w.bluetooth.enabled);
      btSw.disabled = !w.bluetooth.supported;
    }
    if (btBadge && w.bluetooth) {
      btBadge.classList.toggle('is-active', Boolean(w.bluetooth.enabled));
    }
  }

  async function openWifiScannerModal() {
    triggerHaptic(10);
    const pwBox = document.getElementById('wifiPasswordPromptBox');
    if (pwBox) pwBox.classList.add('hidden');
    openModal('wifiScannerModal');
    await scanPcWifiNetworks();
  }

  async function scanPcWifiNetworks() {
    const listEl = document.getElementById('wifiNetworksListContainer');
    if (listEl) {
      listEl.innerHTML = `<div class="sub-panel"><p class="section-subtitle">PC çevresindeki Wi-Fi ağları taranıyor...</p></div>`;
    }
    try {
      const res = await sendCommand('wireless_control', { action: 'wifi_scan' }, 12000);
      if (res && res.wifi) {
        state.wirelessStatus = res;
        renderWirelessStatus(res);
      }
      const networks = res && Array.isArray(res.networks) ? res.networks : [];
      state.scannedWifiNetworks = networks;
      if (!listEl) return;
      if (!networks.length) {
        listEl.innerHTML = `<div class="sub-panel"><p class="section-subtitle">Çevrede kablosuz ağ bulunamadı veya Wi-Fi kapalı.</p></div>`;
        return;
      }
      listEl.innerHTML = networks
        .map((n, idx) => {
          const sig = typeof n.signal === 'number' ? `%${n.signal}` : '';
          const sec = n.security ? n.security : 'Açık Ağ';
          return `
            <div class="wifi-network-row">
              <div class="wifi-net-left">
                <div class="wifi-net-ssid">
                  <span>${escapeHtml(n.ssid)}</span>
                  ${n.connected ? `<span class="wifi-connected-pill">BAĞLI</span>` : ''}
                </div>
                <span class="wifi-net-meta">${escapeHtml([sig, sec].filter(Boolean).join(' · '))}</span>
              </div>
              <div class="fs-entry-actions">
                ${
                  n.connected
                    ? `<button type="button" class="btn-secondary btn-compact" data-wifi-disconnect="${idx}">Kes</button>`
                    : `<button type="button" class="btn-primary btn-compact" data-wifi-select="${idx}">Bağlan</button>`
                }
              </div>
            </div>
          `;
        })
        .join('');
    } catch (err) {
      if (listEl) {
        listEl.innerHTML = `<div class="sub-panel"><p class="section-subtitle">Wi-Fi taraması başarısız: ${escapeHtml(err.message)}</p></div>`;
      }
    }
  }

  // =========================================================================
  // UNIVERSAL PROPERTIES ("ÖZELLİKLER") INSPECTOR ENGINE
  // =========================================================================
  async function openPropertiesInspector(context) {
    // context: { kind: 'quick_action' | 'qa_item' | 'scene' | 'window' | 'installed_app' | 'fs_entry', ... }
    triggerHaptic(12);
    await ensureInstalledAppsLoaded();
    state.activePropContext = context;

    const modalEl = document.getElementById('universalPropertiesModal');
    const titleEl = document.getElementById('propModalTitle');
    const subEl = document.getElementById('propModalSubtitle');
    const bodyEl = document.getElementById('propModalBodyContent');

    if (!modalEl || !bodyEl) return;
    bodyEl.innerHTML = `<div class="sub-panel"><p class="section-subtitle">Özellikler yükleniyor...</p></div>`;
    openModal('universalPropertiesModal');

    let inspectPath = '';
    let inspectHwnd = 0;
    let currentItemConfig = null;

    if (context.kind === 'quick_action') {
      const qa = context.qa;
      titleEl.textContent = `${qa.name} · Özellikler`;
      subEl.textContent = `Hızlı Erişim Butonu · ${(qa.items || []).length} Öğe`;
      if (qa.items && qa.items.length === 1) {
        currentItemConfig = qa.items[0];
        inspectPath = currentItemConfig.targetPath || '';
      }
    } else if (context.kind === 'qa_item' || context.kind === 'qa_composer_item') {
      currentItemConfig = context.item;
      inspectPath = currentItemConfig.targetPath || '';
      titleEl.textContent = `${currentItemConfig.name || 'Öğe'} · Özellikler`;
      subEl.textContent = 'Çalıştırma ve Pencere Yapılandırması';
    } else if (context.kind === 'scene') {
      const sc = context.scene;
      titleEl.textContent = `${sc.name} · Sahne Özellikleri`;
      subEl.textContent = `Çoklu Monitör Sahnesi · ${(sc.items || []).length} Uygulama`;
    } else if (context.kind === 'window') {
      const win = context.window;
      inspectHwnd = Number(win.hwnd || 0);
      inspectPath = win.exePath || '';
      titleEl.textContent = `${win.processName} · Pencere Özellikleri`;
      subEl.textContent = win.title || 'Canlı Açık Pencere';
      currentItemConfig = {
        name: win.processName,
        targetType: 'app',
        targetPath: win.exePath || win.processName,
        openWithMode: 'default',
        openWithPath: '',
        openWithName: 'Varsayılan Uygulama',
        arguments: '',
        workingDirectory: '',
        monitorIndex: Number(win.monitorIndex || 0),
        zone: win.zonePreset === 'fullscreen' ? 'full' : win.zonePreset || 'none',
        windowStyle: win.state === 'maximized' ? 'maximized' : 'normal',
        runAsAdmin: false,
        priority: 'normal',
        delayMs: 0,
        ifRunning: 'focus',
        alwaysOnTop: Boolean(win.isTopMost)
      };
    } else if (context.kind === 'installed_app') {
      const app = context.app;
      inspectPath = app.launchPath || '';
      titleEl.textContent = `${app.name} · Özellikler`;
      subEl.textContent = app.isCustom ? 'Özel Uygulama' : 'Kurulu PC Uygulaması';
      const savedZone = app.zonePreset === 'fullscreen' ? 'full' : app.zonePreset || 'none';
      currentItemConfig = {
        name: app.name,
        targetType: 'app',
        targetPath: app.launchPath || app.processName,
        openWithMode: 'default',
        openWithPath: '',
        openWithName: 'Varsayılan Uygulama',
        arguments: app.launchArgs || '',
        workingDirectory: '',
        monitorIndex: typeof app.monitorIndex === 'number' ? app.monitorIndex : -1,
        zone: savedZone,
        windowStyle: app.windowStyle || 'normal',
        runAsAdmin: Boolean(app.runAsAdmin),
        priority: 'normal',
        delayMs: 0,
        ifRunning: app.ifRunning || 'new',
        alwaysOnTop: Boolean(app.alwaysOnTop)
      };
    } else if (context.kind === 'fs_entry') {
      const entry = context.entry;
      inspectPath = entry.path || '';
      titleEl.textContent = `${entry.name} · Özellikler`;
      subEl.textContent = entry.isDir ? 'PC Klasörü' : `PC Dosyası (${entry.ext || 'DOSYA'})`;
      currentItemConfig = {
        name: entry.name,
        targetType: entry.targetType || (entry.isDir ? 'folder' : 'file'),
        targetPath: entry.path,
        openWithMode: 'default',
        openWithPath: '',
        openWithName: entry.defaultAppName || 'Varsayılan Uygulama',
        arguments: '',
        workingDirectory: '',
        monitorIndex: -1,
        zone: 'none',
        windowStyle: 'normal',
        runAsAdmin: false,
        priority: 'normal',
        delayMs: 0,
        ifRunning: 'new',
        alwaysOnTop: false
      };
    }

    let inspected = null;
    if (inspectHwnd) {
      try {
        inspected = await sendCommand('inspect_target', { path: inspectPath, hwnd: inspectHwnd }, 4500);
      } catch {}
    }

    state.activePropContext.inspected = inspected;
    state.activePropContext.itemConfig = currentItemConfig;

    const sectionsHtml = [];

    // 1. MULTI-ITEM LIST SECTION (If Quick Action OR Scene)
    if (context.kind === 'quick_action') {
      const qa = context.qa;
      const items = Array.isArray(qa.items) ? qa.items : [];
      const lastRunTxt = qa.lastRunAt
        ? new Date(qa.lastRunAt).toLocaleString('tr-TR', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })
        : 'Henüz çalıştırılmadı';

      sectionsHtml.push(`
        <div class="prop-section-card">
          <div class="sub-panel-header">
            <span class="sub-panel-title">Buton Özeti</span>
          </div>
          <div class="prop-kv-grid">
            <div class="prop-kv-item">
              <span class="prop-kv-label">Buton Adı</span>
              <span class="prop-kv-val">${escapeHtml(qa.name)}</span>
            </div>
            <div class="prop-kv-item">
              <span class="prop-kv-label">Çalıştırma Modu</span>
              <span class="prop-kv-val">${qa.executionMode === 'sequential' ? 'Sıralı' : 'Aynı Anda'}</span>
            </div>
            <div class="prop-kv-item">
              <span class="prop-kv-label">Toplam Çalıştırma</span>
              <span class="prop-kv-val">${Number(qa.runCount || 0)} kez</span>
            </div>
            <div class="prop-kv-item">
              <span class="prop-kv-label">Son Çalıştırma</span>
              <span class="prop-kv-val">${escapeHtml(lastRunTxt)}</span>
            </div>
          </div>
          <div class="prop-actions-grid">
            <button type="button" class="btn-primary" data-prop-action="run_qa">Şimdi Başlat</button>
            <button type="button" class="btn-secondary" data-prop-action="edit_qa">Düzenle</button>
            <button type="button" class="btn-secondary" data-prop-action="dup_qa">Çoğalt</button>
            <button type="button" class="btn-danger" data-prop-action="del_qa">Sil</button>
          </div>
        </div>
      `);

      const subItemsHtml = items
        .map((it, idx) => {
          const mon =
            typeof it.monitorIndex === 'number' && it.monitorIndex >= 0
              ? `Ekran ${it.monitorIndex + 1}`
              : 'Varsayılan Ekran';
          return `
            <div class="editor-item-row">
              <div style="min-width:0;flex:1;">
                <div class="window-row-proc">${escapeHtml(it.name || it.targetPath)}</div>
                <div class="mono-stat">${escapeHtml(mon)} · ${escapeHtml(formatZoneShort(it.zone))}</div>
              </div>
              <div class="qa-card-actions">
                <button type="button" class="icon-action-btn" data-prop-inspect-subitem="${idx}" title="Özellikler" aria-label="Özellikler">
                  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6">
                    <circle cx="10" cy="10" r="2.5" />
                    <path d="M10 3v2M10 15v2M3 10h2M15 10h2M5.05 5.05l1.4 1.4M13.55 13.55l1.4 1.4M14.95 5.05l-1.4 1.4M6.45 13.55l-1.4 1.4" stroke-linecap="round" />
                  </svg>
                </button>
                <button type="button" class="btn-primary btn-compact" data-prop-run-subitem="${idx}">Aç</button>
              </div>
            </div>
          `;
        })
        .join('');

      sectionsHtml.push(`
        <div class="prop-section-card">
          <div class="sub-panel-header">
            <span class="sub-panel-title">Buton İçindeki Öğeler (${items.length})</span>
          </div>
          <div class="scene-items-editor-list">
            ${subItemsHtml}
          </div>
        </div>
      `);
    }

    if (context.kind === 'scene') {
      const sc = context.scene;
      const items = Array.isArray(sc.items) ? sc.items : [];
      const rows = items
        .map(
          (it, idx) => `
          <div class="editor-item-row">
            <div style="min-width:0;flex:1;">
              <div class="window-row-proc">${escapeHtml(it.appName || it.processName)}</div>
              <div class="mono-stat">Ekran ${Number(it.monitorIndex || 0) + 1} · ${escapeHtml(ZONE_LABELS[it.zonePreset] || 'Özel')}</div>
            </div>
            <button type="button" class="btn-primary btn-compact" data-prop-run-scene-item="${idx}">Aç</button>
          </div>
        `
        )
        .join('');

      sectionsHtml.push(`
        <div class="prop-section-card">
          <div class="sub-panel-header">
            <span class="sub-panel-title">Sahne İçeriği (${items.length} Uygulama)</span>
          </div>
          <div class="scene-items-editor-list">${rows}</div>
          <div class="prop-actions-grid">
            <button type="button" class="btn-primary" data-prop-action="run_scene">Sahneyi Uygula</button>
            <button type="button" class="btn-secondary" data-prop-action="edit_scene">Sahneyi Düzenle</button>
          </div>
        </div>
      `);
    }

    // 2. LIVE OPEN WINDOW CONTROLS (If inspecting an open window)
    if (context.kind === 'window') {
      const win = context.window;
      const rect = (inspected && inspected.rect) || win.rect || { x: 0, y: 0, width: 0, height: 0 };
      const topMost = inspected ? Boolean(inspected.isTopMost) : Boolean(win.isTopMost);

      sectionsHtml.push(`
        <div class="prop-section-card">
          <div class="sub-panel-header">
            <span class="sub-panel-title">Canlı Pencere Durumu ve Müdahale</span>
            <span class="mono-caption">PID: ${win.pid}</span>
          </div>
          <div class="prop-kv-grid">
            <div class="prop-kv-item">
              <span class="prop-kv-label">Pencere Başlığı</span>
              <span class="prop-kv-val">${escapeHtml(win.title)}</span>
            </div>
            <div class="prop-kv-item">
              <span class="prop-kv-label">Konum ve Boyut</span>
              <span class="prop-kv-val">${rect.x}, ${rect.y} (${rect.width}×${rect.height})</span>
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">Pencere Saydamlığı (Opacity)</label>
            <div class="segmented-row">
              <button type="button" class="segment-btn" data-prop-win-opacity="100">100%</button>
              <button type="button" class="segment-btn" data-prop-win-opacity="85">85%</button>
              <button type="button" class="segment-btn" data-prop-win-opacity="70">70%</button>
              <button type="button" class="segment-btn" data-prop-win-opacity="50">50%</button>
            </div>
          </div>

          <div class="prop-actions-grid">
            <button type="button" class="btn-secondary" data-prop-win-cmd="toggle_topmost">
              ${topMost ? 'Üstte Tutmayı Kaldır' : 'Her Zaman Üstte Tut'}
            </button>
            <button type="button" class="btn-secondary" data-prop-win-cmd="open_file_location">
              Dosya Konumunu Aç
            </button>
            <button type="button" class="btn-secondary" data-prop-win-cmd="maximize">
              Tam Ekran Yap
            </button>
            <button type="button" class="btn-danger" data-prop-win-cmd="kill_process">
              İşlemi Sonlandır
            </button>
          </div>
        </div>
      `);
    }

    // 3. CLEAN LAUNCH & WINDOW PLACEMENT CONFIGURATION EDITOR (No Open-With, No Args/Priority, No Metadata Table)
    if (currentItemConfig) {
      const monHtml = buildTargetMonitorOptionsHtml(
        typeof currentItemConfig.monitorIndex === 'number' ? currentItemConfig.monitorIndex : -1
      );

      sectionsHtml.push(`
        <div class="prop-section-card">
          <div class="sub-panel-header">
            <span class="sub-panel-title">Çalıştırma ve Pencere Yapılandırması</span>
          </div>

          <div class="form-row-2">
            <div class="form-group">
              <label class="form-label" for="propMonitorSelect">Açılacağı Ekran</label>
              <select id="propMonitorSelect" class="input-field">${monHtml}</select>
            </div>
            <div class="form-group">
              <label class="form-label" for="propZoneSelect">Ekran Bölgesi / Konumu</label>
              <select id="propZoneSelect" class="input-field">
                <option value="none" ${currentItemConfig.zone === 'none' ? 'selected' : ''}>Serbest / Varsayılan</option>
                <option value="full" ${currentItemConfig.zone === 'full' ? 'selected' : ''}>Tam Ekran (Maximize)</option>
                <option value="left-half" ${currentItemConfig.zone === 'left-half' ? 'selected' : ''}>Sol Yarı (50%)</option>
                <option value="right-half" ${currentItemConfig.zone === 'right-half' ? 'selected' : ''}>Sağ Yarı (50%)</option>
                <option value="center" ${currentItemConfig.zone === 'center' ? 'selected' : ''}>Ekran Ortası (80%)</option>
                <option value="top-half" ${currentItemConfig.zone === 'top-half' ? 'selected' : ''}>Üst Yarı</option>
                <option value="bottom-half" ${currentItemConfig.zone === 'bottom-half' ? 'selected' : ''}>Alt Yarı</option>
                <option value="top-left" ${currentItemConfig.zone === 'top-left' ? 'selected' : ''}>Sol Üst Köşe</option>
                <option value="top-right" ${currentItemConfig.zone === 'top-right' ? 'selected' : ''}>Sağ Üst Köşe</option>
                <option value="bottom-left" ${currentItemConfig.zone === 'bottom-left' ? 'selected' : ''}>Sol Alt Köşe</option>
                <option value="bottom-right" ${currentItemConfig.zone === 'bottom-right' ? 'selected' : ''}>Sağ Alt Köşe</option>
              </select>
            </div>
          </div>

          <div class="form-row-2">
            <div class="form-group">
              <label class="form-label" for="propWinStyleSelect">Pencere Modu</label>
              <select id="propWinStyleSelect" class="input-field">
                <option value="normal" ${currentItemConfig.windowStyle === 'normal' ? 'selected' : ''}>Normal Pencere</option>
                <option value="maximized" ${currentItemConfig.windowStyle === 'maximized' ? 'selected' : ''}>Tam Ekran (Maximized)</option>
                <option value="minimized" ${currentItemConfig.windowStyle === 'minimized' ? 'selected' : ''}>Simge Durumunda</option>
                <option value="hidden" ${currentItemConfig.windowStyle === 'hidden' ? 'selected' : ''}>Arka Planda Gizli</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label" for="propIfRunningSelect">Zaten Açıksa</label>
              <select id="propIfRunningSelect" class="input-field">
                <option value="new" ${currentItemConfig.ifRunning === 'new' ? 'selected' : ''}>Yeni Pencere Aç</option>
                <option value="focus" ${currentItemConfig.ifRunning === 'focus' ? 'selected' : ''}>Mevcut Pencereyi Öne Getir</option>
                <option value="restart" ${currentItemConfig.ifRunning === 'restart' ? 'selected' : ''}>Kapatıp Yeniden Başlat</option>
              </select>
            </div>
          </div>

          <div class="qa-toggle-checks-row">
            <label class="check-pill">
              <input type="checkbox" id="propAdminCheck" ${currentItemConfig.runAsAdmin ? 'checked' : ''} />
              <span>Yönetici Olarak Çalıştır (Admin)</span>
            </label>
            <label class="check-pill">
              <input type="checkbox" id="propTopMostCheck" ${currentItemConfig.alwaysOnTop ? 'checked' : ''} />
              <span>Her Zaman Üstte Tut (Pin)</span>
            </label>
          </div>

          ${
            context.kind === 'installed_app' && context.app && context.app.isCustom
              ? `
                <div class="prop-actions-grid">
                  <button type="button" class="btn-secondary" data-prop-action="edit_custom_app">
                    Özel Uygulamayı Düzenle
                  </button>
                  <button type="button" class="btn-danger" data-prop-action="del_custom_app">
                    Katalogdan Kaldır
                  </button>
                </div>
              `
              : ''
          }
        </div>
      `);
    }

    bodyEl.innerHTML = sectionsHtml.join('');

    // Auto-save configuration immediately when any property control is changed
    const propControls = bodyEl.querySelectorAll(
      '#propMonitorSelect, #propZoneSelect, #propWinStyleSelect, #propIfRunningSelect, #propAdminCheck, #propTopMostCheck'
    );
    propControls.forEach((ctrl) => {
      ctrl.addEventListener('change', async () => {
        const ctx = state.activePropContext;
        if (!ctx || !ctx.itemConfig) return;
        const updatedItem = readConfiguredItemFromPropModal(ctx.itemConfig);
        ctx.itemConfig = updatedItem;

        if (ctx.kind === 'installed_app' && ctx.app) {
          const zonePreset = updatedItem.zone === 'full' ? 'fullscreen' : updatedItem.zone || 'none';
          ctx.app.monitorIndex = typeof updatedItem.monitorIndex === 'number' ? updatedItem.monitorIndex : -1;
          ctx.app.zonePreset = zonePreset;
          ctx.app.windowStyle = updatedItem.windowStyle || 'normal';
          ctx.app.ifRunning = updatedItem.ifRunning || 'new';
          ctx.app.runAsAdmin = Boolean(updatedItem.runAsAdmin);
          ctx.app.alwaysOnTop = Boolean(updatedItem.alwaysOnTop);
          try {
            const res = await sendCommand('save_app_prefs', {
              key: ctx.app.launchPath || ctx.app.processName || ctx.app.name,
              prefs: {
                monitorIndex: ctx.app.monitorIndex,
                zonePreset: ctx.app.zonePreset,
                windowStyle: ctx.app.windowStyle,
                ifRunning: ctx.app.ifRunning,
                runAsAdmin: ctx.app.runAsAdmin,
                alwaysOnTop: ctx.app.alwaysOnTop
              }
            });
            if (res && Array.isArray(res.installed)) {
              state.installedApps = res.installed;
            }
          } catch {}
        } else if (ctx.kind === 'qa_composer_item' && typeof ctx.itemIndex === 'number') {
          state.qaItems[ctx.itemIndex] = updatedItem;
          renderQaComposerItemsList();
        } else if (ctx.kind === 'qa_item' && ctx.qa && typeof ctx.itemIndex === 'number') {
          ctx.qa.items[ctx.itemIndex] = updatedItem;
          try {
            const res = await sendCommand('save_quick_action', { quickAction: ctx.qa });
            if (res && res.quickActions) {
              state.quickActions = res.quickActions;
              renderQuickActionsList();
            }
          } catch {}
        } else if (ctx.kind === 'quick_action' && ctx.qa && ctx.qa.items && ctx.qa.items.length === 1) {
          ctx.qa.items[0] = updatedItem;
          try {
            const res = await sendCommand('save_quick_action', { quickAction: ctx.qa });
            if (res && res.quickActions) {
              state.quickActions = res.quickActions;
              renderQuickActionsList();
            }
          } catch {}
        } else if (ctx.kind === 'window' && ctx.window) {
          try {
            const zonePreset = updatedItem.zone === 'full' ? 'fullscreen' : updatedItem.zone || 'fullscreen';
            const res = await sendCommand('snap_window', {
              hwnd: ctx.window.hwnd,
              processName: ctx.window.processName,
              monitorIndex: updatedItem.monitorIndex >= 0 ? updatedItem.monitorIndex : 0,
              zonePreset
            });
            if (res && res.windows) {
              state.windows = res.windows;
              renderOpenWindowsList();
            }
          } catch {}
        }
      });
    });
  }

  function openManualAppModal(existingApp) {
    const modal = document.getElementById('addCustomAppModal');
    if (!modal) return;
    document.getElementById('customAppModalTitle').textContent = existingApp
      ? 'Özel Uygulamayı Düzenle'
      : 'Uygulama Ekle';
    document.getElementById('manualAppIdInput').value = existingApp && existingApp.id ? existingApp.id : '';
    document.getElementById('manualAppNameInput').value = existingApp ? existingApp.name || '' : '';
    document.getElementById('manualAppPathInput').value = existingApp ? existingApp.launchPath || '' : '';
    openModal('addCustomAppModal');
  }

  function readConfiguredItemFromPropModal(baseItem) {
    const item = { ...(baseItem || {}) };
    item.openWithMode = 'default';
    item.openWithPath = '';
    item.openWithName = 'Varsayılan Uygulama';

    const monSel = document.getElementById('propMonitorSelect');
    if (monSel) item.monitorIndex = Number(monSel.value);

    const zoneSel = document.getElementById('propZoneSelect');
    if (zoneSel) item.zone = zoneSel.value;

    const styleSel = document.getElementById('propWinStyleSelect');
    if (styleSel) item.windowStyle = styleSel.value;

    const ifRunSel = document.getElementById('propIfRunningSelect');
    if (ifRunSel) item.ifRunning = ifRunSel.value;

    const adminChk = document.getElementById('propAdminCheck');
    if (adminChk) item.runAsAdmin = Boolean(adminChk.checked);

    const topChk = document.getElementById('propTopMostCheck');
    if (topChk) item.alwaysOnTop = Boolean(topChk.checked);

    return item;
  }

  // =========================================================================
  // INTERACTIVE REMOTE DESKTOP TOUCH, TRACKPAD CURSOR, HOLD-DRAG & ZOOM BINDINGS
  // =========================================================================
  function bindRemoteWorkstationGestureEngine() {
    const viewport = document.getElementById('remoteViewportBox');
    const screenImg = document.getElementById('remoteScreenCanvas');
    const scrollStrip = document.getElementById('remoteScrollStrip');
    const liveKbdTrap = document.getElementById('liveKeyboardTrap');

    let touchCount = 0;
    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let lastY = 0;
    let relAccX = 0;
    let relAccY = 0;
    let totalMovedPx = 0;
    let touchStartTs = 0;
    let lastTapTs = 0;
    let isSecondTapTouch = false;
    let trackpadDragHoldActive = false;
    let holdTimer = null;
    let autoHoldTriggered = false;
    let directDragActive = false;
    let directStartNorm = { x: 0.5, y: 0.5 };
    let lastMoveSendTs = 0;
    // Touch mode: the finger is a real Windows touch contact (Windows does tap/scroll/hold/drag itself)
    let touchContactDown = false;
    let lastTouchSent = { x: -1, y: -1 };

    function getPadTouches(touchList) {
      const out = [];
      for (let i = 0; i < touchList.length; i++) {
        const pt = touchList[i];
        const tgt = pt.target;
        if (
          tgt &&
          tgt.closest &&
          (tgt.closest('#laptopTouchpadButtons') ||
            tgt.closest('.laptop-touchpad-buttons') ||
            tgt.closest('.remote-scroll-strip') ||
            tgt.closest('.remote-floating-hud') ||
            tgt.closest('.remote-overlay-badges'))
        ) {
          continue;
        }
        out.push(pt);
      }
      return out;
    }

    function sendTouch(phase, norm) {
      const x = Number(norm.x.toFixed(4));
      const y = Number(norm.y.toFixed(4));
      if (phase === 'move' && x === lastTouchSent.x && y === lastTouchSent.y) return;
      lastTouchSent = { x, y };
      sendFastInput({ type: 'touch', phase, id: 0, x, y, monitorIndex: state.remoteMonitorIndex });
    }

    function endTouchContact(phase) {
      if (!touchContactDown) return;
      touchContactDown = false;
      sendTouch(phase, { x: state.cursorNormX, y: state.cursorNormY });
    }

    // Two-finger pinch & scroll tracking (with focal-point anchoring)
    let pinchStartDist = 0;
    let pinchStartZoom = 1.0;
    let pinchStartPanX = 0;
    let pinchStartPanY = 0;
    let pinchFocalOffsetX = 0;
    let pinchFocalOffsetY = 0;
    let twoFingerLastY = 0;
    let twoFingerLastX = 0;
    let twoFingerMoved = false;
    let singleTapTimer = null;

    function clearHoldTimer() {
      if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
    }

    function clearSingleTapTimer() {
      if (singleTapTimer) {
        clearTimeout(singleTapTimer);
        singleTapTimer = null;
      }
    }

    function computeImageNormalizedCoords(clientX, clientY) {
      const rect = screenImg.getBoundingClientRect();
      if (!rect.width || !rect.height) return { x: state.cursorNormX, y: state.cursorNormY };

      let imgLeft = rect.left;
      let imgTop = rect.top;
      let imgWidth = rect.width;
      let imgHeight = rect.height;

      // Account for object-fit: contain letterboxing when in fullscreen or non-matching aspect ratio
      const natW = screenImg.width > 16 ? screenImg.width : (state.streamBounds && state.streamBounds.width) || 1920;
      const natH = screenImg.height > 9 ? screenImg.height : (state.streamBounds && state.streamBounds.height) || 1080;
      if (natW > 0 && natH > 0) {
        const boxAspect = rect.width / rect.height;
        const imgAspect = natW / natH;
        if (boxAspect > imgAspect + 0.01) {
          imgWidth = rect.height * imgAspect;
          imgLeft = rect.left + (rect.width - imgWidth) / 2;
        } else if (boxAspect < imgAspect - 0.01) {
          imgHeight = rect.width / imgAspect;
          imgTop = rect.top + (rect.height - imgHeight) / 2;
        }
      }

      const nx = Math.max(0, Math.min(1, (clientX - imgLeft) / Math.max(1, imgWidth)));
      const ny = Math.max(0, Math.min(1, (clientY - imgTop) / Math.max(1, imgHeight)));
      return { x: nx, y: ny };
    }

    viewport.addEventListener(
      'touchstart',
      (e) => {
        if (
          e.target.closest('.remote-floating-hud') ||
          e.target.closest('.remote-scroll-strip') ||
          e.target.closest('#startStreamBtn') ||
          e.target.closest('#laptopTouchpadButtons') ||
          e.target.closest('.laptop-touchpad-buttons') ||
          e.target.closest('.remote-overlay-badges')
        ) {
          return;
        }
        e.preventDefault();
        const effectiveMode = state.isStreaming ? state.remoteInputMode : 'trackpad';
        const padTouches = getPadTouches(e.touches);

        touchCount = padTouches.length;
        clearHoldTimer();

        if (touchCount === 2) {
          // Second finger = zoom/pan the phone view: the first finger must not keep pressing on the PC
          clearSingleTapTimer();
          if (effectiveMode === 'direct') endTouchContact('cancel');
          if (trackpadDragHoldActive) {
            trackpadDragHoldActive = false;
            setLeftButtonHold(false);
          }
          const dx = padTouches[0].clientX - padTouches[1].clientX;
          const dy = padTouches[0].clientY - padTouches[1].clientY;
          pinchStartDist = Math.hypot(dx, dy);
          pinchStartZoom = state.zoomScale;
          pinchStartPanX = state.panX;
          pinchStartPanY = state.panY;

          const midX = (padTouches[0].clientX + padTouches[1].clientX) / 2;
          const midY = (padTouches[0].clientY + padTouches[1].clientY) / 2;
          const vpRect = viewport.getBoundingClientRect();
          pinchFocalOffsetX = midX - (vpRect.left + vpRect.width / 2);
          pinchFocalOffsetY = midY - (vpRect.top + vpRect.height / 2);

          twoFingerLastY = midY;
          twoFingerLastX = midX;
          twoFingerMoved = false;
          return;
        }

        if (touchCount === 1) {
          const t = padTouches[0];
          startX = t.clientX;
          startY = t.clientY;
          lastX = t.clientX;
          lastY = t.clientY;
          relAccX = 0;
          relAccY = 0;
          totalMovedPx = 0;
          touchStartTs = performance.now();
          autoHoldTriggered = false;
          directDragActive = false;
          trackpadDragHoldActive = false;

          if (effectiveMode === 'trackpad') {
            isSecondTapTouch = touchStartTs - lastTapTs < 320;
            if (isSecondTapTouch) {
              // Cancel Tap #1's deferred single click so Windows sees a clean left-button hold for dragging!
              clearSingleTapTimer();
              // Double-tap & hold on Touchpad = Left Click Hold (drag) until finger is released!
              holdTimer = setTimeout(() => {
                if (touchCount === 1 && !trackpadDragHoldActive) {
                  trackpadDragHoldActive = true;
                  setLeftButtonHold(true);
                }
              }, 40);
            } else {
              // Long-press on first touch (holding finger still for 380ms) triggers Right Click
              holdTimer = setTimeout(() => {
                if (totalMovedPx < 10 && !state.isLeftButtonHeld && !trackpadDragHoldActive) {
                  autoHoldTriggered = true;
                  triggerHaptic(28);
                  sendFastInput({
                    type: 'mouse_click',
                    button: 'right'
                  });
                }
              }, 380);
            }
          } else {
            isSecondTapTouch = false;
            const norm = computeImageNormalizedCoords(t.clientX, t.clientY);
            directStartNorm = { x: norm.x, y: norm.y };
            state.cursorNormX = norm.x;
            state.cursorNormY = norm.y;
            showTouchRippleAtNormalized(norm.x, norm.y);
            touchContactDown = true;
            sendTouch('down', norm);
            // Windows shows the right-click menu after a press-and-hold; a short buzz tells the user when
            holdTimer = setTimeout(() => {
              if (touchContactDown && totalMovedPx < 12) triggerHaptic(24);
            }, 650);
          }
        }
      },
      { passive: false }
    );

    viewport.addEventListener(
      'touchmove',
      (e) => {
        if (
          e.target.closest('.remote-floating-hud') ||
          e.target.closest('.remote-scroll-strip') ||
          e.target.closest('#startStreamBtn') ||
          e.target.closest('#laptopTouchpadButtons') ||
          e.target.closest('.laptop-touchpad-buttons') ||
          e.target.closest('.remote-overlay-badges')
        ) {
          return;
        }
        e.preventDefault();
        const effectiveMode = state.isStreaming ? state.remoteInputMode : 'trackpad';
        const padTouches = getPadTouches(e.touches);

        // 2-Finger Pinch-to-Zoom (anchored to pinch focal point!) OR 2-Finger Scroll
        if (padTouches.length === 2) {
          clearHoldTimer();
          const dx = padTouches[0].clientX - padTouches[1].clientX;
          const dy = padTouches[0].clientY - padTouches[1].clientY;
          const dist = Math.hypot(dx, dy);
          const avgX = (padTouches[0].clientX + padTouches[1].clientX) / 2;
          const avgY = (padTouches[0].clientY + padTouches[1].clientY) / 2;

          if (state.isStreaming && Math.abs(dist - pinchStartDist) > 14) {
            twoFingerMoved = true;
            const nextZoom = Math.max(1.0, Math.min(3.5, pinchStartZoom * (dist / Math.max(1, pinchStartDist))));
            const zoomRatio = nextZoom / Math.max(1.0, pinchStartZoom);

            const vpRect = viewport.getBoundingClientRect();
            const curFocalX = avgX - (vpRect.left + vpRect.width / 2);
            const curFocalY = avgY - (vpRect.top + vpRect.height / 2);

            // Keep the pinched spot directly under the user's fingers while zooming
            state.zoomScale = nextZoom;
            state.panX = curFocalX - (pinchFocalOffsetX - pinchStartPanX) * zoomRatio;
            state.panY = curFocalY - (pinchFocalOffsetY - pinchStartPanY) * zoomRatio;
            applyStageZoomAndPan();
          } else if (effectiveMode === 'direct') {
            // Touch mode scrolls with one finger, so two fingers move the zoomed phone view around
            if (state.zoomScale > 1.02 && (Math.abs(avgX - twoFingerLastX) > 2 || Math.abs(avgY - twoFingerLastY) > 2)) {
              twoFingerMoved = true;
              state.panX += avgX - twoFingerLastX;
              state.panY += avgY - twoFingerLastY;
              applyStageZoomAndPan();
            }
            twoFingerLastX = avgX;
            twoFingerLastY = avgY;
          } else if (Math.abs(avgY - twoFingerLastY) > 10) {
            twoFingerMoved = true;
            const deltaY = Math.round((avgY - twoFingerLastY) * 4.5);
            twoFingerLastY = avgY;
            sendFastInput({ type: 'mouse_scroll', deltaY });
          }
          return;
        }

        if (padTouches.length === 1 && touchCount === 1) {
          const t = padTouches[0];
          const dx = t.clientX - lastX;
          const dy = t.clientY - lastY;
          lastX = t.clientX;
          lastY = t.clientY;
          totalMovedPx += Math.hypot(dx, dy);

          if (effectiveMode === 'trackpad' && isSecondTapTouch && !trackpadDragHoldActive && totalMovedPx >= 1) {
            clearHoldTimer();
            clearSingleTapTimer();
            trackpadDragHoldActive = true;
            setLeftButtonHold(true);
          } else if (totalMovedPx > 10) {
            clearHoldTimer();
          }

          if (effectiveMode === 'trackpad') {
            // Sub-pixel relative hardware mouse movement with 1:1 isotropic X/Y speed in all modes & orientations
            const boxW = Math.max(240, (state.isStreaming && screenImg.clientWidth) || viewport.clientWidth || 340);
            const boxH = Math.max(150, (state.isStreaming && screenImg.clientHeight) || viewport.clientHeight || 220);
            const pcW = (state.streamBounds && state.streamBounds.width) || 1920;
            const pcH = (state.streamBounds && state.streamBounds.height) || 1080;

            const velocity = Math.hypot(dx, dy);
            const accel = velocity > 14 ? 1.42 : velocity > 6 ? 1.18 : 1.0;
            const sens = (state.cursorSensitivity * accel) / Math.max(1, state.zoomScale * 0.75);

            // Use a uniform isotropic scale factor so horizontal and vertical speeds are strictly identical (including Fullscreen Touchpad)
            const refBoxSpan = Math.max(240, Math.min(boxW, boxH));
            const refPcSpan = Math.max(1080, Math.min(pcW, pcH));
            const isoScale = (refPcSpan / refBoxSpan) * 1.15;

            relAccX += dx * sens * isoScale;
            relAccY += dy * sens * isoScale;

            state.cursorNormX = Math.max(0, Math.min(1, state.cursorNormX + (dx * sens * isoScale) / Math.max(1, pcW)));
            state.cursorNormY = Math.max(0, Math.min(1, state.cursorNormY + (dy * sens * isoScale) / Math.max(1, pcH)));
            noteLocalCursorMove();

            if (state.isStreaming && state.zoomScale > 1.02) {
              state.panX -= dx * 0.45;
              state.panY -= dy * 0.45;
              applyStageZoomAndPan();
            }

            const now = performance.now();
            if (now - lastMoveSendTs >= 12) {
              const stepX = Math.trunc(relAccX);
              const stepY = Math.trunc(relAccY);
              if (stepX !== 0 || stepY !== 0) {
                relAccX -= stepX;
                relAccY -= stepY;
                lastMoveSendTs = now;
                sendFastInput({
                  type: 'mouse_move_rel',
                  monitorIndex: state.isStreaming ? state.remoteMonitorIndex : -1,
                  dx: stepX,
                  dy: stepY
                });
              }
            }
          } else if (touchContactDown) {
            const norm = computeImageNormalizedCoords(t.clientX, t.clientY);
            state.cursorNormX = norm.x;
            state.cursorNormY = norm.y;
            const now = performance.now();
            if (now - lastMoveSendTs >= 8) {
              lastMoveSendTs = now;
              sendTouch('move', norm);
            }
          }
        }
      },
      { passive: false }
    );

    viewport.addEventListener(
      'touchend',
      (e) => {
        clearHoldTimer();
        const effectiveMode = state.isStreaming ? state.remoteInputMode : 'trackpad';
        const padTouches = getPadTouches(e.touches);

        // 2-Finger Tap = Right Click at cursor!
        if (touchCount === 2 && padTouches.length === 0) {
          if (!twoFingerMoved) {
            triggerHaptic(16);
            if (effectiveMode === 'trackpad') {
              sendFastInput({ type: 'mouse_click', button: 'right' });
            } else {
              sendFastInput({
                type: 'mouse_click',
                button: 'right',
                monitorIndex: state.remoteMonitorIndex,
                x: Number(state.cursorNormX.toFixed(4)),
                y: Number(state.cursorNormY.toFixed(4))
              });
            }
          }
          touchCount = 0;
          return;
        }

        if (effectiveMode === 'direct' && padTouches.length === 0) {
          if (touchContactDown) {
            const t = e.changedTouches && e.changedTouches[0];
            if (t) {
              const norm = computeImageNormalizedCoords(t.clientX, t.clientY);
              state.cursorNormX = norm.x;
              state.cursorNormY = norm.y;
            }
            endTouchContact('up');
          }
          touchCount = 0;
          return;
        }

        if (touchCount === 1 && padTouches.length === 0 && effectiveMode === 'trackpad') {
          // Moves are sent at most every 12 ms; whatever accumulated since the last send would otherwise be lost and
          // the PC cursor would end a little short of where the phone shows it
          const stepX = Math.round(relAccX);
          const stepY = Math.round(relAccY);
          relAccX = 0;
          relAccY = 0;
          if (stepX !== 0 || stepY !== 0) {
            sendFastInput({
              type: 'mouse_move_rel',
              monitorIndex: state.isStreaming ? state.remoteMonitorIndex : -1,
              dx: stepX,
              dy: stepY
            });
          }
        }

        if (touchCount === 1 && padTouches.length === 0) {
          // Release double-tap-and-hold drag when finger lifts off touchpad
          if (trackpadDragHoldActive) {
            const holdElapsed = performance.now() - touchStartTs;
            trackpadDragHoldActive = false;
            isSecondTapTouch = false;
            lastTapTs = 0;
            setLeftButtonHold(false);
            // If user did a quick double-tap without dragging, fire double-click on release
            if (totalMovedPx < 10 && holdElapsed < 175) {
              sendFastInput({
                type: 'mouse_click',
                button: 'left',
                double: true
              });
            }
            touchCount = 0;
            return;
          }

          // If long-press right click was already triggered during this touch, do nothing on lift!
          if (autoHoldTriggered) {
            autoHoldTriggered = false;
            isSecondTapTouch = false;
            touchCount = 0;
            return;
          }

          if (directDragActive && effectiveMode === 'direct') {
            setLeftButtonHold(false, Number(state.cursorNormX.toFixed(4)), Number(state.cursorNormY.toFixed(4)));
            directDragActive = false;
            touchCount = 0;
            return;
          }

          // Tap without moving = Left Click (or Double Click if tapped twice fast!)
          const maxTapMove = effectiveMode === 'direct' ? 16 : 11;
          if (totalMovedPx < maxTapMove) {
            const now = performance.now();
            triggerHaptic(10);
            if (effectiveMode === 'trackpad') {
              if (isSecondTapTouch) {
                clearSingleTapTimer();
                lastTapTs = 0;
                isSecondTapTouch = false;
                sendFastInput({
                  type: 'mouse_click',
                  button: 'left',
                  double: true
                });
              } else {
                lastTapTs = now;
                clearSingleTapTimer();
                singleTapTimer = setTimeout(() => {
                  singleTapTimer = null;
                  sendFastInput({
                    type: 'mouse_click',
                    button: 'left',
                    double: false
                  });
                }, 190);
              }
            } else {
              const isDouble = now - lastTapTs < 320;
              lastTapTs = isDouble ? 0 : now;
              showTouchRippleAtNormalized(state.cursorNormX, state.cursorNormY);
              sendFastInput({
                type: 'mouse_click',
                button: 'left',
                double: isDouble,
                monitorIndex: state.remoteMonitorIndex,
                x: Number(state.cursorNormX.toFixed(4)),
                y: Number(state.cursorNormY.toFixed(4))
              });
            }
          }

          isSecondTapTouch = false;
          touchCount = 0;
        }
      },
      { passive: false }
    );

    viewport.addEventListener('touchcancel', () => {
      clearHoldTimer();
      clearSingleTapTimer();
      if (trackpadDragHoldActive) {
        trackpadDragHoldActive = false;
        isSecondTapTouch = false;
        setLeftButtonHold(false);
      }
      endTouchContact('cancel');
      touchCount = 0;
    });

    // Tapping the FPS badge shows / hides the stream diagnostics
    const fpsBadgeEl = document.getElementById('remoteFpsBadge');
    const statsPanelEl = document.getElementById('remoteStatsPanel');
    if (fpsBadgeEl && statsPanelEl) {
      fpsBadgeEl.addEventListener('click', () => {
        statsPanelEl.classList.toggle('hidden');
        if (!statsPanelEl.classList.contains('hidden')) statsPanelEl.textContent = 'İstatistikler toplanıyor...';
      });
    }

    // Right-Edge Dedicated Touch Scroll Strip
    let stripLastY = null;
    scrollStrip.addEventListener(
      'touchstart',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.touches.length === 1) {
          stripLastY = e.touches[0].clientY;
          triggerHaptic(6);
        }
      },
      { passive: false }
    );

    scrollStrip.addEventListener(
      'touchmove',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.touches.length === 1 && stripLastY !== null) {
          const dy = e.touches[0].clientY - stripLastY;
          if (Math.abs(dy) >= 8) {
            const wheelDelta = Math.round(-dy * 5.2);
            stripLastY = e.touches[0].clientY;
            sendFastInput({ type: 'mouse_scroll', deltaY: wheelDelta });
          }
        }
      },
      { passive: false }
    );

    scrollStrip.addEventListener('touchend', () => {
      stripLastY = null;
    });

    // Live Android Native Keyboard Input Trap
    if (liveKbdTrap) {
      liveKbdTrap.addEventListener('input', () => {
        const val = liveKbdTrap.value;
        if (val) {
          liveKbdTrap.value = '';
          sendCommand('send_input', { type: 'text', text: val }, 1500).catch(() => {});
        }
      });

      liveKbdTrap.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace') {
          e.preventDefault();
          sendCommand('send_input', { type: 'key', key: 'BACKSPACE' }, 1500).catch(() => {});
        } else if (e.key === 'Enter') {
          e.preventDefault();
          sendCommand('send_input', { type: 'key', key: 'ENTER' }, 1500).catch(() => {});
        }
      });
    }
  }

  // MODAL DRAWER SCROLL LOCK & BACKDROP TAP-TO-CLOSE ENGINE
  function bindModalBackdropAndScrollLockEngine() {
    const backdrops = Array.from(document.querySelectorAll('.modal-backdrop'));
    const syncBodyScrollLock = () => {
      const anyOpen = backdrops.some((el) => !el.classList.contains('hidden') && el.classList.contains('is-open'));
      document.body.classList.toggle('modal-open', anyOpen);
      syncAndroidNavBarColor();
    };

    const observer = new MutationObserver(syncBodyScrollLock);
    backdrops.forEach((backdrop) => {
      observer.observe(backdrop, { attributes: true, attributeFilter: ['class'] });
      // Clicking the dark backdrop outside .modal-sheet smoothly closes the drawer
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) {
          triggerHaptic(8);
          closeModal(backdrop);
        }
      });
    });
    syncBodyScrollLock();

    // Instant silent reconnect on app foreground / network recovery
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && getActiveDevice()) {
        if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
          connectToActiveDevice(true);
        } else {
          measureLatency(true);
        }
      }
    });

    // Wi-Fi <-> mobile data switch: the old TCP connection is gone even if the socket has not noticed yet
    window.addEventListener('online', () => {
      if (!getActiveDevice()) return;
      if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
        connectToActiveDevice(true);
      } else {
        measureLatency(true);
      }
    });
  }

  // HORIZONTAL SWIPE PAGER ENGINE ACROSS ALL 5 WORKSPACE TABS
  function bindWorkspaceHorizontalSwipeEngine() {
    const workspaceEl = document.getElementById('view-connected-workspace');
    const trackEl = document.getElementById('workspaceTabsTrack');
    const indicatorEl = document.getElementById('navActiveIndicator');
    const swipeSurfaceEl = document.getElementById('mainViewport') || workspaceEl;
    if (!workspaceEl || !trackEl || !swipeSurfaceEl) return;

    let tracking = false;
    let activeTouchId = null;
    let axisLocked = null; // 'x' | 'y' | null
    let startX = 0;
    let startY = 0;
    let lastDx = 0;
    let startTime = 0;
    let startTabIdx = 0;

    const finishSwipe = () => {
      if (!tracking) {
        if (trackEl.classList.contains('is-dragging')) {
          trackEl.classList.remove('is-dragging');
          if (indicatorEl) indicatorEl.style.transition = '';
          switchToTab(state.activeTab, true);
        }
        axisLocked = null;
        activeTouchId = null;
        return;
      }
      tracking = false;
      activeTouchId = null;
      if (axisLocked !== 'x') {
        axisLocked = null;
        return;
      }

      trackEl.classList.remove('is-dragging');
      if (indicatorEl) indicatorEl.style.transition = '';

      const viewW = Math.max(300, workspaceEl.clientWidth || window.innerWidth || 360);
      const elapsed = Math.max(1, performance.now() - startTime);
      const velocityX = lastDx / elapsed; // px per ms
      const shouldAdvance = Math.abs(lastDx) > viewW * 0.2 || Math.abs(velocityX) > 0.36;

      let targetIdx = startTabIdx;
      if (shouldAdvance) {
        if (lastDx < 0 && startTabIdx < TAB_ORDER.length - 1) {
          targetIdx = startTabIdx + 1;
        } else if (lastDx > 0 && startTabIdx > 0) {
          targetIdx = startTabIdx - 1;
        }
      }

      switchToTab(TAB_ORDER[targetIdx], true);
      axisLocked = null;
    };

    swipeSurfaceEl.addEventListener(
      'touchstart',
      (e) => {
        if (workspaceEl.classList.contains('hidden')) {
          finishSwipe();
          return;
        }
        // If a 2nd finger touches while dragging, snap cleanly instead of freezing mid-swipe
        if (e.touches.length !== 1) {
          finishSwipe();
          return;
        }
        if (
          document.body.classList.contains('modal-open') ||
          document.body.classList.contains('layout-edit-mode') ||
          state.isFullscreen
        ) {
          finishSwipe();
          return;
        }
        // Do not hijack touch inside the interactive Remote Desktop / Trackpad viewport or range sliders / horizontal pills
        if (
          e.target.closest('#remoteViewportBox') ||
          e.target.closest('input[type="range"]') ||
          e.target.closest('.monitor-pill-row')
        ) {
          finishSwipe();
          return;
        }

        const t = e.touches[0];
        tracking = true;
        activeTouchId = t.identifier;
        axisLocked = null;
        startX = t.clientX;
        startY = t.clientY;
        lastDx = 0;
        startTime = performance.now();
        startTabIdx = Math.max(0, TAB_ORDER.indexOf(state.activeTab));
      },
      { passive: true }
    );

    swipeSurfaceEl.addEventListener(
      'touchmove',
      (e) => {
        if (!tracking) return;
        if (e.touches.length !== 1 || e.touches[0].identifier !== activeTouchId) {
          finishSwipe();
          return;
        }
        const t = e.touches[0];
        const dx = t.clientX - startX;
        const dy = t.clientY - startY;

        if (!axisLocked) {
          if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
          if (Math.abs(dx) > Math.abs(dy) * 1.2) {
            axisLocked = 'x';
            trackEl.classList.add('is-dragging');
            if (indicatorEl) indicatorEl.style.transition = 'none';
          } else {
            axisLocked = 'y';
            tracking = false;
            activeTouchId = null;
            return;
          }
        }

        if (axisLocked === 'x') {
          if (e.cancelable) e.preventDefault();
          lastDx = dx;
          const viewW = Math.max(300, workspaceEl.clientWidth || window.innerWidth || 360);
          let effectiveDx = dx;
          if ((startTabIdx === 0 && dx > 0) || (startTabIdx === TAB_ORDER.length - 1 && dx < 0)) {
            effectiveDx = dx * 0.26;
          }
          const stepPercent = 100 / TAB_ORDER.length;
          trackEl.style.transform = `translate3d(calc(-${(startTabIdx * stepPercent).toFixed(4)}% + ${effectiveDx.toFixed(1)}px), 0, 0)`;

          if (indicatorEl) {
            const fractionalIdx = Math.max(
              0,
              Math.min(TAB_ORDER.length - 1, startTabIdx - effectiveDx / viewW)
            );
            indicatorEl.style.transform = `translate3d(${(fractionalIdx * 100).toFixed(2)}%, 0, 0)`;
          }
        }
      },
      { passive: false }
    );

    swipeSurfaceEl.addEventListener('touchend', finishSwipe, { passive: true });
    swipeSurfaceEl.addEventListener('touchcancel', finishSwipe, { passive: true });
  }

  // HORIZONTAL SWIPE PAGER ENGINE FOR DEVICE HUB (CİHAZLAR <-> AYARLAR)
  function bindHubHorizontalSwipeEngine() {
    const hubViewEl = document.getElementById('view-device-hub');
    const trackEl = document.getElementById('hubTabsTrack');
    const indicatorEl = document.getElementById('hubNavActiveIndicator');
    const swipeSurfaceEl = document.getElementById('mainViewport') || hubViewEl;
    if (!hubViewEl || !trackEl || !swipeSurfaceEl) return;

    let tracking = false;
    let activeTouchId = null;
    let axisLocked = null;
    let startX = 0;
    let startY = 0;
    let lastDx = 0;
    let startTime = 0;
    let startTabIdx = 0;

    const finishSwipe = () => {
      if (!tracking) {
        if (trackEl.classList.contains('is-dragging')) {
          trackEl.classList.remove('is-dragging');
          if (indicatorEl) indicatorEl.style.transition = '';
          switchToHubTab(state.activeHubTab, true);
        }
        axisLocked = null;
        activeTouchId = null;
        return;
      }
      tracking = false;
      activeTouchId = null;
      if (axisLocked !== 'x') {
        axisLocked = null;
        return;
      }

      trackEl.classList.remove('is-dragging');
      if (indicatorEl) indicatorEl.style.transition = '';

      const viewW = Math.max(300, hubViewEl.clientWidth || window.innerWidth || 360);
      const elapsed = Math.max(1, performance.now() - startTime);
      const velocityX = lastDx / elapsed;
      const shouldAdvance = Math.abs(lastDx) > viewW * 0.2 || Math.abs(velocityX) > 0.36;

      let targetIdx = startTabIdx;
      if (shouldAdvance) {
        if (lastDx < 0 && startTabIdx < HUB_TAB_ORDER.length - 1) {
          targetIdx = startTabIdx + 1;
        } else if (lastDx > 0 && startTabIdx > 0) {
          targetIdx = startTabIdx - 1;
        }
      }

      switchToHubTab(HUB_TAB_ORDER[targetIdx], true);
      axisLocked = null;
    };

    swipeSurfaceEl.addEventListener(
      'touchstart',
      (e) => {
        if (hubViewEl.classList.contains('hidden') || e.touches.length !== 1) {
          finishSwipe();
          return;
        }
        if (
          document.body.classList.contains('modal-open') ||
          document.body.classList.contains('layout-edit-mode') ||
          (e.target && e.target.closest && e.target.closest('button, input, select, textarea, a, label'))
        ) {
          finishSwipe();
          return;
        }
        const t = e.touches[0];
        tracking = true;
        activeTouchId = t.identifier;
        axisLocked = null;
        startX = t.clientX;
        startY = t.clientY;
        lastDx = 0;
        startTime = performance.now();
        startTabIdx = Math.max(0, HUB_TAB_ORDER.indexOf(state.activeHubTab));
      },
      { passive: true }
    );

    swipeSurfaceEl.addEventListener(
      'touchmove',
      (e) => {
        if (!tracking || hubViewEl.classList.contains('hidden')) return;
        if (e.touches.length !== 1 || e.touches[0].identifier !== activeTouchId) {
          finishSwipe();
          return;
        }
        const t = e.touches[0];
        const dx = t.clientX - startX;
        const dy = t.clientY - startY;

        if (!axisLocked) {
          if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
          if (Math.abs(dx) > Math.abs(dy) * 1.2) {
            axisLocked = 'x';
            trackEl.classList.add('is-dragging');
            if (indicatorEl) indicatorEl.style.transition = 'none';
          } else {
            axisLocked = 'y';
            tracking = false;
            activeTouchId = null;
            return;
          }
        }

        if (axisLocked === 'x') {
          if (e.cancelable) e.preventDefault();
          lastDx = dx;
          const viewW = Math.max(300, hubViewEl.clientWidth || window.innerWidth || 360);
          let effectiveDx = dx;
          if ((startTabIdx === 0 && dx > 0) || (startTabIdx === HUB_TAB_ORDER.length - 1 && dx < 0)) {
            effectiveDx = dx * 0.26;
          }
          const stepPercent = 50;
          trackEl.style.transform = `translate3d(calc(-${(startTabIdx * stepPercent).toFixed(4)}% + ${effectiveDx.toFixed(1)}px), 0, 0)`;

          if (indicatorEl) {
            const fractionalIdx = Math.max(
              0,
              Math.min(HUB_TAB_ORDER.length - 1, startTabIdx - effectiveDx / viewW)
            );
            indicatorEl.style.transform = `translate3d(${(fractionalIdx * 100).toFixed(2)}%, 0, 0)`;
          }
        }
      },
      { passive: false }
    );

    swipeSurfaceEl.addEventListener('touchend', finishSwipe, { passive: true });
    swipeSurfaceEl.addEventListener('touchcancel', finishSwipe, { passive: true });
  }

  function initSettingsControls() {
    const s = userSettings;
    const medToggle = document.getElementById('settingMediaNotification');
    if (window.TahaNative && typeof window.TahaNative.setMediaNotificationEnabled === 'function') {
      try {
        window.TahaNative.setMediaNotificationEnabled(Boolean(s.mediaNotification !== false));
      } catch {}
    }
    if (medToggle) {
      medToggle.checked = Boolean(s.mediaNotification !== false);
      medToggle.addEventListener('change', () => {
        s.mediaNotification = medToggle.checked;
        saveUserSettings(s);
        if (window.TahaNative && typeof window.TahaNative.setMediaNotificationEnabled === 'function') {
          try {
            window.TahaNative.setMediaNotificationEnabled(Boolean(s.mediaNotification));
          } catch {}
        }
        if (!s.mediaNotification) {
          state.lastMediaNotifHash = 'CLEAR';
          if (window.TahaNative && typeof window.TahaNative.clearMediaNotification === 'function') {
            window.TahaNative.clearMediaNotification();
          }
        } else {
          state.lastMediaNotifHash = '';
          syncAndroidMediaNotification();
        }
        showToast(s.mediaNotification ? 'Bildirim panelinde medya gösterimi açık' : 'Bildirim panelinde medya kapatıldı');
      });
    }

    const connToggle = document.getElementById('settingConnNotification');
    if (connToggle) {
      connToggle.checked = Boolean(s.connNotification !== false);
      connToggle.addEventListener('change', () => {
        s.connNotification = connToggle.checked;
        saveUserSettings(s);
      });
    }

    const curToggle = document.getElementById('settingVirtualCursor');
    if (curToggle) {
      curToggle.checked = Boolean(s.virtualCursor !== false);
      curToggle.addEventListener('change', () => {
        s.virtualCursor = curToggle.checked;
        saveUserSettings(s);
        remoteRender.cursorEnabled = Boolean(s.virtualCursor);
        updateVirtualCursorVisual();
      });
    }

    const functionPrefsRows = document.getElementById('functionPrefsRows');
    if (functionPrefsRows) {
      functionPrefsRows.addEventListener('change', (e) => {
        const sel = e.target && e.target.closest ? e.target.closest('[data-function-pref]') : null;
        if (!sel) return;
        triggerHaptic(10);
        saveFunctionPref(sel.getAttribute('data-function-pref'), sel.value);
      });
    }
    renderFunctionPrefs();

    const codecSelect = document.getElementById('settingVideoCodec');
    if (codecSelect) {
      codecSelect.value = ['auto', 'av1', 'h264'].includes(s.videoCodec) ? s.videoCodec : 'auto';
      codecSelect.addEventListener('change', () => {
        s.videoCodec = codecSelect.value;
        saveUserSettings(s);
        // Applies immediately to a running stream
        if (state.isStreaming) startRemoteStream();
      });
    }

    const zoomToggle = document.getElementById('settingDoubleTapZoom');
    if (zoomToggle) {
      zoomToggle.checked = Boolean(s.doubleTapZoom !== false);
      zoomToggle.addEventListener('change', () => {
        s.doubleTapZoom = zoomToggle.checked;
        saveUserSettings(s);
      });
    }

    const hapToggle = document.getElementById('settingHapticFeedback');
    if (hapToggle) {
      hapToggle.checked = Boolean(s.hapticFeedback !== false);
      hapToggle.addEventListener('change', () => {
        s.hapticFeedback = hapToggle.checked;
        saveUserSettings(s);
      });
    }

    const recToggle = document.getElementById('settingAutoReconnect');
    if (recToggle) {
      recToggle.checked = Boolean(s.autoReconnect !== false);
      recToggle.addEventListener('change', () => {
        s.autoReconnect = recToggle.checked;
        saveUserSettings(s);
      });
    }

    // Software Update Section (GitHub blttaha/bridge)
    const verTitleEl = document.getElementById('updateVersionTitle');
    const statusCapEl = document.getElementById('updateStatusCaption');
    const checkUpdateBtn = document.getElementById('btnCheckUpdatesSetting');
    const actionBtnsRow = document.getElementById('updateActionButtonsRow');
    const installApkBtn = document.getElementById('btnInstallAndroidUpdate');
    const installPcBtn = document.getElementById('btnInstallPcUpdate');

    let currentAppVer = '2.19.3';
    try {
      if (window.TahaNative && typeof window.TahaNative.getAppVersion === 'function') {
        const nv = window.TahaNative.getAppVersion();
        if (nv) currentAppVer = String(nv).trim();
      }
    } catch {}
    if (verTitleEl) {
      verTitleEl.textContent = `Bridge v${currentAppVer}`;
    }

    let latestApkUrl = 'https://github.com/blttaha/bridge/releases/latest/download/Bridge.apk';

    if (checkUpdateBtn) {
      checkUpdateBtn.addEventListener('click', async () => {
        triggerHaptic(10);
        checkUpdateBtn.disabled = true;
        checkUpdateBtn.textContent = 'Denetleniyor...';
        if (statusCapEl) statusCapEl.textContent = 'GitHub (blttaha/bridge) üzerinden güncel sürüm kontrol ediliyor...';

        let latestVer = currentAppVer;
        let pcUpdateInfo = null;

        try {
          if (state.isAuthenticated) {
            pcUpdateInfo = await sendCommand('check_update', {}, 8000).catch(() => null);
          }
          if (pcUpdateInfo && pcUpdateInfo.latestVersion) {
            latestVer = pcUpdateInfo.latestVersion;
            if (pcUpdateInfo.assets && pcUpdateInfo.assets.android) {
              latestApkUrl = pcUpdateInfo.assets.android;
            }
          } else {
            const resp = await fetch('https://api.github.com/repos/blttaha/bridge/releases/latest');
            if (resp.ok) {
              const rel = await resp.json();
              if (rel && rel.tag_name) {
                latestVer = String(rel.tag_name).replace(/^v/i, '').trim();
              }
              if (rel && Array.isArray(rel.assets)) {
                const apkAsset = rel.assets.find((a) => a && a.name === 'Bridge.apk');
                if (apkAsset && apkAsset.browser_download_url) {
                  latestApkUrl = apkAsset.browser_download_url;
                }
              }
            }
          }

          const cmpSemver = (a, b) => {
            const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
            const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
            for (let i = 0; i < 3; i++) {
              if ((pa[i] || 0) > (pb[i] || 0)) return 1;
              if ((pa[i] || 0) < (pb[i] || 0)) return -1;
            }
            return 0;
          };

          const hasPhoneUpdate = cmpSemver(latestVer, currentAppVer) > 0;
          const hasPcUpdate = Boolean(pcUpdateInfo && pcUpdateInfo.updateAvailable);

          if (actionBtnsRow) actionBtnsRow.classList.remove('hidden');
          if (installApkBtn) {
            installApkBtn.textContent = hasPhoneUpdate
              ? `Telefon Uygulamasını Güncelle (v${latestVer} APK)`
              : `Telefon Sürümünü Yeniden Kur (v${latestVer} APK)`;
          }
          if (installPcBtn) {
            if (state.isAuthenticated) {
              installPcBtn.classList.remove('hidden');
              installPcBtn.textContent = hasPcUpdate
                ? `Bağlı Bilgisayarı Güncelle (v${latestVer})`
                : `Bağlı Bilgisayarı Yeniden Güncelle (v${latestVer})`;
            } else {
              installPcBtn.classList.add('hidden');
            }
          }

          if (hasPhoneUpdate || hasPcUpdate) {
            if (statusCapEl) statusCapEl.textContent = `Yeni sürüm mevcut: v${latestVer}`;
            showToast(`Yeni sürüm bulundu: v${latestVer}`);
          } else {
            if (statusCapEl) statusCapEl.textContent = `En güncel sürümü kullanıyorsunuz (v${latestVer}). İsterseniz aşağıdan yeniden kurabilirsiniz.`;
            showToast(`Sürüm güncel (v${latestVer})`);
          }
        } catch (err) {
          if (statusCapEl) statusCapEl.textContent = `Güncelleme kontrolü başarısız: ${err.message || 'Bağlantı hatası'}`;
          showToast('Güncelleme sunucusuna ulaşılamadı');
        } finally {
          checkUpdateBtn.disabled = false;
          checkUpdateBtn.textContent = 'Denetle';
        }
      });
    }

    if (installApkBtn) {
      installApkBtn.addEventListener('click', () => {
        triggerHaptic(14);
        if (window.TahaNative && typeof window.TahaNative.downloadAndInstallApk === 'function') {
          window.TahaNative.downloadAndInstallApk(latestApkUrl);
          showToast('Bridge.apk indiriliyor, tamamlandığında kurulum penceresi açılacak...');
        } else {
          window.open(latestApkUrl, '_blank');
          showToast('APK indirme bağlantısı açıldı');
        }
      });
    }

    if (installPcBtn) {
      installPcBtn.addEventListener('click', async () => {
        triggerHaptic(14);
        if (!state.isAuthenticated) {
          showToast('Önce bilgisayara bağlanın');
          return;
        }
        installPcBtn.disabled = true;
        installPcBtn.textContent = 'PC Güncelleniyor...';
        try {
          const res = await sendCommand('perform_update', {}, 25000);
          showToast((res && res.message) || 'PC güncelleniyor ve servis yeniden başlatılıyor...');
        } catch (err) {
          showToast(err.message || 'PC güncellemesi başlatılamadı');
        } finally {
          installPcBtn.disabled = false;
          installPcBtn.textContent = 'Bağlı Bilgisayarı Güncelle (PC)';
        }
      });
    }
  }

  // EVENT LISTENERS
  function bindEvents() {
    bindModalBackdropAndScrollLockEngine();
    bindWorkspaceHorizontalSwipeEngine();
    bindHubHorizontalSwipeEngine();
    bindRemoteWorkstationGestureEngine();
    window.addEventListener('resize', () => requestAnimationFrame(updateVirtualCursorVisual));

    // In-Device Bottom Navigation Tabs (5 tabs: Sahneler, Uygulamalar, Ekranlar, Uzaktan, Sistem)
    document.querySelectorAll('#bottomNav .nav-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetTab = btn.getAttribute('data-tab');
        if (targetTab) switchToTab(targetTab, true);
      });
    });

    // Global Home / Hub Bottom Navigation Tabs (2 tabs: Cihazlar, Ayarlar)
    document.querySelectorAll('#hubBottomNav .hub-nav-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetHubTab = btn.getAttribute('data-hub-tab');
        if (targetHubTab) switchToHubTab(targetHubTab);
      });
    });

    // Top bar actions
    const openDeviceModal = () => {
      triggerHaptic(10);
      renderSavedDevicesList();
      openModal('deviceSheetModal');
      scanNetworkForDevices();
    };

    const homeBtn = document.getElementById('homeHubBtn');
    if (homeBtn) {
      homeBtn.addEventListener('click', () => {
        triggerHaptic(10);
        if (!state.showingHubView) {
          state.showingHubView = true;
          syncConnectionViewState();
          switchToHubTab('hub-tab-devices');
          scanNetworkForDevices();
        } else if (getActiveDevice()) {
          state.showingHubView = false;
          syncConnectionViewState();
        }
      });
    }

    const auditBtn = document.getElementById('auditLogBtn');
    if (auditBtn) {
      auditBtn.addEventListener('click', () => {
        triggerHaptic(10);
        renderAuditLogModal();
        openModal('connectionAuditLogModal');
      });
    }

    const closeAuditBtn = document.getElementById('closeAuditLogModalBtn');
    if (closeAuditBtn) {
      closeAuditBtn.addEventListener('click', () => closeModal('connectionAuditLogModal'));
    }

    const clearAuditBtn = document.getElementById('clearAuditLogBtn');
    if (clearAuditBtn) {
      clearAuditBtn.addEventListener('click', () => {
        triggerHaptic(10);
        localStorage.removeItem(AUDIT_LOG_STORAGE_KEY);
        renderAuditLogModal();
        showToast('Denetim kaydı temizlendi');
      });
    }

    const clearAuditSettingBtn = document.getElementById('btnClearAuditLogSetting');
    if (clearAuditSettingBtn) {
      clearAuditSettingBtn.addEventListener('click', () => {
        triggerHaptic(10);
        localStorage.removeItem(AUDIT_LOG_STORAGE_KEY);
        renderAuditLogModal();
        showToast('Denetim kaydı temizlendi');
      });
    }


    const openDeviceSheetBtn = document.getElementById('openDeviceSheetBtn');
    if (openDeviceSheetBtn) openDeviceSheetBtn.addEventListener('click', openDeviceModal);

    const openPairModalBtn = document.getElementById('openPairModalBtn');
    if (openPairModalBtn) openPairModalBtn.addEventListener('click', openDeviceModal);

    const offlineSwitchDeviceBtn = document.getElementById('offlineSwitchDeviceBtn');
    if (offlineSwitchDeviceBtn) offlineSwitchDeviceBtn.addEventListener('click', openDeviceModal);

    const closeDeviceSheetBtn = document.getElementById('closeDeviceSheetBtn');
    if (closeDeviceSheetBtn) {
      closeDeviceSheetBtn.addEventListener('click', () => {
        closeModal('deviceSheetModal');
      });
    }

    const scanNetworkBtn = document.getElementById('scanNetworkBtn');
    if (scanNetworkBtn) {
      scanNetworkBtn.addEventListener('click', () => {
        triggerHaptic(10);
        scanNetworkForDevices();
      });
    }

    const hubScanBtn = document.getElementById('hubScanBtn');
    if (hubScanBtn) {
      hubScanBtn.addEventListener('click', () => {
        triggerHaptic(10);
        scanNetworkForDevices();
      });
    }

    const quickRefreshBtn = document.getElementById('quickRefreshBtn');
    if (quickRefreshBtn) {
      quickRefreshBtn.addEventListener('click', async () => {
        triggerHaptic(10);
        if (!state.devices.length) {
          scanNetworkForDevices();
          return;
        }
        if (!state.isAuthenticated) {
          connectToActiveDevice();
          return;
        }
        try {
          const res = await sendCommand('get_full_state');
          state.monitors = res.monitors || [];
          state.windows = res.windows || [];
          state.scenes = res.scenes || [];
          state.macros = res.macros || [];
          state.quickActions = res.quickActions || [];
          if (res.audio) state.audio = reconcileMediaIntent(res.audio);
          if (res.stats) {
            state.stats = res.stats;
            if (typeof res.stats.isLocked === 'boolean') {
              state.isPcLocked = res.stats.isLocked;
            }
          }
          if (res.powerTimer) state.powerTimer = res.powerTimer;
          renderAllConnectedViews();
          showToast('Durum güncellendi');
        } catch {
          connectToActiveDevice();
        }
      });
    }

    initSettingsControls();

    // Offline Power Console Buttons
    document.getElementById('powerOnMainBtn').addEventListener('click', () => {
      triggerPowerOn(getActiveDevice());
    });

    document.getElementById('offlineRetryBtn').addEventListener('click', async () => {
      triggerHaptic(12);
      const ok = await connectToActiveDevice();
      if (!ok) {
        showToast('Cihaz henüz yanıt vermiyor');
      }
    });

    const hubPinInputEl = document.getElementById('hubPinInput');
    if (hubPinInputEl) {
      hubPinInputEl.addEventListener('input', () => {
        const clean = hubPinInputEl.value
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, '')
          .slice(0, 8);
        hubPinInputEl.value = clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
      });
    }

    // Hub Pairing Form Submit (8-char code only)
    const hubPairFormEl = document.getElementById('hubPairForm');
    if (hubPairFormEl) {
      hubPairFormEl.addEventListener('submit', async (e) => {
        e.preventDefault();
        triggerHaptic(15);
        const pin = (document.getElementById('hubPinInput') && document.getElementById('hubPinInput').value.trim()) || '';
        await performDevicePairing('', pin);
      });
    }

    // Hub Saved Devices list delegation + Long-Press for Device Details Modal
    const hubSavedDevicesListEl = document.getElementById('hubSavedDevicesList');
    if (hubSavedDevicesListEl) {
      let hubPressTimer = null;
      let hubLongPressFired = false;

      const clearHubPress = () => {
        if (hubPressTimer) {
          clearTimeout(hubPressTimer);
          hubPressTimer = null;
        }
      };

      hubSavedDevicesListEl.addEventListener(
        'touchstart',
        (e) => {
          const card = e.target.closest('[data-hub-device-id]');
          if (!card) return;
          hubLongPressFired = false;
          const devId = card.getAttribute('data-hub-device-id');
          clearHubPress();
          hubPressTimer = setTimeout(() => {
            hubLongPressFired = true;
            triggerHaptic(22);
            const dev = state.devices.find((d) => d.deviceId === devId);
            if (dev) openDeviceDetailModal(dev);
          }, 420);
        },
        { passive: true }
      );

      hubSavedDevicesListEl.addEventListener('touchmove', clearHubPress, { passive: true });
      hubSavedDevicesListEl.addEventListener('touchend', clearHubPress, { passive: true });
      hubSavedDevicesListEl.addEventListener('touchcancel', clearHubPress, { passive: true });

      hubSavedDevicesListEl.addEventListener('contextmenu', (e) => {
        const card = e.target.closest('[data-hub-device-id]');
        if (!card) return;
        e.preventDefault();
        clearHubPress();
        hubLongPressFired = true;
        triggerHaptic(22);
        const devId = card.getAttribute('data-hub-device-id');
        const dev = state.devices.find((d) => d.deviceId === devId);
        if (dev) openDeviceDetailModal(dev);
      });

      hubSavedDevicesListEl.addEventListener('click', (e) => {
        if (hubLongPressFired) {
          hubLongPressFired = false;
          e.preventDefault();
          return;
        }
        const selBtn = e.target.closest('[data-select-device]');
        if (selBtn) {
          triggerHaptic(12);
          stopBootWatcher();
          const targetId = selBtn.getAttribute('data-select-device');
          const targetDev = state.devices.find((d) => d.deviceId === targetId);
          if (targetDev && (targetDev.connectionRevoked || !targetDev.authToken)) {
            const pinInput = document.getElementById('hubPinInput');
            if (pinInput) {
              pinInput.focus();
            }
            showToast(`${targetDev.deviceName || 'Bilgisayar'} bağlantısı koparılmış. Görev çubuğundan yeni 8 haneli kod girin.`);
            return;
          }
          const wasSameActive = state.activeDeviceId === targetId;
          state.activeDeviceId = targetId;
          state.showingHubView = false;
          if (!wasSameActive) {
            resetActiveDeviceWorkspaceState(targetId);
          }
          saveDevicesToStorage();
          syncConnectionViewState();
          if (!wasSameActive || !state.isAuthenticated) {
            connectToActiveDevice();
          }
        }
      });
    }

    // Per-PC function preferences live behind System > Özelleştirmeler
    const openFunctionPrefsBtn = document.getElementById('openFunctionPrefsBtn');
    if (openFunctionPrefsBtn) {
      openFunctionPrefsBtn.addEventListener('click', () => {
        triggerHaptic(10);
        renderFunctionPrefs();
        openModal('functionPrefsModal');
      });
    }
    const closeFunctionPrefsBtn = document.getElementById('closeFunctionPrefsModalBtn');
    if (closeFunctionPrefsBtn) closeFunctionPrefsBtn.addEventListener('click', () => closeModal('functionPrefsModal'));

    // Device Detail Modal bindings (opened via long-press on Home page)
    const closeDevDetailBtn = document.getElementById('closeDeviceDetailModalBtn');
    if (closeDevDetailBtn) {
      closeDevDetailBtn.addEventListener('click', () => closeModal('deviceDetailModal'));
    }

    const detailWolBtn = document.getElementById('detailModalWolBtn');
    if (detailWolBtn) {
      detailWolBtn.addEventListener('click', () => {
        triggerHaptic(15);
        const dev = state.devices.find((d) => d.deviceId === state.inspectingDeviceId);
        closeModal('deviceDetailModal');
        if (dev) triggerPowerOn(dev);
      });
    }

    const detailDiscBtn = document.getElementById('detailModalDisconnectBtn');
    if (detailDiscBtn) {
      detailDiscBtn.addEventListener('click', () => {
        triggerHaptic(15);
        closeModal('deviceDetailModal');
        state.isAuthenticated = false;
        state.connectedRoute = '';
        if (state.ws) {
          try {
            state.ws.close();
          } catch {}
        }
        renderSavedDevicesList();
        syncConnectionViewState();
        logAuditEvent('disconnect', 'Aktif bilgisayar bağlantısı kullanıcı tarafından kesildi');
        showToast('Aktif bağlantı kesildi');
      });
    }

    const detailDelBtn = document.getElementById('detailModalDeleteBtn');
    if (detailDelBtn) {
      detailDelBtn.addEventListener('click', () => {
        triggerHaptic(18);
        const id = state.inspectingDeviceId;
        closeModal('deviceDetailModal');
        if (id) removeDevice(id);
      });
    }

    // Device Sheet delegation (tap only, no long-press, no extra buttons)
    const deviceSheetModalEl = document.getElementById('deviceSheetModal');
    if (deviceSheetModalEl) {
      deviceSheetModalEl.addEventListener('click', (e) => {
        const selBtn = e.target.closest('[data-select-device]');
        if (selBtn) {
          triggerHaptic(12);
          stopBootWatcher();
          const targetId = selBtn.getAttribute('data-select-device');
          const targetDev = state.devices.find((d) => d.deviceId === targetId);
          if (targetDev && (targetDev.connectionRevoked || !targetDev.authToken)) {
            const pairPinEl = document.getElementById('pairPinInput');
            const pairHostEl = document.getElementById('pairHostInput');
            if (pairHostEl && targetDev.lanIp && targetDev.lanIp !== '-') {
              pairHostEl.value = targetDev.lanIp;
            }
            if (pairPinEl) {
              pairPinEl.focus();
            }
            showToast(`${targetDev.deviceName || 'Bilgisayar'} bağlantısı koparılmış. Aşağıdan yeni 8 haneli güvenlik kodunu girin.`);
            return;
          }
          const wasSameActive = state.activeDeviceId === targetId;
          state.activeDeviceId = targetId;
          state.showingHubView = false;
          if (!wasSameActive) {
            resetActiveDeviceWorkspaceState(targetId);
          }
          saveDevicesToStorage();
          closeModal('deviceSheetModal');
          syncConnectionViewState();
          if (!wasSameActive || !state.isAuthenticated) {
            connectToActiveDevice();
          }
        }
      });
    }

    // Quick Action Strip (Anlık Müdahale) & Dynamic Customizer
    const AVAILABLE_QUICK_TILES = [
      {
        id: 'monitors-off',
        title: 'Ekranları Kapat',
        icon: `<svg class="tile-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2.5" y="3.5" width="15" height="10" rx="1.5" /><path d="M7 16.5h6M10 13.5v3M3 3l14 14" stroke-linecap="round" /></svg>`
      },
      {
        id: 'monitors-on',
        title: 'Ekranları Aç',
        icon: `<svg class="tile-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2.5" y="3.5" width="15" height="10" rx="1.5" /><path d="M7 16.5h6M10 13.5v3" stroke-linecap="round" /></svg>`
      },
      {
        id: 'show-desktop',
        title: 'Masaüstü',
        icon: `<svg class="tile-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="14" height="12" rx="1.5" /><path d="M3 12.5h14" stroke-linecap="round" /></svg>`
      },
      {
        id: 'lock-pc',
        title: 'Kilitle',
        icon: `<svg class="tile-icon" id="quickLockIcon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4.5" y="9" width="11" height="7.5" rx="1.5" /><path d="M7 9V6.5a3 3 0 0 1 6 0V9" stroke-linecap="round" /></svg>`
      },
      {
        id: 'sleep-pc',
        title: 'Uyku',
        icon: `<svg class="tile-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M16 11.5A6.5 6.5 0 0 1 8.5 4a6.5 6.5 0 1 0 7.5 7.5z" stroke-linecap="round" stroke-linejoin="round" /></svg>`
      },
      {
        id: 'shutdown-pc',
        title: 'Kapat',
        icon: `<svg class="tile-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 2v7M14.5 4.5a7 7 0 1 1-9 0" stroke-linecap="round" /></svg>`
      },
      {
        id: 'restart-pc',
        title: 'Yeniden Başlat',
        icon: `<svg class="tile-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 10a7 7 0 0 1 11.95-4.95L17 7M17 3v4h-4M17 10a7 7 0 0 1-11.95 4.95L3 13M3 17v-4h4" stroke-linecap="round" stroke-linejoin="round" /></svg>`
      }
    ];

    function getQuickTilesConfig() {
      let cfg = null;
      try {
        cfg = JSON.parse(localStorage.getItem('tahablt_quick_tiles_cfg'));
      } catch {}
      if (!cfg || !Array.isArray(cfg.enabled) || !cfg.enabled.length) {
        cfg = {
          layout: 'compact-row',
          enabled: ['monitors-off', 'monitors-on', 'show-desktop', 'lock-pc']
        };
      }
      return cfg;
    }

    function saveQuickTilesConfig(cfg) {
      try {
        localStorage.setItem('tahablt_quick_tiles_cfg', JSON.stringify(cfg));
      } catch {}
      renderQuickActionStrip();
    }

    function renderQuickActionStrip() {
      const strip = document.getElementById('quickActionStrip');
      if (!strip) return;
      const cfg = getQuickTilesConfig();
      strip.className = `quick-action-strip layout-${cfg.layout || 'compact-row'}`;
      const enabledSet = new Set(cfg.enabled);

      const items = AVAILABLE_QUICK_TILES.filter(t => enabledSet.has(t.id));
      if (!items.length) {
        strip.innerHTML = `<span class="empty-hint" style="grid-column: 1 / -1; padding: 12px; color: var(--ink-secondary); font-size: 13px;">Görüntülenecek buton seçilmedi. Düzenleme menüsünden ekleyebilirsiniz.</span>`;
        return;
      }

      strip.innerHTML = items.map(t => {
        const lockIdAttr = t.id === 'lock-pc' ? 'id="quickLockBtn"' : '';
        const lockLabelAttr = t.id === 'lock-pc' ? 'id="quickLockLabel"' : '';
        const displayTitle = (t.id === 'lock-pc' && state.isPcLocked) ? 'Kilidi Aç' : t.title;
        return `
          <button type="button" class="tactile-tile" data-quick="${t.id}" ${lockIdAttr}>
            ${t.icon}
            <span class="tile-label" ${lockLabelAttr}>${escapeHtml(displayTitle)}</span>
          </button>
        `;
      }).join('');
    }

    async function handleQuickTileAction(type) {
      triggerHaptic(14);
      try {
        if (type === 'monitors-off') {
          await sendCommand('monitor_power', { action: 'off' });
          logAuditEvent('power', 'Tüm monitörler karartıldı');
          showToast('Tüm monitörler kapatıldı');
        } else if (type === 'monitors-on') {
          await sendCommand('monitor_power', { action: 'on', clearBlackouts: true });
          logAuditEvent('power', 'Monitörler uyandırıldı');
          showToast('Monitörler uyandırıldı');
        } else if (type === 'show-desktop') {
          await sendCommand('system_control', { action: 'show_desktop' });
          logAuditEvent('app', 'Masaüstü gösterildi');
          showToast('Masaüstü gösterildi');
        } else if (type === 'lock-pc') {
          applyLockResult(await sendCommand('system_control', { action: 'toggle_lock' }));
        } else if (type === 'sleep-pc') {
          await sendCommand('system_control', { action: 'sleep' });
          logAuditEvent('power', 'Bilgisayar uyku moduna alındı');
          showToast('Bilgisayar uyku moduna alınıyor');
        } else if (type === 'shutdown-pc') {
          await sendCommand('system_control', { action: 'shutdown' });
          logAuditEvent('power', 'Bilgisayarı kapat komutu gönderildi');
          showToast('Bilgisayar kapatılıyor');
        } else if (type === 'restart-pc') {
          await sendCommand('system_control', { action: 'restart' });
          logAuditEvent('power', 'Bilgisayarı yeniden başlat komutu gönderildi');
          showToast('Bilgisayar yeniden başlatılıyor');
        }
      } catch (err) {
        showToast(err.message || 'Komut yürütülemedi');
      }
    }

    function initQuickTilesCustomizer() {
      const editBtn = document.getElementById('editQuickTilesBtn');
      const modal = document.getElementById('quickTilesCustomizerModal');
      const closeBtn = document.getElementById('closeQuickTilesModalBtn');
      const saveBtn = document.getElementById('saveQuickTilesBtn');
      const resetBtn = document.getElementById('resetQuickTilesBtn');
      const pickerList = document.getElementById('quickTilesPickerList');
      const segButtons = document.querySelectorAll('#quickTilesLayoutSegments .segment-btn');

      let tempCfg = getQuickTilesConfig();

      const openCustomizer = () => {
        triggerHaptic(10);
        tempCfg = getQuickTilesConfig();

        segButtons.forEach(btn => {
          btn.classList.toggle('active', btn.getAttribute('data-layout') === (tempCfg.layout || 'compact-row'));
        });

        const enabledSet = new Set(tempCfg.enabled || []);
        if (pickerList) {
          pickerList.innerHTML = AVAILABLE_QUICK_TILES.map(t => {
            const isChecked = enabledSet.has(t.id);
            return `
              <label class="quick-tile-pick-item">
                <div class="quick-tile-pick-left">
                  ${t.icon}
                  <span class="quick-tile-pick-title">${escapeHtml(t.title)}</span>
                </div>
                <input type="checkbox" data-tile-id="${t.id}" ${isChecked ? 'checked' : ''} />
              </label>
            `;
          }).join('');
        }

        openModal('quickTilesCustomizerModal');
      };

      if (editBtn) editBtn.addEventListener('click', openCustomizer);
      if (closeBtn) closeBtn.addEventListener('click', () => closeModal('quickTilesCustomizerModal'));

      segButtons.forEach(btn => {
        btn.addEventListener('click', () => {
          triggerHaptic(8);
          segButtons.forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          tempCfg.layout = btn.getAttribute('data-layout') || 'compact-row';
        });
      });

      if (saveBtn) {
        saveBtn.addEventListener('click', () => {
          triggerHaptic(14);
          if (pickerList) {
            const checks = Array.from(pickerList.querySelectorAll('input[type="checkbox"]'));
            const enabled = checks.filter(c => c.checked).map(c => c.getAttribute('data-tile-id'));
            if (!enabled.length) {
              showToast('En az 1 buton seçmelisiniz');
              return;
            }
            tempCfg.enabled = enabled;
          }
          saveQuickTilesConfig(tempCfg);
          closeModal('quickTilesCustomizerModal');
          showToast('Anlık müdahale düzeni güncellendi');
        });
      }

      if (resetBtn) {
        resetBtn.addEventListener('click', () => {
          triggerHaptic(12);
          tempCfg = {
            layout: 'compact-row',
            enabled: ['monitors-off', 'monitors-on', 'show-desktop', 'lock-pc']
          };
          saveQuickTilesConfig(tempCfg);
          closeModal('quickTilesCustomizerModal');
          showToast('Varsayılan butonlara dönüldü');
        });
      }

      const strip = document.getElementById('quickActionStrip');
      if (strip) {
        strip.addEventListener('click', (e) => {
          const btn = e.target.closest('[data-quick]');
          if (btn) {
            const type = btn.getAttribute('data-quick');
            if (type) handleQuickTileAction(type);
          }
        });
      }

      renderQuickActionStrip();
    }

    initQuickTilesCustomizer();

    // =========================================================================
    // TAB 1.5: DEDICATED APPLICATIONS CATALOG ("UYGULAMALAR") & MANUAL APP MODAL
    // =========================================================================
    const appsSearchInput = document.getElementById('appsTabSearchInput');
    if (appsSearchInput) {
      appsSearchInput.addEventListener('input', () => {
        state.appsSearchQuery = appsSearchInput.value;
        renderAppsTab();
      });
    }

    const appsGrid = document.getElementById('appsCatalogGrid');
    let appCardHoldTimer = null;
    let appCardHoldFired = false;

    if (appsGrid) {
      appsGrid.addEventListener(
        'touchstart',
        (e) => {
          if (e.target.closest('[data-app-info-idx]')) return;
          const card = e.target.closest('[data-app-card-idx]');
          if (!card) return;
          appCardHoldFired = false;
          clearTimeout(appCardHoldTimer);
          const idx = Number(card.getAttribute('data-app-card-idx'));
          appCardHoldTimer = setTimeout(() => {
            appCardHoldFired = true;
            triggerHaptic(22);
            const app = state.installedApps[idx];
            if (app) openPropertiesInspector({ kind: 'installed_app', app });
          }, 420);
        },
        { passive: true }
      );

      appsGrid.addEventListener(
        'touchmove',
        () => {
          clearTimeout(appCardHoldTimer);
        },
        { passive: true }
      );

      appsGrid.addEventListener(
        'touchend',
        () => {
          clearTimeout(appCardHoldTimer);
        },
        { passive: true }
      );

      appsGrid.addEventListener('contextmenu', (e) => {
        const card = e.target.closest('[data-app-card-idx]');
        if (!card) return;
        e.preventDefault();
        clearTimeout(appCardHoldTimer);
        appCardHoldFired = true;
        triggerHaptic(18);
        const app = state.installedApps[Number(card.getAttribute('data-app-card-idx'))];
        if (app) openPropertiesInspector({ kind: 'installed_app', app });
      });

      appsGrid.addEventListener('click', async (e) => {
        const infoBtn = e.target.closest('[data-app-info-idx]');
        if (infoBtn) {
          e.stopPropagation();
          triggerHaptic(12);
          const app = state.installedApps[Number(infoBtn.getAttribute('data-app-info-idx'))];
          if (app) openPropertiesInspector({ kind: 'installed_app', app });
          return;
        }

        const card = e.target.closest('[data-app-card-idx]');
        if (!card) return;
        if (appCardHoldFired) {
          appCardHoldFired = false;
          e.preventDefault();
          return;
        }
        triggerHaptic(14);
        const app = state.installedApps[Number(card.getAttribute('data-app-card-idx'))];
        if (!app) return;
        const targetMon = typeof app.monitorIndex === 'number' ? app.monitorIndex : -1;
        const zonePreset = app.zonePreset || 'none';
        try {
          await sendCommand('launch_app', {
            name: app.name,
            processName: app.processName,
            launchPath: app.launchPath,
            launchArgs: app.launchArgs || '',
            runAsAdmin: Boolean(app.runAsAdmin),
            alwaysOnTop: Boolean(app.alwaysOnTop),
            windowStyle: app.windowStyle || 'normal',
            ifRunning: app.ifRunning || 'new',
            monitorIndex: targetMon,
            zonePreset
          });
          showToast(`${app.name} başlatılıyor`);
        } catch (err) {
          showToast(err.message);
        }
      });
    }

    const openAddAppBtn = document.getElementById('openAddCustomAppBtn');
    if (openAddAppBtn) {
      openAddAppBtn.addEventListener('click', () => {
        triggerHaptic(12);
        openManualAppModal(null);
      });
    }

    const closeAddAppBtn = document.getElementById('closeCustomAppModalBtn');
    if (closeAddAppBtn) {
      closeAddAppBtn.addEventListener('click', () => {
        closeModal('addCustomAppModal');
      });
    }

    const cancelAddAppBtn = document.getElementById('cancelCustomAppModalBtn');
    if (cancelAddAppBtn) {
      cancelAddAppBtn.addEventListener('click', () => {
        closeModal('addCustomAppModal');
      });
    }

    const browseManualAppBtn = document.getElementById('manualAppBrowsePcBtn');
    if (browseManualAppBtn) {
      browseManualAppBtn.addEventListener('click', () => {
        triggerHaptic(10);
        openPcFileBrowser('pick_for_custom_app', state.fsCurrentPath || 'quick:desktop');
      });
    }

    const saveManualAppForm = document.getElementById('saveManualAppForm');
    if (saveManualAppForm) {
      saveManualAppForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        triggerHaptic(16);
        const id = document.getElementById('manualAppIdInput').value.trim();
        const name = document.getElementById('manualAppNameInput').value.trim();
        const launchPath = document.getElementById('manualAppPathInput').value.trim();

        if (!name || !launchPath) {
          showToast('Lütfen uygulama adını ve dosya yolunu girin');
          return;
        }

        try {
          const res = await sendCommand('save_custom_app', {
            app: {
              id: id || undefined,
              name,
              launchPath,
              launchArgs: '',
              runAsAdmin: false
            }
          });
          if (res && Array.isArray(res.installed)) {
            state.installedApps = res.installed;
          }
          if (res && Array.isArray(res.customApps)) {
            state.customApps = res.customApps;
          }
          renderAppsTab();
          renderScenesList();
          renderQuickActionsList();
          closeModal('addCustomAppModal');
          showToast(`"${name}" Uygulamalar kataloğuna eklendi`);
        } catch (err) {
          showToast(err.message);
        }
      });
    }

    // =========================================================================
    // QUICK ACTION BUTTONS (SINGLE TAP = RUN, LONG PRESS = EDIT), PC FILE BROWSER & PROPERTIES
    // =========================================================================
    document.getElementById('newQuickActionBtn').addEventListener('click', () => {
      triggerHaptic(12);
      openQuickActionComposer(null, null);
    });

    const qaListContainer = document.getElementById('quickActionsListContainer');
    let qaHoldTimer = null;
    let qaHoldFired = false;

    qaListContainer.addEventListener(
      'touchstart',
      (e) => {
        const tile = e.target.closest('[data-qa-tile]');
        if (!tile) return;
        qaHoldFired = false;
        clearTimeout(qaHoldTimer);
        const id = tile.getAttribute('data-qa-tile');
        qaHoldTimer = setTimeout(() => {
          qaHoldFired = true;
          triggerHaptic(24);
          const qa = state.quickActions.find((q) => q.id === id);
          if (qa) openQuickActionComposer(qa, null);
        }, 420);
      },
      { passive: true }
    );

    qaListContainer.addEventListener(
      'touchmove',
      () => {
        clearTimeout(qaHoldTimer);
      },
      { passive: true }
    );

    qaListContainer.addEventListener(
      'touchend',
      () => {
        clearTimeout(qaHoldTimer);
      },
      { passive: true }
    );

    qaListContainer.addEventListener('contextmenu', (e) => {
      const tile = e.target.closest('[data-qa-tile]');
      if (!tile) return;
      e.preventDefault();
      clearTimeout(qaHoldTimer);
      qaHoldFired = true;
      triggerHaptic(22);
      const id = tile.getAttribute('data-qa-tile');
      const qa = state.quickActions.find((q) => q.id === id);
      if (qa) openQuickActionComposer(qa, null);
    });

    qaListContainer.addEventListener('click', async (e) => {
      const tile = e.target.closest('[data-qa-tile]');
      if (!tile) return;
      if (qaHoldFired) {
        qaHoldFired = false;
        e.preventDefault();
        return;
      }
      triggerHaptic(14);
      const id = tile.getAttribute('data-qa-tile');
      try {
        const res = await sendCommand('run_quick_action', { id }, 12000);
        if (res && res.quickActions) {
          state.quickActions = res.quickActions;
          renderQuickActionsList();
        }
        logAuditEvent('app', `Hızlı erişim butonu çalıştırıldı: ${res.name || 'Öğe'}`);
        showToast(`${res.name || 'Hızlı erişim'} başlatıldı`);
      } catch (err) {
        showToast(err.message);
      }
    });

    // Quick Action Composer Modal Controls
    document.getElementById('closeQaModalBtn').addEventListener('click', () => {
      closeModal('quickActionComposerModal');
    });
    document.getElementById('cancelQaModalBtn').addEventListener('click', () => {
      closeModal('quickActionComposerModal');
    });

    const delQaModalBtn = document.getElementById('deleteQaModalBtn');
    if (delQaModalBtn) {
      delQaModalBtn.addEventListener('click', async () => {
        if (!state.editingQaId) return;
        triggerHaptic(16);
        try {
          const res = await sendCommand('delete_quick_action', { id: state.editingQaId });
          if (res && res.quickActions) {
            state.quickActions = res.quickActions;
            renderQuickActionsList();
          }
          closeModal('quickActionComposerModal');
          showToast('Hızlı erişim butonu silindi');
        } catch (err) {
          showToast(err.message);
        }
      });
    }

    const inspQaModalBtn = document.getElementById('inspectQaModalBtn');
    if (inspQaModalBtn) {
      inspQaModalBtn.addEventListener('click', () => {
        if (!state.editingQaId) return;
        const qa = state.quickActions.find((q) => q.id === state.editingQaId);
        if (qa) {
          closeModal('quickActionComposerModal');
          openPropertiesInspector({ kind: 'quick_action', qa });
        }
      });
    }

    // Searchable App Picker inside Quick Action Composer
    const qaSearchInput = document.getElementById('qaAppSearchInput');
    if (qaSearchInput) {
      qaSearchInput.addEventListener('input', () => {
        renderCustomAppPickerList('qaAppPickerList', 'qaInstalledAppSelect', qaSearchInput.value);
      });
    }

    const qaPickerList = document.getElementById('qaAppPickerList');
    if (qaPickerList) {
      qaPickerList.addEventListener('click', (e) => {
        const itemBtn = e.target.closest('[data-picker-app-idx]');
        if (!itemBtn) return;
        triggerHaptic(8);
        const idx = itemBtn.getAttribute('data-picker-app-idx');
        const hiddenSel = document.getElementById('qaInstalledAppSelect');
        if (hiddenSel) hiddenSel.value = idx;
        renderCustomAppPickerList(
          'qaAppPickerList',
          'qaInstalledAppSelect',
          qaSearchInput ? qaSearchInput.value : ''
        );
        const app = state.installedApps[Number(idx)];
        const nameInput = document.getElementById('qaNameInput');
        if (app && nameInput && !nameInput.value.trim()) {
          nameInput.value = app.name;
        }
      });
    }

    // Searchable App Picker inside Scene Composer
    const sceneSearchInput = document.getElementById('sceneAppSearchInput');
    if (sceneSearchInput) {
      sceneSearchInput.addEventListener('input', () => {
        renderCustomAppPickerList('sceneAppPickerList', 'appSelectDropdown', sceneSearchInput.value);
      });
    }

    const scenePickerList = document.getElementById('sceneAppPickerList');
    if (scenePickerList) {
      scenePickerList.addEventListener('click', (e) => {
        const itemBtn = e.target.closest('[data-picker-app-idx]');
        if (!itemBtn) return;
        triggerHaptic(8);
        const idx = itemBtn.getAttribute('data-picker-app-idx');
        const hiddenSel = document.getElementById('appSelectDropdown');
        if (hiddenSel) hiddenSel.value = idx;
        renderCustomAppPickerList(
          'sceneAppPickerList',
          'appSelectDropdown',
          sceneSearchInput ? sceneSearchInput.value : ''
        );
      });
    }

    document.querySelectorAll('#qaExecModeRow .segment-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        triggerHaptic(8);
        document.querySelectorAll('#qaExecModeRow .segment-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.qaExecMode = btn.getAttribute('data-qa-exec');
      });
    });

    const qaActionTypeSelect = document.getElementById('qaActionTypeSelect');
    if (qaActionTypeSelect) {
      qaActionTypeSelect.addEventListener('change', () => {
        triggerHaptic(8);
        populateQaDynamicSelects();
        syncQaActionTypeVisibility(qaActionTypeSelect.value);
      });
    }

    document.getElementById('qaBrowsePcBtn').addEventListener('click', () => {
      triggerHaptic(10);
      openPcFileBrowser('pick_for_qa', state.fsCurrentPath || 'quick:desktop');
    });

    const tryAddCurrentFormItemToQaList = (silentWhenEmpty) => {
      let name = '';
      let targetPath = '';
      let targetType = 'file';
      let macroId = '';
      let sceneId = '';
      let actionCode = '';

      let fileArgs = '';
      let fileAdmin = false;
      let itemIcon = '';

      if (state.qaItemSource === 'file') {
        targetPath = document.getElementById('qaSelectedFilePathInput').value.trim();
        const argsInput = document.getElementById('qaFileArgsInput');
        const adminCheck = document.getElementById('qaFileAdminCheck');
        if (argsInput) fileArgs = argsInput.value.trim();
        if (adminCheck) fileAdmin = Boolean(adminCheck.checked);

        if (!targetPath) {
          if (!silentWhenEmpty) showToast("Lütfen çalıştırılacak dosyayı seçin");
          return false;
        }
        name = targetPath.split('\\').filter(Boolean).pop() || targetPath;
        if (state.qaSelectedFileMeta && state.qaSelectedFileMeta.path === targetPath) {
          targetType = state.qaSelectedFileMeta.targetType || (state.qaSelectedFileMeta.isDir ? 'folder' : 'file');
          name = state.qaSelectedFileMeta.name || name;
        } else if (targetPath.toLowerCase().endsWith('.exe')) {
          targetType = 'app';
        }
      } else if (state.qaItemSource === 'app') {
        const sel = document.getElementById('qaInstalledAppSelect');
        const app = state.installedApps[Number(sel.value)];
        if (!app) {
          if (!silentWhenEmpty) showToast('Lütfen kurulu bir uygulama seçin');
          return false;
        }
        name = app.name;
        targetPath = app.launchPath || app.processName;
        targetType = 'app';
        fileArgs = app.launchArgs || '';
        itemIcon = app.icon || '';
      } else if (state.qaItemSource === 'macro') {
        const macSel = document.getElementById('qaMacroSelect');
        const macId = macSel ? macSel.value.trim() : '';
        const mac = (state.macros || []).find((m) => m.id === macId);
        if (!mac) {
          if (!silentWhenEmpty) showToast('Lütfen çalıştırılacak bir makro seçin');
          return false;
        }
        name = mac.name;
        targetType = 'macro';
        targetPath = mac.id;
        macroId = mac.id;
      } else if (state.qaItemSource === 'scene') {
        const scSel = document.getElementById('qaSceneSelect');
        const scId = scSel ? scSel.value.trim() : '';
        const sc = (state.scenes || []).find((s) => s.id === scId);
        if (!sc) {
          if (!silentWhenEmpty) showToast('Lütfen başlatılacak bir çalışma sahnesi seçin');
          return false;
        }
        name = sc.name;
        targetType = 'scene';
        targetPath = sc.id;
        sceneId = sc.id;
      } else if (state.qaItemSource === 'system_action') {
        const sysSel = document.getElementById('qaSystemActionSelect');
        const code = sysSel ? sysSel.value.trim() : '';
        if (!code) {
          if (!silentWhenEmpty) showToast('Lütfen çalıştırılacak bir sistem işlevi seçin');
          return false;
        }
        const opt = sysSel.options[sysSel.selectedIndex];
        name = opt ? opt.textContent.trim() : code;
        targetType = 'system_action';
        targetPath = code;
        actionCode = code;
      } else {
        name = document.getElementById('qaCustomItemNameInput').value.trim();
        targetPath = document.getElementById('qaCustomItemPathInput').value.trim();
        if (!targetPath) {
          if (!silentWhenEmpty) showToast('Lütfen dosya yolu veya URL girin');
          return false;
        }
        if (!name) {
          name = targetPath.startsWith('http')
            ? targetPath.replace(/^https?:\/\//i, '').split('/')[0]
            : targetPath.split('\\').filter(Boolean).pop() || targetPath;
        }
        targetType = targetPath.startsWith('http') ? 'url' : targetPath.toLowerCase().endsWith('.exe') ? 'app' : 'file';
      }

      const newItem = {
        id: String(Date.now() + Math.random()),
        name,
        targetType,
        targetPath,
        macroId: macroId || undefined,
        sceneId: sceneId || undefined,
        actionCode: actionCode || undefined,
        icon: itemIcon,
        openWithMode: 'default',
        openWithPath: '',
        openWithName: 'Varsayılan Uygulama',
        monitorIndex: Number(document.getElementById('qaTargetMonitorSelect').value),
        zone: document.getElementById('qaTargetZoneSelect').value,
        windowStyle: document.getElementById('qaWindowStyleSelect').value,
        ifRunning: document.getElementById('qaIfRunningSelect').value,
        delayMs: Number(document.getElementById('qaDelaySelect').value || 0),
        priority: 'normal',
        arguments: fileArgs || '',
        workingDirectory: '',
        runAsAdmin: fileAdmin || Boolean(document.getElementById('qaRunAsAdminCheck').checked),
        alwaysOnTop: Boolean(document.getElementById('qaAlwaysOnTopCheck').checked)
      };

      state.qaItems.push(newItem);
      if (!document.getElementById('qaNameInput').value.trim()) {
        document.getElementById('qaNameInput').value = name;
      }
      document.getElementById('qaSelectedFilePathInput').value = '';
      if (document.getElementById('qaFileArgsInput')) document.getElementById('qaFileArgsInput').value = '';
      if (document.getElementById('qaFileAdminCheck')) document.getElementById('qaFileAdminCheck').checked = false;
      document.getElementById('qaCustomItemNameInput').value = '';
      document.getElementById('qaCustomItemPathInput').value = '';
      renderQaComposerItemsList();
      return name;
    };

    document.getElementById('qaAddItemToListBtn').addEventListener('click', () => {
      triggerHaptic(12);
      const addedName = tryAddCurrentFormItemToQaList(false);
      if (addedName) {
        showToast(`${addedName} listeye eklendi`);
      }
    });

    document.getElementById('qaEditorItemsList').addEventListener('click', (e) => {
      const remBtn = e.target.closest('[data-qa-remove-subitem]');
      if (remBtn) {
        triggerHaptic(10);
        const idx = Number(remBtn.getAttribute('data-qa-remove-subitem'));
        state.qaItems.splice(idx, 1);
        renderQaComposerItemsList();
        return;
      }

      const editBtn = e.target.closest('[data-qa-edit-subitem]');
      if (editBtn) {
        triggerHaptic(10);
        const idx = Number(editBtn.getAttribute('data-qa-edit-subitem'));
        const item = state.qaItems[idx];
        if (item) {
          openPropertiesInspector({
            kind: 'qa_composer_item',
            item,
            itemIndex: idx
          });
        }
      }
    });

    document.getElementById('saveQaConfirmBtn').addEventListener('click', async () => {
      triggerHaptic(16);
      if (!state.qaItems.length) {
        tryAddCurrentFormItemToQaList(true);
      }

      let name = document.getElementById('qaNameInput').value.trim();
      if (!name && state.qaItems.length > 0) {
        name = state.qaItems[0].name || 'Hızlı Buton';
        document.getElementById('qaNameInput').value = name;
      }

      if (!name) {
        showToast('Lütfen hızlı erişim butonuna bir ad verin');
        return;
      }
      if (!state.qaItems.length) {
        showToast('Lütfen butona en az 1 dosya veya uygulama seçin');
        return;
      }

      const catSel = document.getElementById('qaCategorySelect');
      try {
        const res = await sendCommand('save_quick_action', {
          quickAction: {
            id: state.editingQaId,
            name,
            category: catSel ? catSel.value : 'Genel',
            executionMode: state.qaExecMode,
            items: state.qaItems
          }
        });
        if (res && res.quickActions) {
          state.quickActions = res.quickActions;
          renderQuickActionsList();
        }
        closeModal('quickActionComposerModal');
        showToast('Hızlı erişim butonu kaydedildi');
      } catch (err) {
        showToast(err.message);
      }
    });

    // PC File System Browser Modal Controls
    document.getElementById('closeFsBrowserBtn').addEventListener('click', () => {
      closeModal('pcFileBrowserModal');
    });

    document.getElementById('fsRootsPillRow').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-fs-root-path]');
      if (!btn) return;
      triggerHaptic(8);
      loadPcDirectory(btn.getAttribute('data-fs-root-path'), document.getElementById('fsSearchFilterInput').value.trim());
    });

    document.getElementById('fsParentDirBtn').addEventListener('click', () => {
      triggerHaptic(8);
      if (state.fsParentPath) {
        loadPcDirectory(state.fsParentPath, '');
      }
    });

    document.getElementById('fsGoPathBtn').addEventListener('click', () => {
      triggerHaptic(8);
      const pathVal = document.getElementById('fsCurrentPathInput').value.trim();
      if (pathVal) loadPcDirectory(pathVal, '');
    });

    document.getElementById('fsSearchFilterInput').addEventListener('input', (e) => {
      const q = e.target.value.trim();
      loadPcDirectory(state.fsCurrentPath, q);
    });

    document.getElementById('fsSelectCurrentFolderBtn').addEventListener('click', () => {
      if (!state.fsCurrentPath) return;
      triggerHaptic(12);
      const folderName = state.fsCurrentPath.split('\\').filter(Boolean).pop() || state.fsCurrentPath;
      if (state.fsBrowserMode === 'pick_for_qa') {
        state.qaSelectedFileMeta = {
          name: folderName,
          path: state.fsCurrentPath,
          isDir: true,
          targetType: 'folder'
        };
        document.getElementById('qaSelectedFilePathInput').value = state.fsCurrentPath;
        closeModal('pcFileBrowserModal');
        showToast(`Klasör seçildi: ${folderName}`);
      } else {
        openPropertiesInspector({
          kind: 'fs_entry',
          entry: {
            name: folderName,
            path: state.fsCurrentPath,
            isDir: true,
            targetType: 'folder',
            ext: 'KLASÖR',
            defaultAppName: 'Windows Gezgini'
          }
        });
      }
    });

    document.getElementById('fsEntriesListContainer').addEventListener('click', async (e) => {
      const propBtn = e.target.closest('[data-fs-entry-prop]');
      if (propBtn) {
        const entry = state.fsEntries[Number(propBtn.getAttribute('data-fs-entry-prop'))];
        if (entry) openPropertiesInspector({ kind: 'fs_entry', entry });
        return;
      }

      const dlBtn = e.target.closest('[data-fs-entry-download]');
      if (dlBtn) {
        triggerHaptic(12);
        const entry = state.fsEntries[Number(dlBtn.getAttribute('data-fs-entry-download'))];
        if (entry && !entry.isDir) {
          await downloadFileFromPc(entry);
        }
        return;
      }

      const primBtn = e.target.closest('[data-fs-entry-primary]');
      if (primBtn) {
        triggerHaptic(12);
        const entry = state.fsEntries[Number(primBtn.getAttribute('data-fs-entry-primary'))];
        if (!entry) return;

        if (state.fsBrowserMode === 'pick_for_qa') {
          state.qaSelectedFileMeta = entry;
          document.getElementById('qaSelectedFilePathInput').value = entry.path;
          const nameIn = document.getElementById('qaNameInput');
          if (nameIn && !nameIn.value.trim()) {
            nameIn.value = entry.name;
          }
          closeModal('pcFileBrowserModal');
          showToast(`Dosya seçildi: ${entry.name}`);
          return;
        }

        if (state.fsBrowserMode === 'pick_for_custom_app') {
          if (entry.isDir) {
            loadPcDirectory(entry.path, '');
            return;
          }
          document.getElementById('manualAppPathInput').value = entry.path;
          const nameInput = document.getElementById('manualAppNameInput');
          if (nameInput && !nameInput.value.trim()) {
            nameInput.value = String(entry.name || '').replace(/\.[^/.]+$/, '');
          }
          closeModal('pcFileBrowserModal');
          showToast(`Uygulama seçildi: ${entry.name}`);
          return;
        }

        if (entry.isDir) {
          loadPcDirectory(entry.path, '');
        } else {
          try {
            await sendCommand('run_single_item', {
              targetPath: entry.path,
              openWithMode: 'default'
            });
            showToast(`${entry.name} bilgisayarda açıldı`);
          } catch (err) {
            showToast(err.message);
          }
        }
        return;
      }

      const tapInfo = e.target.closest('[data-fs-entry-tap]');
      if (tapInfo) {
        triggerHaptic(8);
        const entry = state.fsEntries[Number(tapInfo.getAttribute('data-fs-entry-tap'))];
        if (!entry) return;
        if (entry.isDir) {
          loadPcDirectory(entry.path, '');
        } else {
          openPropertiesInspector({ kind: 'fs_entry', entry });
        }
      }
    });

    // Universal Properties ("Özellikler") Modal Controls & Delegation
    document.getElementById('closePropModalBtn').addEventListener('click', () => {
      closeModal('universalPropertiesModal');
    });

    document.getElementById('propModalBodyContent').addEventListener('click', async (e) => {
      const ctx = state.activePropContext;
      if (!ctx) return;

      // 1. Sub-item inspect inside a multi-item Quick Action
      const inspectSubBtn = e.target.closest('[data-prop-inspect-subitem]');
      if (inspectSubBtn && ctx.qa) {
        const idx = Number(inspectSubBtn.getAttribute('data-prop-inspect-subitem'));
        const item = ctx.qa.items[idx];
        if (item) {
          openPropertiesInspector({ kind: 'qa_item', qa: ctx.qa, item, itemIndex: idx });
        }
        return;
      }

      // 2. Sub-item single launch inside a Quick Action
      const runSubBtn = e.target.closest('[data-prop-run-subitem]');
      if (runSubBtn && ctx.qa) {
        triggerHaptic(14);
        const idx = Number(runSubBtn.getAttribute('data-prop-run-subitem'));
        const item = ctx.qa.items[idx];
        if (item) {
          try {
            await sendCommand('run_single_item', item);
            showToast(`${item.name} başlatıldı`);
          } catch (err) {
            showToast(err.message);
          }
        }
        return;
      }

      // 3. Scene single item launch
      const runSceneItemBtn = e.target.closest('[data-prop-run-scene-item]');
      if (runSceneItemBtn && ctx.scene) {
        triggerHaptic(14);
        const idx = Number(runSceneItemBtn.getAttribute('data-prop-run-scene-item'));
        const it = ctx.scene.items[idx];
        if (it) {
          try {
            await sendCommand('launch_app', {
              name: it.appName,
              processName: it.processName,
              launchPath: it.launchPath,
              launchArgs: it.launchArgs || '',
              monitorIndex: it.monitorIndex,
              zonePreset: it.zonePreset
            });
            showToast(`${it.appName || it.processName} başlatıldı`);
          } catch (err) {
            showToast(err.message);
          }
        }
        return;
      }

      // 4. Open Window Opacity buttons
      const opBtn = e.target.closest('[data-prop-win-opacity]');
      if (opBtn && ctx.window) {
        triggerHaptic(10);
        const opacity = Number(opBtn.getAttribute('data-prop-win-opacity'));
        try {
          await sendCommand('window_action', {
            hwnd: ctx.window.hwnd,
            action: 'set_opacity',
            opacity
          });
          showToast(`Pencere saydamlığı %${opacity} yapıldı`);
        } catch (err) {
          showToast(err.message);
        }
        return;
      }

      // 5. Open Window Action buttons
      const winCmdBtn = e.target.closest('[data-prop-win-cmd]');
      if (winCmdBtn && ctx.window) {
        triggerHaptic(14);
        const cmd = winCmdBtn.getAttribute('data-prop-win-cmd');
        try {
          const res = await sendCommand('window_action', {
            hwnd: ctx.window.hwnd,
            action: cmd
          });
          if (cmd === 'kill_process') {
            closeModal('universalPropertiesModal');
            showToast('İşlem sonlandırıldı');
          } else if (cmd === 'open_file_location') {
            showToast('Dosya konumu PC ekranında açıldı');
          } else if (cmd === 'toggle_topmost') {
            showToast(res.isTopMost ? 'Pencere en üste sabitlendi' : 'Üstte tutma kaldırıldı');
            openPropertiesInspector(ctx);
          } else {
            showToast('Pencere komutu uygulandı');
          }
        } catch (err) {
          showToast(err.message);
        }
        return;
      }

      // 6. Main Prop Action Buttons
      const actBtn = e.target.closest('[data-prop-action]');
      if (!actBtn) return;
      const act = actBtn.getAttribute('data-prop-action');
      triggerHaptic(15);

      if (act === 'run_qa' && ctx.qa) {
        try {
          await sendCommand('run_quick_action', { id: ctx.qa.id }, 12000);
          closeModal('universalPropertiesModal');
          showToast(`${ctx.qa.name} başlatıldı`);
        } catch (err) {
          showToast(err.message);
        }
      } else if (act === 'edit_qa' && ctx.qa) {
        closeModal('universalPropertiesModal');
        openQuickActionComposer(ctx.qa, null);
      } else if (act === 'dup_qa' && ctx.qa) {
        try {
          const res = await sendCommand('duplicate_quick_action', { id: ctx.qa.id });
          if (res && res.quickActions) {
            state.quickActions = res.quickActions;
            renderQuickActionsList();
          }
          closeModal('universalPropertiesModal');
          showToast('Buton çoğaltıldı');
        } catch (err) {
          showToast(err.message);
        }
      } else if (act === 'del_qa' && ctx.qa) {
        try {
          const res = await sendCommand('delete_quick_action', { id: ctx.qa.id });
          if (res && res.quickActions) {
            state.quickActions = res.quickActions;
            renderQuickActionsList();
          }
          closeModal('universalPropertiesModal');
          showToast('Hızlı erişim butonu silindi');
        } catch (err) {
          showToast(err.message);
        }
      } else if (act === 'run_scene' && ctx.scene) {
        try {
          await sendCommand('run_scene', { sceneId: ctx.scene.id }, 12000);
          closeModal('universalPropertiesModal');
          showToast(`${ctx.scene.name} uygulandı`);
        } catch (err) {
          showToast(err.message);
        }
      } else if (act === 'edit_scene' && ctx.scene) {
        closeModal('universalPropertiesModal');
        openSceneComposer(ctx.scene);
      } else if (act === 'edit_custom_app' && ctx.app) {
        closeModal('universalPropertiesModal');
        openManualAppModal(ctx.app);
      } else if (act === 'del_custom_app' && ctx.app && ctx.app.id) {
        try {
          const res = await sendCommand('delete_custom_app', { id: ctx.app.id });
          if (res && Array.isArray(res.installed)) state.installedApps = res.installed;
          if (res && Array.isArray(res.customApps)) state.customApps = res.customApps;
          renderAppsTab();
          renderScenesList();
          renderQuickActionsList();
          closeModal('universalPropertiesModal');
          showToast(`"${ctx.app.name}" katalogdan kaldırıldı`);
        } catch (err) {
          showToast(err.message);
        }
      }
    });

    // Snapshot & Scene Creation Buttons
    const handleSnapshot = async () => {
      triggerHaptic(15);
      try {
        const res = await sendCommand('snapshot_scene', {});
        if (res && res.scenes) {
          state.scenes = res.scenes;
          renderScenesList();
          showToast(`${res.scene ? res.scene.name : 'Sahne'} olarak kaydedildi`);
        }
      } catch (err) {
        showToast(err.message);
      }
    };

    document.getElementById('snapshotSceneBtn').addEventListener('click', handleSnapshot);

    document.getElementById('newSceneBtn').addEventListener('click', () => {
      triggerHaptic(12);
      openSceneComposer(null);
    });

    // Scenes List Delegation
    document.getElementById('scenesListContainer').addEventListener('click', async (e) => {
      const runBtn = e.target.closest('[data-run-scene]');
      if (runBtn) {
        triggerHaptic(18);
        const sceneId = runBtn.getAttribute('data-run-scene');
        const origHtml = runBtn.innerHTML;
        runBtn.innerHTML = `<span>Sahne Kuruluyor...</span>`;
        try {
          const res = await sendCommand('run_scene', { sceneId }, 12000);
          logAuditEvent('scene', `"${res.name}" sahnesi uygulandı`);
          showToast(`${res.name} (${res.elapsedMs}ms içinde uygulandı)`);
        } catch (err) {
          showToast(err.message);
        } finally {
          runBtn.innerHTML = origHtml;
        }
        return;
      }

      const propSceneBtn = e.target.closest('[data-prop-scene]');
      if (propSceneBtn) {
        triggerHaptic(10);
        const sceneId = propSceneBtn.getAttribute('data-prop-scene');
        const found = state.scenes.find((s) => s.id === sceneId);
        if (found) openPropertiesInspector({ kind: 'scene', scene: found });
        return;
      }

      const editBtn = e.target.closest('[data-edit-scene]');
      if (editBtn) {
        triggerHaptic(10);
        const sceneId = editBtn.getAttribute('data-edit-scene');
        const found = state.scenes.find((s) => s.id === sceneId);
        if (found) openSceneComposer(found);
        return;
      }

      const delBtn = e.target.closest('[data-delete-scene]');
      if (delBtn) {
        triggerHaptic(15);
        const sceneId = delBtn.getAttribute('data-delete-scene');
        try {
          const res = await sendCommand('delete_scene', { sceneId });
          state.scenes = res.scenes || [];
          renderScenesList();
          showToast('Sahne silindi');
        } catch (err) {
          showToast(err.message);
        }
      }
    });

    // Scene Composer Modal Controls
    document.getElementById('closeSceneModalBtn').addEventListener('click', () => {
      closeModal('sceneComposerModal');
    });
    document.getElementById('cancelSceneModalBtn').addEventListener('click', () => {
      closeModal('sceneComposerModal');
    });

    document.querySelectorAll('[data-app-source]').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('[data-app-source]').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        state.composerAppSource = tab.getAttribute('data-app-source');
        const instGroup = document.getElementById('installedAppPickerGroup');
        if (instGroup) instGroup.classList.toggle('hidden', state.composerAppSource !== 'installed');
        const custGroup = document.getElementById('customAppPickerGroup');
        if (custGroup) custGroup.classList.toggle('hidden', state.composerAppSource !== 'custom');
      });
    });

    document.getElementById('ruleMonitorPills').addEventListener('click', (e) => {
      const pill = e.target.closest('[data-composer-mon]');
      if (!pill) return;
      triggerHaptic(8);
      state.composerTargetMonitor = Number(pill.getAttribute('data-composer-mon'));
      renderComposerMonitorPills();
    });

    document.getElementById('ruleZoneGrid').addEventListener('click', (e) => {
      const zBtn = e.target.closest('[data-zone]');
      if (!zBtn) return;
      triggerHaptic(8);
      document.querySelectorAll('#ruleZoneGrid .zone-btn').forEach((b) => b.classList.remove('active'));
      zBtn.classList.add('active');
      state.composerTargetZone = zBtn.getAttribute('data-zone');
    });

    const ruleVisRow = document.getElementById('ruleVisibilityPills');
    if (ruleVisRow) {
      ruleVisRow.addEventListener('click', (e) => {
        const vBtn = e.target.closest('[data-scene-vis]');
        if (!vBtn) return;
        triggerHaptic(8);
        ruleVisRow.querySelectorAll('.segment-btn').forEach((b) => b.classList.remove('active'));
        vBtn.classList.add('active');
        state.composerTargetVisibility = vBtn.getAttribute('data-scene-vis') || 'foreground';
      });
    }

    document.getElementById('addRuleToSceneBtn').addEventListener('click', () => {
      triggerHaptic(12);
      let appName = '';
      let processName = '';
      let launchPath = '';
      let launchArgs = '';
      let icon = '';

      if (state.composerAppSource === 'installed') {
        const sel = document.getElementById('appSelectDropdown');
        const app = state.installedApps[Number(sel.value)];
        if (!app) {
          showToast('Lütfen listeden bir uygulama seçin');
          return;
        }
        appName = app.name;
        processName = app.processName;
        launchPath = app.launchPath || '';
        launchArgs = app.launchArgs || '';
        icon = app.icon || '';
      } else {
        const custNameEl = document.getElementById('customAppNameInput');
        const custPathEl = document.getElementById('customAppPathInput');
        appName = custNameEl ? custNameEl.value.trim() : '';
        launchPath = custPathEl ? custPathEl.value.trim() : '';
        processName = appName;
        if (!appName) {
          showToast('Uygulama adını girin');
          return;
        }
      }

      const geom = ZONE_COORDS[state.composerTargetZone] || ZONE_COORDS.fullscreen;
      const vis = state.composerTargetVisibility || 'foreground';
      const isMin = vis === 'minimized';
      const isBehind = vis === 'background';
      state.composerItems.push({
        id: String(Date.now() + Math.random()),
        appName,
        processName,
        launchPath,
        launchArgs,
        icon,
        monitorIndex: state.composerTargetMonitor,
        zonePreset: state.composerTargetZone,
        state: isMin ? 'minimized' : geom.state,
        windowStyle: isMin ? 'minimized' : geom.state,
        isBackground: isMin || isBehind,
        backgroundReason: isMin ? 'Simge Durumunda' : isBehind ? 'Arkaplanda' : '',
        zOrder: state.composerItems.length,
        rect: { x: geom.x, y: geom.y, w: geom.w, h: geom.h }
      });

      renderComposerBlueprintAndList();
    });

    document.getElementById('sceneEditorItemsList').addEventListener('click', (e) => {
      const visBtn = e.target.closest('[data-cycle-composer-vis]');
      if (visBtn) {
        triggerHaptic(8);
        const idx = Number(visBtn.getAttribute('data-cycle-composer-vis'));
        const item = state.composerItems[idx];
        if (item) {
          const isMin = Boolean(item.state === 'minimized' || item.windowStyle === 'minimized');
          const isBehind = Boolean(!isMin && item.isBackground);
          const geom = ZONE_COORDS[item.zonePreset] || ZONE_COORDS.fullscreen;
          if (!isMin && !isBehind) {
            // Ön Planda -> Arkada Açık
            item.state = geom.state;
            item.windowStyle = geom.state;
            item.isBackground = true;
            item.backgroundReason = 'Arkaplanda';
          } else if (isBehind) {
            // Arkada Açık -> Simge Durumu
            item.state = 'minimized';
            item.windowStyle = 'minimized';
            item.isBackground = true;
            item.backgroundReason = 'Simge Durumunda';
          } else {
            // Simge Durumu -> Ön Planda
            item.state = geom.state;
            item.windowStyle = geom.state;
            item.isBackground = false;
            item.backgroundReason = '';
          }
          renderComposerBlueprintAndList();
        }
        return;
      }

      const rem = e.target.closest('[data-remove-composer-item]');
      if (!rem) return;
      triggerHaptic(10);
      const idx = Number(rem.getAttribute('data-remove-composer-item'));
      state.composerItems.splice(idx, 1);
      renderComposerBlueprintAndList();
    });

    document.getElementById('saveSceneConfirmBtn').addEventListener('click', async () => {
      triggerHaptic(16);
      const name = document.getElementById('sceneNameInput').value.trim();
      if (!name) {
        showToast('Lütfen sahneye bir isim verin');
        return;
      }
      if (!state.composerItems.length) {
        showToast('Sahneye en az 1 uygulama ekleyin');
        return;
      }

      const otherWindowsMode = document.getElementById('sceneOtherWindowsSelect')
        ? document.getElementById('sceneOtherWindowsSelect').value
        : 'keep';

      try {
        const res = await sendCommand('save_scene', {
          scene: {
            id: state.editingSceneId,
            name,
            otherWindowsMode,
            items: state.composerItems
          }
        });
        state.scenes = res.scenes || [];
        renderScenesList();
        closeModal('sceneComposerModal');
        showToast('Sahne kaydedildi');
      } catch (err) {
        showToast(err.message);
      }
    });

    // TAB 2: MONITORS & TOPOLOGY & LIVE WINDOWS
    document.getElementById('allMonitorsOffBtn').addEventListener('click', async () => {
      triggerHaptic(15);
      try {
        await sendCommand('monitor_power', { action: 'off' });
        showToast('Tüm monitörler kapatıldı');
      } catch (e) {
        showToast(e.message);
      }
    });

    document.getElementById('allMonitorsOnBtn').addEventListener('click', async () => {
      triggerHaptic(15);
      try {
        const res = await sendCommand('monitor_power', { action: 'on', clearBlackouts: true });
        if (res.monitors) state.monitors = res.monitors;
        renderMonitorsTab();
        showToast('Monitörler açıldı');
      } catch (e) {
        showToast(e.message);
      }
    });

    document.getElementById('monitorsContainer').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-toggle-blackout]');
      if (!btn) return;
      triggerHaptic(14);
      const monitorIndex = Number(btn.getAttribute('data-toggle-blackout'));
      try {
        const res = await sendCommand('monitor_blackout', { monitorIndex, mode: 'toggle' });
        if (res && res.monitors) {
          state.monitors = res.monitors;
          renderMonitorsTab();
        }
      } catch (err) {
        showToast(err.message);
      }
    });

    document.querySelectorAll('[data-topology]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        triggerHaptic(14);
        const mode = btn.getAttribute('data-topology');
        try {
          await sendCommand('display_topology', { mode });
          showToast('Ekran yansıtma modu uygulandı');
        } catch (err) {
          showToast(err.message);
        }
      });
    });

    document.getElementById('refreshWindowsBtn').addEventListener('click', async () => {
      triggerHaptic(10);
      try {
        const res = await sendCommand('get_full_state');
        state.windows = res.windows || [];
        renderOpenWindowsList();
      } catch {}
    });

    document.getElementById('openWindowsContainer').addEventListener('click', async (e) => {
      // Window Properties ("Özellikler") button
      const propWinBtn = e.target.closest('[data-prop-win]');
      if (propWinBtn) {
        e.stopPropagation();
        const hwnd = Number(propWinBtn.getAttribute('data-prop-win'));
        const win = state.windows.find((w) => Number(w.hwnd) === hwnd);
        if (win) openPropertiesInspector({ kind: 'window', window: win });
        return;
      }

      // Quick 1-tap Move to Other Monitor button
      const moveBtn = e.target.closest('[data-win-move-mon]');
      if (moveBtn) {
        e.stopPropagation();
        triggerHaptic(14);
        const hwnd = Number(moveBtn.getAttribute('data-win-hwnd'));
        const targetMon = Number(moveBtn.getAttribute('data-win-move-mon'));
        try {
          await sendCommand('window_action', { hwnd, action: 'move_to_monitor', monitorIndex: targetMon });
          showToast(`Pencere Ekran ${targetMon + 1} üzerine taşındı`);
        } catch (err) {
          showToast(err.message);
        }
        return;
      }

      // Quick 1-tap Close Window button
      const closeBtn = e.target.closest('[data-win-close-hwnd]');
      if (closeBtn) {
        e.stopPropagation();
        triggerHaptic(15);
        const hwnd = Number(closeBtn.getAttribute('data-win-close-hwnd'));
        try {
          await sendCommand('close_window', { hwnd });
          showToast('Pencere kapatıldı');
        } catch (err) {
          showToast(err.message);
        }
        return;
      }

      const card = e.target.closest('[data-snap-hwnd]');
      if (!card) return;
      triggerHaptic(10);
      const hwnd = Number(card.getAttribute('data-snap-hwnd'));
      const win = state.windows.find((w) => Number(w.hwnd) === hwnd);
      if (!win) return;

      state.snapTargetWindow = win;
      state.snapTargetMonitor = Number(win.monitorIndex || 0);
      document.getElementById('snapModalWindowTitle').textContent = win.processName;
      document.getElementById('snapModalWindowProc').textContent = win.title;

      const pillsEl = document.getElementById('snapModalMonitorPills');
      const monCount = Math.max(1, state.monitors.length || 1);
      const pillsHtml = [];
      for (let i = 0; i < monCount; i++) {
        pillsHtml.push(`
          <button
            type="button"
            class="mon-pill-btn ${state.snapTargetMonitor === i ? 'active' : ''}"
            data-snap-mon="${i}"
          >
            Ekran ${i + 1}
          </button>
        `);
      }
      pillsEl.innerHTML = pillsHtml.join('');
      openModal('windowSnapModal');
    });

    document.getElementById('closeSnapModalBtn').addEventListener('click', () => {
      closeModal('windowSnapModal');
    });

    document.getElementById('snapModalMonitorPills').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-snap-mon]');
      if (!btn) return;
      triggerHaptic(8);
      state.snapTargetMonitor = Number(btn.getAttribute('data-snap-mon'));
      document.querySelectorAll('#snapModalMonitorPills .mon-pill-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
    });

    document.getElementById('snapModalZoneGrid').addEventListener('click', async (e) => {
      const zBtn = e.target.closest('[data-snap-zone]');
      if (!zBtn || !state.snapTargetWindow) return;
      triggerHaptic(14);
      const zonePreset = zBtn.getAttribute('data-snap-zone');
      try {
        const res = await sendCommand('snap_window', {
          hwnd: state.snapTargetWindow.hwnd,
          processName: state.snapTargetWindow.processName,
          monitorIndex: state.snapTargetMonitor,
          zonePreset
        });
        if (res.windows) state.windows = res.windows;
        renderOpenWindowsList();
        closeModal('windowSnapModal');
        showToast(`${state.snapTargetWindow.processName} -> Ekran ${state.snapTargetMonitor + 1}`);
      } catch (err) {
        showToast(err.message);
      }
    });

    document.getElementById('snapInspectWinBtn').addEventListener('click', () => {
      if (!state.snapTargetWindow) return;
      triggerHaptic(12);
      closeModal('windowSnapModal');
      openPropertiesInspector({ kind: 'window', window: state.snapTargetWindow });
    });

    document.getElementById('snapMinimizeWinBtn').addEventListener('click', async () => {
      if (!state.snapTargetWindow) return;
      triggerHaptic(12);
      try {
        await sendCommand('snap_window', {
          hwnd: state.snapTargetWindow.hwnd,
          state: 'minimized'
        });
        closeModal('windowSnapModal');
      } catch {}
    });

    document.getElementById('snapCloseWinBtn').addEventListener('click', async () => {
      if (!state.snapTargetWindow) return;
      triggerHaptic(16);
      try {
        await sendCommand('close_window', { hwnd: state.snapTargetWindow.hwnd });
        closeModal('windowSnapModal');
        showToast('Pencere kapatıldı');
      } catch {}
    });

    // TAB 3: REMOTE CONTROL WORKSTATION BUTTONS
    document.getElementById('remoteMonitorSelector').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-remote-mon]');
      if (!btn) return;
      triggerHaptic(10);
      state.remoteMonitorIndex = Number(btn.getAttribute('data-remote-mon'));
      renderRemoteMonitorPills();
      if (state.isStreaming) {
        startRemoteStream();
      }
    });

    document.getElementById('modeTrackpadBtn').addEventListener('click', () => {
      triggerHaptic(8);
      setRemoteInputMode('trackpad');
    });

    document.getElementById('modeDirectTouchBtn').addEventListener('click', () => {
      triggerHaptic(8);
      setRemoteInputMode('direct');
    });

    document.getElementById('remoteFullscreenBtn').addEventListener('click', () => {
      triggerHaptic(12);
      setRemoteFullscreen(!state.isFullscreen);
    });

    document.getElementById('hudExitFullscreenBtn').addEventListener('click', () => {
      triggerHaptic(12);
      setRemoteFullscreen(false);
    });

    document.getElementById('hudModeToggleBtn').addEventListener('click', () => {
      triggerHaptic(10);
      setRemoteInputMode(state.remoteInputMode === 'trackpad' ? 'direct' : 'trackpad');
    });

    document.getElementById('hudMonitorCycleBtn').addEventListener('click', () => {
      triggerHaptic(10);
      const count = Math.max(1, state.monitors.length || 1);
      if (count > 1) {
        if (state.remoteMonitorIndex === count - 1) state.remoteMonitorIndex = -1;
        else if (state.remoteMonitorIndex === -1) state.remoteMonitorIndex = 0;
        else state.remoteMonitorIndex = state.remoteMonitorIndex + 1;
        renderRemoteMonitorPills();
        if (state.isStreaming) startRemoteStream();
      }
    });

    const openLiveKeyboard = () => {
      triggerHaptic(10);
      const trap = document.getElementById('liveKeyboardTrap');
      if (trap) {
        trap.focus();
        showToast('Canlı klavye aktif — yazdıklarınız anında PC ekranına iletilir');
      }
    };
    document.getElementById('remoteLiveKbdBtn').addEventListener('click', openLiveKeyboard);
    document.getElementById('hudKeyboardBtn').addEventListener('click', openLiveKeyboard);

    const startStreamBtnEl = document.getElementById('startStreamBtn');
    if (startStreamBtnEl) {
      startStreamBtnEl.addEventListener('click', () => {
        triggerHaptic(12);
        startRemoteStream();
      });
    }

    // Keyboard Category Tabs
    document.querySelectorAll('[data-kbd-cat]').forEach((btn) => {
      btn.addEventListener('click', () => {
        triggerHaptic(8);
        const cat = btn.getAttribute('data-kbd-cat');
        document.querySelectorAll('[data-kbd-cat]').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('kbdGridBasic').classList.toggle('hidden', cat !== 'basic');
        document.getElementById('kbdGridEdit').classList.toggle('hidden', cat !== 'edit');
        document.getElementById('kbdGridNav').classList.toggle('hidden', cat !== 'nav');
      });
    });

    document.getElementById('remoteTextForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('remoteTextInput');
      const text = input.value;
      if (!text) return;
      triggerHaptic(10);
      try {
        await sendCommand('send_input', { type: 'text', text });
        input.value = '';
      } catch (err) {
        showToast(err.message);
      }
    });

    document.querySelectorAll('[data-key]').forEach((btn) => {
      btn.addEventListener('click', () => {
        triggerHaptic(10);
        const key = btn.getAttribute('data-key');
        if (key && key.startsWith('MEDIA_')) {
          triggerMediaKeyCommand(key);
        } else {
          sendCommand('send_input', { type: 'key', key }).catch(() => {});
        }
      });
    });

    // TAB 4: AUDIO MIXER, POWER TIMER, CLIPBOARD & POWER
    const refreshAudioBtnEl = document.getElementById('refreshAudioBtn');
    if (refreshAudioBtnEl) {
      refreshAudioBtnEl.addEventListener('click', async () => {
        triggerHaptic(10);
        try {
          const audio = await sendCommand('audio_control', { action: 'get' });
          state.audio = reconcileMediaIntent(audio);
          renderAudioTab();
        } catch {}
      });
    }

    const masterSlider = document.getElementById('masterVolumeSlider');
    masterSlider.addEventListener('input', () => {
      document.getElementById('masterVolumeValue').textContent = `${masterSlider.value}%`;
    });
    masterSlider.addEventListener('change', async () => {
      try {
        const audio = await sendCommand('audio_control', {
          action: 'set_master',
          volume: Number(masterSlider.value)
        });
        state.audio = reconcileMediaIntent(audio);
        renderAudioTab();
      } catch {}
    });

    document.getElementById('masterMuteBtn').addEventListener('click', async () => {
      triggerHaptic(10);
      try {
        const audio = await sendCommand('audio_control', {
          action: 'set_master',
          muted: !state.audio.masterMuted
        });
        state.audio = reconcileMediaIntent(audio);
        renderAudioTab();
      } catch {}
    });

    const micMuteBtn = document.getElementById('micMuteBtn');
    if (micMuteBtn) {
      micMuteBtn.addEventListener('click', async () => {
        triggerHaptic(10);
        try {
          const nextMuted = !(state.audio && state.audio.micMuted);
          const audio = await sendCommand('audio_control', {
            action: 'set_mic_mute',
            muted: nextMuted
          });
          state.audio = reconcileMediaIntent(audio);
          renderAudioTab();
          showToast(nextMuted ? 'PC mikrofonu susturuldu' : 'PC mikrofonu açıldı');
        } catch (err) {
          showToast(err.message || 'Mikrofon durumu değiştirilemedi');
        }
      });
    }

    const audioOutputDeviceSelect = document.getElementById('audioOutputDeviceSelect');
    if (audioOutputDeviceSelect) {
      audioOutputDeviceSelect.addEventListener('change', async () => {
        triggerHaptic(10);
        const deviceId = audioOutputDeviceSelect.value;
        if (!deviceId) return;
        try {
          const audio = await sendCommand('audio_control', {
            action: 'set_default_device',
            deviceId
          });
          state.audio = reconcileMediaIntent(audio);
          renderAudioTab();
          const selectedOpt = audioOutputDeviceSelect.options[audioOutputDeviceSelect.selectedIndex];
          showToast(`Ses çıkışı değiştirildi: ${selectedOpt ? selectedOpt.textContent : 'Varsayılan'}`);
        } catch (err) {
          showToast(err.message || 'Ses çıkış cihazı değiştirilemedi');
        }
      });
    }

    // WIRELESS CONTROLS (Wi-Fi, Hotspot, Bluetooth)
    const refreshWirelessBtn = document.getElementById('refreshWirelessBtn');
    if (refreshWirelessBtn) {
      refreshWirelessBtn.addEventListener('click', async () => {
        triggerHaptic(10);
        await refreshWirelessStatus(false);
        showToast('Kablosuz bağlantı durumu güncellendi');
      });
    }

    const wifiToggleSwitch = document.getElementById('wifiToggleSwitch');
    if (wifiToggleSwitch) {
      wifiToggleSwitch.addEventListener('change', async () => {
        triggerHaptic(12);
        const enable = wifiToggleSwitch.checked;
        if (!enable && state.connectedRoute === 'YEREL AĞ') {
          const ok = window.confirm('PC Wi-Fi bağlantısını kapatmak yerel ağ üzerinden olan bağlantınızı koparabilir. Devam edilsin mi?');
          if (!ok) {
            wifiToggleSwitch.checked = true;
            return;
          }
        }
        try {
          const res = await sendCommand('wireless_control', { action: 'wifi_toggle', enabled: enable }, 10000);
          if (res) {
            state.wirelessStatus = res;
            renderWirelessStatus(res);
          }
          showToast(enable ? 'PC Wi-Fi açıldı' : 'PC Wi-Fi kapatıldı');
        } catch (err) {
          wifiToggleSwitch.checked = !enable;
          showToast(err.message || 'Wi-Fi durumu değiştirilemedi');
        }
      });
    }

    const hotspotToggleSwitch = document.getElementById('hotspotToggleSwitch');
    if (hotspotToggleSwitch) {
      hotspotToggleSwitch.addEventListener('change', async () => {
        triggerHaptic(12);
        const enable = hotspotToggleSwitch.checked;
        const hsSub = document.getElementById('hotspotCurrentStatusText');
        if (hsSub) hsSub.textContent = enable ? 'Açılıyor...' : 'Kapatılıyor...';
        try {
          const res = await sendCommand('wireless_control', { action: 'hotspot_toggle', enabled: enable }, 14000);
          if (res) {
            state.wirelessStatus = res;
            renderWirelessStatus(res);
          }
          showToast(enable ? 'PC Mobil Erişim Noktası açıldı' : 'PC Mobil Erişim Noktası kapatıldı');
        } catch (err) {
          hotspotToggleSwitch.checked = !enable;
          showToast(err.message || 'Mobil Erişim Noktası değiştirilemedi');
        }
      });
    }

    const btToggleSwitch = document.getElementById('btToggleSwitch');
    if (btToggleSwitch) {
      btToggleSwitch.addEventListener('change', async () => {
        triggerHaptic(12);
        const enable = btToggleSwitch.checked;
        try {
          const res = await sendCommand('wireless_control', { action: 'bt_toggle', enabled: enable }, 10000);
          if (res) {
            state.wirelessStatus = res;
            renderWirelessStatus(res);
          }
          showToast(enable ? 'PC Bluetooth açıldı' : 'PC Bluetooth kapatıldı');
        } catch (err) {
          btToggleSwitch.checked = !enable;
          showToast(err.message || 'Bluetooth durumu değiştirilemedi');
        }
      });
    }

    const openWifiScannerBtn = document.getElementById('openWifiScannerBtn');
    if (openWifiScannerBtn) {
      openWifiScannerBtn.addEventListener('click', openWifiScannerModal);
    }

    const rescanWifiModalBtn = document.getElementById('rescanWifiModalBtn');
    if (rescanWifiModalBtn) {
      rescanWifiModalBtn.addEventListener('click', () => {
        triggerHaptic(10);
        scanPcWifiNetworks();
      });
    }

    const closeWifiScannerModalBtn = document.getElementById('closeWifiScannerModalBtn');
    if (closeWifiScannerModalBtn) {
      closeWifiScannerModalBtn.addEventListener('click', () => closeModal('wifiScannerModal'));
    }

    const wifiNetworksListContainer = document.getElementById('wifiNetworksListContainer');
    if (wifiNetworksListContainer) {
      wifiNetworksListContainer.addEventListener('click', async (e) => {
        const discBtn = e.target.closest('[data-wifi-disconnect]');
        if (discBtn) {
          triggerHaptic(12);
          try {
            const res = await sendCommand('wireless_control', { action: 'wifi_disconnect' }, 10000);
            if (res) {
              state.wirelessStatus = res;
              renderWirelessStatus(res);
            }
            showToast('Wi-Fi bağlantısı kesildi');
            await scanPcWifiNetworks();
          } catch (err) {
            showToast(err.message);
          }
          return;
        }

        const selBtn = e.target.closest('[data-wifi-select]');
        if (selBtn) {
          triggerHaptic(10);
          const idx = Number(selBtn.getAttribute('data-wifi-select'));
          const net = (state.scannedWifiNetworks || [])[idx];
          if (!net) return;
          state.selectedWifiSsid = net.ssid;
          const pwBox = document.getElementById('wifiPasswordPromptBox');
          const lbl = document.getElementById('wifiSelectedSsidLabel');
          const pwInput = document.getElementById('wifiPasswordInput');
          if (lbl) lbl.textContent = `"${net.ssid}" Ağına Bağlan (Kayıtlıysa şifreyi boş bırakın)`;
          if (pwInput) pwInput.value = '';
          if (pwBox) {
            pwBox.classList.remove('hidden');
            if (pwInput) pwInput.focus();
          }
        }
      });
    }

    const wifiConfirmConnectBtn = document.getElementById('wifiConfirmConnectBtn');
    if (wifiConfirmConnectBtn) {
      wifiConfirmConnectBtn.addEventListener('click', async () => {
        triggerHaptic(14);
        const ssid = state.selectedWifiSsid;
        if (!ssid) return;
        const pwInput = document.getElementById('wifiPasswordInput');
        const password = pwInput ? pwInput.value : '';
        wifiConfirmConnectBtn.disabled = true;
        wifiConfirmConnectBtn.textContent = 'Bağlanıyor...';
        try {
          const res = await sendCommand('wireless_control', { action: 'wifi_connect', ssid, password }, 16000);
          if (res) {
            state.wirelessStatus = res;
            renderWirelessStatus(res);
          }
          const pwBox = document.getElementById('wifiPasswordPromptBox');
          if (pwBox) pwBox.classList.add('hidden');
          showToast(`${ssid} ağına bağlantı komutu gönderildi`);
          await scanPcWifiNetworks();
        } catch (err) {
          showToast(err.message || 'Wi-Fi bağlantısı kurulamadı');
        } finally {
          wifiConfirmConnectBtn.disabled = false;
          wifiConfirmConnectBtn.textContent = 'Bağlan';
        }
      });
    }

    // BIDIRECTIONAL FILE BRIDGE
    const triggerUploadFileBtn = document.getElementById('triggerUploadFileBtn');
    const phoneToPcFileInput = document.getElementById('phoneToPcFileInput');
    if (triggerUploadFileBtn && phoneToPcFileInput) {
      triggerUploadFileBtn.addEventListener('click', () => {
        triggerHaptic(10);
        phoneToPcFileInput.value = '';
        phoneToPcFileInput.click();
      });

      phoneToPcFileInput.addEventListener('change', async () => {
        const files = Array.from(phoneToPcFileInput.files || []);
        if (!files.length) return;
        const openCheck = document.getElementById('uploadOpenOnPcCheck');
        const openAfterUpload = Boolean(openCheck && openCheck.checked);

        for (const file of files) {
          if (file.size > 35 * 1024 * 1024) {
            showToast(`${file.name} çok büyük (Maksimum 35 MB)`);
            continue;
          }
          showToast(`PC'ye gönderiliyor: ${file.name}...`);
          try {
            const base64Data = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result || ''));
              reader.onerror = () => reject(new Error('Dosya okunamadı'));
              reader.readAsDataURL(file);
            });
            const res = await sendCommand(
              'upload_file',
              {
                fileName: file.name,
                base64Data,
                openAfterUpload
              },
              30000
            );
            logAuditEvent('file', `Telefondan PC'ye dosya gönderildi: ${res.fileName || file.name}`);
            showToast(`PC İndirilenler klasörüne kaydedildi: ${res.fileName || file.name}`);
          } catch (err) {
            showToast(`${file.name} gönderilemedi: ${err.message}`);
          }
        }
      });
    }

    const openPcFilesForDownloadBtn = document.getElementById('openPcFilesForDownloadBtn');
    if (openPcFilesForDownloadBtn) {
      openPcFilesForDownloadBtn.addEventListener('click', () => {
        triggerHaptic(10);
        openPcFileBrowser('download_to_phone');
      });
    }

    // MACROS & KEY BINDINGS (TAB-MACROS)
    const newMacroBtn = document.getElementById('newMacroBtn');
    if (newMacroBtn) {
      newMacroBtn.addEventListener('click', () => {
        triggerHaptic(12);
        openMacroComposer(null);
      });
    }

    const macrosListContainer = document.getElementById('macrosListContainer');
    if (macrosListContainer) {
      macrosListContainer.addEventListener('click', async (e) => {
        const editBtn = e.target.closest('[data-edit-macro]');
        if (editBtn) {
          e.stopPropagation();
          triggerHaptic(10);
          const id = editBtn.getAttribute('data-edit-macro');
          const found = (state.macros || []).find((m) => m.id === id);
          if (found) openMacroComposer(found);
          return;
        }

        const runBtn = e.target.closest('[data-run-macro]');
        if (runBtn) {
          triggerHaptic(16);
          const id = runBtn.getAttribute('data-run-macro');
          const found = (state.macros || []).find((m) => m.id === id);
          try {
            await sendCommand('run_macro', { id }, 12000);
            logAuditEvent('app', `Makro çalıştırıldı: ${(found && found.name) || 'Makro'}`);
            showToast(`${(found && found.name) || 'Makro'} çalıştırıldı`);
          } catch (err) {
            showToast(err.message);
          }
        }
      });
    }

    const closeMacroModalBtn = document.getElementById('closeMacroModalBtn');
    if (closeMacroModalBtn) {
      closeMacroModalBtn.addEventListener('click', () => closeModal('macroComposerModal'));
    }
    const cancelMacroModalBtn = document.getElementById('cancelMacroModalBtn');
    if (cancelMacroModalBtn) {
      cancelMacroModalBtn.addEventListener('click', () => closeModal('macroComposerModal'));
    }

    const macroModPills = document.getElementById('macroModPills');
    if (macroModPills) {
      macroModPills.addEventListener('click', (e) => {
        const pill = e.target.closest('[data-mod],[data-macro-mod]');
        if (!pill) return;
        triggerHaptic(8);
        pill.classList.toggle('active');
        state.macroActiveMods = Array.from(macroModPills.querySelectorAll('.macro-mod-pill.active')).map(
          (b) => b.getAttribute('data-mod') || b.getAttribute('data-macro-mod')
        );
      });
    }

    const addMacroKeyStepBtn = document.getElementById('addMacroKeyStepBtn');
    if (addMacroKeyStepBtn) {
      addMacroKeyStepBtn.addEventListener('click', () => {
        triggerHaptic(10);
        const keyInput = document.getElementById('macroBaseKeySelect') || document.getElementById('macroCustomKeyInput');
        const rawKey = keyInput ? keyInput.value.trim().toUpperCase() : '';
        const mods = Array.isArray(state.macroActiveMods) ? state.macroActiveMods : [];
        if (!rawKey && !mods.length) {
          showToast('Lütfen bir tuş seçin veya üstten kısayol işaretleyin');
          return;
        }
        const parts = [...mods];
        if (rawKey && !parts.includes(rawKey)) parts.push(rawKey);
        const combo = parts.join('+');
        state.macroSteps.push({ type: 'key', value: combo });
        if (keyInput) keyInput.value = '';
        state.macroActiveMods = [];
        document.querySelectorAll('#macroModPills .macro-mod-pill').forEach((b) => b.classList.remove('active'));
        const nameIn = document.getElementById('macroNameInput');
        if (nameIn && !nameIn.value.trim()) nameIn.value = combo;
        renderMacroComposerSteps();
      });
    }

    const macroPresetChips = document.getElementById('macroPresetChips');
    if (macroPresetChips) {
      macroPresetChips.addEventListener('click', (e) => {
        const chip = e.target.closest('[data-macro-preset]');
        if (!chip) return;
        triggerHaptic(10);
        const presetVal = chip.getAttribute('data-macro-preset');
        if (!presetVal) return;
        const mods = Array.isArray(state.macroActiveMods) ? state.macroActiveMods : [];
        let combo = presetVal;
        if (mods.length && !presetVal.includes('+')) {
          combo = [...mods, presetVal].join('+');
          state.macroActiveMods = [];
          document.querySelectorAll('#macroModPills .macro-mod-pill').forEach((b) => b.classList.remove('active'));
        }
        state.macroSteps.push({ type: 'key', value: combo });
        const nameIn = document.getElementById('macroNameInput');
        if (nameIn && !nameIn.value.trim()) nameIn.value = chip.textContent.trim();
        renderMacroComposerSteps();
      });
    }

    const addMacroSystemStepBtn = document.getElementById('addMacroSystemStepBtn');
    if (addMacroSystemStepBtn) {
      addMacroSystemStepBtn.addEventListener('click', () => {
        triggerHaptic(10);
        const sysSel = document.getElementById('macroSystemActionSelect');
        const code = sysSel ? sysSel.value.trim() : '';
        if (!code) {
          showToast('Lütfen eklenecek sistem işlemini seçin');
          return;
        }
        const opt = sysSel.options[sysSel.selectedIndex];
        const label = opt ? opt.textContent.trim() : code;
        state.macroSteps.push({ type: 'system_action', value: code, label });
        const nameIn = document.getElementById('macroNameInput');
        if (nameIn && !nameIn.value.trim()) nameIn.value = label;
        renderMacroComposerSteps();
      });
    }

    const addMacroTextStepBtn = document.getElementById('addMacroTextStepBtn');
    if (addMacroTextStepBtn) {
      addMacroTextStepBtn.addEventListener('click', () => {
        triggerHaptic(10);
        const txtIn = document.getElementById('macroTextStepInput');
        const val = txtIn ? txtIn.value : '';
        if (!val) {
          showToast('Lütfen yazdırılacak metni girin');
          return;
        }
        state.macroSteps.push({ type: 'text', value: val });
        if (txtIn) txtIn.value = '';
        renderMacroComposerSteps();
      });
    }

    const addMacroDelayStepBtn = document.getElementById('addMacroDelayStepBtn');
    if (addMacroDelayStepBtn) {
      addMacroDelayStepBtn.addEventListener('click', () => {
        triggerHaptic(10);
        const sel = document.getElementById('macroDelayStepInput') || document.getElementById('macroDelaySelect');
        const ms = Math.max(20, Number((sel && sel.value) || 250));
        state.macroSteps.push({ type: 'delay', delayMs: ms, value: `${ms}ms` });
        renderMacroComposerSteps();
      });
    }

    const macroStepsEditorList =
      document.getElementById('macroStepsListContainer') || document.getElementById('macroStepsEditorList');
    if (macroStepsEditorList) {
      macroStepsEditorList.addEventListener('click', (e) => {
        const remBtn = e.target.closest('[data-remove-macro-step]');
        if (!remBtn) return;
        triggerHaptic(10);
        const idx = Number(remBtn.getAttribute('data-remove-macro-step'));
        state.macroSteps.splice(idx, 1);
        renderMacroComposerSteps();
      });
    }

    const saveMacroConfirmBtn =
      document.getElementById('saveMacroModalBtn') || document.getElementById('saveMacroConfirmBtn');
    if (saveMacroConfirmBtn) {
      saveMacroConfirmBtn.addEventListener('click', async () => {
        triggerHaptic(14);
        const keyInput = document.getElementById('macroBaseKeySelect') || document.getElementById('macroCustomKeyInput');
        if (!state.macroSteps.length && keyInput && (keyInput.value.trim() || (state.macroActiveMods && state.macroActiveMods.length))) {
          const rawKey = keyInput.value.trim().toUpperCase();
          const mods = Array.isArray(state.macroActiveMods) ? state.macroActiveMods : [];
          const parts = [...mods];
          if (rawKey && !parts.includes(rawKey)) parts.push(rawKey);
          if (parts.length) {
            state.macroSteps.push({ type: 'key', value: parts.join('+') });
          }
          keyInput.value = '';
        }
        const nameIn = document.getElementById('macroNameInput');
        let name = nameIn ? nameIn.value.trim() : '';
        if (!name && state.macroSteps.length > 0) {
          name = String(state.macroSteps[0].value || 'Makro');
          if (nameIn) nameIn.value = name;
        }
        if (!name) {
          showToast('Lütfen makroya bir ad verin');
          return;
        }
        if (!state.macroSteps.length) {
          showToast('Lütfen en az 1 tuş veya metin adımı ekleyin');
          return;
        }
        try {
          const res = await sendCommand('save_macro', {
            macro: {
              id: state.editingMacroId || undefined,
              name,
              steps: state.macroSteps
            }
          });
          if (res && Array.isArray(res.macros)) {
            state.macros = res.macros;
          }
          renderMacrosList();
          saveWorkspaceCache();
          closeModal('macroComposerModal');
          showToast('Makro kaydedildi');
        } catch (err) {
          showToast(err.message);
        }
      });
    }

    const deleteMacroModalBtn = document.getElementById('deleteMacroModalBtn');
    if (deleteMacroModalBtn) {
      deleteMacroModalBtn.addEventListener('click', async () => {
        if (!state.editingMacroId) return;
        triggerHaptic(16);
        try {
          const res = await sendCommand('delete_macro', { id: state.editingMacroId });
          if (res && Array.isArray(res.macros)) {
            state.macros = res.macros;
          }
          renderMacrosList();
          saveWorkspaceCache();
          closeModal('macroComposerModal');
          showToast('Makro silindi');
        } catch (err) {
          showToast(err.message);
        }
      });
    }

    // REMOTE STREAM TOGGLE & LAPTOP TOUCHPAD BUTTONS
    const toggleStreamHeaderBtn = document.getElementById('toggleStreamHeaderBtn');
    if (toggleStreamHeaderBtn) {
      toggleStreamHeaderBtn.addEventListener('click', () => {
        triggerHaptic(12);
        if (state.isStreaming) {
          stopRemoteStream();
        } else {
          startRemoteStream();
        }
      });
    }

    const laptopTouchpadButtons = document.getElementById('laptopTouchpadButtons');
    if (laptopTouchpadButtons) {
      let leftBtnHoldTimer = null;
      let leftBtnHeldByTouch = false;
      let suppressNextLeftClickTs = 0;

      laptopTouchpadButtons.addEventListener(
        'touchstart',
        (e) => {
          const btn = e.target.closest('[data-mouse-btn="left"]');
          if (!btn) return;
          e.stopPropagation();
          leftBtnHeldByTouch = false;
          clearTimeout(leftBtnHoldTimer);
          leftBtnHoldTimer = setTimeout(() => {
            leftBtnHeldByTouch = true;
            setLeftButtonHold(true);
          }, 140);
        },
        { passive: true }
      );

      const endLeftBtnHold = (e) => {
        clearTimeout(leftBtnHoldTimer);
        if (leftBtnHeldByTouch) {
          if (e && e.cancelable) e.preventDefault();
          leftBtnHeldByTouch = false;
          suppressNextLeftClickTs = performance.now();
          setLeftButtonHold(false);
        }
      };

      laptopTouchpadButtons.addEventListener('touchend', endLeftBtnHold);
      laptopTouchpadButtons.addEventListener('touchcancel', endLeftBtnHold);

      laptopTouchpadButtons.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-mouse-btn]');
        if (!btn) return;
        e.stopPropagation();
        const mouseBtn = btn.getAttribute('data-mouse-btn') || 'left';
        if (mouseBtn === 'left' && performance.now() - suppressNextLeftClickTs < 450) {
          return;
        }
        if (mouseBtn === 'left' && state.isLeftButtonHeld) {
          setLeftButtonHold(false);
          return;
        }
        triggerHaptic(12);
        sendFastInput({ type: 'mouse_click', button: mouseBtn });
      });
    }

    const openAppMixerBtn = document.getElementById('openAppMixerBtn');
    if (openAppMixerBtn) {
      openAppMixerBtn.addEventListener('click', async () => {
        triggerHaptic(10);
        renderAudioTab();
        openModal('appAudioMixerModal');
        try {
          const audio = await sendCommand('audio_control', { action: 'get' });
          if (audio) {
            state.audio = reconcileMediaIntent(audio);
            renderAudioTab();
          }
        } catch {}
      });
    }

    const closeAppMixerModalBtn = document.getElementById('closeAppMixerModalBtn');
    if (closeAppMixerModalBtn) {
      closeAppMixerModalBtn.addEventListener('click', () => {
        closeModal('appAudioMixerModal');
      });
    }

    // Live Media Seek Slider (in Ses ve Medya Mikseri)
    const mediaSeekSlider = document.getElementById('mediaSeekSlider');
    if (mediaSeekSlider) {
      mediaSeekSlider.addEventListener('touchstart', () => {
        state.isSeekingMedia = true;
      }, { passive: true });
      mediaSeekSlider.addEventListener('mousedown', () => {
        state.isSeekingMedia = true;
      });
      mediaSeekSlider.addEventListener('input', () => {
        state.isSeekingMedia = true;
        const curEl = document.getElementById('mediaCurrentTime');
        if (curEl) curEl.textContent = formatMediaTime(Number(mediaSeekSlider.value));
      });
      mediaSeekSlider.addEventListener('change', () => {
        const targetSec = Number(mediaSeekSlider.value);
        state.isSeekingMedia = false;
        triggerHaptic(8);
        performMediaSeek(targetSec);
      });
    }

    // Per-Monitor Screen Brightness Sliders (Stacked Ekran 1, Ekran 2, ...) - Pure smooth native feel matching master volume
    const monitorsBrightnessList = document.getElementById('monitorsBrightnessList');
    if (monitorsBrightnessList) {
      monitorsBrightnessList.addEventListener('input', (e) => {
        const slider = e.target.closest('.monitor-brightness-slider');
        if (!slider) return;
        const monIdx = Number(slider.getAttribute('data-monitor-index'));
        const val = Number(slider.value);
        const lbl = document.getElementById(`monitorBrightnessLabel-${monIdx}`);
        if (lbl) lbl.textContent = `${val}%`;

        // Update local monitor state immediately for snappy UI without choking network
        if (Array.isArray(state.monitors)) {
          const m = state.monitors.find((it) => Number(it.index) === monIdx);
          if (m) m.brightness = val;
        }
      });

      monitorsBrightnessList.addEventListener('change', async (e) => {
        const slider = e.target.closest('.monitor-brightness-slider');
        if (!slider) return;
        const monIdx = Number(slider.getAttribute('data-monitor-index'));
        const val = Number(slider.value);
        triggerHaptic(8);
        try {
          await sendCommand('system_control', {
            action: 'set_brightness',
            monitorIndex: monIdx,
            brightness: val
          });
          showToast(`Ekran ${monIdx + 1} parlaklığı %${val} yapıldı`);
        } catch (err) {
          showToast(err.message);
        }
      });
    }

    document.getElementById('appAudioSessionsContainer').addEventListener('input', (e) => {
      const slider = e.target.closest('[data-app-vol-pid]');
      if (!slider) return;
      const pid = slider.getAttribute('data-app-vol-pid');
      const lbl = document.getElementById(`appVolLabel-${pid}`);
      if (lbl) lbl.textContent = `${slider.value}%`;
    });

    document.getElementById('appAudioSessionsContainer').addEventListener('change', async (e) => {
      const slider = e.target.closest('[data-app-vol-pid]');
      if (!slider) return;
      const pid = Number(slider.getAttribute('data-app-vol-pid'));
      try {
        const audio = await sendCommand('audio_control', {
          action: 'set_app',
          pid,
          volume: Number(slider.value)
        });
        state.audio = reconcileMediaIntent(audio);
        renderAudioTab();
      } catch {}
    });

    document.getElementById('appAudioSessionsContainer').addEventListener('click', async (e) => {
      const muteBtn = e.target.closest('[data-app-mute-pid]');
      if (!muteBtn) return;
      triggerHaptic(10);
      const pid = Number(muteBtn.getAttribute('data-app-mute-pid'));
      const currentlyMuted = muteBtn.getAttribute('data-app-muted') === '1';
      try {
        const audio = await sendCommand('audio_control', {
          action: 'set_app',
          pid,
          muted: !currentlyMuted
        });
        state.audio = reconcileMediaIntent(audio);
        renderAudioTab();
      } catch {}
    });

    // Timed Power Scheduler Controls
    document.querySelectorAll('[data-timer-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        triggerHaptic(8);
        document.querySelectorAll('[data-timer-mode]').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.selectedTimerMode = btn.getAttribute('data-timer-mode');
      });
    });

    document.querySelectorAll('[data-timer-mins]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        triggerHaptic(14);
        const mins = Number(btn.getAttribute('data-timer-mins'));
        try {
          const timerState = await sendCommand('power_timer', {
            minutes: mins,
            mode: mins <= 0 ? 'cancel' : state.selectedTimerMode
          });
          state.powerTimer = timerState;
          renderPowerTimerStatus();
          showToast(mins <= 0 ? 'Zamanlayıcı iptal edildi' : `${mins} dakika sonra uygulanacak`);
        } catch (err) {
          showToast(err.message);
        }
      });
    });

    const copyTextToPhoneClipboard = async (text) => {
      if (!text) return false;
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch {}
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        return true;
      } catch {
        return false;
      }
    };

    const renderClipboardHistoryItems = (items) => {
      const container = document.getElementById('clipboardHistoryListContainer');
      if (!container) return;
      if (!Array.isArray(items) || !items.length) {
        container.innerHTML = `<div class="empty-state compact"><p>PC panosunda henüz kopyalanmış öge yok.</p></div>`;
        return;
      }
      container.innerHTML = items
        .map((it, idx) => {
          const isImg = Boolean(it && (it.type === 'image' || it.image));
          const text = typeof it === 'string' ? it : (it && it.text) || '';
          const timeStr = it && it.time ? it.time : idx === 0 ? 'Son Kopyalanan' : `#${idx + 1}`;
          if (isImg && it.image) {
            return `
              <div class="clipboard-history-item is-image-item" data-clip-idx="${idx}">
                <div class="clipboard-history-meta">
                  <span>${escapeHtml(timeStr)} · ${escapeHtml(text || 'Ekran Görüntüsü')}</span>
                </div>
                <div class="clipboard-history-img-wrap">
                  <img class="clipboard-history-img" src="${safeImageSrc(it.image)}" alt="Pano Görseli" loading="lazy" />
                </div>
              </div>
            `;
          }
          return `
            <div class="clipboard-history-item" data-clip-idx="${idx}">
              <div class="clipboard-history-meta">
                <span>${escapeHtml(timeStr)}</span>
              </div>
              <div class="clipboard-history-text">${escapeHtml(text)}</div>
            </div>
          `;
        })
        .join('');
    };

    document.getElementById('pullClipboardBtn').addEventListener('click', async () => {
      triggerHaptic(10);
      openModal('clipboardHistoryModal');
      const container = document.getElementById('clipboardHistoryListContainer');
      if (container && (!state.clipboardHistory || !state.clipboardHistory.length)) {
        container.innerHTML = `<div class="empty-state compact"><p>PC panosu yükleniyor...</p></div>`;
      }
      try {
        const res = await sendCommand('system_control', { action: 'get_clipboard_history' });
        const list = res && Array.isArray(res.items) ? res.items : [];
        if (!list.length && res && res.text) {
          list.push({ text: res.text, time: 'Şimdi' });
        }
        state.clipboardHistory = list;
        renderClipboardHistoryItems(state.clipboardHistory);
      } catch (err) {
        try {
          const fallback = await sendCommand('system_control', { action: 'get_clipboard' });
          const list = fallback && fallback.text ? [{ text: fallback.text, time: 'Aktif Pano' }] : [];
          state.clipboardHistory = list;
          renderClipboardHistoryItems(list);
        } catch {
          showToast(err.message);
        }
      }
    });

    const closeClipModalBtn = document.getElementById('closeClipboardHistoryModalBtn');
    if (closeClipModalBtn) {
      closeClipModalBtn.addEventListener('click', () => {
        closeModal('clipboardHistoryModal');
      });
    }

    const clipHistoryContainer = document.getElementById('clipboardHistoryListContainer');
    if (clipHistoryContainer) {
      clipHistoryContainer.addEventListener('click', async (e) => {
        const row = e.target.closest('[data-clip-idx]');
        if (!row) return;
        triggerHaptic(12);
        const idx = Number(row.getAttribute('data-clip-idx'));
        const entry = state.clipboardHistory[idx];
        if (!entry) return;

        row.classList.add('is-copied');
        setTimeout(() => row.classList.remove('is-copied'), 650);

        if (entry && (entry.type === 'image' || entry.image) && entry.image) {
          let copiedImg = false;
          try {
            if (navigator.clipboard && window.ClipboardItem) {
              const resp = await fetch(entry.image);
              const blob = await resp.blob();
              const pngBlob = blob.type === 'image/png' ? blob : await new Promise((resolve) => {
                const img = new Image();
                img.onload = () => {
                  const c = document.createElement('canvas');
                  c.width = img.naturalWidth || img.width;
                  c.height = img.naturalHeight || img.height;
                  c.getContext('2d').drawImage(img, 0, 0);
                  c.toBlob((b) => resolve(b), 'image/png');
                };
                img.onerror = () => resolve(null);
                img.src = entry.image;
              });
              if (pngBlob) {
                await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
                copiedImg = true;
              }
            }
          } catch {}
          try {
            await sendCommand('system_control', { action: 'set_clipboard_image', image: entry.image });
          } catch {}
          if (!copiedImg) {
            await copyTextToPhoneClipboard(entry.image);
          }
          logAuditEvent('clipboard', 'Pano geçmişinden görsel kopyalandı');
          showToast('Görsel kopyalandı');
          return;
        }

        const text = typeof entry === 'string' ? entry : (entry && entry.text) || '';
        if (!text) return;
        await copyTextToPhoneClipboard(text);
        try {
          await sendCommand('system_control', { action: 'set_clipboard', text });
        } catch {}
        logAuditEvent('clipboard', 'Pano geçmişinden metin telefon panosuna kopyalandı');
        showToast('Metin telefon panosuna kopyalandı');
      });
    }

    document.getElementById('pushClipboardBtn').addEventListener('click', async () => {
      triggerHaptic(12);
      const inputEl = document.getElementById('clipboardInput');
      const text = inputEl ? inputEl.value : '';
      if (!text.trim()) {
        showToast('Lütfen göndermek için bir metin yazın');
        return;
      }
      if (inputEl) inputEl.value = '';
      try {
        await sendCommand('system_control', { action: 'set_clipboard', text });
        logAuditEvent('clipboard', 'Telefondan PC panosuna metin gönderildi');
        showToast('Metin PC panosuna kopyalandı');
      } catch (err) {
        showToast(err.message);
      }
    });

    document.querySelectorAll('[data-power]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const action = btn.getAttribute('data-power');
        triggerHaptic(18);
        try {
          if (action === 'lock') {
            applyLockResult(await sendCommand('system_control', { action: 'toggle_lock' }));
          } else {
            await sendCommand('system_control', { action });
            const actLabel = action === 'sleep' ? 'Uyku Modu' : action === 'restart' ? 'Yeniden Başlat' : action === 'shutdown' ? 'Bilgisayarı Kapat' : action;
            logAuditEvent('power', `PC Güç komutu: ${actLabel}`);
            showToast(`Güç komutu gönderildi: ${actLabel}`);
          }
        } catch (err) {
          showToast(err.message);
        }
      });
    });

    bindPageLayoutCustomizationEngine();
  }

  // UNIVERSAL ITEM-LEVEL & CROSS-PAGE LAYOUT CUSTOMIZATION ENGINE
  const PAGE_LAYOUT_STORAGE_KEY = 'TAHABLT_PAGE_LAYOUTS_V2';
  const defaultGlobalLayoutMap = new Map();
  const globalLayoutItemsById = new Map();

  function loadSavedPageLayoutsMap() {
    try {
      const raw = localStorage.getItem(PAGE_LAYOUT_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function savePageLayoutsMap(map) {
    try {
      localStorage.setItem(PAGE_LAYOUT_STORAGE_KEY, JSON.stringify(map || {}));
    } catch {}
  }

  function ensureLayoutGripDots(itemEl) {
    if (!itemEl || itemEl.querySelector('.layout-grip-dots')) return;
    const grip = document.createElement('span');
    grip.className = 'layout-grip-dots';
    grip.setAttribute('aria-hidden', 'true');
    grip.innerHTML = `
      <svg viewBox="0 0 12 16" fill="currentColor">
        <rect x="2" y="2" width="2.4" height="2.4" rx="0.6"/>
        <rect x="7.6" y="2" width="2.4" height="2.4" rx="0.6"/>
        <rect x="2" y="6.8" width="2.4" height="2.4" rx="0.6"/>
        <rect x="7.6" y="6.8" width="2.4" height="2.4" rx="0.6"/>
        <rect x="2" y="11.6" width="2.4" height="2.4" rx="0.6"/>
        <rect x="7.6" y="11.6" width="2.4" height="2.4" rx="0.6"/>
      </svg>
    `;

    const titleTarget = itemEl.querySelector(
      '.section-title-lg, .section-title, .remote-touchpad-header-title, .sub-panel-title, .wireless-title, .audio-label, .now-playing-title'
    );
    if (titleTarget) {
      titleTarget.insertBefore(grip, titleTarget.firstChild);
    } else {
      grip.classList.add('layout-grip-floating');
      itemEl.insertBefore(grip, itemEl.firstChild);
    }
  }

  function snapshotDefaultGlobalLayouts() {
    if (defaultGlobalLayoutMap.size > 0) return;
    document.querySelectorAll('[data-layout-container]').forEach((containerEl) => {
      const cid = containerEl.id;
      if (!cid) return;
      const items = Array.from(containerEl.children).filter((el) => el.hasAttribute('data-layout-id'));
      defaultGlobalLayoutMap.set(
        cid,
        items.map((el) => el.getAttribute('data-layout-id'))
      );
      items.forEach((itemEl) => {
        const id = itemEl.getAttribute('data-layout-id');
        if (id) globalLayoutItemsById.set(id, itemEl);
        ensureLayoutGripDots(itemEl);
      });
    });
  }

  function applyAllSavedPageLayouts() {
    snapshotDefaultGlobalLayouts();
    const map = loadSavedPageLayoutsMap();
    const placedIds = new Set();

    // First pass: place all items explicitly saved in each container's order list (supports cross-page moves!)
    document.querySelectorAll('[data-layout-container]').forEach((containerEl) => {
      const cid = containerEl.id;
      if (!cid || !Array.isArray(map[cid])) return;
      map[cid].forEach((id) => {
        const el = globalLayoutItemsById.get(id);
        if (el && !placedIds.has(id)) {
          ensureLayoutGripDots(el);
          containerEl.appendChild(el);
          placedIds.add(id);
        }
      });
    });

    // Second pass: ensure any unplaced items are in their default container in default order
    defaultGlobalLayoutMap.forEach((defaultIds, cid) => {
      const containerEl = document.getElementById(cid);
      if (!containerEl) return;
      defaultIds.forEach((id) => {
        if (!placedIds.has(id)) {
          const el = globalLayoutItemsById.get(id);
          if (el) {
            ensureLayoutGripDots(el);
            containerEl.appendChild(el);
            placedIds.add(id);
          }
        }
      });
    });
  }

  function persistAllContainersLayoutOrder() {
    snapshotDefaultGlobalLayouts();
    const map = {};
    document.querySelectorAll('[data-layout-container]').forEach((containerEl) => {
      if (!containerEl.id) return;
      map[containerEl.id] = Array.from(containerEl.children)
        .filter((el) => el.hasAttribute('data-layout-id'))
        .map((el) => el.getAttribute('data-layout-id'));
    });
    savePageLayoutsMap(map);
  }

  function syncLayoutTargetPillsActiveState() {
    const curTab = state.activeTab || 'tab-scenes';
    document.querySelectorAll('#layoutPageTargetRow [data-layout-target-tab]').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-layout-target-tab') === curTab);
    });
  }

  function enterPageLayoutEditMode() {
    if (document.body.classList.contains('layout-edit-mode')) return;
    if (state.isFullscreen) return;
    snapshotDefaultGlobalLayouts();
    document.body.classList.add('layout-edit-mode');
    const banner = document.getElementById('layoutEditBanner');
    if (banner) banner.classList.remove('hidden');
    const pageRow = document.getElementById('layoutPageTargetRow');
    if (pageRow) pageRow.classList.toggle('hidden', Boolean(state.showingHubView));
    syncLayoutTargetPillsActiveState();
    triggerHaptic(28);
  }

  function exitPageLayoutEditMode() {
    if (!document.body.classList.contains('layout-edit-mode')) return;
    document.body.classList.remove('layout-edit-mode');
    const banner = document.getElementById('layoutEditBanner');
    if (banner) banner.classList.add('hidden');
    document.querySelectorAll('.is-layout-dragging, .layout-magnet-slot, .is-drop-hover').forEach((el) => {
      el.classList.remove('is-layout-dragging', 'layout-magnet-slot', 'is-drop-hover');
      el.style.transform = '';
      el.style.zIndex = '';
    });
    triggerHaptic(12);
  }

  function resetAllPageLayouts() {
    snapshotDefaultGlobalLayouts();
    defaultGlobalLayoutMap.forEach((defaultIds, cid) => {
      const containerEl = document.getElementById(cid);
      if (!containerEl) return;
      defaultIds.forEach((id) => {
        const el = globalLayoutItemsById.get(id);
        if (el) {
          ensureLayoutGripDots(el);
          containerEl.appendChild(el);
        }
      });
    });
    try {
      localStorage.removeItem(PAGE_LAYOUT_STORAGE_KEY);
    } catch {}
    triggerHaptic(20);
    showToast('Tüm sayfa ve öge konumları varsayılana sıfırlandı');
  }

  function bindPageLayoutCustomizationEngine() {
    applyAllSavedPageLayouts();

    const resetBtn = document.getElementById('resetPageLayoutBtn');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        resetAllPageLayouts();
      });
    }

    const doneBtn = document.getElementById('donePageLayoutBtn');
    if (doneBtn) {
      doneBtn.addEventListener('click', () => {
        exitPageLayoutEditMode();
      });
    }

    const pageTargetRow = document.getElementById('layoutPageTargetRow');
    if (pageTargetRow) {
      pageTargetRow.addEventListener('click', (e) => {
        const pill = e.target.closest('[data-layout-target-tab]');
        if (!pill) return;
        const targetTab = pill.getAttribute('data-layout-target-tab');
        if (targetTab) {
          switchToTab(targetTab, true);
          syncLayoutTargetPillsActiveState();
        }
      });
    }

    // Prevent accidental button activations inside cards while rearranging page layout
    document.addEventListener(
      'click',
      (e) => {
        if (!document.body.classList.contains('layout-edit-mode')) return;
        if (e.target.closest('#layoutEditBanner') || e.target.closest('.bottom-nav')) {
          return;
        }
        if (e.target.closest('[data-layout-container]')) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      true
    );

    let longPressTimer = null;
    let pressStartX = 0;
    let pressStartY = 0;
    let dragItemEl = null;
    let dragContainerEl = null;
    let dragAnchorY = 0;
    let lastClientX = 0;
    let lastClientY = 0;
    let autoScrollRaf = null;
    let hoveredTargetTab = null;
    let hoverTabSwitchTimer = null;

    const clearLongPress = () => {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };

    const clearHoverTabSwitch = () => {
      if (hoverTabSwitchTimer) {
        clearTimeout(hoverTabSwitchTimer);
        hoverTabSwitchTimer = null;
      }
      hoveredTargetTab = null;
      document.querySelectorAll('.is-drop-hover').forEach((el) => el.classList.remove('is-drop-hover'));
    };

    const stopAutoScroll = () => {
      if (autoScrollRaf) {
        cancelAnimationFrame(autoScrollRaf);
        autoScrollRaf = null;
      }
    };

    const moveDraggedItemToTabContainer = (targetTabId) => {
      if (!dragItemEl || !targetTabId) return false;
      const newContainer = document.getElementById(targetTabId);
      if (!newContainer || !newContainer.hasAttribute('data-layout-container')) return false;
      if (newContainer === dragContainerEl) return false;

      switchToTab(targetTabId, true);
      syncLayoutTargetPillsActiveState();

      dragItemEl.style.transform = '';
      newContainer.appendChild(dragItemEl);
      dragContainerEl = newContainer;

      const newRect = dragItemEl.getBoundingClientRect();
      dragAnchorY = newRect.top + newRect.height / 2;
      const dy = lastClientY - dragAnchorY;
      dragItemEl.style.transform = `translate3d(0, ${dy.toFixed(1)}px, 0) scale(1.02)`;

      persistAllContainersLayoutOrder();
      triggerHaptic(22);
      const label = dragItemEl.getAttribute('data-layout-label') || 'Öge';
      const tabBtn = document.querySelector(`#layoutPageTargetRow [data-layout-target-tab="${targetTabId}"]`);
      const tabName = tabBtn ? tabBtn.textContent.trim() : 'Yeni Sayfa';
      showToast(`${label} → ${tabName} sayfasına taşındı`);
      return true;
    };

    const detectCrossPageTabTargetAtPoint = (clientX, clientY) => {
      if (state.showingHubView) return null;
      const pills = Array.from(document.querySelectorAll('#layoutPageTargetRow [data-layout-target-tab]'));
      for (const pill of pills) {
        const r = pill.getBoundingClientRect();
        if (clientX >= r.left && clientX <= r.right && clientY >= r.top - 6 && clientY <= r.bottom + 6) {
          return { tabId: pill.getAttribute('data-layout-target-tab'), el: pill };
        }
      }
      const navBtns = Array.from(document.querySelectorAll('#bottomNav .nav-item[data-tab]'));
      for (const btn of navBtns) {
        const r = btn.getBoundingClientRect();
        if (clientX >= r.left && clientX <= r.right && clientY >= r.top - 6 && clientY <= r.bottom + 6) {
          return { tabId: btn.getAttribute('data-tab'), el: btn };
        }
      }
      return null;
    };

    const beginMagneticDrag = (itemEl, clientX, clientY) => {
      if (!itemEl || !itemEl.parentElement) return;
      dragItemEl = itemEl;
      dragContainerEl = itemEl.parentElement;
      dragAnchorY = clientY;
      lastClientX = clientX;
      lastClientY = clientY;
      dragItemEl.classList.add('is-layout-dragging');
      dragItemEl.style.zIndex = '88';
      triggerHaptic(18);

      const scrollStep = () => {
        if (!dragItemEl || !dragContainerEl) return;
        const rect = dragContainerEl.getBoundingClientRect();
        const edgeZone = 74;
        let scrollDelta = 0;
        if (lastClientY < rect.top + edgeZone) {
          scrollDelta = -Math.max(4, Math.round(((rect.top + edgeZone - lastClientY) / edgeZone) * 14));
        } else if (lastClientY > rect.bottom - edgeZone) {
          scrollDelta = Math.max(4, Math.round(((lastClientY - (rect.bottom - edgeZone)) / edgeZone) * 14));
        }
        if (scrollDelta !== 0) {
          const prevScroll = dragContainerEl.scrollTop;
          dragContainerEl.scrollTop += scrollDelta;
          const actualScroll = dragContainerEl.scrollTop - prevScroll;
          if (actualScroll !== 0) {
            dragAnchorY -= actualScroll;
            updateMagneticDragPosition(lastClientX, lastClientY);
          }
        }
        autoScrollRaf = requestAnimationFrame(scrollStep);
      };
      stopAutoScroll();
      autoScrollRaf = requestAnimationFrame(scrollStep);
    };

    const updateMagneticDragPosition = (clientX, clientY) => {
      if (!dragItemEl || !dragContainerEl) return;
      lastClientX = clientX;
      lastClientY = clientY;
      let dy = clientY - dragAnchorY;
      dragItemEl.style.transform = `translate3d(0, ${dy.toFixed(1)}px, 0) scale(1.015)`;

      // Check if hovering over a cross-page tab target pill or bottom navbar icon
      const tabHit = detectCrossPageTabTargetAtPoint(clientX, clientY);
      if (tabHit && tabHit.tabId && tabHit.tabId !== dragContainerEl.id) {
        if (hoveredTargetTab !== tabHit.tabId) {
          clearHoverTabSwitch();
          hoveredTargetTab = tabHit.tabId;
          tabHit.el.classList.add('is-drop-hover');
          hoverTabSwitchTimer = setTimeout(() => {
            if (dragItemEl && hoveredTargetTab === tabHit.tabId) {
              moveDraggedItemToTabContainer(tabHit.tabId);
              clearHoverTabSwitch();
            }
          }, 280);
        }
        return;
      } else if (hoveredTargetTab) {
        clearHoverTabSwitch();
      }

      const draggedRect = dragItemEl.getBoundingClientRect();
      const draggedCenterY = draggedRect.top + draggedRect.height / 2;

      const siblings = Array.from(dragContainerEl.children).filter(
        (el) => el.hasAttribute('data-layout-id') && !el.classList.contains('hidden')
      );
      const curIdx = siblings.indexOf(dragItemEl);
      if (curIdx === -1) return;

      // Magnetic upward swap
      if (curIdx > 0) {
        const prevEl = siblings[curIdx - 1];
        const prevRect = prevEl.getBoundingClientRect();
        const prevThreshold = prevRect.top + prevRect.height * 0.52;
        if (draggedCenterY < prevThreshold) {
          const beforeTop = dragItemEl.getBoundingClientRect().top - dy;
          dragContainerEl.insertBefore(dragItemEl, prevEl);
          const afterTop = dragItemEl.getBoundingClientRect().top - dy;
          dragAnchorY += afterTop - beforeTop;
          dy = clientY - dragAnchorY;
          dragItemEl.style.transform = `translate3d(0, ${dy.toFixed(1)}px, 0) scale(1.015)`;
          persistAllContainersLayoutOrder();
          triggerHaptic(10);
          return;
        }
      }

      // Magnetic downward swap
      if (curIdx < siblings.length - 1) {
        const nextEl = siblings[curIdx + 1];
        const nextRect = nextEl.getBoundingClientRect();
        const nextThreshold = nextRect.top + nextRect.height * 0.48;
        if (draggedCenterY > nextThreshold) {
          const beforeTop = dragItemEl.getBoundingClientRect().top - dy;
          dragContainerEl.insertBefore(nextEl, dragItemEl);
          const afterTop = dragItemEl.getBoundingClientRect().top - dy;
          dragAnchorY += afterTop - beforeTop;
          dy = clientY - dragAnchorY;
          dragItemEl.style.transform = `translate3d(0, ${dy.toFixed(1)}px, 0) scale(1.015)`;
          persistAllContainersLayoutOrder();
          triggerHaptic(10);
        }
      }
    };

    const endMagneticDrag = () => {
      clearLongPress();
      stopAutoScroll();
      if (!dragItemEl) {
        clearHoverTabSwitch();
        return;
      }
      // If user released finger directly on a target page pill or bottom nav icon before the hover timer fired, move it immediately!
      const dropHit = detectCrossPageTabTargetAtPoint(lastClientX, lastClientY);
      if (dropHit && dropHit.tabId && dragContainerEl && dropHit.tabId !== dragContainerEl.id) {
        moveDraggedItemToTabContainer(dropHit.tabId);
      }
      clearHoverTabSwitch();

      const finishedEl = dragItemEl;
      dragItemEl = null;
      dragContainerEl = null;
      finishedEl.classList.remove('is-layout-dragging');
      finishedEl.classList.add('layout-magnet-slot');
      finishedEl.style.transform = '';
      finishedEl.style.zIndex = '';
      setTimeout(() => {
        finishedEl.classList.remove('layout-magnet-slot');
      }, 260);
      persistAllContainersLayoutOrder();
      triggerHaptic(14);
    };

    document.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length !== 1) {
          clearLongPress();
          endMagneticDrag();
          return;
        }
        if (document.body.classList.contains('modal-open') || state.isFullscreen) return;
        const target = e.target;
        if (!target || target.closest('#layoutEditBanner') || target.closest('.bottom-nav')) return;

        const itemEl = target.closest('[data-layout-id]');
        const containerEl = target.closest('[data-layout-container]');
        if (!containerEl || !itemEl) return;

        const t = e.touches[0];
        pressStartX = t.clientX;
        pressStartY = t.clientY;
        lastClientX = t.clientX;
        lastClientY = t.clientY;

        // In layout edit mode, touching the 6-dot grip or anywhere on an item begins dragging immediately
        if (document.body.classList.contains('layout-edit-mode')) {
          if (target.closest('.layout-grip-dots')) {
            if (e.cancelable) e.preventDefault();
            beginMagneticDrag(itemEl, t.clientX, t.clientY);
          } else {
            clearLongPress();
            longPressTimer = setTimeout(() => {
              beginMagneticDrag(itemEl, lastClientX || t.clientX, lastClientY || t.clientY);
            }, 90);
          }
          return;
        }

        // When NOT in layout edit mode: ignore interactive inputs, sliders, touchpad surface, or buttons with their own hold actions
        if (
          target.closest('#remoteViewportBox') ||
          target.closest('#laptopTouchpadButtons') ||
          target.closest('input, textarea, select, [data-hotkey], [data-key]') ||
          target.closest('[data-qa-tile]') ||
          target.closest('[data-app-card-idx]') ||
          target.closest('[data-hub-device-id]')
        ) {
          return;
        }

        clearLongPress();
        longPressTimer = setTimeout(() => {
          enterPageLayoutEditMode();
          beginMagneticDrag(itemEl, lastClientX || t.clientX, lastClientY || t.clientY);
        }, 520);
      },
      { passive: false }
    );

    document.addEventListener(
      'touchmove',
      (e) => {
        if (e.touches.length !== 1) {
          clearLongPress();
          return;
        }
        const t = e.touches[0];
        lastClientX = t.clientX;
        lastClientY = t.clientY;
        if (dragItemEl) {
          if (e.cancelable) e.preventDefault();
          updateMagneticDragPosition(t.clientX, t.clientY);
          return;
        }
        if (longPressTimer) {
          const moved = Math.hypot(t.clientX - pressStartX, t.clientY - pressStartY);
          if (moved > 10) {
            clearLongPress();
          }
        }
      },
      { passive: false }
    );

    document.addEventListener('touchend', endMagneticDrag, { passive: true });
    document.addEventListener('touchcancel', endMagneticDrag, { passive: true });
  }

  // INITIALIZE APP
  function init() {
    bindEvents();
    let initDev = getActiveDevice();
    if (initDev && (!initDev.authToken || initDev.connectionRevoked)) {
      const validAlt = state.devices.find((d) => Boolean(d.authToken && !d.connectionRevoked));
      if (validAlt) {
        state.activeDeviceId = validAlt.deviceId;
        initDev = validAlt;
      }
    }
    syncActiveDeviceToNative();
    if (initDev && initDev.authToken && !initDev.connectionRevoked) {
      loadWorkspaceCache();
      state.isInitialConnecting = true;
      switchToTab(state.activeTab || 'tab-scenes', false);
    } else {
      state.showingHubView = true;
    }
    renderLockStateUi();
    syncConnectionViewState();
    renderSavedDevicesList();
    if (state.isInitialConnecting) {
      renderAllConnectedViews();
    }

    if (initDev && initDev.authToken && !initDev.connectionRevoked) {
      connectToActiveDevice(true);
    } else {
      scanNetworkForDevices();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
