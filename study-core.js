/* 纯函数：知识读本解析、按比例抽题及可恢复计时。浏览器与 Node.js 共用。 */
(function (root) {
  'use strict';
  const TITLES = ['政策与法规', '中医药文化', '中医适宜技术', '阴阳五行学说与中医学基础', '中药炮制学', '中医药膳学', '中医营养学', '中药学', '诊断学与中医药史', '中医养生学'];
  const NUMERALS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  const TYPES = { 单选题: 'single', 单项选择题: 'single', 多选题: 'multiple', 多项选择题: 'multiple', 判断题: 'boolean' };
  const LABELS = { single: '单选题', multiple: '多选题', boolean: '判断题' };
  const COLORS = ['green', 'sand', 'blue', 'purple', 'orange', 'green', 'rose', 'sand', 'blue', 'purple'];
  const clean = text => text.replace(/[\s\u3000]+/g, ' ').trim();
  const compact = text => text.replace(/\s/g, '');

  function emptyBanks() {
    return TITLES.map((title, index) => ({
      id: `tcm-u${String(index + 1).padStart(2, '0')}`, unit: index + 1, title,
      category: `第${NUMERALS[index]}单元`, label: `第${NUMERALS[index]}单元`,
      subtitle: '2026 年中医药膳制作技能大赛知识读本', icon: index === 5 || index === 9 ? 'leaf' : 'book',
      color: COLORS[index], level: '竞赛', tags: ['单选题', '多选题', '判断题'], questions: []
    }));
  }

  function fingerprint(text) {
    // 稳定题库标识用于隔离不同版本记录；不是安全用途的密码哈希。
    let a = 2166136261, b = 5381;
    for (let index = 0; index < text.length; index++) {
      a = Math.imul(a ^ text.charCodeAt(index), 16777619);
      b = Math.imul(b, 33) ^ text.charCodeAt(index);
    }
    return `tcm2026-${(a >>> 0).toString(16)}-${(b >>> 0).toString(16)}`;
  }

  function decodeText(buffer) {
    const bytes = new Uint8Array(buffer);
    const encodings = bytes[0] === 255 && bytes[1] === 254 ? ['utf-16le'] :
      bytes[0] === 254 && bytes[1] === 255 ? ['utf-16be'] : ['utf-8', 'gb18030'];
    for (const encoding of encodings) {
      try {
        const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
        if (text.includes('中医') && !text.includes('\ufffd')) return { text, encoding };
      } catch { /* 尝试下一个编码。 */ }
    }
    throw new Error('无法识别文本编码。支持 UTF-8、GBK/GB18030 和带 BOM 的 UTF-16，请确认这是完整的知识读本 TXT。');
  }

  function parseAnswers(text, context) {
    const result = new Map();
    // 先定位答案题号，再保留该题的完整答案文本，避免“A、D”或“√×”被截短后误判。
    const starts = [...text.matchAll(/(?<!\d)(\d{1,3})\s*[.、．]?\s*(?=[A-Za-z√×✓✗✕✔✘正确错误对错])/g)];
    starts.forEach((start, index) => {
      const number = Number(start[1]);
      if (result.has(number)) throw new Error(`${context}：参考答案中第 ${number} 题重复，请核对原文。`);
      const answer = text.slice(start.index + start[0].length, starts[index + 1]?.index ?? text.length);
      result.set(number, clean(answer));
    });
    // 答案章节即使全部缺失，也由逐题校验标记疑点；不得补猜答案。
    return result;
  }

  function parseQuestions(text, expected, type, answers, bank) {
    const context = `${bank.label} ${LABELS[type]}`;
    // 可识别“上一题的选项内容49.下一题”；排除小数以及字母后的数字。
    const starts = [...text.matchAll(/(?<![\dA-Za-z.])(\d{1,3})\s*[.、．](?!\d)/g)];
    // 第十单元第 8 题原文缺少题号后的点。只补识别行首、多空格分隔且
    // 尚未出现的编号，最终仍要求全部题号严格连续，避免把正文数字当题号。
    if (starts.length < expected) {
      const present = new Set(starts.map(match => Number(match[1])));
      const bare = [...text.matchAll(/^[ \t]*(\d{1,3})[ \t]{2,}(?=[^\s\d.A-H])/gm)]
        .filter(match => !present.has(Number(match[1])));
      starts.push(...bare);
      starts.sort((left, right) => left.index - right.index);
    }
    if (starts.length !== expected || starts.some((match, index) => Number(match[1]) !== index + 1)) {
      throw new Error(`${context}：标题标注 ${expected} 题，识别到 ${starts.length} 个题号或题号不连续。请核对粘连题号，当前题库保持不变。`);
    }
    const questions = starts.map((start, index) => {
      const number = index + 1;
      const raw = text.slice(start.index + start[0].length, starts[index + 1]?.index ?? text.length).trim();
      const flags = [];
      let questionText = raw, options = [], optionLabels = [];
      if (type === 'boolean') {
        options = ['正确', '错误'];
        optionLabels = ['√', '×'];
      } else {
        let markers = [...raw.matchAll(/(?:^|\s)([A-H])\s*[.、．]\s*/g)];
        if (markers.length < 2) {
          // 原文存在“A 寒滞胃脘证 … B 胃阳虚证”及混用标点的选项。
          // 仅在常规识别不足且候选从 A 连续编号时采用空格标签。
          const candidates = [...raw.matchAll(/(?:^|\s)([A-H])(?:[ \t]*[.、．][ \t]*|[ \t]+(?=[\u3400-\u9fff]))/g)];
          if (candidates.length >= 2 && candidates.every((marker, position) => marker[1] === String.fromCharCode(65 + position))) markers = candidates;
        }
        if (markers.length) {
          questionText = raw.slice(0, markers[0].index);
          options = markers.map((marker, optionIndex) => clean(raw.slice(marker.index + marker[0].length, markers[optionIndex + 1]?.index ?? raw.length)));
          optionLabels = markers.map(marker => marker[1]);
        }
        if (options.length < 2 || options.some(option => !option)) flags.push('原文选项缺失或无法完整识别');
        if (optionLabels.some((label, optionIndex) => label !== String.fromCharCode(65 + optionIndex))) flags.push('原文选项编号不连续或重复');
      }
      const referenceAnswer = answers.get(number) || '';
      let answer = [];
      if (!referenceAnswer) flags.push('原文未找到对应参考答案');
      else if (type === 'boolean') {
        if (/^(?:[√✓✔]|正确|对)$/.test(referenceAnswer)) answer = [0];
        else if (/^(?:[×✗✕✘]|错误|错)$/.test(referenceAnswer)) answer = [1];
        else flags.push('判断题参考答案格式异常');
      } else {
        const letters = [...referenceAnswer];
        answer = letters.map(letter => optionLabels.indexOf(letter)).filter(value => value >= 0);
        if (letters.some(letter => !optionLabels.includes(letter))) flags.push(`原文参考答案 ${referenceAnswer} 含题面中不存在的选项`);
        if (new Set(letters).size !== letters.length) flags.push('原文参考答案存在重复选项');
        if (type === 'single' && letters.length !== 1) flags.push(`原文标为单选题，但参考答案为 ${referenceAnswer}`);
        if (type === 'multiple' && new Set(answer).size < 2) flags.push('多选题参考答案不足两个不同选项');
      }
      if (!clean(questionText)) throw new Error(`${context}第 ${number} 题缺少题干。`);
      return {
        id: `${bank.id}-${type}-${number}`, type, sourceNumber: number,
        text: clean(questionText), raw, options, optionLabels, answer: [...new Set(answer)],
        referenceAnswer, flags, topic: `${LABELS[type]} · 原题 ${number}`,
        explanation: '原文仅提供参考答案，未提供逐题解析。判定依照读本参考答案；如有争议，以大赛知识读本及命题老师解释为准。'
      };
    });
    for (const number of answers.keys()) {
      if (number < 1 || number > expected) throw new Error(`${context}：答案题号 ${number} 超出题目范围。`);
    }
    return questions;
  }

  function parseText(sourceText) {
    if (typeof sourceText !== 'string' || !sourceText.trim()) throw new Error('知识读本内容为空。');
    if (sourceText.includes('\ufffd')) throw new Error('文本中含编码替换字符，无法确保题目和答案准确。请导入原始 TXT 文件。');
    const text = sourceText.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n').replace(/[\u3000\u00a0]/g, ' ')
      .replace(/[Ａ-Ｈ０-９]/g, character => String.fromCharCode(character.charCodeAt(0) - 65248));
    const headers = [...text.matchAll(/^[ \t]*2026[^\n]*?大赛([^\n]*)/gm)]
      .map(match => ({ index: match.index, end: match.index + match[0].length, title: compact(match[1]) }))
      .filter(header => TITLES.includes(header.title));
    if (headers.length !== 10 || headers.some((header, index) => header.title !== TITLES[index])) {
      throw new Error(`需要按原顺序提供全部十个单元，当前识别到 ${headers.length} 个正文单元。请导入完整知识读本（不是目录或节选）。`);
    }
    const banks = emptyBanks();
    headers.forEach((header, unitIndex) => {
      const body = text.slice(header.end, headers[unitIndex + 1]?.index ?? text.length);
      const sections = [...body.matchAll(/^[ \t]*[一二三四五][、.．][ \t、.．]*(单选题|单项选择题|多选题|多项选择题|判断题)[^\n]*/gm)];
      const sectionMap = new Map();
      sections.forEach((section, index) => {
        const type = TYPES[section[1]];
        const sectionText = body.slice(section.index + section[0].length, sections[index + 1]?.index ?? body.length);
        // 原读本第五单元的判断答案标题漏了“参考答案”。仅当位置及全文均为
        // 判断答案编号/符号时识别，不把普通重复题目章节当答案，也不补猜答案。
        const omittedAnswerHeading = type === 'boolean' && sectionMap.has('boolean-questions') &&
          sectionMap.has('single-answers') && sectionMap.has('multiple-answers') &&
          /^(?:\s*\d{1,3}\s*[.、．]?\s*[√×✓✗✕✔✘]\s*)+$/.test(sectionText);
        const key = `${type}-${section[0].includes('答案') || omittedAnswerHeading ? 'answers' : 'questions'}`;
        if (sectionMap.has(key)) throw new Error(`${banks[unitIndex].label}：${section[1]}章节重复。`);
        sectionMap.set(key, { heading: section[0], text: sectionText });
      });
      for (const type of ['single', 'multiple', 'boolean']) {
        const questions = sectionMap.get(`${type}-questions`);
        const answers = sectionMap.get(`${type}-answers`);
        if (!questions || !answers) throw new Error(`${banks[unitIndex].label}缺少${LABELS[type]}题目或答案章节。`);
        const expected = Number(questions.heading.match(/(?:共\s*)?(\d+)\s*题/)?.[1]);
        if (!Number.isInteger(expected) || expected < 1 || expected > 500) throw new Error(`${banks[unitIndex].label}的${LABELS[type]}题量标注无法识别。`);
        const context = `${banks[unitIndex].label} ${LABELS[type]}`;
        const answerMap = parseAnswers(answers.text.split(/温\s*馨\s*提\s*示/)[0], context);
        banks[unitIndex].questions.push(...parseQuestions(questions.text, expected, type, answerMap, banks[unitIndex]));
      }
      banks[unitIndex].subtitle = ['single', 'multiple', 'boolean'].map(type => `${LABELS[type]} ${banks[unitIndex].questions.filter(question => question.type === type).length}`).join(' · ');
    });
    const questions = banks.flatMap(bank => bank.questions);
    return { id: fingerprint(text), title: '2026 年全省第三届中医药膳制作技能大赛知识读本', sourceText, banks,
      total: questions.length, flagged: questions.filter(question => question.flags.length).length };
  }

  function shuffle(items, random = Math.random) {
    const result = [...items];
    for (let index = result.length - 1; index > 0; index--) {
      const other = Math.floor(random() * (index + 1));
      [result[index], result[other]] = [result[other], result[index]];
    }
    return result;
  }

  function allocate(total, weights, capacities) {
    if (!Number.isSafeInteger(total) || total < 1 || total > 10000) throw new Error('抽题数量须为 1～10000 的整数。');
    if (!Array.isArray(weights) || weights.length !== 10 || weights.some(value => !Number.isFinite(value) || value < 0 || value > 100)) throw new Error('十个单元的比例须为 0～100 的有效数字。');
    if (Math.abs(weights.reduce((sum, weight) => sum + weight, 0) - 100) > 0.000001) throw new Error('十个单元的比例合计必须为 100%。');
    if (!Array.isArray(capacities) || capacities.length !== 10 || capacities.some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error('可用题量无效。');
    const raw = weights.map(weight => total * weight / 100);
    const counts = raw.map(value => Math.floor(value));
    let remaining = total - counts.reduce((sum, value) => sum + value, 0);
    // 最大余数法：相同余数按单元顺序分配，预览与实际组题结果完全一致。
    const order = weights.map((weight, index) => ({ index, remainder: raw[index] - counts[index], weight }))
      .filter(item => item.weight > 0).sort((a, b) => b.remainder - a.remainder || a.index - b.index);
    for (let index = 0; index < remaining; index++) counts[order[index].index]++;
    const shortage = counts.findIndex((count, index) => count > capacities[index]);
    if (shortage !== -1) throw new Error(`第${NUMERALS[shortage]}单元需抽 ${counts[shortage]} 题，可用 ${capacities[shortage]} 题。请减少总题数或调整比例；不会重复抽题或擅自转移配额。`);
    return counts;
  }

  function makePaper(banks, total, weights, includeFlagged = false, random = Math.random) {
    const pools = banks.map(bank => bank.questions.filter(question => includeFlagged || !question.flags.length));
    const counts = allocate(total, weights, pools.map(pool => pool.length));
    const ids = shuffle(pools.flatMap((pool, index) => shuffle(pool, random).slice(0, counts[index]).map(question => question.id)), random);
    if (ids.length !== total || new Set(ids).size !== total) throw new Error('组题校验失败：题量不符或题目编号重复。');
    return { ids, counts };
  }

  // 新接口固定十个单元；题型顺序同时用于 typeWeights 和 typeCounts。
  const PAPER_TYPES = ['single', 'multiple', 'boolean'];

  function validatePaperWeights(weights, length, label) {
    // Array.from 也校验稀疏数组中的空项，不让缺失比例进入最大余数计算。
    if (!Array.isArray(weights) || weights.length !== length ||
        Array.from(weights).some(value => !Number.isFinite(value) || value < 0 || value > 100)) {
      throw new Error(`${label}的比例须为 ${length} 个 0～100 的有效数字。`);
    }
    if (Math.abs(weights.reduce((sum, weight) => sum + weight, 0) - 100) > 0.000001) {
      throw new Error(`${label}的比例合计必须为 100%。`);
    }
  }

  function allocateTypes(total, weights, capacities) {
    const raw = weights.map(weight => total * weight / 100);
    const counts = raw.map(Math.floor);
    const remaining = total - counts.reduce((sum, count) => sum + count, 0);
    const order = weights.map((weight, index) => ({ index, weight, remainder: raw[index] - counts[index] }))
      .filter(item => item.weight > 0).sort((a, b) => b.remainder - a.remainder || a.index - b.index);
    // 与单元分配相同的最大余数法；同余数按单选、多选、判断顺序。
    for (let index = 0; index < remaining; index++) counts[order[index].index]++;
    const shortage = counts.findIndex((count, index) => count > capacities[index]);
    if (shortage !== -1) {
      throw new Error(`${LABELS[PAPER_TYPES[shortage]]}需抽 ${counts[shortage]} 题，可用 ${capacities[shortage]} 题。请减少总题数或调整比例；不会重复抽题或擅自转移配额。`);
    }
    return counts;
  }

  function prepareConfiguredPaper(banks, config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('组卷配置须为对象。');
    const { count, allocationMode = 'unit', weights = Array(10).fill(10),
      typeWeights = [60, 30, 10], includeFlagged = false } = config;
    if (!Number.isSafeInteger(count) || count < 1 || count > 10000) throw new Error('抽题数量须为 1～10000 的整数。');
    if (!['unit', 'type', 'combined'].includes(allocationMode)) throw new Error('组卷模式须为 unit、type 或 combined。');
    if (typeof includeFlagged !== 'boolean') throw new Error('includeFlagged 须为布尔值。');
    if (!Array.isArray(banks) || banks.length !== 10) throw new Error('组卷题库须包含按顺序排列的十个单元。');
    // 只校验当前模式生效的比例，另一维度既不参与配额也不限制抽题。
    if (allocationMode !== 'type') validatePaperWeights(weights, 10, '十个单元');
    if (allocationMode !== 'unit') validatePaperWeights(typeWeights, 3, '三种题型');
    const pools = Array.from({ length: 10 }, () => PAPER_TYPES.map(() => []));
    const seen = new Set();
    for (let unitIndex = 0; unitIndex < 10; unitIndex++) {
      const bank = banks[unitIndex];
      if (!bank || !Array.isArray(bank.questions)) throw new Error(`第${NUMERALS[unitIndex]}单元的题目列表无效。`);
      for (const question of bank.questions) {
        if (!question || typeof question !== 'object') throw new Error(`第${NUMERALS[unitIndex]}单元含无效题目。`);
        const typeIndex = PAPER_TYPES.indexOf(question.type);
        if (typeIndex === -1) continue;
        if (question.flags !== undefined && !Array.isArray(question.flags)) throw new Error('题目的疑点标记须为数组。');
        if (!includeFlagged && question.flags?.length) continue;
        if (typeof question.id !== 'string' || !question.id.trim()) throw new Error('可抽题目的编号须为非空字符串。');
        // 在统计库存之前拒绝重复 ID，预览和实际抽题都不会虚增可用数量。
        if (seen.has(question.id)) throw new Error(`组题校验失败：题目编号重复（${question.id}）。`);
        seen.add(question.id);
        pools[unitIndex][typeIndex].push({ id: question.id, unitIndex, typeIndex });
      }
    }
    const counts = allocationMode === 'type' ? null : allocate(count, weights,
      pools.map(row => row.reduce((sum, pool) => sum + pool.length, 0)));
    const typeCounts = allocationMode === 'unit' ? null : allocateTypes(count, typeWeights,
      PAPER_TYPES.map((_, index) => pools.reduce((sum, row) => sum + row[index].length, 0)));
    return { count, allocationMode, pools, counts, typeCounts };
  }

  function allocateCombined(pools, counts, typeCounts, random) {
    // 源 -> 十单元 -> 三题型 -> 汇；所有容量均为整数，因此增广结果也为整数。
    const source = 0, sink = 14;
    const graph = Array.from({ length: 15 }, () => []);
    function addEdge(from, to, capacity) {
      const forward = { to, capacity, reverse: null };
      const reverse = { to: from, capacity: 0, reverse: forward };
      forward.reverse = reverse;
      graph[from].push(forward);
      graph[to].push(reverse);
      return forward;
    }
    counts.forEach((count, unitIndex) => addEdge(source, unitIndex + 1, count));
    const cells = pools.map((row, unitIndex) => row.map((pool, typeIndex) =>
      addEdge(unitIndex + 1, typeIndex + 11, pool.length)));
    typeCounts.forEach((count, typeIndex) => addEdge(typeIndex + 11, sink, count));
    // 只随机化边的遍历顺序，不修改容量或边际配额；预览不调用随机源。
    if (random) graph.forEach((edges, index) => { graph[index] = shuffle(edges, random); });
    const total = counts.reduce((sum, count) => sum + count, 0);
    let flow = 0;
    while (flow < total) {
      const parents = Array(graph.length).fill(null);
      const queue = [source];
      parents[source] = { from: -1 };
      for (let index = 0; index < queue.length && !parents[sink]; index++) {
        const from = queue[index];
        for (const edge of graph[from]) {
          if (edge.capacity <= 0 || parents[edge.to]) continue;
          parents[edge.to] = { from, edge };
          queue.push(edge.to);
          if (edge.to === sink) break;
        }
      }
      if (!parents[sink]) {
        throw new Error(`单元与题型配额无法同时满足：按当前各单元题型库存最多可分配 ${flow} / ${total} 题。请调整比例或题量；不会重复抽题或擅自转移配额。`);
      }
      let amount = total - flow;
      for (let node = sink; node !== source; node = parents[node].from) {
        amount = Math.min(amount, parents[node].edge.capacity);
      }
      for (let node = sink; node !== source; node = parents[node].from) {
        const edge = parents[node].edge;
        edge.capacity -= amount;
        edge.reverse.capacity += amount;
      }
      flow += amount;
    }
    return cells.map((row, unitIndex) => row.map((edge, typeIndex) => pools[unitIndex][typeIndex].length - edge.capacity));
  }

  // config.count 必填；默认 unit / 十单元各 10% / 题型 60:30:10 / 排除疑点。
  // 预览不抽题：未约束维度返回 null，combined 同时返回两组精确配额。
  function previewConfiguredPaper(banks, config) {
    const plan = prepareConfiguredPaper(banks, config);
    if (plan.allocationMode === 'combined') allocateCombined(plan.pools, plan.counts, plan.typeCounts);
    return { counts: plan.counts, typeCounts: plan.typeCounts };
  }

  function makeConfiguredPaper(banks, config, random = Math.random) {
    const plan = prepareConfiguredPaper(banks, config);
    if (typeof random !== 'function') throw new Error('随机源须为返回 0（含）到 1（不含）之间数字的函数。');
    const nextRandom = () => {
      const value = random();
      if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error('随机源须返回 0（含）到 1（不含）之间的有效数字。');
      return value;
    };
    const selected = [];
    const draw = (pool, count) => {
      if (count) selected.push(...shuffle(pool, nextRandom).slice(0, count));
    };
    if (plan.allocationMode === 'unit') {
      plan.pools.forEach((row, index) => draw(row.flat(), plan.counts[index]));
    } else if (plan.allocationMode === 'type') {
      PAPER_TYPES.forEach((_, index) => draw(plan.pools.flatMap(row => row[index]), plan.typeCounts[index]));
    } else {
      const cellCounts = allocateCombined(plan.pools, plan.counts, plan.typeCounts, nextRandom);
      plan.pools.forEach((row, unitIndex) => row.forEach((pool, typeIndex) => draw(pool, cellCounts[unitIndex][typeIndex])));
    }
    const ids = shuffle(selected, nextRandom).map(item => item.id);
    const counts = Array(10).fill(0), typeCounts = Array(3).fill(0);
    selected.forEach(item => { counts[item.unitIndex]++; typeCounts[item.typeIndex]++; });
    if (ids.length !== plan.count || new Set(ids).size !== plan.count ||
        plan.counts?.some((count, index) => count !== counts[index]) ||
        plan.typeCounts?.some((count, index) => count !== typeCounts[index])) {
      throw new Error('组题校验失败：题量、配额不符或题目编号重复。');
    }
    return { ids, counts, typeCounts };
  }

  function elapsedTime(timer, now = Date.now()) {
    if (timer.mode === 'none') return 0;
    return timer.elapsedMs + (timer.runningSince === null ? 0 : Math.max(0, now - timer.runningSince));
  }
  function pauseClock(timer, now = Date.now()) {
    return { ...timer, elapsedMs: elapsedTime(timer, now), runningSince: null };
  }
  function resumeClock(timer, now = Date.now()) {
    return { ...timer, runningSince: timer.runningSince === null ? now : timer.runningSince };
  }
  function clockExpired(timer, now = Date.now()) {
    return timer.mode === 'countdown' && elapsedTime(timer, now) >= timer.limitMs;
  }
  function formatTime(milliseconds) {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(value => String(value).padStart(2, '0')).join(':');
  }

  const api = { TITLES, LABELS, emptyBanks, decodeText, parseText, shuffle, allocate, makePaper,
    makeConfiguredPaper, previewConfiguredPaper, elapsedTime, pauseClock, resumeClock, clockExpired, formatTime };
  root.ZhixuCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);