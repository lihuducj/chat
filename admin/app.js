const SERVER = window.location.origin;
const TOKEN_KEY = 'ms_token';
let activeConvId = null;
let conversations = [];
let socket = null;

// ---------- 登录 / token 鉴权 ----------
// 用 localStorage 存 token，每次请求自己带上，不依赖 Cookie。
// iOS "添加到主屏幕"的独立Web App模式下，Cookie被系统清掉的概率比localStorage高很多，
// 所以登录状态用这种方式存会更稳。
function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}
function setToken(t) {
  localStorage.setItem(TOKEN_KEY, t);
}
function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}
function authHeaders(extra) {
  const token = getToken();
  return Object.assign({}, extra || {}, token ? { Authorization: 'Bearer ' + token } : {});
}
async function apiFetch(path, options) {
  options = options || {};
  options.credentials = 'same-origin';
  options.headers = authHeaders(options.headers);
  return fetch(SERVER + path, options);
}

async function checkAuth() {
  if (!getToken()) {
    location.replace('login.html');
    throw new Error('no token');
  }
  const res = await apiFetch('/api/me');
  if (!res.ok) {
    clearToken();
    location.replace('login.html');
    throw new Error('unauthorized');
  }
}
document.getElementById('logout-btn').onclick = async () => {
  await apiFetch('/api/logout', { method: 'POST' });
  clearToken();
  location.replace('login.html');
};

const convListEl = document.getElementById('conv-list');
const emptyState = document.getElementById('empty-state');
const chatActive = document.getElementById('chat-active');
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
document.getElementById('chat-visitor-url').onclick = function () { this.classList.toggle('expanded'); };
const connDot = document.getElementById('conn-dot');
const origTitle = document.title;
let titleFlashTimer = null;

// ---------- 声音提醒 ----------
const SOUND_MUTED_KEY = 'ms_sound_muted';
let soundMuted = localStorage.getItem(SOUND_MUTED_KEY) === '1';
const soundBtn = document.getElementById('sound-toggle-btn');
function updateSoundBtn() { soundBtn.textContent = soundMuted ? '🔇' : '🔊'; }
updateSoundBtn();
soundBtn.onclick = () => {
  soundMuted = !soundMuted;
  localStorage.setItem(SOUND_MUTED_KEY, soundMuted ? '1' : '0');
  updateSoundBtn();
};

let audioCtx = null;
function unlockAudio() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return; }
  }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
}
// 浏览器不允许没有用户交互就自动放声音，随便什么点击都先尝试"解锁"一下
document.addEventListener('click', unlockAudio);
document.addEventListener('touchstart', unlockAudio);

function playNotifySound() {
  if (soundMuted || !audioCtx) return;
  if (audioCtx.state === 'suspended') {
    // iOS上系统静音开关、专注模式切换等经常会让已经解锁过的音频又被重新挂起，
    // 先试着恢复一下，不要一遇到这种情况就直接放弃播放（这样静默失败太容易被忽略）
    audioCtx.resume().catch(() => {});
  }
  if (audioCtx.state !== 'running') return;
  try {
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, t);
    gain.gain.setValueAtTime(0.001, t);
    gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    osc.start(t);
    osc.stop(t + 0.36);
  } catch (e) {}
}

function flashTitle() {
  let on = false;
  clearInterval(titleFlashTimer);
  titleFlashTimer = setInterval(() => {
    document.title = on ? origTitle : '🔵 新消息 - ' + origTitle;
    on = !on;
  }, 900);
  window.addEventListener('focus', stopFlash, { once: true });
}
function stopFlash() { clearInterval(titleFlashTimer); document.title = origTitle; }

// ---------- 会话列表 ----------
let searchQuery = '';
let searchDebounce = null;
document.getElementById('search-input').addEventListener('input', (e) => {
  clearTimeout(searchDebounce);
  const v = e.target.value;
  searchDebounce = setTimeout(() => {
    searchQuery = v.trim();
    loadConversations();
  }, 300);
});

let loadConversationsSeq = 0; // 请求序号，防止多个几乎同时发出的请求"后发先至"，用旧数据覆盖了新数据
async function loadConversations() {
  const seq = ++loadConversationsSeq;
  const path = '/api/conversations' + (searchQuery ? '?q=' + encodeURIComponent(searchQuery) : '');
  const res = await apiFetch(path);
  if (res.status === 401) { clearToken(); location.replace('login.html'); return; }
  const data = await res.json();
  if (seq !== loadConversationsSeq) return; // 这次请求发出去之后，又有更新的请求触发了，这个结果已经过期，不能用
  conversations = data;
  renderConvList();
  if (activeConvId) {
    const activeConv = conversations.find((c) => c.id === activeConvId);
    if (activeConv) updateLastMessageReceipt(activeConv);
  }
}

function visitorLabel(c) {
  return c.visitor_email || c.visitor_name || 'chat访客';
}

const DELETE_REVEAL = 76; // 删除按钮的宽度，划开这么多距离
let openSwipeItem = null; // 当前处于"划开"状态的那一项，同时只能有一个

function closeOpenSwipe() {
  if (openSwipeItem) {
    openSwipeItem.style.transform = 'translateX(0)';
    openSwipeItem = null;
  }
}

// ---------- 主屏幕图标角标 ----------
// 用浏览器的Badging API，在"添加到主屏幕"的独立模式下，图标右上角会显示未读数字，
// 跟系统自带的邮件、信息App是同一套机制。不支持的浏览器/环境下静默跳过，不影响其他功能。
let appBadgeDebounceTimer = null;
function updateAppBadge() {
  if (!('setAppBadge' in navigator)) return;
  // 防抖：短时间内多次触发，只用最后一次的最新数据真正调一次角标API，
  // 不再用递归自我纠正那套（虽然设计上不是死循环，但iOS独立App模式本身对JS执行环境
  // 就比较脆弱，能简单绝不复杂，用最朴素的方式换稳定性）
  clearTimeout(appBadgeDebounceTimer);
  appBadgeDebounceTimer = setTimeout(() => {
    const total = conversations.reduce((sum, c) => sum + (c.unread_count || 0), 0);
    try {
      if (total > 0) navigator.setAppBadge(total).catch(() => {});
      else navigator.clearAppBadge().catch(() => {});
    } catch (e) {}
  }, 300);
}

let justUpdatedConvId = null; // 刚收到新消息的会话ID，渲染列表时用来判断要不要加高亮闪一下
let justUpdatedClearTimer = null;

function renderConvList() {
  updateAppBadge();
  convListEl.innerHTML = '';
  conversations.forEach((c) => {
    const el = document.createElement('div');
    el.className = 'conv-item' + (c.id === activeConvId ? ' active' : '') + (c.id === justUpdatedConvId ? ' flash-new' : '');
    const preview = c.last_type === 'text' ? (c.last_message || '') :
      c.last_type === 'image' ? '[图片]' : c.last_type === 'file' ? '[文件]' : '';

    const inner = document.createElement('div');
    inner.className = 'conv-item-inner';
    inner.innerHTML = `
      <div class="conv-top">
        <span class="conv-name">${escapeHtml(visitorLabel(c))}</span>
        <span class="conv-time">${fmtTime(c.last_message_at)}</span>
      </div>
      <div class="conv-preview">${escapeHtml(preview)}</div>
      ${c.unread_count > 0 ? `<span class="conv-unread">${c.unread_count}</span>` : ''}
    `;

    const delBtn = document.createElement('button');
    delBtn.className = 'conv-delete-btn';
    delBtn.textContent = '删除';
    delBtn.onclick = async (e) => {
      e.stopPropagation();
      if (!(await customConfirm(`确定要删除跟"${visitorLabel(c)}"的这段会话吗？删除后聊天记录无法恢复。`))) return;
      await apiFetch('/api/conversations/' + c.id, { method: 'DELETE' });
      conversations = conversations.filter((x) => x.id !== c.id);
      if (activeConvId === c.id) {
        activeConvId = null;
        chatActive.style.display = 'none';
        emptyState.style.display = 'flex';
      }
      openSwipeItem = null;
      renderConvList();
    };

    // 左划手势：只在移动端有意义，桌面端划不了，直接点击照常打开会话
    let touchStartX = 0, touchStartY = 0, dragDx = 0, isDragging = false, decided = false, isHorizontal = false;
    inner.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      if (openSwipeItem && openSwipeItem !== inner) closeOpenSwipe();
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      dragDx = openSwipeItem === inner ? -DELETE_REVEAL : 0;
      isDragging = true;
      decided = false;
      isHorizontal = false;
    }, { passive: true });

    inner.addEventListener('touchmove', (e) => {
      if (!isDragging) return;
      const dx = e.touches[0].clientX - touchStartX;
      const dy = e.touches[0].clientY - touchStartY;
      if (!decided) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        decided = true;
        isHorizontal = Math.abs(dx) > Math.abs(dy);
        if (!isHorizontal) { isDragging = false; return; } // 纵向滑动交给列表自己滚动，不处理
      }
      if (!isHorizontal) return;
      const base = openSwipeItem === inner ? -DELETE_REVEAL : 0;
      let next = base + dx;
      next = Math.max(-DELETE_REVEAL, Math.min(0, next));
      dragDx = next;
      inner.style.transform = `translateX(${next}px)`;
    }, { passive: true });

    inner.addEventListener('touchend', () => {
      if (!isDragging) return;
      isDragging = false;
      if (!isHorizontal) return;
      if (dragDx < -DELETE_REVEAL / 2) {
        inner.style.transform = `translateX(-${DELETE_REVEAL}px)`;
        openSwipeItem = inner;
      } else {
        inner.style.transform = 'translateX(0)';
        if (openSwipeItem === inner) openSwipeItem = null;
      }
    });

    inner.onclick = () => {
      if (openSwipeItem === inner) { closeOpenSwipe(); return; } // 划开状态下点一下先收起，不直接打开
      openConversation(c);
    };

    el.appendChild(delBtn);
    el.appendChild(inner);
    convListEl.appendChild(el);
  });
}

async function openConversation(c) {
  activeConvId = c.id;
  document.getElementById('chat-visitor-name').textContent = visitorLabel(c);
  document.getElementById('chat-visitor-url').textContent = c.last_url || '';
  document.getElementById('chat-visitor-url').title = c.last_url || '';
  document.getElementById('chat-visitor-url').classList.remove('expanded'); // 每次切换会话都收起来，别带着上一个会话的展开状态
  emptyState.style.display = 'none';
  chatActive.style.display = 'flex';
  document.body.classList.add('chat-open');
  document.getElementById('sidebar').classList.add('hidden'); // 移动端：选中会话后收起列表，露出聊天窗
  hideTyping();
  renderTags(c.tags || '');
  document.getElementById('notes-input').value = c.notes || '';
  document.getElementById('meta-panel').style.display = 'none';

  socket.emit('join_conversation', c.id);
  const res = await apiFetch('/api/conversations/' + c.id + '/messages');
  const msgs = await res.json();
  chatMessages.innerHTML = '';
  msgs.forEach(appendMessage);
  updateLastMessageReceipt(c);
  await waitForImages(chatMessages);
  scrollToBottom();
  adjustForKeyboard(); // 打开会话、批量渲染完历史消息之后，只统一校正一次，不要每条消息都触发一次(会卡)
  markRead(c.id);
  renderConvList();
}

// 图片消息刚渲染出来的时候还没加载完，高度会先按0算，等图片真的加载出来了容器才会长高，
// 不等图片加载完就滚动，最后停的位置会比真正的底部少一截（大概就是图片的高度）
function waitForImages(container) {
  const imgs = Array.from(container.querySelectorAll('img'));
  if (!imgs.length) return Promise.resolve();
  return Promise.race([
    Promise.all(imgs.map((img) => img.complete ? Promise.resolve() : new Promise((res) => {
      img.addEventListener('load', res, { once: true });
      img.addEventListener('error', res, { once: true });
    }))),
    new Promise((res) => setTimeout(res, 1500)) // 兜底超时，别让一张加载失败的图卡住整个滚动
  ]);
}

// 双重requestAnimationFrame，确保消息真正渲染、布局稳定之后再滚动，
// 不然长对话切换过去时经常会因为高度还没算完停在最上面
function scrollToBottom() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      chatMessages.scrollTop = chatMessages.scrollHeight;
    });
  });
}

// ---------- 键盘弹出时主动把输入框顶到键盘上方，并重新滚动到底部 ----------
// 之前只给客户端widget做了这个处理，后台自己回复消息的时候键盘一样会挡住刚发的消息，
// 这里补上同样的机制：不依赖iOS自己重新定位fixed元素（这个不太可靠，尤其是第一次弹键盘），
// 用visualViewport主动测量、手动调整。挪成顶层函数，方便每次插入新消息的时候也主动校正一次，
// 不完全依赖键盘事件本身触发得准不准。
const chatInputbarEl = document.getElementById('chat-inputbar');
function adjustForKeyboard() {
  if (!window.visualViewport || window.innerWidth > 720) return; // 只在移动端这种输入框position:fixed的布局下需要处理
  const vv = window.visualViewport;
  const keyboardHeight = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  if (keyboardHeight > 40) {
    chatInputbarEl.style.bottom = (keyboardHeight + 6) + 'px';
    chatMessages.style.paddingBottom = (keyboardHeight + 90) + 'px'; // 输入框被顶多高，消息区底部就要多留多少空间
  } else {
    // 显式设成0px，而不是清空成空字符串指望CSS自己重新接管——
    // 之前用空字符串偶尔会出现"清空了但没有正确回到底部"、卡在屏幕中间的情况
    chatInputbarEl.style.bottom = '0px';
    chatMessages.style.paddingBottom = '';
  }
  scrollToBottom();
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', adjustForKeyboard);
  window.visualViewport.addEventListener('scroll', adjustForKeyboard);
  chatInput.addEventListener('focus', () => {
    setTimeout(adjustForKeyboard, 50);
    setTimeout(adjustForKeyboard, 300);
  });
  chatInput.addEventListener('blur', () => {
    setTimeout(adjustForKeyboard, 50);
    setTimeout(adjustForKeyboard, 350); // 键盘收起的动画有时候比弹出慢，晚一点再校正一次保险
  });
}

function markRead(convId) {
  apiFetch('/api/conversations/' + convId + '/read', { method: 'POST' });
  const c = conversations.find((x) => x.id === convId);
  if (c) c.unread_count = 0;
  renderConvList();
}

// ---------- 标签 / 备注 ----------
let currentTags = [];
function renderTags(tagsStr) {
  currentTags = tagsStr ? tagsStr.split(',').map((t) => t.trim()).filter(Boolean) : [];
  renderTagsFromCurrent();
}
function renderTagsFromCurrent() {
  const wrap = document.getElementById('tag-chips');
  wrap.innerHTML = '';
  currentTags.forEach((t) => {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.innerHTML = `<span>${escapeHtml(t)}</span><button>✕</button>`;
    chip.querySelector('button').onclick = () => {
      currentTags = currentTags.filter((x) => x !== t);
      saveTags();
      renderTagsFromCurrent();
    };
    wrap.appendChild(chip);
  });
}
function saveTags() {
  if (!activeConvId) return;
  const tagsStr = currentTags.join(',');
  apiFetch('/api/conversations/' + activeConvId, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags: tagsStr })
  });
  const c = conversations.find((x) => x.id === activeConvId);
  if (c) c.tags = tagsStr;
}
document.getElementById('tag-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const v = e.target.value.trim();
    if (v && !currentTags.includes(v)) {
      currentTags.push(v);
      saveTags();
      renderTagsFromCurrent();
    }
    e.target.value = '';
  }
});
let notesDebounce = null;
document.getElementById('notes-input').addEventListener('input', (e) => {
  clearTimeout(notesDebounce);
  const v = e.target.value;
  notesDebounce = setTimeout(() => {
    if (!activeConvId) return;
    apiFetch('/api/conversations/' + activeConvId, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: v })
    });
  }, 500);
});
document.getElementById('meta-toggle-btn').onclick = () => {
  const panel = document.getElementById('meta-panel');
  panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
  panel.style.flexDirection = 'column';
};

// ---------- 正在输入提示 ----------
const typingEl = document.getElementById('typing-indicator');
let typingHideTimer = null;
function showTyping() {
  typingEl.classList.add('show');
  clearTimeout(typingHideTimer);
  typingHideTimer = setTimeout(hideTyping, 3000);
}
function hideTyping() {
  typingEl.classList.remove('show');
  clearTimeout(typingHideTimer);
}

let agentTypingThrottle = 0;
chatInput.addEventListener('input', () => {
  if (!activeConvId) return;
  const now = Date.now();
  if (now - agentTypingThrottle > 1500) {
    agentTypingThrottle = now;
    socket.emit('agent_typing', { conversationId: activeConvId });
  }
});

// ---------- 常用语 ----------
let cannedReplies = [];
async function loadCannedReplies() {
  const res = await apiFetch('/api/canned-replies');
  cannedReplies = res.ok ? await res.json() : [];
}
function renderCannedList() {
  const list = document.getElementById('canned-list');
  list.innerHTML = '';
  if (!cannedReplies.length) {
    list.innerHTML = '<div style="padding:12px;color:var(--muted);font-size:12px">还没有常用语，点下面"管理"添加</div>';
    return;
  }
  cannedReplies.forEach((r) => {
    const item = document.createElement('div');
    item.className = 'canned-item';
    item.innerHTML = `<div class="ci-title">${escapeHtml(r.title)}</div><div class="ci-content">${escapeHtml(r.content)}</div>`;
    item.onclick = () => {
      chatInput.value = chatInput.value ? chatInput.value + ' ' + r.content : r.content;
      autoGrowChatInput();
      document.getElementById('canned-popup').style.display = 'none';
      chatInput.focus();
    };
    list.appendChild(item);
  });
}
document.getElementById('canned-btn').onclick = async () => {
  const popup = document.getElementById('canned-popup');
  if (popup.style.display === 'block') { popup.style.display = 'none'; return; }
  await loadCannedReplies();
  renderCannedList();
  popup.style.display = 'block';
};
document.addEventListener('click', (e) => {
  const popup = document.getElementById('canned-popup');
  if (popup.style.display === 'block' && !popup.contains(e.target) && e.target.id !== 'canned-btn') {
    popup.style.display = 'none';
  }
  const emojiPopup = document.getElementById('emoji-popup');
  if (emojiPopup.style.display === 'grid' && !emojiPopup.contains(e.target) && e.target.id !== 'emoji-btn') {
    emojiPopup.style.display = 'none';
  }
  if (openSwipeItem && !openSwipeItem.contains(e.target)) closeOpenSwipe();
});

// ---------- 表情 ----------
const EMOJI_LIST = ['😀','😁','😂','🤣','😊','😍','😘','😜','🤔','🙄','😴','😅','😇','🥳','😭','😡',
  '👍','👎','👏','🙏','🤝','💪','👌','✌️','🙌','👋','🤗','😱','😢','😉','😎','🥰',
  '❤️','🧡','💛','💚','💙','💜','🖤','💯','🔥','✨','🎉','🎁','⭐','☀️','🌈','☕',
  '✅','❌','⚠️','❓','❗','💡','📌','📷','📎','🕐'];
document.getElementById('emoji-btn').onclick = (e) => {
  e.stopPropagation();
  const popup = document.getElementById('emoji-popup');
  if (popup.style.display === 'grid') { popup.style.display = 'none'; return; }
  document.getElementById('canned-popup').style.display = 'none';
  if (!popup.dataset.filled) {
    EMOJI_LIST.forEach((emo) => {
      const b = document.createElement('button');
      b.className = 'emoji-item';
      b.textContent = emo;
      b.onclick = () => {
        const start = chatInput.selectionStart != null ? chatInput.selectionStart : chatInput.value.length;
        const end = chatInput.selectionEnd != null ? chatInput.selectionEnd : chatInput.value.length;
        chatInput.value = chatInput.value.slice(0, start) + emo + chatInput.value.slice(end);
        autoGrowChatInput();
        const pos = start + emo.length;
        chatInput.focus();
        chatInput.setSelectionRange(pos, pos);
      };
      popup.appendChild(b);
    });
    popup.dataset.filled = '1';
  }
  popup.style.display = 'grid';
};

const cannedModal = document.getElementById('canned-modal');
document.getElementById('canned-manage-btn').onclick = async () => {
  document.getElementById('canned-popup').style.display = 'none';
  await loadCannedReplies();
  renderCannedManageList();
  cannedModal.style.display = 'flex';
};
document.getElementById('canned-modal-close').onclick = () => (cannedModal.style.display = 'none');

function renderCannedManageList() {
  const wrap = document.getElementById('canned-manage-list');
  wrap.innerHTML = '';
  if (!cannedReplies.length) {
    wrap.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:6px 0">暂无常用语</div>';
    return;
  }
  cannedReplies.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'canned-manage-item';
    row.innerHTML = `
      <div class="cmi-text">
        <div class="cmi-title">${escapeHtml(r.title)}</div>
        <div class="cmi-content">${escapeHtml(r.content)}</div>
      </div>
      <button data-act="del">删除</button>
    `;
    row.querySelector('[data-act="del"]').onclick = async () => {
      await apiFetch('/api/canned-replies/' + r.id, { method: 'DELETE' });
      await loadCannedReplies();
      renderCannedManageList();
    };
    wrap.appendChild(row);
  });
}
document.getElementById('canned-add-btn').onclick = async () => {
  const title = document.getElementById('canned-new-title').value.trim();
  const content = document.getElementById('canned-new-content').value.trim();
  if (!title || !content) return;
  await apiFetch('/api/canned-replies', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, content })
  });
  document.getElementById('canned-new-title').value = '';
  document.getElementById('canned-new-content').value = '';
  await loadCannedReplies();
  renderCannedManageList();
};

// ---------- 聊天菜单管理 ----------
let menuItems = [];
async function loadMenuItems() {
  const res = await apiFetch('/api/menu-items');
  menuItems = res.ok ? await res.json() : [];
}
function menuChildrenOf(parentId) {
  return menuItems.filter((m) => (m.parent_id || null) === (parentId || null));
}
function renderMenuManageList() {
  const wrap = document.getElementById('menu-manage-list');
  wrap.innerHTML = '';
  if (!menuItems.length) {
    wrap.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:6px 0">还没有菜单项，客户打开聊天窗不会看到引导菜单</div>';
  } else {
    const renderLevel = (parentId, depth) => {
      menuChildrenOf(parentId).forEach((item) => {
        const row = document.createElement('div');
        row.className = 'menu-manage-item';
        row.style.paddingLeft = (depth * 18) + 'px';
        const isMenu = !item.content;
        row.innerHTML = `
          <div class="mmi-text">
            <div class="mmi-title${isMenu ? ' is-menu' : ''}">${depth > 0 ? '└ ' : ''}${escapeHtml(item.title)}${isMenu ? '（菜单）' : ''}</div>
            ${item.content ? `<div class="mmi-content">${escapeHtml(item.content)}</div>` : ''}
          </div>
          <button data-act="edit">编辑</button>
          <button data-act="del">删除</button>
        `;
        row.querySelector('[data-act="edit"]').onclick = () => startEditMenuItem(item);
        row.querySelector('[data-act="del"]').onclick = async () => {
          if (!(await customConfirm(`确定删除"${item.title}"吗？${menuChildrenOf(item.id).length ? '它底下的子项也会一起删掉。' : ''}`))) return;
          await apiFetch('/api/menu-items/' + item.id, { method: 'DELETE' });
          if (editingMenuId === item.id) cancelEditMenuItem();
          await loadMenuItems();
          renderMenuManageList();
          fillMenuParentSelect();
        };
        wrap.appendChild(row);
        renderLevel(item.id, depth + 1);
      });
    };
    renderLevel(null, 0);
  }
}
let editingMenuId = null;
function startEditMenuItem(item) {
  editingMenuId = item.id;
  fillMenuParentSelect();
  document.getElementById('menu-new-parent').value = item.parent_id || '';
  document.getElementById('menu-new-title').value = item.title;
  document.getElementById('menu-new-content').value = item.content || '';
  document.getElementById('menu-form-title').textContent = '编辑菜单项';
  document.getElementById('menu-add-btn').textContent = '保存修改';
  document.getElementById('menu-cancel-edit-btn').style.display = 'inline-block';
}
function cancelEditMenuItem() {
  editingMenuId = null;
  document.getElementById('menu-new-parent').value = '';
  document.getElementById('menu-new-title').value = '';
  document.getElementById('menu-new-content').value = '';
  document.getElementById('menu-form-title').textContent = '新增菜单项';
  document.getElementById('menu-add-btn').textContent = '添加';
  document.getElementById('menu-cancel-edit-btn').style.display = 'none';
}
function collectMenuDescendantIds(id) {
  const ids = [];
  const walk = (pid) => {
    menuChildrenOf(pid).forEach((c) => { ids.push(c.id); walk(c.id); });
  };
  walk(id);
  return ids;
}
function fillMenuParentSelect() {
  const sel = document.getElementById('menu-new-parent');
  const cur = sel.value;
  sel.innerHTML = '<option value="">（顶层）</option>';
  const excluded = editingMenuId ? [editingMenuId, ...collectMenuDescendantIds(editingMenuId)] : [];
  // 只有还没内容的菜单项适合当"上级"（有内容的是最终答案，本来就不该再有子项）；
  // 编辑状态下再排除自己和自己的子孙，不然选了会在树形结构里形成死循环
  menuItems.filter((m) => !m.content && !excluded.includes(m.id)).forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.title;
    sel.appendChild(opt);
  });
  sel.value = cur;
}
document.getElementById('menu-manage-btn').onclick = async () => {
  cancelEditMenuItem();
  await loadMenuItems();
  renderMenuManageList();
  fillMenuParentSelect();
  document.getElementById('menu-modal').style.display = 'flex';
};
document.getElementById('menu-modal-close').onclick = () => {
  cancelEditMenuItem();
  document.getElementById('menu-modal').style.display = 'none';
};
document.getElementById('menu-cancel-edit-btn').onclick = () => cancelEditMenuItem();
document.getElementById('menu-add-btn').onclick = async () => {
  const parentId = document.getElementById('menu-new-parent').value || null;
  const title = document.getElementById('menu-new-title').value.trim();
  const content = document.getElementById('menu-new-content').value.trim();
  if (!title) return;

  if (editingMenuId) {
    const res = await apiFetch('/api/menu-items/' + editingMenuId, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentId, title, content })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || '保存失败');
      return;
    }
    cancelEditMenuItem();
  } else {
    await apiFetch('/api/menu-items', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentId, title, content })
    });
    document.getElementById('menu-new-title').value = '';
    document.getElementById('menu-new-content').value = '';
  }
  await loadMenuItems();
  renderMenuManageList();
  fillMenuParentSelect();
};

document.getElementById('back-btn').onclick = () => {
  document.getElementById('sidebar').classList.remove('hidden');
};

// ---------- 手势：聊天页从屏幕最左边往右划，返回会话列表（模仿iOS原生边缘返回手势）----------
(function () {
  const EDGE_ZONE = 24;   // 只有从这么靠边的地方开始划才算数，避免跟聊天内容的正常滑动冲突
  const SWIPE_DIST = 70;  // 要划这么远才触发返回
  let startX = null;
  let startY = null;
  let tracking = false;

  document.addEventListener('touchstart', (e) => {
    if (window.innerWidth > 720) return; // 只在移动端布局下生效，桌面宽屏不需要
    const sidebar = document.getElementById('sidebar');
    if (!sidebar.classList.contains('hidden')) return; // 已经在列表页了，不用处理
    const t = e.touches[0];
    if (t.clientX <= EDGE_ZONE) {
      startX = t.clientX;
      startY = t.clientY;
      tracking = true;
    } else {
      tracking = false;
    }
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!tracking) return;
    const t = e.touches[0];
    const dx = t.clientX - startX;
    const dy = Math.abs(t.clientY - startY);
    if (dx > SWIPE_DIST && dy < 60) {
      document.getElementById('sidebar').classList.remove('hidden');
      tracking = false;
    }
  }, { passive: true });

  document.addEventListener('touchend', () => { tracking = false; });
})();

// ---------- 消息渲染 ----------
function linkify(text) {
  const escaped = escapeHtml(text);
  const urlRegex = /((https?:\/\/|www\.)[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]+)/gi;
  return escaped.replace(urlRegex, (match) => {
    let trail = '';
    const trailMatch = match.match(/[),.!?;:'"]+$/);
    if (trailMatch) {
      trail = trailMatch[0];
      match = match.slice(0, -trail.length);
    }
    const href = /^https?:\/\//i.test(match) ? match : 'https://' + match;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${match}</a>${trail}`;
  });
}

function fmtMsgTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? hm : d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) + ' ' + hm;
}

// ---------- 已读回执（只标最后一条客服消息）----------
function updateLastMessageReceipt(conv) {
  const oldIcon = chatMessages.querySelector('.msg-receipt');
  if (oldIcon) oldIcon.remove();
  if (!conv) return;
  const lastRow = chatMessages.lastElementChild;
  if (!lastRow || !lastRow.classList.contains('agent')) return; // 最后一条不是客服发的，不显示回执
  const timeEl = lastRow.querySelector('.msg-time');
  if (!timeEl) return;
  const msgCreatedAt = Number(lastRow.dataset.createdAt || 0);
  const readAt = conv.visitor_read_at || 0;
  const deliveredAt = conv.visitor_delivered_at || 0;
  let state = 'sent';
  if (readAt && readAt >= msgCreatedAt) state = 'read';
  else if (deliveredAt && deliveredAt >= msgCreatedAt) state = 'delivered';

  const span = document.createElement('span');
  span.className = 'msg-receipt' + (state === 'read' ? ' read' : '');
  span.textContent = state === 'sent' ? '✓' : '✓✓';
  span.title = state === 'read' ? '对方已读' : state === 'delivered' ? '已送达' : '已发送';
  timeEl.appendChild(span);
}

// ---------- 图片查看弹窗 ----------
// 用应用内弹窗而不是跳转打开图片链接，避免iOS独立App模式下因为跳出manifest声明的scope范围
// 而被弹出到那种简化版浏览器视图里（这个问题之前排查过，症状是白屏/迷你浏览器框架/刷新没用）
const imageLightbox = document.getElementById('image-lightbox');
const imageLightboxImg = document.getElementById('image-lightbox-img');

// 缩放/平移状态
let zoomScale = 1, zoomX = 0, zoomY = 0;
const ZOOM_MAX = 4, ZOOM_MIN = 1;
function applyZoomTransform() {
  imageLightboxImg.style.transform = `translate(${zoomX}px, ${zoomY}px) scale(${zoomScale})`;
}
function resetZoom() {
  zoomScale = 1; zoomX = 0; zoomY = 0;
  applyZoomTransform();
}

function openImageLightbox(url) {
  imageLightboxImg.src = url;
  imageLightbox.style.display = 'flex';
  resetZoom();
}
function closeImageLightbox() {
  imageLightbox.style.display = 'none';
  imageLightboxImg.src = '';
  resetZoom();
}
document.getElementById('image-lightbox-close').onclick = closeImageLightbox;
imageLightbox.onclick = (e) => { if (e.target === imageLightbox && zoomScale === 1) closeImageLightbox(); };

// 双击放大到2.5倍/还原
imageLightboxImg.addEventListener('dblclick', (e) => {
  e.stopPropagation();
  if (zoomScale > 1) {
    resetZoom();
  } else {
    zoomScale = 2.5;
    applyZoomTransform();
  }
});

// 鼠标滚轮缩放(桌面端)
imageLightboxImg.addEventListener('wheel', (e) => {
  e.preventDefault();
  zoomScale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoomScale - e.deltaY * 0.002));
  if (zoomScale === ZOOM_MIN) { zoomX = 0; zoomY = 0; }
  applyZoomTransform();
}, { passive: false });

// 双指捏合缩放 + 单指拖动平移(放大之后)
(function () {
  let pinchStartDist = 0, pinchStartScale = 1;
  let dragStartX = 0, dragStartY = 0, dragStartZoomX = 0, dragStartZoomY = 0, dragging = false;

  function touchDist(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  imageLightboxImg.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      pinchStartDist = touchDist(e.touches);
      pinchStartScale = zoomScale;
      dragging = false;
    } else if (e.touches.length === 1 && zoomScale > 1) {
      dragging = true;
      dragStartX = e.touches[0].clientX;
      dragStartY = e.touches[0].clientY;
      dragStartZoomX = zoomX;
      dragStartZoomY = zoomY;
    }
  }, { passive: true });

  imageLightboxImg.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      const dist = touchDist(e.touches);
      zoomScale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, pinchStartScale * (dist / pinchStartDist)));
      applyZoomTransform();
    } else if (e.touches.length === 1 && dragging) {
      e.preventDefault();
      zoomX = dragStartZoomX + (e.touches[0].clientX - dragStartX);
      zoomY = dragStartZoomY + (e.touches[0].clientY - dragStartY);
      applyZoomTransform();
    }
  }, { passive: false });

  imageLightboxImg.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) pinchStartDist = 0;
    if (e.touches.length === 0) dragging = false;
    if (zoomScale <= 1) { zoomScale = 1; zoomX = 0; zoomY = 0; applyZoomTransform(); }
  });
})();

function appendMessage(m) {
  const row = document.createElement('div');
  row.className = 'msg-row' + (m.sender === 'agent' ? ' agent' : '');
  row.dataset.createdAt = m.created_at || 0;
  row.dataset.msgId = m.id || '';
  const col = document.createElement('div');
  col.className = 'msg-col';
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble' + (m.recalled ? ' recalled' : '');

  if (m.type === 'image') {
    const img = document.createElement('img');
    img.src = SERVER + m.content;
    img.onclick = () => openImageLightbox(SERVER + m.content);
    img.addEventListener('load', () => { chatMessages.scrollTop = chatMessages.scrollHeight; }, { once: true });
    bubble.appendChild(img);
  } else if (m.type === 'file') {
    const a = document.createElement('a');
    a.className = 'file-link';
    a.href = SERVER + m.content;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = '📎 ' + (m.file_name || '文件');
    bubble.appendChild(a);
  } else {
    bubble.innerHTML = linkify(m.content);
  }
  col.appendChild(bubble);

  if (m.recalled) {
    // 撤回的消息：客服自己这边内容还在(方便自己核对当时说了什么)，只是打个虚线标记，不再显示操作按钮
    const tag = document.createElement('div');
    tag.className = 'msg-recalled-tag';
    tag.textContent = '已撤回';
    col.appendChild(tag);
    const timeEl = document.createElement('div');
    timeEl.className = 'msg-time';
    timeEl.textContent = fmtMsgTime(m.created_at);
    col.appendChild(timeEl);
    row.appendChild(col);
    chatMessages.appendChild(row);
    return;
  }

  // 消息操作行：长文本(超过40字)带复制按钮；文字消息都带引用按钮；客服自己发的消息带撤回按钮
  if (m.content && (m.type === 'text' || m.sender === 'agent')) {
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    if (m.type === 'text' && m.content.length > 40) {
      const copyBtn = document.createElement('button');
      copyBtn.className = 'msg-action-btn';
      copyBtn.textContent = '复制';
      copyBtn.onclick = () => {
        navigator.clipboard.writeText(m.content).then(() => {
          copyBtn.textContent = '已复制';
          setTimeout(() => { copyBtn.textContent = '复制'; }, 1500);
        }).catch(() => {});
      };
      actions.appendChild(copyBtn);
    }
    if (m.type === 'text') {
      const quoteBtn = document.createElement('button');
      quoteBtn.className = 'msg-action-btn';
      quoteBtn.textContent = '引用';
      quoteBtn.onclick = () => setQuote(m.content);
      actions.appendChild(quoteBtn);
    }
    if (m.sender === 'agent') {
      const recallBtn = document.createElement('button');
      recallBtn.className = 'msg-action-btn';
      recallBtn.textContent = '撤回';
      recallBtn.onclick = () => recallMessage(m.id);
      actions.appendChild(recallBtn);
    }
    col.appendChild(actions);
  }

  const timeEl = document.createElement('div');
  timeEl.className = 'msg-time';
  timeEl.textContent = fmtMsgTime(m.created_at);
  col.appendChild(timeEl);
  row.appendChild(col);
  chatMessages.appendChild(row);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ---------- 引用回复 ----------
let quotedText = '';
const quoteBar = document.getElementById('quote-bar');
const quoteBarText = document.getElementById('quote-bar-text');
function setQuote(text) {
  quotedText = text;
  quoteBarText.textContent = text.length > 60 ? text.slice(0, 60) + '…' : text;
  quoteBar.classList.add('show');
  chatInput.focus();
}
function clearQuote() {
  quotedText = '';
  quoteBar.classList.remove('show');
}

// ---------- 撤回消息 ----------
async function recallMessage(messageId) {
  if (!(await customConfirm('确定要撤回这条消息吗？撤回后客户那边会立刻看不到，这个操作不能恢复。'))) return;
  socket.emit('agent_recall_message', { conversationId: activeConvId, messageId });
}
function applyRecalledUI(messageId) {
  const row = chatMessages.querySelector(`[data-msg-id="${messageId}"]`);
  if (!row) return;
  const bubble = row.querySelector('.msg-bubble');
  const actions = row.querySelector('.msg-actions');
  if (bubble) bubble.classList.add('recalled'); // 内容保留不清空，客服自己还能看到当时说了什么，只是打个虚线标记
  if (actions) actions.remove();
  if (bubble && !row.querySelector('.msg-recalled-tag')) {
    const tag = document.createElement('div');
    tag.className = 'msg-recalled-tag';
    tag.textContent = '已撤回';
    bubble.insertAdjacentElement('afterend', tag);
  }
}
document.getElementById('quote-bar-close').onclick = clearQuote;

function sendText() {
  const v = chatInput.value.trim();
  if (!v || !activeConvId) return;
  const content = quotedText ? `「${quotedText}」\n${v}` : v;
  socket.emit('agent_message', { conversationId: activeConvId, type: 'text', content });
  chatInput.value = '';
  autoGrowChatInput(); // 发完把输入框高度缩回单行，不然还保持着之前多行文字撑开的高度
  chatInput.focus(); // 发完不失焦，键盘保持打开，方便连续回复
  clearQuote();
}
const sendBtn = document.getElementById('send-btn');
sendBtn.onclick = sendText;
// 点击发送按钮这个动作本身默认会把输入框的焦点抢走(iOS上输入框一失焦键盘就收起来了)，
// 这里提前拦一下，从根源上不让焦点跑掉，比发送完再抢回来更稳
sendBtn.addEventListener('mousedown', (e) => e.preventDefault());
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); }
});
// textarea自动增高：输入多行文字的时候，输入框本身跟着变高，而不是内容在单行里挤压/需要横向滚动才能看全
function autoGrowChatInput() {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
}
chatInput.addEventListener('input', autoGrowChatInput);

document.getElementById('attach-btn').onclick = () => document.getElementById('file-input').click();
document.getElementById('file-input').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f || !activeConvId) return;
  const fd = new FormData();
  fd.append('file', f);
  try {
    const res = await fetch(SERVER + '/api/upload', { method: 'POST', headers: authHeaders(), body: fd });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || '上传失败');
      return;
    }
    socket.emit('agent_message', {
      conversationId: activeConvId, type: data.type, content: data.url,
      fileName: data.name, fileSize: data.size
    });
  } catch (err) {
    alert('上传失败，请检查网络');
  } finally {
    e.target.value = '';
  }
});

// ---------- 设置 / Bark ----------
const settingsModal = document.getElementById('settings-modal');
document.getElementById('settings-btn').onclick = async () => {
  const res = await apiFetch('/api/settings');
  const s = await res.json();
  document.getElementById('bark-url-input').value = s.bark_url || '';
  document.getElementById('widget-title-input').value = s.widget_title || '在线客服';
  document.getElementById('widget-color-input').value = s.widget_color || '#6D5DFB';
  document.getElementById('widget-color2-input').value = s.widget_color2 || '#3B82F6';
  document.getElementById('widget-launcher-input').value = s.widget_launcher_text != null ? s.widget_launcher_text : '点我联系客服';
  document.getElementById('widget-welcome-input').value = s.widget_welcome_message != null ? s.widget_welcome_message : '你好呀，有什么可以帮你的？';
  refreshWebPushBtn();
  renderPushSubList();
  renderPushLogList();
  settingsModal.style.display = 'flex';
};
document.getElementById('settings-cancel').onclick = () => (settingsModal.style.display = 'none');
document.getElementById('settings-save').onclick = async () => {
  const payload = {
    bark_url: document.getElementById('bark-url-input').value.trim(),
    widget_title: document.getElementById('widget-title-input').value.trim(),
    widget_color: document.getElementById('widget-color-input').value,
    widget_color2: document.getElementById('widget-color2-input').value,
    widget_launcher_text: document.getElementById('widget-launcher-input').value.trim(),
    widget_welcome_message: document.getElementById('widget-welcome-input').value.trim()
  };
  await apiFetch('/api/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  settingsModal.style.display = 'none';
};

// ---------- 工具函数 ----------
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 自己实现的确认弹窗，代替浏览器原生的confirm()——iOS独立App模式(添加到主屏幕)下，
// 原生confirm()/alert()有已知的卡死/弹不出来的问题，普通Safari标签页里没事，
// 换成自己用DOM/CSS做的弹窗，不依赖浏览器原生对话框，两种模式下都稳定。
function customConfirm(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'custom-confirm-overlay';
    overlay.innerHTML = `
      <div class="custom-confirm-box">
        <div class="custom-confirm-msg"></div>
        <div class="custom-confirm-actions">
          <button class="custom-confirm-cancel">取消</button>
          <button class="custom-confirm-ok">确定</button>
        </div>
      </div>
    `;
    overlay.querySelector('.custom-confirm-msg').textContent = message;
    document.body.appendChild(overlay);
    function cleanup(result) {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      resolve(result);
    }
    overlay.querySelector('.custom-confirm-cancel').onclick = () => cleanup(false);
    overlay.querySelector('.custom-confirm-ok').onclick = () => cleanup(true);
    overlay.onclick = (e) => { if (e.target === overlay) cleanup(false); };
  });
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

// ---------- PWA ----------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => {});
  // App已经开着的时候点推送通知，Service Worker会用postMessage告诉页面切到指定会话，
  // 不产生任何页面跳转（避免历史记录堆积、避免触发iOS独立App模式那个跳出scope弹简化浏览器的问题）
  navigator.serviceWorker.addEventListener('message', async (event) => {
    if (event.data && event.data.type === 'open-conversation' && event.data.conversationId) {
      await loadConversations(); // 保险起见先刷新一次，避免是条还没同步到本地列表里的新会话
      const target = conversations.find((c) => c.id === event.data.conversationId);
      if (target) {
        await openConversation(target);
        [300, 800, 1500].forEach((delay) => setTimeout(scrollToBottom, delay));
      }
    }
  });
}

// iOS独立App模式("添加到主屏幕"打开)下，100vh/100dvh在部分iOS版本会算不准，导致底部出现空白。
// 这里换一种更保险的方式：用苹果官方文档认证的 navigator.standalone 判断是否是独立模式
// （比CSS的display-mode媒体查询更可靠），然后用JS多次实测真实可视高度，
// 因为这类bug经常是"刚打开那一瞬间量的不准，过零点几秒才会自己纠正"，所以量好几次保险。
(function () {
  var isStandalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  if (!isStandalone) return; // Safari标签页模式不受这个问题影响，不用管
  document.documentElement.classList.add('ms-standalone');
  function measure() {
    var h = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
    document.documentElement.style.setProperty('--ms-app-h', h + 'px');
  }
  measure();
  window.addEventListener('resize', measure);
  window.addEventListener('pageshow', measure);
  window.addEventListener('orientationchange', () => setTimeout(measure, 200));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(measure, 100); });
  if (window.visualViewport) window.visualViewport.addEventListener('resize', measure);
  // 多测几次，兜住"刚启动时数值还没稳定"的情况
  setTimeout(measure, 100);
  setTimeout(measure, 400);
  setTimeout(measure, 1000);
})();

// ---------- Web Push 原生推送 ----------
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window;
async function renderPushSubList() {
  const wrap = document.getElementById('push-sub-list');
  wrap.textContent = '加载中…';
  try {
    const res = await apiFetch('/api/push/subscriptions');
    const subs = await res.json();
    if (!subs.length) {
      wrap.textContent = '还没有任何订阅记录';
      return;
    }
    wrap.innerHTML = subs.map((s, i) => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;${i > 0 ? 'border-top:1px solid var(--border)' : ''}">
        <span>${i === 0 ? '🟢 最新 · ' : ''}...${escapeHtml(s.endpointPreview)} · ${fmtTime(s.created_at)}</span>
        <button data-id="${s.id}" style="background:none;border:none;color:var(--danger);cursor:pointer;font-size:12px">删除</button>
      </div>
    `).join('');
    wrap.querySelectorAll('button[data-id]').forEach((btn) => {
      btn.onclick = async () => {
        await apiFetch('/api/push/subscriptions/' + btn.dataset.id, { method: 'DELETE' });
        renderPushSubList();
      };
    });
  } catch (e) {
    wrap.textContent = '加载失败';
  }
}

async function renderPushLogList() {
  const wrap = document.getElementById('push-log-list');
  wrap.textContent = '加载中…';
  try {
    const res = await apiFetch('/api/push-logs');
    const logs = await res.json();
    if (!logs.length) {
      wrap.textContent = '还没有任何推送记录';
      return;
    }
    wrap.innerHTML = logs.map((l) => `
      <div style="padding:4px 0;border-top:1px solid var(--border);display:flex;gap:6px;align-items:flex-start">
        <span style="flex-shrink:0">${l.success ? '🟢' : '🔴'}</span>
        <span style="flex:1;min-width:0">
          <span style="font-weight:600">${l.channel === 'bark' ? 'Bark' : 'Web Push'}</span>
          · ${fmtTime(l.created_at)}
          ${l.detail ? `<br><span style="word-break:break-all">${escapeHtml(l.detail)}</span>` : ''}
        </span>
      </div>
    `).join('');
  } catch (e) {
    wrap.textContent = '加载失败';
  }
}

const webPushBtn = document.getElementById('webpush-toggle-btn');

async function refreshWebPushBtn() {
  if (!pushSupported) {
    webPushBtn.textContent = '当前浏览器不支持';
    webPushBtn.disabled = true;
    return;
  }
  webPushBtn.disabled = false;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    webPushBtn.textContent = sub ? '✅ 已开启，点击关闭' : '🔔 开启原生推送通知';
  } catch (e) {
    webPushBtn.textContent = '🔔 开启原生推送通知';
  }
}

webPushBtn.onclick = async () => {
  if (!pushSupported) return;
  webPushBtn.disabled = true;
  try {
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();

    if (existing) {
      await apiFetch('/api/push/unsubscribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: existing.endpoint })
      });
      await existing.unsubscribe();
      webPushBtn.textContent = '🔔 开启原生推送通知';
      renderPushSubList();
      return;
    }

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      webPushBtn.textContent = '未获得通知权限，去系统设置里开启';
      return;
    }
    const keyRes = await apiFetch('/api/push/vapid-public-key');
    const { publicKey } = await keyRes.json();
    if (!publicKey) {
      webPushBtn.textContent = '服务器未配置推送密钥';
      return;
    }
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey)
    });
    await apiFetch('/api/push/subscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sub.toJSON())
    });
    webPushBtn.textContent = '✅ 已开启，点击关闭';
    renderPushSubList();
  } catch (e) {
    webPushBtn.textContent = '开启失败，请重试';
  } finally {
    webPushBtn.disabled = false;
  }
};

// ---------- 启动：先确认登录，再建立Socket连接（Socket握手也带上token）----------
function startSocket() {
  socket = io(SERVER, { query: { role: 'agent', token: getToken() } });

  socket.on('connect', async () => {
    connDot.classList.add('online');
    // 断线重连后，服务器不会记得之前加入过哪个会话房间，这里手动补一次，
    // 不然重连后正开着的会话收不到新消息推送，得手动切换会话才能刷新出来
    if (activeConvId) socket.emit('join_conversation', activeConvId);
    await loadConversations();
    // 之前只刷新了列表，没刷新"正开着的这个会话"本身的消息内容——
    // 从后台切回来、期间客户回复了消息的话，这里必须重新拉一次完整消息，
    // 不然聊天窗里显示的还是切到后台之前的旧状态，得等再发一条消息才会刷新，体验上就是"卡住了"
    if (activeConvId) {
      const activeConv = conversations.find((c) => c.id === activeConvId);
      if (activeConv) openConversation(activeConv);
    }
  });
  socket.on('disconnect', () => connDot.classList.remove('online'));
  socket.on('connect_error', (err) => {
    if (err && err.message === 'unauthorized') {
      clearToken();
      location.replace('login.html');
    }
  });

  socket.on('new_message', (m) => {
    if (m.conversation_id === activeConvId) {
      appendMessage(m);
      adjustForKeyboard(); // 这里只是单条实时消息，不是批量渲染，调一次没有性能问题
      markRead(activeConvId);
    } else if (m.sender === 'visitor') {
      flashTitle();
      justUpdatedConvId = m.conversation_id; // 标记这个会话刚收到新消息，列表重新渲染的时候给它加个高亮闪一下
      clearTimeout(justUpdatedClearTimer);
      justUpdatedClearTimer = setTimeout(() => { justUpdatedConvId = null; }, 1500); // 延迟清除，别被几乎同时到达的conversation_updated触发的另一次渲染抢先覆盖掉
    }
    if (m.sender === 'visitor') playNotifySound();
    loadConversations();
  });

  socket.on('conversation_updated', () => loadConversations());

  socket.on('conversation_deleted', ({ conversationId }) => {
    conversations = conversations.filter((x) => x.id !== conversationId);
    if (activeConvId === conversationId) {
      activeConvId = null;
      chatActive.style.display = 'none';
      emptyState.style.display = 'flex';
    }
    if (openSwipeItem) openSwipeItem = null;
    renderConvList();
  });

  socket.on('message_recalled', ({ conversationId, messageId }) => {
    if (conversationId === activeConvId) applyRecalledUI(messageId);
  });

  socket.on('visitor_typing', (payload) => {
    const { conversationId } = payload || {};
    if (conversationId === activeConvId) showTyping();
  });

  // 判断"现在真的有人在看"：不能只看document.hidden，那个只能识别"标签页被切走/窗口最小化"，
  // 识别不了"这个标签页本身还是激活状态、浏览器窗口也没最小化，但人已经切到别的软件去用了"这种情况
  // （比如电脑上开着后台网页，但焦点在别的软件上）——这种情况下document.hidden还是false，
  // 加上window.hasFocus()这层判断才能识别出来。
  function isPageTrulyVisible() {
    return !document.hidden && document.hasFocus();
  }

  // App被切到后台/锁屏、或者窗口失去焦点时立刻上报，服务器好判断"现在真的没人在看，该推送了"，
  // 不用傻等Socket连接超时断开才反应过来
  function reportVisibility() {
    if (!socket || !socket.connected) return;
    socket.emit(isPageTrulyVisible() ? 'agent_active' : 'agent_away');
  }
  document.addEventListener('visibilitychange', reportVisibility);
  window.addEventListener('blur', reportVisibility);
  window.addEventListener('focus', reportVisibility);

  // App从后台切回前台时，主动刷新一次数据，不完全依赖Socket重连事件触发得够不够及时——
  // iOS切到后台时长时间挂起JS执行，恢复执行的时候Socket底层连接可能已经断了，
  // 但socket.io自己意识到"连接死了、需要重连"这个过程有时候会有延迟，
  // 这里直接绑定系统级的"回到前台"信号，不管Socket重连快不快，都主动去拉一次最新数据
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden) return;
    await loadConversations();
    if (activeConvId) {
      const activeConv = conversations.find((c) => c.id === activeConvId);
      if (activeConv) openConversation(activeConv);
    }
  });

  // 定期心跳：iOS上PWA场景下visibilitychange有时候不够可靠(切到后台没能正确上报away)，
  // 加一个心跳兜底——页面真的在后台的话，这个定时器自然也不会准时执行(iOS会暂停后台JS执行)，
  // 服务器那边超过一段时间收不到心跳，就会自己判断"这个客服已经不在看了"，不会一直误判成"还在线"导致漏推送
  setInterval(() => {
    if (isPageTrulyVisible() && socket && socket.connected) socket.emit('agent_heartbeat');
  }, 45000);
}

checkAuth().then(async () => {
  startSocket();
  await loadConversations();
  setInterval(() => loadConversations(), 15000); // 兜底轮询

  const params = new URLSearchParams(location.search);
  const convId = params.get('conv');
  if (convId) {
    const target = conversations.find((c) => c.id === convId);
    if (target) {
      await openConversation(target);
      // 从推送通知冷启动进来的场景，页面布局比"App已经在跑、点一下列表进入"更不稳定
      // （安全区计算、视口尺寸这些可能还没完全稳定下来），多补几次延迟校正，
      // 避免刚打开时消息停在半截、看不到最后（包括自己之前发的）消息
      [300, 800, 1500].forEach((delay) => setTimeout(scrollToBottom, delay));
    }
    history.replaceState({}, '', location.pathname); // 打开后清掉url参数，避免刷新重复跳转
  }
});
