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

use git2::{BranchType, DiffFormat, ObjectType, Oid, Repository, Sort, TreeWalkResult};
use serde::{Deserialize, Serialize};
use tauri::Manager; // AppHandle::path() 来自这个 trait
use std::collections::HashMap;
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

/// 从 state 取仓库，处理锁 + None 两种情况，减少每个命令的样板代码
macro_rules! with_repo {
    ($state:expr, $repo:ident, $body:block) => {{
        let guard = $state.repo.lock().map_err(to_err)?;
        let $repo = guard.as_ref().ok_or("尚未打开仓库")?;
        $body
    }};
}

// ---------- Tauri 命令 ----------

#[tauri::command]
fn open_repo(state: tauri::State<AppState>, path: String) -> Result<RepoSummary, String> {
    // discover 会沿目录向上逐级找 .git，因此选中仓库的子目录也能打开；
    // 找不到再退回严格 open，两者都失败才报错
    let repo = Repository::discover(&path).or_else(|_| Repository::open(&path)).map_err(|_| {
        format!("在 {path} 及其父目录中没有找到 Git 仓库")
    })?;

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

        let mut revwalk = repo.revwalk().map_err(to_err)?;
        // 分支过滤：None / "HEAD" / "" 视为当前 HEAD；其余按 ref 名解析
        match branch.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            None | Some("HEAD") => revwalk.push_head().map_err(to_err)?,
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

#[tauri::command]
fn get_diff(state: tauri::State<AppState>, oid: String) -> Result<String, String> {
    with_repo!(state, repo, {
        let diff = commit_diff(repo, &oid)?;
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
            let path = entry.path().unwrap_or("?").to_string();
            let s = entry.status();
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

// ---------- 分支操作 ----------

#[tauri::command]
fn checkout_branch(state: tauri::State<AppState>, name: String) -> Result<(), String> {
    with_repo!(state, repo, {
        let (obj, reference) = repo.revparse_ext(&name).map_err(to_err)?;
        repo.checkout_tree(&obj, None).map_err(to_err)?;
        match reference {
            Some(r) => repo
                .set_head(r.name().ok_or("invalid ref name")?)
                .map_err(to_err),
            None => repo.set_head_detached(obj.id()).map_err(to_err),
        }
    })
}

#[tauri::command]
fn create_branch(
    state: tauri::State<AppState>,
    name: String,
    checkout: bool,
) -> Result<(), String> {
    with_repo!(state, repo, {
        let head = repo.head().map_err(to_err)?.peel_to_commit().map_err(to_err)?;
        repo.branch(&name, &head, false).map_err(to_err)?;
        if checkout {
            let obj = repo.revparse_single(&format!("refs/heads/{name}")).map_err(to_err)?;
            repo.checkout_tree(&obj, None).map_err(to_err)?;
            repo.set_head(&format!("refs/heads/{name}")).map_err(to_err)?;
        }
        Ok(())
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

// ---------- 暂存与提交 ----------

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

        let mut args = vec![op.clone(), remote_name];
        if let Some(b) = branch_name {
            args.push(b);
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
            let hint = if combined.contains("could not read Username")
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

#[tauri::command]
fn get_recent(app: tauri::AppHandle) -> Vec<RecentEntry> {
    let mut list = read_recent(&app);
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

        // 有 HEAD 则以 HEAD 为父提交，否则为根提交
        let parents = match repo.head().ok().and_then(|h| h.peel_to_commit().ok()) {
            Some(c) => vec![c],
            None => vec![],
        };
        let parent_refs: Vec<&git2::Commit> = parents.iter().collect();

        let oid = repo
            .commit(Some("HEAD"), &sig, &sig, &message, &tree, &parent_refs)
            .map_err(to_err)?;
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
            get_head_tree,
            get_status,
            checkout_branch,
            create_branch,
            delete_branch,
            stage_all,
            commit,
            get_recent,
            add_recent,
            remove_recent,
            git_remote_op,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
