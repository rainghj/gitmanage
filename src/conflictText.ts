// 冲突标记文本解析与行对齐 —— 纯函数模块（无 React 依赖，可独立单元测试）
//
// 磁盘上的冲突文件带 <<<<<<< / ======= / >>>>>>> 标记，把它解析成「普通段 + 冲突块」序列：
//  - 普通段：三侧相同，逐行透传
//  - 冲突块：git 只在该块的两侧内容都不同时给标记；块内再做行级对齐，
//    让「本地/远程」两列同行对比。

export type M3Seg =
  | { kind: "text"; lines: string[] }
  | { kind: "conflict"; id: number; ours: string[]; theirs: string[] };

/** 解析冲突标记文本 → (eol, segments)。raw 的末尾换行做规范化处理，保证可逆还原。 */
export function parseConflictText(raw: string): { eol: string; segs: M3Seg[] } {
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const content = raw.endsWith(eol) ? raw : raw + eol; // 统一视为以 eol 结尾
  const lines = content.slice(0, -eol.length).split(eol); // 尾无空串，行内无 eol
  const segs: M3Seg[] = [];
  let cur: string[] | null = null;
  const flush = () => {
    if (cur && cur.length) {
      segs.push({ kind: "text", lines: cur });
      cur = null;
    }
  };
  let i = 0;
  let conflictId = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("<<<<<<<")) {
      flush();
      const ours: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("=======")) {
        ours.push(lines[i]);
        i++;
      }
      if (i >= lines.length) break; // 损坏的标记：无分隔行，终止
      i++;
      const theirs: string[] = [];
      while (i < lines.length && !lines[i].startsWith(">>>>>>>")) {
        theirs.push(lines[i]);
        i++;
      }
      if (i >= lines.length) break;
      i++;
      segs.push({ kind: "conflict", id: conflictId++, ours, theirs });
    } else {
      (cur ??= []).push(line);
      i++;
    }
  }
  flush();
  return { eol, segs };
}

/** 冲突块内行级对齐：贪心双指针，把相同行配对，不同行各自落单。返回行流 [(aIdx|null, bIdx|null)] */
export function alignLines(a: string[], b: string[]): [number | null, number | null][] {
  const rows: [number | null, number | null][] = [];
  let ia = 0;
  let ib = 0;
  const n = a.length;
  const m = b.length;
  while (ia < n && ib < m) {
    if (a[ia] === b[ib]) {
      rows.push([ia, ib]);
      ia++;
      ib++;
    } else {
      const nextB = b.indexOf(a[ia], ib); // a[ia] 出现在 b里的最近位置
      const nextA = a.indexOf(b[ib], ia);
      if (nextB !== -1 && (nextA === -1 || nextB - ib <= nextA - ia)) {
        while (ib < nextB) {
          rows.push([null, ib]);
          ib++;
        }
      } else if (nextA !== -1) {
        while (ia < nextA) {
          rows.push([ia, null]);
          ia++;
        }
      } else {
        // 两端都找不到对方后续出现的行（无跨行跳转线索）：当前两行各判孤儿，
        // 只前进一步，让后续相同的行（如空行/重复行）仍能自然配对
        rows.push([ia, null]);
        ia++;
        rows.push([null, ib]);
        ib++;
      }
    }
  }
  while (ia < n) {
    rows.push([ia, null]);
    ia++;
  }
  while (ib < m) {
    rows.push([null, ib]);
    ib++;
  }
  return rows;
}

/** 单个冲突块的采纳状态：按行级别存放 + 是否「Accept Both」整块两侧都纳入 */
export type RowPick = {
  /** 长度 = alignLines 输出的 row 数；null = 该展示行尚未采纳 */
  sides: ("ours" | "theirs" | null)[];
  /** 整块「两侧都留」——为 true 时忽略 sides，把 ours + theirs 全部按顺序写结果 */
  both: boolean;
};

/** 整文件所有冲突块的用户选择，键 = seg.id */
export type Picks = Record<number, RowPick>;

/** 构造每个冲突块的初始 picks（sides 数组按对齐后行数填 null） */
export function emptyPicks(blocks: number, rowCount = 0): Picks {
  const o: Picks = {};
  for (let i = 0; i < blocks; i++) o[i] = { sides: new Array(rowCount).fill(null), both: false };
  return o;
}

/**
 * 按各冲突块的选择拼出完整文件内容。
 *  - Accept Both：该块 ours 全部行 + eol + theirs 全部行
 *  - 行级：按 alignLines 输出顺序，对每 row 应用 sides[i]
 *      · sides[i] = 'ours' 且该 row 有 ours 内容 → 输出 seg.ours[ai]
 *      · sides[i] = 'theirs' 且该 row 有 theirs 内容 → 输出 seg.theirs[bi]
 *      · sides[i] = 'ours' 但 ai===null（整块采纳某侧时遇到跨侧孤儿） → 跳过
 *      · sides[i] = null：
 *          - 两侧都无内容 → 跳过（理论上极少见）
 *          - 至少一侧有内容 → 视为未采纳，返回 null 防止半成品写回
 *  - common pair 行配对：a===b 同一行索引，一次设置 sides[idx] 覆盖两列内容
 */
export function buildResultText(
  segs: M3Seg[],
  picks: Picks,
  eol: string,
): string | null {
  const parts: string[] = [];
  for (const seg of segs) {
    if (seg.kind === "text") {
      parts.push(seg.lines.join(eol));
      continue;
    }

    const pick = picks[seg.id];
    if (!pick) return null; // 没有初始化的 picks（兜底）
    if (pick.both) {
      // Accept Both：先 ours 全部行 + eol + theirs 全部行
      const oursPart = seg.ours.length ? seg.ours.join(eol) : "";
      const theirsPart = seg.theirs.length ? seg.theirs.join(eol) : "";
      const joined =
        oursPart && theirsPart
          ? oursPart + eol + theirsPart
          : oursPart || theirsPart;
      parts.push(joined);
      continue;
    }
    // 行级采纳：按 alignLines 输出顺序决定每行去留
    const aligned = alignLines(seg.ours, seg.theirs);
    const out: string[] = [];
    for (let i = 0; i < aligned.length; i++) {
      const s = pick.sides[i] ?? null;
      const [ai, bi] = aligned[i];
      const hasOurs = ai !== null;
      const hasTheirs = bi !== null;
      if (s === null) {
        if (!hasOurs && !hasTheirs) continue;
        return null;
      }
      if (s === "ours" && hasOurs) out.push(seg.ours[ai]);
      else if (s === "theirs" && hasTheirs) out.push(seg.theirs[bi]);
      // else: 选了某侧但该 row 没有此内容（整块采纳时的跨侧孤儿）—— 静默跳过
    }
    parts.push(out.join(eol));
  }
  return parts.join(eol) + eol;
}

/**
 * 「应用无冲突的更改」——把能安全自动采纳的行填上，真正冲突的行留空等人决策。
 *
 * 判据（对齐 IDEA 的 Apply non-conflicting changes）：
 *  - common pair 行（两侧内容相同）→ 安全，采纳
 *  - 连续孤儿区（不含 common 行的一段）里只有一侧有内容 → 该侧是独立改动，采纳
 *  - 连续孤儿区里两侧都有内容 → 两侧在同一位置各改了不同内容 = 真冲突，保留空（不覆盖用户已决策）
 *
 * @param direction both=两侧都应用；ours=只应用左侧改动；theirs=只应用右侧改动
 * @param blockId   指定时只作用于该冲突块（块级按钮用），其余块原样保留
 */
export function applyNonConflicting(
  segs: M3Seg[],
  picks: Picks,
  direction: "both" | "ours" | "theirs" = "both",
  blockId?: number,
): Picks {
  const next: Picks = {};
  for (const seg of segs) {
    if (seg.kind !== "conflict") continue;
    if (blockId !== undefined && seg.id !== blockId) {
      next[seg.id] = picks[seg.id] ?? { sides: [], both: false };
      continue;
    }
    const cur = picks[seg.id];
    if (cur?.both) {
      next[seg.id] = cur; // 整块 Accept Both 已决策，跳过
      continue;
    }
    const aligned = alignLines(seg.ours, seg.theirs);
    const sides = (cur?.sides ?? []).slice();
    while (sides.length < aligned.length) sides.push(null);
    const isCommon = (r: [number | null, number | null]) => r[0] !== null && r[1] !== null;

    let i = 0;
    while (i < aligned.length) {
      if (isCommon(aligned[i])) {
        // 两侧内容相同，无争议（ours === theirs，取哪边都一样）
        if (sides[i] === null) sides[i] = "ours";
        i++;
        continue;
      }
      // 收集一段连续孤儿区（到下一个 common 行或末尾为止）
      let j = i;
      let hasOurs = false;
      let hasTheirs = false;
      while (j < aligned.length && !isCommon(aligned[j])) {
        if (aligned[j][0] !== null) hasOurs = true;
        if (aligned[j][1] !== null) hasTheirs = true;
        j++;
      }
      if (hasOurs && hasTheirs) {
        // 两侧在同一位置各改了不同内容 → 真冲突，保留用户既有选择（未选则仍为 null）
      } else if (hasOurs || hasTheirs) {
        // 只有一侧有内容 = 该侧的独立改动
        const side: "ours" | "theirs" = hasOurs ? "ours" : "theirs";
        if (direction === "both" || direction === side) {
          for (let k = i; k < j; k++) if (sides[k] === null) sides[k] = side;
        }
      }
      i = j;
    }
    next[seg.id] = { sides, both: false };
  }
  return next;
}