const { spawn } = require('child_process');
const axios = require('axios');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const crypto = require('crypto');
const os = require('os');

class MinecraftLauncher {
  constructor(gameDir) {
    this.gameDir = gameDir || path.join(os.homedir(), 'AppData', 'Roaming', '.minecraft');
    this.versionManifestUrl = 'https://launchermeta.mojang.com/mc/game/version_manifest.json';
    this.resourcesUrl = 'https://resources.download.minecraft.net';
    this.fabricMetaUrl = 'https://meta.fabricmc.net/v2';
    this.versionsCache = null;
    this.gameProcess = null;
  }

  // ========================================================================
  // ВЕРСИИ MINECRAFT
  // ========================================================================

  async fetchVersionManifest() {
    try {
      if (this.versionsCache) return this.versionsCache;
      
      const response = await axios.get(this.versionManifestUrl);
      this.versionsCache = response.data;
      return this.versionsCache;
    } catch (error) {
      console.error('Failed to fetch version manifest:', error);
      throw error;
    }
  }

  async getVersions() {
    const manifest = await this.fetchVersionManifest();
    const versions = manifest.versions;

    // Добавляем локальные версии (включая Fabric)
    const localVersions = await this.getLocalVersions();
    
    // Объединяем, избегая дубликатов
    const allVersions = [...localVersions];
    for (const version of versions) {
      if (!allVersions.find(v => v.id === version.id)) {
        allVersions.push(version);
      }
    }

    return allVersions;
  }

  async getLocalVersions() {
    const versionsDir = path.join(this.gameDir, 'versions');
    const localVersions = [];

    try {
      await fs.mkdir(versionsDir, { recursive: true });
      const dirs = await fs.readdir(versionsDir);

      for (const dir of dirs) {
        const versionPath = path.join(versionsDir, dir);
        const jsonPath = path.join(versionPath, `${dir}.json`);

        try {
          const stats = await fs.stat(versionPath);
          if (stats.isDirectory() && fsSync.existsSync(jsonPath)) {
            const versionData = JSON.parse(await fs.readFile(jsonPath, 'utf-8'));
            localVersions.push({
              id: dir,
              type: versionData.type || 'release',
              releaseTime: versionData.releaseTime || new Date().toISOString(),
              url: '',
              isLocal: true,
              isFabric: dir.includes('fabric-loader'),
            });
          }
        } catch (err) {
          console.warn(`Failed to read version ${dir}:`, err.message);
        }
      }
    } catch (error) {
      console.error('Failed to scan local versions:', error);
    }

    return localVersions;
  }

  async getVersionData(version) {
    const versionPath = path.join(this.gameDir, 'versions', version.id, `${version.id}.json`);
    
    // Проверяем локальную версию
    if (fsSync.existsSync(versionPath)) {
      const data = await fs.readFile(versionPath, 'utf-8');
      return JSON.parse(data);
    }

    // Загружаем из интернета
    const response = await axios.get(version.url);
    return response.data;
  }

  async isVersionInstalled(versionId) {
    const versionDir = path.join(this.gameDir, 'versions', versionId);
    const jsonFile = path.join(versionDir, `${versionId}.json`);
    const jarFile = path.join(versionDir, `${versionId}.jar`);

    try {
      await fs.access(jsonFile);
      
      // Для Fabric версий проверяем базовую версию
      if (versionId.includes('fabric-loader')) {
        const versionData = JSON.parse(await fs.readFile(jsonFile, 'utf-8'));
        const inheritsFrom = versionData.inheritsFrom;
        if (inheritsFrom) {
          return await this.isVersionInstalled(inheritsFrom);
        }
      } else {
        await fs.access(jarFile);
      }
      
      return true;
    } catch {
      return false;
    }
  }

  // ========================================================================
  // ЗАГРУЗКА ВЕРСИЙ
  // ========================================================================

  async downloadVersion(version, onProgress) {
    const versionData = await this.getVersionData(version);
    const versionDir = path.join(this.gameDir, 'versions', version.id);
    const librariesDir = path.join(this.gameDir, 'libraries');
    const assetsDir = path.join(this.gameDir, 'assets');
    const nativesDir = path.join(versionDir, 'natives');

    // Создаём директории
    await fs.mkdir(versionDir, { recursive: true });
    await fs.mkdir(librariesDir, { recursive: true });
    await fs.mkdir(assetsDir, { recursive: true });
    await fs.mkdir(nativesDir, { recursive: true });

    // Сохраняем JSON версии
    await fs.writeFile(
      path.join(versionDir, `${version.id}.json`),
      JSON.stringify(versionData, null, 2)
    );

    let totalProgress = 0;
    const updateProgress = (status, progress) => {
      if (onProgress) {
        onProgress({ status, progress: totalProgress + progress });
      }
    };

    // 1. Скачиваем клиент (15%)
    updateProgress('Загрузка клиента...', 0);
    const clientUrl = versionData.downloads.client.url;
    const clientFile = path.join(versionDir, `${version.id}.jar`);
    if (!fsSync.existsSync(clientFile)) {
      await this.downloadFile(clientUrl, clientFile, (p) => {
        updateProgress('Загрузка клиента...', p * 0.15);
      });
    }
    totalProgress = 0.15;

    // 2. Скачиваем библиотеки (55%)
    updateProgress('Загрузка библиотек...', 0);
    const libraries = versionData.libraries.filter(lib => this.checkLibraryRules(lib));
    await this.downloadLibraries(libraries, librariesDir, nativesDir, (p) => {
      updateProgress('Загрузка библиотек...', p * 0.55);
    });
    totalProgress = 0.70;

    // 3. Скачиваем ресурсы (30%)
    updateProgress('Загрузка ресурсов...', 0);
    await this.downloadAssets(versionData, assetsDir, (p) => {
      updateProgress('Загрузка ресурсов...', p * 0.30);
    });
    totalProgress = 1.0;

    updateProgress('Готово!', 1.0);
  }

  async downloadFile(url, destPath, onProgress) {
    const response = await axios.get(url, {
      responseType: 'stream',
    });

    const totalLength = response.headers['content-length'];
    let downloadedLength = 0;

    await fs.mkdir(path.dirname(destPath), { recursive: true });
    const writer = fsSync.createWriteStream(destPath);

    response.data.on('data', (chunk) => {
      downloadedLength += chunk.length;
      if (onProgress && totalLength) {
        onProgress(downloadedLength / totalLength);
      }
    });

    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  }

  checkLibraryRules(library) {
    const rules = library.rules;
    if (!rules) return true;

    let allowed = false;
    for (const rule of rules) {
      const action = rule.action;
      const os = rule.os;

      if (!os) {
        allowed = action === 'allow';
      } else if (os.name === 'windows') {
        allowed = action === 'allow';
      }
    }
    return allowed;
  }

  async downloadLibraries(libraries, librariesDir, nativesDir, onProgress) {
    const total = libraries.length;
    let completed = 0;

    for (const lib of libraries) {
      try {
        const downloads = lib.downloads;

        if (downloads && downloads.artifact) {
          const artifact = downloads.artifact;
          const libPath = artifact.path.replace(/\//g, path.sep);
          const filePath = path.join(librariesDir, libPath);

          if (!fsSync.existsSync(filePath)) {
            await this.downloadFile(artifact.url, filePath);
          }
        }

        // Natives
        if (downloads && downloads.classifiers && lib.natives) {
          const nativeKey = lib.natives.windows?.replace('${arch}', '64') || 'natives-windows';
          const nativeArtifact = downloads.classifiers[nativeKey];

          if (nativeArtifact) {
            const nativePath = path.join(nativesDir, path.basename(nativeArtifact.path));
            if (!fsSync.existsSync(nativePath)) {
              await this.downloadFile(nativeArtifact.url, nativePath);
              await this.extractNatives(nativePath, nativesDir);
            }
          }
        }

        completed++;
        if (onProgress) {
          onProgress(completed / total);
        }
      } catch (error) {
        console.warn(`Failed to download library ${lib.name}:`, error.message);
      }
    }
  }

  async extractNatives(zipPath, destDir) {
    try {
      const zip = new AdmZip(zipPath);
      const entries = zip.getEntries();

      for (const entry of entries) {
        const name = entry.entryName.toLowerCase();
        if (name.endsWith('.dll') || name.endsWith('.so') || name.endsWith('.dylib')) {
          const fileName = path.basename(entry.entryName);
          zip.extractEntryTo(entry, destDir, false, true, false, fileName);
        }
      }
    } catch (error) {
      console.error('Failed to extract natives:', error);
    }
  }

  async downloadAssets(versionData, assetsDir, onProgress) {
    const assetIndex = versionData.assetIndex;
    const indexDir = path.join(assetsDir, 'indexes');
    const objectsDir = path.join(assetsDir, 'objects');

    await fs.mkdir(indexDir, { recursive: true });
    await fs.mkdir(objectsDir, { recursive: true });

    const indexPath = path.join(indexDir, `${assetIndex.id}.json`);

    let indexData;
    if (fsSync.existsSync(indexPath)) {
      indexData = JSON.parse(await fs.readFile(indexPath, 'utf-8'));
    } else {
      const response = await axios.get(assetIndex.url);
      indexData = response.data;
      await fs.writeFile(indexPath, JSON.stringify(indexData, null, 2));
    }

    const objects = Object.entries(indexData.objects);
    const total = objects.length;
    let completed = 0;

    // Скачиваем ассеты пакетами
    const batchSize = 30;
    for (let i = 0; i < objects.length; i += batchSize) {
      const batch = objects.slice(i, i + batchSize);
      
      await Promise.all(
        batch.map(async ([name, asset]) => {
          const hash = asset.hash;
          const prefix = hash.substring(0, 2);
          const assetPath = path.join(objectsDir, prefix, hash);

          if (!fsSync.existsSync(assetPath)) {
            const url = `${this.resourcesUrl}/${prefix}/${hash}`;
            await this.downloadFile(url, assetPath);
          }
        })
      );

      completed = Math.min(i + batchSize, total);
      if (onProgress) {
        onProgress(completed / total);
      }
    }
  }

  // ========================================================================
  // FABRIC LOADER
  // ========================================================================

  async installFabric(mcVersion, onProgress) {
    try {
      // Получаем последнюю версию Fabric loader
      const loaderVersions = await axios.get(`${this.fabricMetaUrl}/versions/loader`);
      const stableLoader = loaderVersions.data.find(v => v.stable);
      
      if (!stableLoader) {
        throw new Error('No stable Fabric loader found');
      }

      const fabricId = `fabric-loader-${stableLoader.version}-${mcVersion}`;
      
      if (onProgress) onProgress({ status: 'Загрузка Fabric профиля...', progress: 0.1 });

      // Загружаем профиль Fabric
      const profileUrl = `${this.fabricMetaUrl}/versions/loader/${mcVersion}/${stableLoader.version}/profile/json`;
      const profileResponse = await axios.get(profileUrl);
      const profileData = profileResponse.data;

      const versionDir = path.join(this.gameDir, 'versions', fabricId);
      await fs.mkdir(versionDir, { recursive: true });

      // Сохраняем JSON профиля
      await fs.writeFile(
        path.join(versionDir, `${fabricId}.json`),
        JSON.stringify(profileData, null, 2)
      );

      if (onProgress) onProgress({ status: 'Проверка базовой версии...', progress: 0.2 });

      // Проверяем базовую версию
      const inheritsFrom = profileData.inheritsFrom;
      if (inheritsFrom) {
        const baseInstalled = await this.isVersionInstalled(inheritsFrom);
        if (!baseInstalled) {
          // Скачиваем базовую версию
          const manifest = await this.fetchVersionManifest();
          const baseVersion = manifest.versions.find(v => v.id === inheritsFrom);
          if (baseVersion) {
            if (onProgress) onProgress({ status: `Загрузка базовой версии ${inheritsFrom}...`, progress: 0.3 });
            await this.downloadVersion(baseVersion, (p) => {
              if (onProgress) onProgress({ status: `Загрузка базовой версии ${inheritsFrom}...`, progress: 0.3 + p.progress * 0.4 });
            });
          }
        }
      }

      if (onProgress) onProgress({ status: 'Загрузка библиотек Fabric...', progress: 0.7 });

      // Загружаем библиотеки Fabric
      const libraries = profileData.libraries || [];
      const librariesDir = path.join(this.gameDir, 'libraries');
      await this.downloadLibraries(libraries, librariesDir, path.join(versionDir, 'natives'));

      if (onProgress) onProgress({ status: 'Fabric установлен!', progress: 1.0 });

      return fabricId;
    } catch (error) {
      console.error('Failed to install Fabric:', error);
      throw error;
    }
  }

  async getFabricVersions() {
    try {
      const response = await axios.get(`${this.fabricMetaUrl}/versions/game`);
      return response.data.map(v => v.version);
    } catch (error) {
      console.error('Failed to fetch Fabric versions:', error);
      return [];
    }
  }

  // ========================================================================
  // ЗАПУСК ИГРЫ
  // ========================================================================

  async launchGame(versionId, account, settings = {}) {
    try {
      console.log('Launching Minecraft:', versionId);

      const versionDir = path.join(this.gameDir, 'versions', versionId);
      const versionJsonPath = path.join(versionDir, `${versionId}.json`);
      
      // Читаем данные версии
      const versionData = JSON.parse(await fs.readFile(versionJsonPath, 'utf-8'));

      // Для Fabric версий объединяем с базовой версией
      const resolvedVersion = await this.resolveVersion(versionData);

      // Строим classpath
      const classpath = await this.buildClasspath(resolvedVersion, versionDir);

      // Строим аргументы
      const args = await this.buildArguments(
        resolvedVersion,
        versionDir,
        classpath,
        account,
        settings
      );

      // Путь к Java
      const javaPath = settings.javaPath || 'javaw';

      console.log('Java path:', javaPath);
      console.log('Arguments:', args.length);

      // Запускаем процесс
      this.gameProcess = spawn(javaPath, args, {
        cwd: this.gameDir,
        detached: false,
      });

      this.gameProcess.stdout.on('data', (data) => {
        console.log('[Minecraft]:', data.toString());
      });

      this.gameProcess.stderr.on('data', (data) => {
        console.error('[Minecraft Error]:', data.toString());
      });

      return new Promise((resolve, reject) => {
        this.gameProcess.on('exit', (code) => {
          console.log('Minecraft exited with code:', code);
          this.gameProcess = null;
          resolve(code);
        });

        this.gameProcess.on('error', (error) => {
          console.error('Failed to start Minecraft:', error);
          this.gameProcess = null;
          reject(error);
        });
      });
    } catch (error) {
      console.error('Launch failed:', error);
      throw error;
    }
  }

  async resolveVersion(versionData) {
    // Если версия наследуется от другой (Fabric)
    if (versionData.inheritsFrom) {
      const basePath = path.join(this.gameDir, 'versions', versionData.inheritsFrom, `${versionData.inheritsFrom}.json`);
      const baseData = JSON.parse(await fs.readFile(basePath, 'utf-8'));
      
      // Объединяем данные
      return {
        id: versionData.id,
        mainClass: versionData.mainClass || baseData.mainClass,
        arguments: this.mergeArguments(baseData.arguments, versionData.arguments),
        libraries: [...(baseData.libraries || []), ...(versionData.libraries || [])],
        assetIndex: versionData.assetIndex || baseData.assetIndex,
        assets: versionData.assets || baseData.assets,
        minecraftArguments: versionData.minecraftArguments || baseData.minecraftArguments,
      };
    }

    return versionData;
  }

  mergeArguments(base, child) {
    if (!base && !child) return {};
    if (!base) return child;
    if (!child) return base;

    const merged = { ...base };
    for (const key in child) {
      if (Array.isArray(child[key]) && Array.isArray(base[key])) {
        merged[key] = [...base[key], ...child[key]];
      } else {
        merged[key] = child[key];
      }
    }
    return merged;
  }

  async buildClasspath(versionData, versionDir) {
    const paths = [];
    const librariesDir = path.join(this.gameDir, 'libraries');

    for (const lib of versionData.libraries) {
      if (!this.checkLibraryRules(lib)) continue;

      if (lib.downloads && lib.downloads.artifact) {
        const libPath = lib.downloads.artifact.path.replace(/\//g, path.sep);
        const filePath = path.join(librariesDir, libPath);
        if (fsSync.existsSync(filePath)) {
          paths.push(filePath);
        }
      }
    }

    // Добавляем главный jar
    if (versionData.id.includes('fabric-loader')) {
      // Для Fabric используем базовую версию
      const baseVersion = versionData.id.split('-').pop();
      const baseJar = path.join(this.gameDir, 'versions', baseVersion, `${baseVersion}.jar`);
      if (fsSync.existsSync(baseJar)) {
        paths.push(baseJar);
      }
    } else {
      paths.push(path.join(versionDir, `${versionData.id}.jar`));
    }

    return paths.join(';');
  }

  async buildArguments(versionData, versionDir, classpath, account, settings) {
    const args = [];
    const nativesPath = path.join(versionDir, 'natives');
    const assetsPath = path.join(this.gameDir, 'assets');

    // JVM аргументы
    const ramMb = settings.ramMb || 4096;
    const minRamMb = settings.minRamMb || Math.floor(ramMb / 2);

    args.push(
      `-Xms${minRamMb}M`,
      `-Xmx${ramMb}M`,
      '-XX:+UnlockExperimentalVMOptions',
      '-XX:+UseG1GC',
      '-XX:G1NewSizePercent=20',
      '-XX:G1ReservePercent=20',
      '-XX:MaxGCPauseMillis=50',
      '-XX:G1HeapRegionSize=32M',
      `-Djava.library.path=${nativesPath}`,
      '-Dminecraft.launcher.brand=NsLauncher',
      '-Dminecraft.launcher.version=1.0.0',
      '-cp',
      classpath,
      versionData.mainClass
    );

    // Game аргументы
    const assetIndex = versionData.assetIndex?.id || versionData.assets || 'legacy';

    if (versionData.arguments && versionData.arguments.game) {
      args.push(
        '--username', account.username,
        '--version', versionData.id,
        '--gameDir', this.gameDir,
        '--assetsDir', assetsPath,
        '--assetIndex', assetIndex,
        '--uuid', account.uuid,
        '--accessToken', account.accessToken || '0',
        '--userType', account.type || 'legacy',
        '--versionType', 'release'
      );

      if (settings.fullscreen) {
        args.push('--fullscreen');
      } else {
        args.push(
          '--width', String(settings.windowWidth || 1280),
          '--height', String(settings.windowHeight || 720)
        );
      }
    } else if (versionData.minecraftArguments) {
      // Старый формат аргументов
      let processed = versionData.minecraftArguments
        .replace('${auth_player_name}', account.username)
        .replace('${version_name}', versionData.id)
        .replace('${game_directory}', this.gameDir)
        .replace('${assets_root}', assetsPath)
        .replace('${assets_index_name}', assetIndex)
        .replace('${auth_uuid}', account.uuid)
        .replace('${auth_access_token}', account.accessToken || '0')
        .replace('${user_type}', account.type || 'legacy')
        .replace('${version_type}', 'release');

      args.push(...processed.split(' '));

      if (settings.fullscreen) {
        args.push('--fullscreen');
      } else {
        args.push(
          '--width', String(settings.windowWidth || 1280),
          '--height', String(settings.windowHeight || 720)
        );
      }
    }

    return args;
  }

  isGameRunning() {
    return this.gameProcess !== null;
  }

  killGame() {
    if (this.gameProcess) {
      this.gameProcess.kill();
      this.gameProcess = null;
    }
  }
}

module.exports = MinecraftLauncher;
