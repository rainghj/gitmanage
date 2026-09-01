# gitmanage 项目长期备忘

## 项目定位
- 类似 IDEA Git Tool Window 的轻量 Git 管理器，资源占用少，**仅面向 Windows 11**。
- 技术栈：Tauri v2（Rust 后端）+ React 19 + TypeScript + pnpm；Git 操作用 git2-rs（libgit2）。
- UI 参考 IDEA 截图：顶部仓库栏 + 左文件树/更改 + 中分支+提交历史 + 右改动文件+diff。
- 视觉：VS Code 风格深色中性蓝灰调（用户通用偏好），CSS 变量集中在 src/App.css :root。

## 关键决策
- git2 用 default-features=false（关闭 ssh/https/openssl），v0.1 只做本地仓库；远程推拉计划后续用 git CLI 侧车。
- lib 名 gitmanage_lib；identifier com.guohj.gitmanage；窗口 1400x900。
- Rust 命令桥在 src-tauri/src/lib.rs，状态用 Mutex<Option<Repository>> 单仓库模型。
- serde 全 camelCase，前端 TS 接口直接同名对应。

## 环境注意事项
- bash（Git Bash）PATH 没有 cargo，跑构建前先 export PATH="/c/Users/guohj/.cargo/bin:$PATH"。
- pnpm install 提示 esbuild 构建脚本被忽略（ERR_PNPM_IGNORED_BUILDS），目前未影响 dev/build，如遇 esbuild 二进制缺失再 pnpm approve-builds。
- C 盘空间充足（~217GB），Rust/VS Build Tools 均装在 C 盘默认位置。
