import { useState, useEffect, useCallback, useMemo, useRef, Component } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import hljs from "highlight.js/lib/core";
// 只注册常用语言，控制 bundle 体积
import rust from "highlight.js/lib/languages/rust";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import yaml from "highlight.js/lib/languages/yaml";
import ini from "highlight.js/lib/languages/ini";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import bash from "highlight.js/lib/languages/bash";
import python from "highlight.js/lib/languages/python";
import cpp from "highlight.js/lib/languages/cpp";
import java from "highlight.js/lib/languages/java";
import sql from "highlight.js/lib/languages/sql";
import "highlight.js/styles/vs2015.css"; // VS Code 深色风，贴合整体蓝灰调
import { alignLines, applyNonConflicting, buildResultText, parseConflictText } from "./conflictText";
import type { M3Seg, Picks } from "./conflictText";
import "./App.css";

hljs.registerLanguage("rust", rust);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("css", css);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("python", python);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("java", java);
hljs.registerLanguage("sql", sql);

// 扩展名 → hljs 语言 id（未识别的走 highlightAuto）
const EXT_LANG: Record<string, string> = {
  rs: "rust",
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  json: "json",
  md: "markdown",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  cfg: "ini",
  css: "css",
  html: "xml",
  htm: "xml",
  vue: "xml",
  svg: "xml",
  sh: "bash",
  bash: "bash",
  py: "python",
  c: "cpp",
  h: "cpp",
  cpp: "cpp",
  java: "java",
  sql: "sql",
};

// 只读高亮代码视图（hljs 输出自带转义，可安全 innerHTML）
function HighlightedCode({ code, path }: { code: string; path: string }) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const lang = EXT_LANG[ext];
  const html = useMemo(() => {
    try {
      return lang
        ? hljs.highlight(code, { language: lang }).value
        : hljs.highlightAuto(code).value;
    } catch {
      return null;
    }
  }, [code, lang]);
  if (html === null) return <pre className="file-content">{code}</pre>;
  return (
    <pre className="file-content hljs-body">
      <code dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
}

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

interface ConflictFile {
  path: string;
  hasBase: boolean;
  hasOurs: boolean;
  hasTheirs: boolean;
}

interface ConflictSides {
  path: string;
  base: string | null;
  ours: string | null;
  theirs: string | null;
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
  lane: number; // 本行提交节点所在泳道
  top: number[]; // 从上方延续进入本行的泳道（画竖线 0→midY）
  bot: number[]; // 本行向下延续的泳道（画竖线 midY→ROW_H；不含 born）
  born: number[]; // merge 第二父「出生」泳道：节点向下画弧连到该泳道（分出新支）
  converge: number[]; // 共享父的「收拢」泳道：从该泳道顶部画弧收进本行节点（两支汇到一点）
  isMerge: boolean;
}

const GRAPH_LANE_W = 16; // 每条泳道宽度
const GRAPH_ROW_H = 30; // 行高，需与 CSS .commit-item 的高度一致
const LANE_COLORS = ["#569cd6", "#4ec9b0", "#d7ba7d", "#ce9178", "#b5cea8", "#9cdcfe"];

function computeGraph(commits: CommitInfo[]): { rows: GraphRow[]; laneCount: number } {
  // lanes[i] = 泳道 i 下一个期待出现的 commit oid；非空表示该泳道有竖线从上方延续下来
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = commits.map((c) => {
    // 1) 定位本提交所在泳道（父们已把期待 oid 放进 lanes，命中即接管该泳道）
    let idx = lanes.indexOf(c.oid);
    if (idx === -1) {
      // 头部/分页截断后第一个出现的提交：复用空位或新开
      const free = lanes.indexOf(null);
      idx = free === -1 ? lanes.length : free;
      if (free === -1) lanes.push(null);
    }
    // 2) 收拢：其它泳道也期待同一个 oid（两条支线共享同一父）
    //    → 该泳道竖线不再直穿，改为画弧收进本行节点，然后终止
    const converge: number[] = [];
    for (let i = 0; i < lanes.length; i++) {
      if (i !== idx && lanes[i] === c.oid) {
        converge.push(i);
        lanes[i] = null;
      }
    }
    // 3) 顶部延续：处理前仍非空的泳道（converge 已置空，剩真正直穿下来的）
    const top: number[] = [];
    lanes.forEach((o, i) => {
      if (o !== null) top.push(i);
    });
    // 4) 第一父先接管当前泳道（先占位，保证 born 分配不会撞到 idx）
    lanes[idx] = c.parents[0] ?? null;
    // 5) merge：parents[1..] 每个第二父开一条「出生」泳道（弧从本节点分出新支）
    const born: number[] = [];
    for (const p of c.parents.slice(1)) {
      let m = -1;
      for (let j = 0; j < lanes.length; j++) {
        if (j !== idx && lanes[j] === null) {
          m = j;
          break;
        }
      }
      if (m === -1) {
        m = lanes.length;
        lanes.push(null);
      }
      lanes[m] = p;
      born.push(m);
    }
    // 6) 底部延续：处理后非空且非 born 的泳道（born 用弧表达，不再画竖线）
    const bot: number[] = [];
    lanes.forEach((o, i) => {
      if (o !== null && !born.includes(i)) bot.push(i);
    });
    return { lane: idx, top, bot, born, converge, isMerge: c.parents.length > 1 };
  });

  // 宽度取全局最大泳道下标 + 1（数组可能含空洞，不能用 length）
  const laneCount = Math.max(
    1,
    ...rows.map((r) => Math.max(r.lane, ...r.top, ...r.bot, ...r.born, ...r.converge) + 1)
  );
  return { rows, laneCount };
}

function CommitGraph({ row, laneCount }: { row: GraphRow; laneCount: number }) {
  const w = laneCount * GRAPH_LANE_W;
  const x = (i: number) => i * GRAPH_LANE_W + GRAPH_LANE_W / 2;
  const midY = GRAPH_ROW_H / 2;
  const laneColor = (i: number) => LANE_COLORS[i % LANE_COLORS.length];

  return (
    <svg className="commit-graph" width={w} height={GRAPH_ROW_H} viewBox={`0 0 ${w} ${GRAPH_ROW_H}`}>
      {/* 顶部延续竖线：0→midY（从上方直穿下来，进本行节点或继续向下） */}
      {row.top.map((i) => (
        <line
          key={`t${i}`}
          x1={x(i)}
          y1={0}
          x2={x(i)}
          y2={midY}
          stroke={laneColor(i)}
          strokeWidth={1.5}
          strokeLinecap="round"
        />
      ))}
      {/* 底部延续竖线：midY→ROW_H（从本行节点继续向下延伸到下一行） */}
      {row.bot.map((i) => (
        <line
          key={`b${i}`}
          x1={x(i)}
          y1={midY}
          x2={x(i)}
          y2={GRAPH_ROW_H}
          stroke={laneColor(i)}
          strokeWidth={1.5}
          strokeLinecap="round"
        />
      ))}
      {/* merge 出生弧：从本节点向下弯到新泳道——表示「从这里分出一条新支」
          三次贝塞尔：起点切线沿节点泳道竖直到 60% 行高 (P1=(x_lane, 0.4H+0.6*(H-0.4H))=
          midY + 0.6*(H-midY))，末段切线沿 born 泳道竖直到行底 (P2=(x_m, H-0.4*(H-midY)))。
          末段最后 40% 行高与下一行 top 同向竖直下行，衔接到 (x_m, 0) 时无方向突变
          ——消除 P2=P3 时末段水平切线与下一行 top 竖直切线在行底交接的 90° 锐角 */}
      {row.born.map((m) => (
        <path
          key={`n${m}`}
          d={`M ${x(row.lane)} ${midY} C ${x(row.lane)} ${midY + (GRAPH_ROW_H - midY) * 0.6}, ${x(m)} ${GRAPH_ROW_H - (GRAPH_ROW_H - midY) * 0.4}, ${x(m)} ${GRAPH_ROW_H}`}
          fill="none"
          stroke={laneColor(m)}
          strokeWidth={1.5}
          strokeLinecap="round"
        />
      ))}
      {/* 共享父收拢弧：从泳道顶部弯进本行节点——表示「两条支线汇到这一点」
        三次贝塞尔：P1=(x_i, 0.6H) 让起点切线沿支线向下，P2=(x_node, 0.4H) 让末端切线沿节点泳道向下。
        末段 0.4H 范围内沿节点泳道竖直下落，与节点下方 bot 同向合流（消除 Q 曲线末端水平进入与
        bot 竖直线造成的锐角折点） */}
      {row.converge.map((i) => (
        <path
          key={`v${i}`}
          d={`M ${x(i)} 0 C ${x(i)} ${midY * 0.6}, ${x(row.lane)} ${midY * 0.4}, ${x(row.lane)} ${midY}`}
          fill="none"
          stroke={laneColor(i)}
          strokeWidth={1.5}
          strokeLinecap="round"
        />
      ))}
      {/* 本行提交节点：纯实心（IDEA 风格）。不要描边——深色描边在小尺寸下会让圆心被吞掉，看着像空心环 */}
      <circle cx={x(row.lane)} cy={midY} r={5} fill={laneColor(row.lane)} />
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

// ---------- 三路合并面板（解决 pull/merge 冲突） ----------
//
// 冲突标记文本的解析/对齐/拼装逻辑在 src/conflictText.ts（纯函数，可单测）：
// 磁盘文件带 <<<<<<< / ======= / >>>>>>> 标记 → 切成「普通段 + 冲突块」，
// 块内行对齐让本地/远程两列同行对比；块是整块替换的原子单位，
// 全部块选择完才允许写回 + 暂存（git add = 标记已解决）。
function MergePanel({
  path,
  onOpenFile,
  onResolved,
  onAbort,
}: {
  path: string;
  onOpenFile: (p: string) => void;
  onResolved: () => void;
  onAbort: () => void;
}) {
  // sides：undefined=加载中 / null=后端读取失败；disk：null=磁盘读取失败（二进制等）
  const [sides, setSides] = useState<ConflictSides | null | undefined>(undefined);
  const [disk, setDisk] = useState<string | null>(null);
  const [error, setError] = useState("");
  // picks：行级选择 + Accept Both。每个冲突块的 row 数在 segs 解析后才知道，先初始化为空
  const [picks, setPicks] = useState<Picks>({});
  // 整体模式（磁盘无冲突标记，如单侧冲突 added/deleted）下的选择："ours"|"theirs"|null
  const [wholePick, setWholePick] = useState<"ours" | "theirs" | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let dead = false;
    setError("");
    setSides(undefined);
    setDisk(null);
    setPicks({});
    setWholePick(null);
    invoke<ConflictSides | null>("get_conflict_sides", { path })
      .then((s) => {
        if (!dead) setSides(s);
      })
      .catch((e) => {
        if (!dead) {
          setError(String(e));
          setSides(null);
        }
      });
    // 磁盘文件可能读不到（二进制含 NUL 会被后端拒绝）——失败不致命，
    // sides 已带两侧内容，走「整体模式」仍可整侧采用；二进制面板另有专门提示
    invoke<string>("read_file_content", { path })
      .then((d) => {
        if (!dead) setDisk(d);
      })
      .catch(() => {
        if (!dead) setDisk(null);
      });
    return () => {
      dead = true;
    };
  }, [path]);

  // 根据磁盘文本解析段结构；失败（无有效标记文本）视为整体模式
  const parsed = useMemo(() => {
    if (disk === null) return null;
    try {
      const { eol, segs } = parseConflictText(disk);
      const blocks = segs.filter((s) => s.kind === "conflict") as Extract<
        M3Seg,
        { kind: "conflict" }
      >[];
      return { eol, segs, blocks, whole: blocks.length === 0, hasMarkers: disk.includes("<<<<<<<") };
    } catch {
      return null;
    }
  }, [disk]);

  // 冲突块数 + 行级采纳进度
  let totalBlocks = 0;
  let totalRows = 0;
  let resolvedRows = 0;
  if (parsed) {
    for (const b of parsed.blocks) {
      totalBlocks++;
      const n = alignLines(b.ours, b.theirs).length;
      totalRows += n;
      const pick = picks[b.id];
      if (pick) {
        resolvedRows += pick.both ? n : pick.sides.filter((s) => s !== null).length;
      }
    }
  }
  const allResolved = totalRows > 0 && resolvedRows === totalRows;
  // 两侧都没有内容（后端 blob 读不出/二进制）：只能走编辑器手动处理
  const fileBinary =
    sides !== null && sides !== undefined && sides.ours === null && sides.theirs === null;

  // 改动区采纳（IDEA 风格）：把某块内第 regionNo 个「改动区」的全部行设为 ours/theirs。
  // 改动区 = alignLines 的连续孤儿区，一次点击采纳整区（不再是逐行点按钮）
  const pickRegion = (blockId: number, regionNo: number, side: "ours" | "theirs") => {
    const idxs = blockRegions[blockId]?.[regionNo];
    if (!idxs || idxs.length === 0) return;
    setPicks((m) => {
      const cur = m[blockId] ?? { sides: [], both: false };
      const sides = cur.sides.slice();
      for (const r of idxs) sides[r] = side;
      return { ...m, [blockId]: { sides, both: false } };
    });
  };

  // 整块快速采纳：把该块所有行都设为 ours/theirs（覆盖既有行级选择）
  const pickBlock = (blockId: number, side: "ours" | "theirs") =>
    setPicks((m) => {
      const cur = m[blockId];
      if (!cur) return m;
      return { ...m, [blockId]: { sides: cur.sides.map(() => side), both: false } };
    });

  // Accept Both：该块 ours + theirs 全部按顺序纳入结果（行级忽略）
  const pickBlockBoth = (blockId: number) =>
    setPicks((m) => {
      const cur = m[blockId];
      if (!cur) return m;
      return { ...m, [blockId]: { sides: cur.sides, both: true } };
    });

  // 把所有冲突块都整块采纳同一侧
  const pickAll = (side: "ours" | "theirs") => {
    if (!parsed) return;
    setPicks((m) => {
      const next: Picks = {};
      for (const seg of parsed.segs) {
        if (seg.kind !== "conflict") continue;
        const cur = m[seg.id];
        next[seg.id] = cur
          ? { sides: cur.sides.map(() => side), both: false }
          : { sides: [], both: true /* 下方补齐 */ };
      }
      return next;
    });
  };

  // 所有冲突块都 Accept Both（适合"两边各加一段"场景）
  const pickAllBoth = () => {
    if (!parsed) return;
    setPicks((m) => {
      const next: Picks = {};
      for (const seg of parsed.segs) {
        if (seg.kind !== "conflict") continue;
        const cur = m[seg.id];
        next[seg.id] = { sides: cur?.sides ?? [], both: true };
      }
      return next;
    });
  };

  // 「应用无冲突的更改」：自动采纳两侧不冲突的行（两侧相同 / 单侧独立改动），
  // 真冲突（两侧在同一位置各改不同内容）保持未选，留给人工决策
  const applyNonConf = (direction: "both" | "ours" | "theirs") => {
    if (!parsed) return;
    setPicks((m) => applyNonConflicting(parsed.segs, m, direction));
  };

  // 块级版本：只对指定冲突块应用无冲突更改
  const applyBlockNonConf = (blockId: number) => {
    if (!parsed) return;
    setPicks((m) => applyNonConflicting(parsed.segs, m, "both", blockId));
  };

  // 组装最终内容并写回 + 暂存（git add = 标记已解决）
  async function resolveWith(content: string) {
    setBusy(true);
    try {
      await invoke("write_file_content", { path, content });
      await invoke("stage_files", { paths: [path] });
      onResolved();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  // 逐块模式：按各块选择拼出最终文本（模块版会校验全部块都已选择）
  function buildResult(): string | null {
    if (!parsed || !allResolved) return null;
    return buildResultText(parsed.segs, picks, parsed.eol);
  }

  const doResolve = () => {
    if (fileBinary) return;
    // parsed === null（磁盘读失败/无可解析文本）或磁盘无冲突块 → 整体模式
    const whole = parsed === null || parsed.whole;
    if (whole) {
      if (wholePick) {
        const content = wholePick === "ours" ? sides?.ours : sides?.theirs;
        if (content === undefined || content === null) {
          setError("所选一侧不存在（该侧没有此文件），请改选另一侧");
          return;
        }
        resolveWith(content);
        return;
      }
      if (disk !== null && (parsed === null || !parsed.hasMarkers)) {
        if (!confirm("文件不包含冲突标记（可能已手动解决）。\n将当前工作区内容标记为已解决并暂存？")) return;
        resolveWith(disk);
        return;
      }
      if (disk === null) {
        setError("无法读取工作区文件（二进制或已被删除）。请先点击「采用本地/远程」选择一侧，或用编辑器手动处理");
        return;
      }
      setError("请先点击「采用本地」或「采用远程」选择一侧");
      return;
    }
    const text = buildResult();
    if (text !== null) resolveWith(text);
  };

  // 把显示行里的 \r 剥掉（CRLF 文件按行显示更干净，写回时统一用检测到的 eol）
  const clean = (s: string) => (s.endsWith("\r") ? s.slice(0, -1) : s);

  // 三列内容渲染数据：按段生成展示行流
  const rows = useMemo(() => {
    if (!parsed || parsed.whole) return null;
    type Row =
      | { t: "ctx"; line: string; no: number }
      | { t: "bar"; id: number }
      | {
          t: "pair";
          id: number;
          rowIdx: number;
          a: string | null;
          b: string | null;
          common: boolean;
          clash: boolean;
          /** 所属「改动区」（连续孤儿区，块内从 0 编号）；common 行为 -1 */
          region: number;
          /** 该行是所属改动区内第一个有本地内容的行 → 在此渲染 » 按钮（采纳整区本地） */
          firstA: boolean;
          /** 该行是所属改动区内第一个有远程内容的行 → 在此渲染 « 按钮（采纳整区远程） */
          firstB: boolean;
          /** 该展示行在左（ours）源文件中的行号；a 无内容时为 0 */
          aNo: number;
          /** 该展示行在右（theirs）源文件中的行号；b 无内容时为 0 */
          bNo: number;
        };
    const out: Row[] = [];
    // 行号按「各自源文件」累计：ctx 段两文件位置相同，行号同步推进；
    // 冲突块内 ours/theirs 的行数可能不同，各自独立累计（对齐 IDEA 三列各自真实行号）
    let offO = 0;
    let offT = 0;
    for (const seg of parsed.segs) {
      if (seg.kind === "text") {
        for (const line of seg.lines) {
          out.push({ t: "ctx", line, no: offO + 1 });
          offO++;
          offT++;
        }
      } else {
        out.push({ t: "bar", id: seg.id });
        const aligned = alignLines(seg.ours, seg.theirs);
        const isPair = (r: [number | null, number | null]) => r[0] !== null && r[1] !== null;
        // 每个「连续孤儿区」= 一个改动区（IDEA 的一处 change）：
        //  - 区内只有一侧有内容 → 单侧改动（绿）
        //  - 区内两侧都有内容 → 真冲突（红）
        // 每个区只在「区首有内容的行」放采纳按钮（IDEA 的 » « 一次采纳整区）
        const clash = new Array<boolean>(aligned.length).fill(false);
        const region = new Array(aligned.length).fill(-1);
        const firstA = new Array(aligned.length).fill(false);
        const firstB = new Array(aligned.length).fill(false);
        let regNo = 0;
        let i = 0;
        while (i < aligned.length) {
          if (isPair(aligned[i])) {
            i++;
            continue;
          }
          let j = i;
          let hasO = false;
          let hasT = false;
          while (j < aligned.length && !isPair(aligned[j])) {
            if (aligned[j][0] !== null) hasO = true;
            if (aligned[j][1] !== null) hasT = true;
            j++;
          }
          const clashReg = hasO && hasT;
          let aAnchor = false;
          let bAnchor = false;
          for (let k = i; k < j; k++) {
            if (clashReg) clash[k] = true;
            region[k] = regNo;
            if (!aAnchor && aligned[k][0] !== null) {
              aAnchor = true;
              firstA[k] = true;
            }
            if (!bAnchor && aligned[k][1] !== null) {
              bAnchor = true;
              firstB[k] = true;
            }
          }
          regNo++;
          i = j;
        }
        aligned.forEach(([ai, bi], rowIdx) => {
          out.push({
            t: "pair",
            id: seg.id,
            rowIdx,
            a: ai !== null ? seg.ours[ai] : null,
            b: bi !== null ? seg.theirs[bi] : null,
            common: ai !== null && bi !== null,
            clash: clash[rowIdx],
            region: region[rowIdx],
            firstA: firstA[rowIdx],
            firstB: firstB[rowIdx],
            aNo: ai !== null ? offO + ai + 1 : 0,
            bNo: bi !== null ? offT + bi + 1 : 0,
          });
        });
        offO += seg.ours.length;
        offT += seg.theirs.length;
      }
    }
    return out;
  }, [parsed]);

  // 每个冲突块内各改动区覆盖的行 idx（按钮一次采纳整区）
  const blockRegions = useMemo(() => {
    const m: Record<number, number[][]> = {};
    if (!parsed) return m;
    for (const seg of parsed.segs) {
      if (seg.kind !== "conflict") continue;
      const aligned = alignLines(seg.ours, seg.theirs);
      const regions: number[][] = [];
      const isPair = (r: [number | null, number | null]) => r[0] !== null && r[1] !== null;
      let i = 0;
      while (i < aligned.length) {
        if (isPair(aligned[i])) {
          i++;
          continue;
        }
        let j = i;
        while (j < aligned.length && !isPair(aligned[j])) j++;
        regions.push(Array.from({ length: j - i }, (_, k) => i + k));
        i = j;
      }
      m[seg.id] = regions;
    }
    return m;
  }, [parsed]);

  // picks 按冲突块的"对齐后行数"初始化；用户已采纳的行/Accept Both 选择会保留
  useEffect(() => {
    if (!parsed) return;
    setPicks((prev) => {
      const next: Picks = {};
      for (const seg of parsed.segs) {
        if (seg.kind !== "conflict") continue;
        const aligned = alignLines(seg.ours, seg.theirs);
        const old = prev[seg.id];
        const sides =
          old && old.sides.length === aligned.length ? old.sides.slice() : new Array(aligned.length).fill(null);
        // common 行（两侧内容相同，无争议）直接视为已采纳 ours——
        // 避免它们阻塞「标记已解决」，也不需要逐行按钮
        aligned.forEach((r, i) => {
          if (r[0] !== null && r[1] !== null && sides[i] === null) sides[i] = "ours";
        });
        next[seg.id] = { sides, both: old?.both ?? false };
      }
      return next;
    });
  }, [parsed]);

  // 每个冲突块的对齐后行数（避免在 JSX 内反复 alignLines）
  const blockRowCounts = useMemo(() => {
    const m: Record<number, number> = {};
    if (!parsed) return m;
    for (const seg of parsed.segs) {
      if (seg.kind === "conflict") m[seg.id] = alignLines(seg.ours, seg.theirs).length;
    }
    return m;
  }, [parsed]);

  if (sides === undefined) return <div className="empty-hint">加载中…</div>;
  if (sides === null) {
    return (
      <div className="empty-hint" style={{ color: "var(--red)" }}>
        {error || "读取冲突信息失败"}
      </div>
    );
  }

  // parsed===null（磁盘读失败）与磁盘无冲突块都走「整体模式」：整侧采用或靠编辑器
  const whole = parsed === null || parsed.whole;
  const errFlash =
    error && sides !== null ? (
      <div className="merge-file-hint err">⚠ {error}</div>
    ) : null;

  if (fileBinary) {
    return (
      <div className="merge-panel">
        <div className="merge-toolbar">
          <span className="merge-path" title={path}>{path}</span>
          <span className="merge-binary-hint">二进制文件，无法三路对比</span>
          <span className="spacer" />
          <button className="ghost small" onClick={() => onOpenFile(path)}>在编辑器中处理…</button>
          <button className="ghost small" disabled={busy} onClick={onAbort}>放弃合并…</button>
        </div>
        <div className="empty-hint">请在编辑器中手动处理该文件后，回到「冲突」页点击「标记已解决」。</div>
      </div>
    );
  }

  if (whole) {
    // 整体模式：无冲突标记（单侧新增/删除冲突等），直接选择一侧作为解决结果
    const oursText = sides.ours;
    const theirsText = sides.theirs;
    const resultText =
      wholePick === "ours" ? oursText : wholePick === "theirs" ? theirsText : disk;
    const hasBoth = oursText !== null && theirsText !== null;
    const note = !parsed
      ? hasBoth
        ? "工作区内容无法预览（二进制或已删除）——可整侧采用本地/远程"
        : "单侧冲突：某一侧删除了此文件"
      : hasBoth
        ? "两版本都改动此文件（无冲突标记），请选择保留哪个"
        : "单侧冲突：某一侧删除了此文件";
    return (
      <div className="merge-panel">
        <div className="merge-toolbar">
          <span className="merge-path" title={path}>{path}</span>
          <span className="merge-note">{note}</span>
          <span className="spacer" />
          <button className="ghost small" onClick={() => onOpenFile(path)}>在编辑器中手动处理…</button>
          <button className="ghost small" disabled={busy} onClick={onAbort}>放弃合并…</button>
          <button
            disabled={busy}
            title="把选择/当前内容写回并暂存（标记已解决）"
            onClick={doResolve}
          >
            标记已解决
          </button>
        </div>
        {errFlash}
        <div className="m3-col-heads">
          <span>本地（HEAD）</span>
          <span>解决结果</span>
          <span>远程（合入方）</span>
        </div>
        <div className="m3-grid">
          <div className="m3-row whole">
            <div className="m3-cell">{oursText !== null ? clean(oursText) : "（此侧没有该文件）"}</div>
            <div className="m3-cell result">
              {resultText !== null && resultText !== undefined
                ? clean(resultText)
                : wholePick
                  ? "（该侧无内容）"
                  : "选择一侧后显示结果"}
            </div>
            <div className="m3-cell">{theirsText !== null ? clean(theirsText) : "（此侧没有该文件）"}</div>
          </div>
        </div>
        <div className="merge-whole-actions">
          <button className="ghost" disabled={oursText === null || busy} onClick={() => setWholePick("ours")}>
            ← 采用本地
          </button>
          <button className="ghost" disabled={theirsText === null || busy} onClick={() => setWholePick("theirs")}>
            采用远程 →
          </button>
          <span className="merge-note">（若已在编辑器中手动解决过，可直接点「标记已解决」）</span>
        </div>
      </div>
    );
  }

  // 逐块模式
  // 单行采纳结果：null=未采纳 / "ours"/"theirs"=采纳了某侧 / "both"=整块 Accept Both
  const rowSide = (id: number, rowIdx: number): "ours" | "theirs" | "both" | null => {
    const pick = picks[id];
    if (!pick) return null;
    if (pick.both) return "both";
    return pick.sides[rowIdx] ?? null;
  };
  const resultTextFor = (row: { t: "pair"; a: string | null; b: string | null }, side: "ours" | "theirs" | "both" | null): string | null => {
    if (side === "ours") return row.a;
    if (side === "theirs") return row.b;
    return null; // null 或 both → 不显示文本（both 的预览另作占位）
  };

  // 行数护栏：冲突文件太大时逐行三列渲染会拖垮 UI，引导去编辑器手动处理
  if (rows && rows.length > 8000) {
    return (
      <div className="merge-panel">
        <div className="merge-toolbar">
          <span className="merge-path" title={path}>{path}</span>
          <span className="merge-note">共 {totalBlocks} 处冲突（文件过大，共 {rows.length} 显示行）</span>
          <span className="spacer" />
          <button className="ghost small" onClick={() => onOpenFile(path)}>在编辑器中手动处理…</button>
          <button className="ghost small" disabled={busy} onClick={onAbort}>放弃合并…</button>
        </div>
        <div className="empty-hint">
          该文件超过逐行渲染上限。请在编辑器中删掉 &lt;&lt;&lt;&lt;&lt;&lt;&lt; / ======= / &gt;&gt;&gt;&gt;&gt;&gt;&gt;
          保留需要的内容并保存，然后回到「冲突」页点击「标记已解决」。
        </div>
      </div>
    );
  }

  return (
    <div className="merge-panel">
      <div className="merge-toolbar">
        <span className="merge-path" title={path}>{path}</span>
        <span className="merge-note">
          共 {totalBlocks} 处冲突 · 已采纳 {resolvedRows}/{totalRows} 行
        </span>
        <span className="spacer" />
        {/* IDEA 风格：Apply non-conflicting changes 迷你按钮组（»左 »«全部 «右） */}
        <span className="m3-tb-group">
          <span className="m3-tb-label">无冲突更改</span>
          <button
            className="m3-mini"
            title="只应用左侧（本地）的无冲突改动"
            disabled={busy}
            onClick={() => applyNonConf("ours")}
          >
            » 左
          </button>
          <button
            className="m3-mini"
            title="自动采纳所有不冲突的行：两侧内容相同的行、以及只有一侧有的独立改动；真冲突（两侧在同一位置各改了不同内容）保持未选"
            disabled={busy}
            onClick={() => applyNonConf("both")}
          >
            »« 全部
          </button>
          <button
            className="m3-mini"
            title="只应用右侧（远程）的无冲突改动"
            disabled={busy}
            onClick={() => applyNonConf("theirs")}
          >
            « 右
          </button>
        </span>
        <span className="m3-tb-sep" />
        <button className="ghost small" title="在编辑器中手动处理该文件" onClick={() => onOpenFile(path)}>编辑器…</button>
        <button className="ghost small" title="放弃本次合并，回到合并前状态" disabled={busy} onClick={onAbort}>放弃合并…</button>
      </div>
      {errFlash}
      {/* 逐块模式：表头与正文的行号列对齐（整体模式无行号，不加该类） */}
      <div className="m3-col-heads m3-col-heads-ln">
        <span>本地（HEAD）</span>
        <span>解决结果</span>
        <span>远程（合入方）</span>
      </div>
      <div className="m3-grid">
        {rows!.map((row, idx) => {
          if (row.t === "ctx") {
            return (
              <div key={idx} className="m3-row">
                <div className="m3-cell a ctx" title="上下文（三侧一致）">
                  <span className="m3-lineno">{row.no}</span>
                  <span className="m3-cell-text">{clean(row.line)}</span>
                </div>
                <div className="m3-cell result ctx">
                  <span className="m3-lineno">{row.no}</span>
                  <span className="m3-cell-text">{clean(row.line)}</span>
                </div>
                {/* b 窗前导槽位与 pair 行的 « 按钮对齐，保证三列文本起点一致 */}
                <div className="m3-cell b ctx">
                  <span className="m3-adopt-slot" />
                  <span className="m3-lineno">{row.no}</span>
                  <span className="m3-cell-text">{clean(row.line)}</span>
                </div>
              </div>
            );
          }
          if (row.t === "bar") {
            const pick = picks[row.id];
            const both = !!pick?.both;
            const blockRows = blockRowCounts[row.id] ?? 0;
            const resolvedRowsInBlock = pick
              ? (pick.both ? blockRows : pick.sides.filter((s) => s !== null).length)
              : 0;
            const allOurs = !both && !!pick && pick.sides.length > 0 && pick.sides.every((s) => s === "ours");
            const allTheirs = !both && !!pick && pick.sides.length > 0 && pick.sides.every((s) => s === "theirs");
            return (
              <div key={idx} className={`m3-block-bar ${pick ? "done" : ""}`}>
                {/* 块级采纳按钮贴在窗格分界处（IDEA 的小 » «，默认灰、悬停亮起） */}
                <div className="m3-block-side left">
                  <button
                    className={`m3-mini m3-block-accept ${allOurs ? "done" : ""}`}
                    disabled={busy}
                    title="整块采纳本地（HEAD）"
                    onClick={() => pickBlock(row.id, "ours")}
                  >
                    »
                  </button>
                </div>
                {/* 中间：冲突编号 + 状态 + 两个迷你操作 */}
                <div className="m3-block-mid">
                  <span className="m3-block-no">冲突 {row.id + 1}/{totalBlocks}</span>
                  {both ? (
                    <span className="m3-block-state">两侧都留</span>
                  ) : pick && resolvedRowsInBlock > 0 ? (
                    <span className="m3-block-state">已采纳 {resolvedRowsInBlock}/{blockRows} 行</span>
                  ) : (
                    <span className="m3-block-state pending">未解决</span>
                  )}
                  <button
                    className={`m3-mini ${both ? "done" : ""}`}
                    disabled={busy || both}
                    title="两侧都留（Accept Both）：ours 与 theirs 全部按顺序纳入结果"
                    onClick={() => pickBlockBoth(row.id)}
                  >
                    ⊕
                  </button>
                  <button
                    className="m3-mini"
                    disabled={busy || both}
                    title="只对本块应用无冲突的更改（两侧相同 / 单侧独立改动自动采纳，真冲突保留）"
                    onClick={() => applyBlockNonConf(row.id)}
                  >
                    ⇥
                  </button>
                </div>
                <div className="m3-block-side right">
                  <button
                    className={`m3-mini m3-block-accept ${allTheirs ? "done" : ""}`}
                    disabled={busy}
                    title="整块采纳远程（合入方）"
                    onClick={() => pickBlock(row.id, "theirs")}
                  >
                    «
                  </button>
                </div>
              </div>
            );
          }
          const side = rowSide(row.id, row.rowIdx);
          const rText = resultTextFor(row, side);
          // clash=真冲突（红）；单侧孤儿=独立改动（绿）；common=两侧一致（无底色）
          const cls = row.common
            ? "m3-row"
            : row.clash
              ? "m3-row clash"
              : row.a !== null
                ? "m3-row change ours-only"
                : "m3-row change theirs-only";
          // 中间结果列行号：采纳后跟随采纳侧的源行号；未采纳（含 common 未决）为空
          const midNo =
            side === "ours" || side === "both"
              ? row.aNo || row.bNo
              : side === "theirs"
                ? row.bNo || row.aNo
                : 0;
          // 按钮只出现在改动区（region >= 0）区首对应侧有内容的行：
          // » = 采纳整个改动区的本地内容，« = 采纳整个改动区的远程内容（IDEA 交互）
          const showOurs = row.region >= 0 && row.firstA;
          const showTheirs = row.region >= 0 && row.firstB;
          // 按钮的「已采纳」状态按整区判定：区内所有行都采纳了同一侧才亮绿
          const regRows = row.region >= 0 ? blockRegions[row.id]?.[row.region] : undefined;
          const regPick = regRows ? picks[row.id] : undefined;
          const regAllOurs =
            !!regRows && !!regPick && !regPick.both && regRows.every((r) => regPick.sides[r] === "ours");
          const regAllTheirs =
            !!regRows && !!regPick && !regPick.both && regRows.every((r) => regPick.sides[r] === "theirs");
          // common 行两侧相同视为已采纳（初始化即 ours），中列直接显示文本且不上绿底
          const adoptedCls = side && !row.common ? " adopted" : "";
          return (
            <div key={idx} className={cls}>
              {/* 左窗格：行号 + 文本 + 内缘 »（采纳整区本地）——按钮贴在窗格分界处 */}
              <div className={`m3-cell a${row.common ? " common" : ""}`}>
                <span className="m3-lineno">{row.aNo || ""}</span>
                <span className="m3-cell-text">{row.a !== null ? clean(row.a) : ""}</span>
                {showOurs && (
                  <button
                    className={`m3-adopt ours${regAllOurs ? " picked" : ""}`}
                    disabled={busy}
                    title="采纳此改动的本地版本（整段进入中间结果列）"
                    onClick={() => pickRegion(row.id, row.region, "ours")}
                  >
                    »
                  </button>
                )}
              </div>
              {/* 中间结果列：只显示行号 + 结果文本，保持纯净（对齐 IDEA 的可编辑结果窗格） */}
              <div className={`m3-cell result${adoptedCls}`}>
                <span className="m3-lineno">{midNo || ""}</span>
                <span className="m3-cell-text">
                  {side === "both"
                    ? <span className="m3-void">⊕</span>
                    : rText !== null
                      ? clean(rText)
                      : <span className="m3-void">·</span>}
                </span>
              </div>
              {/* 右窗格：内缘 «（采纳整区远程）+ 行号 + 文本 */}
              <div className={`m3-cell b${row.common ? " common" : ""}`}>
                {showTheirs && (
                  <button
                    className={`m3-adopt theirs${regAllTheirs ? " picked" : ""}`}
                    disabled={busy}
                    title="采纳此改动的远程版本（整段进入中间结果列）"
                    onClick={() => pickRegion(row.id, row.region, "theirs")}
                  >
                    «
                  </button>
                )}
                <span className="m3-lineno">{row.bNo || ""}</span>
                <span className="m3-cell-text">{row.b !== null ? clean(row.b) : ""}</span>
              </div>
            </div>
          );
        })}
      </div>
      {/* IDEA 风格底栏：Accept Left/Right 类操作在左，主操作「标记已解决」在右 */}
      <div className="merge-bottombar">
        <button className="ghost small" title="所有冲突块都整块采纳本地（HEAD）" disabled={busy} onClick={() => pickAll("ours")}>全部采用本地 »</button>
        <button className="ghost small" title="所有冲突块都整块采纳远程（合入方）" disabled={busy} onClick={() => pickAll("theirs")}>« 全部采用远程</button>
        <button className="ghost small" title="所有冲突块都「两侧都留」——ours 与 theirs 都纳入结果" disabled={busy} onClick={pickAllBoth}>全部接受两侧</button>
        <span className="spacer" />
        <span className="merge-tip-inline">改动区首行 » / « 一次采纳整段 · ⊕ 两侧都留 · ⇥ 应用无冲突</span>
        <button
          disabled={busy || !allResolved}
          title={allResolved ? "写回合并结果并暂存（标记已解决）" : `还有 ${totalRows - resolvedRows} 行待采纳`}
          onClick={doResolve}
        >
          标记已解决
        </button>
      </div>
    </div>
  );
}

// ---------- 布局拖拽分割 ----------

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 数值 state 持久化到 localStorage（拖动过的布局尺寸重开应用保持） */
function usePersistentNumber(key: string, def: number): [number, (v: number) => void] {
  const [v, setV] = useState(() => {
    const n = Number(localStorage.getItem(key));
    return Number.isFinite(n) && n > 0 ? n : def;
  });
  const set = (nv: number) => {
    setV(nv);
    localStorage.setItem(key, String(nv));
  };
  return [v, set];
}

/** 通用拖拽：pointerdown + setPointerCapture 把事件捕获到元素自身
 * （比 window mousemove 在 WebView2 里更可靠），期间锁定光标与文本选中 */
function startDrag(e: React.PointerEvent<HTMLElement>, cursor: string, onMove: (ev: PointerEvent) => void) {
  e.preventDefault();
  const el = e.currentTarget;
  el.setPointerCapture(e.pointerId);
  document.body.style.cursor = cursor;
  document.body.style.userSelect = "none";
  const move = (ev: PointerEvent) => onMove(ev);
  const end = () => {
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", end);
    el.removeEventListener("pointercancel", end);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  };
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
}

// ---------- 中栏标签页 ----------
//
// history 是固定首页签（提交历史，不可关闭）；file = 文件树预览；wdiff = 「更改」单文件对比。
// 内容按需加载并缓存到 tabData（key = kind:path），refresh 时整体失效重拉。

type CenterTab =
  | { kind: "history" }
  | { kind: "file"; path: string }
  | { kind: "wdiff"; path: string }
  | { kind: "merge"; path: string };

function tabKey(t: CenterTab): string {
  return t.kind === "history" ? "history" : `${t.kind}:${t.path}`;
}

function tabLabel(t: CenterTab): string {
  if (t.kind === "history") return "提交历史";
  const base = t.path.split("/").pop() ?? t.path;
  if (t.kind === "wdiff") return `对比 ${base}`;
  if (t.kind === "merge") return `解决冲突 ${base}`;
  return base;
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
  // 合并冲突文件列表（merge 进行中才有；无冲突时空数组）
  const [conflicts, setConflicts] = useState<ConflictFile[]>([]);
  const [consoleText, setConsoleText] = useState("");
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [opBusy, setOpBusy] = useState<string | null>(null); // 当前正在执行的远程操作
  const [pathMenuOpen, setPathMenuOpen] = useState(false); // 路径显示框（已开仓库时）点击弹出的统一菜单
  const [recentMenuIndex, setRecentMenuIndex] = useState(0); // 菜单里键盘高亮的那一项
  const pathMenuRef = useRef<HTMLDivElement>(null); // 包住显示框 + 菜单的容器
  const [leftTab, setLeftTab] = useState<"branches" | "files" | "conflicts">("branches"); // 左栏顶部 tab：分支树 / 文件树 / 冲突
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
  // 提交历史右键菜单（复制 hash / 提交信息）
  const [commitCtx, setCommitCtx] = useState<{ x: number; y: number; oid: string; summary: string } | null>(null);
  // 分支树右键菜单 + 重命名弹窗
  const [branchCtx, setBranchCtx] = useState<{ x: number; y: number; name: string } | null>(null);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  // Stash 区默认折叠（低频功能），点标题展开
  const [stashOpen, setStashOpen] = useState(false);
  // 文件标签：默认高亮预览，点「编辑」才切到可编辑文本框
  const [fileEditMode, setFileEditMode] = useState(false);
  // 布局尺寸（可拖动，localStorage 记忆）：左栏宽度 / 右栏占比 / 控制台高度
  const [leftW, setLeftW] = usePersistentNumber("gm.leftW", 260);
  const [rightShare, setRightShare] = usePersistentNumber("gm.rightShare", 0.545);
  const [consoleH, setConsoleH] = usePersistentNumber("gm.consoleH", 180);
  const workspaceRowRef = useRef<HTMLDivElement>(null);
  // 提交历史分页：默认 300 条，列表底部「加载更多」每次 +300
  const [logLimit, setLogLimit] = useState(300);

  const refresh = useCallback(async () => {
    if (!repo) return;
    try {
      const [bs, log, t, st, s, ab, sk, cf] = await Promise.all([
        invoke<BranchInfo[]>("list_branches"),
        invoke<CommitInfo[]>("get_log", {
          limit: logLimit,
          branch: filterBranch || null,
          query: filterQuery.trim() || null,
        }),
        invoke<string[]>("get_head_tree"),
        invoke<StatusItem[]>("get_status"),
        invoke<StashEntry[]>("stash_list"),
        invoke<[number, number] | null>("get_ahead_behind"),
        invoke<string[]>("get_skip_list"),
        invoke<ConflictFile[]>("get_conflicts"),
      ]);
      setBranches(bs);
      setCommits(log);
      setTree(t);
      setStatus(st);
      setStashes(s);
      setSyncCounts(ab);
      setSkipList(sk);
      setConflicts(cf);
      // 已打开的文件/对比标签内容可能已过时，清空缓存让激活标签重拉
      setTabData({});
    } catch (e) {
      setError(String(e));
    }
  }, [repo, filterBranch, filterQuery, logLimit]);

  // ---------- 中栏标签页 ----------

  function openCenterTab(kind: "file" | "wdiff" | "merge", path: string) {
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

  // 激活的文件/对比标签按需加载内容（结果缓存进 tabData，refresh 时清空重拉）。
  // merge 标签内容由 MergePanel 自管（需要结构化 sides + 逐块选择状态），不走 tabData
  useEffect(() => {
    if (!activeT || activeT.kind === "history" || activeT.kind === "merge") return;
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

  // 切换标签时回到预览模式
  useEffect(() => {
    setFileEditMode(false);
  }, [activeKey]);

  // 过滤条件变化时重置回第一页
  useEffect(() => {
    setLogLimit(300);
  }, [filterBranch, filterQuery]);

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
      setConflicts([]);
      setCtxMenu(null);
      setLogLimit(300);
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
      setConflicts([]);
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

  // 重命名本地分支
  async function doRenameBranch() {
    if (!renameTarget || !renameValue.trim() || renameValue.trim() === renameTarget) {
      setRenameTarget(null);
      return;
    }
    try {
      await invoke("rename_branch", { old: renameTarget, new: renameValue.trim() });
      setRenameTarget(null);
      await refresh();
    } catch (e) {
      setError(String(e));
      setRenameTarget(null);
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
      // pull 可能已把仓库带进合并冲突状态——无论成败都刷新，让「冲突」入口及时出现
      await refresh();
    } finally {
      setOpBusy(null);
    }
  }

  // 放弃合并/变基：git merge --abort / git rebase --abort（后端按仓库状态自动选）
  async function doAbortMerge() {
    if (!confirm("放弃当前合并/变基？\n所有冲突解决进度都会丢失，工作区回到操作前状态。")) return;
    try {
      const msg = await invoke<string>("abort_merge");
      setConsoleText(msg);
      setConsoleOpen(true);
      // 仓库已回滚，冲突面板标签全部失效，关掉回到提交历史
      const kept = tabs.filter((t) => t.kind !== "merge");
      setTabs(kept.length ? kept : [{ kind: "history" }]);
      setActiveTab(0);
      await refresh();
    } catch (e) {
      setError(String(e));
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
        // 布局：左栏 | 拖动条 | 工作区列（中栏+右栏在上，控制台在下）
        <div className="main" style={{ gridTemplateColumns: `${leftW}px 5px 1fr` }}>
          {/* 左栏：文件树 + 工作区状态 */}
          <aside className="pane left">
            {/* 顶部 tab：分支树（默认，IDEA 风格）/ 文件树 / 冲突（有冲突时红色提醒） */}
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
              <button
                className={`left-tab ${leftTab === "conflicts" ? "active" : ""} ${conflicts.length > 0 ? "alert" : ""}`}
                onClick={() => setLeftTab("conflicts")}
                title={
                  conflicts.length > 0
                    ? `合并冲突：${conflicts.length} 个文件待解决`
                    : "合并冲突（无冲突时无内容）"
                }
              >
                冲突{conflicts.length > 0 ? `（${conflicts.length}）` : ""}
              </button>
            </div>
            <div className="pane-body">
              {leftTab === "conflicts" ? (
                <div className="conflict-tree">
                  <div className="conflict-head">
                    <span>
                      {conflicts.length > 0
                        ? `合并进行中 — ${conflicts.length} 个文件冲突`
                        : "当前没有合并冲突"}
                    </span>
                    {conflicts.length > 0 && (
                      <button
                        className="ghost xsmall danger-text"
                        title="git merge --abort（变基中为 git rebase --abort），放弃后所有解决进度丢失"
                        onClick={doAbortMerge}
                      >
                        放弃合并…
                      </button>
                    )}
                  </div>
                  {conflicts.length === 0 && <div className="empty-hint">没有需要解决的冲突</div>}
                  {conflicts.map((c) => (
                    <div
                      key={c.path}
                      className="status-item clickable"
                      title={`${c.path}（点击打开三路合并面板）`}
                      onClick={() => openCenterTab("merge", c.path)}
                    >
                      <span className="status-badge st-conflict">!</span>
                      <span className="conflict-path">{c.path}</span>
                      <span
                        className="conflict-type"
                        title={
                          c.hasOurs && c.hasTheirs
                            ? "两侧都修改了此文件"
                            : c.hasTheirs
                              ? "仅合入方有该文件（本地删除/未新增）"
                              : "仅本地有该文件（合入方删除）"
                        }
                      >
                        {c.hasOurs && c.hasTheirs ? "双改" : c.hasTheirs ? "仅远程" : "仅本地"}
                      </span>
                      <button
                        className="chip-x"
                        title="在编辑器中手动处理（逐字修改冲突标记）"
                        onClick={(e) => {
                          e.stopPropagation();
                          openCenterTab("file", c.path);
                        }}
                      >
                        ✎
                      </button>
                    </div>
                  ))}
                </div>
              ) : leftTab === "files" ? (
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
                      title={b.isHead ? "当前分支（右键更多操作）" : `点击切换到 ${b.name}（右键更多操作）`}
                      onClick={() => !b.isHead && checkoutBranch(b.name)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setBranchCtx({ x: e.clientX, y: e.clientY, name: b.name });
                      }}
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

            <div
              className="pane-title clickable"
              title={stashOpen ? "点击折叠" : "点击展开"}
              onClick={() => setStashOpen((o) => !o)}
            >
              {stashOpen ? "▾" : "▸"} Stash（{stashes.length}）
            </div>
            {stashOpen && (
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
            )}
          </aside>

          {/* 左栏|工作区 拖动条（双击恢复默认 260px） */}
          <div
            className="divider-v"
            title="拖动调整左栏宽度（双击恢复默认）"
            onPointerDown={(e) => {
              const start = leftW;
              const startX = e.clientX;
              startDrag(e, "col-resize", (ev) =>
                setLeftW(clamp(start + ev.clientX - startX, 180, 480))
              );
            }}
            onDoubleClick={() => setLeftW(260)}
          />

          {/* 工作区列：上 = 中栏+右栏，下 = 控制台 */}
          <div className="workspace-col">
            {/* 文件/对比标签激活时右栏整栏隐藏，中栏工作区撑满（编辑器形态） */}
            <div
              ref={workspaceRowRef}
              className={`workspace-row ${activeT?.kind !== "history" ? "no-right" : ""}`}
              style={
                activeT?.kind !== "history"
                  ? undefined
                  : { gridTemplateColumns: `${1 - rightShare}fr 5px ${rightShare}fr` }
              }
            >
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
                {activeT.kind === "merge" ? (
                  <MergePanel
                    path={activeT.path}
                    onOpenFile={(p) => openCenterTab("file", p)}
                    onResolved={async () => {
                      // 已写回并暂存：刷新状态；若该文件不在冲突列表里了就关掉这个面板 tab
                      await refresh();
                      closeTab(activeTab);
                    }}
                    onAbort={doAbortMerge}
                  />
                ) : tabData[activeKey] === undefined ? (
                  <div className="empty-hint">加载中…</div>
                ) : activeT.kind === "file" ? (
                  <div className="file-edit-wrap">
                    <div className="file-edit-bar">
                      <span className="file-edit-path" title={activeT.path}>
                        {activeT.path}
                      </span>
                      <button
                        className={`ghost small ${fileEditMode ? "" : "on"}`}
                        title="语法高亮只读预览"
                        onClick={() => setFileEditMode(false)}
                      >
                        预览
                      </button>
                      <button
                        className={`ghost small ${fileEditMode ? "on" : ""}`}
                        title="纯文本编辑（无高亮）"
                        onClick={() => setFileEditMode(true)}
                      >
                        编辑
                      </button>
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
                    {fileEditMode ? (
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
                    ) : (
                      // 预览也展示草稿内容（若有未保存修改），保证所见即所得
                      <HighlightedCode
                        code={tabDrafts[activeKey] ?? tabData[activeKey]}
                        path={activeT.path}
                      />
                    )}
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
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setSelected(c.oid);
                    setCommitCtx({ x: e.clientX, y: e.clientY, oid: c.oid, summary: c.summary });
                  }}
                >
                  <div className="commit-row">
                    <CommitGraph row={graphRows[i]} laneCount={laneCount} />
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
              {/* 返回条数打满说明可能还有更早的历史 */}
              {commits.length >= logLimit && (
                <button className="load-more" onClick={() => setLogLimit((l) => l + 300)}>
                  加载更多（再 300 条）
                </button>
              )}
            </div>
              </>
            )}
          </section>

          {/* 中栏|右栏 拖动条（双击恢复默认占比）；右栏隐藏时不渲染 */}
          {activeT?.kind === "history" && (
            <div
              className="divider-v"
              title="拖动调整中/右栏比例（双击恢复默认）"
              onPointerDown={(e) => {
                const row = workspaceRowRef.current;
                if (!row) return;
                const rect = row.getBoundingClientRect();
                startDrag(e, "col-resize", (ev) =>
                  setRightShare(clamp((rect.right - ev.clientX) / rect.width, 0.25, 0.7))
                );
              }}
              onDoubleClick={() => setRightShare(0.545)}
            />
          )}

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

            {/* 控制台|工作区 横向拖动条（仅展开时可拖，双击恢复默认 180px） */}
            {consoleOpen && (
              <div
                className="divider-h"
                title="拖动调整控制台高度（双击恢复默认）"
                onPointerDown={(e) => {
                  const start = consoleH;
                  const startY = e.clientY;
                  startDrag(e, "row-resize", (ev) =>
                    setConsoleH(clamp(start - (ev.clientY - startY), 100, 400))
                  );
                }}
                onDoubleClick={() => setConsoleH(180)}
              />
            )}

            {/* 控制台：压在工作区列底部（不压左栏），标题栏图标折叠/展开 */}
            <div className={`console-bar ${consoleOpen ? "open" : ""}`}>
              <div
                className="console-head draggable"
                title="拖动调整高度（折叠时向上拖直接展开），双击恢复默认"
                onPointerDown={(e) => {
                  // 点在按钮上不触发拖拽
                  if ((e.target as HTMLElement).closest("button")) return;
                  const start = consoleH;
                  const startY = e.clientY;
                  const wasOpen = consoleOpen;
                  if (!wasOpen) setConsoleOpen(true); // 折叠时拖动直接展开
                  startDrag(e, "row-resize", (ev) =>
                    setConsoleH(clamp((wasOpen ? start : 180) - (ev.clientY - startY), 100, 400))
                  );
                }}
                onDoubleClick={(e) => {
                  if ((e.target as HTMLElement).closest("button")) return;
                  setConsoleH(180);
                }}
              >
                <span>控制台输出</span>
                <div className="console-tools">
                  {consoleOpen && (
                    <button
                      className="ghost small"
                      onClick={() => setConsoleText("")}
                      title="清空"
                    >
                      清空
                    </button>
                  )}
                  <button
                    className="ghost small"
                    onClick={() => setConsoleOpen((o) => !o)}
                    title={consoleOpen ? "折叠控制台" : "展开控制台"}
                  >
                    {consoleOpen ? "▾" : "▴"}
                  </button>
                </div>
              </div>
              {consoleOpen && (
                <pre className="console-body" style={{ height: consoleH }}>
                  {consoleText || "(空)"}
                </pre>
              )}
            </div>
          </div>
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

      {/* 提交历史右键菜单 */}
      {commitCtx && (
        <div
          className="ctx-overlay"
          onClick={() => setCommitCtx(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setCommitCtx(null);
          }}
        >
          <div
            className="ctx-menu"
            style={{ left: commitCtx.x, top: commitCtx.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="recent-menu-item"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(commitCtx.oid);
                } catch {
                  setError("复制失败：剪贴板不可用");
                }
                setCommitCtx(null);
              }}
            >
              ⧉ 复制完整 hash
            </button>
            <button
              className="recent-menu-item"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(commitCtx.summary);
                } catch {
                  setError("复制失败：剪贴板不可用");
                }
                setCommitCtx(null);
              }}
            >
              ⧉ 复制提交信息
            </button>
          </div>
        </div>
      )}

      {/* 分支树右键菜单 */}
      {branchCtx && (
        <div
          className="ctx-overlay"
          onClick={() => setBranchCtx(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setBranchCtx(null);
          }}
        >
          <div
            className="ctx-menu"
            style={{ left: branchCtx.x, top: branchCtx.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="recent-menu-item"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(branchCtx.name);
                } catch {
                  setError("复制失败：剪贴板不可用");
                }
                setBranchCtx(null);
              }}
            >
              ⧉ 复制分支名
            </button>
            <button
              className="recent-menu-item"
              onClick={() => {
                setRenameTarget(branchCtx.name);
                setRenameValue(branchCtx.name);
                setBranchCtx(null);
              }}
            >
              ✎ 重命名分支…
            </button>
          </div>
        </div>
      )}

      {/* 分支重命名弹窗 */}
      {renameTarget && (
        <div className="ctx-overlay dim" onClick={() => setRenameTarget(null)}>
          <div className="confirm-box" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-title" style={{ color: "var(--accent)" }}>
              重命名分支
            </div>
            <div className="confirm-path">{renameTarget}</div>
            <input
              className="rename-input"
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") doRenameBranch();
                if (e.key === "Escape") setRenameTarget(null);
              }}
            />
            <div className="confirm-actions">
              <button
                onClick={doRenameBranch}
                disabled={!renameValue.trim() || renameValue.trim() === renameTarget}
              >
                重命名
              </button>
              <button className="ghost" onClick={() => setRenameTarget(null)}>
                取消
              </button>
            </div>
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

    </div>
  );
}

export default App;
