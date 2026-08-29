(function () {
  // 防止同一页面重复加载这段脚本（比如公共头部+页脚都不小心贴了一份）
  if (window.__MS_WIDGET_LOADED__) return;
  window.__MS_WIDGET_LOADED__ = true;

  // 整体包一层try/catch：任何环境差异导致的异常都只让"客服按钮不出现"，
  // 不会往宿主网站控制台抛错、更不会影响宿主网站其他脚本正常运行
  try {
    boot();
  } catch (e) {
    if (window.console && console.error) console.error('[客服组件] 初始化失败:', e);
  }

  function boot() {
    // 如果脚本被放在了 <head> 里（没按说明放在 </body> 前），document.body 可能还不存在，等DOM就绪再跑
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', function () {
        try { run(); } catch (e) { if (window.console && console.error) console.error('[客服组件] 初始化失败:', e); }
      }, { once: true });
      return;
    }
    run();
  }

  // ---------- 安全的本地存储读写：部分隐私模式/企业策略/内置浏览器会禁用localStorage，
  // 直接调用可能抛错导致整个脚本中断。localStorage不可用时退到当前标签页的
  // sessionStorage；至少网络重连和当前标签页刷新时不会反复生成访客身份。 ----------
  function safeGet(key) {
    try {
      var localValue = localStorage.getItem(key);
      if (localValue) return localValue;
    } catch (e) {}
    try { return sessionStorage.getItem(key); } catch (e2) { return null; }
  }
  function safeSet(key, value) {
    try {
      localStorage.setItem(key, value);
      if (localStorage.getItem(key) === value) return true;
    } catch (e) {}
    try {
      sessionStorage.setItem(key, value);
      return sessionStorage.getItem(key) === value;
    } catch (e2) {
      return false;
    }
  }
  function isSafeIdentityPart(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(value);
  }
  function randomHex(byteLength) {
    try {
      if (!window.crypto || typeof window.crypto.getRandomValues !== 'function') return '';
      var bytes = new Uint8Array(byteLength);
      window.crypto.getRandomValues(bytes);
      return Array.prototype.map.call(bytes, function (b) {
        return b.toString(16).padStart(2, '0');
      }).join('');
    } catch (e) {
      return '';
    }
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function safeColor(value, fallback) {
    value = String(value || '');
    return /^#[0-9A-Fa-f]{6}$/.test(value) ? value : fallback;
  }

  function run() {
  var CONFIG = window.MYSERVICE_CONFIG || {};
  var SERVER = CONFIG.server || (function () {
    var s = document.currentScript || document.querySelector('script[src*="widget.js"]');
    var u;
    try { u = new URL(s.src); } catch (e) { return ''; }
    return u.origin;
  })();
  if (!SERVER) return; // 拿不到服务器地址就不渲染，避免半成品UI

  function afterConfig(remote) { init(remote || {}); }
  if (typeof fetch === 'function') {
    fetch(SERVER + '/api/widget-config')
      .then(function (r) { return r.ok ? r.json() : {}; })
      .catch(function () { return {}; })
      .then(afterConfig);
  } else {
    afterConfig({}); // 极老旧环境没有fetch，直接用默认外观，不影响基础聊天功能
  }

  function init(remote) {
  // 优先级：嵌入代码里显式配置 > 后台"设置"里保存的外观 > 默认值
  var PRIMARY = safeColor(CONFIG.color || remote.color, '#6D5DFB');
  var SECONDARY = safeColor(CONFIG.color2 || remote.color2, PRIMARY);
  var GRADIENT = 'linear-gradient(160deg, ' + PRIMARY + ', ' + SECONDARY + ')';
  var LAUNCHER_TEXT = String(CONFIG.launcherText != null ? CONFIG.launcherText : (remote.launcherText != null ? remote.launcherText : '点我联系客服')).slice(0, 40);
  var WELCOME_MESSAGE = String(CONFIG.welcomeMessage != null ? CONFIG.welcomeMessage : (remote.welcomeMessage != null ? remote.welcomeMessage : '')).slice(0, 500);
  var TITLE = String(CONFIG.title || remote.title || '在线客服').slice(0, 80);
  var MENU_TREE = Array.isArray(remote.menu) ? remote.menu : [];

  var STORAGE_KEY = 'myservice_visitor';
  var stored = {};
  try { stored = JSON.parse(safeGet(STORAGE_KEY) || '{}'); } catch (e) {}
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) stored = {};

  // 首次访问时先由浏览器同步生成高强度随机身份，再发起网络连接。这样Socket.IO
  // 即使在session_info返回前遇到断网重连，也不会再次拿空身份让服务器创建新访客。
  // 老版本已经有visitorId但还没有secret时保留原ID，由服务器完成一次性安全升级。
  if (!isSafeIdentityPart(stored.visitorId)) {
    var initialVisitorId = randomHex(16);
    var initialVisitorSecret = randomHex(32);
    if (initialVisitorId && initialVisitorSecret) {
      stored.visitorId = initialVisitorId;
      stored.visitorSecret = initialVisitorSecret;
      stored.conversationId = '';
      safeSet(STORAGE_KEY, JSON.stringify(stored));
      // 多标签页几乎同时首次打开时，以存储中最终可见的身份为准。
      try {
        var confirmedStored = JSON.parse(safeGet(STORAGE_KEY) || '{}');
        if (isSafeIdentityPart(confirmedStored.visitorId) && isSafeIdentityPart(confirmedStored.visitorSecret)) {
          stored = confirmedStored;
        }
      } catch (e) {}
    }
  }

  // ---------- 样式 ----------
  var style = document.createElement('style');
  style.textContent = `
    #ms-panel {
      --ms-panel-bg: #fff; --ms-msg-bg: #F7F8FA; --ms-bubble-bg: #fff;
      --ms-bubble-border: #E5E7EB; --ms-text: #111; --ms-muted: #666; --ms-input-bg: #fff;
    }
    #ms-panel.ms-dark {
      --ms-panel-bg: #1B1D23; --ms-msg-bg: #16171C; --ms-bubble-bg: #21242B;
      --ms-bubble-border: #2A2D35; --ms-text: #E8E9ED; --ms-muted: #9599A3; --ms-input-bg: #21242B;
    }
    #ms-theme-toggle { background: none; border: none; color: #fff; font-size: 16px; cursor: pointer;
      opacity: .85; padding: 4px; flex-shrink: 0; }
    #ms-theme-toggle:hover { opacity: 1; }
    #ms-launcher { position: fixed; bottom: 22px; right: 20px; z-index: 999998;
      display: flex; flex-direction: column; align-items: center; cursor: pointer; touch-action: none; }
    #ms-tag { background: ${GRADIENT}; color: #fff; font-size: 13px; letter-spacing: 3px;
      -webkit-writing-mode: vertical-rl; writing-mode: vertical-rl; text-orientation: upright; padding: 12px 7px;
      border-radius: 16px 16px 6px 6px; box-shadow: 0 4px 14px rgba(0,0,0,.18);
      margin-bottom: -6px; transition: opacity .2s, transform .2s; user-select: none; }
    #ms-btn { position: relative; width: 64px; height: 64px; border-radius: 50%;
      background: ${GRADIENT}; box-shadow: 0 4px 14px rgba(0,0,0,.2);
      display: flex; align-items: center; justify-content: center;
      transition: transform .2s; flex-shrink: 0; }
    #ms-launcher:hover #ms-btn { transform: scale(1.06); }
    #ms-btn svg { width: 28px; height: 28px; fill: #fff; }
    #ms-badge { position: absolute; top: -2px; right: -2px; background: #EF4444; color: #fff;
      font-size: 11px; min-width: 18px; height: 18px; border-radius: 9px; display: none;
      align-items: center; justify-content: center; padding: 0 4px; font-family: sans-serif; }
    #ms-panel { position: fixed; bottom: 6px; right: 20px; width: 400px; max-width: calc(100vw - 32px);
      height: 560px; max-height: calc(100vh - 26px); background: var(--ms-panel-bg); border-radius: 16px;
      box-shadow: 0 12px 40px rgba(0,0,0,.25); display: none; flex-direction: column; overflow: hidden;
      z-index: 999999; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    #ms-panel.open { display: flex; }
    #ms-header { background: ${GRADIENT}; color: #fff; padding: 16px 18px; font-size: 18px; font-weight: 600;
      display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-shrink: 0; }
    #ms-header > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #ms-collapse-btn { background: rgba(255,255,255,.2); border: none; border-radius: 50%; width: 26px; height: 26px;
      display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; padding: 0; }
    #ms-collapse-btn svg { width: 14px; height: 14px; fill: #fff; }
    #ms-collapse-btn:hover { background: rgba(255,255,255,.32); }
    #ms-intro { padding: 12px 18px; font-size: 13px; line-height: 1.5; color: var(--ms-muted);
      background: var(--ms-msg-bg); border-bottom: 1px solid var(--ms-bubble-border); flex-shrink: 0; }
    #ms-messages { flex: 1; overflow-y: auto; padding: 12px; background: var(--ms-msg-bg); position: relative; }
    .ms-row { display: flex; margin-bottom: 10px; }
    .ms-row.me { justify-content: flex-end; }
    .ms-col { display: flex; flex-direction: column; max-width: 78%; }
    .ms-row.me .ms-col { align-items: flex-end; }
    .ms-row:not(.me) .ms-col { align-items: flex-start; }
    .ms-bubble { padding: 11px 15px; border-radius: 12px; font-size: 17px; line-height: 1.5;
      word-break: break-word; white-space: pre-wrap; }
    .ms-row:not(.me) .ms-bubble { background: var(--ms-bubble-bg); border: 1px solid var(--ms-bubble-border); color: var(--ms-text); border-bottom-left-radius: 4px; }
    .ms-row.me .ms-bubble { background: ${PRIMARY}; color: #fff; border-bottom-right-radius: 4px; }
    .ms-quote-block { margin: -3px -6px 9px; padding: 8px 10px; border-left: 4px solid ${PRIMARY};
      border-radius: 8px; background: var(--ms-bubble-bg); background: color-mix(in srgb, ${PRIMARY} 12%, var(--ms-bubble-bg)); white-space: normal; }
    .ms-quote-label { margin-bottom: 3px; color: ${PRIMARY}; font-size: 11px; font-weight: 800; }
    .ms-quote-text { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 4; overflow: hidden;
      font-size: 13px; line-height: 1.42; opacity: .88; white-space: pre-wrap; }
    .ms-row.me .ms-quote-block { border-left-color: #fff; background: rgba(255,255,255,.17); }
    .ms-row.me .ms-quote-label { color: #fff; }
    .ms-text-body { white-space: pre-wrap; }
    .ms-bubble img { max-width: 100%; border-radius: 8px; display: block; }
    .ms-bubble a.ms-file { color: inherit; text-decoration: underline; }
    .ms-time { font-size: 10px; color: var(--ms-muted); margin-top: 3px; padding: 0 4px; }
    .ms-bubble a.ms-link { color: inherit; text-decoration: underline; word-break: break-all; }
    #ms-inputbar { position: relative; display: flex; align-items: center; gap: 8px; padding: 10px; border-top: 1px solid var(--ms-bubble-border); background: var(--ms-panel-bg); }
    #ms-input { flex: 1; border: 1px solid var(--ms-bubble-border); background: var(--ms-input-bg); color: var(--ms-text);
      border-radius: 20px; padding: 8px 14px; font-size: 16px; outline: none; min-width: 0; }
    #ms-send, #ms-attach, #ms-emoji { background: none; border: none; cursor: pointer; color: ${PRIMARY}; padding: 6px; flex-shrink: 0; }
    #ms-send svg, #ms-attach svg { width: 20px; height: 20px; fill: currentColor; }
    #ms-emoji { font-size: 18px; line-height: 1; }
    #ms-emoji-popup { position: absolute; bottom: 56px; left: 10px; width: 220px; max-height: 180px; overflow-y: auto;
      background: var(--ms-bubble-bg); border: 1px solid var(--ms-bubble-border); border-radius: 10px;
      box-shadow: 0 8px 24px rgba(0,0,0,.25); z-index: 3; padding: 6px;
      display: none; grid-template-columns: repeat(7, 1fr); gap: 2px; }
    #ms-emoji-popup.show { display: grid; }
    .ms-emoji-item { background: none; border: none; font-size: 18px; cursor: pointer; padding: 4px; border-radius: 6px; line-height: 1; }
    .ms-emoji-item:hover { background: var(--ms-msg-bg); }
    .ms-gate-card { position: absolute; left: 0; right: 0; bottom: 0; z-index: 20;
      background: var(--ms-panel-bg); border-top: 1px solid var(--ms-bubble-border);
      border-radius: 0 0 16px 16px; padding: 18px 16px; text-align: center;
      box-shadow: 0 -6px 20px rgba(0,0,0,.18); }
    .ms-gate-card h4 { margin: 0 0 6px; font-size: 15px; font-weight: 600; color: var(--ms-text); }
    .ms-gate-card p { margin: 0 0 12px; font-size: 13px; color: var(--ms-muted); line-height: 1.4; }
    .ms-gate-card input { width: 100%; border: 1px solid var(--ms-bubble-border); background: var(--ms-input-bg); color: var(--ms-text);
      border-radius: 8px; padding: 10px 12px; font-size: 16px; outline: none; margin-bottom: 10px; box-sizing: border-box; }
    .ms-gate-card input:focus { border-color: ${PRIMARY}; }
    .ms-gate-btns { display: flex; gap: 8px; }
    .ms-gate-btns button { flex: 1; border-radius: 8px; padding: 10px; font-size: 14px; font-weight: 600; cursor: pointer; border: none; }
    .ms-gate-submit { background: ${PRIMARY}; color: #fff; }
    .ms-gate-skip { background: var(--ms-msg-bg); color: var(--ms-muted); border: 1px solid var(--ms-bubble-border) !important; }
    .ms-gate-err { color: #F87171; font-size: 11px; margin-top: -6px; margin-bottom: 8px; text-align: left; }
    #ms-typing { padding: 4px 12px; font-size: 12px; color: var(--ms-muted); display: none; background: var(--ms-msg-bg); }
    #ms-typing.show { display: block; }
    #ms-menu-view { position: absolute; inset: 0; background: var(--ms-msg-bg); overflow-y: auto;
      padding: 14px; display: none; flex-direction: column; gap: 10px; z-index: 2; }
    #ms-menu-view.show { display: flex; }
    .ms-menu-back { align-self: flex-start; background: none; border: none; color: ${PRIMARY};
      font-size: 14px; font-weight: 600; cursor: pointer; padding: 4px 2px; margin-bottom: 2px; }
    .ms-menu-pill { display: block; width: 100%; background: var(--ms-bubble-bg); border: 1px solid var(--ms-bubble-border);
      color: ${PRIMARY}; font-size: 16px; font-weight: 500; border-radius: 20px; padding: 13px 18px;
      text-align: center; cursor: pointer; }
    .ms-menu-pill:hover { border-color: ${PRIMARY}; }
    .ms-menu-answer { background: var(--ms-bubble-bg); border: 1px solid var(--ms-bubble-border);
      border-radius: 12px; padding: 14px 16px; font-size: 16px; line-height: 1.6; color: var(--ms-text); white-space: pre-wrap; }
    .ms-menu-answer-title { font-size: 16px; font-weight: 600; margin-bottom: 8px; color: var(--ms-text); }

    @media (max-width: 480px) {
      #ms-tag { display: none; }
      #ms-launcher { bottom: 16px; right: 16px; }
      #ms-btn { width: 56px; height: 56px; }
      #ms-btn svg { width: 24px; height: 24px; }
      #ms-panel { right: 6px; bottom: 6px; width: calc(100vw - 12px);
        height: min(560px, calc(100vh - 12px)); max-height: calc(100vh - 12px); }
    }
  `;
  document.head.appendChild(style);

  // ---------- DOM：悬浮按钮（含可选竖排标签） ----------
  var launcher = document.createElement('div');
  launcher.id = 'ms-launcher';
  var tagHtml = LAUNCHER_TEXT ? '<div id="ms-tag">' + escapeHtml(LAUNCHER_TEXT) + '</div>' : '';
  launcher.innerHTML = tagHtml +
    '<div id="ms-btn"><svg viewBox="0 0 24 24"><path d="M4 4h16v12H7l-3 3V4z"/></svg><div id="ms-badge">0</div></div>';
  document.body.appendChild(launcher);

  var tagEl = document.getElementById('ms-tag');
  // 标签不再永久记忆隐藏状态：每次重新打开/刷新页面都会显示，只有这次访问期间点开过聊天窗才会隐藏

  var panel = document.createElement('div');
  panel.id = 'ms-panel';
  panel.innerHTML = `
    <div id="ms-header">
      <span>${escapeHtml(TITLE)}</span>
      <button id="ms-theme-toggle" title="切换深浅色">🌙</button>
      <button id="ms-collapse-btn" title="收起"><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
    </div>
    <div id="ms-intro" style="display:none"></div>
    <div id="ms-messages"><div id="ms-menu-view"></div></div>
    <div id="ms-typing">客服正在输入…</div>
    <div id="ms-inputbar">
      <button id="ms-attach" title="发送文件"><svg viewBox="0 0 24 24"><path d="M16.5 6.5l-8 8a3 3 0 104.24 4.24l7-7a1 1 0 111.42 1.42l-7 7a5 5 0 11-7.08-7.08l8-8a3 3 0 114.24 4.24l-7.5 7.5a1 1 0 01-1.42-1.42l7-7z"/></svg></button>
      <button id="ms-emoji" title="表情">😊</button>
      <input id="ms-input" placeholder="输入消息..." />
      <button id="ms-send"><svg viewBox="0 0 24 24"><path d="M3 20l18-8L3 4v6l12 2-12 2z"/></svg></button>
      <input id="ms-file" type="file" style="display:none" />
      <div id="ms-emoji-popup"></div>
    </div>
  `;
  document.body.appendChild(panel);

  var messagesEl = document.getElementById('ms-messages');

  // ---------- 简介（固定展示在标题下方，不占用聊天记录，不是一条消息）----------
  var introEl = document.getElementById('ms-intro');
  if (WELCOME_MESSAGE) {
    introEl.textContent = WELCOME_MESSAGE;
    introEl.style.display = 'block';
  }

  // ---------- 邮箱采集卡片：客户发完第一条消息后才弹出（不再是一打开聊天窗就弹），
  // 样式改成标题+说明+输入框+两个并排按钮。
  // 注意：跳过只是这一次会话不再问，不会永久记住——只要客户没有真正留下邮箱，
  // 下次重新打开页面（哪怕就是刷新一下）还是会再问一次，直到留了邮箱为止 ----------
  var gateShownThisSession = false; // 只防止同一次打开页面内重复弹，不代表"以后都不弹了"
  function insertGateCard(onDone) {
    if (stored.email) return; // 已经真正留过邮箱了，不用再问
    if (panel.querySelector('.ms-gate-card')) return; // 已经在展示了，不重复插入
    gateShownThisSession = true;
    var card = document.createElement('div');
    card.className = 'ms-gate-card';
    card.innerHTML = `
      <h4>您的电子邮件地址是？</h4>
      <p>请输入您的电子邮件，以便我们及时回复您</p>
      <input type="email" placeholder="输入您的电子邮件地址" />
      <div class="ms-gate-err" style="display:none"></div>
      <div class="ms-gate-btns">
        <button class="ms-gate-skip" type="button">跳过</button>
        <button class="ms-gate-submit" type="button">设置我的电子邮件</button>
      </div>
    `;
    panel.appendChild(card); // 挂在面板上，盖住输入框，不是插进消息列表里滚走的

    var emailInput = card.querySelector('input');
    var submitBtn = card.querySelector('.ms-gate-submit');
    var errEl = card.querySelector('.ms-gate-err');

    function dismiss() {
      if (card.parentNode) card.parentNode.removeChild(card);
    }
    card.querySelector('.ms-gate-skip').onclick = dismiss;
    submitBtn.onclick = function () {
      var v = emailInput.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
        errEl.textContent = '请输入正确的邮箱地址';
        errEl.style.display = 'block';
        return;
      }
      stored.email = v;
      safeSet(STORAGE_KEY, JSON.stringify(stored));
      if (onDone) onDone(v);
      if (card.parentNode) card.parentNode.removeChild(card);
    };
    emailInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') submitBtn.click(); });
    emailInput.addEventListener('focus', function () {
      setTimeout(adjustForKeyboard, 50);
      setTimeout(adjustForKeyboard, 300);
    });
  }

  var badge = document.getElementById('ms-badge');
  var inputEl = document.getElementById('ms-input');
  var fileEl = document.getElementById('ms-file');
  var unread = 0;
  var isOpen = false;
  var socket; // 提升到这一层作用域，Socket.IO脚本加载完成后才会真正赋值
  var originalPageTitle = document.title;
  var titleFlashTimer = null;
  var titleFlashOn = false;
  var notificationAudioContext = null;

  function isConversationVisible() {
    return isOpen && document.visibilityState !== 'hidden';
  }

  function updateUnreadIndicators() {
    if (unread <= 0) {
      badge.style.display = 'none';
      clearInterval(titleFlashTimer);
      titleFlashTimer = null;
      titleFlashOn = false;
      document.title = originalPageTitle;
      return;
    }

    badge.textContent = unread > 99 ? '99+' : unread;
    badge.style.display = 'flex';
    if (titleFlashTimer) return;

    titleFlashOn = true;
    document.title = '【' + unread + '条新消息】' + originalPageTitle;
    titleFlashTimer = setInterval(function () {
      titleFlashOn = !titleFlashOn;
      document.title = titleFlashOn ? '【' + unread + '条新消息】' + originalPageTitle : originalPageTitle;
    }, 1200);
  }

  function clearUnreadIndicators() {
    unread = 0;
    updateUnreadIndicators();
  }

  // 浏览器不允许网页在用户从未操作过页面时自动播放声音。
  // 第一次点击、触摸或按键时提前解锁 AudioContext，之后客服消息即可正常响铃。
  function unlockNotificationAudio() {
    if (!notificationAudioContext) {
      var AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      try { notificationAudioContext = new AudioContextClass(); } catch (e) { return; }
    }
    if (notificationAudioContext.state === 'suspended') {
      notificationAudioContext.resume().catch(function () {});
    }
  }

  function playIncomingMessageSound() {
    if (!notificationAudioContext) return;

    function play() {
      if (notificationAudioContext.state !== 'running') return;
      var start = notificationAudioContext.currentTime;
      // 高音“叮”接低音“咚”，每一声独立衰减，听感比单调蜂鸣更自然。
      [
        { frequency: 1046.5, delay: 0, volume: 0.18 },
        { frequency: 659.25, delay: 0.22, volume: 0.16 }
      ].forEach(function (tone) {
        var toneStart = start + tone.delay;
        var gain = notificationAudioContext.createGain();
        gain.gain.setValueAtTime(0.0001, toneStart);
        gain.gain.exponentialRampToValueAtTime(tone.volume, toneStart + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, toneStart + 0.32);
        gain.connect(notificationAudioContext.destination);

        var oscillator = notificationAudioContext.createOscillator();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(tone.frequency, toneStart);
        oscillator.connect(gain);
        oscillator.start(toneStart);
        oscillator.stop(toneStart + 0.33);
      });
    }

    if (notificationAudioContext.state === 'suspended') {
      notificationAudioContext.resume().then(play).catch(function () {});
    } else {
      play();
    }
  }

  document.addEventListener('click', unlockNotificationAudio, { passive: true });
  document.addEventListener('touchstart', unlockNotificationAudio, { passive: true });
  document.addEventListener('keydown', unlockNotificationAudio);

  document.addEventListener('visibilitychange', function () {
    if (!isConversationVisible()) return;
    clearUnreadIndicators();
    if (socket && socket.connected) socket.emit('visitor_read');
  });

  function setPanelOpen(open) {
    isOpen = open;
    panel.classList.toggle('open', isOpen);
    launcher.style.display = isOpen ? 'none' : 'flex';
    if (isOpen) {
      clearUnreadIndicators();
      if (socket && socket.connected && isConversationVisible()) socket.emit('visitor_read');
      if (tagEl && tagEl.style.display !== 'none') {
        tagEl.style.display = 'none';
      }
      // 面板打开之前如果历史消息已经渲染好了，那时候面板是display:none的，
      // 设置scrollTop在隐藏元素上是无效的，所以每次真正打开的时候都要重新滚一次到底部
      scrollMessagesToBottom();
    }
  }

  // 等消息区里的图片都加载完（避免图片还没下载完就滚动，停的位置会差一截），再滚动到底部
  function waitForImagesThenScroll() {
    var imgs = Array.prototype.slice.call(messagesEl.querySelectorAll('img'));
    var wait = !imgs.length ? Promise.resolve() : Promise.race([
      Promise.all(imgs.map(function (img) {
        return img.complete ? Promise.resolve() : new Promise(function (res) {
          img.addEventListener('load', res, { once: true });
          img.addEventListener('error', res, { once: true });
        });
      })),
      new Promise(function (res) { setTimeout(res, 1500); })
    ]);
    return wait;
  }
  function scrollMessagesToBottom() {
    waitForImagesThenScroll().then(function () {
      if (window.requestAnimationFrame) {
        requestAnimationFrame(function () {
          requestAnimationFrame(function () { messagesEl.scrollTop = messagesEl.scrollHeight; });
        });
      } else {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
    });
  }

  // ---------- 悬浮按钮可拖拽定位 ----------
  var LAUNCHER_POS_KEY = 'myservice_launcher_pos';
  (function applyStoredLauncherPos() {
    var saved = safeGet(LAUNCHER_POS_KEY);
    if (!saved) return;
    try {
      var pos = JSON.parse(saved);
      if (typeof pos.left === 'number' && typeof pos.top === 'number') {
        launcher.style.left = pos.left + 'px';
        launcher.style.top = pos.top + 'px';
        launcher.style.right = 'auto';
        launcher.style.bottom = 'auto';
      }
    } catch (e) {}
  })();

  var dragging = false;
  var dragMoved = false;
  var dragStartX = 0, dragStartY = 0, dragStartLeft = 0, dragStartTop = 0;
  var DRAG_THRESHOLD = 8; // 移动超过这个距离才算拖动，否则算点击

  launcher.addEventListener('touchstart', function (e) {
    if (e.touches.length !== 1) return;
    dragging = true;
    dragMoved = false;
    var t = e.touches[0];
    var rect = launcher.getBoundingClientRect();
    dragStartX = t.clientX;
    dragStartY = t.clientY;
    dragStartLeft = rect.left;
    dragStartTop = rect.top;
  }, { passive: true });

  launcher.addEventListener('touchmove', function (e) {
    if (!dragging) return;
    var t = e.touches[0];
    var dx = t.clientX - dragStartX;
    var dy = t.clientY - dragStartY;
    if (!dragMoved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
    dragMoved = true;
    var rect = launcher.getBoundingClientRect();
    var maxLeft = window.innerWidth - rect.width;
    var maxTop = window.innerHeight - rect.height;
    var newLeft = Math.max(0, Math.min(dragStartLeft + dx, maxLeft));
    var newTop = Math.max(0, Math.min(dragStartTop + dy, maxTop));
    launcher.style.left = newLeft + 'px';
    launcher.style.top = newTop + 'px';
    launcher.style.right = 'auto';
    launcher.style.bottom = 'auto';
  }, { passive: true });

  launcher.addEventListener('touchend', function (e) {
    if (dragging && dragMoved) {
      var rect = launcher.getBoundingClientRect();
      safeSet(LAUNCHER_POS_KEY, JSON.stringify({ left: rect.left, top: rect.top }));
      e.preventDefault(); // 拖动结束时把紧跟着的click事件吃掉，避免拖完顺带把聊天窗打开了
    }
    dragging = false;
  }, { passive: false });

  launcher.onclick = function () {
    if (dragMoved) { dragMoved = false; return; } // 刚拖完不算点击
    setPanelOpen(!isOpen);
  };
  document.getElementById('ms-collapse-btn').onclick = function (e) {
    e.stopPropagation();
    setPanelOpen(false); // 收起面板，访客可以继续正常浏览网站，随时点悬浮按钮再打开
  };

  // ---------- 深浅色手动切换（不再跟随系统，客户自己点按钮切换，选择会记住）----------
  var THEME_KEY = 'myservice_theme';
  var themeToggleBtn = document.getElementById('ms-theme-toggle');
  function applyTheme(dark) {
    panel.classList.toggle('ms-dark', dark);
    themeToggleBtn.textContent = dark ? '☀️' : '🌙';
  }
  applyTheme(safeGet(THEME_KEY) === 'dark');
  themeToggleBtn.onclick = function (e) {
    e.stopPropagation();
    var isDark = panel.classList.contains('ms-dark');
    applyTheme(!isDark);
    safeSet(THEME_KEY, !isDark ? 'dark' : 'light');
  };

  document.getElementById('ms-attach').onclick = function (e) { e.stopPropagation(); fileEl.click(); };
  panel.onclick = function (e) {
    if (emojiPopup.classList.contains('show') && !emojiPopup.contains(e.target) && e.target.id !== 'ms-emoji') {
      emojiPopup.classList.remove('show');
    }
    e.stopPropagation();
  };

  // ---------- 键盘弹出时主动把面板顶到键盘上方 ----------
  // iOS Safari对 position:fixed 元素在键盘弹出时的重新定位经常不可靠（尤其是第一次弹键盘的时候），
  // 用 visualViewport 主动测量、手动调整，比干等浏览器自己处理更稳
  var baseBottom = 6;
  function adjustForKeyboard() {
    if (!window.visualViewport) return;
    var vv = window.visualViewport;
    var keyboardHeight = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    panel.style.bottom = (keyboardHeight > 40 ? keyboardHeight + baseBottom : baseBottom) + 'px';
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', adjustForKeyboard);
    window.visualViewport.addEventListener('scroll', adjustForKeyboard);
    inputEl.addEventListener('focus', function () { setTimeout(adjustForKeyboard, 50); setTimeout(adjustForKeyboard, 300); });
    inputEl.addEventListener('blur', function () { setTimeout(adjustForKeyboard, 50); });
  }

  function fmtMsgTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var now = new Date();
    var hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    var sameDay = d.toDateString() === now.toDateString();
    return sameDay ? hm : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
  }

  // ---------- 菜单式引导：客户点选项，有子项就往下钻一层，没有就显示预设内容 ----------


  // ---------- 菜单式引导：铺满整个消息区的列表，点击进下一层，顶部有返回按钮 ----------
  var menuViewEl = document.getElementById('ms-menu-view');
  var menuStack = []; // 每层放 {items: [...]} 或 {answer: {title, content}}，栈顶是当前展示的层级
  function currentMenuLevel() {
    return menuStack.length ? menuStack[menuStack.length - 1] : { items: MENU_TREE };
  }
  function renderMenuView() {
    menuViewEl.innerHTML = '';
    if (menuStack.length) {
      var backBtn = document.createElement('button');
      backBtn.type = 'button';
      backBtn.className = 'ms-menu-back';
      backBtn.textContent = '‹ 返回上一级';
      backBtn.onclick = function () {
        menuStack.pop();
        renderMenuView();
      };
      menuViewEl.appendChild(backBtn);
    }
    var level = currentMenuLevel();
    if (level.answer) {
      var ans = document.createElement('div');
      ans.className = 'ms-menu-answer';
      var t = document.createElement('div');
      t.className = 'ms-menu-answer-title';
      t.textContent = level.answer.title;
      ans.appendChild(t);
      ans.appendChild(document.createTextNode(level.answer.content));
      menuViewEl.appendChild(ans);
    } else {
      level.items.forEach(function (item) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ms-menu-pill';
        btn.textContent = item.title;
        btn.onclick = function () {
          if (item.children && item.children.length) {
            menuStack.push({ items: item.children });
          } else if (item.content) {
            menuStack.push({ answer: { title: item.title, content: item.content } });
          }
          renderMenuView();
        };
        menuViewEl.appendChild(btn);
      });
    }
  }
  function showMenuView() {
    if (!MENU_TREE.length) return;
    menuStack = [];
    renderMenuView();
    menuViewEl.classList.add('show');
  }
  function hideMenuView() {
    menuViewEl.classList.remove('show');
  }

  function parseQuotedMessage(text) {
    if (typeof text !== 'string' || text.charAt(0) !== '「') return null;
    var quoteEnd = text.lastIndexOf('」\n');
    if (quoteEnd <= 1 || quoteEnd + 2 >= text.length) return null;
    return { quote: text.slice(1, quoteEnd), body: text.slice(quoteEnd + 2) };
  }

  function renderMessageText(container, text) {
    var parts = parseQuotedMessage(text);
    if (parts) {
      var quote = document.createElement('div');
      quote.className = 'ms-quote-block';
      quote.innerHTML = '<div class="ms-quote-label">↩ 引用消息</div><div class="ms-quote-text">' + linkify(parts.quote) + '</div>';
      container.appendChild(quote);
    }
    var body = document.createElement('div');
    body.className = 'ms-text-body';
    body.innerHTML = linkify(parts ? parts.body : text);
    container.appendChild(body);
  }

  function renderMessage(m) {
    var row = document.createElement('div');
    row.className = 'ms-row' + (m.sender === 'visitor' ? ' me' : '');
    row.setAttribute('data-msg-id', m.id);
    var col = document.createElement('div');
    col.className = 'ms-col';
    var bubble = document.createElement('div');
    bubble.className = 'ms-bubble';
    if (m.type === 'image') {
      var img = document.createElement('img');
      img.src = SERVER + m.content;
      bubble.appendChild(img);
    } else if (m.type === 'file') {
      var a = document.createElement('a');
      a.className = 'ms-file';
      a.href = SERVER + m.content;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = '📎 ' + (m.file_name || '文件');
      bubble.appendChild(a);
    } else {
      renderMessageText(bubble, m.content);
    }
    col.appendChild(bubble);
    var timeEl = document.createElement('div');
    timeEl.className = 'ms-time';
    timeEl.textContent = fmtMsgTime(m.created_at);
    col.appendChild(timeEl);
    row.appendChild(col);
    messagesEl.appendChild(row);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function linkify(text) {
    var escaped = escapeHtml(text);
    var urlRegex = /((https?:\/\/|www\.)[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]+)/gi;
    return escaped.replace(urlRegex, function (match) {
      var trail = '';
      var trailMatch = match.match(/[),.!?;:'"]+$/);
      if (trailMatch) {
        trail = trailMatch[0];
        match = match.slice(0, -trail.length);
      }
      var href = /^https?:\/\//i.test(match) ? match : 'https://' + match;
      return '<a class="ms-link" href="' + href + '" target="_blank" rel="noopener noreferrer">' + match + '</a>' + trail;
    });
  }

  // ---------- 表情 ----------
  var EMOJI_LIST = ['😀','😁','😂','🤣','😊','😍','😘','😜','🤔','🙄','😴','😅','😇','🥳','😭','😡',
    '👍','👎','👏','🙏','🤝','💪','👌','✌️','🙌','👋','🤗','😱','😢','😉','😎','🥰',
    '❤️','🧡','💛','💚','💙','💜','🖤','💯','🔥','✨','🎉','🎁','⭐','☀️','🌈','☕',
    '✅','❌','⚠️','❓','❗','💡','📌','📷','📎','🕐'];
  var emojiPopup = document.getElementById('ms-emoji-popup');
  var emojiFilled = false;
  document.getElementById('ms-emoji').onclick = function (e) {
    e.stopPropagation();
    if (emojiPopup.classList.contains('show')) { emojiPopup.classList.remove('show'); return; }
    if (!emojiFilled) {
      EMOJI_LIST.forEach(function (emo) {
        var b = document.createElement('button');
        b.className = 'ms-emoji-item';
        b.type = 'button';
        b.textContent = emo;
        b.onclick = function (ev) {
          ev.stopPropagation();
          var start = inputEl.selectionStart != null ? inputEl.selectionStart : inputEl.value.length;
          var end = inputEl.selectionEnd != null ? inputEl.selectionEnd : inputEl.value.length;
          inputEl.value = inputEl.value.slice(0, start) + emo + inputEl.value.slice(end);
          var pos = start + emo.length;
          inputEl.focus();
          if (inputEl.setSelectionRange) inputEl.setSelectionRange(pos, pos);
        };
        emojiPopup.appendChild(b);
      });
      emojiFilled = true;
    }
    emojiPopup.classList.add('show');
  };
  document.addEventListener('click', function (e) {
    if (emojiPopup.classList.contains('show') && !emojiPopup.contains(e.target) && e.target.id !== 'ms-emoji') {
      emojiPopup.classList.remove('show');
    }
  });

  // ---------- Socket.IO ----------
  var scriptTag = document.createElement('script');
  scriptTag.src = SERVER + '/socket.io/socket.io.js';
  var connectTimeout = setTimeout(onLoadFail, 8000); // 网络慢/被拦截时，8秒还没连上就提示
  scriptTag.onerror = onLoadFail;
  function onLoadFail() {
    clearTimeout(connectTimeout);
    if (messagesEl.dataset.msFailed) return;
    messagesEl.dataset.msFailed = '1';
    var row = document.createElement('div');
    row.id = 'ms-fail-row';
    row.className = 'ms-row';
    var bubble = document.createElement('div');
    bubble.className = 'ms-bubble';
    bubble.style.color = '#E11D48';
    bubble.textContent = '连接失败，请检查网络后重新打开页面试试';
    row.appendChild(bubble);
    messagesEl.appendChild(row);
  }
  function clearFailMessage() {
    delete messagesEl.dataset.msFailed;
    var row = document.getElementById('ms-fail-row');
    if (row && row.parentNode) row.parentNode.removeChild(row);
  }
  scriptTag.onload = function () {
    clearTimeout(connectTimeout);
    socket = io(SERVER, {
      query: {
        role: 'visitor',
        url: location.href
      },
      // auth回调会在每一次初连和自动重连前重新执行，始终使用session_info
      // 最近一次保存的身份，避免网络抖动时继续携带首次连接的空参数。
      auth: function (callback) {
        callback({
          role: 'visitor',
          visitorId: stored.visitorId || '',
          visitorSecret: stored.visitorSecret || '',
          conversationId: stored.conversationId || '',
          email: stored.email || ''
        });
      }
    });
    // 网络抖动会瞬时触发connect_error，Socket.IO自己会自动重连，
    // 等5秒确认真的连不上了再提示，避免误报；一旦重连成功就把提示清掉
    var errorTimer = null;
    socket.on('connect_error', function () {
      if (!errorTimer) errorTimer = setTimeout(onLoadFail, 5000);
    });
    socket.on('connect', function () {
      clearTimeout(errorTimer);
      errorTimer = null;
      clearFailMessage();
    });

    socket.on('session_info', function (data) {
      stored.visitorId = data.visitorId;
      stored.visitorSecret = data.visitorSecret;
      stored.conversationId = data.conversationId;
      safeSet(STORAGE_KEY, JSON.stringify(stored));
    });

    socket.on('history', function (msgs) {
      msgs.forEach(renderMessage);
      if (msgs.some(function (m) { return m.sender === 'agent'; })) {
        socket.emit(isConversationVisible() ? 'visitor_read' : 'visitor_delivered');
      }
      if (!msgs.length && MENU_TREE.length) showMenuView();
      scrollMessagesToBottom();
    });

    // 客服撤回了一条消息：如果这条消息已经在界面上显示出来了，直接移除
    socket.on('message_recalled', function (data) {
      var el = messagesEl.querySelector('[data-msg-id="' + data.messageId + '"]');
      if (el) el.parentNode.removeChild(el);
    });

    socket.on('new_message', function (m) {
      hideMenuView();
      renderMessage(m);
      hideTyping();
      if (m.sender === 'agent') {
        var isViewing = isConversationVisible();
        socket.emit(isViewing ? 'visitor_read' : 'visitor_delivered');
        playIncomingMessageSound();
        if (!isViewing) {
          unread++;
          updateUnreadIndicators();
        }
      }
    });

    var typingEl = document.getElementById('ms-typing');
    var typingHideTimer;
    function showTyping() {
      typingEl.classList.add('show');
      clearTimeout(typingHideTimer);
      typingHideTimer = setTimeout(hideTyping, 3000);
    }
    function hideTyping() {
      typingEl.classList.remove('show');
      clearTimeout(typingHideTimer);
    }
    socket.on('agent_typing', showTyping);

    var visitorTypingThrottle = 0;
    inputEl.addEventListener('input', function () {
      var now = Date.now();
      if (now - visitorTypingThrottle > 1500) {
        visitorTypingThrottle = now;
        socket.emit('visitor_typing');
      }
    });

    function send(type, content, fileName, fileSize) {
      socket.emit('visitor_message', { type: type, content: content, fileName: fileName, fileSize: fileSize });
      if (!gateShownThisSession && !stored.email) {
        insertGateCard(function (email) { socket.emit('visitor_info', { email: email }); });
      }
    }

    document.getElementById('ms-send').onclick = function () {
      var v = inputEl.value.trim();
      if (!v) return;
      send('text', v);
      inputEl.value = '';
    };
    inputEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') document.getElementById('ms-send').click();
    });

    fileEl.addEventListener('change', function () {
      var f = fileEl.files[0];
      if (!f) return;
      var fd = new FormData();
      fd.append('file', f);
      fetch(SERVER + '/api/upload', {
        method: 'POST',
        headers: {
          'X-Visitor-Id': stored.visitorId || '',
          'X-Visitor-Secret': stored.visitorSecret || ''
        },
        body: fd
      })
        .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
        .then(function (result) {
          if (!result.ok) {
            var row = document.createElement('div');
            row.className = 'ms-row';
            var bubble = document.createElement('div');
            bubble.className = 'ms-bubble';
            bubble.style.color = '#E11D48';
            bubble.textContent = result.data && result.data.error ? result.data.error : '文件发送失败';
            row.appendChild(bubble);
            messagesEl.appendChild(row);
            messagesEl.scrollTop = messagesEl.scrollHeight;
            return;
          }
          send(result.data.type, result.data.url, result.data.name, result.data.size);
        })
        .catch(function () {});
      fileEl.value = '';
    });
  };
  document.head.appendChild(scriptTag);
  } // end init
  } // end run
})();
