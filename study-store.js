/* 题库备份校验、题目编辑与错题记录；无存储、网络或 DOM 操作。 */
(function (root) {
  'use strict';

  const LIMITS = Object.freeze({
    id: 256, title: 1000, text: 20000, option: 10000, explanation: 200000,
    referenceAnswer: 2000, raw: 200000, sourceText: 10000000, metadata: 2000,
    apiAnalysis: 1048576, model: 256, endpointOrigin: 2048, timestamp: 40,
    evidenceSources: 32, sourceUrl: 2048, sourceTitle: 300,
    options: 8, banks: 100, questionsPerBank: 1500, mistakes: 150000
  });
  const TYPE_NAMES = Object.freeze({ single: '单选题', multiple: '多选题', boolean: '判断题' });
  const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const same = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);
  const sameAnswer = (left, right) => same([...left].sort((a, b) => a - b), [...right].sort((a, b) => a - b));
  const ORIGINAL_EXPLANATION = '原文仅提供参考答案，未提供逐题解析。判定依照读本参考答案；如有争议，以大赛知识读本及命题老师解释为准。';
  // 用户逐项确认的练习修订，不是赛事官方勘误。原文、题目 ID 和题目位置不变。
  // 匹配完整题面及答案，避免同号合成题、用户另行修改的题被覆盖。
  const CONFIRMED_REVISIONS = [
    {
      id: 'tcm-u02-single-40', text: '《内经》所谓“ 阴阳之征兆 ”，是指 ( )',
      options: ['天地', '男女', '左右', '水火'], type: 'single', referenceAnswer: 'E', answer: [],
      nextType: 'single', nextAnswer: [4], blankE: true,
      explanation: '判分说明：按用户确认，补入内容为空的 E 选项，保留读本参考答案 E；选择 E 按正确判分，选择 D 不符合本练习的判分答案。E 仅为兼容读本答案的占位，不代表新增了有依据的知识内容。\n知识核对：《素问·阴阳应象大论》有“水火者，阴阳之征兆也”的表述，与题面的 D（水火）直接对应，因此从题意看 D 更有依据。但尚未取得赛事官方勘误，本练习仍按读本 E 判分，请区分判分规则与知识结论。'
    },
    {
      id: 'tcm-u03-single-26', text: '推拿治疗高血压常用手法是 ( )',
      options: ['推桥弓', '叩击脊柱', '摇腰', '点按肩井'], type: 'single', referenceAnswer: 'AD', answer: [0, 3],
      nextType: 'multiple', nextAnswer: [0, 3], blankE: false,
      explanation: '题型修订：按用户确认，将原单选题改为多选题，保留原题位置及读本参考答案 AD（推桥弓、点按肩井）。必须同时选择 A、D 才按正确判分。此项修订用于消除题型与原答案的冲突，尚未取得赛事官方勘误，也不代表各选项已完成独立证据核验。内容仅供竞赛复习，不作为自行实施推拿或治疗高血压的指导。'
    },
    {
      id: 'tcm-u05-single-64', text: '宜用豆腐煮制的药物是 ( )',
      options: ['硫磺', '远志', '吴茱萸', '珍珠', '藤黄'], type: 'single', referenceAnswer: 'ADE', answer: [0, 3, 4],
      nextType: 'multiple', nextAnswer: [0, 3, 4], blankE: false,
      explanation: '题型修订：按用户确认，将原单选题改为多选题，保留原题位置及读本参考答案 ADE（硫磺、珍珠、藤黄）。必须同时选择 A、D、E 才按正确判分。此项修订用于消除题型与原答案的冲突，尚未取得赛事官方勘误，也不代表各选项已完成独立证据核验。内容仅供竞赛复习，不作为自行炮制或使用药物的指导。'
    },
    {
      id: 'tcm-u07-multiple-25', text: '黑豆的功效是 ( )',
      options: ['活血利水', '祛湿消暑', '祛风解毒', '健脾益肾'], type: 'multiple', referenceAnswer: 'ADE', answer: [0, 3],
      nextType: 'multiple', nextAnswer: [0, 3, 4], blankE: true,
      explanation: '判分说明：按用户确认，补入内容为空的 E 选项，保留读本参考答案 ADE；同时选择 A、D、E 按正确判分。E 仅是占位，原文没有对应的选项内容。\n候选答案提示：ACD（活血利水、祛风解毒、健脾益肾）可作为进一步核对的候选，但目前证据不足，尚不能确认其为标准答案，也不能确定原文是漏了 E 选项还是答案字母写错。尚未取得赛事官方勘误，本练习不会把 ADE 擅自改为 ACD；选择 ACD 不符合当前判分答案。'
    }
  ];

  function matchesRevision(question, revision, revised) {
    return question.id === revision.id && question.sourceNumber === Number(revision.id.split('-').pop()) &&
      question.text === revision.text && question.type === (revised ? revision.nextType : revision.type) &&
      question.referenceAnswer === revision.referenceAnswer &&
      same(question.options, revised && revision.blankE ? [...revision.options, ''] : revision.options) &&
      sameAnswer(question.answer, revised ? revision.nextAnswer : revision.answer);
  }

  // 只豁免用户确认的这两道题的空白 E；其余空选项仍按异常处理。
  function isConfirmedBlankOption(question, index) {
    return index === 4 && CONFIRMED_REVISIONS.some(revision => revision.blankE && matchesRevision(question, revision, true));
  }

  function invalid(message) { throw new TypeError(message); }

  function object(value, name) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${name}必须为普通对象。`);
    const prototype = Object.getPrototypeOf(value);
    // 同时接受其他 realm 的 JSON 对象和无原型字典，拒绝带自定义原型的实例。
    if (prototype !== null && Object.getPrototypeOf(prototype) !== null) invalid(`${name}不能带自定义原型。`);
    return value;
  }

  function field(value, key) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return undefined;
    if (!own(descriptor, 'value')) invalid(`${key}不能为访问器。`);
    return descriptor.value;
  }

  function text(value, name, maximum, required = false) {
    if (typeof value !== 'string' || value.length > maximum || (required && !value.trim())) {
      invalid(`${name}必须为${required ? '非空' : ''}字符串，最多 ${maximum} 字符。`);
    }
    return value;
  }

  function identifier(value, name) {
    text(value, name, LIMITS.id, true);
    if (UNSAFE_KEYS.has(value) || /[\u0000-\u001f\u007f]/.test(value)) invalid(`${name}无效。`);
    return value;
  }

  function integer(value, name, minimum, maximum) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(`${name}须为 ${minimum}～${maximum} 的整数。`);
    return value;
  }

  function array(value, name, maximum) {
    if (!Array.isArray(value) || value.length > maximum) invalid(`${name}必须为不超过 ${maximum} 项的数组。`);
    const result = [];
    for (let index = 0; index < value.length; index++) {
      if (!own(value, index)) invalid(`${name}不能为稀疏数组。`);
      result.push(field(value, String(index)));
    }
    return result;
  }

  function strings(value, name, maximum, itemMaximum) {
    return array(value, name, maximum).map(item => text(item, name, itemMaximum));
  }

  function type(value) {
    if (typeof value !== 'string' || !own(TYPE_NAMES, value)) invalid('题型必须为 single、multiple 或 boolean。');
    return value;
  }

  function transition(previous, next) {
    if ((previous === 'boolean') !== (next === 'boolean')) invalid('判断题不能与选择题互换；只允许单选、多选互换。');
  }

  function labelsFor(questionType, count) {
    return questionType === 'boolean' ? ['√', '×'] : Array.from({ length: count }, (_, index) => String.fromCharCode(65 + index));
  }

  function readQuestion(value) {
    object(value, '题目');
    const options = strings(field(value, 'options'), '选项', LIMITS.options, LIMITS.option);
    const answer = array(field(value, 'answer'), '答案', LIMITS.options).map(index => integer(index, '答案下标', 0, options.length - 1));
    if (new Set(answer).size !== answer.length) invalid('答案下标不能重复。');
    return {
      id: identifier(field(value, 'id'), '题目 ID'),
      type: type(field(value, 'type')),
      sourceNumber: integer(field(value, 'sourceNumber'), '原题号', 1, 500),
      text: text(field(value, 'text'), '题干', LIMITS.text, true),
      options, answer,
      referenceAnswer: text(field(value, 'referenceAnswer'), '参考答案', LIMITS.referenceAnswer),
      explanation: text(field(value, 'explanation'), '解析', LIMITS.explanation)
    };
  }

  // 与 Core 的原文答案解释规则一致；疑点来自内容，绝不读取输入的 flags。
  function inspect(question, labels) {
    const flags = [];
    const { type: questionType, options, referenceAnswer } = question;
    if (questionType === 'boolean') {
      if (!same(options, ['正确', '错误']) || !same(labels, ['√', '×'])) invalid('判断题选项必须依次为正确、错误。');
    } else {
      if (options.length < 2 || options.some((option, index) => !option.trim() && !isConfirmedBlankOption(question, index))) flags.push('原文选项缺失或无法完整识别');
      if (!same(labels, labelsFor(questionType, options.length))) flags.push('原文选项编号不连续或重复');
    }
    let expected = [];
    if (!referenceAnswer) flags.push('原文未找到对应参考答案');
    else if (questionType === 'boolean') {
      if (/^(?:[√✓✔]|正确|对)$/.test(referenceAnswer)) expected = [0];
      else if (/^(?:[×✗✕✘]|错误|错)$/.test(referenceAnswer)) expected = [1];
      else flags.push('判断题参考答案格式异常');
    } else {
      const letters = [...referenceAnswer];
      expected = [...new Set(letters.map(letter => labels.indexOf(letter)).filter(index => index >= 0))];
      if (letters.some(letter => !labels.includes(letter))) flags.push(`原文参考答案 ${referenceAnswer} 含题面中不存在的选项`);
      if (new Set(letters).size !== letters.length) flags.push('原文参考答案存在重复选项');
      if (questionType === 'single' && letters.length !== 1) flags.push(`原文标为单选题，但参考答案为 ${referenceAnswer}`);
      if (questionType === 'multiple' && expected.length < 2) flags.push('多选题参考答案不足两个不同选项');
    }
    if (!sameAnswer(question.answer, expected)) invalid('referenceAnswer 与 answer 不一致。');
    return flags;
  }

  function unchangedQuestion(question, baseline) {
    return question.type === baseline.type && question.text === baseline.text &&
      same(question.options, baseline.options) && sameAnswer(question.answer, baseline.answer) &&
      question.referenceAnswer === baseline.referenceAnswer;
  }

  function timestamp(value, name) {
    text(value, name, LIMITS.timestamp, true);
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
    const milliseconds = Date.parse(value);
    if (!match || !Number.isFinite(milliseconds) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) {
      invalid(`${name}必须为有效 ISO 时间。`);
    }
    const calendar = new Date(`${match[1]}T00:00:00.000Z`);
    if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== match[1]) invalid(`${name}日期无效。`);
    return new Date(milliseconds).toISOString();
  }

  function analysisSource(value) {
    object(value, 'API 证据来源');
    const raw = text(field(value, 'url'), 'API 来源 URL', LIMITS.sourceUrl, true);
    // 与客户端的来源规则一致；拒绝 URL 构造器会自动修复的链接及空凭据标记。
    if (!/^https?:\/\/[^/?#]/i.test(raw) || /[\s\\\u0000-\u001f\u007f-\u009f]/.test(raw)) invalid('API 来源 URL 必须是安全的完整 HTTP(S) 地址。');
    let url;
    try { url = new URL(raw); } catch { invalid('API 来源 URL 无效。'); }
    const authority = raw.slice(raw.indexOf('://') + 3).split(/[/?#]/, 1)[0];
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || authority.includes('@') || url.href.length > LIMITS.sourceUrl) {
      invalid('API 来源 URL 不能含凭据，且规范化后不能超长。');
    }
    return { url: url.href, title: text(field(value, 'title'), 'API 来源标题', LIMITS.sourceTitle) };
  }

  function analysisEvidence(value) {
    // 旧分析保留缺省 evidence；缺省不能被推断为已检索或已核验。
    if (value === undefined) return undefined;
    object(value, 'API evidence');
    const status = field(value, 'status');
    if (status !== 'unverified' && status !== 'search-reported') invalid('API 证据状态必须为 unverified 或 search-reported。');
    const sources = array(field(value, 'sources'), 'API 证据来源', LIMITS.evidenceSources).map(analysisSource);
    const searchedAt = field(value, 'searchedAt');
    const result = { status, sources };
    if (searchedAt !== undefined) result.searchedAt = timestamp(searchedAt, 'API 检索报告时间');
    // 仅保留服务端报告检索的元数据，不证明来源真实或分析已独立事实核验。
    if (status === 'search-reported' && (!sources.length || result.searchedAt === undefined)) {
      invalid('search-reported 必须包含安全来源及有效检索报告时间。');
    }
    return result;
  }

  function analysis(value) {
    if (value === undefined || value === null) return undefined;
    object(value, 'apiAnalysis');
    const result = {
      text: text(field(value, 'text'), 'API 分析', LIMITS.apiAnalysis, true),
      model: text(field(value, 'model'), 'API 模型', LIMITS.model),
      at: timestamp(field(value, 'at'), 'API 分析时间'),
      endpointOrigin: text(field(value, 'endpointOrigin'), 'API 来源', LIMITS.endpointOrigin, true)
    };
    let url;
    try { url = new URL(result.endpointOrigin); } catch { invalid('API 来源必须是 HTTP(S) origin。'); }
    // 仅允许协议、主机、端口，避免路径、查询参数或凭据被备份。
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== result.endpointOrigin) invalid('API 来源只能包含 HTTP(S) 协议、主机及端口。');
    const evidence = analysisEvidence(field(value, 'evidence'));
    if (evidence !== undefined) result.evidence = evidence;
    return result;
  }

  function finishQuestion(question, raw, labels, flags) {
    return {
      id: question.id, type: question.type, sourceNumber: question.sourceNumber,
      text: question.text, raw: text(raw, '原始题面', LIMITS.raw),
      options: [...question.options], optionLabels: [...labels], answer: [...question.answer],
      referenceAnswer: question.referenceAnswer, flags: [...flags],
      topic: `${TYPE_NAMES[question.type]} · 原题 ${question.sourceNumber}`, explanation: question.explanation
    };
  }

  function importedQuestion(input, original) {
    const baseline = readQuestion(original);
    const question = readQuestion(input);
    if (question.id !== baseline.id || question.sourceNumber !== baseline.sourceNumber) invalid('题目 ID、原题号和顺序必须与内置题库一致。');
    transition(baseline.type, question.type);
    const revision = CONFIRMED_REVISIONS.find(item => matchesRevision(question, item, false) &&
      (matchesRevision(baseline, item, false) || matchesRevision(baseline, item, true)));
    if (revision) {
      question.type = revision.nextType;
      question.options = revision.blankE ? [...revision.options, ''] : [...revision.options];
      question.answer = [...revision.nextAnswer];
      // 旧缓存/旧 JSON 同步修订；已有手写解析保留，不把过期 API 分析带到新题面。
      question.explanation = question.explanation === ORIGINAL_EXPLANATION || !question.explanation.trim()
        ? revision.explanation
        : question.explanation.includes(revision.explanation) ? question.explanation : `${question.explanation}\n\n${revision.explanation}`;
    }
    const unchanged = unchangedQuestion(question, baseline);
    // 原文的缺号/重复标签也属于异常证据；输入 optionLabels 无权改写它们。
    const labels = unchanged
      ? strings(field(original, 'optionLabels'), '原文选项标签', LIMITS.options, 1)
      : labelsFor(question.type, question.options.length);
    if (labels.length !== question.options.length) invalid('选项与标签数量不一致。');
    const flags = inspect(question, labels);
    if (flags.length && !unchanged) invalid('修改后的题目必须具有完整选项和严格正常答案；仅允许保留原文异常。');
    const result = finishQuestion(question, field(original, 'raw'), labels, flags);
    const edited = field(input, 'edited');
    if (edited !== undefined && typeof edited !== 'boolean') invalid('edited 必须为布尔值。');
    const editedAt = field(input, 'editedAt');
    const normalizedAt = editedAt === undefined ? undefined : timestamp(editedAt, '编辑时间');
    if (revision || !unchanged || question.explanation !== baseline.explanation || edited === true) {
      result.edited = true;
      // JSON 手动修改可能没有时间记录；校验函数不猜测编辑发生的时间。
      if (normalizedAt !== undefined) result.editedAt = normalizedAt;
    }
    const apiAnalysis = revision ? undefined : analysis(field(input, 'apiAnalysis'));
    if (apiAnalysis !== undefined) result.apiAnalysis = apiAnalysis;
    return result;
  }

  function bankMetadata(original) {
    object(original, '内置单元');
    const result = { id: identifier(field(original, 'id'), '单元 ID'), unit: integer(field(original, 'unit'), '单元编号', 1, LIMITS.banks) };
    for (const key of ['title', 'category', 'label', 'subtitle', 'icon', 'color', 'level']) {
      result[key] = text(field(original, key), `单元 ${key}`, LIMITS.metadata);
    }
    result.tags = strings(field(original, 'tags'), '单元标签', 20, LIMITS.metadata);
    return result;
  }

  /** 校验 JSON.parse 后的对象；baseline 必须始终是内置原始题库，而非上次导入的题库。
   * 身份/数量/位置不符或编辑内容无效时抛 TypeError。返回全新白名单对象，可直接 JSON.stringify。
   */
  function validateLibrary(raw, baseline) {
    object(raw, '导入题库');
    object(baseline, '内置题库');
    const id = identifier(field(baseline, 'id'), '题库 ID');
    if (field(raw, 'id') !== id) invalid('只允许导入当前内置题库的备份。');
    const originals = array(field(baseline, 'banks'), '内置单元', LIMITS.banks);
    const incoming = array(field(raw, 'banks'), '导入单元', LIMITS.banks);
    if (!originals.length || incoming.length !== originals.length) invalid('单元数量必须与内置题库一致。');
    const bankIds = new Set(), units = new Set(), questionIds = new Set();
    let total = 0, flagged = 0;
    const banks = originals.map((original, bankIndex) => {
      const bank = bankMetadata(original);
      if (bankIds.has(bank.id) || units.has(bank.unit)) invalid('内置题库单元重复。');
      bankIds.add(bank.id);
      units.add(bank.unit);
      const input = object(incoming[bankIndex], '导入单元');
      if (field(input, 'id') !== bank.id || field(input, 'unit') !== bank.unit) invalid('单元 ID、编号和顺序必须与内置题库一致。');
      const originalQuestions = array(field(original, 'questions'), '内置题目', LIMITS.questionsPerBank);
      const inputQuestions = array(field(input, 'questions'), '导入题目', LIMITS.questionsPerBank);
      if (inputQuestions.length !== originalQuestions.length) invalid('每个单元的题量必须与内置题库一致，不能增删题目。');
      bank.questions = originalQuestions.map((question, index) => {
        const result = importedQuestion(inputQuestions[index], question);
        if (questionIds.has(result.id)) invalid('内置题库题目 ID 重复。');
        questionIds.add(result.id);
        total++;
        if (result.flags.length) flagged++;
        return result;
      });
      // 单、多选修正后同步更新由 Core 生成的题型数量摘要。
      bank.subtitle = ['single', 'multiple', 'boolean'].map(questionType => `${TYPE_NAMES[questionType]} ${bank.questions.filter(question => question.type === questionType).length}`).join(' · ');
      return bank;
    });
    return { id, title: text(field(baseline, 'title'), '题库标题', LIMITS.title, true),
      sourceText: text(field(baseline, 'sourceText'), '原始读本', LIMITS.sourceText), banks, total, flagged };
  }

  /** 部分字段更新；第三参数可注入毫秒时间或 ISO 字符串，使测试与重放可复现。
   * 默认使用当前时间生成 editedAt；所有输入保持不变。
   */
  function editedQuestion(question, changes, now = Date.now()) {
    const previous = readQuestion(question);
    object(changes, '编辑内容');
    const selected = key => own(changes, key) ? field(changes, key) : previous[key];
    const candidate = {
      id: previous.id, sourceNumber: previous.sourceNumber,
      type: selected('type'), text: selected('text'), options: selected('options'),
      answer: selected('answer'), explanation: selected('explanation'), referenceAnswer: ''
    };
    const next = readQuestion(candidate);
    transition(previous.type, next.type);
    next.answer.sort((left, right) => left - right);
    const labels = labelsFor(next.type, next.options.length);
    next.referenceAnswer = next.answer.map(index => labels[index]).join('');
    const flags = inspect(next, labels);
    if (flags.length) invalid('编辑后的题目必须具有完整选项和严格正常答案。');
    const result = finishQuestion(next, field(question, 'raw'), labels, []);
    result.edited = true;
    if (typeof now === 'number') {
      if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) invalid('编辑时间无效。');
      result.editedAt = timestamp(new Date(now).toISOString(), '编辑时间');
    } else result.editedAt = timestamp(now, '编辑时间');
    let previousAnswerValid = false;
    try {
      previousAnswerValid = inspect(previous, labelsFor(previous.type, previous.options.length)).length === 0;
    } catch { /* 原文参考答案与规范标签不一致时，修正后旧分析也已失效。 */ }
    const gradingChanged = previous.type !== next.type || previous.text !== next.text ||
      !same(previous.options, next.options) || !sameAnswer(previous.answer, next.answer) || !previousAnswerValid;
    if (!gradingChanged) {
      const apiAnalysis = analysis(field(question, 'apiAnalysis'));
      if (apiAnalysis !== undefined) result.apiAnalysis = apiAnalysis;
    }
    return result;
  }

  /** 正确次数累计（非连续次数）：错误不清零，null 不改变记录，达标只在答对时移除。 */
  function recordMistake(entries, id, correct, target) {
    object(entries, '错题记录');
    identifier(id, '题目 ID');
    integer(target, '移出目标', 1, 100);
    if (correct !== true && correct !== false && correct !== null) invalid('correct 只能为 true、false 或 null。');
    const keys = Object.keys(entries);
    if (keys.length > LIMITS.mistakes) invalid('错题记录数量超限。');
    const result = {};
    for (const key of keys) {
      identifier(key, '错题 ID');
      const entry = object(field(entries, key), '错题记录项');
      const correctCount = integer(field(entry, 'correctCount'), '累计正确次数', 0, 99);
      Object.defineProperty(result, key, { value: { correctCount }, writable: true, enumerable: true, configurable: true });
    }
    if (correct === false && !own(result, id)) {
      if (keys.length === LIMITS.mistakes) invalid('错题记录数量超限。');
      Object.defineProperty(result, id, { value: { correctCount: 0 }, writable: true, enumerable: true, configurable: true });
    } else if (correct === true && own(result, id)) {
      result[id].correctCount++;
      if (result[id].correctCount >= target) delete result[id];
    }
    return result;
  }

  const api = Object.freeze({ validateLibrary, editedQuestion, recordMistake, isConfirmedBlankOption, LIMITS });
  root.ZhixuStore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);