# 旧 Mac 无需 Xcode：用 GitHub 生成未签名 IPA

这个流程不上传 `.p12`、`.mobileprovision` 或密码，只在 GitHub 的 Mac 构建机上编译无签名 IPA。最后仍由 iPhone 上的 Feather 本地签名。

## 第一次上传

1. 登录 GitHub，创建一个 **Private** 私有仓库。
2. 把解压后的 `customer-service` 文件夹内容上传到仓库根目录。根目录应直接看到 `.github`、`ios`、`server` 和 `README.md`。
3. 打开仓库顶部的 **Actions**。
4. 如果出现启用工作流提示，点击 **I understand my workflows, go ahead and enable them**。

## 生成 IPA

1. 在 Actions 左侧选择 **Build unsigned iOS IPA**。
2. 点击右侧 **Run workflow**。
3. 选择 `main`，再点击绿色 **Run workflow**，等待状态变成绿色对勾。
4. 打开本次运行页面，在底部 **Artifacts** 下载 `ServiceDesk-unsigned-ipa`。
5. 下载的是 ZIP，解压后得到 `ServiceDesk-unsigned.ipa`。

## 用 Feather 安装

把 IPA 传到 iPhone 的“文件”App，在 Feather 中导入，选择你的 UDID 证书签名安装。不要注入插件、dylib 或额外 entitlement。

以后更新 App 时，重新运行同一个 workflow，并保持 Bundle ID 完全不变。证书仍在有效期内时不需要重新购买，只需要在 Feather 对新 IPA 再签一次。

如果构建失败，打开失败步骤，把完整日志截图或复制给 Codex。不要把 `.p12`、密码或兑换码上传到 GitHub。
