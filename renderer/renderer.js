const { ipcRenderer } = require('electron');
const MinecraftLauncher = require('../src/launcher');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const os = require('os');

// ============================================================================
// STATE
// ============================================================================

let launcher;
let state = {
  versions: [],
  filteredVersions: [],
  selectedVersion: null,
  account: {
    username: 'Player',
    uuid: generateOfflineUUID('Player'),
    type: 'legacy',
    accessToken: '0',
  },
  settings: {
    javaPath: '',
    ramMb: 4096,
    gameDir: '',
    fullscreen: false,
    windowWidth: 1920,
    windowHeight: 1080,
    locale: 'ru',
    isDarkTheme: true,
  },
  filters: {
    releases: true,
    snapshots: false,
    old: false,
  },
  stats: {
    totalPlayTime: 0,
    totalLaunches: 0,
    todayTime: 0,
    weekTime: 0,
    longestSession: 0,
  },
  isGameRunning: false,
  isDownloading: false,
  currentTab: 'home',
};

// ============================================================================
// INITIALIZATION
// ============================================================================

async function init() {
  console.log('Initializing launcher...');
  
  // Получаем директорию игры
  state.settings.gameDir = await ipcRenderer.invoke('get-minecraft-dir');
  
  // Создаём launcher
  launcher = new MinecraftLauncher(state.settings.gameDir);
  
  // Загружаем настройки
  await loadSettings();
  
  // Загружаем статистику
  await loadStats();
  
  // Настраиваем обработчики
  setupEventListeners();
  
  // Загружаем версии
  await loadVersions();
  
  // Автопоиск Java
  if (!state.settings.javaPath) {
    await autoFindJava();
  }
  
  // Обновляем UI
  updateUI();
  
  console.log('Launcher initialized');
}

// ============================================================================
// SETTINGS
// ============================================================================

async function loadSettings() {
  try {
    const settingsPath = path.join(state.settings.gameDir, 'nslauncher-settings.json');
    if (fsSync.existsSync(settingsPath)) {
      const data = await fs.readFile(settingsPath, 'utf-8');
      const saved = JSON.parse(data);
      state.settings = { ...state.settings, ...saved };
      state.account = saved.account || state.account;
    }
  } catch (error) {
    console.error('Failed to load settings:', error);
  }
}

async function saveSettings() {
  try {
    const settingsPath = path.join(state.settings.gameDir, 'nslauncher-settings.json');
    await fs.writeFile(settingsPath, JSON.stringify({
      ...state.settings,
      account: state.account,
    }, null, 2));
  } catch (error) {
    console.error('Failed to save settings:', error);
  }
}

async function loadStats() {
  try {
    const statsPath = path.join(state.settings.gameDir, 'nslauncher-stats.json');
    if (fsSync.existsSync(statsPath)) {
      const data = await fs.readFile(statsPath, 'utf-8');
      state.stats = JSON.parse(data);
    }
  } catch (error) {
    console.error('Failed to load stats:', error);
  }
}

async function saveStats() {
  try {
    const statsPath = path.join(state.settings.gameDir, 'nslauncher-stats.json');
    await fs.writeFile(statsPath, JSON.stringify(state.stats, null, 2));
  } catch (error) {
    console.error('Failed to save stats:', error);
  }
}

// ============================================================================
// VERSIONS
// ============================================================================

async function loadVersions() {
  try {
    showLoadingState();
    const versions = await launcher.getVersions();
    state.versions = versions;
    filterVersions();
    hideLoadingState();
  } catch (error) {
    console.error('Failed to load versions:', error);
    showToast('Ошибка загрузки версий: ' + error.message, 'error');
    hideLoadingState();
  }
}

function filterVersions() {
  state.filteredVersions = state.versions.filter(v => {
    // Фильтр по типу
    if (state.filters.releases && v.type === 'release') return true;
    if (state.filters.snapshots && v.type === 'snapshot') return true;
    if (state.filters.old && (v.type === 'old_beta' || v.type === 'old_alpha')) return true;
    return false;
  });

  // Автовыбор первой версии
  if (!state.selectedVersion && state.filteredVersions.length > 0) {
    state.selectedVersion = state.filteredVersions[0];
  }

  renderVersions();
}

function renderVersions() {
  const container = document.getElementById('versionsList');
  container.innerHTML = '';

  if (state.filteredVersions.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">🔍</span>
        <p>Версии не найдены</p>
        <small>Попробуйте изменить фильтры</small>
      </div>
    `;
    return;
  }

  for (const version of state.filteredVersions) {
    const card = createVersionCard(version);
    container.appendChild(card);
  }
}

function createVersionCard(version) {
  const card = document.createElement('div');
  card.className = 'version-card';
  if (state.selectedVersion?.id === version.id) {
    card.classList.add('selected');
  }

  const isFabric = version.id.includes('fabric-loader');
  const versionType = isFabric ? 'fabric' : version.type;
  
  card.innerHTML = `
    <div class="version-icon ${versionType}">
      ${isFabric ? '🧵' : (version.type === 'release' ? '✓' : '🔬')}
    </div>
    <div class="version-info">
      <div class="version-name">${isFabric ? version.id.split('-').pop() : version.id}</div>
      <div class="version-meta">
        <span>${getVersionTypeName(version)}</span>
        ${isFabric ? `<span class="version-badge fabric-tag">🧵 Fabric</span>` : ''}
      </div>
    </div>
    ${state.selectedVersion?.id === version.id ? '<div class="version-check">✓</div>' : ''}
  `;

  card.addEventListener('click', () => selectVersion(version));
  return card;
}

function selectVersion(version) {
  state.selectedVersion = version;
  updateUI();
}

function getVersionTypeName(version) {
  if (version.id.includes('fabric-loader')) return 'Fabric';
  switch (version.type) {
    case 'release': return 'Релиз';
    case 'snapshot': return 'Снапшот';
    case 'old_beta': return 'Бета';
    case 'old_alpha': return 'Альфа';
    default: return version.type;
  }
}

// ============================================================================
// DOWNLOAD & LAUNCH
// ============================================================================

async function downloadVersion() {
  if (!state.selectedVersion) {
    showToast('Выберите версию!', 'error');
    return;
  }

  if (state.isDownloading) return;

  const isInstalled = await launcher.isVersionInstalled(state.selectedVersion.id);
  if (isInstalled) {
    showToast('Версия уже установлена!', 'success');
    return;
  }

  state.isDownloading = true;
  showDownloadOverlay();

  try {
    await launcher.downloadVersion(state.selectedVersion, (progress) => {
      updateDownloadProgress(progress.status, progress.progress);
    });
    
    showToast(`Версия ${state.selectedVersion.id} готова к запуску!`, 'success');
  } catch (error) {
    console.error('Download failed:', error);
    showToast('Ошибка загрузки: ' + error.message, 'error');
  } finally {
    state.isDownloading = false;
    hideDownloadOverlay();
  }
}

async function launchGame() {
  if (state.isGameRunning) {
    showToast('Игра уже запущена!', 'error');
    return;
  }

  if (!state.selectedVersion) {
    showToast('Выберите версию!', 'error');
    return;
  }

  if (!state.settings.javaPath) {
    showToast('Java не найдена! Укажите путь в настройках.', 'error');
    return;
  }

  const isInstalled = await launcher.isVersionInstalled(state.selectedVersion.id);
  if (!isInstalled) {
    showToast('Сначала скачайте версию!', 'error');
    return;
  }

  state.isGameRunning = true;
  state.stats.totalLaunches++;
  const sessionStart = Date.now();
  updateUI();

  try {
    const exitCode = await launcher.launchGame(
      state.selectedVersion.id,
      state.account,
      state.settings
    );
    
    console.log('Game exited with code:', exitCode);
  } catch (error) {
    console.error('Launch failed:', error);
    showToast('Ошибка запуска: ' + error.message, 'error');
  } finally {
    const sessionDuration = Math.floor((Date.now() - sessionStart) / 1000);
    state.stats.totalPlayTime += sessionDuration;
    state.stats.todayTime += sessionDuration;
    state.stats.weekTime += sessionDuration;
    if (sessionDuration > state.stats.longestSession) {
      state.stats.longestSession = sessionDuration;
    }
    
    await saveStats();
    state.isGameRunning = false;
    updateUI();
  }
}

async function installFabric(mcVersion) {
  if (state.isDownloading) return;

  state.isDownloading = true;
  showDownloadOverlay();

  try {
    updateDownloadProgress(`Установка Fabric для ${mcVersion}...`, 0);
    
    const fabricId = await launcher.installFabric(mcVersion, (progress) => {
      updateDownloadProgress(progress.status, progress.progress);
    });
    
    showToast(`Fabric установлен для ${mcVersion}!`, 'success');
    
    // Обновляем список версий
    await loadVersions();
  } catch (error) {
    console.error('Fabric installation failed:', error);
    showToast('Ошибка установки Fabric: ' + error.message, 'error');
  } finally {
    state.isDownloading = false;
    hideDownloadOverlay();
  }
}

// ============================================================================
// UI UPDATES
// ============================================================================

function updateUI() {
  // Обновляем информацию о выбранной версии
  const versionDisplay = document.getElementById('selectedVersionDisplay');
  if (state.selectedVersion) {
    versionDisplay.innerHTML = `
      <span class="version-icon">🎮</span>
      <span class="version-text">${state.selectedVersion.id}</span>
    `;
  } else {
    versionDisplay.innerHTML = `
      <span class="version-icon">🎮</span>
      <span class="version-text">Выберите версию</span>
    `;
  }

  // Обновляем информацию об аккаунте
  document.querySelector('.account-name').textContent = state.account.username;
  document.querySelector('.account-type').textContent = 
    state.account.type === 'legacy' ? 'Offline' : 'Microsoft';
  
  // Обновляем аватар
  const avatar = document.querySelector('.player-avatar img');
  avatar.src = `https://mc-heads.net/avatar/${state.account.username}/100`;

  // Обновляем кнопку играть
  const playBtn = document.getElementById('playBtn');
  const playText = playBtn.querySelector('.play-text');
  if (state.isGameRunning) {
    playBtn.classList.add('playing');
    playText.textContent = 'ИГРАЕМ...';
    playBtn.querySelector('.play-icon').textContent = '⏳';
  } else {
    playBtn.classList.remove('playing');
    playText.textContent = 'ИГРАТЬ';
    playBtn.querySelector('.play-icon').textContent = '▶';
  }

  // Обновляем статус
  updateStatusIndicator();
  
  // Обновляем настройки
  updateSettingsUI();
  
  // Обновляем статистику
  updateStatsUI();
  
  // Перерисовываем версии
  renderVersions();
}

function updateStatusIndicator() {
  const indicator = document.getElementById('statusIndicator');
  const statusText = document.getElementById('statusText');
  
  if (state.isGameRunning) {
    indicator.classList.add('active');
    statusText.textContent = 'В игре';
  } else {
    indicator.classList.remove('active');
    const hours = Math.floor(state.stats.totalPlayTime / 3600);
    const minutes = Math.floor((state.stats.totalPlayTime % 3600) / 60);
    statusText.textContent = `Всего: ${hours}ч ${minutes}м`;
  }
}

function updateSettingsUI() {
  document.getElementById('javaPathInput').value = state.settings.javaPath || 'Не указан';
  document.getElementById('gameDirInput').value = state.settings.gameDir;
  document.getElementById('ramSlider').value = state.settings.ramMb / 1024;
  document.getElementById('ramValue').textContent = (state.settings.ramMb / 1024).toFixed(1);
  document.getElementById('ramDisplay').textContent = `${(state.settings.ramMb / 1024).toFixed(1)} ГБ RAM`;
  document.getElementById('fullscreenToggle').checked = state.settings.fullscreen;
  document.getElementById('windowWidth').value = state.settings.windowWidth;
  document.getElementById('windowHeight').value = state.settings.windowHeight;
  
  const windowSizeGroup = document.getElementById('windowSizeGroup');
  windowSizeGroup.style.display = state.settings.fullscreen ? 'none' : 'block';
}

function updateStatsUI() {
  const hours = Math.floor(state.stats.totalPlayTime / 3600);
  const minutes = Math.floor((state.stats.totalPlayTime % 3600) / 60);
  document.getElementById('totalTime').textContent = `${hours} ч ${minutes} мин`;
  document.getElementById('totalLaunches').textContent = state.stats.totalLaunches;
  
  const todayMins = Math.floor(state.stats.todayTime / 60);
  document.getElementById('todayTime').textContent = `${todayMins} мин`;
  
  const weekMins = Math.floor(state.stats.weekTime / 60);
  document.getElementById('weekTime').textContent = `${weekMins} мин`;
  
  const longestMins = Math.floor(state.stats.longestSession / 60);
  document.getElementById('longestSession').textContent = `${longestMins} мин`;
}

// ============================================================================
// EVENT LISTENERS
// ============================================================================

function setupEventListeners() {
  // Window controls
  document.getElementById('minimizeBtn').addEventListener('click', () => {
    ipcRenderer.send('window-minimize');
  });

  document.getElementById('maximizeBtn').addEventListener('click', () => {
    ipcRenderer.send('window-maximize');
  });

  document.getElementById('closeBtn').addEventListener('click', () => {
    ipcRenderer.send('window-close');
  });

  // Navigation
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      switchTab(btn.dataset.tab);
    });
  });

  // Home tab
  document.getElementById('playBtn').addEventListener('click', launchGame);
  document.getElementById('downloadBtn').addEventListener('click', downloadVersion);
  document.getElementById('folderBtn').addEventListener('click', async () => {
    await ipcRenderer.invoke('open-folder', state.settings.gameDir);
  });
  document.getElementById('refreshVersions').addEventListener('click', loadVersions);

  // Version filters
  document.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const filter = chip.dataset.filter;
      state.filters[filter] = !state.filters[filter];
      chip.classList.toggle('active');
      filterVersions();
    });
  });

  // Version search
  document.getElementById('versionSearch').addEventListener('input', (e) => {
    const search = e.target.value.toLowerCase();
    state.filteredVersions = state.versions.filter(v => {
      const matchesSearch = v.id.toLowerCase().includes(search);
      const matchesType = 
        (state.filters.releases && v.type === 'release') ||
        (state.filters.snapshots && v.type === 'snapshot') ||
        (state.filters.old && (v.type === 'old_beta' || v.type === 'old_alpha'));
      return matchesSearch && matchesType;
    });
    renderVersions();
  });

  // Settings
  document.getElementById('selectJava').addEventListener('click', async () => {
    const path = await ipcRenderer.invoke('select-file', [
      { name: 'Java Executable', extensions: ['exe'] }
    ]);
    if (path) {
      state.settings.javaPath = path;
      await saveSettings();
      updateUI();
    }
  });

  document.getElementById('autoJava').addEventListener('click', async () => {
    await autoFindJava();
  });

  document.getElementById('selectGameDir').addEventListener('click', async () => {
    const dir = await ipcRenderer.invoke('select-directory');
    if (dir) {
      state.settings.gameDir = dir;
      launcher.gameDir = dir;
      await saveSettings();
      updateUI();
    }
  });

  document.getElementById('openGameDir').addEventListener('click', async () => {
    await ipcRenderer.invoke('open-folder', state.settings.gameDir);
  });

  document.getElementById('ramSlider').addEventListener('input', (e) => {
    const gb = parseFloat(e.target.value);
    state.settings.ramMb = Math.floor(gb * 1024);
    updateUI();
  });

  document.getElementById('ramSlider').addEventListener('change', saveSettings);

  document.getElementById('fullscreenToggle').addEventListener('change', async (e) => {
    state.settings.fullscreen = e.target.checked;
    await saveSettings();
    updateUI();
  });

  document.getElementById('windowWidth').addEventListener('change', async (e) => {
    state.settings.windowWidth = parseInt(e.target.value) || 1920;
    await saveSettings();
  });

  document.getElementById('windowHeight').addEventListener('change', async (e) => {
    state.settings.windowHeight = parseInt(e.target.value) || 1080;
    await saveSettings();
  });

  // Stats
  document.getElementById('resetStats').addEventListener('click', async () => {
    if (confirm('Сбросить всю статистику?')) {
      state.stats = {
        totalPlayTime: 0,
        totalLaunches: 0,
        todayTime: 0,
        weekTime: 0,
        longestSession: 0,
      };
      await saveStats();
      updateUI();
      showToast('Статистика сброшена', 'success');
    }
  });

  // About links
  document.querySelectorAll('.link-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const url = btn.dataset.url;
      if (url) {
        ipcRenderer.invoke('open-url', url);
      }
    });
  });

  // Language toggle
  document.getElementById('langToggle').addEventListener('click', () => {
    state.settings.locale = state.settings.locale === 'ru' ? 'en' : 'ru';
    document.getElementById('langToggle').textContent = 
      state.settings.locale === 'ru' ? '🇷🇺 RU' : '🇺🇸 EN';
    saveSettings();
    // TODO: Update all text based on locale
  });

  // Theme toggle
  document.getElementById('themeToggle').addEventListener('click', () => {
    state.settings.isDarkTheme = !state.settings.isDarkTheme;
    document.getElementById('themeToggle').textContent = 
      state.settings.isDarkTheme ? '🌙' : '☀️';
    saveSettings();
    // TODO: Apply light theme
  });

  // Account management
  document.getElementById('accountInfo').addEventListener('click', () => {
    showAccountDialog();
  });

  document.getElementById('manageAccountsBtn')?.addEventListener('click', () => {
    showAccountDialog();
  });
}

function switchTab(tabName) {
  state.currentTab = tabName;
  
  // Update nav items
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.remove('active');
    if (item.dataset.tab === tabName) {
      item.classList.add('active');
    }
  });

  // Update tab content
  document.querySelectorAll('.tab-content').forEach(tab => {
    tab.classList.remove('active');
  });
  
  document.getElementById(`${tabName}Tab`).classList.add('active');
}

// ============================================================================
// JAVA AUTO-DETECTION
// ============================================================================

async function autoFindJava() {
  const paths = [
    'C:\\Program Files\\Java',
    'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\Microsoft\\jdk-21.0.9.10-hotspot',
    'C:\\Program Files\\Microsoft',
    'C:\\Program Files\\Zulu',
    'C:\\Program Files\\BellSoft',
    'C:\\Program Files (x86)\\Java',
  ];

  for (const basePath of paths) {
    try {
      const exists = await ipcRenderer.invoke('check-file-exists', basePath);
      if (exists) {
        const dirs = await fs.readdir(basePath);
        for (const dir of dirs) {
          const javawPath = path.join(basePath, dir, 'bin', 'javaw.exe');
          const javawExists = await ipcRenderer.invoke('check-file-exists', javawPath);
          if (javawExists) {
            state.settings.javaPath = javawPath;
            await saveSettings();
            updateUI();
            showToast('Java найдена автоматически!', 'success');
            return;
          }
        }
      }
    } catch (error) {
      console.warn('Failed to check path:', basePath);
    }
  }

  showToast('Java не найдена. Укажите путь вручную.', 'error');
}

// ============================================================================
// ACCOUNT MANAGEMENT
// ============================================================================

function showAccountDialog() {
  const currentUsername = state.account.username;
  const newUsername = prompt('Введите никнейм:', currentUsername);
  
  if (newUsername && newUsername.trim()) {
    state.account.username = newUsername.trim();
    state.account.uuid = generateOfflineUUID(newUsername.trim());
    saveSettings();
    updateUI();
    showToast(`Аккаунт изменён на ${newUsername}`, 'success');
  }
}

function generateOfflineUUID(username) {
  // Генерируем UUID для оффлайн режима
  let hash = 0;
  const data = `OfflinePlayer:${username}`;
  for (let i = 0; i < data.length; i++) {
    hash = ((hash << 5) - hash + data.charCodeAt(i)) & 0xFFFFFFFF;
  }
  const hex = hash.toString(16).padStart(8, '0');
  return `00000000-0000-0000-0000-${hex.padStart(12, '0')}`;
}

// ============================================================================
// UI HELPERS
// ============================================================================

function showDownloadOverlay() {
  document.getElementById('downloadOverlay').style.display = 'flex';
}

function hideDownloadOverlay() {
  document.getElementById('downloadOverlay').style.display = 'none';
}

function updateDownloadProgress(status, progress) {
  document.getElementById('downloadStatus').textContent = status;
  document.getElementById('progressFill').style.width = `${progress * 100}%`;
  document.getElementById('progressText').textContent = `${Math.floor(progress * 100)}%`;
}

function showLoadingState() {
  const container = document.getElementById('versionsList');
  container.innerHTML = `
    <div class="loading-state">
      <div class="spinner"></div>
      <p>Загрузка версий...</p>
    </div>
  `;
}

function hideLoadingState() {
  // Versions will be rendered by renderVersions()
}

function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  const icon = type === 'success' ? '✓' : '✕';
  
  toast.innerHTML = `
    <span class="toast-icon">${icon}</span>
    <span class="toast-message">${message}</span>
  `;
  
  container.appendChild(toast);
  
  setTimeout(() => {
    toast.style.animation = 'slideIn 0.3s ease reverse';
    setTimeout(() => toast.remove(), 300);
  }, type === 'error' ? 4000 : 2000);
}

// ============================================================================
// INITIALIZATION
// ============================================================================

window.addEventListener('DOMContentLoaded', () => {
  init().catch(error => {
    console.error('Initialization failed:', error);
    showToast('Ошибка инициализации: ' + error.message, 'error');
  });
});
