import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

// ---------- 类型（对应 Rust 侧的 serde camelCase） ----------

interface RepoSummary {
  path: string;
  name: string;
  currentBranch?: string;
  isEmpty: boolean;
  headCommit?: string;
}

interface BranchInfo {
  name: string;
  isHead: boolean;
  isRemote: boolean;
  upstream?: string;
  commit: string;
}

interface CommitInfo {
  oid: string;
  short: string;
  summary: string;
  author: string;
  email: string;
  time: number;
  parents: string[];
  refs: string[];
}

interface FileChange {
  path: string;
  status: string;
  oldPath?: string;
}

interface StatusItem {
  path: string;
  status: string;
}

// ---------- 文件树工具：平铺路径 → 嵌套树 ----------

interface TreeNode {
  name: string;
  path: string;
  children: TreeNode[];
  isFile: boolean;
}

function buildTree(paths: string[]): TreeNode[] {
  const root: TreeNode[] = [];
  for (const p of paths) {
    const parts = p.split("/");
    let level = root;
    let acc = "";
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      acc = acc ? `${acc}/${name}` : name;
      let node = level.find((n) => n.name === name);
      if (!node) {
        node = { name, path: acc, children: [], isFile: i === parts.length - 1 };
        level.push(node);
      }
      level = node.children;
    }
  }
  return root;
}

function FileTreeView({ nodes, depth = 0 }: { nodes: TreeNode[]; depth?: number }) {
  return (
    <ul className="file-tree" style={{ paddingLeft: depth === 0 ? 0 : 14 }}>
      {nodes.map((n) => (
        <li key={n.path}>
          <span className={`tree-label ${n.isFile ? "file" : "dir"}`}>
            <span className={`tree-icon ${n.isFile ? "file" : "dir"}`}>
              {n.isFile ? "📄" : "📁"}
            </span>
            {n.name}
          </span>
          {n.children.length > 0 && <FileTreeView nodes={n.children} depth={depth + 1} />}
        </li>
      ))}
    </ul>
  );
}

// ---------- diff 渲染 ----------

function DiffView({ text }: { text: string }) {
  if (!text) return <div className="empty-hint">选择左侧提交查看改动</div>;
  return (
    <pre className="diff-pre">
      {text.split("\n").map((line, i) => {
        let cls = "diff-line";
        if (line.startsWith("===")) cls += " diff-file";
        else if (line.startsWith("+")) cls += " diff-add";
        else if (line.startsWith("-")) cls += " diff-del";
        else if (line.startsWith("@@")) cls += " diff-hunk";
        return (
          <div key={i} className={cls}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

// ---------- 状态徽标 ----------

const STATUS_LABEL: Record<string, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  typechange: "T",
  other: "?",
};

// ---------- 主组件 ----------

function App() {
  const [repoPath, setRepoPath] = useState("");
  const [repo, setRepo] = useState<RepoSummary | null>(null);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [tree, setTree] = useState<string[]>([]);
  const [status, setStatus] = useState<StatusItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [files, setFiles] = useState<FileChange[]>([]);
  const [diff, setDiff] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!repo) return;
    try {
      const [bs, log, t, st] = await Promise.all([
        invoke<BranchInfo[]>("list_branches"),
        invoke<CommitInfo[]>("get_log", { limit: 200 }),
        invoke<string[]>("get_head_tree"),
        invoke<StatusItem[]>("get_status"),
      ]);
      setBranches(bs);
      setCommits(log);
      setTree(t);
      setStatus(st);
    } catch (e) {
      setError(String(e));
    }
  }, [repo]);

  async function openRepo(pathOverride?: string) {
    const path = (pathOverride ?? repoPath).trim();
    if (!path) return;
    setLoading(true);
    setError("");
    try {
      const summary = await invoke<RepoSummary>("open_repo", { path });
      setRepo(summary);
      setRepoPath(path);
      setSelected(null);
      setFiles([]);
      setDiff("");
    } catch (e) {
      setError(String(e));
      setRepo(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!selected) return;
    (async () => {
      try {
        const [fs, d] = await Promise.all([
          invoke<FileChange[]>("get_commit_files", { oid: selected }),
          invoke<string>("get_diff", { oid: selected }),
        ]);
        setFiles(fs);
        setDiff(d);
      } catch (e) {
        setError(String(e));
      }
    })();
  }, [selected]);

  const localBranches = branches.filter((b) => !b.isRemote);
  const remoteBranches = branches.filter((b) => b.isRemote);
  const current = branches.find((b) => b.isHead);

  return (
    <div className="app">
      {/* 顶部栏 */}
      <header className="topbar">
        <span className="logo">GitManage</span>
        <input
          className="repo-input"
          placeholder="仓库路径，如 C:\Users\you\code\project"
          value={repoPath}
          onChange={(e) => setRepoPath(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && openRepo()}
        />
        <button onClick={() => openRepo()} disabled={loading}>
          {loading ? "打开中…" : "打开仓库"}
        </button>
        {repo && (
          <button className="ghost" onClick={refresh}>
            刷新
          </button>
        )}
        {current && (
          <span className="head-badge" title={current.commit}>
            ⎇ {current.name}
          </span>
        )}
      </header>

      {error && <div className="error-bar">⚠ {error}</div>}

      {!repo ? (
        <div className="welcome">
          <h2>输入仓库路径开始</h2>
          <p>
            例如：打开本项目自身试试 —
            <button className="link" onClick={() => openRepo("C:\\Users\\guohj\\code\\gitmanage")}>
              C:\Users\guohj\code\gitmanage
            </button>
          </p>
        </div>
      ) : (
        <div className="main">
          {/* 左栏：文件树 + 工作区状态 */}
          <aside className="pane left">
            <div className="pane-title">项目 · {repo.name}</div>
            <div className="pane-body">
              {repo.isEmpty ? (
                <div className="empty-hint">空仓库（尚无提交）</div>
              ) : (
                <FileTreeView nodes={buildTree(tree)} />
              )}
            </div>
            <div className="pane-title">更改（{status.length}）</div>
            <div className="pane-body status-list">
              {status.length === 0 && <div className="empty-hint">工作区干净</div>}
              {status.map((s) => (
                <div key={s.path} className="status-item" title={s.path}>
                  <span className={`status-badge st-${s.status}`}>
                    {STATUS_LABEL[s.status] ?? "?"}
                  </span>
                  {s.path}
                </div>
              ))}
            </div>
          </aside>

          {/* 中栏：分支 + 提交历史 */}
          <section className="pane center">
            <div className="branch-row">
              {localBranches.map((b) => (
                <span key={b.name} className={`branch-chip local ${b.isHead ? "current" : ""}`}>
                  ⎇ {b.name}
                </span>
              ))}
              {remoteBranches.map((b) => (
                <span key={b.name} className="branch-chip remote">
                  ☁ {b.name}
                </span>
              ))}
            </div>
            <div className="pane-title">提交历史（{commits.length}）</div>
            <div className="pane-body commit-list">
              {commits.map((c) => (
                <div
                  key={c.oid}
                  className={`commit-item ${selected === c.oid ? "selected" : ""}`}
                  onClick={() => setSelected(c.oid)}
                >
                  <div className="commit-summary">
                    <span className="hash">{c.short}</span>
                    {c.refs.map((r) => (
                      <span key={r} className={`ref-chip ${r.includes("/") ? "remote" : "local"}`}>
                        {r}
                      </span>
                    ))}
                    <span className="summary-text" title={c.summary}>
                      {c.summary}
                    </span>
                  </div>
                  <div className="commit-meta">
                    {c.author} · {new Date(c.time * 1000).toLocaleString("zh-CN")}
                    {c.parents.length > 1 && <span className="merge-tag">merge</span>}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* 右栏：文件变更 + diff */}
          <section className="pane right">
            <div className="pane-title">
              改动文件（{files.length}）
            </div>
            <div className="pane-body change-list">
              {files.map((f) => (
                <div key={f.path} className="status-item" title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
                  <span className={`status-badge st-${f.status}`}>
                    {STATUS_LABEL[f.status] ?? "?"}
                  </span>
                  {f.path}
                </div>
              ))}
              {selected && files.length === 0 && <div className="empty-hint">无文件改动</div>}
            </div>
            <div className="pane-title">差异</div>
            <div className="pane-body diff-body">
              <DiffView text={diff} />
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

export default App;
