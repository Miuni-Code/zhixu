(() => {
  'use strict';

  const Core = window.ZhixuCore;
  const Store = window.ZhixuStore;
  const API = window.ZhixuAPI;
  const LIBRARY_KEY = 'zhixu-tcm-library-v1';
  let libraryError = '';
  let preserveUnreadLibrary = false;
  let baseline = null;
  let repository = null;
  let library = loadLibrary();
  let BANKS = library?.banks ?? Core.emptyBanks();
  let QUESTIONS = flattenBanks(BANKS);
  let QUESTION_MAP = new Map(QUESTIONS.map(question => [question.id, question]));
  let STORAGE_KEY = repository?.studyKey() ?? `zhixu-study-v2-${library?.id ?? 'unloaded'}`;
  const PRESETS = [
    { id: 'forest', name: '松间绿', colors: { accent: '#3b8067', background: '#f5f6f3', surface: '#ffffff', text: '#27372f' } },
    { id: 'ocean', name: '海盐蓝', colors: { accent: '#4c759d', background: '#f3f5f8', surface: '#ffffff', text: '#2d3b4b' } },
    { id: 'clay', name: '陶土橙', colors: { accent: '#ae6d50', background: '#f8f5f0', surface: '#fffefa', text: '#49392f' } },
    { id: 'lilac', name: '暮山紫', colors: { accent: '#82729f', background: '#f6f4f8', surface: '#ffffff', text: '#3e3748' } }
  ];
  const TITLES = { dashboard: '学习工作台', banks: '分单元练习', paper: '随机组题', mistakes: '错题本', favorites: '我的收藏', stats: '学习统计' };
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const escapeHTML = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const icon = (name, className = '') => `<svg class="icon ${className}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const percent = (part, total) => total ? Math.round(part / total * 100) : 0;
  const clamp = (number, min, max) => Math.min(max, Math.max(min, number));
  const validColor = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
  const todayKey = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const STUDY_MODES = { practice: '练习模式', memorize: '背题模式', exam: '考试模式' };
  function defaultWeights(banks = BANKS) {
    const originals = banks.filter(bank => !bank.id.startsWith('u-custom-'));
    const preferred = originals.length ? originals : banks;
    const weights = banks.map(bank => preferred.includes(bank) ? Math.floor(1000 / preferred.length) / 10 : 0);
    if (preferred.length) weights[banks.indexOf(preferred.at(-1))] += Math.round((100 - weights.reduce((a, b) => a + b, 0)) * 10) / 10;
    return weights;
  }
  const answeredItems = session => session.answers.filter(answer => answer && (session.mode === 'memorize' || answer.selection.length));
  const defaultPreferences = () => ({ count: 100, weights: defaultWeights(), typeWeights: [60, 30, 10], allocationMode: 'combined', studyMode: 'practice', timerMode: 'stopwatch', minutes: 60, includeFlagged: false });
  const defaultState = (libraryId = library?.id ?? 'unloaded') => ({ version: 2, libraryId, attempts: [], favorites: [], mistakes: {}, mistakeTarget: 3, goal: 20, theme: { ...PRESETS[0].colors }, session: null, progress: {}, papers: [], preferences: defaultPreferences() });
  let storageFailed = false;
  let preserveUnreadStorage = false;
  let toastTimer;
  let currentRoute = 'dashboard';
  let category = '全部';
  let sortBy = 'recommended';
  let searchQuery = '';
  let listCategory = '全部';
  let collectionSort = 'unit';
  let paperRestartReady = false;
  let addingQuestion = null;
  const expandedUnits = new Set();
  let currentSelection = [];
  let activeStartedAt = 0;
  let questionElapsed = 0;
  let completedSession = null;
  let sessionInterval = null;
  let pendingUnit = null;
  const studySnapshots = new Map();
  let state = loadState();
  let paperDraft = { ...state.preferences, weights: [...state.preferences.weights] };

  function flattenBanks(banks) {
    return banks.flatMap(bank => bank.questions.map(question => ({ ...question,
      bankId: bank.id, bankTitle: bank.title, bankIcon: bank.icon, bankColor: bank.color, category: bank.category
    })));
  }

  function loadLibrary() {
    try {
      if (window.ZHIXU_SOURCE_TEXT) baseline = Core.parseText(window.ZHIXU_SOURCE_TEXT);
      else if (window.ZHIXU_SOURCE_BASE64) {
        const bytes = Uint8Array.from(atob(window.ZHIXU_SOURCE_BASE64), character => character.charCodeAt(0));
        baseline = Core.parseText(Core.decodeText(bytes).text);
      }
      if (baseline) baseline = Store.validateLibrary(baseline, baseline);
    } catch (error) {
      libraryError = `内置题库解析失败：${error.message}。原文文件未被修改。`;
      return null;
    }
    try {
      if (baseline) {
        repository = window.ZhixuWorkspace.createRepository(localStorage, baseline);
        return repository.load();
      }
    } catch (error) {
      preserveUnreadLibrary = true;
      libraryError = `本地版本未能载入：${error.message}。仍可临时练习默认版；原存储已保护，请先备份。`;
    }
    if (!baseline && !libraryError) libraryError = '当前安装包缺少读本正文，暂时无法练习。';
    return baseline;
  }

  function persistLibrary(next, deleting = false) {
    if (preserveUnreadLibrary) throw new Error('原题库存储读取失败，已阻止覆盖。请先导出原存储副本，再导入已核验的 JSON 备份。');
    if (!repository) throw new Error('版本存储尚未恢复，暂不能保存修改。');
    if (preserveUnreadStorage || !saveState()) throw new Error('当前学习记录未能安全保存，请先导出恢复副本。');
    const oldWeights = new Map(BANKS.map((bank, index) => [bank.id, state.preferences.weights[index]]));
    const weights = next.banks.map(bank => oldWeights.get(bank.id) ?? 0);
    let nextState;
    if (deleting) {
      const ids = new Set(next.banks.flatMap(bank => bank.questions.map(question => question.id)));
      const bankIds = new Set(next.banks.map(bank => bank.id));
      const compatible = session => session && session.ids.every(id => ids.has(id)) && (!session.key.startsWith('unit:') || bankIds.has(session.key.slice(5)));
      const copied = JSON.parse(JSON.stringify(state));
      copied.progress = Object.fromEntries(Object.entries(copied.progress).filter(([, session]) => compatible(session)));
      if (!compatible(copied.session)) copied.session = null;
      copied.preferences.weights = weights;
      nextState = normalizeState(copied, next);
      repository.saveDraft(next, nextState, studySnapshots.get(STORAGE_KEY) ?? null);
      studySnapshots.set(STORAGE_KEY, JSON.stringify(nextState));
    } else repository.saveDraft(next);
    setLibrary(next);
    if (nextState) {
      state = nextState;
      completedSession = null;
      currentSelection = [...(state.session?.answers[state.session.index]?.selection ?? state.session?.draft ?? [])];
      questionElapsed = state.session?.elapsed ?? 0; activeStartedAt = 0;
      clearInterval(sessionInterval);
      if (!state.session) $('#practice-dialog').close();
    } else state.preferences.weights = weights;
    if (Math.abs(state.preferences.weights.reduce((a, b) => a + b, 0) - 100) > .000001) state.preferences.weights = defaultWeights();
    paperDraft.weights = [...state.preferences.weights];
    saveState();
  }

  function deleteContent(kind, id) {
    const item = kind === 'bank' ? BANKS.find(bank => bank.id === id) : QUESTION_MAP.get(id);
    if (!item) return;
    const label = kind === 'bank' ? `单元“${item.title}”及其中 ${item.questions.length} 道题` : `题目“${item.text.slice(0, 70)}”`;
    if (!window.confirm(`确定删除${label}吗？默认单元和原题也允许删除，仅影响当前版本。`)) return;
    if (!window.confirm('请再次确认删除：相关作答、错题和收藏将移除，包含这些题目的练习进度将清除，未交卷考试不会结算。其他题目的成绩、其他入口与版本保留。建议先导出备份。')) return;
    try {
      parkSession();
      const next = kind === 'bank' ? Store.removeBank(library, id, baseline) : Store.removeQuestion(library, id, baseline);
      persistLibrary(next, true);
      expandedUnits.delete(id);
      $('#editor-dialog').close();
      renderPage();
      if (state.session) renderPractice();
      showToast('已删除并保存到当前版本的工作草稿。保存版本或导出时勾选题库内容可保留删除结果。');
    } catch (error) { showToast(error.message, 'help'); }
  }

  function renameBank(id) {
    const bank = BANKS.find(item => item.id === id);
    if (!bank) return;
    const title = window.prompt('修改单元名称（默认与自定义单元均可修改）', bank.title);
    if (title === null) return;
    try { persistLibrary(Store.renameBank(library, id, title, baseline)); renderPage(); showToast('单元名称已保存。'); }
    catch (error) { showToast(error.message, 'help'); }
  }

  function replaceQuestion(question, allowMemory = false) {
    const next = { ...library, banks: BANKS.map(bank => ({ ...bank,
      questions: bank.questions.map(item => item.id === question.id ? question : item) })) };
    const validated = Store.validateLibrary(next, baseline);
    try { persistLibrary(validated); return true; }
    catch (error) {
      if (!allowMemory || preserveUnreadLibrary) throw error;
      setLibrary(validated);
      return false;
    }
  }

  function setLibrary(next) {
    library = next;
    BANKS = next.banks;
    QUESTIONS = flattenBanks(BANKS);
    QUESTION_MAP = new Map(QUESTIONS.map(question => [question.id, question]));
    STORAGE_KEY = repository?.studyKey() ?? `zhixu-study-v2-${library.id}`;
    libraryError = '';
  }

  function validSelection(selection, question, allowEmpty = false) {
    return Array.isArray(selection) && (selection.length > 0 || allowEmpty) && selection.length <= question.options.length &&
      new Set(selection).size === selection.length && selection.every(item => Number.isInteger(item) && item >= 0 && item < question.options.length) &&
      (question.type === 'multiple' || selection.length <= 1);
  }

  function isCorrect(question, selection) {
    if (question.flags.length) return null;
    return selection.length === question.answer.length && question.answer.every(answer => selection.includes(answer));
  }

  function normalizeState(raw, expectedLibrary = library) {
    const expectedId = expectedLibrary?.id ?? 'unloaded';
    if (!raw || raw.version !== 2 || raw.libraryId !== expectedId || !Array.isArray(raw.attempts) || !Array.isArray(raw.favorites)) {
      throw new Error('备份格式或题库版本不匹配。旧示例题记录不能对应到大赛题库。');
    }
    const map = new Map(flattenBanks(expectedLibrary?.banks ?? []).map(question => [question.id, question]));
    const clean = defaultState(expectedId);
    clean.preferences.weights = defaultWeights(expectedLibrary?.banks ?? BANKS);
    const cleanAnswer = answer => ({ questionId: answer.questionId, selection: [...answer.selection],
      correct: [true, false, null].includes(answer.correct) ? answer.correct : isCorrect(map.get(answer.questionId), answer.selection), seconds: clamp(answer.seconds, 0, 86400) });
    const validAnswer = answer => {
      const question = map.get(answer?.questionId);
      return question && Array.isArray(answer.selection) && answer.selection.length <= 8 &&
        answer.selection.every(index => Number.isInteger(index) && index >= 0 && index < 8) &&
        new Set(answer.selection).size === answer.selection.length && Number.isFinite(answer.seconds) && answer.seconds >= 0;
    };
    clean.mistakeTarget = Number.isInteger(raw.mistakeTarget) ? clamp(raw.mistakeTarget, 1, 100) : 3;
    if (raw.mistakes && typeof raw.mistakes === 'object' && !Array.isArray(raw.mistakes)) {
      for (const [id, entry] of Object.entries(raw.mistakes)) {
        if (map.has(id) && Number.isInteger(entry?.correctCount) && entry.correctCount >= 0 && entry.correctCount <= 99)
          clean.mistakes[id] = { correctCount: entry.correctCount };
      }
    } else {
      // 旧版只保留最后一次答错；迁移时保留当时的错题，不复活已移出的题。
      const latest = new Map();
      raw.attempts.forEach(attempt => { if (map.has(attempt?.questionId)) latest.set(attempt.questionId, attempt.correct); });
      for (const [id, correct] of latest) if (correct === false) clean.mistakes[id] = { correctCount: 0 };
    }
    clean.attempts = raw.attempts.filter(attempt => validAnswer(attempt) && Number.isFinite(attempt.at) && attempt.at > 0 && attempt.at <= Date.now() + 60000)
      .map(attempt => ({ ...cleanAnswer(attempt), at: attempt.at }));
    clean.favorites = [...new Set(raw.favorites.filter(id => map.has(id)))];
    clean.goal = Number.isFinite(raw.goal) ? clamp(Math.round(raw.goal), 5, 100) : 20;
    for (const key of Object.keys(clean.theme)) if (validColor(raw.theme?.[key])) clean.theme[key] = raw.theme[key];
    const preferences = raw.preferences;
    if (preferences && Number.isInteger(preferences.count) && preferences.count > 0 && preferences.count <= 10000 &&
      Array.isArray(preferences.weights) && preferences.weights.length <= expectedLibrary.banks.length && preferences.weights.every(value => Number.isFinite(value) && value >= 0 && value <= 100) &&
      (expectedLibrary.banks.length === 0 || Math.abs(preferences.weights.reduce((sum, value) => sum + value, 0) - 100) < .000001)) {
      clean.preferences = { ...defaultPreferences(), count: preferences.count, weights: expectedLibrary.banks.map((_, index) => preferences.weights[index] ?? 0), timerMode: ['countdown', 'none'].includes(preferences.timerMode) ? preferences.timerMode : 'stopwatch',
        studyMode: Object.hasOwn(STUDY_MODES, preferences.studyMode) ? preferences.studyMode : 'practice',
        allocationMode: ['unit', 'type', 'combined'].includes(preferences.allocationMode) ? preferences.allocationMode : 'unit',
        typeWeights: Array.isArray(preferences.typeWeights) && preferences.typeWeights.length === 3 && preferences.typeWeights.every(n => Number.isFinite(n) && n >= 0 && n <= 100) && Math.abs(preferences.typeWeights.reduce((a, b) => a + b, 0) - 100) < .000001 ? [...preferences.typeWeights] : [60, 30, 10],
        minutes: Number.isInteger(preferences.minutes) ? clamp(preferences.minutes, 1, 1440) : 60, includeFlagged: preferences.includeFlagged === true };
    }
    clean.papers = Array.isArray(raw.papers) ? raw.papers.filter(paper => paper && Number.isFinite(paper.at) && typeof paper.title === 'string' &&
      Number.isInteger(paper.total) && paper.total > 0 && Number.isInteger(paper.answered) && paper.answered >= 0 && paper.answered <= paper.total &&
      Number.isInteger(paper.correct) && paper.correct >= 0 && Number.isInteger(paper.graded) && paper.graded >= paper.correct && paper.graded <= paper.answered &&
      Number.isFinite(paper.elapsedMs) && paper.elapsedMs >= 0).slice(-100).map(paper => ({ at: paper.at, title: paper.title.slice(0, 120), total: paper.total,
        answered: paper.answered, correct: paper.correct, graded: paper.graded, elapsedMs: Math.min(paper.elapsedMs, 31536000000), reason: ['complete', 'timeout', 'finish'].includes(paper.reason) ? paper.reason : 'finish' })) : [];
    function cleanSession(session, fallbackKey = 'legacy') {
      if (!session || !Array.isArray(session.ids) || !session.ids.length || session.ids.length > 10000 ||
        !session.ids.every(id => map.has(id)) || new Set(session.ids).size !== session.ids.length ||
        !Number.isInteger(session.index) || session.index < 0 || session.index >= session.ids.length ||
        !Array.isArray(session.answers) || session.answers.length > session.ids.length ||
        !Array.from(session.answers).every((answer, index) => answer == null || answer.questionId === session.ids[index] && validAnswer(answer))) return null;
      const timer = session.timer;
      const validTimer = timer && ['none', 'stopwatch', 'countdown'].includes(timer.mode) && Number.isFinite(timer.elapsedMs) && timer.elapsedMs >= 0 &&
        (timer.runningSince === null || (Number.isFinite(timer.runningSince) && timer.runningSince > 0 && timer.runningSince <= Date.now() + 60000)) &&
        (timer.mode !== 'countdown' || (Number.isFinite(timer.limitMs) && timer.limitMs >= 60000 && timer.limitMs <= 86400000));
      const allowedKey = value => typeof value === 'string' && (['paper', 'mistakes', 'mistake-paper', 'favorites', 'daily', 'retry', 'legacy'].includes(value) || value.startsWith('unit:') && expectedLibrary.banks.some(bank => bank.id === value.slice(5)) || value.startsWith('question:') && map.has(value.slice(9)));
      const key = allowedKey(session.key) ? session.key : fallbackKey;
      const drafts = {};
      if (session.drafts && typeof session.drafts === 'object' && !Array.isArray(session.drafts)) {
        for (const [index, selection] of Object.entries(session.drafts)) {
          if (/^(0|[1-9]\d*)$/.test(index) && Number(index) < session.ids.length && validSelection(selection, map.get(session.ids[Number(index)]), true)) drafts[index] = [...selection];
        }
      }
      return {
        key, mode: Object.hasOwn(STUDY_MODES, session.mode) ? session.mode : 'practice',
        status: session.status === 'completed' ? 'completed' : 'active', reason: ['complete', 'timeout', 'finish'].includes(session.reason) ? session.reason : 'complete',
        title: typeof session.title === 'string' ? session.title.slice(0, 120) : '继续练习', ids: [...session.ids], index: session.index,
        drafts, draft: validSelection(session.draft, map.get(session.ids[session.index]), true) ? [...session.draft] : [],
        elapsed: Number.isFinite(session.elapsed) ? clamp(session.elapsed, 0, 86400000) : 0,
        answers: Array.from(session.answers, answer => answer == null ? null : { ...cleanAnswer(answer), ...(session.mode === 'exam' && session.status !== 'completed' ? { correct: null } : {}) }), timer: validTimer ? { mode: timer.mode, elapsedMs: timer.mode === 'none' ? 0 : Math.min(timer.elapsedMs, 31536000000),
          runningSince: timer.runningSince, limitMs: timer.mode === 'countdown' ? timer.limitMs : 0 } : { mode: 'stopwatch', elapsedMs: 0, runningSince: null, limitMs: 0 }
      };
    }
    if (raw.progress && typeof raw.progress === 'object' && !Array.isArray(raw.progress)) {
      for (const [key, value] of Object.entries(raw.progress).slice(0, 1200)) {
        const restored = cleanSession(value);
        if (restored && restored.key === key) {
          restored.timer = Core.pauseClock(restored.timer);
          clean.progress[key] = restored;
        }
      }
    }
    if (raw.progress && (typeof raw.progress !== 'object' || Array.isArray(raw.progress))) throw new Error('练习进度格式损坏，已阻止覆盖。');
    if (raw.progress && Object.keys(clean.progress).length !== Object.keys(raw.progress).length) throw new Error('部分练习进度无法恢复，已阻止覆盖；请保留原备份。');
    const oldSession = raw.session;
    const unitBank = oldSession && expectedLibrary?.banks.find(bank => oldSession.ids?.length === bank.questions.length && bank.questions.every(question => oldSession.ids.includes(question.id)));
    const inferredKey = unitBank ? `unit:${unitBank.id}` : oldSession?.title?.startsWith('随机组题') ? 'paper' : oldSession?.title?.startsWith('错题独立') ? 'mistake-paper' : oldSession?.title?.startsWith('错题复习') ? 'mistakes' : 'legacy';
    clean.session = cleanSession(oldSession, inferredKey);
    if (oldSession && !clean.session) throw new Error('当前练习无法恢复，已阻止覆盖原记录。');
    if (clean.session) clean.progress[clean.session.key] = clean.session;
    return clean;
  }

  function loadState() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      studySnapshots.set(STORAGE_KEY, saved);
      return saved ? normalizeState(JSON.parse(saved)) : defaultState();
    } catch {
      storageFailed = true;
      preserveUnreadStorage = true;
      return defaultState();
    }
  }

  function saveState() {
    // Preserve unreadable records until the user explicitly imports or resets data.
    if (preserveUnreadStorage || preserveUnreadLibrary) return false;
    if (state.session) state.progress[state.session.key] = state.session;
    try {
      if (localStorage.getItem(STORAGE_KEY) !== (studySnapshots.get(STORAGE_KEY) ?? null)) {
        preserveUnreadStorage = true;
        showToast('另一个页面已更新学习记录，已阻止覆盖。请导出恢复副本，再刷新载入最新记录。', 'help');
        return false;
      }
      const serialized = JSON.stringify(state);
      localStorage.setItem(STORAGE_KEY, serialized);
      studySnapshots.set(STORAGE_KEY, serialized);
      storageFailed = false;
      return true;
    } catch {
      if (!storageFailed) {
        storageFailed = true;
        showToast('本地存储不可用或已满，请及时导出学习记录。', 'help');
      }
      return false;
    }
  }

  function luminance(hex) {
    const channels = hex.slice(1).match(/.{2}/g).map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  }

  function applyTheme() {
    for (const [key, value] of Object.entries(state.theme)) document.documentElement.style.setProperty(`--${key}`, value);
    const lightness = luminance(state.theme.accent);
    document.documentElement.style.setProperty('--on-accent', lightness > .179 ? '#162b22' : '#ffffff');
    $('meta[name="theme-color"]').content = state.theme.background;
  }

  function showToast(message, name = 'check-circle') {
    const toast = $('#toast');
    clearTimeout(toastTimer);
    toast.innerHTML = `${icon(name)}<span>${escapeHTML(message)}</span>`;
    // Popover places feedback above modal dialogs in supporting browsers.
    if (typeof toast.showPopover === 'function') {
      toast.setAttribute('popover', 'manual');
      if (toast.matches(':popover-open')) toast.hidePopover();
      toast.showPopover();
    }
    toast.classList.add('visible');
    toastTimer = setTimeout(() => {
      toast.classList.remove('visible');
      if (typeof toast.hidePopover === 'function' && toast.matches(':popover-open')) toast.hidePopover();
    }, 3800);
  }

  function getStats() {
    const today = todayKey();
    const todayAttempts = state.attempts.filter(attempt => todayKey(new Date(attempt.at)) === today);
    const unique = new Set(state.attempts.map(attempt => attempt.questionId));
    const dates = new Set(state.attempts.map(attempt => todayKey(new Date(attempt.at))));
    const mistakes = Object.keys(state.mistakes).filter(id => QUESTION_MAP.has(id));
    let streak = 0;
    const day = new Date();
    if (!dates.has(todayKey(day))) day.setDate(day.getDate() - 1);
    while (dates.has(todayKey(day))) {
      streak++;
      day.setDate(day.getDate() - 1);
    }
    return {
      total: state.attempts.length,
      graded: state.attempts.filter(attempt => attempt.correct !== null).length,
      correct: state.attempts.filter(attempt => attempt.correct === true).length,
      today: todayAttempts.length,
      todayCorrect: todayAttempts.filter(attempt => attempt.correct).length,
      minutes: Math.floor(state.attempts.reduce((sum, attempt) => sum + attempt.seconds, 0) / 60),
      seconds: Math.round(state.attempts.reduce((sum, attempt) => sum + attempt.seconds, 0)),
      unique, mistakes, streak, days: dates.size
    };
  }

  function getWeek() {
    const now = new Date();
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    return Array.from({ length: 7 }, (_, index) => {
      const date = new Date(monday);
      date.setDate(date.getDate() + index);
      const key = todayKey(date);
      return { date: key, label: ['一', '二', '三', '四', '五', '六', '日'][index], today: key === todayKey(), count: state.attempts.filter(attempt => todayKey(new Date(attempt.at)) === key).length };
    });
  }

  function renderWeekChart() {
    const week = getWeek();
    const maximum = Math.max(state.goal, ...week.map(day => day.count));
    return `<div class="week-chart" role="img" aria-label="本周练习：${week.map(day => `周${day.label}${day.count}题`).join('，')}">${week.map(day => `
      <div class="chart-column ${day.today ? 'today' : ''}" title="${day.date}：${day.count} 题">
        <div class="bar-space"><div class="chart-bar" style="height:${day.count ? Math.max(6, percent(day.count, maximum)) : 0}%;${day.count ? '' : 'min-height:0'}"></div></div><span>${day.label}</span>
      </div>`).join('')}</div>`;
  }

  function renderSidebar() {
    const stats = getStats();
    $('#mistake-count').textContent = stats.mistakes.length;
    $('#sidebar-plan').innerHTML = `<div class="plan-inner">
      <div class="plan-title">${icon('target')}一点点，走得更远</div>
      <p>${stats.today >= state.goal ? '今日目标已完成，做得很棒。' : '给今天的自己，一个小目标。'}</p>
      <div class="plan-progress-row"><span>今日练习</span><span><strong>${stats.today}</strong> / ${state.goal} 题</span></div>
      <div class="progress-track" role="progressbar" aria-label="每日目标进度" aria-valuenow="${Math.min(stats.today, state.goal)}" aria-valuemin="0" aria-valuemax="${state.goal}"><span style="width:${Math.min(100, percent(stats.today, state.goal))}%"></span></div>
      <button class="plan-edit" data-action="theme">调整学习目标 ${icon('arrow')}</button></div>`;
  }

  function renderStatCards() {
    const stats = getStats();
    return `<div class="stats-grid">
      <div class="stat-card"><div class="stat-top">累计练习${statIcon('book')}</div><div class="stat-number"><strong>${stats.total.toLocaleString()}</strong><span>题</span></div><div class="stat-foot"><span class="accent">${stats.today ? `+ ${stats.today}` : '从 1 开始'}</span><span>${stats.today ? '今日完成' : '每一道题都是新的积累'}</span></div></div>
      <div class="stat-card"><div class="stat-top">答题正确率${statIcon('target')}</div><div class="stat-number"><strong>${stats.graded ? percent(stats.correct, stats.graded) : '—'}</strong><span>%</span></div><div class="stat-foot">${icon('check-circle')}<span>${stats.total ? `累计答对 ${stats.correct} 题` : '练习后生成你的正确率'}</span></div></div>
      <div class="stat-card"><div class="stat-top">累计学习${statIcon('clock')}</div><div class="stat-number"><strong>${stats.minutes}</strong><span>分钟</span></div><div class="stat-foot">${icon('leaf')}<span>${stats.seconds && !stats.minutes ? '已专注学习，不足 1 分钟' : '每一分钟，都在靠近目标'}</span></div></div>
      <div class="stat-card"><div class="stat-top">连续学习${statIcon('flame')}</div><div class="stat-number"><strong>${stats.streak}</strong><span>天</span></div><div class="stat-foot"><span class="accent">${stats.streak ? '继续保持' : '今天启程'}</span><span>${stats.streak ? '让好习惯慢慢发生' : '开启你的第一天'}</span></div></div>
    </div>`;
  }

  function statIcon(name) { return `<span class="stat-icon">${icon(name)}</span>`; }

  function heroArt() {
    return `<svg class="hero-art" viewBox="0 0 270 240" fill="none" aria-hidden="true">
      <circle cx="159" cy="117" r="81" fill="currentColor" opacity=".055"/>
      <circle cx="159" cy="117" r="104" stroke="currentColor" stroke-opacity=".12" stroke-dasharray="3 7"/>
      <path d="M35 199H241" stroke="currentColor" stroke-opacity=".13" stroke-width="1.5"/>
      <path d="M53 168H206Q215 168 215 177V190H64Q53 190 53 180Z" fill="#7c9d7a"/>
      <path d="M61 175H212V185H65Q60 185 60 180Z" fill="#f9f7ec"/>
      <path d="M67 180H203" stroke="#b8b7a1" stroke-opacity=".5"/>
      <path d="M78 143H226V167H77Q65 167 65 155Q65 143 78 143Z" fill="#c7ad7f"/>
      <path d="M80 148H219V162H81Q73 162 73 155Q73 148 80 148Z" fill="#fffbed"/>
      <path d="M82 152H207M82 157H211" stroke="#dad4bb" stroke-width="1"/>
      <path d="M119 149V172L127 167L135 172V149" fill="#a67252"/>
      <g transform="rotate(-9 137 131)"><path d="M64 118H199V141H64Q55 141 55 130Q55 118 64 118Z" fill="currentColor"/>
      <path d="M67 123H194V136H68Q61 136 61 130Q61 123 67 123Z" fill="#f8f6e8"/>
      <path d="M72 128H187M72 132H184" stroke="#cccdb5"/></g>
      <path d="M157 119C153 91 166 66 163 40" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
      <path d="M161 76C145 77 132 64 134 48C153 46 166 55 161 76Z" fill="#729476"/>
      <path d="M160 90C178 88 188 73 185 58C168 59 156 71 160 90Z" fill="currentColor"/>
      <path d="M163 55C169 45 165 34 154 27C147 39 151 50 163 55Z" fill="#a3b08a"/>
      <path d="M155 104C140 106 127 99 124 85C143 79 157 89 155 104Z" fill="#8ca07d"/>
      <path d="m163 80 12-11m-16 0-15-11m11 41-18-8" stroke="#f5f6ed" stroke-opacity=".45" stroke-width="1"/>
      <path d="m75 63 0 10m-5-5h10m132 33v8m-4-4h8" stroke="currentColor" stroke-opacity=".45" stroke-linecap="round"/>
      <circle cx="102" cy="39" r="3" fill="#c3aa76"/><circle cx="225" cy="153" r="2.5" fill="currentColor" opacity=".5"/>
      <path d="m53 105 3-4 3 4-3 4Z" fill="#c3aa76"/>
    </svg>`;
  }

  function renderResume() {
    if (!state.session) return '';
    return `<div class="resume-banner">${icon('clock')}<div><strong>上次的练习，等你继续</strong><p>${escapeHTML(state.session.title)} · 已完成 ${answeredItems(state.session).length} / ${state.session.ids.length} 题</p></div><button class="button soft" data-action="resume">继续练习${icon('arrow')}</button></div>`;
  }

  function renderDashboard() {
    const stats = getStats();
    const hour = new Date().getHours();
    const greeting = hour < 6 ? '夜深了，记得适时休息' : hour < 12 ? '早上好，新的一天也要有所收获' : hour < 18 ? '下午好，给学习留一点时间' : '晚上好，和今天的自己一起进步';
    const dateLabel = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
    const weekCount = getWeek().reduce((sum, day) => sum + day.count, 0);
    return `<div class="page-enter">
      <section class="page-heading"><div><div class="greeting">${icon('sun')}${greeting}</div><h1>让每一次练习，都有收获<span style="color:var(--accent)">。</span></h1><p class="heading-description">不必急于求成，按照自己的节奏，一点点进步。</p></div><div class="heading-action"><button class="button" data-action="random">${icon('shuffle')}随机练一练</button><div class="date-label">${icon('calendar')}${dateLabel}</div></div></section>
      ${renderLibraryNotice()}
      ${renderResume()}
      <section class="hero-grid" aria-label="每日学习">
        <div class="hero-card"><div class="hero-copy"><div class="hero-label"><span></span>YOUR DAILY GROWTH</div><h2>每一点积累，都算数。</h2><p>每天留一点时间给自己，<br>让知识生根，让进步有迹可循。</p><div class="hero-actions"><button class="button primary" data-action="daily">${stats.today ? '继续今日练习' : '开始今日练习'}${icon('arrow')}</button><span>${icon('clock')}10 道小题，保持好状态</span></div></div>${heroArt()}</div>
        <div class="week-card"><div class="card-heading"><h2>本周学习足迹</h2><span class="small-pill">本周</span></div><div class="week-summary"><strong>${weekCount}</strong><span>题</span><span class="week-hint">${weekCount ? '每一题都算数' : '从今天开始'}</span></div>${renderWeekChart()}<div class="week-footer">${icon('flame')}${stats.streak ? `已连续学习 ${stats.streak} 天，继续保持` : '第一步，就是最好的开始'}</div></div>
      </section>
      <section aria-label="学习概览">${renderStatCards()}</section>
      <section aria-labelledby="banks-title"><div class="section-heading"><h2 id="banks-title">单元练习<span class="section-subtitle">内置读本与个人自定义单元</span></h2><a class="text-button" href="#banks">全部单元${icon('arrow')}</a></div>${renderBankToolbar()}<div id="bank-results">${renderBankResults()}</div></section>
      <div class="inspiration">${icon('leaf')}学习不是一场竞赛，而是一段成为更好自己的旅程。</div>
    </div>`;
  }

  function renderBankToolbar() {
    return `<div class="bank-toolbar"><span class="result-count">内置单元保留原文顺序 · 自定义单元排列在后</span><label class="bank-filter">${icon('filter')}<select id="bank-sort" aria-label="单元排序"><option value="recommended" ${sortBy === 'recommended' ? 'selected' : ''}>原文顺序</option><option value="progress" ${sortBy === 'progress' ? 'selected' : ''}>学习进度</option><option value="unstarted" ${sortBy === 'unstarted' ? 'selected' : ''}>未学优先</option></select></label></div>`;
  }

  function filteredBanks() {
    const query = currentRoute === 'banks' ? searchQuery.trim().toLowerCase() : '';
    const done = getStats().unique;
    const progress = bank => percent(bank.questions.filter(question => done.has(question.id)).length, bank.questions.length);
    return BANKS.filter(bank => !query || [bank.title, bank.category, ...bank.questions.map(question => question.text)].join(' ').toLowerCase().includes(query))
      .sort((a, b) => sortBy === 'progress' ? progress(b) - progress(a) : sortBy === 'unstarted' ? progress(a) - progress(b) : a.unit - b.unit);
  }

  function renderBankCard(bank) {
    const completed = getStats().unique;
    const count = bank.questions.filter(question => completed.has(question.id)).length;
    const saved = state.progress[`unit:${bank.id}`];
    return `<details class="unit-card" name="units" data-bank-details="${bank.id}" ${expandedUnits.has(bank.id) ? 'open' : ''}><summary class="unit-summary"><span class="unit-number">${String(bank.unit).padStart(2, '0')}</span><span class="unit-title">${escapeHTML(bank.title)}<small>${bank.questions.length} 题 · 已练 ${count} 题${saved ? ` · ${saved.status === 'completed' ? '已完成' : `进度 ${saved.index + 1}/${saved.ids.length}`}` : ''}</small></span>${icon('chevron')}</summary>
      <div class="unit-detail"><p class="setting-note">${escapeHTML(bank.subtitle)}</p><div class="unit-actions"><button class="button primary" data-unit-continue="${bank.id}" ${bank.questions.length ? '' : 'disabled'}>${saved?.status === 'completed' ? '查看结果' : '继续刷题'}</button><button class="button" data-unit-restart="${bank.id}" ${bank.questions.length ? '' : 'disabled'}>重新开始</button><button class="button" data-add-bank-question="${bank.id}">新增题目</button><button class="button" data-rename-bank="${bank.id}">修改名称</button><button class="button warning-text" data-delete-bank="${bank.id}">删除单元</button></div></div></details>`;
  }

  function renderBankResults() {
    const banks = filteredBanks();
    return `<p class="result-count" aria-live="polite">共 ${banks.length} 个单元 · 点击标题展开</p><div class="compact-unit-grid">${banks.map(renderBankCard).join('')}<button class="add-unit-card" data-action="add-bank">＋ 增加单元</button></div>`;
  }

  function renderLibraryNotice() {
    return libraryError ? `<p class="source-warning" role="alert">${escapeHTML(libraryError)}</p>` : '';
  }

  function renderBanks() {
    return `<div class="page-enter"><section class="page-heading"><div><h1>分单元练习</h1><p class="heading-description">点击单元展开。继续刷题直接恢复进度；重新开始可调整顺序、模式和计时。</p></div></section>
      ${renderLibraryNotice()}<label class="search-field">${icon('search')}<input id="bank-search" aria-label="搜索单元或题目" value="${escapeHTML(searchQuery)}" placeholder="搜索单元名称或题目关键词…" autocomplete="off"><button class="icon-button" data-action="clear-search" aria-label="清除搜索">${icon('close', 'small-icon')}</button></label>
      ${renderBankToolbar()}<div id="bank-results">${renderBankResults()}</div></div>`;
  }

  function renderPaperPage() {
    if (!library) return renderLibraryNotice();
    const draft = paperDraft;
    return `<div class="page-enter"><section class="page-heading"><div><h1>随机组题</h1><p class="heading-description">按单元、题型或两者共同分配。题目随机，选项顺序不变。</p></div></section>
      <form id="paper-form">${choiceFields('allocation-mode', '抽取方式', [['unit', '按单元'], ['type', '按题型'], ['combined', '单元＋题型']], draft.allocationMode)}
      ${entryControls('paper', '继续进度', '重新抽取')}
      <div class="paper-ratios"><section class="panel" id="unit-weight-panel"><div class="card-heading"><h2>单元抽取比例</h2><button type="button" class="text-button" data-action="reset-weights">恢复默认</button></div><p class="setting-note">合计 100%。新增单元默认 0%，可自行调整。</p><div class="allocation-list">${BANKS.map((bank, index) => `<div class="allocation-row"><label for="weight-${index}">${escapeHTML(bank.title)}<small data-capacity="${index}"></small></label><div class="percent-input"><input id="weight-${index}" data-weight="${index}" type="number" min="0" max="100" step="0.1" value="${draft.weights[index] ?? 0}" required aria-label="${escapeHTML(bank.title)}抽题百分比"><span>%</span></div><output data-quota="${index}">— 题</output></div>`).join('')}</div><div class="allocation-total"><span>比例合计</span><strong id="weight-total">100%</strong></div></section>
      <section class="panel" id="type-weight-panel"><div class="card-heading"><h2>题型抽取比例</h2><button type="button" class="text-button" data-action="reset-type-weights">恢复默认</button></div><p class="setting-note">单选 60%、多选 30%、判断 10%，合计须为 100%。</p>${['单选', '多选', '判断'].map((label, index) => `<label class="form-field">${label}（%）<input data-type-weight="${index}" type="number" min="0" max="100" step="0.1" required value="${draft.typeWeights[index]}"></label>`).join('')}<p class="setting-note">叠加模式同时满足两组比例。库存不足时提示，不自动转移配额。</p></section></div>
      <section class="panel" id="paper-practice-settings" tabindex="-1"><h2>练习设置</h2><label class="form-field">抽题总数<input type="number" id="paper-count" min="1" max="10000" step="1" value="${draft.count}" required></label>${timerFields(draft.timerMode, draft.minutes, 'paper', draft.studyMode)}<div class="paper-preview" id="paper-preview" role="status"></div><button class="button primary full-width" id="paper-start" type="submit">生成并开始练习${icon('arrow')}</button><p class="setting-note" id="paper-restart-note">${state.progress.paper && !paperRestartReady ? '已有进度。请点击继续进度，或先点击重新抽取确认后生成新卷。' : '设置只在生成成功后用于新练习；取消设置不会重置原进度。'}</p></section></form></div>`;
  }

  function choiceFields(name, legend, choices, selected) {
    return `<fieldset class="choice-group" id="${name}-choices"><legend>${legend}</legend>${choices.map(([value, label]) => `<label><input type="radio" name="${name}" value="${value}" ${value === selected ? 'checked' : ''}><span>${label}</span></label>`).join('')}</fieldset>`;
  }

  function choice(name) { return $(`[name="${name}"]:checked`)?.value; }

  function timerFields(mode, minutes, prefix, studyMode = state.preferences.studyMode) {
    return `${choiceFields(`${prefix}-mode`, '做题模式', Object.entries(STUDY_MODES), studyMode)}<p class="setting-note">背题直接显示答案；练习确认后判分；考试选择后保留当前题，点击下一题或选题切换，交卷后只复盘错题和未作答题。</p>${choiceFields(`${prefix}-timer`, '计时方式', [['none', '不计时'], ['stopwatch', '正计时'], ['countdown', '倒计时']], mode)}<label class="form-field" id="${prefix}-minutes-field" ${mode === 'countdown' ? '' : 'hidden'}>限时（分钟）<input id="${prefix}-minutes" type="number" min="1" max="1440" step="1" value="${minutes}" ${mode === 'countdown' ? 'required' : 'disabled'}></label>`;
  }

  function updatePaperPreview() {
    if (!$('#paper-form')) return;
    paperDraft.count = Number($('#paper-count').value);
    paperDraft.weights = $$('[data-weight]').map(input => input.value === '' ? NaN : Number(input.value));
    paperDraft.timerMode = choice('paper-timer');
    paperDraft.studyMode = choice('paper-mode');
    paperDraft.allocationMode = choice('allocation-mode');
    $('#unit-weight-panel').hidden = paperDraft.allocationMode === 'type';
    $('#type-weight-panel').hidden = paperDraft.allocationMode === 'unit';
    paperDraft.typeWeights = $$('[data-type-weight]').map(input => input.value === '' ? NaN : Number(input.value));
    $$('[data-weight]').forEach(input => { input.disabled = paperDraft.allocationMode === 'type'; });
    $$('[data-type-weight]').forEach(input => { input.disabled = paperDraft.allocationMode === 'unit'; });
    paperDraft.minutes = Number($('#paper-minutes').value);
    paperDraft.includeFlagged = false;
    const countdown = paperDraft.timerMode === 'countdown';
    $('#paper-minutes-field').hidden = !countdown;
    $('#paper-minutes').disabled = !countdown;
    $('#paper-minutes').required = countdown;
    const sum = paperDraft.weights.reduce((total, weight) => total + weight, 0);
    $('#weight-total').textContent = Number.isFinite(sum) ? `${Math.round(sum * 1000) / 1000}%` : '—';
    const capacities = BANKS.map(bank => bank.questions.filter(question => paperDraft.includeFlagged || !question.flags.length).length);
    $$('[data-capacity]').forEach((output, index) => { output.textContent = `可抽 ${capacities[index]} 题`; });
    const preview = $('#paper-preview');
    try {
      const { counts, typeCounts } = Core.previewConfiguredPaper(BANKS, paperDraft);
      if (countdown && (!Number.isInteger(paperDraft.minutes) || paperDraft.minutes < 1 || paperDraft.minutes > 1440)) throw new Error('倒计时须为 1～1440 分钟的整数。');
      $$('[data-quota]').forEach((output, index) => { output.textContent = counts ? `${counts[index]} 题` : '随机'; });
      preview.textContent = `将抽取 ${paperDraft.count} 题。${typeCounts ? `单选 ${typeCounts[0]} / 多选 ${typeCounts[1]} / 判断 ${typeCounts[2]}。` : '题型不限制。'}${counts ? `覆盖 ${counts.filter(Boolean).length} 个单元。` : '跨单元随机。'}${countdown ? `限时 ${paperDraft.minutes} 分钟。` : paperDraft.timerMode === 'none' ? '不计时。' : '记录用时。'}`;
      preview.classList.remove('invalid');
      $('#paper-start').disabled = Boolean(state.progress.paper && !paperRestartReady);
    } catch (error) {
      $$('[data-quota]').forEach(output => { output.textContent = '— 题'; });
      preview.textContent = error.message;
      preview.classList.add('invalid');
      $('#paper-start').disabled = true;
    }
  }

  function openUnitSetup(id, restart = false) {
    if (!library) return openLibrary();
    pendingUnit = BANKS.find(bank => bank.id === id);
    if (!pendingUnit?.questions.length) return;
    const prefs = state.preferences;
    $('#practice-config-dialog').innerHTML = `<div class="dialog-heading"><h2 id="config-title">${escapeHTML(pendingUnit.title)}</h2><button class="icon-button" data-close="practice-config-dialog" aria-label="关闭练习设置">${icon('close')}</button></div><form id="unit-form" data-restart="${restart}">${choiceFields('unit-order', '题目顺序', [['sequence', '顺序'], ['shuffle', '随机']], 'sequence')}${timerFields(prefs.timerMode, prefs.minutes, 'unit')}<p class="setting-note">共 ${pendingUnit.questions.length} 题。取消设置保留原有进度。</p><button class="button primary full-width" type="submit">开始练习${icon('arrow')}</button></form>`;
    if (!$('#practice-config-dialog').open) $('#practice-config-dialog').showModal();
  }

  function enterUnit(id, restart = false) {
    const bank = BANKS.find(item => item.id === id);
    if (!bank?.questions.length) return;
    const key = `unit:${id}`;
    if (restart) {
      if (!confirmRestart()) return;
      openUnitSetup(id, true);
    } else if (!continueProgress(key)) {
      startSession(bank.questions.map(question => question.id), `${bank.label} · ${bank.title}`, { ...state.preferences, key });
    }
  }

  function confirmRestart() {
    return window.confirm('确定重新开始吗？生成新练习后将替换此入口的进度，历史成绩和其他入口保留。取消设置不会清空原进度。');
  }

  function renderVersionSelector() {
    if (!repository) return `<section class="setting-section"><h3>题库存储恢复</h3><p class="warning-text">${escapeHTML(libraryError || '版本存储尚未恢复，请先保留恢复副本。')}</p><button class="button" data-action="export">导出恢复副本</button></section>`;
    return `<section class="setting-section" id="version-settings"><h3>当前题库版本</h3><label class="form-field">选择版本<select id="library-version">${repository.list().map(item => `<option value="${escapeHTML(item.id)}" ${item.id === repository.activeId ? 'selected' : ''}>${escapeHTML(item.name)}</option>`).join('')}</select></label><div class="backup-actions"><button class="button primary" data-action="save-version">保存版本</button><button class="button" data-action="rename-version" ${repository.activeId === 'default' ? 'disabled' : ''}>修改名称</button><button class="button" data-action="delete-version" ${repository.activeId === 'default' ? 'disabled' : ''}>删除版本</button><button class="button" data-action="export">导出 JSON</button><button class="button" data-action="import">导入 JSON</button></div><p class="setting-note">题目修改与进度自动续存为本机工作草稿，不会自动创建命名版本。保存版本时按勾选项创建快照；未勾选的进度、用户解析和自定义内容不写入快照。原始读本基准及四题修订保留，当前版本中的默认单元和题目也可删改。导出也按勾选内容生成，不包含接口配置或密钥。</p></section>`;
  }

  function openSnapshot(exporting = false) {
    if (preserveUnreadLibrary || preserveUnreadStorage) return exporting ? exportBackup() : showToast('存储已保护，请先导出恢复副本。', 'help');
    pauseForDialog();
    $('#snapshot-dialog').innerHTML = `<div class="dialog-heading"><h2>${exporting ? '导出 JSON' : '保存版本'}</h2><button class="icon-button" data-close="snapshot-dialog" aria-label="关闭">${icon('close')}</button></div><form id="snapshot-form" data-export="${exporting}">${exporting ? '' : '<label class="form-field">版本名称<input name="name" required maxlength="80" placeholder="例如：第一轮复习"></label>'}<fieldset class="snapshot-options"><legend>选择保存内容（默认均不选）</legend><label class="checkbox-field"><input type="checkbox" name="content">题库内容：单元改名、题面和答案修改、新增及删除的单元和题目</label><label class="checkbox-field"><input type="checkbox" name="analysis">解析：手写解析和 API 分析</label><label class="checkbox-field"><input type="checkbox" name="progress">学习进度：作答、错题、收藏、组卷与续做记录</label></fieldset><p class="setting-note">未选题库内容时使用默认读本。解析与进度只保留题面及答案仍一致的题目；不兼容的整组进度不复制。原草稿不受影响。</p><p id="snapshot-error" class="warning-text" role="alert"></p><button class="button primary" type="submit">${exporting ? '生成文件' : '保存为新版本'}</button></form>`;
    $('#snapshot-dialog').showModal();
  }

  function snapshotStudy(nextLibrary, include) {
    const fresh = defaultState(nextLibrary.id);
    fresh.preferences.weights = defaultWeights(nextLibrary.banks);
    if (!include) return fresh;
    const compatible = new Set(nextLibrary.banks.flatMap(bank => bank.questions).filter(question => {
      const source = QUESTION_MAP.get(question.id);
      return source && JSON.stringify([source.type, source.text, source.options, source.answer]) === JSON.stringify([question.type, question.text, question.options, question.answer]);
    }).map(question => question.id));
    const copied = JSON.parse(JSON.stringify(state));
    copied.attempts = copied.attempts.filter(answer => compatible.has(answer.questionId));
    copied.favorites = copied.favorites.filter(id => compatible.has(id));
    copied.mistakes = Object.fromEntries(Object.entries(copied.mistakes).filter(([id]) => compatible.has(id)));
    copied.progress = Object.fromEntries(Object.entries(copied.progress).filter(([, session]) => session.ids.every(id => compatible.has(id))));
    if (copied.session && !copied.session.ids.every(id => compatible.has(id))) copied.session = null;
    if (compatible.size < QUESTIONS.length) copied.papers = [];
    copied.preferences.weights = nextLibrary.banks.map(bank => copied.preferences.weights[BANKS.findIndex(source => source.id === bank.id)] ?? 0);
    const sum = copied.preferences.weights.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 100) > .000001) copied.preferences.weights = defaultWeights(nextLibrary.banks);
    return normalizeState(copied, nextLibrary);
  }

  function saveSnapshot(form) {
    try {
      parkSession();
      if (!saveState()) throw new Error('本机记录未能安全保存，请先导出恢复副本。');
      const content = form.elements.content.checked, analysis = form.elements.analysis.checked;
      const next = Store.snapshotLibrary(library, baseline, { content, analysis });
      const study = snapshotStudy(next, form.elements.progress.checked);
      if (form.dataset.export === 'true') {
        downloadFile(JSON.stringify({ format: 'zhixu-library', version: 3, library: next, study, exportedAt: new Date().toISOString() }, null, 2), `知序-所选内容-${todayKey()}.json`, 'application/json;charset=utf-8');
        showToast('已按所选内容导出 JSON，不含 API 配置。');
      } else {
        repository.add(form.elements.name.value.trim(), next, study);
        adoptVersion();
        showToast('命名版本已保存，未勾选内容没有写入新版本。原工作草稿保留。');
      }
      $('#snapshot-dialog').close();
    } catch (error) { $('#snapshot-error').textContent = error.message; }
  }

  function switchVersion(id) {
    if (!repository) return;
    try {
      if (preserveUnreadStorage) {
        if (!window.confirm('原学习记录已保护，不会覆盖。切换后当前临时进度不保存；建议先导出恢复副本。确定切换吗？')) return;
        cancelAllAPI(); clearInterval(sessionInterval);
      } else {
        parkSession();
        if (preserveUnreadStorage || storageFailed) throw new Error('当前记录未能安全保存，请先导出备份。');
      }
      repository.select(id);
      adoptVersion();
      showToast('已切换版本，当前版本进度已恢复。');
    } catch (error) { showToast(error.message, 'help'); renderPage(); }
  }

  function adoptVersion() {
    cancelAllAPI(); apiMessages.clear(); apiStreams.clear();
    setLibrary(repository.load());
    preserveUnreadStorage = false; storageFailed = false;
    state = loadState();
    if (state.session) state.session.timer = Core.pauseClock(state.session.timer);
    paperRestartReady = false;
    paperDraft = { ...state.preferences, weights: [...state.preferences.weights], typeWeights: [...state.preferences.typeWeights] };
    currentSelection = []; completedSession = null; questionElapsed = 0; activeStartedAt = 0;
    clearInterval(sessionInterval);
    $('#practice-dialog').close(); $('#editor-dialog').close(); $('#practice-config-dialog').close();
    applyTheme(); renderPage();
    if ($('#settings-dialog').open) renderSettings();
  }

  function openLibrary() {
    showToast(libraryError || '当前安装包的读本正文尚未就绪。', 'help');
  }

  const API_KEY = 'zhixu-single-question-api-v1';
  let apiConfig = API.defaults();
  try { const saved = localStorage.getItem(API_KEY); if (saved) apiConfig = API.validateConfig(JSON.parse(saved)); } catch { /* 保留空配置，不阻止练习。 */ }
  const apiJobs = new Map();
  const apiStreams = new Map();
  const API_PRESETS_KEY = 'zhixu-api-presets-v1';
  let apiPresets = [];
  try { apiPresets = JSON.parse(localStorage.getItem(API_PRESETS_KEY) || '[]').filter(item => item && typeof item.name === 'string' && item.config).map(item => ({ name: item.name.slice(0, 80), config: API.validateConfig(item.config) })); } catch { apiPresets = []; }
  let apiMessages = new Map();
  let apiModelIds = [];
  let apiNetworkJob = null;
  let editingId = null;

  function pauseForDialog() {
    if (!state.session) return;
    if (Core.clockExpired(state.session.timer)) { finishSession('timeout'); return; }
    pauseTimer();
    state.session.timer = Core.pauseClock(state.session.timer);
    saveState();
    if ($('#practice-dialog').open) renderPractice();
  }

  function openAPI() {
    pauseForDialog();
    cancelAPINetwork();
    apiModelIds = [];
    const config = apiConfig;
    $('#api-dialog').innerHTML = `<div class="dialog-heading"><div><span class="eyebrow">SINGLE QUESTION API</span><h2 id="api-title">API 调用</h2></div><button class="icon-button" data-close="api-dialog" aria-label="关闭 API 设置">${icon('close')}</button></div>
      <p class="settings-intro">配置自己的接口。打开设置会暂停练习，关闭后点击「继续练习」。分析每次只发送当前题的题型、题干、选项和参考答案，不发送其他题目、学习记录或已有解析。</p>
      <div class="preset-controls"><label class="form-field">API 预设<select id="api-preset"><option value="">选择已保存预设</option>${apiPresets.map((item, i) => `<option value="${i}">${escapeHTML(item.name)}${item.config.rememberKey ? '' : '（仅本次）'}</option>`).join('')}</select></label><div class="backup-actions"><button class="button" data-action="save-api-preset">另存为预设</button><button class="button" data-action="delete-api-preset">删除所选预设</button></div></div>
      <form id="api-form"><label class="form-field">接口地址<input name="endpoint" type="url" required value="${escapeHTML(config.endpoint)}" placeholder="https://你的接口/v1/chat/completions"><small>填写完整地址；OpenAI 兼容模式也支持以 /v1 结尾的地址。</small></label>
      <label class="form-field">模型名称<input name="model" value="${escapeHTML(config.model)}" autocomplete="off" placeholder="填写模型 ID，或从拉取的列表选择"><small>保留手动填写；拉取模型不会自动替换当前名称。</small></label>
      <div class="backup-actions"><button type="button" class="button" data-action="list-models">拉取模型</button><button type="button" class="button" data-action="test-api">测试连接</button></div><p id="api-network-status" class="setting-note" role="status">连接测试只访问模型列表，不生成内容、不发送题目；成功不代表所选模型支持生成。</p>
      <section id="api-model-picker" class="api-model-picker" aria-label="接口返回的模型" hidden>
        <label class="form-field" for="api-model-search">搜索模型<input id="api-model-search" type="search" autocomplete="off" placeholder="独立搜索，例如 Claude、Gemini、DeepSeek"></label>
        <div class="api-model-count-row"><p id="api-model-count" class="setting-note" role="status"></p><button type="button" class="text-button" data-action="clear-model-search">显示全部</button></div>
        <label class="form-field" for="api-models">模型列表（选择后填入模型名称）<select id="api-models" size="8" aria-describedby="api-model-count api-model-help"></select></label>
        <p id="api-model-help" class="setting-note">仅显示当前接口及密钥本次返回的有效模型，不按品牌过滤；滚动查看全部，搜索不受上方模型名称影响。未列出的模型仍可手动填写。是否支持文本生成取决于接口与模型。</p>
      </section>
      <label class="checkbox-field"><input name="stream" type="checkbox" ${config.stream ? 'checked' : ''}>流式输出（关闭为非流式）</label>
      <label class="form-field">温度 temperature<input name="temperature" type="number" min="0" max="2" step="0.05" value="${config.temperature}" placeholder="留空使用模型默认"></label>
      ${[['thinking', 'Thinking / 思考', [['default', '服务商默认'], ['on', '开启'], ['off', '关闭']]], ['thinkingFormat', '思考参数格式', [['reasoning', 'OpenAI reasoning / reasoning_effort'], ['enable_thinking', '兼容网关 enable_thinking']]], ['reasoningEffort', '思考强度（OpenAI 格式）', [['', '未指定'], ['low', 'low'], ['medium', 'medium'], ['high', 'high']]], ['searchMode', '联网取证', [['off', '普通分析 · 未验证联网'], ['required', '强制检索 · 仅 Responses 支持 web_search 的模型']]]].map(([name, label, choices]) => `<label class="form-field">${label}<select name="${name}">${choices.map(([value, text]) => `<option value="${value}" ${config[name] === value ? 'selected' : ''}>${text}</option>`).join('')}</select></label>`).join('')}
      <p class="setting-note">温度、思考与检索取决于接口支持，失败不自动降级。流式片段完成前不保存，失败即丢弃；只展示公开回答，不展示原始思维链。</p>
      <label class="form-field">API Key<input name="key" type="password" autocomplete="off" value="${escapeHTML(config.key)}" placeholder="无需认证可留空"></label>
      <details class="api-advanced" ${config.mode === 'custom' ? 'open' : ''}><summary>自定义接口格式（可选）</summary>
      <label class="form-field">请求格式<select name="mode"><option value="openai" ${config.mode === 'openai' ? 'selected' : ''}>OpenAI 兼容</option><option value="responses" ${config.mode === 'responses' ? 'selected' : ''}>OpenAI Responses</option><option value="custom" ${config.mode === 'custom' ? 'selected' : ''}>自定义 JSON POST · 非流式</option></select></label>
      <label class="form-field">自定义请求头（JSON）<textarea name="headersText" rows="3" spellcheck="false">${escapeHTML(config.headersText)}</textarea><small>例如 {"x-api-key":"你的密钥"}。已有 Authorization 时优先使用自定义值。</small></label>
      <label class="form-field">提示词角色<select name="promptMode"><option value="system" ${config.promptMode === 'system' ? 'selected' : ''}>System / Instructions</option><option value="user" ${config.promptMode === 'user' ? 'selected' : ''}>合并到 User</option></select></label>
      <label class="form-field">附加请求 JSON（Chat / Responses）<textarea name="extraBodyText" rows="3" spellcheck="false">${escapeHTML(config.extraBodyText)}</textarea><small>例如最大输出 token。题目、模型、温度、思考与流式使用专用控件。</small></label>
      <label class="form-field">请求体模板（自定义模式）<textarea name="bodyTemplate" rows="5" spellcheck="false" placeholder='{"input":"{{prompt}}","model":"{{model}}"}'>${escapeHTML(config.bodyTemplate)}</textarea><small>必须包含 {{prompt}}（当前题及审核要求）；{{question}} 可额外插入题目对象；{{model}} 为模型名称。自定义模式只支持非流式，温度与思考参数写在模板中，上方温度/强度留空、思考选默认、附加 JSON 设为 {}。</small></label>
      <label class="form-field">响应文本字段<input name="responsePath" value="${escapeHTML(config.responsePath)}"><small>例如 choices.0.message.content 或 data.analysis。纯文本响应直接读取。</small></label>
      <label class="form-field">超时（秒）<input name="timeoutSeconds" type="number" min="5" max="180" value="${config.timeoutSeconds}" required></label></details>
      <label class="checkbox-field"><input name="rememberKey" type="checkbox" ${config.rememberKey ? 'checked' : ''}><span>在此设备记住完整配置和密钥<small>默认仅本次打开有效；勾选后完整配置和预设明文保存在浏览器，勿在公共设备使用。JSON 导出始终不包含 API 配置。</small></span></label>
      <p class="setting-note">仅在你点击调用并确认后联网，可能产生接口费用。服务商需允许浏览器跨域请求（CORS），直接打开 HTML 时可能需要允许来源 null。请求失败不会自动重试，也不会自动修改答案。</p><p id="api-config-error" class="warning-text" role="alert"></p>
      <div class="backup-actions"><button type="submit" class="button primary">保存设置</button><button type="button" class="button" data-action="clear-api">清除配置</button></div></form>`;
    if (!$('#api-dialog').open) $('#api-dialog').showModal();
  }

  function apiFormValues(form = $('#api-form')) {
    const values = Object.fromEntries(new FormData(form));
    values.rememberKey = form.elements.rememberKey.checked;
    values.stream = form.elements.stream.checked;
    values.temperature = values.temperature === '' ? '' : Number(values.temperature);
    return values;
  }

  function cancelAPINetwork() {
    const job = apiNetworkJob;
    apiNetworkJob = null;
    job?.controller.abort();
    if (job) $$('[data-action="list-models"], [data-action="test-api"]', job.form).forEach(button => { button.disabled = false; });
  }

  function resetAPIModels() {
    cancelAPINetwork();
    apiModelIds = [];
    $('#api-model-search').value = '';
    $('#api-models').replaceChildren();
    $('#api-model-picker').hidden = true;
    $('#api-network-status').textContent = '接口或认证配置已更改，请重新拉取模型或测试连接。';
  }

  function renderAPIModels() {
    const list = $('#api-models'), form = $('#api-form');
    if (!list || !form) return;
    const query = $('#api-model-search').value.trim().toLowerCase();
    const visible = apiModelIds.filter(id => id.toLowerCase().includes(query));
    // 独立列表仅按搜索框过滤，绝不按当前 model 值隐式筛选。
    list.innerHTML = visible.map(id => `<option value="${escapeHTML(id)}">${escapeHTML(id)}</option>`).join('');
    list.value = form.elements.model.value;
    list.disabled = !visible.length;
    $('#api-model-count').textContent = `显示 ${visible.length} / ${apiModelIds.length} 个模型${visible.length ? '' : '；无匹配结果，可清空搜索显示全部'}。`;
  }

  async function apiNetworkTest(models) {
    const form = $('#api-form'), status = $('#api-network-status');
    if (!form) return;
    cancelAPINetwork();
    const job = { form, controller: new AbortController() };
    apiNetworkJob = job;
    const current = () => apiNetworkJob === job && $('#api-form') === form && $('#api-dialog').open;
    const buttons = $$('[data-action="list-models"], [data-action="test-api"]', form);
    buttons.forEach(button => { button.disabled = true; });
    if (models) {
      apiModelIds = [];
      $('#api-model-picker').hidden = true;
      $('#api-models').replaceChildren();
    }
    try {
      const config = apiFormValues(form);
      const options = { signal: job.controller.signal };
      status.textContent = models ? '正在拉取模型…' : '正在测试连接（不生成内容）…';
      if (models) {
        const ids = await API.listModels(config, options);
        if (!current()) return;
        apiModelIds = ids;
        $('#api-model-search').value = '';
        $('#api-model-picker').hidden = false;
        renderAPIModels();
        status.textContent = `本次已获取 ${ids.length} 个有效模型。请在下方列表选择，或手动填写；当前模型名称未改变。`;
      } else {
        const result = await API.testConnection(config, options);
        if (current()) status.textContent = result.message;
      }
    } catch (error) { if (current()) status.textContent = error.message; }
    finally {
      if (apiNetworkJob === job) apiNetworkJob = null;
      if (!apiNetworkJob || apiNetworkJob.form !== form) buttons.forEach(button => { button.disabled = false; });
    }
  }

  function saveAPIPreset() {
    try {
      const config = API.validateConfig(apiFormValues());
      const name = window.prompt('预设名称（最多80字；勾选记住配置才会跨刷新保存，包含明文密钥）');
      if (!name?.trim()) return;
      if (apiPresets.length >= 20) throw new Error('最多保存20个预设，请先删除不用的预设。');
      const next = [...apiPresets, { name: name.trim().slice(0, 80), config }];
      localStorage.setItem(API_PRESETS_KEY, JSON.stringify(next.filter(item => item.config.rememberKey)));
      apiPresets = next; apiConfig = config; openAPI();
      showToast(config.rememberKey ? '预设已保存在此设备。' : '预设仅本次有效；如需跨刷新保存，请勾选记住完整配置。');
    } catch (error) { $('#api-config-error').textContent = error.message; }
  }

  function deleteAPIPreset() {
    const value = $('#api-preset').value;
    if (value === '' || !apiPresets[Number(value)]) return;
    if (!window.confirm('确定删除该 API 预设？当前已使用的配置不受影响。')) return;
    try {
      const next = apiPresets.filter((_, index) => index !== Number(value));
      localStorage.setItem(API_PRESETS_KEY, JSON.stringify(next.filter(item => item.config.rememberKey)));
      apiPresets = next; openAPI();
    } catch { $('#api-config-error').textContent = '存储失败，预设未删除。'; }
  }

  function saveAPI(form) {
    try {
      const next = API.validateConfig(apiFormValues(form));
      if (next.rememberKey) localStorage.setItem(API_KEY, JSON.stringify(next));
      else localStorage.removeItem(API_KEY);
      apiConfig = next;
      $('#api-dialog').close();
      showToast(next.rememberKey ? 'API 配置已保存在此设备。' : 'API 配置仅在本次打开期间保留。');
    } catch (error) { $('#api-config-error').textContent = error.message; }
  }

  function renderAPIPanel(question, reveal = state.session?.mode === 'memorize' || Boolean(state.session?.answers[state.session.index])) {
    if (state.session?.mode === 'exam') return '';
    const pending = apiJobs.has(question.id), analysis = question.apiAnalysis;
    const evidence = analysis?.evidence;
    return `<section class="question-api"><div class="card-heading"><h4>解析与 API 分析</h4><button class="text-button" data-action="api">接口设置</button></div>
      ${reveal ? `<p class="analysis-text question-explanation">${escapeHTML(question.explanation || '原文未提供逐题解析。当前按读本参考答案判分，可调用 API 辅助核对；分析不自动修改答案。')}</p>` : '<p class="setting-note">确认选择后显示解析。</p>'}
      <p class="setting-note">单题发送，不上传题库或学习记录。分析仅供参考，不自动改答案。</p>
      <div class="backup-actions"><button class="button soft" data-analyze="${question.id}" ${pending || !reveal ? 'disabled' : ''}>${pending ? '正在分析…' : analysis ? '重新分析' : '检验与分析'}</button>${pending ? `<button class="button" data-cancel-api="${question.id}">取消请求</button>` : ''}</div>
      <p role="status" class="setting-note">${escapeHTML(apiMessages.get(question.id) || '')}</p>
      ${pending ? `<p class="analysis-text api-stream">${escapeHTML(apiStreams.get(question.id) || '等待接口响应…')}</p>` : ''}
      ${reveal && analysis ? `<section class="api-result"><h5>${escapeHTML(analysis.model || '自定义接口')}</h5><small>${escapeHTML(analysis.endpointOrigin)} · ${escapeHTML(new Date(analysis.at).toLocaleString('zh-CN'))}</small><p class="setting-note">${evidence?.status === 'search-reported' ? '接口报告已完成检索，并返回下列来源；这不等于客户端已独立核实事实。' : '本次联网未经验证；有引用也不代表已经实际检索。'}</p><div class="analysis-text">${escapeHTML(analysis.text)}</div>${evidence?.sources?.length ? `<ul class="api-sources">${evidence.sources.map(source => `<li><a href="${escapeHTML(source.url)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">${escapeHTML(source.title || source.url)}</a></li>`).join('')}</ul>` : ''}</section>` : ''}</section>`;
  }

  function refreshAPIPanel(id) {
    const panel = $('.question-api', $('#practice-dialog'));
    if (panel && state.session?.ids[state.session.index] === id) panel.outerHTML = renderAPIPanel(QUESTION_MAP.get(id));
  }

  function cancelAPI(id) { apiJobs.get(id)?.abort(); }
  function cancelAllAPI() { for (const controller of apiJobs.values()) controller.abort(); }

  async function analyzeQuestion(id) {
    const question = QUESTION_MAP.get(id);
    if (!question || apiJobs.has(id) || state.session?.mode === 'exam') return;
    if (state.session?.mode !== 'memorize' && !state.session?.answers[state.session.index]) return;
    if (preserveUnreadLibrary) return showToast('原题库存储尚未恢复，暂不发送 API 请求，避免产生无法保存的费用。', 'help');
    let config;
    try { config = API.validateConfig(apiConfig); } catch { openAPI(); return; }
    const origin = new URL(config.endpoint).origin;
    if (!window.confirm(`将当前这一道题的题干、选项和参考答案发送至 ${origin} 进行检验与分析，可能产生费用。不会发送其他题目。是否继续？`)) return;
    const snapshot = JSON.stringify([question.type, question.text, question.options, question.referenceAnswer]);
    const controller = new AbortController();
    apiJobs.set(id, controller); apiMessages.delete(id); apiStreams.set(id, ''); refreshAPIPanel(id);
    try {
      const result = await API.analyze(config, question, { signal: controller.signal, onDelta: text => {
        if (controller.signal.aborted) return;
        apiStreams.set(id, (apiStreams.get(id) || '') + text);
        const output = state.session?.ids[state.session.index] === id ? $('.api-stream') : null;
        if (output) output.textContent = apiStreams.get(id);
      } });
      const current = QUESTION_MAP.get(id);
      if (controller.signal.aborted || !current || snapshot !== JSON.stringify([current.type, current.text, current.options, current.referenceAnswer])) return;
      const persisted = replaceQuestion({ ...current, apiAnalysis: result }, true);
      apiMessages.set(id, persisted ? '分析已保存，可随 JSON 导出。正确答案保持不变。' : '本地存储失败，分析仅在本次打开期间保留。请立即导出 JSON，刷新会丢失！');
    } catch (error) {
      apiMessages.set(id, error.code === 'ABORTED' ? '已取消等待，服务商仍可能计费。' : error.message);
    } finally { if (apiJobs.get(id) === controller) { apiJobs.delete(id); apiStreams.delete(id); } refreshAPIPanel(id); }
  }

  function openNewQuestion(bankId, afterId = null) {
    if (state.session?.mode === 'exam') return showToast('考试中不能新增题目。', 'help');
    const bank = BANKS.find(item => item.id === bankId);
    if (!bank) return;
    pauseForDialog();
    addingQuestion = { bankId, afterId };
    editingId = null;
    $('#editor-dialog').innerHTML = `<div class="dialog-heading"><h2 id="editor-title">新增题目</h2><button class="icon-button" data-close="editor-dialog" aria-label="关闭">${icon('close')}</button></div><p class="setting-note">${escapeHTML(bank.title)} · ${afterId ? '插入当前题后' : '追加到单元末尾'}。题目按位置自动编号，原题身份不变。当前练习题序不变，重新开始时纳入新题。</p><form id="editor-form"><label class="form-field">题型<select id="edit-type"><option value="single">单选题</option><option value="multiple">多选题</option><option value="boolean">判断题</option></select></label><label class="form-field">题干<textarea id="edit-text" rows="3" required maxlength="20000"></textarea></label><div id="edit-options">${[0, 1, 2, 3].map(i => editorOption(i, '', false, 'single')).join('')}</div><button class="button" type="button" data-action="add-option">增加选项</button><p class="setting-note">勾选正确答案。单选/判断恰好一项，多选至少两项。</p><label class="form-field">解析<textarea id="edit-explanation" rows="3" maxlength="200000"></textarea></label><p id="editor-error" role="alert" class="warning-text"></p><button class="button primary" type="submit">新增题目</button></form>`;
    if (!$('#editor-dialog').open) $('#editor-dialog').showModal();
  }

  function openEditor(id) {
    addingQuestion = null;
    const question = QUESTION_MAP.get(id);
    if (!question || state.session?.mode === 'exam') return;
    cancelAPI(id);
    pauseForDialog();
    editingId = id;
    $('#editor-dialog').innerHTML = `<div class="dialog-heading"><div><span class="eyebrow">EDIT QUESTION</span><h2 id="editor-title">编辑题目</h2></div><button class="icon-button" data-close="editor-dialog" aria-label="关闭题目编辑">${icon('close')}</button></div>
      <p class="settings-intro">${escapeHTML(question.bankTitle)} · 原题 ${question.sourceNumber}。修改仅保存在本机，可通过 JSON 迁移。练习已暂停。</p>
      <form id="editor-form"><label class="form-field">题型<select id="edit-type" ${question.type === 'boolean' ? 'disabled' : ''}>${(question.type === 'boolean' ? ['boolean'] : ['single', 'multiple']).map(type => `<option value="${type}" ${type === question.type ? 'selected' : ''}>${Core.LABELS[type]}</option>`).join('')}</select></label>
      <label class="form-field">题干<textarea id="edit-text" rows="4" required maxlength="20000">${escapeHTML(question.text)}</textarea></label>
      <div id="edit-options">${Array.from({ length: question.type === 'boolean' ? 2 : Math.max(2, question.options.length) }, (_, index) => editorOption(index, question.options[index] || '', question.answer.includes(index), question.type, Store.isConfirmedBlankOption(question, index))).join('')}</div>
      ${question.type !== 'boolean' ? '<button class="button" type="button" data-action="add-option">增加选项</button>' : ''}
      <p class="setting-note">勾选正确答案：单选 / 判断恰好 1 项，多选至少 2 项。删除选项后请重新确认答案。判断选项固定为正确、错误。</p>
      <label class="form-field">解析<textarea id="edit-explanation" rows="5" maxlength="200000">${escapeHTML(question.explanation)}</textarea></label>
      <p class="setting-note">修改题干、选项或答案会清除过期 API 分析；历史成绩不重算，正在进行的练习会结束并保留已提交记录。</p><p id="editor-error" class="warning-text" role="alert"></p><button type="submit" class="button primary full-width">保存题目</button><button type="button" class="button warning-text full-width" data-delete-question="${question.id}">删除这道题</button></form>`;
    $('#editor-dialog').showModal();
  }

  function editorOption(index, text, correct, type, allowBlank = false) {
    return `<div class="editor-option"><label class="editor-correct"><input type="checkbox" data-edit-correct ${correct ? 'checked' : ''} aria-label="选项 ${index + 1} 为正确答案"><span>${type === 'boolean' ? ['√', '×'][index] : String.fromCharCode(65 + index)}</span></label><textarea data-edit-option rows="2" ${allowBlank ? 'placeholder="经确认保留的空白 E 选项"' : 'required'} maxlength="10000" aria-label="选项 ${index + 1} 内容${allowBlank ? '（允许保留空白）' : ''}" ${type === 'boolean' ? 'readonly' : ''}>${escapeHTML(text)}</textarea>${type !== 'boolean' ? '<button type="button" class="icon-button" data-remove-option aria-label="删除此选项">×</button>' : ''}</div>`;
  }

  function saveEditor() {
    try {
      if (addingQuestion) {
        const question = Store.createQuestion({ type: $('#edit-type').value, text: $('#edit-text').value.trim(), options: $$('[data-edit-option]').map(input => input.value.trim()), answer: $$('[data-edit-correct]').flatMap((input, index) => input.checked ? [index] : []), explanation: $('#edit-explanation').value });
        const { bankId, afterId } = addingQuestion;
        persistLibrary(Store.addQuestion(library, bankId, question, afterId, baseline));
        addingQuestion = null;
        $('#editor-dialog').close(); renderPage();
        if (state.session) renderPractice();
        showToast('新题已插入并自动编号。保存命名版本时请勾选题库内容。');
        return;
      }
      const previous = QUESTION_MAP.get(editingId);
      const next = Store.editedQuestion(previous, { type: $('#edit-type').value, text: $('#edit-text').value.trim(),
        options: $$('[data-edit-option]').map(input => input.value.trim()),
        answer: $$('[data-edit-correct]').flatMap((input, index) => input.checked ? [index] : []), explanation: $('#edit-explanation').value });
      const changed = JSON.stringify([previous.type, previous.text, previous.options, previous.answer]) !== JSON.stringify([next.type, next.text, next.options, next.answer]);
      if (changed && Object.values(state.progress).some(session => session.mode === 'exam' && session.status !== 'completed' && session.ids.includes(previous.id))) {
        throw new Error('此题属于尚未交卷的考试，已阻止修改判分依据。请先继续并交卷该考试；可以先保存仅解析的修改。');
      }
      if (changed && state.session && !window.confirm('修改题目会结束当前练习，已提交成绩保留。确定保存吗？')) return;
      replaceQuestion(next);
      if (changed && state.session) finishSession('finish');
      else if (state.session) renderPractice();
      $('#editor-dialog').close(); renderPage(); showToast('题目已保存。');
    } catch (error) { $('#editor-error').textContent = error.message; }
  }

  function downloadFile(contents, filename, type) {
    const url = URL.createObjectURL(new Blob([contents], { type }));
    const link = document.createElement('a');
    link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }


  function emptyState(name, title, description, buttonLabel, action) {
    return `<div class="empty-state"><div class="empty-icon">${icon(name)}</div><h2>${title}</h2><p>${description}</p><button class="button primary" data-action="${action}">${buttonLabel}${icon('arrow')}</button></div>`;
  }

  function questionType(question) { return Core.LABELS[question.type]; }

  function collectionIds(type) {
    const ids = (type === 'mistakes' ? getStats().mistakes : state.favorites).filter(id => QUESTION_MAP.has(id));
    if (collectionSort === 'unit') {
      const positions = new Map(QUESTIONS.map((question, index) => [question.id, index]));
      ids.sort((a, b) => positions.get(a) - positions.get(b));
    }
    return ids;
  }

  function renderCollection(type) {
    const mistakes = type === 'mistakes';
    const ids = collectionIds(type);
    const availableCategories = ['全部', ...new Set(ids.map(id => QUESTION_MAP.get(id).category))];
    if (!availableCategories.includes(listCategory)) listCategory = '全部';
    const questions = ids.map(id => QUESTION_MAP.get(id)).filter(question => listCategory === '全部' || question.category === listCategory);
    const title = mistakes ? '把每一次错误，变成进步。' : '值得记住的，留在这里。';
    const description = mistakes ? `答错自动收录，进入错题本后累计答对 ${state.mistakeTarget} 次自动移出；再次答错不清零。手动移出只影响错题本。` : '收藏那些有启发的题目，建立属于自己的知识清单。';
    return `<div class="page-enter"><section class="page-heading"><div><div class="greeting">${mistakes ? 'REVIEW & GROW' : 'YOUR KNOWLEDGE COLLECTION'}</div><h1>${title}</h1><p class="heading-description">${description}</p></div></section>
${entryControls(type, mistakes ? '继续复习' : '继续练习', '重新开始')}${choiceFields('collection-sort', '排列方式', [['unit', '按单元顺序'], ['added', mistakes ? '按错题收录顺序' : '按收藏顺序']], collectionSort)}
      ${mistakes ? `<section class="panel mistake-settings"><form id="mistake-rule-form"><label class="form-field">累计答对几次后移出<input name="target" type="number" min="1" max="100" step="1" required value="${state.mistakeTarget}"></label><button class="button" type="submit">保存规则</button></form><p class="setting-note">可设 1～100 次。修改规则不立即清空错题，下次答对时按新规则判断。移出后再次答错会重新收录、从 0 次开始。</p>${entryControls('mistake-paper', '继续错题组卷', '重新抽取错题卷')}</section>` : ''}
      ${ids.length ? `<div class="bank-toolbar"><div class="tabs" aria-label="按学科筛选">${availableCategories.map(item => `<button class="tab ${listCategory === item ? 'active' : ''}" data-list-category="${item}" aria-pressed="${listCategory === item}">${item === '全部' ? '全部学科' : item}</button>`).join('')}</div><span class="result-count">${questions.length} 道题目</span></div>` : ''}
      ${questions.length ? `<div class="question-list">${questions.map(question => `<article class="question-list-card"><div class="bank-icon ${question.bankColor}">${icon(question.bankIcon)}</div><div class="question-list-content"><div class="question-labels"><span class="pill">${questionType(question)}</span><span>${escapeHTML(question.bankTitle)}</span><span>·</span><span>${question.topic}</span></div><h3>${escapeHTML(question.text)}</h3>${mistakes ? `<p class="setting-note">累计答对 ${state.mistakes[question.id].correctCount} / ${state.mistakeTarget} 次</p>` : ''}</div><div class="question-list-actions"><button class="button" data-edit="${question.id}">编辑</button><button class="button" data-add-after="${question.id}">新增题目</button>${mistakes ? `<button class="button" data-remove-mistake="${question.id}">移出错题本</button>` : ''}<button class="icon-button" data-favorite="${question.id}" aria-label="${state.favorites.includes(question.id) ? '取消收藏' : '收藏题目'}" aria-pressed="${state.favorites.includes(question.id)}" ${state.favorites.includes(question.id) ? 'style="color:#bd9252"' : ''}>${icon('star')}</button><button class="button soft" data-question="${question.id}">再练一次${icon('arrow')}</button></div></article>`).join('')}</div>` : emptyState(mistakes ? 'check-circle' : 'star', mistakes ? (ids.length ? '这个学科还没有错题' : '错题本，还是一张白纸') : (ids.length ? '这个学科还没有收藏' : '把有启发的题目，留给未来的自己'), mistakes ? '在练习中遇到的难题会自动出现在这里。不怕答错，每一次尝试都有收获。' : '练习时点击「收藏题目」，就能在这里再次找到它，随时回顾、反复练习。', '去题库看看', 'go-banks')}
    </div>`;
  }

  function openMistakePaper(restart = false) {
    const ids = getStats().mistakes.filter(id => !QUESTION_MAP.get(id).flags.length);
    const prefs = state.preferences;
    $('#practice-config-dialog').innerHTML = `<div class="dialog-heading"><h2 id="config-title">错题随机组卷</h2><button class="icon-button" data-close="practice-config-dialog" aria-label="关闭">${icon('close')}</button></div><form id="mistake-paper-form" data-restart="${restart}"><label class="form-field">抽取数量（可用 ${ids.length} 题）<input id="mistake-paper-count" type="number" min="1" max="${Math.max(1, ids.length)}" value="${Math.min(20, ids.length)}" required></label>${timerFields(prefs.timerMode, prefs.minutes, 'unit')}<button class="button primary" type="submit" ${ids.length ? '' : 'disabled'}>生成并开始</button></form>`;
    if (!$('#practice-config-dialog').open) $('#practice-config-dialog').showModal();
  }

  let collectionSetup = null;
  function openCollectionSetup(key, ids, title, restart = false) {
    collectionSetup = { key, ids, title, restart };
    $('#practice-config-dialog').innerHTML = `<div class="dialog-heading"><h2 id="config-title">${escapeHTML(title)}</h2><button class="icon-button" data-close="practice-config-dialog" aria-label="关闭">${icon('close')}</button></div><form id="collection-form">${choiceFields('collection-order', '题目顺序', [['sequence', '顺序'], ['shuffle', '随机']], 'sequence')}<p class="setting-note">顺序按当前列表排列，共 ${ids.length} 题。取消设置保留原进度。</p>${timerFields(state.preferences.timerMode, state.preferences.minutes, 'unit')}<button class="button primary" type="submit">开始练习</button></form>`;
    if (!$('#practice-config-dialog').open) $('#practice-config-dialog').showModal();
  }

  function enterCollection(key, restart = false) {
    if (restart && !confirmRestart()) return;
    if (!restart && continueProgress(key)) return;
    if (key === 'mistake-paper') return openMistakePaper(restart);
    const ids = collectionIds(key).filter(id => listCategory === '全部' || QUESTION_MAP.get(id).category === listCategory);
    const title = key === 'mistakes' ? '错题复习' : '收藏练习';
    if (restart) openCollectionSetup(key, ids, title, true);
    else startSession(ids, title, { ...state.preferences, key });
  }

  function removeMistake(id) {
    const question = QUESTION_MAP.get(id);
    if (!question || !state.mistakes[id]) return;
    if (!window.confirm(`确定将「${question.text.slice(0, 80)}」移出错题本吗？累计正确次数会清除，题目及历史答题记录仍保留。`)) return;
    delete state.mistakes[id]; saveState(); renderPage(); showToast('已移出错题本。');
  }

  function renderStatsPage() {
    const stats = getStats();
    const weekCount = getWeek().reduce((sum, day) => sum + day.count, 0);
    return `<div class="page-enter"><section class="page-heading"><div><div class="greeting">SMALL STEPS, REAL PROGRESS</div><h1>你的努力，都有迹可循。</h1><p class="heading-description">用真实的积累记录成长。已经学习 ${stats.days} 天，探索了 ${stats.unique.size} 道不同的题目。</p></div></section>${renderStatCards()}
      <div class="stats-panels"><section class="panel"><h2>本周练习趋势</h2><p class="panel-description">从周一到周日，记录你的每一点积累。</p><div class="week-summary"><strong>${weekCount}</strong><span>道题目</span><span class="week-hint">每日目标 ${state.goal} 题</span></div>${renderWeekChart()}</section>
      <section class="panel"><h2>学科掌握情况</h2><p class="panel-description">按累计已判分题的正确率统计，重复练习也会计入；原文疑问题不计入分母。</p>${BANKS.map(bank => {
        const attempts = state.attempts.filter(attempt => QUESTION_MAP.get(attempt.questionId).bankId === bank.id && attempt.correct !== null);
        const correct = attempts.filter(attempt => attempt.correct === true).length;
        return `<div class="subject-stat"><div class="bank-icon ${bank.color}">${icon(bank.icon)}</div><div class="subject-stat-content"><div class="subject-stat-name"><span>${escapeHTML(bank.title)}</span><span>${attempts.length ? `${percent(correct, attempts.length)}% · ${attempts.length} 次` : '尚未开始'}</span></div><div class="progress-track"><span style="width:${percent(correct, attempts.length)}%"></span></div></div></div>`;
      }).join('')}</section></div>
      <section class="panel recent-panel"><h2>最近的学习记录</h2><p class="panel-description">展示最近 8 次答题，所有记录仅保存在当前浏览器。</p>${state.attempts.length ? state.attempts.slice(-8).reverse().map(attempt => {
        const question = QUESTION_MAP.get(attempt.questionId);
        return `<div class="recent-row"><span class="recent-result ${attempt.correct === false ? 'incorrect' : attempt.correct === null ? 'ungraded' : ''}">${icon(attempt.correct === null ? 'help' : attempt.correct ? 'check' : 'close')}</span><div class="recent-content"><h3>${escapeHTML(question.text)}</h3><p>${escapeHTML(question.bankTitle)} · ${attempt.correct === null ? '原文待核对 · 未判分' : attempt.correct ? '与参考答案一致' : '需要再巩固'}</p></div><time datetime="${new Date(attempt.at).toISOString()}">${new Date(attempt.at).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })} ${new Date(attempt.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</time></div>`;
      }).join('') : `<div style="padding:35px 0 15px;text-align:center"><p class="panel-description">还没有学习记录。完成第一道题，让成长从这里开始。</p><button class="button soft" style="margin-top:15px" data-action="daily">开始第一次练习${icon('arrow')}</button></div>`}</section>
      ${renderSessionHistory()}
    </div>`;
  }

  function renderSessionHistory() {
    if (!state.papers.length) return '';
    const reasons = { complete: '全部完成', timeout: '倒计时结束', finish: '主动结束' };
    return `<section class="panel session-history"><h2>最近的整组练习</h2><p class="panel-description">保留最近 8 组的结算结果；疑问题与未作答题不计入正确率。</p>${state.papers.slice(-8).reverse().map(paper => `<article class="session-history-row"><strong>${escapeHTML(paper.title)}</strong><span>${paper.graded ? `${percent(paper.correct, paper.graded)}%` : '未判分'}</span><small>${new Date(paper.at).toLocaleString('zh-CN', { hour12: false })} · ${reasons[paper.reason]}<br>提交 ${paper.answered} / ${paper.total} 题 · 答对 ${paper.correct} / ${paper.graded} 道已判分题 · 用时 ${Core.formatTime(paper.elapsedMs)}</small></article>`).join('')}</section>`;
  }

  function renderPage() {
    renderSidebar();
    $$('[data-nav]').forEach(link => {
      const active = link.dataset.nav === currentRoute;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    });
    $('#page-crumb').textContent = TITLES[currentRoute];
    document.title = `${TITLES[currentRoute]} · 知序`;
    const renders = { dashboard: renderDashboard, banks: renderBanks, paper: renderPaperPage, mistakes: () => renderCollection('mistakes'), favorites: () => renderCollection('favorites'), stats: renderStatsPage };
    $('#main').innerHTML = renders[currentRoute]();
    if (currentRoute === 'paper') updatePaperPreview();
  }

  function navigate() {
    const requested = location.hash.slice(1).split('?')[0] || 'dashboard';
    currentRoute = Object.hasOwn(TITLES, requested) ? requested : 'dashboard';
    listCategory = '全部';
    renderPage();
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  function goToBanks() {
    if (currentRoute === 'banks') renderPage(); else location.hash = 'banks';
  }

  function shuffle(items) { return Core.shuffle(items); }

  function parkSession() {
    cancelAllAPI();
    clearInterval(sessionInterval);
    if (state.session) {
      pauseTimer();
      state.session.timer = Core.pauseClock(state.session.timer);
      state.progress[state.session.key] = state.session;
    }
    saveState();
    activeStartedAt = 0;
  }

  function continueProgress(key) {
    const saved = state.progress[key];
    if (!saved) return false;
    parkSession();
    $('#practice-config-dialog').close();
    completedSession = null;
    if (saved.status === 'completed') {
      state.session = null; completedSession = saved; renderSummary();
      if (!$('#practice-dialog').open) $('#practice-dialog').showModal();
      saveState(); return true;
    }
    state.session = saved;
    openPractice(); return true;
  }

  function entryControls(key, resume, restart) {
    const saved = state.progress[key];
    return `<div class="entry-actions"><button type="button" class="button primary" data-entry-continue="${key}" ${key === 'paper' && !saved ? 'disabled' : ''}>${saved?.status === 'completed' ? '查看结果' : resume}</button><button type="button" class="button" data-entry-restart="${key}">${restart}</button></div>`;
  }

  function startSession(ids, title, options = {}) {
    const key = options.key || 'legacy';
    if (state.progress[key] && !options.restart) return continueProgress(key);
    if (state.progress[key] && !options.confirmed && !confirmRestart()) return false;
    if (!ids.length) { showToast('这里暂时没有可练习的题目。', 'help'); return false; }
    if (new Set(ids).size !== ids.length || ids.some(id => !QUESTION_MAP.has(id))) throw new Error('练习题目校验失败。');
    const mode = ['countdown', 'none'].includes(options.timerMode) ? options.timerMode : 'stopwatch';
    const minutes = options.minutes ?? 60;
    if (mode === 'countdown' && (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440)) throw new Error('倒计时须为 1～1440 分钟的整数。');
    parkSession();
    state.session = { key, mode: Object.hasOwn(STUDY_MODES, options.studyMode) ? options.studyMode : 'practice', status: 'active', ids: [...ids], title, index: 0, answers: [], draft: [], elapsed: 0,
      timer: { mode, limitMs: mode === 'countdown' ? minutes * 60000 : 0, elapsedMs: 0, runningSince: null } };
    completedSession = null;
    currentSelection = [];
    saveState();
    $('#practice-config-dialog').close();
    openPractice();
    return true;
  }

  function openPractice() {
    if (!state.session) return;
    if (Core.clockExpired(state.session.timer)) { finishSession('timeout'); return; }
    const answered = state.session.answers[state.session.index];
    currentSelection = [...(answered?.selection ?? state.session.draft ?? [])];
    questionElapsed = state.session.elapsed ?? 0;
    activeStartedAt = answered ? 0 : Date.now();
    state.session.timer = Core.resumeClock(state.session.timer);
    saveState();
    renderPractice();
    if (!$('#practice-dialog').open) $('#practice-dialog').showModal();
    clearInterval(sessionInterval);
    sessionInterval = setInterval(updateSessionClock, 250);
    updateSessionClock();
  }

  function pauseTimer() {
    // 尚未恢复的会话沿用磁盘中的单题用时，避免刷新或导出把它清零。
    if (!activeStartedAt) return;
    questionElapsed += Math.max(0, Date.now() - activeStartedAt);
    activeStartedAt = 0;
    if (state.session && !state.session.answers[state.session.index]) state.session.elapsed = Math.min(questionElapsed, 86400000);
  }

  function updateSessionClock() {
    const session = state.session;
    if (!session) return;
    if (Core.clockExpired(session.timer)) { finishSession('timeout'); return; }
    const output = $('#session-clock');
    if (!output) return;
    const elapsed = Core.elapsedTime(session.timer);
    const remaining = session.timer.mode === 'countdown' ? session.timer.limitMs - elapsed : elapsed;
    output.textContent = session.timer.mode === 'none' ? '不计时' : Core.formatTime(session.timer.mode === 'countdown' ? Math.ceil(remaining / 1000) * 1000 : remaining);
    output.classList.toggle('warning-text', session.timer.mode === 'countdown' && remaining <= 60000);
  }

  function practiceBlocked() {
    if (!state.session) return true;
    if (Core.clockExpired(state.session.timer)) { finishSession('timeout'); return true; }
    return state.session.timer.runningSince === null;
  }

  function toggleClock() {
    const session = state.session;
    if (!session) return;
    if (Core.clockExpired(session.timer)) { finishSession('timeout'); return; }
    if (session.timer.runningSince === null) {
      session.timer = Core.resumeClock(session.timer);
      if (!session.answers[session.index]) activeStartedAt = Date.now();
    } else {
      pauseTimer();
      session.timer = Core.pauseClock(session.timer);
    }
    saveState(); renderPractice(); updateSessionClock();
    $('[data-action="toggle-clock"]').focus({ preventScroll: true });
  }

  function finishSession(reason = 'complete') {
    const session = state.session;
    if (!session) return;
    pauseTimer();
    session.timer = Core.pauseClock(session.timer);
    if (reason === 'timeout') session.timer.elapsedMs = Math.min(session.timer.elapsedMs, session.timer.limitMs);
    if (session.mode === 'exam') {
      session.answers = Array.from(session.answers, answer => answer?.selection.length ? { ...answer, correct: isCorrect(QUESTION_MAP.get(answer.questionId), answer.selection) } : null);
      for (const answer of answeredItems(session)) recordAnswer(answer, false);
    }
    session.status = 'completed'; session.reason = reason;
    completedSession = { ...session, reason };
    state.progress[session.key] = completedSession;
    cancelAllAPI();
    state.papers.push({ title: session.title, total: session.ids.length, answered: answeredItems(session).length,
      correct: session.answers.filter(answer => answer?.correct === true).length,
      graded: session.answers.filter(answer => answer && answer.correct !== null).length,
      elapsedMs: session.timer.elapsedMs, at: Date.now(), reason });
    state.papers = state.papers.slice(-100);
    state.session = null;
    clearInterval(sessionInterval);
    saveState(); renderSummary(); renderPage();
    if (!$('#practice-dialog').open) $('#practice-dialog').showModal();
  }

  function questionNavigation() {
    const session = state.session;
    const labels = { unanswered: '未回答', answered: '已回答', correct: '答对', incorrect: '答错', neutral: '' };
    const numbers = session.ids.map((_, index) => {
      const answer = session.answers[index];
      const selection = index === session.index ? currentSelection : answer?.selection ?? session.drafts?.[index] ?? [];
      const status = session.mode === 'memorize' ? 'neutral' : session.mode === 'practice' && answer?.correct === true ? 'correct'
        : session.mode === 'practice' && answer?.correct === false ? 'incorrect' : selection.length ? 'answered' : 'unanswered';
      return `<button type="button" class="question-number status-${status}" data-jump-question="${index}" ${index === session.index ? 'aria-current="step"' : ''} aria-label="第 ${index + 1} 题${labels[status] ? '，' + labels[status] : ''}">${index + 1}</button>`;
    }).join('');
    return `<div class="question-picker-heading"><strong id="question-picker-title">选题 · ${session.ids.length} 题</strong><button class="text-button" data-action="toggle-question-picker">收起</button></div>${session.mode === 'memorize' ? '<p class="setting-note">点击题号自由跳转；背题不标记作答颜色。</p>' : `<div class="question-picker-legend"><span class="status-unanswered">未回答</span><span class="status-answered">已回答${session.mode === 'practice' ? ' / 待确认' : ''}</span>${session.mode === 'practice' ? '<span class="status-correct">答对</span><span class="status-incorrect">答错</span>' : ''}</div>`}<div class="question-number-grid">${numbers}</div>`;
  }

  function toggleQuestionPicker() {
    const panel = $('#question-picker');
    if (!panel || !state.session) return;
    const open = panel.hidden;
    panel.innerHTML = questionNavigation(); panel.hidden = !open;
    $('[data-action="toggle-question-picker"]', $('.practice-footer')).setAttribute('aria-expanded', String(open));
    if (open) {
      const current = panel.querySelector('[aria-current]');
      current?.scrollIntoView({ block: 'nearest' });
      current?.focus({ preventScroll: true });
    } else $('[data-action="toggle-question-picker"]', $('.practice-footer'))?.focus({ preventScroll: true });
  }

  function jumpQuestion(index) {
    if (!state.session || practiceBlocked() || !Number.isInteger(index) || index < 0 || index >= state.session.ids.length) return;
    moveQuestion(index);
  }

  function requestFinish(reason = 'complete') {
    const session = state.session;
    if (!session) return;
    if (Core.clockExpired(session.timer)) return finishSession('timeout');
    if (session.mode === 'exam') saveExamSelection();
    const unanswered = session.ids.flatMap((_, index) => session.answers[index]?.selection.length ? [] : [index + 1]);
    if (session.mode !== 'memorize' && unanswered.length) {
      if (!window.confirm(`还有 ${unanswered.length} 道题未作答或未确认（题号：${unanswered.slice(0, 20).join('、')}${unanswered.length > 20 ? '…' : ''}）。确定提交吗？未作答计 0 分；点击取消可使用“选题”继续作答。`)) return;
    } else if (reason === 'finish' && !window.confirm('确定结束本次练习吗？已完成的记录会保留。')) return;
    finishSession(Core.clockExpired(session.timer) ? 'timeout' : reason);
  }

  function renderPractice() {
    const session = state.session;
    if (!session) return;
    const question = QUESTION_MAP.get(session.ids[session.index]);
    const answer = session.answers[session.index];
    const multiple = question.type === 'multiple';
    const favorite = state.favorites.includes(question.id);
    const flagged = question.flags.length > 0;
    const paused = session.timer.runningSince === null;
    const memorize = session.mode === 'memorize', exam = session.mode === 'exam';
    const reveal = memorize || Boolean(answer && !exam);
    $('#practice-dialog').innerHTML = `<div class="practice-top"><div class="practice-title-wrap"><h2 id="practice-title">${escapeHTML(session.title)}</h2><p>${question.category} · ${escapeHTML(question.bankTitle)} · ${STUDY_MODES[session.mode]}</p></div><button class="icon-button" data-action="pause-practice" aria-label="保存进度并关闭">${icon('close')}</button></div>
      <div class="timer-bar"><div>${icon('clock')}<strong id="session-clock" role="timer" aria-live="off"></strong>${paused ? '<span class="small-pill">已暂停</span>' : ''}</div><div><button class="text-button" data-action="toggle-clock">${paused ? '继续练习' : '暂停练习'}</button><button class="text-button warning-text" data-action="finish-early">${exam ? '提前交卷' : '结束本次'}</button></div></div>
      <div class="progress-track practice-progress"><span style="width:${percent(answeredItems(session).length, session.ids.length)}%"></span></div>
      <div class="practice-scroll">${paused ? '<div class="paused-content"><h3>练习已暂停</h3><p>点击「继续练习」恢复当前题目。</p></div>' : `<div class="practice-body"><div class="practice-meta"><div class="question-labels"><span class="question-type type-${question.type}">${questionType(question)} · ${multiple ? '可选多项' : '只能选一项'}</span><span>第 ${question.position ?? question.sourceNumber} 题</span>${exam ? '' : `<button class="text-button" data-edit="${question.id}">编辑题目</button><button class="text-button" data-add-after="${question.id}">新增题目</button><button class="text-button warning-text" data-delete-question="${question.id}">删除题目</button>`}</div><span class="practice-count"><strong>${session.index + 1}</strong> / ${session.ids.length}</span></div>
      ${flagged ? `<div class="source-warning"><p>${exam ? '本题存在格式疑点，结算时不计分。' : question.flags.map(escapeHTML).join('；') + '。本题不判分。'}</p></div>` : ''}
      <h3 class="question-title" id="question-title">${escapeHTML(question.text)}</h3><p class="question-hint">${memorize ? '背题模式：答案已标出，不计成绩；可使用上一题、下一题阅读。' : exam ? '选择会自动保存，点击下一题或选题切换；可返回修改，交卷前不判分。' : answer ? '判分已标注在选项中；解析见下方。' : multiple ? '请选择所有符合题意的选项，再确认选择。' : '请选择一个选项，再确认选择。'}</p>
      <div class="answer-options" role="group" aria-labelledby="question-title">${question.options.map((option, index) => {
        const selected = currentSelection.includes(index);
        const correct = reveal && !flagged && question.answer.includes(index);
        const incorrect = reveal && !flagged && !memorize && selected && !question.answer.includes(index);
        return `<label class="answer-option ${selected ? 'selected' : ''} ${(answer && !exam) || memorize ? 'locked' : ''} ${correct ? 'correct' : ''} ${incorrect ? 'incorrect' : ''}"><input type="${multiple ? 'checkbox' : 'radio'}" name="practice-answer" value="${index}" ${selected ? 'checked' : ''} ${(answer && !exam) || memorize ? 'disabled' : ''}><span class="option-letter">${escapeHTML(question.optionLabels[index])}</span><span class="option-text">${escapeHTML(option)}</span>${correct ? '<span class="option-verdict">✓ 正确答案</span>' : incorrect ? '<span class="option-verdict">✕ 你的选择</span>' : '<span class="option-verdict" aria-hidden="true"></span>'}</label>`;
      }).join('')}</div>
      ${exam ? '<p class="setting-note exam-notice">考试中隐藏正确答案、解析、编辑及 API 分析，交卷后只显示错误和未作答题的答案与解析。纯前端模式仅提供练习体验，不作为防作弊考试系统。</p>' : renderAPIPanel(question, reveal)}
      </div>`}</div>
      <section id="question-picker" class="question-picker" aria-labelledby="question-picker-title" hidden></section>
      <div class="practice-footer"><div class="practice-footer-left"><button class="favorite-button ${favorite ? 'active' : ''}" data-practice-favorite="${question.id}" aria-pressed="${favorite}">${icon('star')}<span>${favorite ? '已收藏' : '收藏'}</span></button><button class="favorite-button" data-action="toggle-question-picker" aria-expanded="false" aria-controls="question-picker" ${paused ? 'disabled' : ''}>${icon('grid')}<span>选题</span></button></div><div class="practice-footer-right"><button class="button" data-action="previous-question" ${paused || session.index === 0 ? 'disabled' : ''}>上一题</button>${!answer && !memorize && !exam ? `<button class="button primary" id="submit-answer" data-action="submit-answer" ${paused || (!flagged && !currentSelection.length) ? 'disabled' : ''}>确认</button>` : ''}<button class="button ${answer || memorize || exam ? 'primary' : ''}" data-action="next-question" ${paused ? 'disabled' : ''}>${session.index === session.ids.length - 1 ? exam ? '交卷' : '完成' : '下一题'}</button></div></div>`;
    updateSessionClock();
  }

  function recordAnswer(answer, notify = true) {
    state.attempts.push({ ...answer, at: Date.now() });
    const wasMistake = Boolean(state.mistakes[answer.questionId]);
    state.mistakes = Store.recordMistake(state.mistakes, answer.questionId, answer.correct, state.mistakeTarget);
    if (notify && wasMistake && !state.mistakes[answer.questionId]) showToast(`累计答对已达到 ${state.mistakeTarget} 次，已自动移出错题本。`);
  }

  function submitAnswer() {
    if (practiceBlocked()) return;
    const session = state.session;
    if (session.answers[session.index]) return;
    const question = QUESTION_MAP.get(session.ids[session.index]);
    if (!validSelection(currentSelection, question, Boolean(question.flags.length))) return;
    pauseTimer();
    if (session.mode === 'memorize') return;
    const answer = {
      questionId: question.id, selection: [...currentSelection].sort((a, b) => a - b),
      correct: session.mode === 'exam' ? null : isCorrect(question, currentSelection), seconds: session.timer.mode === 'none' ? 0 : Math.min(3600, Math.max(1, Math.round(questionElapsed / 1000)))
    };
    session.answers[session.index] = answer;
    session.draft = [];
    session.elapsed = 0;
    if (session.mode !== 'exam') recordAnswer(answer);
    saveState();
    renderPractice();
    $('[data-action="next-question"]', $('#practice-dialog'))?.focus({ preventScroll: true });
    renderSidebar();
  }

  function saveExamSelection() {
    const session = state.session;
    if (!session || session.mode !== 'exam') return;
    const question = QUESTION_MAP.get(session.ids[session.index]);
    if (!validSelection(currentSelection, question, true)) return;
    pauseTimer();
    const previous = session.answers[session.index];
    session.answers[session.index] = currentSelection.length ? { questionId: question.id, selection: [...currentSelection].sort((a, b) => a - b), correct: null,
      seconds: previous?.seconds ?? (session.timer.mode === 'none' ? 0 : Math.min(3600, Math.max(1, Math.round(questionElapsed / 1000)))) } : null;
    session.draft = [...currentSelection];
    saveState();
  }

  function moveQuestion(index) {
    const session = state.session;
    if (session.mode === 'exam') saveExamSelection();
    pauseTimer();
    if (!session.answers[session.index]) {
      session.drafts ??= {};
      session.drafts[session.index] = [...currentSelection];
    }
    cancelAllAPI();
    session.index = index;
    session.draft = [...(session.answers[index]?.selection ?? session.drafts?.[index] ?? [])];
    currentSelection = [...session.draft];
    session.elapsed = 0; questionElapsed = 0;
    activeStartedAt = session.answers[index] ? 0 : Date.now();
    saveState(); renderPractice();
    $('#practice-dialog .practice-scroll')?.scrollTo(0, 0);
    $('#question-title')?.setAttribute('tabindex', '-1');
    $('#question-title')?.focus({ preventScroll: true });
  }

  function previousQuestion() {
    if (practiceBlocked() || state.session.index === 0) return;
    if (state.session.mode === 'exam' && currentSelection.length) saveExamSelection();
    moveQuestion(state.session.index - 1);
  }

  function nextQuestion() {
    if (practiceBlocked()) return;
    const session = state.session;
    if (session.mode === 'exam') saveExamSelection();
    if (session.mode === 'memorize' && !session.answers[session.index]) {
      session.answers[session.index] = { questionId: session.ids[session.index], selection: [], correct: null, seconds: 0 };
    }
    if (session.index === session.ids.length - 1) { requestFinish('complete'); return; }
    moveQuestion(session.index + 1);
  }

  function renderSummary() {
    const session = completedSession;
    if (!session) return;
    const correct = session.answers.filter(answer => answer?.correct === true).length;
    const graded = session.answers.filter(answer => answer && answer.correct !== null).length;
    const eligible = session.ids.filter(id => !QUESTION_MAP.get(id).flags.length).length;
    const score = session.mode === 'memorize' || !eligible ? '—' : (correct / eligible * 100).toFixed(1);
    $('#practice-dialog').innerHTML = `<div class="practice-top"><div class="practice-title-wrap"><h2 id="practice-title">${STUDY_MODES[session.mode]} · ${session.reason === 'timeout' ? '时间到，已交卷' : '本次结果'}</h2><p>${escapeHTML(session.title)}</p></div><button class="icon-button" data-close="practice-dialog" aria-label="关闭结果">${icon('close')}</button></div><div class="practice-scroll"><div class="summary-body"><h3>${session.mode === 'memorize' ? '背题进度已保存，不计成绩。' : `本次得分：${score} / 100`}</h3><p>已完成 ${answeredItems(session).length} / ${session.ids.length} 题。按整卷可判分题等权计分，未作答计 0 分；格式疑问题不计入分母。背题不影响错题累计答对次数。</p><div class="summary-stats"><div><strong>${correct} / ${graded}</strong><span>答对 / 已判分</span></div><div><strong>${session.timer.mode === 'none' ? '不计时' : Core.formatTime(session.timer.elapsedMs)}</strong><span>本次用时</span></div></div><div class="summary-actions"><button class="button primary" data-restart-session="${session.key}">重新开始这组题</button></div></div>
      ${session.mode === 'exam' ? `<section class="exam-review"><h3>错题与未作答题解析</h3>${session.ids.map((id, index) => {
        const question = QUESTION_MAP.get(id), answer = session.answers[index];
        if (answer?.correct === true || question.flags.length) return '';
        return `<article class="review-question"><div class="question-type type-${question.type}">${questionType(question)} · ${index + 1}</div><h4>${escapeHTML(question.text)}</h4><p>你的选择：${answer?.selection.length ? answer.selection.map(i => escapeHTML(question.optionLabels[i])).join('、') : '未作答 / 背题'} · 判分答案：${escapeHTML(question.referenceAnswer || '缺失')}</p><div class="review-options">${question.options.map((option, i) => `<p class="${question.answer.includes(i) ? 'review-correct' : ''}">${escapeHTML(question.optionLabels[i])}. ${escapeHTML(option)}${question.answer.includes(i) ? ' ✓' : ''}</p>`).join('')}</div><p class="analysis-text">${escapeHTML(question.explanation || '原文未提供逐题解析，可调用 API 辅助核对。')}</p>${question.apiAnalysis ? `<h5>已保存的 API 分析</h5><p class="analysis-text">${escapeHTML(question.apiAnalysis.text)}</p>` : ''}</article>`;
      }).join('') || '<p>全部答对，没有需要复盘的错题。</p>'}</section>` : ''}</div><div class="practice-footer"><button class="button" data-close="practice-dialog">关闭结果</button></div>`;
  }

  function toggleFavorite(id) {
    if (!QUESTION_MAP.has(id)) return;
    const exists = state.favorites.includes(id);
    state.favorites = exists ? state.favorites.filter(value => value !== id) : [...state.favorites, id];
    saveState();
    showToast(exists ? '已取消收藏。' : '已加入收藏，值得回顾的知识不会走丢。', 'star');
    const practiceButton = $('[data-practice-favorite]');
    if ($('#practice-dialog').open && practiceButton?.dataset.practiceFavorite === id) {
      practiceButton.classList.toggle('active', !exists);
      practiceButton.setAttribute('aria-pressed', String(!exists));
      $('span', practiceButton).textContent = exists ? '收藏题目' : '已收藏';
    } else renderPage();
  }

  function renderSettings() {
    const selected = PRESETS.find(preset => Object.entries(preset.colors).every(([key, value]) => state.theme[key].toLowerCase() === value));
    $('#settings-dialog').innerHTML = `<div class="dialog-heading"><div><span class="eyebrow">MAKE IT YOURS</span><h2 id="settings-title">设置与偏好</h2></div><button class="icon-button" data-close="settings-dialog" aria-label="关闭外观设置">${icon('close')}</button></div><p class="settings-intro">请按需要配置外观、题库版本和 API。配色与练习进度自动续存；命名版本需要点击保存并勾选内容。</p>
      ${renderVersionSelector()}<section class="setting-section"><h3>API 与使用帮助</h3><div class="backup-actions"><button class="button" data-action="api">${icon('code')}API 调用设置</button><button class="button" data-action="show-guide">重新查看引导</button></div><p class="setting-note">API 仅在主动请求时联网，可能产生费用，密钥只保存在你选择的本机存储中。</p><button class="danger-link" data-action="reset-data">清空当前版本学习记录</button></section>
      <section class="setting-section"><h3>选择一份心情</h3><div class="preset-grid">${PRESETS.map(preset => `<button class="preset ${selected?.id === preset.id ? 'active' : ''}" data-preset="${preset.id}" aria-pressed="${selected?.id === preset.id}"><span class="preset-swatch"><i style="background:${preset.colors.accent}"></i><i style="background:${preset.colors.background};border:1px solid #00000008"></i></span><span>${preset.name}</span></button>`).join('')}</div></section>
      <section class="setting-section"><h3>自定义界面颜色</h3><div class="color-inputs">${[['accent', '强调色'], ['background', '页面背景'], ['surface', '卡片背景'], ['text', '文字颜色']].map(([key, title]) => `<label class="color-field"><input type="color" data-color="${key}" value="${state.theme[key]}" aria-label="${title}"><span>${title}</span><small class="color-value" data-color-value="${key}">${state.theme[key].toUpperCase()}</small></label>`).join('')}</div><p class="setting-note" id="contrast-note">按钮文字会随强调色自动适配。建议为文字与背景保留足够的对比度。</p></section>
      <section class="setting-section"><h3>每日练习目标</h3><label class="goal-row"><input type="range" id="goal-input" min="5" max="100" step="1" value="${state.goal}" aria-label="每日练习题数"><output class="goal-value" for="goal-input">${state.goal} 题</output></label><p class="setting-note">按自己的节奏来，少一点也没关系。完成一道题就会计入今日目标。</p></section>
      <div class="settings-footer"><button class="button ghost" data-action="reset-theme">${icon('reset')}恢复默认配色</button><button class="button primary" data-close="settings-dialog">完成设置${icon('check')}</button></div>`;
    updateContrastNote();
  }

  function updateContrastNote() {
    const note = $('#contrast-note');
    if (!note) return;
    const text = luminance(state.theme.text);
    const contrast = ['surface', 'background'].map(key => {
      const background = luminance(state.theme[key]);
      return (Math.max(text, background) + .05) / (Math.min(text, background) + .05);
    });
    note.textContent = Math.min(...contrast) < 4.5 ? '当前文字与背景的对比度偏低，建议加深文字颜色或调亮背景，以便阅读。' : '按钮文字会随强调色自动适配。当前正文与背景的对比度适合阅读。';
  }

  function exportBackup() {
    // 本地草稿可能包含自定义题目、单独失败的学习记录；恢复导出必须一起保留。
    if (preserveUnreadLibrary) {
      try {
        const stored = {};
        for (let index = 0; index < localStorage.length; index++) {
          const key = localStorage.key(index);
          if (key === 'zhixu-library-versions-v1' || key === LIBRARY_KEY || key.startsWith('zhixu-library-draft-v1-') || key.startsWith('zhixu-study-v')) stored[key] = localStorage.getItem(key);
        }
        if (!Object.keys(stored).length) return showToast('没有可导出的原存储内容。', 'help');
        downloadFile(JSON.stringify({ format: 'zhixu-storage-recovery', stored }, null, 2), `知序-待读取存储副本-${todayKey()}.json`, 'application/json;charset=utf-8');
        showToast('已导出原题库、草稿和学习存储，未包含 API 配置；这是恢复副本，不是普通导入文件。');
      } catch { showToast('浏览器不允许读取原存储。', 'help'); }
      return;
    }
    if (preserveUnreadStorage) {
      try {
        const storedStudy = localStorage.getItem(STORAGE_KEY);
        downloadFile(JSON.stringify({ format: 'zhixu-storage-recovery', storageKey: STORAGE_KEY, storedStudy, pendingStudy: state,
          library: Store.validateLibrary(library, baseline) }, null, 2), `知序-学习记录恢复副本-${todayKey()}.json`, 'application/json;charset=utf-8');
        showToast('已导出原存储字符串及临时进度恢复副本；原存储未改动。这不是普通题库导入文件。');
      } catch { showToast('无法读取受保护原记录，恢复副本未生成；请勿清空数据。', 'help'); }
      return;
    }
    if (!library) return openLibrary();
    const session = state.session ? { ...state.session, elapsed: activeStartedAt ? Math.min(86400000, questionElapsed + Math.max(0, Date.now() - activeStartedAt)) : state.session.elapsed,
      timer: Core.pauseClock(state.session.timer) } : null;
    // API 配置独立存储；只导出题目、解析和学习状态，绝不混入密钥或请求模板。
    downloadFile(JSON.stringify({ format: 'zhixu-library', version: 3, library: Store.validateLibrary(library, baseline),
      study: { ...state, session, progress: { ...state.progress, ...(session ? { [session.key]: session } : {}) } }, exportedAt: new Date().toISOString() }, null, 2),
      `知序-题库与解析-${todayKey()}.json`, 'application/json;charset=utf-8');
    showToast('JSON 已生成，包含修改后的题目、解析及学习记录，不含 API 配置。', 'download');
  }

  async function importBackup(file) {
    if (!file) return;
    if (!baseline) return openLibrary();
    if (file.size > 15 * 1024 * 1024) return showToast('文件超过 15 MB，请选择有效的知序 JSON。', 'help');
    try {
      const raw = JSON.parse(await file.text());
      const envelope = raw?.format === 'zhixu-library';
      if (envelope && raw.version !== 3) throw new Error('不支持此 JSON 版本。');
      const nextLibrary = Store.validateLibrary(envelope ? raw.library : raw, baseline);
      if (!repository || preserveUnreadLibrary) throw new Error('原版本存储尚未恢复，已阻止导入覆盖。');
      const imported = envelope && raw.study ? normalizeState(raw.study, nextLibrary) : defaultState(nextLibrary.id);
      if (envelope && raw.study && (imported.attempts.length !== raw.study.attempts?.length || imported.favorites.length !== raw.study.favorites?.length || (raw.study.session && !imported.session))) throw new Error('学习记录格式不完整，未导入。');
      const name = window.prompt('为导入版本命名。原版本保留，可随时切回默认版。', file.name.replace(/\.json$/i, '').slice(0, 80));
      if (!name?.trim()) return;
      if (preserveUnreadStorage) {
        if (!window.confirm('原学习记录保持保护；导入只创建新版本，不覆盖旧记录。当前临时进度不迁移，确定继续吗？')) return;
      } else {
        parkSession();
        if (!saveState()) throw new Error('当前进度未能保存，请先备份。');
      }
      if (imported.session) imported.session.timer = Core.pauseClock(imported.session.timer);
      repository.add(name.trim().slice(0, 80), nextLibrary, imported);
      adoptVersion();
      showToast('已导入为独立版本，原版本与进度均保留，可随时切换。');
    } catch (error) { showToast(error instanceof SyntaxError ? '文件不是有效的 JSON，当前数据未改变。' : `导入失败：${error.message}`, 'help'); }
  }

  const actions = {
    theme: () => { pauseForDialog(); renderSettings(); $('#settings-dialog').showModal(); },
    'save-version': () => openSnapshot(false),
    'rename-version': () => {
      if (!repository || repository.activeId === 'default') return;
      const old = repository.list().find(item => item.id === repository.activeId).name;
      const name = window.prompt('修改版本名称（最多 80 字）', old);
      if (name === null) return;
      try { repository.rename(repository.activeId, name); renderSettings(); showToast('名称已修改。'); }
      catch (error) { showToast(error.message, 'help'); }
    },
    'add-bank': () => {
      const title = window.prompt('新增单元名称（仅保存在当前版本的本机草稿中）');
      if (!title?.trim()) return;
      try { persistLibrary(Store.addBank(library, title.trim(), baseline)); expandedUnits.clear(); expandedUnits.add(BANKS.at(-1).id); renderPage(); showToast('已增加单元，可展开新增题目。保存版本时请勾选题库内容。'); }
      catch (error) { showToast(error.message, 'help'); }
    },
    help: () => $('#help-dialog').showModal(),
    api: openAPI,
    library: openLibrary,
    'mistake-paper': openMistakePaper,
    'list-models': () => apiNetworkTest(true),
    'clear-model-search': () => { $('#api-model-search').value = ''; renderAPIModels(); $('#api-model-search').focus(); },
    'test-api': () => apiNetworkTest(false),
    'save-api-preset': saveAPIPreset,
    'delete-api-preset': deleteAPIPreset,
    'delete-version': () => {
      if (!repository || repository.activeId === 'default') return;
      if (!window.confirm('确定删除当前导入/修改版本及其进度？建议先导出 JSON。默认版不受影响。')) return;
      if (!window.confirm('请再次确认：此版本的题库、草稿和学习记录将被删除，其他版本保留。确定继续吗？')) return;
      try { parkSession(); repository.remove(repository.activeId); adoptVersion(); showToast('版本已删除，已切回默认版。'); }
      catch (error) { showToast(error.message, 'help'); }
    },
    'clear-api': () => {
      cancelAllAPI(); apiConfig = API.defaults();
      try { localStorage.removeItem(API_KEY); } catch { showToast('无法清除浏览器保存的配置，请检查存储权限。', 'help'); }
      openAPI();
    },
    'add-option': () => {
      const count = $$('[data-edit-option]').length;
      if (count >= 8) return showToast('最多支持 8 个选项。', 'help');
      $('#edit-options').insertAdjacentHTML('beforeend', editorOption(count, '', false, $('#edit-type').value));
    },
    'reset-weights': () => {
      paperDraft.weights = defaultWeights();
      $$('[data-weight]').forEach((input, index) => { input.value = paperDraft.weights[index]; });
      updatePaperPreview();
    },
    'reset-type-weights': () => {
      $$('[data-type-weight]').forEach((input, index) => { input.value = [60, 30, 10][index]; });
      updatePaperPreview();
    },
    'toggle-clock': toggleClock,
    'toggle-question-picker': toggleQuestionPicker,
    'finish-early': () => requestFinish('finish'),
    'resume-from-config': () => { $('#practice-config-dialog').close(); openPractice(); },
    daily: () => {
      if (!library) return openLibrary();
      const ids = shuffle(QUESTIONS.filter(question => !question.flags.length).map(question => question.id)).slice(0, 10);
      openCollectionSetup('daily', ids, `每日练习 · ${ids.length} 题`);
    },
    random: () => {
      if ($('#practice-dialog').open) $('#practice-dialog').close();
      if (currentRoute === 'paper') renderPage(); else location.hash = 'paper';
    },
    resume: openPractice,
    'go-banks': goToBanks,
    'clear-search': () => {
      searchQuery = '';
      category = '全部';
      renderPage();
      $('#bank-search')?.focus();
    },
    'submit-answer': submitAnswer,
    'next-question': nextQuestion,
    'previous-question': previousQuestion,
    'pause-practice': () => $('#practice-dialog').close(),
    'review-mistakes': () => openCollectionSetup('mistakes', getStats().mistakes.filter(id => listCategory === '全部' || QUESTION_MAP.get(id).category === listCategory), '错题复习'),
    'review-favorites': () => openCollectionSetup('favorites', state.favorites.filter(id => listCategory === '全部' || QUESTION_MAP.get(id).category === listCategory), '收藏练习'),
    'retry-wrong': () => {
      const ids = completedSession?.answers.filter(answer => answer?.correct === false).map(answer => answer.questionId) ?? [];
      startSession(ids, '错题巩固 · 再进一步');
    },
    'summary-more': () => actions.random(),
    'reset-theme': () => {
      state.theme = { ...PRESETS[0].colors };
      applyTheme(); saveState(); renderSettings();
      showToast('已恢复松间绿默认配色。');
    },
    export: () => openSnapshot(true),
    import: () => $('#import-file').click(),
    'reset-data': () => {
      if (!window.confirm('确定清空当前版本的答题记录、错题、收藏和所有练习进度吗？此操作无法撤销，建议先导出备份。其他版本、配色和每日目标保留。')) return;
      try { studySnapshots.set(STORAGE_KEY, localStorage.getItem(STORAGE_KEY)); }
      catch { return showToast('无法读取原记录，未执行清空。', 'help'); }
      preserveUnreadStorage = false;
      storageFailed = false;
      state.attempts = [];
      state.mistakes = {};
      cancelAllAPI();
      state.papers = [];
      state.favorites = [];
      state.session = null;
      state.progress = {};
      completedSession = null;
      currentSelection = [];
      activeStartedAt = 0; questionElapsed = 0;
      clearInterval(sessionInterval);
      saveState(); renderPage(); renderSettings();
      showToast('学习记录已清空，新的开始也值得期待。');
    }
  };

  document.addEventListener('toggle', event => {
    const details = event.target;
    if (!details.matches?.('[data-bank-details]')) return;
    if (details.open) { expandedUnits.clear(); expandedUnits.add(details.dataset.bankDetails); }
    else expandedUnits.delete(details.dataset.bankDetails);
  }, true);

  document.addEventListener('click', event => {
    const target = event.target.closest('button');
    if (!target || target.disabled) return;
    if (target.dataset.renameBank) { renameBank(target.dataset.renameBank); return; }
    if (target.dataset.deleteBank) { deleteContent('bank', target.dataset.deleteBank); return; }
    if (target.dataset.deleteQuestion) { deleteContent('question', target.dataset.deleteQuestion); return; }
    if (target.hasAttribute('data-jump-question')) { jumpQuestion(Number(target.dataset.jumpQuestion)); return; }
    if (target.dataset.unitContinue) { enterUnit(target.dataset.unitContinue); return; }
    if (target.dataset.unitRestart) { enterUnit(target.dataset.unitRestart, true); return; }
    if (target.dataset.addBankQuestion) { openNewQuestion(target.dataset.addBankQuestion); return; }
    if (target.dataset.addAfter) { const q = QUESTION_MAP.get(target.dataset.addAfter); if (q) openNewQuestion(q.bankId, q.id); return; }
    if (target.dataset.entryContinue) {
      const key = target.dataset.entryContinue;
      if (key === 'paper') continueProgress(key); else enterCollection(key);
      return;
    }
    if (target.dataset.entryRestart) {
      const key = target.dataset.entryRestart;
      if (key === 'paper') {
        if (!confirmRestart()) return;
        paperRestartReady = true; updatePaperPreview();
        $('#paper-restart-note').textContent = '已确认重新抽取，请调整设置后生成；离开前原进度仍然保留。';
        $('#paper-practice-settings').scrollIntoView({ block: 'start', behavior: 'smooth' });
        $('#paper-practice-settings').focus({ preventScroll: true });
      } else enterCollection(key, true);
      return;
    }
    if (target.dataset.continue) { continueProgress(target.dataset.continue); return; }
    if (target.dataset.restartSession) {
      const saved = state.progress[target.dataset.restartSession];
      if (saved) {
        if (!confirmRestart()) return;
        $('#practice-dialog').close();
        if (saved.key.startsWith('unit:')) openUnitSetup(saved.key.slice(5), true);
        else if (saved.key === 'paper') {
          paperRestartReady = true;
          if (currentRoute !== 'paper') location.hash = 'paper'; else renderPage();
          requestAnimationFrame(() => $('#paper-practice-settings')?.scrollIntoView({ block: 'start' }));
        } else if (saved.key === 'mistake-paper') openMistakePaper(true);
        else openCollectionSetup(saved.key, saved.ids, saved.title, true);
      }
      return;
    }
    if (target.dataset.edit) { openEditor(target.dataset.edit); return; }
    if (target.dataset.analyze) { analyzeQuestion(target.dataset.analyze); return; }
    if (target.dataset.cancelApi) { cancelAPI(target.dataset.cancelApi); return; }
    if (target.dataset.removeMistake) { removeMistake(target.dataset.removeMistake); return; }
    if (target.hasAttribute('data-remove-option')) {
      if ($$('[data-edit-option]').length <= 2) return showToast('至少保留两个选项。', 'help');
      target.closest('.editor-option').remove();
      $$('.editor-option').forEach((row, index) => {
        $('.editor-correct span', row).textContent = String.fromCharCode(65 + index);
        $('[data-edit-option]', row).setAttribute('aria-label', `选项 ${index + 1} 内容`);
        $('[data-edit-correct]', row).setAttribute('aria-label', `选项 ${index + 1} 为正确答案`);
      });
      return;
    }
    if (target.dataset.close) {
      const id = target.dataset.close;
      $(`#${id}`).close();
      if (id === 'practice-dialog' && completedSession) location.hash = 'dashboard';
    } else if (target.dataset.action && actions[target.dataset.action]) {
      actions[target.dataset.action]();
    } else if (target.dataset.unit) {
      openUnitSetup(target.dataset.unit, target.dataset.order);
    } else if (target.dataset.category) {
      category = target.dataset.category;
      $$('[data-category]').forEach(button => {
        const active = button.dataset.category === category;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
      });
      $('#bank-results').innerHTML = renderBankResults();
    } else if (target.dataset.listCategory) {
      listCategory = target.dataset.listCategory;
      renderPage();
    } else if (target.dataset.question) {
      openCollectionSetup(`question:${target.dataset.question}`, [target.dataset.question], '单题练习');
    } else if (target.dataset.favorite || target.dataset.practiceFavorite) {
      toggleFavorite(target.dataset.favorite || target.dataset.practiceFavorite);
    } else if (target.dataset.preset) {
      const preset = PRESETS.find(item => item.id === target.dataset.preset);
      state.theme = { ...preset.colors };
      applyTheme(); saveState(); renderSettings();
      $(`[data-preset="${preset.id}"]`).focus({ preventScroll: true });
    }
  });

  document.addEventListener('submit', event => {
    if (event.target.id === 'snapshot-form') { event.preventDefault(); if (event.target.reportValidity()) saveSnapshot(event.target); return; }
    if (event.target.id === 'collection-form') {
      event.preventDefault();
      if (!collectionSetup || !event.target.reportValidity()) return;
      const { ids, key, title, restart } = collectionSetup;
      try { startSession(choice('collection-order') === 'shuffle' ? shuffle(ids) : ids, title, { key, restart, confirmed: restart, studyMode: choice('unit-mode'), timerMode: choice('unit-timer'), minutes: Number($('#unit-minutes').value) }); }
      catch (error) { showToast(error.message, 'help'); }
      return;
    }
    if (['api-form', 'editor-form', 'mistake-rule-form', 'mistake-paper-form'].includes(event.target.id)) {
      event.preventDefault();
      if (!event.target.reportValidity()) return;
      if (event.target.id === 'api-form') return saveAPI(event.target);
      if (event.target.id === 'editor-form') return saveEditor();
      if (event.target.id === 'mistake-rule-form') {
        const target = Number(event.target.elements.target.value);
        if (!Number.isInteger(target) || target < 1 || target > 100) return;
        state.mistakeTarget = target; saveState(); renderPage(); showToast('错题移出规则已保存，从下次答对起生效。'); return;
      }
      const restart = event.target.dataset.restart === 'true';
      if (event.target.id === 'mistake-paper-form' && state.progress['mistake-paper'] && !restart) { continueProgress('mistake-paper'); return; }
      const ids = getStats().mistakes.filter(id => !QUESTION_MAP.get(id).flags.length);
      const count = Number($('#mistake-paper-count').value);
      if (!Number.isInteger(count) || count < 1 || count > ids.length) return showToast('抽题数量超出当前错题本可用题量。', 'help');
      try { startSession(shuffle(ids).slice(0, count), `错题独立组卷 · ${count} 题`, { key: 'mistake-paper', restart, confirmed: restart, studyMode: choice('unit-mode'), timerMode: choice('unit-timer'), minutes: Number($('#unit-minutes').value) }); }
      catch (error) { showToast(error.message, 'help'); }
      return;
    }
    if (!['paper-form', 'unit-form'].includes(event.target.id)) return;
    event.preventDefault();
    try {
      if (event.target.id === 'paper-form') {
        if (state.progress.paper && !paperRestartReady) { continueProgress('paper'); return; }
        updatePaperPreview();
        if ($('#paper-start').disabled || !event.target.reportValidity()) return;
        const paper = Core.makeConfiguredPaper(BANKS, paperDraft);
        if (startSession(paper.ids, `随机组题 · ${paper.ids.length} 题`, { ...paperDraft, key: 'paper', restart: paperRestartReady, confirmed: paperRestartReady })) {
          paperRestartReady = false;
          state.preferences = { ...paperDraft, weights: [...paperDraft.weights], typeWeights: [...paperDraft.typeWeights] };
          saveState();
        }
      } else {
        if (!pendingUnit) return;
        const key = `unit:${pendingUnit.id}`;
        const restart = event.target.dataset.restart === 'true';
        if (state.progress[key] && !restart) { continueProgress(key); return; }
        if (!event.target.reportValidity()) return;
        const order = $('[name="unit-order"]:checked').value;
        const ids = pendingUnit.questions.map(question => question.id);
        startSession(order === 'shuffle' ? shuffle(ids) : ids, `${pendingUnit.label} · ${pendingUnit.title} · ${order === 'shuffle' ? '乱序' : '顺序'}`,
          { key, restart, confirmed: restart, studyMode: choice('unit-mode'), timerMode: choice('unit-timer'), minutes: Number($('#unit-minutes').value) });
      }
    } catch (error) { showToast(error.message, 'help'); }
  });

  function handleAPIField(input) {
    if (!input.closest('#api-form')) return false;
    if (['endpoint', 'key', 'headersText', 'mode'].includes(input.name)) resetAPIModels();
    else if (input.id === 'api-model-search') renderAPIModels();
    else if (input.id === 'api-models' && apiModelIds.includes(input.value)) $('#api-form').elements.model.value = input.value;
    else if (input.name === 'model') $('#api-models').value = input.value;
    return true;
  }

  document.addEventListener('input', event => {
    const input = event.target;
    if (handleAPIField(input)) return;
    if (input.closest('#paper-form')) { updatePaperPreview(); return; }
    if (input.id === 'bank-search') {
      searchQuery = input.value;
      $('#bank-results').innerHTML = renderBankResults();
    } else if (input.dataset.color) {
      const key = input.dataset.color;
      if (!validColor(input.value) || !Object.hasOwn(state.theme, key)) return;
      state.theme[key] = input.value;
      applyTheme(); saveState();
      $(`[data-color-value="${key}"]`).textContent = input.value.toUpperCase();
      $$('.preset').forEach(button => { button.classList.remove('active'); button.setAttribute('aria-pressed', 'false'); });
      updateContrastNote();
    } else if (input.id === 'goal-input') {
      state.goal = clamp(Number(input.value), 5, 100);
      $('.goal-value').textContent = `${state.goal} 题`;
      saveState(); renderSidebar();
    }
  });

  document.addEventListener('change', event => {
    const input = event.target;
    if (handleAPIField(input)) return;
    if (input.id === 'edit-type' && addingQuestion) {
      const boolean = input.value === 'boolean';
      $('#edit-options').innerHTML = (boolean ? ['正确', '错误'] : ['', '', '', '']).map((text, index) => editorOption(index, text, false, input.value)).join('');
      $('#editor-form [data-action="add-option"]').hidden = boolean;
      return;
    }
    if (input.id === 'library-version') { switchVersion(input.value); return; }
    if (input.id === 'api-preset') {
      if (input.value !== '' && apiPresets[Number(input.value)]) { apiConfig = { ...apiPresets[Number(input.value)].config }; const selected = input.value; openAPI(); $('#api-preset').value = selected; }
      return;
    }
    if (input.closest('#paper-form')) { updatePaperPreview(); return; }
    if (input.name === 'collection-sort') { collectionSort = input.value; renderPage(); return; }
    if (input.name === 'unit-timer') {
      const countdown = input.value === 'countdown';
      $('#unit-minutes-field').hidden = !countdown;
      $('#unit-minutes').disabled = !countdown;
      $('#unit-minutes').required = countdown;
      return;
    }
    if (input.id === 'bank-sort') {
      sortBy = input.value;
      $('#bank-results').innerHTML = renderBankResults();
    } else if (input.name === 'practice-answer') {
      if (practiceBlocked() || state.session.mode === 'memorize' || state.session.mode !== 'exam' && state.session.answers[state.session.index]) return;
      currentSelection = $$('[name="practice-answer"]:checked', $('#practice-dialog')).map(option => Number(option.value));
      state.session.draft = [...currentSelection];
      saveState();
      $$('.answer-option').forEach(option => option.classList.toggle('selected', $('input', option).checked));
      if (state.session.mode === 'exam') saveExamSelection();
      else $('#submit-answer').disabled = !currentSelection.length && !QUESTION_MAP.get(state.session.ids[state.session.index]).flags.length;
      const picker = $('#question-picker');
      if (picker && !picker.hidden) picker.innerHTML = questionNavigation();
    } else if (input.id === 'import-file') {
      importBackup(input.files[0]);
      input.value = '';
    }
  });

  $('.skip-link').addEventListener('click', event => {
    event.preventDefault();
    $('#main').focus();
  });

  $('#global-search').addEventListener('submit', event => {
    event.preventDefault();
    searchQuery = new FormData(event.target).get('query').trim();
    category = '全部';
    goToBanks();
  });

  $('#practice-dialog').addEventListener('close', () => {
    // close 事件异步送达，忽略已重新打开的对话框，避免误暂停新会话。
    if ($('#practice-dialog').open) return;
    cancelAllAPI();
    if (state.session && Core.clockExpired(state.session.timer)) { finishSession('timeout'); return; }
    pauseTimer();
    if (state.session) state.session.timer = Core.pauseClock(state.session.timer);
    clearInterval(sessionInterval);
    saveState();
    renderPage();
  });
  $('#api-dialog').addEventListener('close', () => {
    if (!$('#api-dialog').open) cancelAPINetwork();
  });
  $('#settings-dialog').addEventListener('close', () => renderPage());
  $$('dialog').forEach(dialog => dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  }));

  document.addEventListener('keydown', event => {
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
    if (event.target.id === 'api-model-search' && event.key === 'Enter') { event.preventDefault(); return; }
    const typing = event.target.matches('textarea, select, [contenteditable="true"], input:not([type="radio"]):not([type="checkbox"])');
    if (typing) return;
    if (event.target.closest('dialog') && event.target.closest('dialog').id !== 'practice-dialog') return;
    if ($('#practice-dialog').open && state.session) {
      if (practiceBlocked()) return;
      const answer = state.session.answers[state.session.index];
      if (/^[1-8]$/.test(event.key) && (!answer || state.session.mode === 'exam')) {
        const option = $(`[name="practice-answer"][value="${Number(event.key) - 1}"]`);
        if (option) { event.preventDefault(); option.click(); option.focus(); }
      } else if (event.key === 'Enter' && !event.target.closest('button')) {
        event.preventDefault();
        if (answer || state.session.mode === 'memorize' || state.session.mode === 'exam') nextQuestion(); else submitAnswer();
      }
    } else if (event.key === '/' && !$('dialog[open]')) {
      event.preventDefault();
      if (window.innerWidth > 1000) $('[name="query"]').focus();
      else { goToBanks(); setTimeout(() => $('#bank-search')?.focus(), 0); }
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { pauseTimer(); saveState(); }
    else {
      updateSessionClock();
      if ($('#practice-dialog').open && state.session?.timer.runningSince !== null && state.session && !state.session.answers[state.session.index]) activeStartedAt = Date.now();
    }
  });
  window.addEventListener('hashchange', navigate);
  window.addEventListener('beforeunload', () => { pauseTimer(); saveState(); });

  applyTheme();
  navigate();
  // 刷新后，尚在运行的会话继续计时；无需先点「继续练习」才能触发到期结算。
  if (state.session && state.session.timer.runningSince !== null) {
    sessionInterval = setInterval(updateSessionClock, 250);
    updateSessionClock();
  }
  if (state.session && state.session.timer.runningSince !== null) openPractice();
  if (storageFailed) setTimeout(() => showToast('未能读取本地记录，当前以临时模式运行。请检查浏览器存储权限并及时备份。', 'help'), 500);
})();