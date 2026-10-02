'use strict';

/*
 * 智能 Tab 跳出（smart tab）
 *
 * 找出光标所处的「最内层结构」，按 Tab 跳到它的闭合符之后；嵌套时可以逐层跳出：
 *
 *     {{0}|1}2     Tab → 1（内层 } 之后）  再 Tab → 2（外层 } 之后）
 *
 * 支持的结构：
 *     { … }   [ … ]   ( … )            —— 普通括号
 *     \{ … \}   \[ … \]   \( … \)      —— 转义括号
 *     \begin{env} … \end{env}          —— 环境（含 \begin{theorem}[可选参数] 里的 [ ]）
 *
 * 会忽略：
 *     % 注释里的内容；verbatim / lstlisting / minted / comment 等原样环境里的内容。
 *
 * 说明：这里只做「闭合符配对 + 光标归属」的纯计算，不依赖 vscode，便于单独测试。
 */

const VERBATIM_ENVS = new Set([
  'verbatim', 'verbatim*', 'lstlisting', 'lstlisting*', 'minted', 'comment', 'Verbatim',
]);

const ENV_RE = /\\(begin|end)\{([^}]*)\}/y;

// 括号家族：\{ 与 { 算同一家族（\ 只是转义，不改变配对关系）
const FAMILY = {
  brace: 'brace', ebrace: 'brace',
  brack: 'brack', ebrack: 'brack',
  paren: 'paren', eparen: 'paren',
};

// text[i] 是不是被反斜杠转义的字符（\\{ 里的 { 不算转义，那只是换行命令后跟括号）
function isEscaped(text, i) {
  if (i <= 0 || text[i - 1] !== '\\') return false;
  return !(i >= 2 && text[i - 2] === '\\');
}

/**
 * 求「从 offset 处按 Tab 应该跳到哪」。
 * @param {string} text 文档全文
 * @param {number} offset 光标偏移
 * @param {{environments?: boolean, parentheses?: boolean, skipEnvs?: string[], newlineAfterEnv?: boolean}} [options]
 * @returns {{offset: number, kind: string, env: string|null} | null} 跳转目标（闭合符之后）；没有可跳的结构时返回 null
 */
function findJumpTarget(text, offset, options) {
  const opts = options || {};
  const useEnv = opts.environments !== false;
  const useParen = opts.parentheses !== false;
  const newlineAfterEnv = opts.newlineAfterEnv !== false;
  // 「不算结构」的环境：默认排除 document —— 否则在正文任何地方按 Tab 都会跳到文件末尾的 \end{document}
  const skipEnvs = new Set(opts.skipEnvs || ['document']);
  if (typeof text !== 'string' || !Number.isFinite(offset)) return null;
  if (offset < 0 || offset > text.length) return null;
  if (text.length > 1000000) return null;   // 超大文件直接不参与，避免卡顿

  const stack = [];
  const pairs = [];

  function push(openStart, openEnd, kind, env) {
    stack.push({ openStart, openEnd, kind, env: env || null, closeStart: -1, closeEnd: -1 });
  }

  function close(family, closeStart, closeEnd) {
    for (let k = stack.length - 1; k >= 0; k -= 1) {
      if (FAMILY[stack[k].kind] !== family) continue;
      const p = stack[k];
      p.closeStart = closeStart;
      p.closeEnd = closeEnd;
      pairs.push(p);
      stack.length = k;   // 中间那些没配上的开符号属于写错了，丢掉
      return;
    }
    // 没有对应的开符号 → 忽略这个孤零零的闭符号
  }

  let i = 0;
  const n = text.length;
  let inComment = false;
  let skipTo = 0;

  while (i < n) {
    if (i < skipTo) { i = skipTo; continue; }
    const ch = text[i];

    if (ch === '\n') { inComment = false; i += 1; continue; }
    if (inComment) { i += 1; continue; }
    if (ch === '%' && !isEscaped(text, i)) { inComment = true; i += 1; continue; }

    if (ch === '\\') {
      ENV_RE.lastIndex = i;
      const m = useEnv ? ENV_RE.exec(text) : null;
      if (m) {
        const name = m[2];
        const openEnd = i + m[0].length;
        if (m[1] === 'begin') {
          if (VERBATIM_ENVS.has(name)) {
            const endTok = '\\end{' + name + '}';
            const idx = text.indexOf(endTok, openEnd);
            skipTo = idx < 0 ? n : idx + endTok.length;
          } else if (!skipEnvs.has(name)) {
            push(i, openEnd, 'env', name);
          }
        } else {
          for (let k = stack.length - 1; k >= 0; k -= 1) {
            if (stack[k].kind === 'env' && stack[k].env === name) {
              const p = stack[k];
              p.closeStart = i;
              p.closeEnd = openEnd;
              pairs.push(p);
              stack.length = k;
              break;
            }
          }
        }
        i = openEnd;
        continue;
      }
      const nx = text[i + 1];
      if (nx === '{') { push(i, i + 2, 'ebrace'); i += 2; continue; }
      if (nx === '[') { push(i, i + 2, 'ebrack'); i += 2; continue; }
      if (nx === '(') { push(i, i + 2, 'eparen'); i += 2; continue; }
      if (nx === '}') { close('brace', i, i + 2); i += 2; continue; }
      if (nx === ']') { close('brack', i, i + 2); i += 2; continue; }
      if (nx === ')') { close('paren', i, i + 2); i += 2; continue; }
      i += 2;   // 跳过普通命令（\\ 换行、\alpha 之类）
      continue;
    }

    if (ch === '{') { push(i, i + 1, 'brace'); i += 1; continue; }
    if (ch === '[') { push(i, i + 1, 'brack'); i += 1; continue; }
    if (ch === '(' && useParen) { push(i, i + 1, 'paren'); i += 1; continue; }
    if (ch === '}') { close('brace', i, i + 1); i += 1; continue; }
    if (ch === ']') { close('brack', i, i + 1); i += 1; continue; }
    if (ch === ')' && useParen) { close('paren', i, i + 1); i += 1; continue; }
    i += 1;
  }

  // 选出包含光标的最内层结构（开符号最靠右的那个）。
  // 除了「在结构内部」，光标紧跟块状结构闭合符之后（后面只剩空白/换行）也算可跳出 ——
  // 这样刚写完 \end{…} / \] 时按 Tab 能直接落到下一行。
  let best = null;
  let bestAfter = false;
  for (const p of pairs) {
    if (p.closeStart < 0) continue;
    const nlIn = text.indexOf('\n', p.openStart);
    const pBlock = nlIn !== -1 && nlIn < p.closeEnd;
    const inside = offset >= p.openEnd && offset <= p.closeStart;
    let afterBlock = false;
    if (!inside && pBlock && offset === p.closeEnd) {
      let j = p.closeEnd;
      while (j < n && (text[j] === ' ' || text[j] === '\t')) j += 1;
      afterBlock = j >= n || text[j] === '\n';
    }
    if (!inside && !afterBlock) continue;
    if (!best || p.openStart > best.openStart) { best = p; bestAfter = afterBlock; }
  }
  if (!best) return null;

  // 光标在结构「内部」：Tab 就是单纯地「跳到闭合符之后」——
  // 紧贴闭合符、同一行，不改写文档（不换行、不缩进、不补空行）。
  // \end{…} 也一样：跳完就停在 } 后面，要换行自己按回车。
  if (!bestAfter) {
    return {
      offset: best.closeEnd, kind: best.kind, env: best.env,
      block: false, wantsNewline: false, afterCloser: false, insert: null, caret: null,
    };
  }

  // 光标已经紧贴在闭合符之后（后面只剩空白/换行）：块状结构且后面就是换行 → 落到下一行开头。
  const nl = text.indexOf('\n', best.openStart);
  const block = nl !== -1 && nl < best.closeEnd;
  let target = best.closeEnd;
  if (newlineAfterEnv && block) {
    let j = target;
    while (j < n && (text[j] === ' ' || text[j] === '\t')) j += 1;
    if (j < n && text[j] === '\n') target = j + 1;
  }
  return {
    offset: target, kind: best.kind, env: best.env,
    block, wantsNewline: false, afterCloser: true, insert: null, caret: null,
  };
}

module.exports = { findJumpTarget, wordBlocksJump };

/**
 * 光标前的词是否「应该让 Tab 去接受补全」：
 *   • 它本身就是某个触发词（如 thm）
 *   • 或它是某个触发词的前缀（如 fun 是 function 的前缀，此时补全弹窗正开着）
 * 命中的话智能 Tab 就不接管，Tab 照旧接受补全/展开片段。
 * @param {string} word 光标前的完整 ASCII 词
 * @param {string[]} wordTriggers 所有单词触发词
 */
function wordBlocksJump(word, wordTriggers) {
  if (!word) return false;
  const w = String(word).toLowerCase();
  if (w.length < 2) return false;                 // 单字符不当触发词/前缀
  const list = wordTriggers || [];
  for (const t of list) {
    const lt = String(t).toLowerCase();
    if (lt === w) return true;
    if (lt.startsWith(w)) return true;
  }
  return false;
}
