/* 独立的首次须知与界面引导；不读取或修改题库、练习进度及 API 配置。 */
(() => {
  'use strict';

  const NOTICE_KEY = 'zhixu-notice-confirmed-v1';
  const GUIDE_KEY = 'zhixu-guide-seen-v1';
  const NOTICE_DELAY_MS = 5000;
  const notice = document.getElementById('first-visit-dialog');
  const acceptButton = document.getElementById('accept-notice');
  const countdown = document.getElementById('notice-countdown');
  const guide = document.getElementById('onboarding-guide');
  const card = guide.querySelector('.guide-card');
  const outline = document.getElementById('guide-target-outline');
  const arrow = document.getElementById('guide-arrow-path');
  const title = document.getElementById('guide-title');
  const description = document.getElementById('guide-description');
  const counter = document.getElementById('guide-step-count');
  const previousButton = document.getElementById('guide-previous');
  const nextButton = document.getElementById('guide-next');
  const storageNote = document.getElementById('guide-storage-note');
  let storageAvailable = true;

  function readFlag(key) {
    try { return localStorage.getItem(key) === '1'; }
    catch { storageAvailable = false; return false; }
  }

  function saveFlag(key) {
    try { localStorage.setItem(key, '1'); }
    catch { storageAvailable = false; }
  }

  let noticeAccepted = readFlag(NOTICE_KEY);
  let guideSeen = readFlag(GUIDE_KEY);
  let readMilliseconds = 0;
  let lastReadTick = 0;
  let wasReading = false;
  let countdownTimer = 0;
  let pendingGuide = false;
  let guideActive = false;
  let stepIndex = 0;
  let positionFrame = 0;
  let previousFocus = null;
  let currentTarget = null;
  let scrollTargetIntoView = false;
  const backgroundState = new Map();
  const mobileQuery = window.matchMedia('(max-width: 760px)');

  function isRendered(element) {
    if (!element || !element.getClientRects().length) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse';
  }

  function visibleElement(selector) {
    return Array.from(document.querySelectorAll(selector)).find(isRendered) || null;
  }

  function navigationTarget(name) {
    const preferred = mobileQuery.matches ? '.mobile-nav' : '.main-nav';
    return visibleElement(`${preferred} [data-nav="${name}"]`) || visibleElement(`nav [data-nav="${name}"]`);
  }

  const steps = [
    {
      title: '设置一直在顶部',
      text: '顶部设置集中管理外观、API 和题库版本。点击「保存版本」后，可分别勾选题库内容、解析和学习进度；未勾选的内容不写入新版本。也可从这里重看引导。',
      target: () => visibleElement('.topbar .settings-top-button[data-action="theme"]') || visibleElement('.topbar [data-action="theme"]')
    },
    {
      title: '分单元练习',
      text: '从「单元」导航进入分单元练习，再选择要学习的内容。背题、练习与考试的说明，以开始前的实际设置为准。',
      target: () => navigationTarget('banks')
    },
    {
      title: '随机组题',
      text: '从「组题」导航设置随机练习。可按单元、题型或两者叠加设置比例；实际题数与可用题量以页面预览为准。',
      target: () => navigationTarget('paper')
    },
    {
      title: '回到错题，查漏补缺',
      text: '「错题」导航汇总当前版本的错题。可查看移出规则，并按页面提供的操作复习或组题。',
      target: () => navigationTarget('mistakes')
    },
    {
      title: '收藏值得再看的题目',
      text: '在答题时收藏题目，再从「收藏」导航返回查看。引导只介绍入口，不会开始练习或修改你的学习记录。',
      target: () => navigationTarget('favorites')
    },
    {
      title: '个人自定义练习',
      text: '这里是新增单元入口。应用内的个人自定义练习不在须知禁止范围；这不代表允许二次传播或商业发布。具体操作以该入口当前提供的功能为准。',
      target: () => visibleElement('[data-action="add-bank"]'),
      needsBanks: true
    }
  ];

  function hasOtherDialog() {
    return Array.from(document.querySelectorAll('dialog[open]')).some(dialog => dialog !== notice);
  }

  function updateCountdown() {
    const now = performance.now();
    const reading = notice.open && document.visibilityState === 'visible' && document.hasFocus();
    // 只累计前台可见且获得焦点的时段；长时间挂起/休眠不视作阅读。
    if (wasReading && reading) readMilliseconds += Math.min(1000, Math.max(0, now - lastReadTick));
    lastReadTick = now;
    wasReading = reading;
    const remaining = Math.max(0, NOTICE_DELAY_MS - readMilliseconds);
    const seconds = Math.ceil(remaining / 1000);
    acceptButton.disabled = remaining > 0;
    const message = seconds
      ? `${reading ? '请保持本页在前台阅读' : '阅读计时已暂停，请返回本页'}，还需 ${seconds} 秒。`
      : '阅读时间已满，请确认你已阅读并同意以上须知。';
    if (countdown.textContent !== message) countdown.textContent = message;
    acceptButton.textContent = seconds ? `我已阅读并同意以上须知（${seconds} 秒）` : '我已阅读并同意，继续';
    if (!remaining) { clearInterval(countdownTimer); countdownTimer = 0; }
  }

  function showNotice() {
    if (noticeAccepted || notice.open) return;
    notice.showModal();
    wasReading = false;
    clearInterval(countdownTimer);
    countdownTimer = window.setInterval(updateCountdown, 100);
    updateCountdown();
  }

  document.addEventListener('visibilitychange', () => { if (notice.open) updateCountdown(); });
  window.addEventListener('blur', () => { if (notice.open) { updateCountdown(); wasReading = false; } });
  window.addEventListener('focus', () => { if (notice.open) updateCountdown(); });

  // app.js 为所有 dialog 绑定了点击遮罩关闭事件；在捕获阶段仅拦截本须知。
  notice.addEventListener('click', event => {
    if (event.target === notice) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  notice.addEventListener('cancel', event => {
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  notice.addEventListener('close', () => {
    if (!noticeAccepted) showNotice();
  });
  acceptButton.addEventListener('click', () => {
    // 即使强行启用按钮，也必须累计满 5 秒前台阅读时间。
    updateCountdown();
    if (!notice.open || readMilliseconds < NOTICE_DELAY_MS) return;
    noticeAccepted = true;
    clearInterval(countdownTimer);
    saveFlag(NOTICE_KEY);
    notice.close();
    if (!guideSeen) requestGuide();
  });

  function ensureReplayButton() {
    const settings = document.getElementById('settings-dialog');
    if (!settings.querySelector('#settings-title') || settings.querySelector('[data-action="show-guide"]')) return;
    const section = document.createElement('section');
    section.className = 'setting-section guide-replay';
    const copy = document.createElement('div');
    const heading = document.createElement('h3');
    heading.textContent = '使用引导';
    const note = document.createElement('p');
    note.textContent = '重新认识设置、单元、组题、错题与收藏入口。';
    copy.append(heading, note);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button soft';
    button.dataset.action = 'show-guide';
    button.textContent = '重看引导';
    section.append(copy, button);
    settings.insertBefore(section, settings.querySelector('.settings-footer'));
  }

  new MutationObserver(ensureReplayButton).observe(document.getElementById('settings-dialog'), { childList: true, subtree: true });
  ensureReplayButton();
  document.addEventListener('click', event => {
    const trigger = event.target instanceof Element ? event.target.closest('[data-action="show-guide"]') : null;
    if (!trigger) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    previousFocus = trigger;
    const parentDialog = trigger.closest('dialog');
    if (parentDialog?.open) parentDialog.close();
    if (!noticeAccepted) { showNotice(); return; }
    requestGuide();
  }, true);

  function requestGuide() {
    pendingGuide = true;
    stepIndex = 0;
    if (guideActive) {
      scrollTargetIntoView = true;
      schedulePosition();
    } else {
      // 让设置 close 事件完成自己的页面重绘，不操作练习 dialog。
      requestAnimationFrame(tryStartGuide);
    }
  }

  function setBackgroundInert(active) {
    if (active) {
      // 保留所有元素原有 inert 状态；不改动任何业务数据或点击处理器。
      for (const element of document.body.children) {
        if (!(element instanceof HTMLElement) || element === guide || element === notice || element.tagName === 'SCRIPT') continue;
        if (!backgroundState.has(element)) backgroundState.set(element, element.inert);
        element.inert = true;
      }
    } else {
      backgroundState.forEach((inert, element) => { element.inert = inert; });
      backgroundState.clear();
    }
    document.body.classList.toggle('onboarding-active', active);
  }

  function tryStartGuide() {
    if (!pendingGuide || !noticeAccepted || notice.open || hasOtherDialog() || guideActive) return;
    pendingGuide = false;
    guideActive = true;
    if (!previousFocus) previousFocus = document.activeElement;
    guide.dataset.active = 'true';
    if (typeof guide.showPopover === 'function') guide.showPopover();
    setBackgroundInert(true);
    storageNote.hidden = storageAvailable;
    storageNote.textContent = storageAvailable ? '' : '当前浏览器无法保存确认标识，本次仍可使用，下次访问可能需要重新确认。';
    scrollTargetIntoView = true;
    renderStep();
    nextButton.focus({ preventScroll: true });
  }

  function suspendGuide() {
    if (!guideActive) return;
    guideActive = false;
    pendingGuide = true;
    hideGuide();
  }

  function hideGuide() {
    guide.removeAttribute('data-active');
    if (typeof guide.hidePopover === 'function' && guide.matches(':popover-open')) guide.hidePopover();
    setBackgroundInert(false);
    targetResizeObserver?.disconnect();
    currentTarget = null;
    cancelAnimationFrame(positionFrame);
    positionFrame = 0;
  }

  function finishGuide() {
    if (!guideActive) return;
    guideActive = false;
    pendingGuide = false;
    guideSeen = true;
    saveFlag(GUIDE_KEY);
    hideGuide();
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected && isRendered(previousFocus) && !previousFocus.closest('[inert], dialog:not([open])')) {
      previousFocus.focus({ preventScroll: true });
    } else {
      (steps[0].target() || document.getElementById('main')).focus({ preventScroll: true });
    }
    previousFocus = null;
  }

  function renderStep() {
    if (!guideActive) return;
    const step = steps[stepIndex];
    if (step.needsBanks && !step.target() && location.hash !== '#banks') {
      location.hash = 'banks';
    }
    title.textContent = step.title;
    description.textContent = step.text;
    counter.textContent = `${String(stepIndex + 1).padStart(2, '0')} / ${String(steps.length).padStart(2, '0')}`;
    previousButton.disabled = stepIndex === 0;
    nextButton.textContent = stepIndex === steps.length - 1 ? '完成引导' : '下一步';
    const oldTarget = currentTarget;
    currentTarget = step.target();
    if (!currentTarget && step.needsBanks) {
      currentTarget = navigationTarget('banks');
      description.textContent = '当前页面尚未提供可用的新增单元入口；接入后，引导会自动定位该按钮。应用内个人自定义练习不在须知禁止范围，仍请遵守禁止二次传播和商业化的约定。';
    }
    if (currentTarget !== oldTarget) {
      if (oldTarget) targetResizeObserver?.unobserve(oldTarget);
      if (currentTarget) targetResizeObserver?.observe(currentTarget);
      scrollTargetIntoView = true;
    }
    guide.dataset.target = currentTarget?.dataset.action || currentTarget?.dataset.nav || '';
    positionGuide();
  }

  const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));

  function positionGuide() {
    if (!guideActive) return;
    const viewport = window.visualViewport;
    const width = viewport?.width || window.innerWidth;
    const height = viewport?.height || window.innerHeight;
    const leftEdge = viewport?.offsetLeft || 0;
    const topEdge = viewport?.offsetTop || 0;
    const margin = 12;
    const gap = 42;
    card.style.maxWidth = `${Math.max(1, width - margin * 2)}px`;
    card.style.maxHeight = `${Math.max(1, height - margin * 2)}px`;
    if (scrollTargetIntoView && currentTarget) {
      scrollTargetIntoView = false;
      const rect = currentTarget.getBoundingClientRect();
      // 保留固定顶部设置和底部导航的空间，且不触发平滑滚动抖动。
      if (rect.top < topEdge + 88 || rect.bottom > topEdge + height - 88) {
        currentTarget.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
      }
    }
    const rect = currentTarget?.getBoundingClientRect();
    let box = card.getBoundingClientRect();
    const visible = rect && rect.width > 0 && rect.height > 0 && rect.bottom > topEdge && rect.top < topEdge + height && rect.right > leftEdge && rect.left < leftEdge + width;
    if (!visible) {
      outline.hidden = true;
      arrow.setAttribute('d', '');
      card.style.left = `${leftEdge + (width - box.width) / 2}px`;
      card.style.top = `${topEdge + (height - box.height) / 2}px`;
      return;
    }
    outline.hidden = false;
    const target = {
      left: Math.max(leftEdge + 3, rect.left - 4), right: Math.min(leftEdge + width - 3, rect.right + 4),
      top: Math.max(topEdge + 3, rect.top - 4), bottom: Math.min(topEdge + height - 3, rect.bottom + 4)
    };
    const fitsBeside = target.right + gap + box.width <= leftEdge + width - margin || target.left - gap - box.width >= leftEdge + margin;
    if (!fitsBeside) {
      // 小屏/横屏时缩短卡片并允许内部滚动，避免压住目标和箭头。
      const roomAbove = target.top - topEdge - margin - gap;
      const roomBelow = topEdge + height - margin - target.bottom - gap;
      card.style.maxHeight = `${Math.max(1, Math.max(roomAbove, roomBelow))}px`;
      box = card.getBoundingClientRect();
    }
    outline.style.left = `${target.left}px`;
    outline.style.top = `${target.top}px`;
    outline.style.width = `${target.right - target.left}px`;
    outline.style.height = `${target.bottom - target.top}px`;
    const centerX = (target.left + target.right) / 2;
    const centerY = (target.top + target.bottom) / 2;
    let left;
    let top;
    let startX;
    let startY;
    let endX;
    let endY;
    if (target.right + gap + box.width <= leftEdge + width - margin) {
      left = target.right + gap;
      top = clamp(centerY - box.height / 2, topEdge + margin, topEdge + height - box.height - margin);
      startX = left - 7; startY = clamp(centerY, top + 20, top + box.height - 20);
      endX = target.right + 6; endY = centerY;
    } else if (target.left - gap - box.width >= leftEdge + margin) {
      left = target.left - gap - box.width;
      top = clamp(centerY - box.height / 2, topEdge + margin, topEdge + height - box.height - margin);
      startX = left + box.width + 7; startY = clamp(centerY, top + 20, top + box.height - 20);
      endX = target.left - 6; endY = centerY;
    } else {
      left = clamp(centerX - box.width / 2, leftEdge + margin, leftEdge + width - box.width - margin);
      const below = target.bottom + gap + box.height <= topEdge + height - margin;
      const above = target.top - gap - box.height >= topEdge + margin;
      const placeBelow = below || (!above && centerY < topEdge + height / 2);
      top = clamp(placeBelow ? target.bottom + gap : target.top - gap - box.height, topEdge + margin, topEdge + height - box.height - margin);
      startX = clamp(centerX, left + 20, left + box.width - 20);
      startY = placeBelow ? top - 7 : top + box.height + 7;
      endX = centerX; endY = placeBelow ? target.bottom + 6 : target.top - 6;
    }
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
    arrow.setAttribute('d', `M ${startX} ${startY} L ${endX} ${endY}`);
  }

  function schedulePosition() {
    if (!guideActive || positionFrame) return;
    positionFrame = requestAnimationFrame(() => { positionFrame = 0; renderStep(); });
  }

  previousButton.addEventListener('click', () => {
    if (stepIndex > 0) { stepIndex--; scrollTargetIntoView = true; renderStep(); }
  });
  nextButton.addEventListener('click', () => {
    if (stepIndex === steps.length - 1) finishGuide();
    else { stepIndex++; scrollTargetIntoView = true; renderStep(); }
  });
  document.getElementById('guide-skip').addEventListener('click', finishGuide);
  // 覆盖层和 inert 双重阻止鼠标、触摸与键盘误操作底下页面。
  document.addEventListener('click', event => {
    if (guideActive && !card.contains(event.target)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  guide.addEventListener('click', event => event.stopPropagation());
  document.addEventListener('focusin', event => {
    if (guideActive && !hasOtherDialog() && !card.contains(event.target)) nextButton.focus({ preventScroll: true });
  }, true);
  document.addEventListener('keydown', event => {
    if (notice.open) {
      if (event.key === 'Escape') event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!guideActive) return;
    event.stopImmediatePropagation();
    if (event.key === 'Escape') { event.preventDefault(); finishGuide(); }
    else if (event.key === 'Tab') {
      const buttons = Array.from(card.querySelectorAll('button:not(:disabled)'));
      const index = buttons.indexOf(document.activeElement);
      event.preventDefault();
      buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus({ preventScroll: true });
    }
  }, true);
  const targetResizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(schedulePosition) : null;
  document.getElementById('main').addEventListener('animationend', schedulePosition);
  window.addEventListener('resize', schedulePosition, { passive: true });
  window.addEventListener('scroll', schedulePosition, { capture: true, passive: true });
  window.visualViewport?.addEventListener('resize', schedulePosition, { passive: true });
  window.visualViewport?.addEventListener('scroll', schedulePosition, { passive: true });
  new MutationObserver(schedulePosition).observe(document.getElementById('main'), { childList: true, subtree: true });
  new MutationObserver(() => {
    if (hasOtherDialog()) suspendGuide();
    else { tryStartGuide(); schedulePosition(); }
  }).observe(document.body, { attributes: true, attributeFilter: ['open'], subtree: true });

  // app.js 已先行完成路由与练习自动恢复。须知只覆盖在原生顶层，不关闭任何练习。
  if (!noticeAccepted) showNotice();
})();