# 自建客服系统（个人版）

包含三部分：
- `server/`：Node.js 后端，Express + Socket.IO + SQLite，负责实时消息、文件上传、Bark 与 Web Push
- `admin/`：客服后台（网页版，支持添加到 iPhone 主屏幕当 App 用）
- `server/public/widget.js`：嵌入到你网站的悬浮聊天按钮

原生 iOS App 是无 APNs 签名版，适合使用普通 UDID 证书和 Feather 安装。

## 1. 本地跑起来

```bash
cd server
npm install
cp .env.example .env
```

**打开 `.env`，把这三项改成你自己的：**

```env
ADMIN_USERNAME=admin              # 你的登录用户名
ADMIN_PASSWORD=一个复杂点的密码     # 登录密码，别用弱密码
ADMIN_PATH=admin                  # 后台访问路径，建议改成不容易猜到的词，比如 xj9k2panel
```

```bash
npm start
```

启动后：
- 后台管理页：`http://localhost:4000/{ADMIN_PATH}/index.html`（先输入用户名密码登录）
- 嵌入脚本地址：`http://localhost:4000/widget.js`

如果改了 `ADMIN_PATH`，之后所有"访问后台"的地址都要相应替换成你自己设的那个词，下文统一用 `{ADMIN_PATH}` 表示。

## 2. 把 Widget 嵌入你的网站

在你网站的 HTML 里，`</body>` 前加一行（换成你的域名）：

```html
<script>
  window.MYSERVICE_CONFIG = {
    server: 'https://chat.yourdomain.com',
    title: '在线客服',
    color: '#6D5DFB',            // 主色/渐变起始色
    color2: '#3B82F6',           // 渐变结束色，不填则为纯色按钮
    launcherText: '点我联系客服',  // 悬浮按钮上的竖排文字，留空字符串则不显示
    welcomeMessage: '你好呀，有什么可以帮你的？'  // 访客首次打开时自动显示的欢迎语（不占用会话记录）
  };
</script>
<script src="https://chat.yourdomain.com/widget.js"></script>
```

右下角就会出现悬浮聊天按钮。移动端（屏幕宽度≤480px）会自动适配：竖排标签隐藏、聊天窗口变全屏。

## 3. 部署到 VPS

假设用 Ubuntu + Nginx + PM2：

```bash
# 安装 Node（如果没装）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 上传项目到服务器后
cd server
npm install --production
npm i -g pm2
pm2 start server.js --name myservice
pm2 save
pm2 startup   # 按提示执行输出的命令，实现开机自启
```

### Nginx 反代 + HTTPS

```nginx
server {
    listen 80;
    server_name chat.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;   # Socket.IO 需要
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

然后用 `certbot --nginx -d chat.yourdomain.com` 一键配置 HTTPS。
**注意：PWA 必须跑在 HTTPS 下才能"添加到主屏幕"体验完整。**

## 4. iPhone 上当 App 用（PWA）

1. Safari 打开 `https://chat.yourdomain.com/{ADMIN_PATH}/index.html`，先登录一次
2. 点击分享按钮 → "添加到主屏幕"
3. 桌面上会出现一个独立图标，点开是全屏App体验（无浏览器地址栏），登录状态会保持（30天免登录）

## 5. 新消息推送到手机

现在有两条推送通道，可以只用一个，也可以两个都开（互不冲突，同时触发）：

### 方式A：Bark（简单，依赖第三方App）

因为 iOS 上做原生推送比较麻烦，这里用开源的 [Bark](https://github.com/Finb/Bark) 转发：

1. iPhone 上 App Store 搜索并安装 "Bark"
2. 打开App会显示一个专属推送地址，形如：`https://api.day.app/xxxxxxxxxxxx`
3. 打开客服后台（`{ADMIN_PATH}/index.html`，登录后）→ 右上角设置(⚙) → 粘贴这个地址 → 保存
4. 安装 1.2.2 或更高版本的原生客服台后，点击 Bark 通知会通过 `servicedesk://` 直接打开原生 App，并进入对应会话。

### 方式B：Web Push（原生，不依赖第三方，点击通知能直接跳回主屏幕图标App）

Bark点开通知固定用Safari打开，跳不进你"添加到主屏幕"的那个图标。Web Push走的是标准协议，通知本身就属于你的PWA，点开会直接带你进那个已安装的图标App，还能精确定位到对应会话。

**第一步：生成密钥（一次性，在服务器上执行）**

```bash
cd server
node -e "console.log(JSON.stringify(require('web-push').generateVAPIDKeys(), null, 2))"
```

会输出 `publicKey` 和 `privateKey` 两串字符，填到 `.env` 里：

```env
VAPID_PUBLIC_KEY=生成的publicKey
VAPID_PRIVATE_KEY=生成的privateKey
```

改完 `pm2 restart myservice`。

**第二步：在手机上开启**

1. 确保已经把后台"添加到主屏幕"（iOS的硬性要求，Safari标签页里没法用）
2. 打开后台 → ⚙设置 → "浏览器/App原生推送" → 点"开启原生推送通知"
3. 系统会弹一个"允许通知"的授权，点允许

开启之后，客服离线时的新消息，会同时通过Bark（如果配置了）和Web Push两条通道推送过来，点Web Push那条通知会直接跳回你的App。

服务端会对每条客户消息发起推送，避免网页或 App 切到后台、锁屏时因为系统冻结连接而漏掉提醒；前台同时会即时刷新会话列表与未读数字。

## 6. 从Crisp导入历史会话（一次性）

如果你之前用Crisp，想把历史聊天记录搬过来：

**第一步：去Crisp后台拿3个值**
1. `Website ID`：Settings → Workspace Settings → Setup & Integrations
2. `API识别符` + `API金钥`：Settings → Workspace Settings → API令牌（Advanced configuration）→ 生成/查看REST API的Token。**这两个值只显示一次，当场复制好**，弄丢了只能重新生成一对（旧的会失效）

**第二步：填到 `.env`**
```env
CRISP_WEBSITE_ID=
CRISP_TOKEN_ID=
CRISP_TOKEN_KEY=
```

**第三步：先空跑测试，别直接正式导入**
```bash
cd server
node scripts/import-crisp.js --dry-run --limit=3
```
看输出的"第一条消息原始数据"，确认没乱码/格式看起来正常。

**第四步：正式导入**
```bash
node scripts/import-crisp.js --limit=50   # 先导50个试试水
node scripts/import-crisp.js               # 确认没问题后，去掉limit导入全部
```

脚本是幂等的（重复跑同一批数据不会重复导入），报错了直接重跑就行。导入的会话会自动打上"已导入,Crisp"标签，方便在后台用搜索功能筛选区分。详细说明看 `server/scripts/import-crisp.js` 文件顶部的注释。

**安全提醒**：这几个Token相当于你Crisp账号数据的钥匙，只写在服务器的 `.env` 里，不要贴到聊天记录/群里/代码仓库中。

## 7. 目录结构

```
customer-service/
├── server/
│   ├── server.js        # 主服务：Express + Socket.IO + API + 推送
│   ├── db.js             # SQLite 表结构
│   ├── public/widget.js  # 访客端嵌入脚本
│   └── uploads/           # 上传的图片/文件（运行后自动创建）
└── admin/
    ├── index.html / app.js / style.css   # 客服后台页面
    ├── login.html                         # 登录页
    ├── manifest.json / sw.js             # PWA 配置（manifest实际由服务端动态生成，此文件仅作参考）
    └── icons/                             # PWA 图标
```

## 8. 数据库

用的是 SQLite（`server/data.sqlite`，会自动生成），单用户场景免维护、免额外部署数据库服务。想换 PostgreSQL 也只需要改 `db.js` 里的连接部分，上层 SQL 基本通用。

## 9. 已实现的安全功能

- **登录鉴权**：登录后拿到的是一个token，存在浏览器 localStorage 里，每次请求自己带上（不依赖Cookie）。这是专门针对iOS的——"添加到主屏幕→作为Web App打开"的独立模式下，Cookie被系统清理的概率比localStorage高不少，用token方式更稳，从多任务里划掉App重新打开也不会掉登录
- **自定义后台路径**：通过 `.env` 的 `ADMIN_PATH` 改成任意不容易被猜到的路径，别人就算拿到域名也摸不到登录入口
- **访客身份保护**：浏览器保存随机 visitor secret，与 visitorId 一起验证历史会话；只知道会话 ID 或填写相同邮箱都不能读取他人的旧聊天
- **受控文件上传**：客服上传必须带登录 token，访客上传必须带 visitor secret；限制文件类型、20MB 大小和上传频率
- **访客邮箱采集**：访客发送第一条消息后会询问邮箱，邮箱会显示在后台会话列表和聊天头部；邮箱仅作为联系资料，不作为登录凭证
- 退出登录：后台右上角 ⏻ 按钮

登录 session 存在 SQLite 中并自动续期，Node 服务重启不会主动掉登录。密码保存在服务器 `.env`，不要上传到 GitHub，且应使用高强度随机密码。

## 10. 常用语 / 正在输入提示 / 会话标签备注 / 搜索

- **常用语**：聊天输入框左边的 💬 按钮，点开是你自己保存的快捷话术列表，点一下插入到输入框；列表底部"管理常用语…"可以增删
- **正在输入提示**：访客打字时你这边会看到"对方正在输入…"，反过来你打字时访客那边也会看到"客服正在输入…"
- **会话标签/备注**：聊天头部右上角 🏷 图标展开面板，可以给当前会话打标签（比如"VIP"、"已成交"）、写内部备注（仅你自己看得到），方便以后筛选
- **会话搜索**：侧边栏顶部搜索框，支持按访客邮箱、标签、备注、聊天内容关键词搜索历史会话

## 11. 单客服版已集成的高频功能

- 网页后台和原生 App：搜索、未读数字、处理中/已结束筛选、常用语、标签、备注、输入状态、已发送/送达/已读、引用、复制、撤回、图片与文件
- 客户插件：叮咚提示音、网页标题闪烁、悬浮按钮角标、深浅色、表情、附件、欢迎语、渐变颜色、竖排文字和多层聊天菜单
- 原生 App 设置：直接管理客户插件外观、欢迎语、菜单和常用语；iOS 18 以上可选系统自动翻译客户文字
- 本项目固定为个人单客服模式，不包含客服分配、排队抢单或多账号协作

## 12. 打包成原生 iPhone IPA

项目内 `ios/` 是 SwiftUI 原生工程。登录、会话列表、聊天、图片/文件上传、常用语、客户插件设置和自动翻译全部由 iOS 原生控件渲染，不使用 WebView。第一次启动只填写服务器域名，之后通过 `/api/...` 与 Node.js 服务通信。App 前台使用 SSE 实时事件流，后台和锁屏提醒使用 Bark。

- 有 Mac：用 Xcode 打开 `ios/ServiceDesk.xcodeproj`，选择自己的签名 Team 后安装或 Archive。
- Mac 上运行 `ios/build-unsigned-ipa.sh` 可生成供 Feather 重签的未签名 IPA。
- Mac 无法安装 Xcode 时，使用仓库内置 GitHub Actions；步骤见 `ios/GITHUB-BUILD.md`。
- 安装前必须把新版 `server/` 和 `admin/` 部署到 VPS；本版更新了安全依赖，需要在 `server` 目录重新执行 `npm ci --omit=dev`，再重启 PM2。
- 完整步骤见 `ios/README.md`。

注意：此版本不申请 Push Notifications entitlement，普通 UDID provisioning profile 更容易签名安装；后台通知依靠 Bark。
