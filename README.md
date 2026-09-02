# GitManage

Windows 11 上的轻量级 Git 管理器，对标 IntelliJ IDEA 的 Git 工具窗口，但内存占用只有它的几十分之一（约 35MB）。

技术栈：Tauri v2（Rust 后端）+ React 19 + TypeScript + pnpm，Git 操作基于 libgit2（`git2-rs`）。

## 运行环境

GitManage 是编译好的桌面程序，**运行期**需要：

| 组件 | 版本要求 | 说明 |
| --- | --- | --- |
| Windows | 11 | 唯一目标平台 |
| WebView2 运行时 | Win11 自带（与 Edge 共用） | 渲染前端 UI；Win10 需自行安装 Evergreen 运行时 |
| Git CLI | ≥ 2.30，且加入 PATH | **远程操作必需**：fetch / pull / push 走系统 `git` 命令侧车执行（复用 Windows 凭据管理器与 SSH agent），不走 libgit2 |

> 远程操作由应用注入 `GIT_TERMINAL_PROMPT=0`：凭据缺失会立即失败并把 git 输出展示到底部 Console，不会弹交互框把界面卡死。
> 验证：PowerShell 里能跑通 `git --version` 即可。

## 开发 / 构建环境

从源码编译运行，除运行环境外还需要：

| 组件 | 版本要求 | 用途 | 安装方式 |
| --- | --- | --- | --- |
| Rust 工具链 | stable-msvc | 编译 Rust 后端 | 官网 rustup-init.exe，或 `winget install Rustlang.Rustup` |
| VS Build Tools | 2022 / 2026，「使用 C++ 的桌面开发」工作负载 | git2-sys / libgit2 编译与链接必需（MSVC C 链接器） | 微软官网 Build Tools 安装器勾选对应工作负载 |
| Node.js | ≥ 18 | 前端构建（Vite / React） | nodejs.org，或 `winget install OpenJS.NodeJS.LTS` |
| pnpm | ≥ 9 | 依赖安装与项目脚本 | 装好 Node 后 `npm i -g pnpm` |

> git2 以 `default-features=false` 编译，**不需要**额外装 openssl / libssh2 等系统库；但 MSVC 工具链不可缺。

**本机已验证版本**：

| 组件 | 版本 | 路径 |
| --- | --- | --- |
| Rust | 1.98.0（stable-x86_64-pc-windows-msvc） | `C:\Users\guohj\.rustup` + `~\.cargo` |
| VS Build Tools | 2026 | `C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools` |
| Node.js | v22.22.2 | 系统安装 |
| pnpm | 11.22.0 | 系统安装 |

装好后在项目根目录一次性验证：

```powershell
rustc --version; cargo --version; node -v; pnpm -v; git --version
```

### 首次构建注意

- 首次 `pnpm tauri dev` 会全量编译 Rust 依赖，约 **15-30 分钟**；`src-tauri\target` 占用约 5-10GB 磁盘。之后增量编译 1-3 分钟。
- 在 **Git Bash** 里跑 `pnpm tauri dev` 前需补 PATH（bash 环境默认没有 cargo）：

  ```bash
  export PATH="/c/Users/guohj/.cargo/bin:$PATH"
  ```

- 首次 `pnpm install` 若报 `ERR_PNPM_IGNORED_BUILDS`（esbuild 构建脚本被拦），已用 `pnpm-workspace.yaml` 的 `allowBuilds` 放行，不要改回 `false`。

## 启动（手动）

在项目根目录 `C:\Users\guohj\code\gitmanage` 打开 **PowerShell**，一次一条：

```powershell
# 1) 装前端依赖（仅首次或 package.json 变动后需要）
pnpm install

# 2) 启动开发模式（会同时拉起 Vite dev server 和桌面窗口）
pnpm tauri dev
```

首次启动需要编译 Rust 依赖，**大约 15-30 分钟**（之后增量编译约 1-3 分钟）。窗口弹出即代表成功。

> 如果在 Git Bash 里跑，需要先补 PATH：
> ```bash
> export PATH="/c/Users/guohj/.cargo/bin:$PATH"
> ```

### 只跑前端（不拉起桌面窗口）

调试纯 UI 时更快：

```powershell
pnpm dev
# 然后浏览器打开 http://localhost:1420
```

> 注意：浏览器的 WebView 环境不完整，`invoke()` 调 Rust 命令会失败，只能用来调样式。

## 构建发布版

```powershell
pnpm tauri build
```

产物在 `src-tauri\target\release\bundle\`，`msi` 和 `nsis` 两种安装包都有，体积约 5-10MB（复用系统 WebView2，不打包运行时）。

## 常用命令速查

| 命令 | 作用 |
| --- | --- |
| `pnpm tauri dev` | 开发模式，改代码自动重载 |
| `pnpm dev` | 只启 Vite（前端调试） |
| `pnpm build` | `tsc` 类型检查 + 前端打包 |
| `pnpm tauri build` | 打安装包 |
| `pnpm tauri info` | 打印环境诊断信息（排查编译问题时用） |

## 功能一览

| 模块 | 能力 |
| --- | --- |
| 仓库 | 文件夹选择器打开、自动向上查找 `.git`（可选中仓库子目录） |
| 提交历史 | 分支图 lane 连线、merge 汇合曲线、ref 标签、按分支过滤、关键字搜索（hash / 作者 / message） |
| 分支 | 查看本地与远程、点击切换、新建、删除（未合并会拒绝） |
| 工作区 | 文件树（HEAD 已跟踪文件）、更改列表（A/M/D）、暂存并提交 |
| Diff | 单提交的文件改动列表 + unified diff，按文件分段 |

## 常见问题

### 窗口里出现 `ERR_CONNECTION_REFUSED` / localhost 拒绝连接

Vite dev server 已退出但 Tauri 主进程还活着，WebView 指向了死地址。**杀干净重启**即可：

```powershell
Get-Process gitmanage,node -ErrorAction SilentlyContinue | Stop-Process -Force
pnpm tauri dev
```

判断是否真的挂了：

```powershell
curl -s -o /dev/null -w "%{http_code}" http://localhost:1420
# 200 正常；连接被拒绝 = Vite 挂了
```

### `pnpm install` 报 `ERR_PNPM_IGNORED_BUILDS`

esbuild 的构建脚本被 pnpm 拦截，会让 install 退出码变成 1，连带 `pnpm build` 的前置检查一起失败。项目里已经用 `pnpm-workspace.yaml` 处理过：

```yaml
allowBuilds:
  esbuild: true
```

别把这项改成 `false`。

### 改了 Rust 却没重新编译

`tauri dev` 会监听 `src-tauri/` 并自动重编 + 重启窗口。**不要再手动跑 `cargo build` / `cargo check`**，会和 dev 进程抢文件锁，互相阻塞十几分钟。

想确认编译是否完成，看产物时间戳是否晚于源码：

```powershell
Get-Item src-tauri\src\lib.rs, src-tauri\target\debug\gitmanage.exe | Select-Object Name, LastWriteTime
```

### 打开非 Git 目录

会提示「在 XXX 及其父目录中没有找到 Git 仓库」——这是预期行为，`Repository::discover()` 会沿目录向上找 `.git`。

## 目录结构

```
gitmanage/
├─ src/                   前端（React + TS）
│  ├─ App.tsx             主界面、三栏布局、分支图计算
│  ├─ App.css             VS Code 风格深色主题
│  └─ main.tsx
├─ src-tauri/             Rust 后端
│  ├─ src/lib.rs          Git 命令桥（全部 Tauri command）
│  ├─ capabilities/       权限配置（新增插件必须在这里加）
│  ├─ tauri.conf.json     窗口与应用配置
│  └─ Cargo.toml
└─ pnpm-workspace.yaml    pnpm 构建脚本白名单
```

## 新增 Tauri 插件时要改三处

1. `pnpm add @tauri-apps/plugin-xxx`
2. `src-tauri/Cargo.toml` 加依赖 + `src-tauri/src/lib.rs` 里 `.plugin(tauri_plugin_xxx::init())`
3. **`src-tauri/capabilities/default.json` 的 permissions 加 `"xxx:default"`**（最容易漏，漏了是运行时报错而非编译报错）
