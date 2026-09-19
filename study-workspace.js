/* 同一本读本的题库版本与学习记录隔离；同步 localStorage，不含 API 配置。 */
(function (root) {
  'use strict';

  const Store = typeof module !== 'undefined' && module.exports
    ? require('./study-store.js') : root.ZhixuStore;
  const MANIFEST_KEY = 'zhixu-library-versions-v1';
  const LEGACY_LIBRARY_KEY = 'zhixu-tcm-library-v1';
  const DEFAULT_ID = 'default';
  // 包含不可删除的默认版本，最多保存 19 个修改版本。
  const MAX_VERSIONS = 20;
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  let sequence = 0;

  function invalid(message) { throw new TypeError(message); }

  function plainObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label}必须为 JSON 对象。`);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && Object.getPrototypeOf(prototype) !== null) invalid(`${label}不能带自定义原型。`);
    return value;
  }

  function exactFields(value, keys, label) {
    plainObject(value, label);
    if (Object.keys(value).length !== keys.length || keys.some(key => !own(value, key))) {
      invalid(`${label}结构损坏或包含未知字段，已阻止覆盖；请先备份原存储。`);
    }
  }

  function versionId(value) {
    if (typeof value !== 'string' || value.length > 80 ||
        (value !== DEFAULT_ID && !/^v-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value))) {
      invalid('版本 ID 无效。');
    }
    return value;
  }

  function versionName(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 80 || /[\u0000-\u001f\u007f]/.test(value)) {
      invalid('版本名称必须为非空字符串，最多 80 个字符，且不能包含控制字符。');
    }
    return value.trim();
  }

  function parseJSON(raw, label) {
    try { return JSON.parse(raw); }
    catch (error) { throw new TypeError(`${label}不是有效 JSON，已阻止覆盖；请先备份原存储。`, { cause: error }); }
  }

  // validateLibrary 已完成白名单校验；只去掉能由 baseline 还原的整本/逐题原文。
  function compact(library) {
    const { sourceText, ...saved } = library;
    saved.banks = library.banks.map(bank => ({ ...bank,
      questions: bank.questions.map(question => {
        // 内置题 raw 从 baseline 恢复；自定义题 raw 没有原始基准，必须原样保存。
        if (question.id.startsWith('q-custom-')) return { ...question };
        const { raw, ...fields } = question;
        return fields;
      })
    }));
    return saved;
  }

  /** baseline 是已由 Store.validateLibrary 校验的内置用户修订版。
   * 清单同时保存所有压缩题库，使更新/切换只需一次原子的 setItem。
   * 学习状态仍由应用校验、保存；这里仅检查 JSON 对象及可选的 libraryId。
   */
  function createRepository(storage, baseline) {
    if (!Store || typeof Store.validateLibrary !== 'function') invalid('请先加载 study-store.js。');
    if (!storage || ['getItem', 'setItem', 'removeItem'].some(key => typeof storage[key] !== 'function')) {
      invalid('storage 必须提供同步 getItem、setItem 和 removeItem。');
    }
    // 保存独立副本；外部修改 baseline 或 load() 的返回值均不能改变默认版本。
    const original = Store.validateLibrary(baseline, baseline);
    const studyPrefix = `zhixu-study-v3-${encodeURIComponent(original.id)}:`;
    const draftPrefix = `zhixu-library-draft-v1-${encodeURIComponent(original.id)}:`;
    // 保存首次成功读取的原值；后续读取不能静默接受其他页面对草稿的修改。
    const draftRaws = new Map();
    let manifest;
    let manifestRaw = read(MANIFEST_KEY);

    function read(key) {
      const value = storage.getItem(key); // 读取失败必须上抛，不能当成空存储。
      if (value !== null && typeof value !== 'string') invalid('storage.getItem 必须返回字符串或 null。');
      return value;
    }

    function keyFor(id) { return `${studyPrefix}${versionId(id)}`; }
    function draftKeyFor(id) { return `${draftPrefix}${versionId(id)}`; }

    function readDraft(id) {
      const raw = read(draftKeyFor(id));
      if (draftRaws.has(id) && draftRaws.get(id) !== raw) {
        throw new Error('当前版本草稿已被其他页面更改或损坏，本次操作未保存；请重新载入后重试。');
      }
      let library = null;
      if (raw !== null) {
        const value = parseJSON(raw, '版本草稿');
        exactFields(value, ['version', 'libraryId', 'versionId', 'library'], '版本草稿');
        if (value.version !== 1 || value.libraryId !== original.id || value.versionId !== id) {
          invalid('版本草稿格式、读本或版本 ID 不匹配，已阻止覆盖。');
        }
        library = Store.validateLibrary(value.library, original);
      }
      // 读取或校验失败不会更新观察值，也不会触碰持久化存储。
      draftRaws.set(id, raw);
      return library;
    }

    function loadSaved(id) {
      const entry = find(id);
      return Store.validateLibrary(entry ? entry.library : original, original);
    }

    function load(id) {
      find(id);
      return readDraft(id) || loadSaved(id);
    }

    function studyJSON(raw, label) {
      const value = plainObject(parseJSON(raw, label), label);
      if (own(value, 'libraryId') && value.libraryId !== original.id) invalid(`${label}不属于当前内置题库。`);
      return raw; // 原样复制，保留应用管理的所有学习字段。
    }

    function serializeStudy(value) {
      plainObject(value, '学习记录');
      const raw = JSON.stringify(value);
      if (typeof raw !== 'string') invalid('学习记录必须可以序列化为 JSON 对象。');
      return studyJSON(raw, '学习记录');
    }

    function validateManifest(value) {
      exactFields(value, ['version', 'libraryId', 'activeId', 'versions'], '版本清单');
      if (value.version !== 1 || value.libraryId !== original.id) invalid('版本清单格式或读本 ID 不匹配，已阻止覆盖。');
      versionId(value.activeId);
      if (!Array.isArray(value.versions) || value.versions.length >= MAX_VERSIONS) {
        invalid(`版本清单损坏：版本总数最多 ${MAX_VERSIONS} 个（含默认版本）。`);
      }
      const ids = new Set([DEFAULT_ID]);
      const versions = value.versions.map(entry => {
        exactFields(entry, ['id', 'name', 'library'], '版本记录');
        const id = versionId(entry.id);
        if (ids.has(id)) invalid('版本清单包含默认版本数据或重复 ID，已阻止覆盖。');
        ids.add(id);
        const name = versionName(entry.name);
        // 包括非当前版本：任何一份题库缺失或损坏都不能被静默丢弃。
        const library = compact(Store.validateLibrary(entry.library, original));
        return { id, name, library };
      });
      if (!ids.has(value.activeId)) invalid('版本清单的当前版本不存在，已阻止覆盖。');
      return { version: 1, libraryId: original.id, activeId: value.activeId, versions };
    }

    function assertUnchanged() {
      if (read(MANIFEST_KEY) !== manifestRaw) {
        throw new Error('版本清单已被其他页面更改或损坏，本次操作未保存；请重新载入后重试。');
      }
    }

    // localStorage 的单次 setItem 失败不改变旧值。先写新学习记录，最后提交清单。
    // 这里只会创建空闲 key，回滚永远不删除已有学习记录或旧版迁移副本。
    function commit(next, study) {
      const serialized = JSON.stringify(next);
      assertUnchanged();
      let createdKey = null;
      try {
        if (study) {
          const previous = read(study.key);
          if (previous !== null && previous !== study.raw) {
            throw new Error('目标版本已有学习记录，已阻止覆盖；请先备份原存储。');
          }
          if (previous === null) {
            storage.setItem(study.key, study.raw);
            createdKey = study.key;
          }
          assertUnchanged();
        }
        storage.setItem(MANIFEST_KEY, serialized);
      } catch (error) {
        if (createdKey !== null) {
          try {
            // 其他页面可能已更新刚创建的 key；失败回滚只能删除本次写入的原值。
            if (read(createdKey) === study.raw) storage.removeItem(createdKey);
          }
          catch (cleanupError) {
            throw new Error(`保存失败，且未提交的新学习记录清理失败；当前版本未改变。${error.message}`, { cause: cleanupError });
          }
        }
        throw error;
      }
      manifestRaw = serialized;
      manifest = next;
    }

    function newId() {
      for (let attempt = 0; attempt < 32; attempt++) {
        const crypto = root.crypto;
        let token;
        if (crypto && typeof crypto.randomUUID === 'function') token = crypto.randomUUID();
        else {
          const random = crypto && typeof crypto.getRandomValues === 'function'
            ? Array.from(crypto.getRandomValues(new Uint32Array(3)), part => part.toString(36)).join('-')
            : `${Math.floor(Math.random() * 0x100000000).toString(36)}-${Math.floor(Math.random() * 0x100000000).toString(36)}`;
          token = `${Date.now().toString(36)}-${(++sequence).toString(36)}-${random}`;
        }
        const id = versionId(`v-${token}`);
        // 失败清理后残留的学习记录也不能被下一次导入覆盖。
        if (!manifest.versions.some(entry => entry.id === id) && read(keyFor(id)) === null && read(draftKeyFor(id)) === null) return id;
      }
      throw new Error('无法生成未使用的安全版本 ID，本次操作未保存；请重试。');
    }

    function find(id) {
      versionId(id);
      const entry = manifest.versions.find(item => item.id === id);
      if (id !== DEFAULT_ID && !entry) invalid('指定的题库版本不存在。');
      return entry;
    }

    function ensureCapacity() {
      if (manifest.versions.length + 1 >= MAX_VERSIONS) {
        throw new Error(`最多保存 ${MAX_VERSIONS} 个版本（含默认版本）；请先删除不需要的修改版本，再导入或修改默认版本。`);
      }
    }

    function addValidated(name, library, studyRaw) {
      ensureCapacity();
      const id = newId();
      const next = { ...manifest, activeId: id, versions: [...manifest.versions, { id, name, library: compact(library) }] };
      commit(next, studyRaw === undefined ? undefined : { key: keyFor(id), raw: studyRaw });
      draftRaws.set(id, null);
      return id;
    }

    if (manifestRaw !== null) {
      manifest = validateManifest(parseJSON(manifestRaw, '版本清单'));
      readDraft(manifest.activeId);
    } else {
      // 仅以清单不存在判断首次迁移。旧 key 永不删除，也不在以后重复读取。
      const legacyLibrary = read(LEGACY_LIBRARY_KEY);
      const legacyStudy = read(`zhixu-study-v2-${original.id}`);
      const migratedLibrary = legacyLibrary === null ? null
        : Store.validateLibrary(parseJSON(legacyLibrary, '旧题库'), original);
      const migratedStudy = legacyStudy === null ? undefined : studyJSON(legacyStudy, '旧学习记录');
      manifest = { version: 1, libraryId: original.id, activeId: DEFAULT_ID, versions: [] };
      if (migratedLibrary) addValidated('迁移的本地修改', migratedLibrary, migratedStudy);
      else {
        readDraft(DEFAULT_ID);
        commit(manifest, migratedStudy === undefined ? undefined : { key: keyFor(DEFAULT_ID), raw: migratedStudy });
      }
    }

    return Object.freeze({
      list() {
        return [{ id: DEFAULT_ID, name: '默认原题' }, ...manifest.versions.map(({ id, name }) => ({ id, name }))];
      },
      get activeId() { return manifest.activeId; },
      load(id = manifest.activeId) { return load(id); },
      loadSaved(id = manifest.activeId) { return loadSaved(id); },
      hasDraft(id = manifest.activeId) {
        find(id);
        return readDraft(id) !== null;
      },
      draftKey(id = manifest.activeId) {
        find(id);
        return draftKeyFor(id);
      },
      // 草稿是本地自动续存的工作副本，不是命名快照；切走、重开后仍保留。
      // default 同样可有草稿；loadSaved('default') 始终返回独立的默认原题。
      saveDraft(library, study, expectedStudyRaw) {
        const validated = Store.validateLibrary(library, original);
        const id = manifest.activeId;
        const serialized = JSON.stringify({ version: 1, libraryId: original.id, versionId: id, library: compact(validated) });
        const nextStudy = study === undefined ? undefined : serializeStudy(study);
        assertUnchanged();
        readDraft(id);
        assertUnchanged();
        const studyKey = keyFor(id);
        // 删除先清理相关进度，再提交题库，避免重开时引用已不存在的题。
        // 比较原值以保护其他页面；题库写入失败时仅回滚本次写入。
        if (nextStudy !== undefined && read(studyKey) !== expectedStudyRaw) throw new Error('学习记录已被其他页面更改，删除未保存，请刷新后重试。');
        let wroteStudy = false;
        try {
          if (nextStudy !== undefined) { storage.setItem(studyKey, nextStudy); wroteStudy = true; }
          assertUnchanged();
          readDraft(id);
          assertUnchanged();
          if (nextStudy !== undefined && read(studyKey) !== nextStudy) throw new Error('学习记录在保存期间被其他页面更新，删除未提交，请刷新后重试。');
          storage.setItem(draftKeyFor(id), serialized);
        } catch (error) {
          if (wroteStudy) {
            try {
              if (read(studyKey) === nextStudy) {
                if (expectedStudyRaw === null) storage.removeItem(studyKey);
                else storage.setItem(studyKey, expectedStudyRaw);
              }
            } catch (rollbackError) { throw new Error('题库未删除，但学习记录回滚失败，请先导出恢复副本再刷新。', { cause: rollbackError }); }
          }
          throw error;
        }
        draftRaws.set(id, serialized);
        return id;
      },
      select(id) {
        assertUnchanged();
        const library = load(id); // 切换前验证目标版本自己的草稿，失败保持原选择。
        if (manifest.activeId !== id) commit({ ...manifest, activeId: id });
        return library;
      },
      rename(id, name) {
        find(id);
        if (id === DEFAULT_ID) invalid('默认版本不可改名。');
        const normalizedName = versionName(name);
        commit({ ...manifest, versions: manifest.versions.map(entry => entry.id === id ? { ...entry, name: normalizedName } : entry) });
        return id;
      },
      // 手动保存并激活新的命名快照；题库由 Store.snapshotLibrary 选择内容/解析，
      // 仅显式传入 study 时复制进度，省略则新版本从无进度开始；源草稿不删除。
      add(name, library, study) {
        const normalizedName = versionName(name);
        const validated = Store.validateLibrary(library, original);
        return addValidated(normalizedName, validated, study === undefined ? undefined : serializeStudy(study));
      },
      // 仅兼容旧调用：会直接改快照，且 default 会自动创建“我的修改”。新 UI 必须使用 saveDraft/add。
      update(library) {
        const validated = Store.validateLibrary(library, original);
        if (manifest.activeId === DEFAULT_ID) {
          ensureCapacity();
          const raw = read(keyFor(DEFAULT_ID));
          return addValidated('我的修改', validated, raw === null ? undefined : studyJSON(raw, '默认版本学习记录'));
        }
        const id = manifest.activeId;
        commit({ ...manifest, versions: manifest.versions.map(entry => entry.id === id ? { ...entry, library: compact(validated) } : entry) });
        return id;
      },
      studyKey(id = manifest.activeId) {
        find(id);
        return keyFor(id);
      },
      remove(id) {
        find(id);
        if (id === DEFAULT_ID) invalid('默认版本不可删除。');
        readDraft(id); // 已观察的草稿若被其他实例更新，则拒绝删除。
        if (manifest.activeId === id) readDraft(DEFAULT_ID);
        commit({ ...manifest, activeId: manifest.activeId === id ? DEFAULT_ID : manifest.activeId,
          versions: manifest.versions.filter(entry => entry.id !== id) });
        // 清单提交即为删除成功；清理失败仅保留不再引用的副本，不回滚已提交清单。
        try { storage.removeItem(keyFor(id)); } catch { /* 保留副本比丢失学习记录安全。 */ }
        try { storage.removeItem(draftKeyFor(id)); } catch { /* 孤立草稿仍受新 ID 碰撞检查保护。 */ }
        draftRaws.delete(id);
      }
    });
  }

  const api = Object.freeze({ createRepository });
  root.ZhixuWorkspace = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);