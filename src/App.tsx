import { useState, useEffect, useCallback, useMemo, useRef, Component } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import "./App.css";

// ---------- 错误边界：渲染崩溃时显示错误内容，避免黑屏无从排查 ----------

export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: string | null }
> {
  state = { error: null as string | null };

  static getDerivedStateFromError(e: unknown) {
    return { error: String(e) };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="error-boundary">
          <h2>界面渲染出错</h2>
          <pre>{this.state.error}</pre>
          <button onClick={() => window.location.reload()}>重新加载</button>
        </div>
      );
    }
    return this.props.children;
  }
}

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

interface RecentEntry {
  path: string;
  name: string;
  lastOpened: number;
  exists: boolean;
}

interface StashEntry {
  index: number;
  message: string;
  oid: string;
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
  // VS Code/IDEA 风格：目录在前、文件在后，同级按名称排序（不区分大小写）
  const sortLevel = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    for (const n of nodes) sortLevel(n.children);
  };
  sortLevel(root);
  return root;
}

function FileTreeView({
  nodes,
  depth = 0,
  onFileClick,
}: {
  nodes: TreeNode[];
  depth?: number;
  onFileClick?: (path: string) => void;
}) {
  return (
    <ul className="file-tree" style={{ paddingLeft: depth === 0 ? 0 : 14 }}>
      {nodes.map((n) => (
        <TreeNodeRow key={n.path} node={n} depth={depth} onFileClick={onFileClick} />
      ))}
    </ul>
  );
}

// 单个树节点：目录自带折叠状态（默认展开，key=path 保证 refresh 后状态保留）
function TreeNodeRow({
  node: n,
  depth,
  onFileClick,
}: {
  node: TreeNode;
  depth: number;
  onFileClick?: (path: string) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <li>
      <span
        className={`tree-label ${n.isFile ? "file" : "dir"}`}
        onClick={() => (n.isFile ? onFileClick?.(n.path) : setOpen((o) => !o))}
        title={
          n.isFile ? `${n.path}（点击在中栏预览）` : `${n.path}（点击${open ? "折叠" : "展开"}）`
        }
      >
        <span className={`tree-icon ${n.isFile ? "file" : "dir"}`}>
          {n.isFile ? "📄" : open ? "▾ 📁" : "▸ 📁"}
        </span>
        {n.name}
      </span>
      {open && n.children.length > 0 && (
        <FileTreeView nodes={n.children} depth={depth + 1} onFileClick={onFileClick} />
      )}
    </li>
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
const GRAPH_ROW_H = 28; // 行高，需与 CSS .commit-item 的高度一致
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

// 从整段 commit diff 中抽出单个文件的部分（patch_to_string 用 === path === 做文件分隔行）
function extractFileDiff(full: string, path: string): string {
  const lines = full.split("\n");
  const out: string[] = [];
  let take = false;
  for (const line of lines) {
    const m = line.match(/^=== (.+) ===$/);
    if (m) take = m[1] === path;
    if (take) out.push(line);
  }
  return out.join("\n").trim();
}

function DiffView({ text, hint = "选择左侧提交查看改动" }: { text: string; hint?: string }) {
  if (!text) return <div className="empty-hint">{hint}</div>;
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

// ---------- 中栏标签页 ----------
//
// history 是固定首页签（提交历史，不可关闭）；file = 文件树预览；wdiff = 「更改」单文件对比。
// 内容按需加载并缓存到 tabData（key = kind:path），refresh 时整体失效重拉。

type CenterTab =
  | { kind: "history" }
  | { kind: "file"; path: string }
  | { kind: "wdiff"; path: string };

function tabKey(t: CenterTab): string {
  return t.kind === "history" ? "history" : `${t.kind}:${t.path}`;
}

function tabLabel(t: CenterTab): string {
  if (t.kind === "history") return "提交历史";
  const base = t.path.split("/").pop() ?? t.path;
  return t.kind === "wdiff" ? `对比 ${base}` : base;
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

// ---------- 通用小工具 ----------

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

// 把秒级时间戳转成"X分钟前 / X小时前 / 昨天 / YYYY-MM-DD"
function formatRelative(ts: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = Math.max(0, now - ts);
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 2) return "昨天";
  return new Date(ts * 1000).toLocaleDateString("zh-CN");
}

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
  // 右栏「改动文件」里选中的文件：非空时差异区只显示该文件的 diff，再点一次恢复全部
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [commitMsg, setCommitMsg] = useState("");
  const [filterBranch, setFilterBranch] = useState(""); // "" = 全部（HEAD）
  const [filterQuery, setFilterQuery] = useState("");
  const [recent, setRecent] = useState<RecentEntry[]>([]);
  const [stashes, setStashes] = useState<StashEntry[]>([]);
  const [consoleText, setConsoleText] = useState("");
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [opBusy, setOpBusy] = useState<string | null>(null); // 当前正在执行的远程操作
  const [pathMenuOpen, setPathMenuOpen] = useState(false); // 路径显示框（已开仓库时）点击弹出的统一菜单
  const [recentMenuIndex, setRecentMenuIndex] = useState(0); // 菜单里键盘高亮的那一项
  const pathMenuRef = useRef<HTMLDivElement>(null); // 包住显示框 + 菜单的容器
  const [leftTab, setLeftTab] = useState<"branches" | "files">("branches"); // 左栏顶部 tab：分支树 / 文件树
  const [remoteUrlOpen, setRemoteUrlOpen] = useState(false); // 中栏过滤条上的「设置远程」输入行
  const [remoteUrl, setRemoteUrl] = useState("");
  // [ahead, behind]：待 push / 待 pull 条数；null = 无上游（纯本地仓库）不显示角标
  const [syncCounts, setSyncCounts] = useState<[number, number] | null>(null);
  // 中栏标签页工作区
  const [tabs, setTabs] = useState<CenterTab[]>([{ kind: "history" }]);
  const [activeTab, setActiveTab] = useState(0);
  const [tabData, setTabData] = useState<Record<string, string>>({});
  // 文件标签的未保存草稿（key = tabKey）；与 tabData 分离，refresh 清缓存时草稿不丢
  const [tabDrafts, setTabDrafts] = useState<Record<string, string>>({});
  // 「不提交」列表（持久化在 .git/info/gitmanage-skip.json，后端读写）
  const [skipList, setSkipList] = useState<string[]>([]);
  // 更改列表里被取消勾选的文件（默认全部勾选，提交只提交勾选项）
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  // 更改/不提交列表项的右键菜单
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; path: string; inSkip: boolean } | null>(null);
  // 「放弃更改」的二次确认弹窗（值为待确认的文件路径）
  const [discardConfirm, setDiscardConfirm] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!repo) return;
    try {
      const [bs, log, t, st, s, ab, sk] = await Promise.all([
        invoke<BranchInfo[]>("list_branches"),
        invoke<CommitInfo[]>("get_log", {
          limit: 300,
          branch: filterBranch || null,
          query: filterQuery.trim() || null,
        }),
        invoke<string[]>("get_head_tree"),
        invoke<StatusItem[]>("get_status"),
        invoke<StashEntry[]>("stash_list"),
        invoke<[number, number] | null>("get_ahead_behind"),
        invoke<string[]>("get_skip_list"),
      ]);
      setBranches(bs);
      setCommits(log);
      setTree(t);
      setStatus(st);
      setStashes(s);
      setSyncCounts(ab);
      setSkipList(sk);
      // 已打开的文件/对比标签内容可能已过时，清空缓存让激活标签重拉
      setTabData({});
    } catch (e) {
      setError(String(e));
    }
  }, [repo, filterBranch, filterQuery]);

  // ---------- 中栏标签页 ----------

  function openCenterTab(kind: "file" | "wdiff", path: string) {
    // 焦点转到中栏标签页：取消提交历史的选中，右栏回到空提示，避免"右边还显示着旧提交"的困惑
    setSelected(null);
    const key = `${kind}:${path}`;
    const idx = tabs.findIndex((t) => tabKey(t) === key);
    if (idx >= 0) {
      setActiveTab(idx);
      return;
    }
    setTabs([...tabs, { kind, path }]);
    setActiveTab(tabs.length);
  }

  function closeTab(i: number) {
    if (tabs[i]?.kind === "history") return; // 首页签不可关闭
    const next = tabs.filter((_, j) => j !== i);
    setTabs(next);
    if (activeTab === i) {
      setActiveTab(Math.max(0, i - 1));
    } else if (activeTab > i) {
      setActiveTab(activeTab - 1);
    }
  }

  const activeT = tabs[activeTab] ?? tabs[0];
  const activeKey = activeT ? tabKey(activeT) : "history";
  // 文件标签的脏状态：草稿存在且与已加载内容不同
  const isDirty = (t: CenterTab) =>
    t.kind === "file" && tabDrafts[tabKey(t)] !== undefined && tabDrafts[tabKey(t)] !== tabData[tabKey(t)];

  async function saveFileTab(t: CenterTab) {
    if (t.kind !== "file") return;
    const key = tabKey(t);
    const content = tabDrafts[key];
    if (content === undefined) return;
    try {
      await invoke("write_file_content", { path: t.path, content });
      setTabData((m) => ({ ...m, [key]: content }));
      setTabDrafts((m) => {
        const n = { ...m };
        delete n[key];
        return n;
      });
      // 保存会影响「更改」列表，刷新一下
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  function discardFileTab(t: CenterTab) {
    if (t.kind !== "file") return;
    const key = tabKey(t);
    setTabDrafts((m) => {
      const n = { ...m };
      delete n[key];
      return n;
    });
  }

  // 激活的文件/对比标签按需加载内容（结果缓存进 tabData，refresh 时清空重拉）
  useEffect(() => {
    if (!activeT || activeT.kind === "history") return;
    if (tabData[activeKey] !== undefined) return;
    let dead = false;
    invoke<string>(activeT.kind === "file" ? "read_file_content" : "get_workdir_diff", {
      path: activeT.path,
    })
      .then((c) => {
        if (!dead) setTabData((m) => ({ ...m, [activeKey]: c }));
      })
      .catch((e) => {
        if (!dead) setTabData((m) => ({ ...m, [activeKey]: `加载失败：${String(e)}` }));
      });
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, tabData]);

// 打开仓库。路径一律显式传入（浏览…/最近列表/示例链接），输入框只做展示不承接输入
  async function openRepo(path: string) {
    path = path.trim();
    if (!path) return;
    setLoading(true);
    setError("");
    try {
      const summary = await invoke<RepoSummary>("open_repo", { path });
      setRepo(summary);
      // 回填真实仓库根：选中子目录时 Rust 侧会向上找到 .git，显示框展示实际根目录
      setRepoPath(summary.path);
      setSelected(null);
      setFiles([]);
      setDiff("");
      setPathMenuOpen(false);
      // 换仓库：标签页全部重置回「提交历史」
      setTabs([{ kind: "history" }]);
      setActiveTab(0);
      setTabData({});
      setUnchecked(new Set());
      setCtxMenu(null);
      // 异步记一条最近打开，失败不阻塞主流程；成功后刷新最近列表，更新菜单和欢迎页
      invoke("add_recent", { path: summary.path })
        .then(loadRecent)
        .catch(() => {});
    } catch (e) {
      setError(String(e));
      setRepo(null);
      // 打开失败会退回欢迎页，但后端可能仍持有上一个仓库的句柄（文件锁残留），主动释放
      invoke("close_repo").catch(() => {});
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

  // 关闭当前仓库：先叫 Rust 释放 git2 句柄（不然后端一直占着 .git 文件锁），
  // 然后清空所有相关状态返回欢迎页
  async function closeRepo() {
    try {
      await invoke("close_repo");
    } catch (e) {
      setError(String(e));
      return; // 释放失败别继续，否则前端状态和后端会脱钩
    }
    setRepo(null);
    setBranches([]);
    setCommits([]);
    setTree([]);
    setStatus([]);
    setStashes([]);
    setSelected(null);
    setFiles([]);
    setDiff("");
    setFilterBranch("");
    setFilterQuery("");
    setCommitMsg("");
    setConsoleText("");
    setConsoleOpen(false);
    setRepoPath("");
    setPathMenuOpen(false);
  }

  // 点击菜单外部关闭
  useEffect(() => {
    if (!pathMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (pathMenuRef.current && !pathMenuRef.current.contains(e.target as Node)) {
        setPathMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [pathMenuOpen]);

  // 键盘导航：↑↓ 移动高亮、Enter 打开、Esc 关闭；并把高亮项滚动进可视区
  useEffect(() => {
    if (!pathMenuOpen) return;
    const items = recent;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPathMenuOpen(false);
        return;
      }
      if (items.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setRecentMenuIndex((i) => (i + 1) % items.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setRecentMenuIndex((i) => (i - 1 + items.length) % items.length);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const r = items[recentMenuIndex];
        if (!r) return;
        setPathMenuOpen(false);
        if (r.path === repo?.path) return;
        if (!r.exists) {
          setError(`路径不存在：${r.path}`);
          return;
        }
        openRepo(r.path);
      }
    };
    document.addEventListener("keydown", onKey);

    // 滚动到高亮项（block: nearest 防止列表被甩出去）
    const el = pathMenuRef.current?.querySelector<HTMLElement>(
      `[data-idx="${recentMenuIndex}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });

    return () => document.removeEventListener("keydown", onKey);
  }, [pathMenuOpen, recent, recentMenuIndex, repo]);

  // 过滤变更时 300ms 防抖：避免每个字符发一次 RPC
  const debouncedQuery = useDebounced(filterQuery, 300);
  const debouncedBranch = useDebounced(filterBranch, 300);

  useEffect(() => {
    refresh();
  }, [refresh, debouncedQuery, debouncedBranch]);

  // 每次 repo 变化（或首次挂载）都拉一次最近列表：欢迎页用它渲染，顶部栏下拉菜单也用
  const loadRecent = useCallback(async () => {
    try {
      setRecent(await invoke<RecentEntry[]>("get_recent"));
    } catch {
      // 拉取失败就清空，不影响主流程
    }
  }, []);

  // 仓库切换（含关闭回到首页）时重新拉最近列表
  useEffect(() => {
    loadRecent();
  }, [repo, loadRecent]);

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
    // 只暂存勾选且不在「不提交」列表里的文件
    const paths = status
      .filter((s) => !skipList.includes(s.path) && !unchecked.has(s.path))
      .map((s) => s.path);
    if (paths.length === 0) {
      setError("没有勾选要提交的文件");
      return;
    }
    try {
      await invoke("stage_files", { paths });
      await invoke("commit", { message: commitMsg });
      setCommitMsg("");
      setUnchecked(new Set());
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  // 更改 ⇄ 不提交 双向移动（右键菜单触发），列表持久化在后端
  async function toggleSkip(path: string, toSkip: boolean) {
    try {
      const list = await invoke<string[]>("set_skip", { path, skip: toSkip });
      setSkipList(list);
      if (toSkip) {
        // 移入不提交时清掉勾选残留
        setUnchecked((u) => {
          const n = new Set(u);
          n.delete(path);
          return n;
        });
      }
      setCtxMenu(null);
    } catch (e) {
      setError(String(e));
    }
  }

  // 放弃更改：已跟踪文件从索引还原，未跟踪文件直接删除（后端语义）
  async function discardFile(path: string) {
    try {
      const msg = await invoke<string>("discard_file_changes", { path });
      setDiscardConfirm(null);
      setConsoleText(`> 放弃更改\n${msg}`);
      setConsoleOpen(true);
      await refresh();
    } catch (e) {
      setError(String(e));
      setDiscardConfirm(null);
    }
  }

  async function doRemoteOp(op: "fetch" | "pull" | "push") {
    if (!repo) return;
    setOpBusy(op);
    setConsoleText(`> git ${op}\n`);
    setConsoleOpen(true);
    try {
      const text = await invoke<string>("git_remote_op", {
        op,
        remote: null,
        branch: null,
      });
      setConsoleText(`> git ${op}\n${text}`);
      await refresh();
    } catch (e) {
      setConsoleText(`> git ${op} 失败\n${String(e)}`);
    } finally {
      setOpBusy(null);
    }
  }

  // ---------- 远程地址设置（git remote add / set-url origin） ----------

  async function openRemoteSettings() {
    if (remoteUrlOpen) {
      setRemoteUrlOpen(false);
      return;
    }
    try {
      const u = await invoke<string | null>("get_remote_url", { name: null });
      setRemoteUrl(u ?? "");
      setRemoteUrlOpen(true);
    } catch (e) {
      setError(String(e));
    }
  }

  async function saveRemoteUrl() {
    const url = remoteUrl.trim();
    if (!url) {
      setError("远程地址不能为空");
      return;
    }
    try {
      const msg = await invoke<string>("set_remote_url", { url, name: null });
      setRemoteUrlOpen(false);
      setConsoleText(`> git remote\n${msg}`);
      setConsoleOpen(true);
    } catch (e) {
      setError(String(e));
    }
  }

  async function stashAll() {
    try {
      await invoke("stash_save", { message: null });
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  async function stashOp(op: "pop" | "apply" | "drop", index: number) {
    const verb = op === "drop" ? "删除" : op === "pop" ? "弹出并应用" : "应用";
    if (!confirm(`确认${verb} stash@{${index}}？`)) return;
    try {
      await invoke(`stash_${op}`, { index });
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    if (!selected) {
      // 取消选中（如打开文件/对比标签）时，右栏数据一并清空，不残留上一个提交的内容
      setFiles([]);
      setDiff("");
      return;
    }
    setSelectedFile(null); // 换提交时清掉文件级筛选
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
  // 更改列表拆成两部分：不提交列表里的文件单独成区，不参与勾选提交
  const visibleStatus = status.filter((s) => !skipList.includes(s.path));
  const skippedStatus = status.filter((s) => skipList.includes(s.path));
  const checkedCount = visibleStatus.filter((s) => !unchecked.has(s.path)).length;
  // 右栏提交详情头的数据源：选中提交在当前过滤结果里才找得到
  const selectedCommit = selected ? commits.find((c) => c.oid === selected) ?? null : null;
  // 提交列表行内的时间用短格式（IDEA 风格：M/D HH:mm），详情头里再用完整格式
  const fmtShort = (t: number) =>
    new Date(t * 1000).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });

  return (
    <div className="app">
      {/* 顶部栏 */}
      <header className="topbar">
        <span className="logo">GitManage</span>
        <div className="path-menu-wrap" ref={pathMenuRef}>
          {/* 纯展示框：只显示当前仓库路径。开仓库走「浏览…」/ 最近列表，这里不承接输入 */}
          <input
            className={"repo-input" + (repo ? " has-repo" : "")}
            placeholder="点「浏览…」选择仓库目录，或从最近打开中选择"
            value={repoPath}
            readOnly
            onClick={() => {
              // 已开仓库时点显示框弹统一菜单
              if (repo) {
                const next = !pathMenuOpen;
                setPathMenuOpen(next);
                if (next) {
                  const idx = recent.findIndex((r) => r.path === repo.path);
                  setRecentMenuIndex(idx >= 0 ? idx : 0);
                }
              }
            }}
            title={repo ? "点击打开仓库菜单（切换 / 在资源管理器中打开 / 复制路径）" : "点「浏览…」选择仓库目录"}
          />
          {repo && pathMenuOpen && (
            <div className="recent-menu path-menu" role="menu">
              {/* 当前仓库信息 */}
              <div className="path-menu-head">
                <div className="path-menu-name">📁 {repo.name}</div>
                <div className="path-menu-sub" title={repo.path}>
                  {repo.path}
                </div>
              </div>
              {/* 仓库级快捷动作 */}
              <button
                className="recent-menu-item"
                onClick={async () => {
                  setPathMenuOpen(false);
                  try {
                    await invoke("reveal_in_explorer", { path: repo.path });
                  } catch (e) {
                    setError(String(e));
                  }
                }}
              >
                📂 在资源管理器中打开
              </button>
              <button
                className="recent-menu-item"
                onClick={async () => {
                  setPathMenuOpen(false);
                  try {
                    await navigator.clipboard.writeText(repo.path);
                  } catch {
                    setError("复制失败：剪贴板不可用");
                  }
                }}
              >
                ⧉ 复制路径
              </button>
              {/* 切换到最近打开的仓库 */}
              <div className="recent-menu-sep" />
              <div className="recent-menu-title">
                切换到 <span className="recent-menu-hint">↑↓ 选择 · Enter · Esc</span>
              </div>
              {recent.length === 0 && <div className="recent-menu-empty">暂无记录</div>}
              {recent.map((r, idx) => {
                const isCurrent = r.path === repo.path;
                return (
                  <button
                    key={r.path}
                    data-idx={idx}
                    className={`recent-menu-item ${r.exists ? "" : "missing"} ${isCurrent ? "current" : ""} ${idx === recentMenuIndex ? "active" : ""}`}
                    // 鼠标移上来同步键盘高亮，让鼠标/键盘两种操作一致
                    onMouseEnter={() => setRecentMenuIndex(idx)}
                    onClick={() => {
                      setPathMenuOpen(false);
                      if (isCurrent) return;
                      if (!r.exists) {
                        setError(`路径不存在：${r.path}`);
                        return;
                      }
                      openRepo(r.path);
                    }}
                    title={r.exists ? r.path : `${r.path}（路径不存在）`}
                  >
                    <span className="recent-menu-dot">{isCurrent ? "●" : "○"}</span>
                    <div className="recent-menu-text">
                      <div className="recent-menu-name">{r.name}</div>
                      <div className="recent-menu-path">{r.path}</div>
                    </div>
                    <span className="recent-menu-time">
                      {r.exists ? formatRelative(r.lastOpened) : "不存在"}
                    </span>
                  </button>
                );
              })}
              {recent.length > 0 && (
                <>
                  <div className="recent-menu-sep" />
                  <button
                    className="recent-menu-item ghost-flat"
                    onClick={() => {
                      setPathMenuOpen(false);
                      closeRepo();
                    }}
                  >
                    ✕ 关闭当前仓库，回到欢迎页
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        <button
          className={repo ? "ghost" : ""}
          onClick={browseFolder}
          disabled={loading}
          title="弹出文件夹选择器（支持选中仓库内任意子目录）"
        >
          浏览…
        </button>
        {repo && (
          <button className="ghost" onClick={refresh}>
            刷新
          </button>
        )}
        {repo && (
          <button className="ghost" onClick={closeRepo} title="关闭当前仓库，回到欢迎页">
            关闭
          </button>
        )}
        {current && (
          <span className="head-badge" title={current.commit}>
            ⎇ {current.name}
          </span>
        )}
        {repo && (
          // fetch/pull/push 已移到中栏过滤条右侧——它们是针对提交历史的操作，顶栏只留仓库级操作
          <div className="remote-actions">
            <button
              className="ghost small"
              onClick={() => setConsoleOpen((o) => !o)}
              title={consoleOpen ? "隐藏控制台" : "显示控制台"}
            >
              {consoleOpen ? "▼" : "▲"} Console
            </button>
          </div>
        )}
      </header>

      {error && <div className="error-bar">⚠ {error}</div>}

      {!repo ? (
        <div className="welcome">
          <h2>选择仓库目录开始</h2>
          <p className="welcome-hint">
            点右上角「浏览…」选择目录（支持选中仓库内任意子目录）。
          </p>

          {recent.length > 0 && (
            <>
              <div className="recent-title">最近打开</div>
              <ul className="recent-list">
                {recent.map((r) => (
                  <li
                    key={r.path}
                    className={`recent-item ${r.exists ? "" : "missing"}`}
                    title={r.exists ? r.path : `${r.path}（路径不存在）`}
                  >
                    <button
                      className="recent-main"
                      title={r.exists ? r.path : `${r.path}（路径不存在）`}
                      onClick={() => {
                        if (!r.exists) {
                          setError(`路径不存在：${r.path}`);
                          return;
                        }
                        openRepo(r.path);
                      }}
                    >
                      <span className="recent-icon">{r.exists ? "📁" : "⚠"}</span>
                      <div className="recent-meta">
                        <div className="recent-name">{r.name}</div>
                        <div className="recent-path">{r.path}</div>
                      </div>
                      <span className="recent-time">
                        {r.exists ? formatRelative(r.lastOpened) : "不存在"}
                      </span>
                    </button>
                    <div className="recent-tools">
                      <button
                        className="recent-tool"
                        title="在 Windows 资源管理器中打开"
                        disabled={!r.exists}
                        onClick={async (e) => {
                          e.stopPropagation();
                          try {
                            await invoke("reveal_in_explorer", { path: r.path });
                          } catch (err) {
                            setError(String(err));
                          }
                        }}
                      >
                        📂
                      </button>
                      <button
                        className="recent-tool"
                        title="复制路径"
                        onClick={async (e) => {
                          e.stopPropagation();
                          try {
                            await navigator.clipboard.writeText(r.path);
                          } catch {
                            setError("复制失败：浏览器剪贴板不可用");
                          }
                        }}
                      >
                        ⧉
                      </button>
                      <button
                        className="recent-remove"
                        title="从列表中移除"
                        onClick={async (e) => {
                          e.stopPropagation();
                          try {
                            await invoke("remove_recent", { path: r.path });
                            setRecent((prev) => prev.filter((x) => x.path !== r.path));
                          } catch (err) {
                            setError(String(err));
                          }
                        }}
                      >
                        ×
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}

          {recent.length === 0 && (
            <p className="welcome-hint">
              例如：打开本项目自身试试 —
              <button className="link" onClick={() => openRepo("C:\\Users\\guohj\\code\\gitmanage")}>
                C:\Users\guohj\code\gitmanage
              </button>
            </p>
          )}
        </div>
      ) : (
        // 文件/对比标签激活时右栏整栏隐藏，中栏工作区撑满（编辑器形态）
        <div className={`main ${activeT?.kind !== "history" ? "no-right" : ""}`}>
          {/* 左栏：文件树 + 工作区状态 */}
          <aside className="pane left">
            {/* 顶部 tab：分支树（默认，IDEA 风格）/ 文件树 */}
            <div className="left-tabs">
              <button
                className={`left-tab ${leftTab === "branches" ? "active" : ""}`}
                onClick={() => setLeftTab("branches")}
              >
                分支
              </button>
              <button
                className={`left-tab ${leftTab === "files" ? "active" : ""}`}
                onClick={() => setLeftTab("files")}
                title={`项目文件树 · ${repo.name}`}
              >
                文件树
              </button>
            </div>
            <div className="pane-body">
              {leftTab === "files" ? (
                repo.isEmpty ? (
                  <div className="empty-hint">空仓库（尚无提交）</div>
                ) : (
                  <FileTreeView
                    nodes={buildTree(tree)}
                    onFileClick={(p) => openCenterTab("file", p)}
                  />
                )
              ) : (
                <div className="branch-tree">
                  <div className="branch-tree-group">本地</div>
                  {localBranches.map((b) => (
                    <div
                      key={b.name}
                      className={`branch-tree-item ${b.isHead ? "current" : "clickable"}`}
                      title={b.isHead ? "当前分支" : `点击切换到 ${b.name}`}
                      onClick={() => !b.isHead && checkoutBranch(b.name)}
                    >
                      <span className="branch-tree-name">⎇ {b.name}</span>
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
                    </div>
                  ))}
                  {remoteBranches.length > 0 && (
                    <div className="branch-tree-group">远程</div>
                  )}
                  {remoteBranches.map((b) => (
                    <div key={b.name} className="branch-tree-item remote">
                      <span className="branch-tree-name">☁ {b.name}</span>
                    </div>
                  ))}
                  <button
                    className="branch-tree-add"
                    title="基于 HEAD 新建分支并切换"
                    onClick={createBranch}
                  >
                    ＋ 新分支
                  </button>
                </div>
              )}
            </div>
            <div className="pane-title">更改（{visibleStatus.length}）</div>
            <div className="pane-body status-list">
              {visibleStatus.length === 0 && <div className="empty-hint">工作区干净</div>}
              {visibleStatus.map((s) => (
                <div
                  key={s.path}
                  className="status-item clickable"
                  title={`${s.path}（点击查看对比，右键移到「不提交」）`}
                  onClick={() => openCenterTab("wdiff", s.path)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setCtxMenu({ x: e.clientX, y: e.clientY, path: s.path, inSkip: false });
                  }}
                >
                  <input
                    type="checkbox"
                    className="status-check"
                    checked={!unchecked.has(s.path)}
                    title="勾选参与本次提交"
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      const on = e.currentTarget.checked;
                      setUnchecked((u) => {
                        const n = new Set(u);
                        if (on) n.delete(s.path);
                        else n.add(s.path);
                        return n;
                      });
                    }}
                  />
                  <span className={`status-badge st-${s.status}`}>
                    {STATUS_LABEL[s.status] ?? "?"}
                  </span>
                  {s.path}
                </div>
              ))}
            </div>
            {visibleStatus.length > 0 && (
              <div className="commit-box">
                <textarea
                  placeholder="提交信息…"
                  value={commitMsg}
                  onChange={(e) => setCommitMsg(e.currentTarget.value)}
                  rows={2}
                />
                <div className="commit-actions">
                  <button onClick={doCommit} disabled={!commitMsg.trim() || checkedCount === 0}>
                    提交（{checkedCount} 个文件）
                  </button>
                  <button
                    className="ghost"
                    onClick={stashAll}
                    title="将当前所有改动压入 stash（含未跟踪）"
                  >
                    Stash 暂存
                  </button>
                </div>
              </div>
            )}

            {/* 「不提交」：本地修改但不想提交的文件，右键可移回更改；列表存在 .git/info 里 */}
            {skippedStatus.length > 0 && (
              <>
                <div className="pane-title">不提交（{skippedStatus.length}）</div>
                <div className="pane-body status-list skip-list">
                  {skippedStatus.map((s) => (
                    <div
                      key={s.path}
                      className="status-item clickable skipped"
                      title={`${s.path}（点击查看对比，右键移回「更改」）`}
                      onClick={() => openCenterTab("wdiff", s.path)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setCtxMenu({ x: e.clientX, y: e.clientY, path: s.path, inSkip: true });
                      }}
                    >
                      <span className={`status-badge st-${s.status}`}>
                        {STATUS_LABEL[s.status] ?? "?"}
                      </span>
                      {s.path}
                    </div>
                  ))}
                </div>
              </>
            )}

            <div className="pane-title">Stash（{stashes.length}）</div>
            <div className="pane-body stash-list">
              {stashes.length === 0 && <div className="empty-hint">没有 stash</div>}
              {stashes.map((s) => (
                <div key={`${s.index}-${s.oid}`} className="stash-item">
                  <div className="stash-meta">
                    <span className="stash-index">stash@{s.index}</span>
                    <span className="stash-msg" title={s.message}>
                      {s.message}
                    </span>
                  </div>
                  <div className="stash-actions">
                    <button
                      className="ghost xsmall"
                      title="应用但不删除（apply）"
                      onClick={() => stashOp("apply", s.index)}
                    >
                      apply
                    </button>
                    <button
                      className="ghost xsmall"
                      title="应用并删除（pop）"
                      onClick={() => stashOp("pop", s.index)}
                    >
                      pop
                    </button>
                    <button
                      className="ghost xsmall"
                      title="直接删除（drop）"
                      onClick={() => stashOp("drop", s.index)}
                    >
                      drop
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </aside>

          {/* 中栏：标签页工作区——「提交历史」固定首页签，文件预览/对比开新标签 */}
          <section className="pane center">
            <div className="center-tabs">
              {tabs.map((t, i) => (
                <div
                  key={tabKey(t)}
                  className={`center-tab ${i === activeTab ? "active" : ""}`}
                  title={t.kind === "history" ? "提交历史" : t.path}
                  onClick={() => setActiveTab(i)}
                >
                  {isDirty(t) && <span className="tab-dirty">●</span>}
                  <span className="center-tab-label">{tabLabel(t)}</span>
                  {t.kind !== "history" && (
                    <button
                      className="chip-x"
                      title="关闭标签"
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTab(i);
                      }}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
            {activeT?.kind !== "history" ? (
              <div className="pane-body tab-view">
                {tabData[activeKey] === undefined ? (
                  <div className="empty-hint">加载中…</div>
                ) : activeT.kind === "file" ? (
                  <div className="file-edit-wrap">
                    <div className="file-edit-bar">
                      <span className="file-edit-path" title={activeT.path}>
                        {activeT.path}
                      </span>
                      {isDirty(activeT) && (
                        <>
                          <button className="ghost small" onClick={() => saveFileTab(activeT)}>
                            保存（Ctrl+S）
                          </button>
                          <button className="ghost small" onClick={() => discardFileTab(activeT)}>
                            放弃修改
                          </button>
                        </>
                      )}
                    </div>
                    <textarea
                      className="file-editor"
                      spellCheck={false}
                      value={tabDrafts[activeKey] ?? tabData[activeKey]}
                      onChange={(e) => {
                        // 注意：currentTarget 在事件分发结束后被 React 置 null，
                        // 必须先取出 value 再进 setState 更新器，否则更新器执行时访问 null.value 崩溃
                        const v = e.currentTarget.value;
                        setTabDrafts((m) => ({ ...m, [activeKey]: v }));
                      }}
                      onKeyDown={(e) => {
                        if ((e.ctrlKey || e.metaKey) && e.key === "s") {
                          e.preventDefault();
                          saveFileTab(activeT);
                        }
                      }}
                    />
                  </div>
                ) : (
                  <DiffView text={tabData[activeKey]} hint="该文件当前没有工作区改动" />
                )}
              </div>
            ) : (
              <>
                <div className="pane-title">提交历史（{commits.length}）</div>
                <div className="filter-toolbar">
              <select
                value={filterBranch}
                onChange={(e) => setFilterBranch(e.currentTarget.value)}
                title="按分支过滤"
              >
                <option value="">全部（HEAD）</option>
                {localBranches.map((b) => (
                  <option key={b.name} value={b.name}>⎇ {b.name}</option>
                ))}
                {remoteBranches.map((b) => (
                  <option key={b.name} value={b.name}>☁ {b.name}</option>
                ))}
              </select>
              <input
                type="search"
                placeholder="搜索 message / 作者 / hash…"
                value={filterQuery}
                onChange={(e) => setFilterQuery(e.currentTarget.value)}
              />
              {(filterBranch || filterQuery) && (
                <button
                  className="ghost small"
                  title="清除过滤"
                  onClick={() => {
                    setFilterBranch("");
                    setFilterQuery("");
                  }}
                >
                  清除
                </button>
              )}
              {/* 远程操作放在提交历史的工具条上（IDEA 风格），顶栏只留仓库级操作 */}
              <div className="filter-remote">
                <button
                  className="ghost small"
                  onClick={() => doRemoteOp("fetch")}
                  disabled={opBusy !== null}
                  title="git fetch"
                >
                  {opBusy === "fetch" ? "…" : "↓ fetch"}
                </button>
                <button
                  className="ghost small"
                  onClick={() => doRemoteOp("pull")}
                  disabled={opBusy !== null}
                  title={
                    syncCounts && syncCounts[1] > 0
                      ? `git pull（当前分支）—— 远程领先 ${syncCounts[1]} 条（基于上次 fetch）`
                      : "git pull（当前分支）"
                  }
                >
                  {opBusy === "pull" ? "…" : "↓ pull"}
                  {!opBusy && syncCounts && syncCounts[1] > 0 && (
                    <span className="sync-badge">{syncCounts[1]}</span>
                  )}
                </button>
                <button
                  className="ghost small"
                  onClick={() => doRemoteOp("push")}
                  disabled={opBusy !== null}
                  title={
                    syncCounts && syncCounts[0] > 0
                      ? `git push（当前分支）—— 本地领先 ${syncCounts[0]} 条`
                      : "git push（当前分支）"
                  }
                >
                  {opBusy === "push" ? "…" : "↑ push"}
                  {!opBusy && syncCounts && syncCounts[0] > 0 && (
                    <span className="sync-badge">{syncCounts[0]}</span>
                  )}
                </button>
                <button
                  className="ghost small"
                  onClick={openRemoteSettings}
                  title="设置远程仓库地址（git remote add / set-url origin）"
                >
                  ⚙ 远程
                </button>
              </div>
            </div>
            {/* 「⚙ 远程」展开的设置行：输入远程仓库地址，回车或点保存生效 */}
            {remoteUrlOpen && (
              <div className="remote-edit">
                <input
                  autoFocus
                  placeholder="https://github.com/user/repo.git 或 git@github.com:user/repo.git"
                  value={remoteUrl}
                  onChange={(e) => setRemoteUrl(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveRemoteUrl();
                    if (e.key === "Escape") setRemoteUrlOpen(false);
                  }}
                />
                <button className="ghost small" onClick={saveRemoteUrl} disabled={!remoteUrl.trim()}>
                  保存
                </button>
                <button className="ghost small" onClick={() => setRemoteUrlOpen(false)}>
                  取消
                </button>
              </div>
            )}
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
                    {/* 单行布局（IDEA 风格）：hash + refs + message 省略号，作者·时间右对齐 */}
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
                      {c.parents.length > 1 && <span className="merge-tag">merge</span>}
                      {c.author} · {fmtShort(c.time)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
              </>
            )}
          </section>

          {/* 右栏：提交详情头 + 文件变更 + diff（仅提交历史标签激活时显示） */}
          {activeT?.kind === "history" && (
          <section className="pane right">
            {selectedCommit ? (
              <div className="commit-detail-head">
                <div className="detail-summary" title={selectedCommit.summary}>
                  {selectedCommit.summary}
                </div>
                <div className="detail-meta">
                  {selectedCommit.author} ·{" "}
                  {new Date(selectedCommit.time * 1000).toLocaleString("zh-CN", { hour12: false })}
                  <span className="hash detail-hash" title="完整 hash">
                    {selectedCommit.oid}
                  </span>
                </div>
              </div>
            ) : (
              <div className="commit-detail-head empty-hint">选择左侧提交查看详情</div>
            )}
            <div className="pane-title">
              改动文件（{files.length}）
              {selectedFile && (
                <button
                  className="ghost small pane-title-btn"
                  title="恢复显示全部文件的差异"
                  onClick={() => setSelectedFile(null)}
                >
                  显示全部
                </button>
              )}
            </div>
            <div className="pane-body change-list">
              {files.map((f) => (
                <div
                  key={f.path}
                  className={`status-item clickable ${selectedFile === f.path ? "selected" : ""}`}
                  title={`${f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}（点击只看此文件的差异）`}
                  onClick={() => setSelectedFile(selectedFile === f.path ? null : f.path)}
                >
                  <span className={`status-badge st-${f.status}`}>
                    {STATUS_LABEL[f.status] ?? "?"}
                  </span>
                  {f.path}
                </div>
              ))}
              {selected && files.length === 0 && <div className="empty-hint">无文件改动</div>}
            </div>
            <div className="pane-title">差异{selectedFile ? ` · ${selectedFile}` : ""}</div>
            <div className="pane-body diff-body">
              <DiffView text={selectedFile ? extractFileDiff(diff, selectedFile) : diff} />
            </div>
          </section>
          )}
        </div>
      )}

      {/* 更改/不提交列表项的右键菜单：透明遮罩点击即关 */}
      {ctxMenu && (
        <div
          className="ctx-overlay"
          onClick={() => setCtxMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setCtxMenu(null);
          }}
        >
          <div
            className="ctx-menu"
            style={{ left: ctxMenu.x, top: ctxMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            {ctxMenu.inSkip ? (
              <button
                className="recent-menu-item"
                onClick={() => toggleSkip(ctxMenu.path, false)}
              >
                ↩ 移回「更改」
              </button>
            ) : (
              <>
                <button
                  className="recent-menu-item"
                  onClick={() => toggleSkip(ctxMenu.path, true)}
                >
                  ⏏ 移到「不提交」（本地保留改动，不参与提交）
                </button>
                <button
                  className="recent-menu-item danger"
                  onClick={() => {
                    setDiscardConfirm(ctxMenu.path);
                    setCtxMenu(null);
                  }}
                >
                  ✕ 放弃更改…（不可恢复）
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* 「放弃更改」二次确认弹窗 */}
      {discardConfirm && (
        <div className="ctx-overlay dim" onClick={() => setDiscardConfirm(null)}>
          <div className="confirm-box" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-title">确认放弃更改？</div>
            <div className="confirm-path" title={discardConfirm}>
              {discardConfirm}
            </div>
            <div className="confirm-desc">
              已跟踪文件将还原到上次提交的内容；未跟踪的新文件会被直接删除。此操作不可恢复。
            </div>
            <div className="confirm-actions">
              <button className="danger-btn" onClick={() => discardFile(discardConfirm)}>
                确认放弃
              </button>
              <button className="ghost" onClick={() => setDiscardConfirm(null)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {repo && consoleOpen && (
        <div className="console-bar">
          <div className="console-head">
            <span>控制台输出</span>
            <button
              className="ghost small"
              onClick={() => setConsoleText("")}
              title="清空"
            >
              清空
            </button>
          </div>
          <pre className="console-body">{consoleText || "(空)"}</pre>
        </div>
      )}
    </div>
  );
}

export default App;
