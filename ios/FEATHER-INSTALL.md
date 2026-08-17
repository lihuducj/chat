# Feather 安装无 APNs 版客服台

## 还需要什么

你已经安装 Feather 后，还需要：

1. 有效的 `.p12` 证书及其密码。
2. 包含当前 iPhone UDID 的 `.mobileprovision`。
3. `ServiceDesk-no-apns-unsigned.ipa`。
4. 客服服务器域名、后台账号和密码。

不需要 APNs `.p8`、Team ID、Key ID，也不需要 Push Notifications entitlement。

## 在 Mac 生成未签名 IPA

安装完整 Xcode，第一次打开 Xcode 时让它安装 iOS 组件。终端进入项目目录后执行：

```bash
cd ios
chmod +x build-unsigned-ipa.sh
./build-unsigned-ipa.sh
```

生成文件：

```text
ios/output/ServiceDesk-no-apns-unsigned.ipa
```

如果 Mac 太旧无法安装 Xcode，不需要降级 App，也不要从不明网站下载修改版 Xcode。改用 `.github/workflows/build-unsigned-ios.yml` 云端构建，详细步骤见 `ios/GITHUB-BUILD.md`。

如果证书商要求固定 Bundle ID，用下面方式构建，值换成对方允许的 Bundle ID：

```bash
BUNDLE_ID=com.yourname.servicedesk ./build-unsigned-ipa.sh
```

同一台手机以后覆盖更新时必须继续使用相同 Bundle ID。不要删除旧 App，否则本地保存的域名、登录 token 和草稿会一起删除。

## 在 Feather 签名

1. 打开 Feather，确认“证书”页面能看到证书及到期时间；如果没有，导入 `.p12`、密码和 `.mobileprovision`。
2. 把 `ServiceDesk-no-apns-unsigned.ipa` 通过隔空投送、iCloud Drive 或微信文件传到 iPhone 的“文件”App。
3. 在 Feather 中导入 IPA，选择你的 UDID 证书。
4. 不注入 dylib、插件或 tweak，不开启额外 entitlement。
5. Bundle ID 保持与首次安装完全一致，然后签名并安装。
6. 首次打开填写 HTTPS 客服域名并登录。

若提示 `ApplicationVerificationFailed`、`0xe8008015`、完整性无法验证或设备未包含，通常是 mobileprovision 没有当前 UDID、Bundle ID 不允许、证书已撤销或描述文件已过期。可以只把 `.mobileprovision` 放进项目目录让 Codex 检查；不要上传 `.p12` 和密码。

## 后台通知

此构建没有 APNs。App 前台由 SSE 实时刷新；后台、锁屏或 App 被系统清理后必须依靠 Bark。登录后进入“设置 → Bark 推送”，填写自己的 Bark 地址并保存。
