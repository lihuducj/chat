# 原生客服台 iOS / IPA

这是完全原生的 SwiftUI 客服客户端，不包含 `WebView`，也不会加载后台网页。所有界面和交互都由 iOS 原生控件绘制，App 只通过 HTTPS JSON API 与现有 Node.js 服务通信。

## 原生功能

- 第一次启动填写服务器域名，只需要填写 `chat.example.com`
- 原生管理员登录，token 保存在 iOS Keychain
- 原生会话列表、搜索、未读数和下拉刷新
- 处理中 / 未读 / 已结束筛选，左滑结束或重新打开会话
- 原生聊天气泡和时间戳
- 发送文字、照片、相机图片和文件
- 常用语管理、会话标签、内部备注、引用回复、消息撤回、删除会话
- 原生管理客户插件的标题、渐变颜色、竖排文字、欢迎语和多层聊天菜单
- iOS 18 以上可选系统自动翻译客户文字（原文仍保留；iOS 16/17 正常聊天但不显示该功能）
- App 前台客户新消息提示音，可在设置中关闭；会话列表实时显示未读数字
- 无 APNs entitlement，适合普通 UDID 证书和 Feather 重签安装
- App 前台由 SSE 实时刷新，后台和锁屏由 Bark 提醒
- SSE 实时消息流，断线自动重连，15 秒安全兜底
- 发送中 / 已发送 / 已送达 / 已读，以及双方正在输入提示
- 文字乐观发送、草稿自动保存、图片磁盘缓存、失败自动重试和原生缩放预览
- 访客回复已结束会话时自动重新打开

原来的网页客服后台和访客 Widget 仍然保留，可以与原生 App 同时使用。

## 必须先更新服务器

原生 App 使用 API v2 和 SSE 实时事件流。生成 IPA 前或安装后，都必须把新版 `server/` 与 `admin/` 覆盖到 VPS。本版还更新了 Multer、Express 和 Socket.IO 安全依赖，因此需要执行：

```bash
cd /srv/chat/server
npm ci --omit=dev
pm2 restart myservice --update-env
```

如果你的实际目录不同，请换成真实路径。数据库表会由 `server/db.js` 自动升级，无需手工执行 SQL。

可以在服务器上验证接口是否已更新：未登录执行下面命令应返回 `unauthorized`，而不是 `Cannot POST`：

```bash
curl -X POST https://chat.example.com/api/conversations/test/messages \
  -H 'Content-Type: application/json' \
  -d '{"type":"text","content":"test"}'
```

还可以直接检查版本：

```bash
curl https://chat.example.com/api/native/health
```

应返回包含 `"apiVersion":2` 和 `"pushMode":"bark"` 的 JSON。第一次填写域名时，App 也会自动检查这个接口。

### 宝塔 / Nginx 实时连接优化

服务端已经发送 `X-Accel-Buffering: no` 并每 25 秒保活，大多数现有反向代理无需修改。如果 App 顶部一直是橙点、只能依靠兜底刷新，在站点 Nginx 配置中给事件接口增加：

```nginx
location = /api/native/events {
    proxy_pass http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
}
```

保存后在宝塔里重载 Nginx。普通 `/` 反代和 Socket.IO WebSocket 配置继续保留。

## 操作逻辑

- 默认显示“处理中”，未读会话优先，再按最后消息时间排序。
- 会话向右滑可以“结束”，已结束会话同样操作可以重新打开。
- 永久删除放在另一侧，并且必须二次确认；正常处理完成请使用“结束”。
- 聊天页右上角 ✓ 用于结束/重新打开，资料按钮用于标签、来源页面和内部备注。
- 长按文字可以复制；长按自己发送的消息可以撤回。
- 输入的草稿按会话保存，返回列表再进入不会丢失。
- 顶部绿点表示实时连接正常；橙点表示正在重连，期间仍会通过 15 秒兜底刷新恢复数据。

## 方法一：有 Mac，直接用 Xcode

1. 用 Xcode 打开 `ios/ServiceDesk.xcodeproj`。
2. 选中 `ServiceDesk` target → Signing & Capabilities。
3. 把 Bundle Identifier `com.example.servicedesk` 改成自己的唯一值。
4. 选择 Personal Team，连接 iPhone，点击运行。
5. 如果需要 IPA，通过 Product → Archive 按证书方式导出。

## 方法二：没有 Mac，用 GitHub Actions 生成未签名 IPA

1. 把整个 `customer-service` 文件夹上传到自己的 GitHub 仓库。
2. 打开 Actions → `Build unsigned iOS IPA` → Run workflow。
3. 下载 `ServiceDesk-1.3.0-unsigned-ipa` artifact，解压得到 `ServiceDesk-unsigned.ipa`。
4. 用自己的签名工具重签并安装。

未签名 IPA 不能直接安装。免费 Apple ID 签名通常需要定期续签，具体有效期由 Apple 账号和签名工具决定。

## 第一次打开

只填写服务器域名：

```text
chat.example.com
```

也可以填写 `https://chat.example.com`。App 会自动去掉路径并使用 `/api/...` 原生接口，因此不需要填写 `ADMIN_PATH`。

服务器必须使用受信任证书的 HTTPS。

## 推送说明

此版本不包含 APNs entitlement。App 在前台时通过 SSE、App 内提示音和未读数字立即提醒，并主动抑制重复的 Bark；切到后台、锁屏或被系统清理后恢复 Bark 提醒。必须在 App 设置中保存 Bark 地址，否则后台没有系统通知。服务器发送 Bark 通知时会附带当前未读总数角标，并使用时效性通知；需要在 iPhone“设置 → 通知 → Bark”中开启锁定屏幕、横幅、声音、标记和时效性通知。

PWA Web Push 与原生 App 是两个不同身份，不能直接沿用。1.2.2 起 Bark 通知携带 `servicedesk://conversation/<会话ID>`，点击后会直接打开原生 App 并进入对应会话。当前版本号为 1.3.0（build 11）。消息正文可自动识别 `https://example.com`、`www.example.com` 等网址，点击后由 iOS 默认浏览器打开，同时保留长按选择与复制文字。
