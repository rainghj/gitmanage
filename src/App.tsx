import { useState, useEffect, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
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

// ---------- 分支图（lane 计算 + SVG 渲染） ----------
//
// 算法：维护 lanes 数组，lanes[i] 表示第 i 条泳道下一个预期出现的 commit oid。
// 遍历提交（后端已按时间拓扑序返回）：
//   - 若当前 commit 已在某条泳道上 → 沿用该泳道
//   - 否则占一条空泳道（没有就新开一条）
//   - 第一父提交接管当前泳道；merge 的其他父提交另开泳道（这就是分叉/汇合的来源）

interface GraphRow {
  lane: number; // 本行 commit 所在泳道
  occupied: boolean[]; // 本行有哪些泳道有竖线穿过
  mergeLane: number | null; // merge 提交第二父所在泳道（画汇合曲线用）
  isMerge: boolean;
}

const GRAPH_LANE_W = 14; // 每条泳道宽度
const GRAPH_ROW_H = 46; // 行高，需与 CSS .commit-item 的高度一致
const LANE_COLORS = ["#569cd6", "#4ec9b0", "#d7ba7d", "#ce9178", "#b5cea8", "#9cdcfe"];

function computeGraph(commits: CommitInfo[]): { rows: GraphRow[]; laneCount: number } {
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = commits.map((c) => {
    let idx = lanes.indexOf(c.oid);
    if (idx === -1) {
      const free = lanes.indexOf(null);
      if (free === -1) {
        idx = lanes.length;
        lanes.push(null);
      } else {
        idx = free;
      }
    }
    // 快照：本行有竖线穿过的泳道
    const occupied = lanes.map((o) => o !== null);

    // merge：第二父提交另开一条泳道
    let mergeLane: number | null = null;
    if (c.parents.length > 1) {
      const free = lanes.indexOf(null);
      mergeLane = free === -1 ? lanes.length : free;
      if (free === -1) lanes.push(null);
      lanes[mergeLane] = c.parents[1];
      occupied[mergeLane] = true;
    }

    // 第一父接管当前泳道
    lanes[idx] = c.parents[0] ?? null;
    return { lane: idx, occupied, mergeLane, isMerge: c.parents.length > 1 };
  });

  const laneCount = Math.max(1, ...rows.map((r) => Math.max(r.occupied.length, r.lane + 1)));
  return { rows, laneCount };
}

function CommitGraph({ row, laneCount, isLast }: { row: GraphRow; laneCount: number; isLast: boolean }) {
  const w = laneCount * GRAPH_LANE_W;
  const x = (i: number) => i * GRAPH_LANE_W + GRAPH_LANE_W / 2;
  const midY = GRAPH_ROW_H / 2;
  const color = LANE_COLORS[row.lane % LANE_COLORS.length];

  return (
    <svg className="commit-graph" width={w} height={GRAPH_ROW_H} viewBox={`0 0 ${w} ${GRAPH_ROW_H}`}>
      {/* 竖线：穿过本行的每条泳道 */}
      {row.occupied.map((on, i) =>
        on ? (
          <line
            key={i}
            x1={x(i)}
            y1={0}
            x2={x(i)}
            y2={isLast ? midY : GRAPH_ROW_H}
            stroke={LANE_COLORS[i % LANE_COLORS.length]}
            strokeWidth={2}
          />
        ) : null
      )}
      {/* merge 汇合曲线：从本行圆心绕到第二父泳道 */}
      {row.mergeLane !== null && (
        <path
          d={`M ${x(row.lane)} ${midY} C ${x(row.lane)} ${GRAPH_ROW_H}, ${x(row.mergeLane)} ${midY}, ${x(row.mergeLane)} ${GRAPH_ROW_H}`}
          fill="none"
          stroke={LANE_COLORS[row.mergeLane % LANE_COLORS.length]}
          strokeWidth={2}
        />
      )}
      {/* 本行提交节点 */}
      <circle cx={x(row.lane)} cy={midY} r={4} fill={color} stroke="#1e1e1e" strokeWidth={1.5} />
    </svg>
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
  const [commitMsg, setCommitMsg] = useState("");

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
      // 回填真实仓库根：选中子目录时 Rust 侧会向上找到 .git，输入框显示实际根目录
      setRepoPath(summary.path);
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

  // 弹出系统文件夹选择器，选中后直接打开该仓库
  async function browseFolder() {
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath: repoPath || undefined,
      title: "选择 Git 仓库目录",
    });
    if (!selected) return; // 用户取消
    const path = Array.isArray(selected) ? selected[0] : selected;
    if (path) await openRepo(path);
  }

  useEffect(() => {
    refresh();
  }, [refresh]);

  // ---------- 分支 / 提交操作 ----------

  async function checkoutBranch(name: string) {
    if (!confirm(`切换到分支 ${name}？`)) return;
    try {
      await invoke("checkout_branch", { name });
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  async function createBranch() {
    const name = window.prompt("新分支名（基于当前 HEAD 创建并切换）：");
    if (!name?.trim()) return;
    try {
      await invoke("create_branch", { name: name.trim(), checkout: true });
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  async function deleteBranch(name: string) {
    if (!confirm(`删除分支 ${name}？未合并的分支会被拒绝。`)) return;
    try {
      await invoke("delete_branch", { name, force: false });
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  async function doCommit() {
    if (!commitMsg.trim()) return;
    try {
      await invoke("stage_all");
      await invoke("commit", { message: commitMsg });
      setCommitMsg("");
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

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

  const { rows: graphRows, laneCount } = useMemo(() => computeGraph(commits), [commits]);
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
          placeholder="仓库路径，或直接点「浏览…」选择（支持选中仓库内任意子目录）"
          value={repoPath}
          onChange={(e) => setRepoPath(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && openRepo()}
        />
        <button className="ghost" onClick={browseFolder} disabled={loading} title="弹出文件夹选择器">
          浏览…
        </button>
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
            {status.length > 0 && (
              <div className="commit-box">
                <textarea
                  placeholder="提交信息…"
                  value={commitMsg}
                  onChange={(e) => setCommitMsg(e.currentTarget.value)}
                  rows={2}
                />
                <button onClick={doCommit} disabled={!commitMsg.trim()}>
                  提交（自动暂存全部）
                </button>
              </div>
            )}
          </aside>

          {/* 中栏：分支 + 提交历史 */}
          <section className="pane center">
            <div className="branch-row">
              {localBranches.map((b) => (
                <span
                  key={b.name}
                  className={`branch-chip local ${b.isHead ? "current" : "clickable"}`}
                  title={b.isHead ? "当前分支" : `点击切换到 ${b.name}`}
                  onClick={() => !b.isHead && checkoutBranch(b.name)}
                >
                  ⎇ {b.name}
                  {!b.isHead && (
                    <button
                      className="chip-x"
                      title="删除分支"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteBranch(b.name);
                      }}
                    >
                      ×
                    </button>
                  )}
                </span>
              ))}
              {remoteBranches.map((b) => (
                <span key={b.name} className="branch-chip remote">
                  ☁ {b.name}
                </span>
              ))}
              <button className="chip-add" title="基于 HEAD 新建分支并切换" onClick={createBranch}>
                ＋ 新分支
              </button>
            </div>
            <div className="pane-title">提交历史（{commits.length}）</div>
            <div className="pane-body commit-list">
              {commits.map((c, i) => (
                <div
                  key={c.oid}
                  className={`commit-item ${selected === c.oid ? "selected" : ""}`}
                  onClick={() => setSelected(c.oid)}
                >
                  <div className="commit-row">
                    <CommitGraph
                      row={graphRows[i]}
                      laneCount={laneCount}
                      isLast={i === commits.length - 1}
                    />
                    <div className="commit-content">
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
