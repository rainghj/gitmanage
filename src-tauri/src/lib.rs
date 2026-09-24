//! gitmanage - 轻量 Git 管理器（Tauri 后端）
//!
//! 命令桥设计：
//! - open_repo        打开本地仓库，返回概要
//! - list_branches    本地 + 远程分支列表
//! - get_log          提交历史（带分支/标签引用）
//! - get_commit_files 单提交的改动文件列表
//! - get_diff         单提交的 unified diff 文本
//! - get_head_tree    HEAD 提交的已跟踪文件列表（文件树数据源）
//! - get_status       工作区状态（未暂存/已暂存/未跟踪）
//!
//! git2 使用 default-features=false（无 ssh/https/openssl），只做本地操作。

use git2::{
    opts, BranchType, Config, ConfigLevel, DiffFormat, ErrorCode, ObjectType, Oid, Repository,
    RepositoryState, Sort, TreeWalkResult,
};
use serde::{Deserialize, Serialize};
use tauri::Manager; // AppHandle::path() 来自这个 trait
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;

struct AppState {
    repo: Mutex<Option<Repository>>,
}

// ---------- 最近打开的仓库 ----------

const RECENT_LIMIT: usize = 10;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RecentEntry {
    path: String,
    name: String,
    last_opened: i64, // unix 秒
    /// 路径仍存在于磁盘（frontend 会据此灰显）。`#[serde(default)]` 保证旧版 recent.json
    /// （没有此字段）也能正常解析，不会把历史记录一次性清空。
    #[serde(default)]
    exists: bool,
}

/// 存到 AppData 下的配置目录（Windows: %APPDATA%\com.guohj.gitmanage\）
fn recent_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法解析 app 配置目录: {e}"))?;
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    Ok(dir.join("recent.json"))
}

fn read_recent(app: &tauri::AppHandle) -> Vec<RecentEntry> {
    let Ok(path) = recent_file_path(app) else { return vec![] };
    let Ok(bytes) = std::fs::read(&path) else { return vec![] };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

fn write_recent(app: &tauri::AppHandle, list: &[RecentEntry]) -> Result<(), String> {
    let path = recent_file_path(app)?;
    let bytes = serde_json::to_vec_pretty(list).map_err(to_err)?;
    std::fs::write(&path, bytes).map_err(to_err)?;
    Ok(())
}

// ---------- 数据结构（serde camelCase，前端 TS 直接对应） ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RepoSummary {
    path: String,
    name: String,
    current_branch: Option<String>,
    is_empty: bool,
    head_commit: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BranchInfo {
    name: String,
    is_head: bool,
    is_remote: bool,
    upstream: Option<String>,
    commit: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CommitInfo {
    oid: String,
    short: String,
    summary: String,
    author: String,
    email: String,
    time: i64,
    parents: Vec<String>,
    refs: Vec<String>,
    /// 该提交能否从本地 HEAD 走到。false = 只存在于上游/远程一侧，即「还没拉下来的提交」。
    /// 前端据此把它标成「待拉取」并降一档亮度。
    reachable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileChange {
    path: String,
    status: String,
    old_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusItem {
    path: String,
    status: String,
}

fn to_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// 从 state 取仓库，处理锁 + None 两种情况，减少每个命令的样板代码。
/// 一律用 as_mut() 拿到 &mut Repository——很多 git2 API（stash_*、checkout_tree 等）
/// 需要可变借用，不可变 API 也接受可变借用（自动 reborrow），统一可变更省心。
macro_rules! with_repo {
    ($state:expr, $repo:ident, $body:block) => {{
        let mut guard = $state.repo.lock().map_err(to_err)?;
        let $repo = guard.as_mut().ok_or("尚未打开仓库")?;
        $body
    }};
}

// ---------- Tauri 命令 ----------

/// 先 discover（沿目录向上逐级找 .git），失败再退回严格 open；两次的错误都带回来用于诊断
fn try_open_repo(path: &str) -> Result<Repository, (git2::Error, git2::Error)> {
    match Repository::discover(path) {
        Ok(r) => Ok(r),
        Err(e1) => Repository::open(path).map_err(|e2| (e1, e2)),
    }
}

#[tauri::command]
fn open_repo(state: tauri::State<AppState>, path: String) -> Result<RepoSummary, String> {
    // 参数名必须保持 path：前端 invoke 传的 key 就是 { path }。raw 只留作诊断用的原始入参
    let raw = path.clone();
    // 从资源管理器「复制文件地址」粘贴进来时可能带一对英文引号，先剥掉；
    // \\?\ 长路径前缀 libgit2 也能吃，但统一去掉更稳妥
    let path = path.trim().trim_matches('"').trim().to_string();
    let path = path.strip_prefix(r"\\?\").unwrap_or(&path).to_string();

    if !std::path::Path::new(&path).exists() {
        return Err(format!("路径不存在：{path}"));
    }

    let repo = match try_open_repo(&path) {
        Ok(r) => r,
        Err((e1, e2)) => {
            // 真实原因一定要带出去：libgit2 的报错（权限/所有权/找不到 .git 等）各不相同，
            // 只回一句「没找到 Git 仓库」根本没法排查
            let detail = format!("discover: {}；open: {}", e1.message(), e2.message());
            // 同时打到后台终端，跑 pnpm tauri dev 时不用再开前端控制台
            eprintln!("[open_repo] 打开失败 path={path} raw={raw} -> {detail}");

            // 目录归属与当前用户不一致时 libgit2 会直接拒绝打开（Owner 类错误，等价 git 的
            // "dubious ownership"）。本地工具没必要拦这一层，关掉校验重试一次。
            let retried = if e1.code() == ErrorCode::Owner || e2.code() == ErrorCode::Owner {
                unsafe { let _ = opts::set_verify_owner_validation(false); }
                let r = try_open_repo(&path).ok();
                unsafe { let _ = opts::set_verify_owner_validation(true); }
                r
            } else {
                None
            };

            match retried {
                Some(r) => {
                    eprintln!("[open_repo] 关闭所有权校验后成功打开：{path}");
                    r
                }
                None => {
                    return Err(format!("在 {path} 及其父目录中没有找到 Git 仓库（{detail}）"));
                }
            }
        }
    };

    // 真实仓库根（去掉结尾分隔符），裸库回退到 .git 的父目录
    let root = repo
        .workdir()
        .or_else(|| repo.path().parent())
        .map(|p| {
            p.to_string_lossy()
                .trim_end_matches(['\\', '/'])
                .to_string()
        })
        .unwrap_or_else(|| path.clone());
    let name = std::path::Path::new(&root)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| root.clone());
    let is_empty = repo.is_empty().map_err(to_err)?;

    // head 引用借用 repo，先在块内提取 owned 值并随块结束 drop，之后才能 move repo 进 state
    let (current_branch, head_commit) = {
        let head = repo.head().ok();
        let current_branch = head
            .as_ref()
            .filter(|h| h.is_branch())
            .and_then(|h| h.shorthand().map(|s| s.to_string()));
        let head_commit = head
            .as_ref()
            .and_then(|h| h.target().map(|o| o.to_string()));
        (current_branch, head_commit)
    };

    *state.repo.lock().map_err(to_err)? = Some(repo);
    Ok(RepoSummary {
        path: root,
        name,
        current_branch,
        is_empty,
        head_commit,
    })
}

/// 关闭当前仓库：把 state 里的 Repository 置 None 以释放 git2 句柄。
/// 必须走这个命令而不是只在前端把 repo 状态清空——否则 Rust 侧仍持有 .git 的文件锁，
/// Windows 上表现为：其他 git 命令 / 资源管理器删除该目录会被拒绝访问。
#[tauri::command]
fn close_repo(state: tauri::State<AppState>) -> Result<(), String> {
    *state.repo.lock().map_err(to_err)? = None;
    Ok(())
}

#[tauri::command]
fn list_branches(state: tauri::State<AppState>) -> Result<Vec<BranchInfo>, String> {
    with_repo!(state, repo, {
        let mut out = Vec::new();
        for item in repo.branches(None).map_err(to_err)? {
            let (branch, btype) = item.map_err(to_err)?;
            let name = branch
                .name()
                .map_err(to_err)?
                .unwrap_or("?")
                .to_string();
            let commit = branch
                .get()
                .target()
                .map(|o| o.to_string())
                .unwrap_or_default();
            let upstream = if btype == BranchType::Local {
                branch
                    .upstream()
                    .ok()
                    .and_then(|u| u.name().ok().flatten().map(|s| s.to_string()))
            } else {
                None
            };
            out.push(BranchInfo {
                name,
                is_head: branch.is_head(),
                is_remote: btype == BranchType::Remote,
                upstream,
                commit,
            });
        }
        Ok(out)
    })
}

#[tauri::command]
fn get_log(
    state: tauri::State<AppState>,
    limit: usize,
    branch: Option<String>,
    query: Option<String>,
) -> Result<Vec<CommitInfo>, String> {
    with_repo!(state, repo, {
        // 先建 ref 映射：oid -> [分支名/远程分支名]，用于在 log 行上打标签
        let mut refmap: HashMap<String, Vec<String>> = HashMap::new();
        for item in repo.branches(None).map_err(to_err)? {
            let (branch, _btype) = item.map_err(to_err)?;
            if let (Some(oid), Ok(Some(name))) = (
                branch.get().target(),
                branch.name().map(|n| n.map(|s| s.to_string())),
            ) {
                refmap.entry(oid.to_string()).or_default().push(name);
            }
        }

        // 当前分支的上游 ref（未绑定 → None）。只有「全部（HEAD）」视图会把它的历史并进来。
        // 不并的话，fetch 下来、本地还没有的提交在列表里压根不存在——徽标数字变了，却看不到到底要拉什么。
        let upstream_oid = repo
            .head()
            .ok()
            .and_then(|h| h.shorthand().map(|s| s.to_string()))
            .and_then(|name| repo.find_branch(&name, BranchType::Local).ok())
            .and_then(|b| b.upstream().ok().and_then(|u| u.get().target()));

        // HEAD 可达集合：用来标出「本地 HEAD 还没有」的提交。
        // 单独走一次 revwalk 收集，而不是对每行调 graph_descendant_of——那是每行一次图遍历。
        // 上限 = 输出遍历窗口（max_scan）的 10 倍：能出现在结果里的行最远只在两头顶端 1 万步内，
        // 可达的最老祖先必然在 HEAD 的 1 万步内，所以 10 万的上限对本视图是完备的。
        const HEAD_REACH_CAP: usize = 100_000;
        let mut head_reach: HashSet<Oid> = HashSet::new();
        let mut head_ok = false;
        if let Ok(mut rw) = repo.revwalk() {
            if rw.push_head().is_ok() {
                head_ok = true;
                for oid in rw.flatten().take(HEAD_REACH_CAP) {
                    head_reach.insert(oid);
                }
            }
        }

        let mut revwalk = repo.revwalk().map_err(to_err)?;
        // 分支过滤：None / "HEAD" / "" 视为当前 HEAD；其余按 ref 名解析
        match branch.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            None | Some("HEAD") => {
                revwalk.push_head().map_err(to_err)?;
                // 并上游：上游就是 HEAD（已同步）时重复 push 同一个 oid 无害
                if let Some(u) = upstream_oid {
                    revwalk.push(u).map_err(to_err)?;
                }
            }
            Some(name) => {
                let obj = repo.revparse_single(name).map_err(to_err)?;
                revwalk.push(obj.id()).map_err(to_err)?;
            }
        }
        revwalk
            .set_sorting(Sort::TIME | Sort::TOPOLOGICAL)
            .map_err(to_err)?;

        // 关键字过滤（小写匹配 oid / author / summary），过滤发生在 take(limit) 之前
        // —— 这样返回的 limit 条都是匹配的；非匹配的可能需要遍历更多（最多 10k 条兜底）
        let q_lower = query
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_lowercase());

        let mut out = Vec::new();
        let max_scan = 10_000usize; // 防止不匹配的 query 遍历整库
        for oid_res in revwalk.take(max_scan) {
            if out.len() >= limit {
                break;
            }
            let oid = oid_res.map_err(to_err)?;
            let commit = repo.find_commit(oid).map_err(to_err)?;
            let summary = commit.summary().unwrap_or("").to_string();
            let author = commit.author().name().unwrap_or("").to_string();

            if let Some(q) = &q_lower {
                let oid_str = oid.to_string();
                let hay = format!("{} {} {}", oid_str, author, summary).to_lowercase();
                if !hay.contains(q) {
                    continue;
                }
            }

            out.push(CommitInfo {
                oid: oid.to_string(),
                short: oid.to_string().chars().take(7).collect(),
                summary,
                author,
                email: commit.author().email().unwrap_or("").to_string(),
                time: commit.time().seconds(),
                parents: commit.parent_ids().map(|o| o.to_string()).collect(),
                refs: refmap.remove(&oid.to_string()).unwrap_or_default(),
                // head_ok=false 表示连 HEAD 都解析不出来（空仓库等异常路径），
                // 此时一律视为可达，免得整屏被误标成「待拉取」
                reachable: !head_ok || head_reach.contains(&oid),
            });
        }
        Ok(out)
    })
}

/// 取提交与其第一父提交的 tree diff；根提交与空树 diff
fn commit_diff<'r>(repo: &'r Repository, oid: &str) -> Result<git2::Diff<'r>, String> {
    let oid = Oid::from_str(oid).map_err(to_err)?;
    let commit = repo.find_commit(oid).map_err(to_err)?;
    let new_tree = commit.tree().map_err(to_err)?;
    let old_tree = if commit.parent_count() > 0 {
        Some(commit.parent(0).map_err(to_err)?.tree().map_err(to_err)?)
    } else {
        None
    };
    repo.diff_tree_to_tree(old_tree.as_ref(), Some(&new_tree), None)
        .map_err(to_err)
}

#[tauri::command]
fn get_commit_files(state: tauri::State<AppState>, oid: String) -> Result<Vec<FileChange>, String> {
    with_repo!(state, repo, {
        let diff = commit_diff(repo, &oid)?;
        let mut out = Vec::new();
        for delta in diff.deltas() {
            let status = match delta.status() {
                git2::Delta::Added => "added",
                git2::Delta::Deleted => "deleted",
                git2::Delta::Modified => "modified",
                git2::Delta::Renamed => "renamed",
                git2::Delta::Copied => "copied",
                git2::Delta::Typechange => "typechange",
                _ => "other",
            }
            .to_string();
            out.push(FileChange {
                path: delta
                    .new_file()
                    .path()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default(),
                status,
                old_path: delta
                    .old_file()
                    .path()
                    .map(|p| p.to_string_lossy().to_string()),
            });
        }
        Ok(out)
    })
}

/// 把 git2 Diff 打印成统一文本：文件头转成 === path === 分隔行，增删行带 +/- 前缀，
/// 前端 DiffView 按前缀上色。get_diff / get_workdir_diff 共用。
fn patch_to_string(diff: git2::Diff) -> Result<String, String> {
    let mut buf = String::new();
    diff.print(DiffFormat::Patch, |delta, _hunk, line| {
        match line.origin() {
            // 增删/上下文行：带前缀输出
            '+' | '-' | ' ' => {
                buf.push(line.origin());
                buf.push_str(std::str::from_utf8(line.content()).unwrap_or(""));
            }
            // 文件头：转成我们自己的分隔行，前端好按文件分段渲染
            'F' => {
                if let Some(path) = delta.new_file().path().map(|p| p.to_string_lossy()) {
                    buf.push_str(&format!("\n=== {path} ===\n"));
                }
            }
            // 其余（hunk 头 @@、index 行等）原样输出
            _ => buf.push_str(std::str::from_utf8(line.content()).unwrap_or("")),
        }
        true
    })
    .map_err(to_err)?;
    Ok(buf)
}

#[tauri::command]
fn get_diff(state: tauri::State<AppState>, oid: String) -> Result<String, String> {
    with_repo!(state, repo, {
        let diff = commit_diff(repo, &oid)?;
        patch_to_string(diff)
    })
}

/// 读取工作区文件内容（左栏文件树点击预览用）。
/// 防御：拒绝含 .. 的路径逃逸；超过 512KB 截断；含 NUL 视为二进制拒绝预览。
#[tauri::command]
fn read_file_content(state: tauri::State<AppState>, path: String) -> Result<String, String> {
    with_repo!(state, repo, {
        let rel = std::path::Path::new(&path);
        if rel
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err("非法路径".to_string());
        }
        let workdir = repo.workdir().ok_or("裸仓库不支持此操作")?;
        let full = workdir.join(rel);
        if !full.starts_with(workdir) {
            return Err("非法路径".to_string());
        }
        let bytes = std::fs::read(&full).map_err(|e| format!("读取失败: {e}"))?;
        const LIMIT: usize = 512 * 1024;
        let (slice, truncated) = if bytes.len() > LIMIT {
            (&bytes[..LIMIT], true)
        } else {
            (&bytes[..], false)
        };
        if slice.contains(&0) {
            return Err("二进制文件不支持预览".to_string());
        }
        let mut text = String::from_utf8_lossy(slice).to_string();
        if truncated {
            text.push_str("\n\n…（文件过大，仅显示前 512KB）");
        }
        Ok(text)
    })
}

/// 写回工作区文件内容（文件预览标签页的编辑保存用）。路径安全规则同 read_file_content。
#[tauri::command]
fn write_file_content(state: tauri::State<AppState>, path: String, content: String) -> Result<(), String> {
    with_repo!(state, repo, {
        let rel = std::path::Path::new(&path);
        if rel
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err("非法路径".to_string());
        }
        let workdir = repo.workdir().ok_or("裸仓库不支持此操作")?;
        let full = workdir.join(rel);
        if !full.starts_with(workdir) {
            return Err("非法路径".to_string());
        }
        std::fs::write(&full, content.as_bytes()).map_err(|e| format!("写入失败: {e}"))
    })
}

/// 单文件的工作区 diff（HEAD+index → workdir），点「更改」列表里的文件看对比用。
/// include_untracked 让新文件整体以 "+" 行呈现；文件无改动时返回空串，前端显示提示。
#[tauri::command]
fn get_workdir_diff(state: tauri::State<AppState>, path: String) -> Result<String, String> {
    with_repo!(state, repo, {
        let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
        let mut opts = git2::DiffOptions::new();
        opts.pathspec(&path)
            .context_lines(3)
            .include_untracked(true)
            .recurse_untracked_dirs(true);
        let diff = repo
            .diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut opts))
            .map_err(to_err)?;
        patch_to_string(diff)
    })
}

#[tauri::command]
fn get_head_tree(state: tauri::State<AppState>) -> Result<Vec<String>, String> {
    with_repo!(state, repo, {
        let commit = repo.head().map_err(to_err)?.peel_to_commit().map_err(to_err)?;
        let tree = commit.tree().map_err(to_err)?;
        let mut paths = Vec::new();
        tree.walk(git2::TreeWalkMode::PreOrder, |root, entry| {
            if entry.kind() == Some(ObjectType::Blob) {
                paths.push(format!("{}{}", root, entry.name().unwrap_or("")));
            }
            TreeWalkResult::Ok
        })
        .map_err(to_err)?;
        paths.sort();
        Ok(paths)
    })
}

#[tauri::command]
fn get_status(state: tauri::State<AppState>) -> Result<Vec<StatusItem>, String> {
    with_repo!(state, repo, {
        let mut opts = git2::StatusOptions::new();
        opts.include_untracked(true)
            .recurse_untracked_dirs(true);
        let statuses = repo.statuses(Some(&mut opts)).map_err(to_err)?;
        let mut out = Vec::new();
        for entry in statuses.iter() {
            let s = entry.status();
            // 冲突文件不进「更改/不提交」列表——解决入口在左栏「冲突」页，
            // 否则会混进勾选提交的清单里（冲突未解决前 git 不允许正常暂存提交）
            if s.is_conflicted() {
                continue;
            }
            let path = entry.path().unwrap_or("?").to_string();
            let status = if s.is_wt_new() || s.is_index_new() {
                "added"
            } else if s.is_wt_modified() || s.is_index_modified() {
                "modified"
            } else if s.is_wt_deleted() || s.is_index_deleted() {
                "deleted"
            } else if s.is_wt_renamed() || s.is_index_renamed() {
                "renamed"
            } else {
                "other"
            }
            .to_string();
            out.push(StatusItem { path, status });
        }
        Ok(out)
    })
}

// ---------- 合并冲突（pull/merge 进入 MERGE 状态后，左栏「冲突」页数据源） ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConflictFile {
    path: String,
    /// 冲突三侧是否存在：base=合并公共祖先 / ours=本地(HEAD) / theirs=合入方(MERGE_HEAD)。
    /// 例如「deleted by us / added by them」场景里 ours 或 theirs 会缺位，前端据此给徽标。
    has_base: bool,
    has_ours: bool,
    has_theirs: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConflictSides {
    path: String,
    base: Option<String>,
    ours: Option<String>,
    theirs: Option<String>,
}

/// 遍历 index 的冲突 stage 条目。git 冲突 stages：stage1=base(祖先)、stage2=ours、stage3=theirs。
/// 返回 (path, base_oid, ours_oid, theirs_oid)，oid 只在对应侧存在时是 Some。
fn index_conflicts(repo: &Repository) -> Result<Vec<(String, Option<Oid>, Option<Oid>, Option<Oid>)>, String> {
    let index = repo.index().map_err(to_err)?;
    let mut out = Vec::new();
    for item in index.conflicts().map_err(to_err)? {
        let c = item.map_err(to_err)?;
        let path = c
            .our
            .as_ref()
            .or(c.their.as_ref())
            .or(c.ancestor.as_ref())
            .map(|e| String::from_utf8_lossy(&e.path).to_string())
            .unwrap_or_default();
        if path.is_empty() {
            continue;
        }
        out.push((
            path,
            c.ancestor.as_ref().map(|e| e.id),
            c.our.as_ref().map(|e| e.id),
            c.their.as_ref().map(|e| e.id),
        ));
    }
    Ok(out)
}

/// 冲突文件列表（合并进行中才有；无冲突返回空数组）
#[tauri::command]
fn get_conflicts(state: tauri::State<AppState>) -> Result<Vec<ConflictFile>, String> {
    with_repo!(state, repo, {
        let items = index_conflicts(repo)?;
        Ok(items
            .into_iter()
            .map(|(path, base, ours, theirs)| ConflictFile {
                path,
                has_base: base.is_some(),
                has_ours: ours.is_some(),
                has_theirs: theirs.is_some(),
            })
            .collect())
    })
}

/// 读取单个冲突文件的三侧完整内容（直接读 index stage blob，不需要解析磁盘上的 <<<<<<< 标记）。
/// 大文件截断到 512KB 并追加提示行，与 read_file_content 的策略保持一致。
fn conflict_sides_for(repo: &Repository, path: &str) -> Result<Option<ConflictSides>, String> {
    let items = index_conflicts(repo)?;
    let Some((_, base, ours, theirs)) = items.into_iter().find(|(p, ..)| *p == path) else {
        return Ok(None);
    };
    const LIMIT: usize = 512 * 1024;
    let read = |oid: Option<Oid>| -> Option<String> {
        let oid = oid?;
        let blob = repo.find_blob(oid).ok()?;
        let bytes = blob.content();
        // 含 NUL 视为二进制，返回 None（前端判定为「该侧不可用」，避免把乱码当文本写回）
        if bytes.contains(&0) {
            return None;
        }
        let (slice, truncated) = if bytes.len() > LIMIT {
            (&bytes[..LIMIT], true)
        } else {
            (bytes, false)
        };
        let mut text = String::from_utf8_lossy(slice).to_string();
        if truncated {
            text.push_str("\n\n…（文件过大，仅显示前 512KB）");
        }
        Some(text)
    };
    Ok(Some(ConflictSides {
        path: path.to_string(),
        base: read(base),
        ours: read(ours),
        theirs: read(theirs),
    }))
}

#[tauri::command]
fn get_conflict_sides(state: tauri::State<AppState>, path: String) -> Result<Option<ConflictSides>, String> {
    with_repo!(state, repo, { conflict_sides_for(repo, &path) })
}

/// 放弃当前合并/变基，回到操作前状态（git merge --abort / git rebase --abort）。
/// 走 git CLI：git2 没有等价的单调用，且 abort 要正确处理 index/worktree 回滚。
#[tauri::command]
fn abort_merge(state: tauri::State<AppState>) -> Result<String, String> {
    with_repo!(state, repo, {
        let st = repo.state();
        let (args, label) = match st {
            RepositoryState::Merge => (vec!["merge", "--abort"], "git merge --abort"),
            RepositoryState::Rebase
            | RepositoryState::RebaseInteractive
            | RepositoryState::RebaseMerge => (vec!["rebase", "--abort"], "git rebase --abort"),
            _ => return Err("当前不处于合并/变基状态，无需放弃".to_string()),
        };
        let workdir = repo.workdir().ok_or("裸仓库不支持此操作")?;
        let out = std::process::Command::new("git")
            .args(&args)
            .current_dir(workdir)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .map_err(|e| format!("无法执行 git（是否已安装并在 PATH 中？）: {e}"))?;
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        let combined = format!("{stdout}{stderr}");
        if out.status.success() {
            Ok(format!("{label}\n{combined}"))
        } else {
            Err(format!("{label} 失败：\n{combined}"))
        }
    })
}

// ---------- 分支操作 ----------

/// 把 libgit2 的 SAFE checkout 冲突原文翻成人话（原文照旧附在后面，便于诊断）。
///
/// 撞上本地改动时 libgit2 只给一句
///   `1 conflict prevents checkout: class=Checkout (20); code=Conflict (-13)`
/// ——字面上完全看不出「是未提交的改动挡住了」，class/code 是给调用方分支判断用的，
/// 不是给用户看的。这里补一句说明 + 出口，原始错误保留在末尾。
///
/// 判据用字符串匹配而不是 `e.class()/e.code()`：libgit2 在个别版本里把同一个语义
/// 归到不同 class（Checkout / Index / Tree 都见过），"prevents checkout" 这句才是稳定的。
fn checkout_err(name: &str, e: git2::Error) -> String {
    let raw = e.to_string();
    if raw.contains("prevents checkout") {
        return format!(
            "工作区有未提交的改动，切到 {name} 会被覆盖，git 已阻止这次切换（当前什么都没动）。\n\
             处理办法：先提交，或把改动暂存（左下角「暂存」按钮），或放弃这些文件的改动。\n\
             原始错误：{raw}"
        );
    }
    raw
}

/// 被本地改动挡住时，给出一条能把「挡的是什么」摊开的消息（错误条与控制台都用它）。
/// 文件列表设上限：几十个文件全列出来会把错误条撑满，反而看不清结论。
fn checkout_blocked_msg(name: &str, blockers: &[String]) -> String {
    const MAX_LIST: usize = 20;
    let mut msg = format!(
        "无法切换到 {name}：{} 个文件有未提交的改动，切过去会被覆盖（未做任何改动）。",
        blockers.len()
    );
    for p in blockers.iter().take(MAX_LIST) {
        msg.push_str(&format!("\n  {p}"));
    }
    if blockers.len() > MAX_LIST {
        msg.push_str(&format!("\n  … 还有 {} 个", blockers.len() - MAX_LIST));
    }
    msg.push_str("\n\n处理办法：先提交，或用左下角「暂存」把改动收进 stash，或放弃这些文件的改动。");
    msg
}

/// 切换前预检：算出「切到 target 会被覆盖、因而会被 libgit2 拒绝」的本地改动文件。
///
/// 判据（与 libgit2 的 SAFE checkout 逐条实测对齐，见 `_scratch/checkout_probe.rs`）：
///   1) **范围**先限定在「切换会动的文件」= diff(当前 HEAD tree, 目标 tree)。没被切换碰到的文件
///      不可能冲突——它在工作区里怎么改都无所谓。
///   2) 在这个范围里，只有「**该路径在工作区/索引层面是脏的**」且「**工作区内容与目标内容不同**」
///      才算冲突：脏但内容已与目标一致（比如自己改成了目标那份）→ 切换没有东西可覆盖，不拦。
///
/// 「脏」用 `status_file` 判，不是自己比字节——实测出来的坑：
///   · 本地删除未暂存（rm 没 git rm）→ libgit2 也拒（它要把文件恢复出来），status 是 WT_DELETED；
///   · 已暂存但工作区与 index 一致 → libgit2 **照样拒**（改动在 index 里同样会被冲掉），
///     所以不能拿「工作区 == index」当干净的判据，必须看 status 的 INDEX_* 位。
/// 纯本地、只读：不联网、不动 index、不动工作区。
fn checkout_blockers(repo: &Repository, target: Oid) -> Result<Vec<String>, String> {
    let Some(workdir) = repo.workdir().map(|w| w.to_path_buf()) else {
        return Ok(Vec::new()); // 裸仓库
    };
    // 还没有任何提交（unborn HEAD）时没有 HEAD tree 可 diff，直接放行
    let Some(head_tree) = repo.head().ok().and_then(|h| h.peel_to_tree().ok()) else {
        return Ok(Vec::new());
    };
    let target_tree = repo
        .find_commit(target)
        .map_err(to_err)?
        .tree()
        .map_err(to_err)?;
    let diff = repo
        .diff_tree_to_tree(Some(&head_tree), Some(&target_tree), None)
        .map_err(to_err)?;

    // 工作区/索引层面「动过」的所有位（含已暂存的 INDEX_*：它也挡切换，见函数注释）
    let dirty_bits = git2::Status::WT_NEW
        | git2::Status::WT_MODIFIED
        | git2::Status::WT_DELETED
        | git2::Status::WT_RENAMED
        | git2::Status::WT_TYPECHANGE
        | git2::Status::INDEX_NEW
        | git2::Status::INDEX_MODIFIED
        | git2::Status::INDEX_DELETED
        | git2::Status::INDEX_RENAMED
        | git2::Status::INDEX_TYPECHANGE
        | git2::Status::CONFLICTED;

    let mut out: Vec<String> = Vec::new();
    for delta in diff.deltas() {
        let Some(path) = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(|p| p.to_path_buf())
        else {
            continue;
        };
        let st = repo.status_file(&path).unwrap_or(git2::Status::CURRENT);
        if (st & dirty_bits).is_empty() {
            continue; // 干净文件：切换覆盖它是正常行为
        }
        let work_bytes = std::fs::read(workdir.join(&path)).ok();
        let target_bytes = match target_tree.get_path(&path) {
            Ok(entry) => repo.find_blob(entry.id()).ok().map(|b| b.content().to_vec()),
            Err(_) => None,
        };
        // 内容已经和目标一致 → 切换写不写都一样，不算冲突
        if work_bytes != target_bytes {
            out.push(path.to_string_lossy().replace('\\', "/"));
        }
    }
    out.sort();
    out.dedup();
    Ok(out)
}

/// 切换分支的只读预检：前端拿它决定「直接切」还是「弹一个能选出口的处理层」。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CheckoutPreview {
    ok: bool,
    blockers: Vec<String>,
}

#[tauri::command]
fn checkout_preview(
    state: tauri::State<AppState>,
    name: String,
) -> Result<CheckoutPreview, String> {
    with_repo!(state, repo, {
        let target = repo
            .revparse_single(&name)
            .map_err(to_err)?
            .peel_to_commit()
            .map_err(to_err)?
            .id();
        let blockers = checkout_blockers(repo, target)?;
        Ok(CheckoutPreview {
            ok: blockers.is_empty(),
            blockers,
        })
    })
}

#[tauri::command]
fn checkout_branch(state: tauri::State<AppState>, name: String) -> Result<(), String> {
    with_repo!(state, repo, {
        let (obj, reference) = repo.revparse_ext(&name).map_err(to_err)?;
        // 仍走 libgit2 的 SAFE checkout（会拒绝覆盖本地改动）；只是把撞车时的原文翻成人话
        repo.checkout_tree(&obj, None)
            .map_err(|e| checkout_err(&name, e))?;
        match reference {
            Some(r) => repo
                .set_head(r.name().ok_or("invalid ref name")?)
                .map_err(to_err),
            None => repo.set_head_detached(obj.id()).map_err(to_err),
        }
    })
}

/// 新建本地分支并（可选）切换过去。
///
/// - `from` 省略 = 起点取当前 HEAD（原来的行为）；给了就按 ref 解析，例如 `origin/202607-v5`。
///   等价 `git branch <name> <from>`。
/// - `track` = 让新分支跟踪 `from`。等价 `git checkout -b <name> --track <from>`
///   （`--track` 隐含从 <from> 建分支）。只有 `from` 是**已存在的远程跟踪分支**才成立。
///
/// 校验全部前置到建分支之前：否则中途报错会在仓库里留一个半成品分支（建了但没跟踪、也没切过去）。
fn create_branch_impl(
    repo: &Repository,
    name: &str,
    checkout: bool,
    from: Option<&str>,
    track: bool,
) -> Result<(), String> {
    let start_ref = from.map(str::trim).filter(|s| !s.is_empty());

    // set_upstream 认的是短名（"origin/main"）；调用方可能传 refs/remotes/... 或 remotes/...
    let upstream_short = if track {
        let Some(r) = start_ref else {
            return Err("跟踪远程分支必须同时指定 from（起点）".to_string());
        };
        let short = r
            .trim_start_matches("refs/remotes/")
            .trim_start_matches("remotes/")
            .to_string();
        // 远程跟踪分支必须先存在（fetch 过）。否则 set_upstream 只会报一句看不懂的错，
        // 这里提前换成能照着做的提示（和 set_upstream_impl 的策略一致）
        if repo.find_branch(&short, BranchType::Remote).is_err() {
            return Err(format!(
                "{short} 不是本仓库已知的远程跟踪分支。先 fetch 一次再试（git fetch）"
            ));
        }
        Some(short)
    } else {
        None
    };

    if repo.find_branch(name, BranchType::Local).is_ok() {
        return Err(format!("本地已存在分支 {name}"));
    }

    let start = match start_ref {
        Some(r) => repo
            .revparse_single(r)
            .map_err(to_err)?
            .peel_to_commit()
            .map_err(to_err)?,
        None => repo.head().map_err(to_err)?.peel_to_commit().map_err(to_err)?,
    };

    // 前置预检：切过去会被本地改动挡住时，**在建分支之前**就报错退出。
    // 否则会留下「分支建好了、人却还在原分支」的半成品（原实现就是这个顺序）。
    if checkout {
        let blockers = checkout_blockers(repo, start.id())?;
        if !blockers.is_empty() {
            return Err(checkout_blocked_msg(name, &blockers));
        }
    }

    repo.branch(name, &start, false).map_err(to_err)?;

    if let Some(short) = upstream_short.as_deref() {
        let mut lb = repo.find_branch(name, BranchType::Local).map_err(to_err)?;
        lb.set_upstream(Some(short)).map_err(to_err)?;
    }

    if checkout {
        let obj = repo
            .revparse_single(&format!("refs/heads/{name}"))
            .map_err(to_err)?;
        if let Err(e) = repo.checkout_tree(&obj, None).map_err(|e| checkout_err(name, e)) {
            // 预检之外仍切不过去（例如索引里有未提交的删除/重命名）：把刚建的分支撤掉，
            // 不留「分支建好了但人还在原分支」的半成品。
            if let Ok(mut b) = repo.find_branch(name, BranchType::Local) {
                let _ = b.delete();
            }
            return Err(e);
        }
        repo.set_head(&format!("refs/heads/{name}")).map_err(to_err)?;
    }
    Ok(())
}

#[tauri::command]
fn create_branch(
    state: tauri::State<AppState>,
    name: String,
    checkout: bool,
    from: Option<String>,
    track: Option<bool>,
) -> Result<(), String> {
    with_repo!(state, repo, {
        create_branch_impl(repo, &name, checkout, from.as_deref(), track.unwrap_or(false))
    })
}

/// 重命名本地分支。当前分支也允许（git 支持）；force=false 时与已有分支重名会报错。
#[tauri::command]
fn rename_branch(state: tauri::State<AppState>, old: String, new: String) -> Result<(), String> {
    let new = new.trim().to_string();
    if new.is_empty() {
        return Err("分支名不能为空".to_string());
    }
    with_repo!(state, repo, {
        let mut branch = repo.find_branch(&old, BranchType::Local).map_err(to_err)?;
        // rename 返回重命名后的 Branch，丢弃即可
        branch.rename(&new, false).map_err(to_err).map(|_| ())
    })
}

#[tauri::command]
fn delete_branch(state: tauri::State<AppState>, name: String, force: bool) -> Result<(), String> {
    with_repo!(state, repo, {
        let mut branch = repo.find_branch(&name, BranchType::Local).map_err(to_err)?;
        if branch.is_head() {
            return Err("不能删除当前分支".to_string());
        }
        // 用 graph_descendant_of 判断分支 tip 是否已合并进 HEAD
        let tip = branch.get().target().ok_or("分支没有目标提交")?;
        let head_oid = repo.head().map_err(to_err)?.target().ok_or("HEAD 没有目标提交")?;
        let merged = tip == head_oid || repo.graph_descendant_of(head_oid, tip).map_err(to_err)?;
        if !force && !merged {
            return Err("分支未合并，需要 force 才能删除".to_string());
        }
        branch.delete().map_err(to_err)
    })
}

// ---------- 上游分支关联（upstream / 分支绑定） ----------
//
// 等价 git 命令：
//   绑定：git branch -u origin/main main      （--set-upstream-to：上游在前，本地分支在后）
//   解绑：git branch --unset-upstream main
// 两者都**只写 .git/config**（branch.<本地>.remote / branch.<本地>.merge），不 fetch、不 push，
// 也不需要先切到那个分支——所以用 git2 原生 API 完成，不走 git CLI 侧车（侧车留给要联网的操作）。
//
// 注意 libgit2 的隐含前置条件：它内部会按 GIT_BRANCH_REMOTE 去找 <name>，
// 也就是 refs/remotes/<remote>/<branch> **必须已经在本地存在**（之前 fetch 或 push 过）。
// 否则只报一句 "cannot set upstream for branch 'x'"，所以这里提前判一次，换成能照着做的提示。

/// 列出仓库已配置的远程名（纯本地读 config，不联网）。
/// 前端用它区分顶栏该显示「未关联远程」（有远程、只是没绑）还是「无远程」（连地址都没配），
/// 以及绑定弹层里的远程候选。
#[tauri::command]
fn list_remotes(state: tauri::State<AppState>) -> Result<Vec<String>, String> {
    with_repo!(state, repo, {
        let names = repo.remotes().map_err(to_err)?;
        Ok(names.iter().flatten().map(|s| s.to_string()).collect())
    })
}

/// set_branch_upstream 的实现体（拆出来是为了能脱离 Tauri State 直接单测）。
/// upstream 传 None / 空串表示解绑。
fn set_upstream_impl(repo: &Repository, local: &str, upstream: Option<&str>) -> Result<String, String> {
    let mut branch = repo
        .find_branch(local, BranchType::Local)
        .map_err(|e| format!("找不到本地分支 {local}：{}", e.message()))?;

    let target = upstream.map(str::trim).filter(|u| !u.is_empty());

    let Some(name) = target else {
        branch.set_upstream(None).map_err(to_err)?;
        return Ok(format!("已解除 {local} 的远程分支关联（只改本地配置）"));
    };

    if repo.find_branch(name, BranchType::Remote).is_err() {
        return Err(format!(
            "本地没有远程跟踪分支 {name}，绑定不了。\n\
             通常是这个分支还没 fetch 下来：先点一次 fetch 再看；也顺手确认分支名有没有写错。"
        ));
    }

    branch.set_upstream(Some(name)).map_err(to_err)?;

    // 读回真正的配置值再回报，避免「以为绑上了」——libgit2 会按 remote 的 fetch refspec
    // 反推 branch.<名字>.merge 的值，回读能顺带验证这一步没出错
    let applied = branch
        .upstream()
        .ok()
        .and_then(|u| u.name().ok().flatten().map(|s| s.to_string()))
        .unwrap_or_else(|| name.to_string());
    Ok(format!(
        "已把 {local} 绑定到 {applied}（只改 .git/config，未推送）"
    ))
}

/// 绑定 / 解绑本地分支的上游。
/// upstream 形如 "origin/main"（远程跟踪分支短名）；传 None（或空串）表示解绑。
/// 本地分支名与远程分支名可以不同——这正是「名字对不上时手动绑定」的主要用例。
#[tauri::command]
fn set_branch_upstream(
    state: tauri::State<AppState>,
    local: String,
    upstream: Option<String>,
) -> Result<String, String> {
    let local = local.trim().to_string();
    if local.is_empty() {
        return Err("本地分支名不能为空".to_string());
    }
    with_repo!(state, repo, {
        let target = upstream
            .map(|u| u.trim().to_string())
            .filter(|u| !u.is_empty());
        set_upstream_impl(repo, &local, target.as_deref())
    })
}

// ---------- 暂存与提交 ----------

// ---------- Stash（本地操作，直接用 git2 原生 API） ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StashEntry {
    index: usize,
    message: String,
    oid: String,
}

/// 取提交签名；仓库没配 user.name/email 时兜底，避免 stash 直接失败
fn signature_or_default(repo: &Repository) -> Result<git2::Signature<'static>, String> {
    match repo.signature() {
        Ok(s) => Ok(git2::Signature::new(
            s.name().unwrap_or("unknown"),
            s.email().unwrap_or("unknown@local"),
            &s.when(),
        )
        .map_err(to_err)?),
        Err(_) => git2::Signature::now("GitManage", "gitmanage@local").map_err(to_err),
    }
}

#[tauri::command]
fn stash_list(state: tauri::State<AppState>) -> Result<Vec<StashEntry>, String> {
    with_repo!(state, repo, {
        let mut out = Vec::new();
        repo.stash_foreach(|index, message, oid| {
            out.push(StashEntry {
                index,
                message: message.to_string(),
                oid: oid.to_string(),
            });
            true // 继续遍历
        })
        .map_err(to_err)?;
        Ok(out)
    })
}

#[tauri::command]
fn stash_save(state: tauri::State<AppState>, message: Option<String>) -> Result<String, String> {
    with_repo!(state, repo, {
        let sig = signature_or_default(repo)?;
        let msg = message
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty())
            .unwrap_or_else(|| "GitManage 自动暂存".to_string());
        let oid = repo
            .stash_save(&sig, &msg, Some(git2::StashFlags::INCLUDE_UNTRACKED))
            .map_err(to_err)?;
        Ok(oid.to_string())
    })
}

/// pop = apply + drop，索引不存在时 git2 会返回错误
#[tauri::command]
fn stash_pop(state: tauri::State<AppState>, index: usize) -> Result<(), String> {
    with_repo!(state, repo, {
        repo.stash_pop(index, None).map_err(to_err)
    })
}

#[tauri::command]
fn stash_apply(state: tauri::State<AppState>, index: usize) -> Result<(), String> {
    with_repo!(state, repo, {
        repo.stash_apply(index, None).map_err(to_err)
    })
}

#[tauri::command]
fn stash_drop(state: tauri::State<AppState>, index: usize) -> Result<(), String> {
    with_repo!(state, repo, {
        repo.stash_drop(index).map_err(to_err)
    })
}

// ---------- 「不提交」列表（本地修改但不提交的文件） ----------
//
// 持久化在 .git/info/gitmanage-skip.json——.git/info/ 本就是 git 放仓库级本地配置的地方
// （info/exclude 同理），不进版本库、不随 push 传播，语义正好是"只在本机生效"。

fn skip_file(repo: &Repository) -> std::path::PathBuf {
    repo.path().join("info/gitmanage-skip.json")
}

fn read_skip(repo: &Repository) -> Vec<String> {
    std::fs::read_to_string(skip_file(repo))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

#[tauri::command]
fn get_skip_list(state: tauri::State<AppState>) -> Result<Vec<String>, String> {
    with_repo!(state, repo, { Ok(read_skip(repo)) })
}

/// 把路径加入/移出「不提交」列表，返回更新后的完整列表
#[tauri::command]
fn set_skip(state: tauri::State<AppState>, path: String, skip: bool) -> Result<Vec<String>, String> {
    with_repo!(state, repo, {
        let mut list = read_skip(repo);
        if skip {
            if !list.contains(&path) {
                list.push(path);
            }
        } else {
            list.retain(|p| *p != path);
        }
        let f = skip_file(repo);
        if let Some(dir) = f.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("无法创建 info 目录: {e}"))?;
        }
        let json = serde_json::to_string_pretty(&list).map_err(to_err)?;
        std::fs::write(&f, json).map_err(|e| format!("写入不提交列表失败: {e}"))?;
        Ok(list)
    })
}

/// 只暂存指定路径（文件级勾选提交用）。
/// 删除判定不能只看磁盘是否存在——「停止跟踪」（git rm --cached）的文件磁盘上还在，
/// 但状态是 INDEX_DELETED，这种情况必须 remove_path 保持不跟踪，否则会被重新加回。
#[tauri::command]
fn stage_files(state: tauri::State<AppState>, paths: Vec<String>) -> Result<usize, String> {
    with_repo!(state, repo, {
        let workdir = repo.workdir().ok_or("裸仓库不支持此操作")?;
        // 先收集所有"删除态"路径（索引删除 = 停止跟踪；工作区删除 = 文件没了）
        let mut dels = std::collections::HashSet::new();
        let sts = repo.statuses(None).map_err(to_err)?;
        for e in sts.iter() {
            if e
                .status()
                .intersects(git2::Status::INDEX_DELETED | git2::Status::WT_DELETED)
            {
                if let Some(p) = e.path() {
                    dels.insert(p.to_string());
                }
            }
        }
        let mut index = repo.index().map_err(to_err)?;
        for p in &paths {
            let rel = std::path::Path::new(p);
            if dels.contains(p) || !workdir.join(rel).exists() {
                index.remove_path(rel).map_err(to_err)?;
            } else {
                index.add_path(rel).map_err(to_err)?;
            }
        }
        index.write().map_err(to_err)?;
        Ok(paths.len())
    })
}

/// 放弃单个文件的工作区改动（不可恢复，前端必须确认后才调用）。
/// - 已跟踪文件：从索引检出覆盖工作区（等价 git checkout -- <path>）
/// - 未跟踪文件：直接删除（等价扔掉新建的文件）
/// - 工作区已删除的跟踪文件：同样从索引检出 = 还原回来
#[tauri::command]
fn discard_file_changes(state: tauri::State<AppState>, path: String) -> Result<String, String> {
    with_repo!(state, repo, {
        let rel = std::path::Path::new(&path);
        let st = repo.status_file(rel).map_err(to_err)?;
        if st.contains(git2::Status::WT_NEW) {
            let full = repo
                .workdir()
                .ok_or("裸仓库不支持此操作")?
                .join(rel);
            std::fs::remove_file(&full).map_err(|e| format!("删除失败: {e}"))?;
            return Ok(format!("已删除未跟踪文件: {path}"));
        }
        let mut opts = git2::build::CheckoutBuilder::new();
        opts.path(&path).force();
        repo.checkout_index(None, Some(&mut opts)).map_err(to_err)?;
        Ok(format!("已放弃改动: {path}"))
    })
}

/// 「放弃这些文件的改动」= 真的回到 HEAD，**含清掉已暂存的改动**。
///
/// 与 `discard_file_changes` 的区别：那个恢复的是 **index 版本**（对已暂存文件 = 保留暂存内容，
/// 因为 index 里存的就是那份新内容），只够撤掉「工作区那点手改」；而切换受阻时挡路的往往还有
/// **暂存区**里的改动——实测 libgit2 对 INDEX_MODIFIED 一样拒（见 `_scratch/checkout_probe.rs` ⑦），
/// 所以这里必须把 index 也归位到 HEAD。顺序不能反：先归位 index，再按 index 刷工作区。
fn discard_paths_to_head_impl(repo: &Repository, paths: &[String]) -> Result<String, String> {
    let workdir = repo.workdir().ok_or("裸仓库不支持此操作")?.to_path_buf();
    let head = repo.head().map_err(to_err)?.peel_to_commit().map_err(to_err)?;
    let head_tree = head.tree().map_err(to_err)?;

    // index 归位到 HEAD（等价 `git reset -- <paths>`）：已暂存的改动、以及「已暂存但 HEAD 里没有」
    // 的新文件条目都在这一步清掉。这里走 pathspec 接口，路径原样传即可（精确匹配）。
    let specs: Vec<&str> = paths.iter().map(|s| s.as_str()).collect();
    repo.reset_default(Some(head.as_object()), specs.iter().copied())
        .map_err(to_err)?;

    let mut restored = 0usize;
    let mut removed = 0usize;
    for p in paths {
        let rel = std::path::Path::new(p);
        if head_tree.get_path(rel).is_ok() {
            // index 刚归位到 HEAD，让工作区跟着 index 走（force 覆盖本地改动）
            let mut opts = git2::build::CheckoutBuilder::new();
            opts.path(p).force();
            repo.checkout_index(None, Some(&mut opts)).map_err(to_err)?;
            restored += 1;
        } else {
            // HEAD 里没有这个文件 = 未跟踪的新文件，直接删
            let full = workdir.join(rel);
            if full.is_file() {
                std::fs::remove_file(&full).map_err(|e| format!("删除失败: {e}"))?;
            }
            removed += 1;
        }
    }
    Ok(format!("已放弃 {restored} 个文件的改动，删除 {removed} 个新增文件"))
}

#[tauri::command]
fn discard_paths_to_head(
    state: tauri::State<AppState>,
    paths: Vec<String>,
) -> Result<String, String> {
    with_repo!(state, repo, { discard_paths_to_head_impl(repo, &paths) })
}

// ---------- 远程操作（git CLI 侧车） ----------
//
// git2 编译时关掉了 https/ssh（default-features=false），网络操作交给系统 git 命令：
// 这样能复用 Windows 凭据管理器 / SSH agent，也省掉 openssl 依赖。
//
// 关键：设置 GIT_TERMINAL_PROMPT=0，避免 git 在后台弹交互式凭据输入把界面卡死；
// 缺凭据时会直接失败并把 git 的原始输出返回给前端展示。

#[tauri::command]
fn git_remote_op(
    state: tauri::State<AppState>,
    op: String, // "fetch" | "pull" | "push"
    remote: Option<String>,
    branch: Option<String>,
) -> Result<String, String> {
    if !matches!(op.as_str(), "fetch" | "pull" | "push") {
        return Err(format!("不支持的操作: {op}"));
    }
    with_repo!(state, repo, {
        let workdir = repo.workdir().ok_or("裸仓库不支持此操作")?;
        let remote_name = remote
            .map(|r| r.trim().to_string())
            .filter(|r| !r.is_empty())
            .unwrap_or_else(|| "origin".to_string());
        let branch_name = branch
            .map(|b| b.trim().to_string())
            .filter(|b| !b.is_empty());

        // 未绑定上游的分支上 `git push origin`（不带 refspec）会直接 fatal：
        //   "The current branch X has no upstream branch."
        // 因为 push.default 默认是 simple，没有 upstream 就不知道该往哪儿推。
        // 界面上的「↑ push」按钮正好走这条路径（branch 传 null），于是新分支第一次根本推不上去。
        // 这里在缺 upstream 时补 --set-upstream，等价 `git push -u origin <当前分支>`：
        // 推上去的同时建立跟踪，后面的 ahead/behind 角标也才有意义。
        let mut set_upstream = false;
        let mut current = None;
        if op == "push" && branch_name.is_none() {
            let cur = repo
                .head()
                .ok()
                .filter(|h| h.is_branch())
                .and_then(|h| h.shorthand().map(|s| s.to_string()));
            let has_upstream = cur
                .as_deref()
                .and_then(|n| repo.find_branch(n, BranchType::Local).ok())
                .and_then(|b| b.upstream().ok())
                .is_some();
            set_upstream = cur.is_some() && !has_upstream;
            current = cur;
        }

        let mut args: Vec<String> = vec![op.clone(), remote_name.clone()];
        if set_upstream {
            args.push("--set-upstream".to_string());
        }
        if let Some(b) = branch_name {
            args.push(b);
        } else if set_upstream {
            // 只有确认缺 upstream 才补分支名；否则保持原来的 `git push origin` 语义
            if let Some(cur) = current {
                args.push(cur);
            }
        }
        // git 2.27+ 在分支分叉且未配置 pull.rebase / pull.ff 时会直接 fatal:
        // "Need to specify how to reconcile divergent branches"，连合并都不会做。
        // 这里显式走 merge：不依赖用户 config，且冲突一次性写入 index（→「冲突」列表）；
        // rebase 会逐个 commit 重放，同一个文件可能反复冲突多轮，不适合 GUI 流程。
        // 注意：能快进时依然是 fast-forward，只有真分叉才会生成 merge commit。
        if op == "pull" {
            args.push("--no-rebase".to_string());
        }

        let out = std::process::Command::new("git")
            .args(&args)
            .current_dir(workdir)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .map_err(|e| format!("无法执行 git（是否已安装并在 PATH 中？）: {e}"))?;

        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        // git 习惯把进度信息写 stderr，两路都要收集
        let combined = format!("{stdout}{stderr}");

        if out.status.success() {
            Ok(combined)
        } else {
            // pull 不带 refspec 时 git 只认「当前分支的 upstream」，没有上游就直接失败退出（码 1，
            // 什么都没合）：
            //   "You asked to pull from the remote 'origin', but did not specify a branch."
            // 行为是安全的（不会误合远程默认分支），但这句原文对 GUI 用户太绕——他没写过 git 命令的话
            // 看不出「缺的是绑定」，所以这里补一句该去哪儿绑。
            let no_upstream = op == "pull" && combined.contains("but did not specify");
            let hint = if no_upstream {
                "\n\n提示：当前分支未关联远程分支，git 不知道该合并哪一条（未做任何改动）。\n绑定入口：左栏分支树里右键当前分支 →「⇄ 绑定远程分支…」，选一个上游后再点 pull。"
            } else if combined.contains("could not read Username")
                || combined.contains("Authentication failed")
                || combined.contains("Permission denied")
            {
                "\n\n提示：凭据未提供。请在 Windows 凭据管理器中配置，或改用 SSH 远端地址。"
            } else {
                ""
            };
            Err(format!("git {op} 失败：\n{combined}{hint}"))
        }
    })
}

/// 当前分支与其上游（upstream）的领先/落后提交数：(ahead, behind)。
/// ahead = 本地领先、待 push 的条数；behind = 远程领先、待 pull 的条数。
/// 无上游（未关联远程分支 / 纯本地仓库）返回 None，前端不显示角标。
/// 注意：behind 只反映"上次 fetch 时"的远程状态——这是所有 Git GUI 的共同语义。
#[tauri::command]
fn get_ahead_behind(state: tauri::State<AppState>) -> Result<Option<(usize, usize)>, String> {
    with_repo!(state, repo, {
        let local_oid = match repo.head().ok().and_then(|h| h.target()) {
            Some(o) => o,
            None => return Ok(None), // 空仓库 / 分离 HEAD
        };
        let branch_name = match repo.head().ok().and_then(|h| h.shorthand().map(|s| s.to_string())) {
            Some(s) => s,
            None => return Ok(None),
        };
        let branch = match repo.find_branch(&branch_name, git2::BranchType::Local) {
            Ok(b) => b,
            Err(_) => return Ok(None),
        };
        let upstream_oid = match branch.upstream().ok().and_then(|u| u.get().target()) {
            Some(o) => o,
            None => return Ok(None), // 未设置 upstream
        };
        let ab = repo.graph_ahead_behind(local_oid, upstream_oid).map_err(to_err)?;
        Ok(Some(ab))
    })
}

/// 读取指定远程（默认 origin）的 URL，用于「设置远程」弹层预填；未配置时返回 None。
#[tauri::command]
fn get_remote_url(state: tauri::State<AppState>, name: Option<String>) -> Result<Option<String>, String> {
    with_repo!(state, repo, {
        let n = name
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "origin".to_string());
        // match 必须先落到 let：块尾表达式里的 match 临时量（Remote 借用了 guard）
        // 会在 guard 之后才析构，触发 E0597
        let url = match repo.find_remote(&n) {
            Ok(r) => r.url().map(|u| u.to_string()),
            Err(_) => None,
        };
        Ok(url)
    })
}

/// 设置远程仓库地址：已存在同名远程则改 URL（等价 git remote set-url），
/// 不存在则新建（等价 git remote add）。纯配置操作，不走网络，所以直接用 git2 而不走 CLI 侧车。
#[tauri::command]
fn set_remote_url(state: tauri::State<AppState>, url: String, name: Option<String>) -> Result<String, String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("远程地址不能为空".to_string());
    }
    with_repo!(state, repo, {
        let n = name
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "origin".to_string());
        if repo.find_remote(&n).is_ok() {
            repo.remote_set_url(&n, &url).map_err(to_err)?;
            Ok(format!("已更新远程 {n} → {url}"))
        } else {
            repo.remote(&n, &url).map_err(to_err)?;
            Ok(format!("已添加远程 {n} → {url}"))
        }
    })
}

// ---------- 提交身份（user.name / user.email） ----------
//
// 生效值按 git 的层级优先级叠加（本地覆盖全局）：
//   worktree > local(.git/config) > global(~/.gitconfig) > xdg > system > programdata
// libgit2 侧的依据：
//   - 读：git_config_get_entry 遍历 readers（按 level 降序），**第一个命中的**就是生效值，
//         它的 level() 正好说明「这个值是从哪一层来的」——所以能如实回显来源。
//   - 写：git_config_set_string 写「最高层（通常是 local）」，见 libgit2 config.h 原文：
//         "Set the value of a string config variable in the config file with the highest level
//          (usually the local one)."
//         → repo.config().set_str() 等价 `git config user.name`（只动本仓库）；
//           要写 global 必须先 open_level(Global) 取出**只含 global 层**的 config，
//           否则照样会写进 local（这是最容易写错的地方）。
//   - 缓存：repo 的 config 实例在仓库生命周期内复用（repository.c 的 repo->_config），
//           但 config_file backend 每次读之前都会按 mtime 重载（config_file.c: config_file_get
//           → config_file_refresh），所以写完之后立刻提交/再读，拿到的都是新值，不存在脏读。

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IdentityInfo {
    /// 当前**生效值**（各层叠加后的结果）；未配置为空串
    name: String,
    email: String,
    /// 生效值来自哪一层："local" / "global" / "system" / "xdg" / "programdata" / "worktree" / "app"；
    /// 该键完全没配置时为空串
    name_level: String,
    email_level: String,
    /// 各层**显式写着**的值（该层没配 → 空串）。local 用来判断「本仓库是否覆盖过」，
    /// global 用来在切到全局作用域时预填。
    local_name: String,
    local_email: String,
    global_name: String,
    global_email: String,
}

fn config_level_name(level: ConfigLevel) -> &'static str {
    match level {
        ConfigLevel::ProgramData => "programdata",
        ConfigLevel::System => "system",
        ConfigLevel::XDG => "xdg",
        ConfigLevel::Global => "global",
        ConfigLevel::Local => "local",
        ConfigLevel::Worktree => "worktree",
        ConfigLevel::App => "app",
        ConfigLevel::Highest => "highest",
    }
}

/// 读**某一层**里显式写着的值。该层没配就是 GIT_ENOTFOUND —— 那是正常情况（比如 local 没覆盖），
/// 直接当空串，不往上抛错误。
fn config_level_value(cfg: &Config, level: ConfigLevel, key: &str) -> String {
    cfg.open_level(level)
        .ok()
        .and_then(|c| c.get_string(key).ok())
        .unwrap_or_default()
}

/// 读某个键的生效值 + 它来自哪一层。没配置 → ("", "")。
fn config_effective(cfg: &Config, key: &str) -> (String, String) {
    match cfg.get_entry(key) {
        Ok(e) => (
            e.value().unwrap_or("").to_string(),
            config_level_name(e.level()).to_string(),
        ),
        Err(_) => (String::new(), String::new()),
    }
}

/// 读取当前生效的提交身份 + local/global 两层的显式值（编辑面板用）。
#[tauri::command]
fn get_identity(state: tauri::State<AppState>) -> Result<IdentityInfo, String> {
    with_repo!(state, repo, {
        let cfg = repo.config().map_err(to_err)?;
        let (name, name_level) = config_effective(&cfg, "user.name");
        let (email, email_level) = config_effective(&cfg, "user.email");
        Ok(IdentityInfo {
            name,
            email,
            name_level,
            email_level,
            local_name: config_level_value(&cfg, ConfigLevel::Local, "user.name"),
            local_email: config_level_value(&cfg, ConfigLevel::Local, "user.email"),
            global_name: config_level_value(&cfg, ConfigLevel::Global, "user.name"),
            global_email: config_level_value(&cfg, ConfigLevel::Global, "user.email"),
        })
    })
}

/// 写入提交身份。
/// scope = "local"  只写本仓库 .git/config，等价 `git config user.name "..."`；
/// scope = "global" 写用户级 ~/.gitconfig，等价 `git config --global user.name "..."`，
///                  所有仓库一起变（本仓库若已有 local 覆盖，仍然以 local 为准）。
/// 校验全部前置：宁可什么都不写，也不留下「name 写了 email 没写」这种半截配置 ——
/// 那种状态下一提交就报 NotFound，比直接报错更难查。
#[tauri::command]
fn set_identity(
    state: tauri::State<AppState>,
    name: String,
    email: String,
    scope: String,
) -> Result<String, String> {
    if !matches!(scope.as_str(), "local" | "global") {
        return Err(format!("不支持的作用域：{scope}（只认 local / global）"));
    }
    let name = name.trim().to_string();
    let email = email.trim().to_string();
    if name.is_empty() {
        return Err("用户名不能为空".to_string());
    }
    if email.is_empty() || !email.contains('@') {
        return Err("邮箱不能为空，且必须包含 @".to_string());
    }
    with_repo!(state, repo, {
        // 写哪一层完全取决于 config 实例里那个「可写 backend」：
        // global 分支用 open_level 取出只含 global 层的实例（libgit2 即使 ~/.gitconfig 不存在
        // 也会为它开一个可写 backend —— repository.c 有 "If there is no global file, open a
        // backend for it anyway"，文件会在首次写入时创建）。
        // 中间那个临时 Config 析构是安全的：git_config__add_instance 对新实例做了
        // GIT_REFCOUNT_INC，config_free 只是 DEC，backend 不会被提前释放。
        let mut cfg = if scope == "global" {
            repo.config()
                .map_err(to_err)?
                .open_level(ConfigLevel::Global)
                .map_err(|e| format!("打不开全局配置（~/.gitconfig）：{e}"))?
        } else {
            repo.config().map_err(to_err)?
        };
        cfg.set_str("user.name", &name).map_err(to_err)?;
        cfg.set_str("user.email", &email).map_err(to_err)?;

        let (flag, where_) = if scope == "global" {
            ("--global ", "全局")
        } else {
            ("", "本仓库")
        };
        Ok(format!(
            "已设置{where_}提交身份：{name} <{email}>\n\
             等价命令：git config {flag}user.name \"{name}\" && git config {flag}user.email \"{email}\""
        ))
    })
}

/// 取消本仓库的身份覆盖（等价 `git config --unset user.name/email`），回落到全局身份。
/// 只动 local 层；某一边本来就没覆盖时静默跳过 —— libgit2 删不存在的键会报
/// "could not find key ... to delete"，那不该算失败。
#[tauri::command]
fn clear_local_identity(state: tauri::State<AppState>) -> Result<String, String> {
    with_repo!(state, repo, {
        let mut cfg = repo
            .config()
            .map_err(to_err)?
            .open_level(ConfigLevel::Local)
            .map_err(|e| format!("打不开本仓库配置（.git/config）：{e}"))?;
        for key in ["user.name", "user.email"] {
            // 先确认这一层确实写着，再删：直接把 ENOTFOUND 当失败会误报
            if cfg.get_entry(key).is_ok() {
                cfg.remove(key).map_err(to_err)?;
            }
        }
        Ok("已清除本仓库的身份覆盖，之后沿用全局身份\n\
            等价命令：git config --unset user.name && git config --unset user.email"
            .to_string())
    })
}

// ---------- 这个仓库推送时会用哪个凭据 ----------

/// 把 remote URL 拆成 (scheme, host, path, user)。支持两种写法：
///   https://host/path、http://user@host:port/path、ssh://git@host/path
///   git@host:path（scp 风格，没有 "://"）
/// 解析不出来就返回全空串（调用方据此给「不支持/认不出」的提示）。
fn parse_remote_url(url: &str) -> (String, String, String, String) {
    let s = url.trim();
    if let Some(idx) = s.find("://") {
        let scheme = s[..idx].to_lowercase();
        let rest = &s[idx + 3..];
        let (authority, path) = match rest.find('/') {
            Some(i) => (&rest[..i], rest[i + 1..].to_string()),
            None => (rest, String::new()),
        };
        let (user, host) = match authority.rfind('@') {
            Some(i) => (authority[..i].to_string(), authority[i + 1..].to_string()),
            None => (String::new(), authority.to_string()),
        };
        return (scheme, host, path, user);
    }
    // scp 风格 git@host:path
    if let (Some(at), Some(colon)) = (s.find('@'), s.find(':')) {
        if at < colon {
            return (
                "ssh".to_string(),
                s[at + 1..colon].to_string(),
                s[colon + 1..].to_string(),
                s[..at].to_string(),
            );
        }
    }
    (String::new(), String::new(), String::new(), String::new())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteCredential {
    url: String,
    /// https / http / ssh / 空（认不出来）
    scheme: String,
    host: String,
    /// git 实际会用的账号名；空 = 没查到
    username: String,
    /// 该主机是否已有可用凭据。SSH 恒为 false —— 那条路走 key，跟凭据管理器无关
    has_credential: bool,
    /// "ok" | "warn" | "info"，前端据此上色
    level: String,
    /// 一句话结论，直接展示
    note: String,
}

/// 查「当前仓库推送时会以谁的身份连服务器」，用来回答「我这个项目的凭据正常吗」。
///
/// 做法是**让 git 自己回答**：`git credential fill` 是 git 取凭据的唯一入口，它会按完整的
/// 优先级链（credential.helper → 凭据管理器 → `credential.<url>.*` 配置）算出实际会用的那份，
/// 比我们自己读 Windows 凭据管理器再猜准得多 —— 还能正确反映 useHttpPath 这类配置的影响。
///
/// ⚠️ 输出里的 `password=` 字段**只存在于这个函数的局部字符串里**：不解析、不返回、读完立刻释放。
/// 返回给前端的只有账号名和「有没有凭据」。这条命令同时禁掉交互与 GCM 弹窗，纯粹当查询用。
#[tauri::command]
fn get_remote_credential(state: tauri::State<AppState>) -> Result<RemoteCredential, String> {
    with_repo!(state, repo, {
        let url = repo
            .find_remote("origin")
            .ok()
            .and_then(|r| r.url().map(str::to_string))
            .unwrap_or_default();

        if url.trim().is_empty() {
            return Ok(RemoteCredential {
                url,
                scheme: String::new(),
                host: String::new(),
                username: String::new(),
                has_credential: false,
                level: "info".to_string(),
                note: "这个仓库没有配置远程地址（origin），不涉及推送凭据".to_string(),
            });
        }

        let (scheme, host, path, url_user) = parse_remote_url(&url);

        // SSH：认证走 key，凭据管理器完全不参与，别去查它
        if scheme == "ssh" {
            return Ok(RemoteCredential {
                url,
                scheme,
                username: url_user,
                has_credential: false,
                level: "info".to_string(),
                host: host.clone(),
                note: format!(
                    "走 SSH key 认证，凭据管理器不参与。key 一般在 %USERPROFILE%\\.ssh\\ 下；\
                     用 ssh -T git@{host} 可以测连通性"
                ),
            });
        }

        if scheme.is_empty() {
            return Ok(RemoteCredential {
                url,
                scheme,
                host,
                username: String::new(),
                has_credential: false,
                level: "info".to_string(),
                note: "这个远程地址的写法认不出来，无法判断凭据（支持 https:// / http:// / ssh 形式）"
                    .to_string(),
            });
        }

        // HTTPS / HTTP：问 git 用哪个账号
        let mut input = format!("protocol={scheme}\nhost={host}\n");
        if !path.is_empty() {
            input.push_str(&format!("path={path}\n"));
        }
        if !url_user.is_empty() {
            input.push_str(&format!("username={url_user}\n"));
        }
        input.push('\n');

        let mut child = std::process::Command::new("git")
            .args(["credential", "fill"])
            .env("GIT_TERMINAL_PROMPT", "0") // 别卡在交互提示上
            .env("GCM_INTERACTIVE", "never") // 更别弹 GCM 的窗
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("无法执行 git（是否已安装并在 PATH 中？）：{e}"))?;
        {
            use std::io::Write;
            let mut si = child.stdin.take().ok_or("无法写入 git 的标准输入")?;
            si.write_all(input.as_bytes()).map_err(to_err)?;
            // si 在这里 drop → 关掉 stdin，git 才会开始处理
        }
        let out = child.wait_with_output().map_err(to_err)?;
        let text = String::from_utf8_lossy(&out.stdout).to_string();

        let mut username = String::new();
        let mut has_password = false;
        for line in text.lines() {
            if let Some(v) = line.strip_prefix("username=") {
                username = v.trim().to_string();
            } else if let Some(v) = line.strip_prefix("password=") {
                has_password = !v.trim().is_empty();
            }
        }
        drop(text); // 含 password 的整段立刻释放

        let (level, note) = if has_password {
            let who = if username.is_empty() {
                "（git 没返回用户名）".to_string()
            } else {
                format!("「{username}」")
            };
            (
                "ok",
                format!("该主机已有凭据，推送时会以{who}登录"),
            )
        } else {
            (
                "warn",
                "该主机没有已存凭据：推送时会要求输入账号/密码，在无人值守的环境里会直接失败"
                    .to_string(),
            )
        };

        Ok(RemoteCredential {
            url,
            scheme,
            host,
            username,
            has_credential: has_password,
            level: level.to_string(),
            note,
        })
    })
}

// ---------- 用当前身份重写 HEAD 提交的作者（amend） ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AmendResult {
    old_author: String,
    new_author: String,
    old_oid: String,
    new_oid: String,
    /// 原提交是否就是上游 ref 指向的那一条（= 已经推上去了）。
    /// true 表示本地与远端马上要分叉，下次 push 会被拒（得 force）—— 前端据此警告。
    already_pushed: bool,
}

/// 重写 HEAD 提交的作者，用当前生效的提交身份（等价 `git commit --amend --author="..."`）。
///
/// 三处刻意的选择：
///   · **保留原 author 时间**：只换名字/邮箱，作者的时间线不动。对应 `--author=`，
///     而不是 `--reset-author`（后者会把作者时间改成现在，等于篡改历史时间）。
///   · **tree 传 None 保持不动**（也不读 index）：所以暂存区里那些还没提交的改动绝不会被
///     卷进这次改写 —— 原生 `git commit --amend` 会卷进去，那对「只改作者」是意外行为。
///   · committer 换成当前身份 + 当前时间：这是 amend 的正常语义（"这次是我改的"）。
///
/// 只对 HEAD 生效：amend 的本质就是替换 HEAD；改历史中间某条得走 rebase，不在这个入口的职责里。
#[tauri::command]
fn amend_head_author(state: tauri::State<AppState>) -> Result<AmendResult, String> {
    with_repo!(state, repo, {
        let head = repo.head().map_err(to_err)?;
        if !head.is_branch() {
            return Err("当前不在任何分支上（分离 HEAD），无法重写作者".to_string());
        }
        let commit = head.peel_to_commit().map_err(to_err)?;

        let sig = repo.signature().map_err(|e| {
            format!("读不到当前提交身份（user.name / user.email）：{e}\n先在顶栏的身份徽标里配置")
        })?;
        let author_name = sig.name().unwrap_or_default().to_string();
        let author_email = sig.email().unwrap_or_default().to_string();
        if author_name.is_empty() || author_email.is_empty() {
            return Err("当前提交身份不完整（user.name / user.email 有空值）".to_string());
        }

        let old_name = commit.author().name().unwrap_or_default().to_string();
        let old_email = commit.author().email().unwrap_or_default().to_string();
        let old_author = format!("{old_name} <{old_email}>");
        let new_author = format!("{author_name} <{author_email}>");
        if old_author == new_author {
            return Err(format!("HEAD 的作者已经是 {new_author}，无需重写"));
        }

        // 新 author = 当前身份的名字/邮箱 + **原提交的 author 时间**
        let author_time = commit.author().when();
        let author = git2::Signature::new(&author_name, &author_email, &author_time).map_err(to_err)?;

        let old_oid = commit.id();

        // 判定「是否已经推上去」：拿当前分支上游 ref 的 oid 直接和 HEAD 比。
        // 比的是"上游 tip 是否就是这条"——正好是「改完会和远端分叉」的那种情形。
        let already_pushed = repo
            .head()
            .ok()
            .filter(|h| h.is_branch())
            .and_then(|h| h.shorthand().map(str::to_string))
            .and_then(|n| repo.find_branch(&n, BranchType::Local).ok())
            .and_then(|b| b.upstream().ok())
            .and_then(|u| u.get().target())
            == Some(old_oid);

        // git_commit_amend：新提交与旧提交「只有非 None 的项被替换」，parents 自动沿用旧提交。
        //   · author 传新签名 → 换掉名字/邮箱（时间用上面构造的，保持原样）
        //   · committer 传当前签名 → amend 的正常语义
        //   · message_encoding / message / tree 传 None → **原样不动**。
        //     特别是 tree：不传就不会把暂存区里那些还没提交的改动卷进来。
        //
        // ⚠️ 别用 repo.commit(Some("HEAD"), ...) 来做 amend：libgit2 会校验
        //    「新提交的第一个 parent 必须是当前 ref 的 tip」，而 amend 的第一个 parent
        //    恰恰是**旧提交的父**，必然报 "current tip is not the first parent"
        //    （探针实测踩出来的，不是推测）。
        let new_oid = commit
            .amend(Some("HEAD"), Some(&author), Some(&sig), None, None, None)
            .map_err(to_err)?;

        Ok(AmendResult {
            old_author,
            new_author,
            old_oid: old_oid.to_string(),
            new_oid: new_oid.to_string(),
            already_pushed,
        })
    })
}

#[tauri::command]
fn get_recent(app: tauri::AppHandle) -> Vec<RecentEntry> {
    // 返回前按当前磁盘情况计算 exists —— 文件被移动/删除后再次打开 UI 会有直观显示，
    // 注意这里只 inspect 路径是否存在，不会去 find_commit（避免对有问题的仓库报红）。
    let mut list = read_recent(&app);
    for e in &mut list {
        e.exists = std::path::Path::new(&e.path).exists();
    }
    list.sort_by(|a, b| b.last_opened.cmp(&a.last_opened));
    list
}

#[tauri::command]
fn add_recent(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let name = std::path::Path::new(&path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let mut list = read_recent(&app);
    // dedupe（同路径移除旧条目），新条目推到首位
    list.retain(|e| !e.path.eq_ignore_ascii_case(&path));
    list.insert(
        0,
        RecentEntry {
            path,
            name,
            last_opened: now,
            exists: true, // 刚打开必存在
        },
    );
    list.truncate(RECENT_LIMIT);
    write_recent(&app, &list)
}

#[tauri::command]
fn remove_recent(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let mut list = read_recent(&app);
    list.retain(|e| !e.path.eq_ignore_ascii_case(&path));
    write_recent(&app, &list)
}

/// 在 Windows 资源管理器中打开路径。
/// 目录：直接进入该目录（explorer <dir>）；文件：打开所在目录并选中它（/select）。
/// 注意不能用 /select 打开目录——那会停在父目录只做高亮，用户会以为"没打开"。
/// explorer 是"软失败"型进程（exit code 不可靠），用 spawn 即可。
#[tauri::command]
fn reveal_in_explorer(path: String) -> Result<(), String> {
    use std::path::Path;
    // explorer.exe 把 "/" 视为开关前缀（/select 等），正斜杠路径会被当成无效参数，
    // 静默退化为打开默认文件夹（文档）——必须先把分隔符统一成反斜杠。
    let path = path.replace('/', "\\");
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("路径不存在: {path}"));
    }
    let arg = if p.is_file() {
        format!("/select,{}", p.display())
    } else {
        p.display().to_string()
    };
    std::process::Command::new("explorer")
        .arg(arg)
        .spawn()
        .map_err(|e| format!("无法启动 explorer: {e}"))?;
    Ok(())
}

#[tauri::command]
fn stage_all(state: tauri::State<AppState>) -> Result<usize, String> {
    with_repo!(state, repo, {
        let mut index = repo.index().map_err(to_err)?;
        index
            .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
            .map_err(to_err)?;
        index.write().map_err(to_err)?;
        Ok(index.len())
    })
}

#[tauri::command]
fn commit(state: tauri::State<AppState>, message: String) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("提交信息不能为空".to_string());
    }
    with_repo!(state, repo, {
        let sig = repo.signature().map_err(to_err)?;
        let mut index = repo.index().map_err(to_err)?;
        let tree_oid = index.write_tree().map_err(to_err)?;
        let tree = repo.find_tree(tree_oid).map_err(to_err)?;

        // 父提交集合：正常提交 = [HEAD]；根提交 = []。
        // merge 进行中（.git/MERGE_HEAD 存在）→ 追加第二父，提交完成后清理合并状态，
        // 等价于 git commit 收尾一次 merge。
        let mut parents = Vec::new();
        if let Some(c) = repo.head().ok().and_then(|h| h.peel_to_commit().ok()) {
            parents.push(c);
        }
        let mut merging = false;
        if let Ok(text) = std::fs::read_to_string(repo.path().join("MERGE_HEAD")) {
            if let Ok(oid) = Oid::from_str(text.trim()) {
                if let Ok(c) = repo.find_commit(oid) {
                    parents.push(c);
                    merging = true;
                }
            }
        }
        let parent_refs: Vec<&git2::Commit> = parents.iter().collect();

        let oid = repo
            .commit(Some("HEAD"), &sig, &sig, &message, &tree, &parent_refs)
            .map_err(to_err)?;
        if merging {
            repo.cleanup_state().map_err(to_err)?;
        }
        Ok(oid.to_string())
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            repo: Mutex::new(None),
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            open_repo,
            list_branches,
            get_log,
            get_commit_files,
            get_diff,
            read_file_content,
            write_file_content,
            get_workdir_diff,
            get_head_tree,
            get_status,
            get_conflicts,
            get_conflict_sides,
            abort_merge,
            checkout_branch,
            checkout_preview,
            create_branch,
            delete_branch,
            rename_branch,
            list_remotes,
            set_branch_upstream,
            stage_all,
            stage_files,
            discard_file_changes,
            discard_paths_to_head,
            get_skip_list,
            set_skip,
            commit,
            get_recent,
            add_recent,
            remove_recent,
            reveal_in_explorer,
            close_repo,
            git_remote_op,
            get_ahead_behind,
            get_remote_url,
            set_remote_url,
            get_identity,
            set_identity,
            clear_local_identity,
            get_remote_credential,
            amend_head_author,
            stash_list,
            stash_save,
            stash_pop,
            stash_apply,
            stash_drop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ---------- 冲突处理逻辑单测（真实构造 merge 冲突仓库） ----------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) -> std::process::Output {
        Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .expect("git 不可用")
    }

    /// 运行预期成功的 git 命令
    fn git_ok(dir: &Path, args: &[&str]) {
        let out = git(dir, args);
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// 运行允许失败（如制造 merge 冲突）的 git 命令
    fn git_may(dir: &Path, args: &[&str]) {
        let _ = git(dir, args);
    }

    fn write(dir: &Path, name: &str, content: &str) {
        std::fs::write(dir.join(name), content).unwrap();
    }

    /// 建一个冲突仓库并返回其目录（调用方负责删除；tag 用于并行测试下隔离目录）
    fn make_conflict_repo(tag: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "gitmanage-test-{}-{}",
            std::process::id(),
            tag
        ));
        let _ = std::fs::remove_dir_all(&base);
        let dir = base.join("repo");
        std::fs::create_dir_all(&dir).unwrap();

        git_ok(&dir, &["init", "-b", "main"]);
        git_ok(&dir, &["config", "user.email", "t@t"]);
        git_ok(&dir, &["config", "user.name", "t"]);
        write(&dir, "f.txt", "1\n2\n3\n4\n");
        git_ok(&dir, &["add", "."]);
        git_ok(&dir, &["commit", "-m", "base"]);

        // feature 分支把第 2 行改成 F
        git_ok(&dir, &["checkout", "-b", "feature"]);
        write(&dir, "f.txt", "1\nF\n3\n4\n");
        git_ok(&dir, &["add", "."]);
        git_ok(&dir, &["commit", "-m", "feat"]);

        // main 把第 2 行改成 M —— 与 feature 冲突
        git_ok(&dir, &["checkout", "main"]);
        write(&dir, "f.txt", "1\nM\n3\n4\n");
        git_ok(&dir, &["add", "."]);
        git_ok(&dir, &["commit", "-m", "main-change"]);
        git_may(&dir, &["merge", "feature"]); // 必然冲突，git 返回非 0

        dir
    }

    #[test]
    fn detect_conflicts_and_read_sides() {
        let dir = make_conflict_repo("detect");
        let repo = Repository::open(&dir).unwrap();

        // 仓库应处于 Merge 状态且 index 有冲突
        assert_eq!(repo.state(), RepositoryState::Merge);
        let items = index_conflicts(&repo).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].0, "f.txt");
        assert!(items[0].1.is_some() && items[0].2.is_some() && items[0].3.is_some());

        // sides：base=祖先内容、ours=本地 main 的 M、theirs=feature 的 F
        let sides = conflict_sides_for(&repo, "f.txt").unwrap().unwrap();
        assert_eq!(sides.base.as_deref(), Some("1\n2\n3\n4\n"));
        assert_eq!(sides.ours.as_deref(), Some("1\nM\n3\n4\n"));
        assert_eq!(sides.theirs.as_deref(), Some("1\nF\n3\n4\n"));

        // 磁盘文件应带冲突标记（模拟 MergePanel 读取的输入）
        let disk = std::fs::read_to_string(dir.join("f.txt")).unwrap();
        assert!(disk.contains("<<<<<<<"), "磁盘应有冲突标记");
        assert!(disk.contains(">>>>>>>"));

        // 不存在的 path 返回 None
        assert!(conflict_sides_for(&repo, "nope.txt").unwrap().is_none());
        drop(repo);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_and_abort() {
        let dir = make_conflict_repo("resolve");

        // 方式一：git add = 标记解决（等价前端「标记已解决」的 stage_files）
        git_ok(&dir, &["add", "f.txt"]);
        {
            let repo = Repository::open(&dir).unwrap();
            assert!(index_conflicts(&repo).unwrap().is_empty());
            assert_eq!(repo.state(), RepositoryState::Merge);
        }

        // 方式二：abort 回滚到冲突前
        git_ok(&dir, &["merge", "--abort"]);
        {
            let repo = Repository::open(&dir).unwrap();
            assert_eq!(repo.state(), RepositoryState::Clean);
            assert!(index_conflicts(&repo).unwrap().is_empty());
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 建一个「远程分支已存在、但本地故意没绑定」的仓库，返回 work 目录。
    /// push 时不带 -u，正好复现用户遇到的状态。
    fn make_repo_with_remote(tag: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "gitmanage-upstream-{}-{}",
            std::process::id(),
            tag
        ));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let remote = base.join("remote.git");
        let dir = base.join("work");

        git_ok(&base, &["init", "--bare", "-b", "main", remote.to_str().unwrap()]);
        std::fs::create_dir_all(&dir).unwrap();
        git_ok(&dir, &["init", "-b", "main"]);
        git_ok(&dir, &["config", "user.email", "t@t"]);
        git_ok(&dir, &["config", "user.name", "t"]);
        write(&dir, "a.txt", "1\n");
        git_ok(&dir, &["add", "."]);
        git_ok(&dir, &["commit", "-m", "base"]);
        git_ok(&dir, &["remote", "add", "origin", remote.to_str().unwrap()]);
        git_ok(&dir, &["push", "origin", "main"]); // 不带 -u
        dir
    }

    fn cfg_text(dir: &Path) -> String {
        std::fs::read_to_string(dir.join(".git/config")).unwrap()
    }

    #[test]
    fn bind_and_unbind_upstream() {
        let dir = make_repo_with_remote("bind");

        {
            let repo = Repository::open(&dir).unwrap();
            let main = repo.find_branch("main", BranchType::Local).unwrap();

            // 前置：push 没带 -u → 此刻没有上游
            assert!(main.upstream().is_err(), "不该有 upstream");

            // 绑定 = 只写配置
            let msg = set_upstream_impl(&repo, "main", Some("origin/main")).unwrap();
            assert!(msg.contains("origin/main"), "回执要带上游名：{msg}");
            let cfg = cfg_text(&dir);
            assert!(cfg.contains("remote = origin"), "config 应有 remote：{cfg}");
            assert!(cfg.contains("merge = refs/heads/main"), "config 应有 merge：{cfg}");

            // 解绑：两条都清掉
            set_upstream_impl(&repo, "main", None).unwrap();
            let main = repo.find_branch("main", BranchType::Local).unwrap();
            assert!(main.upstream().is_err(), "解绑后不该有 upstream");
            let cfg = cfg_text(&dir);
            assert!(!cfg.contains("merge = refs/heads/main"), "解绑后 merge 应消失：{cfg}");
        }

        // 本地名 ≠ 远程名：git CLI 先建分支（Windows 上 git2 句柄要先释放）
        git_ok(&dir, &["branch", "feature/login"]);
        {
            let repo = Repository::open(&dir).unwrap();
            set_upstream_impl(&repo, "feature/login", Some("origin/main")).unwrap();
            // merge 指向的是远程那个名字，不是本地名 —— 这正是名字不同时的关键
            let cfg = cfg_text(&dir);
            assert!(cfg.contains("merge = refs/heads/main"), "merge 应跟远程名：{cfg}");
            let b = repo.find_branch("feature/login", BranchType::Local).unwrap();
            assert_eq!(b.upstream().unwrap().name().unwrap(), Some("origin/main"));

            // 上游 ref 不存在 → 报错要能照着做
            let err = set_upstream_impl(&repo, "feature/login", Some("origin/nope")).unwrap_err();
            assert!(err.contains("fetch"), "错误提示应引导先 fetch：{err}");
        }

        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
    }

    /// 从远程跟踪分支建本地分支（等价 git checkout -b <name> --track origin/<x>）。
    /// 这是「点击远程分支 = 检出为本地分支」的后端路径。
    #[test]
    fn create_branch_from_remote() {
        let dir = make_repo_with_remote("fromremote");

        {
            let repo = Repository::open(&dir).unwrap();

            // 1) 指定起点 + 跟踪，但不切换：HEAD 仍留在 main
            create_branch_impl(&repo, "feat", false, Some("origin/main"), true).unwrap();
            let tip = repo
                .find_branch("feat", BranchType::Local)
                .unwrap()
                .get()
                .target()
                .unwrap();
            let remote_tip = repo
                .find_branch("origin/main", BranchType::Remote)
                .unwrap()
                .get()
                .target()
                .unwrap();
            assert_eq!(tip, remote_tip, "起点应为 origin/main");
            assert_eq!(
                repo.head().unwrap().shorthand(),
                Some("main"),
                "checkout=false 不该切走 HEAD"
            );
            assert_eq!(
                repo.find_branch("feat", BranchType::Local)
                    .unwrap()
                    .upstream()
                    .unwrap()
                    .name()
                    .unwrap(),
                Some("origin/main"),
                "track=true 应建立跟踪关系"
            );

            // 2) checkout=true 会切过去
            create_branch_impl(&repo, "feat2", true, Some("origin/main"), true).unwrap();
            assert_eq!(repo.head().unwrap().shorthand(), Some("feat2"));

            // 3) 重名：提前拒绝
            let err =
                create_branch_impl(&repo, "feat", false, Some("origin/main"), true).unwrap_err();
            assert!(err.contains("已存在"), "重名提示：{err}");

            // 4) track 但没给起点
            let err = create_branch_impl(&repo, "feat3", false, None, true).unwrap_err();
            assert!(err.contains("from"), "缺起点提示：{err}");

            // 5) from 不是远程跟踪分支 → 引导 fetch，且**不留半成品分支**
            let err =
                create_branch_impl(&repo, "feat4", false, Some("origin/nope"), true).unwrap_err();
            assert!(err.contains("fetch"), "该引导 fetch：{err}");
            assert!(
                repo.find_branch("feat4", BranchType::Local).is_err(),
                "校验失败时不该建出分支"
            );

            // 6) 不带 track 时传远程起点也允许（纯建分支，不建立跟踪）
            create_branch_impl(&repo, "feat5", false, Some("origin/main"), false).unwrap();
            assert!(repo
                .find_branch("feat5", BranchType::Local)
                .unwrap()
                .upstream()
                .is_err());
        }

        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
    }
}
