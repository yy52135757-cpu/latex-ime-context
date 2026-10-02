'use strict';

/*
 * LaTeX 结构化上下文分析。
 * 输入：文档全文 text、光标偏移 offset、选项 options。
 * 输出：{ mode: 'en' | 'cn', reason: string }
 *
 * 判定优先级（从高到低）：
 *   1. verbatim / minted 等抄录环境            -> 英文
 *   2. % 注释                                   -> commentMode（默认中文）
 *   3. 正在输入命令名（\、\cmd、\begin{env}）  -> 英文
 *   4. 光标前的 ASCII 词命中快捷指令/前缀       -> 英文
 *   5. 结构：数学环境 -> 英文；\text{} 等文本参数 -> 中文；\label{} 等参数 -> 英文
 *   6. 正文                                     -> proseMode（默认中文）
 */

const MATH_ENVS = new Set([
  'math', 'displaymath',
  'equation', 'equation*',
  'eqnarray', 'eqnarray*',
  'align', 'align*', 'alignat', 'alignat*', 'flalign', 'flalign*',
  'gather', 'gather*', 'multline', 'multline*',
  'split', 'aligned', 'alignedat', 'gathered', 'lgathered',
  'cases', 'cases*', 'dcases', 'dcases*', 'rcases', 'rcases*', 'drcases', 'drcases*',
  'matrix', 'matrix*', 'pmatrix', 'pmatrix*', 'bmatrix', 'bmatrix*',
  'Bmatrix', 'Bmatrix*', 'vmatrix', 'vmatrix*', 'Vmatrix', 'Vmatrix*',
  'smallmatrix', 'array', 'subarray',
  'tikzcd', 'CD', 'mathpar', 'dmath', 'dgroup', 'empheq',
  'numcases', 'subnumcases',
]);

const VERBATIM_ENVS = new Set([
  'verbatim', 'verbatim*', 'lstlisting', 'minted',
  'Verbatim', 'BVerbatim', 'LVerbatim', 'SaveVerbatim',
  'alltt', 'comment', 'filecontents', 'filecontents*',
]);

// 命令 -> 依次各 {} 参数的模式：'cn' 中文 / 'en' 英文 / 'math' 英文(数学) / 'default' 不改变
const CMD_ARGS = {
  // —— 文本类参数：中文 ——
  text: ['cn'], mbox: ['cn'], textbf: ['cn'], textit: ['cn'], textrm: ['cn'],
  textsf: ['cn'], texttt: ['cn'], textnormal: ['cn'], textup: ['cn'],
  textsl: ['cn'], textsc: ['cn'], textmd: ['cn'],
  textsuperscript: ['cn'], textsubscript: ['cn'],
  emph: ['cn'], footnote: ['cn'], caption: ['cn'], thanks: ['cn'], index: ['cn'],
  title: ['cn'],
  section: ['cn'], subsection: ['cn'], subsubsection: ['cn'],
  paragraph: ['cn'], subparagraph: ['cn'], chapter: ['cn'], part: ['cn'],
  // —— 数学语义参数：英文 ——
  ensuremath: ['math'], substack: ['math'],
  operatorname: ['en'], declaremathoperator: ['en'],
  // —— 标签 / 引用 / 代码类参数：英文 ——
  label: ['en'], ref: ['en'], eqref: ['en'], pageref: ['en'], autoref: ['en'],
  cref: ['en'], Cref: ['en'], cpageref: ['en'], vref: ['en'],
  cite: ['en'], citep: ['en'], citet: ['en'], Cite: ['en'], nocite: ['en'],
  citealp: ['en'], citeauthor: ['en'], citeyear: ['en'],
  url: ['en'], nolinkurl: ['en'], path: ['en'],
  includegraphics: ['en'], input: ['en'], include: ['en'], subfile: ['en'],
  usepackage: ['en'], documentclass: ['en'], loadclass: ['en'],
  bibliographystyle: ['en'], bibliography: ['en'], addbibresource: ['en'],
  hypersetup: ['en'], definecolor: ['en'], colorlet: ['en'], color: ['en'],
  newcommand: ['en'], renewcommand: ['en'], providecommand: ['en'],
  newenvironment: ['en'], renewenvironment: ['en'], newtheorem: ['en'],
  newcounter: ['en'], setcounter: ['en'], addtocounter: ['en'],
  usetikzlibrary: ['en'], tikzset: ['en'], pgfkeys: ['en'],
  lstset: ['en'], lstinputlisting: ['en'],
  // —— 双参数命令 ——
  href: ['en', 'default'], hyperref: ['en', 'cn'],
  textcolor: ['en', 'cn'], colorbox: ['en', 'cn'], fcolorbox: ['en', 'en', 'cn'],
};

const DEFAULT_TRIGGER_WORDS = [];

function normalizeOptions(options) {
  const o = options || {};
  const mathEnvs = new Set(MATH_ENVS);
  (o.extraMathEnvs || []).forEach((e) => e && mathEnvs.add(String(e).trim()));

  const cmdArgs = Object.assign({}, CMD_ARGS);
  (o.extraTextArgs || []).forEach((c) => c && (cmdArgs[String(c).trim()] = ['cn']));
  (o.extraEnglishArgs || []).forEach((c) => c && (cmdArgs[String(c).trim()] = ['en']));

  return {
    mathEnvs,
    cmdArgs,
    notesLanguage: o.notesLanguage === 'english' ? 'english' : 'chinese',
    commentMode: o.commentMode === 'english' ? 'en' : 'cn',
    proseMode: o.proseMode === 'english' ? 'en' : 'cn',
    forceEnglishInPreamble: !!o.forceEnglishInPreamble,
    triggerWords: (o.triggerWords && o.triggerWords.length ? o.triggerWords : DEFAULT_TRIGGER_WORDS)
      .map((t) => String(t)),
    triggerMatchMode: o.triggerMatchMode === 'prefix' || o.triggerMatchMode === 'off' ? o.triggerMatchMode : 'exact',
    anyAsciiWordForcesEnglish: !!o.anyAsciiWordForcesEnglish,
    englishEnvs: new Set(o.englishEnvs || []),
    chineseEnvs: new Set(o.chineseEnvs || []),
  };
}

/**
 * @param {string} text 文档全文
 * @param {number} offset 光标字符偏移
 * @param {object} [options]
 * @returns {{mode:'en'|'cn', reason:string}}
 */
function analyzeContext(text, offset, options) {
  const opts = normalizeOptions(options);
  const res = analyzeCore(text, offset, opts);
  // 英文笔记模式：把一切「中文」判定整体翻成英文
  if (opts.notesLanguage === 'english' && res.mode === 'cn') {
    return { mode: 'en', reason: res.reason + '|全英' };
  }
  return res;
}

function analyzeCore(text, offset, opts) {
  const n = Math.max(0, Math.min(offset, text.length));

  const st = scanTo(text, n, opts);

  // 1. 抄录环境
  if (st.inVerbatim) return { mode: 'en', reason: 'verbatim' };

  const lineStart = text.lastIndexOf('\n', n - 1) + 1;
  const before = text.slice(lineStart, n);

  // 2. 注释
  if (st.inComment) return { mode: opts.commentMode, reason: 'comment' };

  // 3. 正在输入命令名
  if (isTypingCommandName(before)) return { mode: 'en', reason: 'cmd-name' };

  // 4. 快捷指令
  if (matchesTrigger(before, opts)) return { mode: 'en', reason: 'trigger' };

  // 5. 结构
  return resolveStructural(text, st.stack, n, opts);
}

// ---------------------------------------------------------------------------

function scanTo(text, n, opts) {
  const stack = [];
  let inComment = false;
  let inVerbatim = null;
  let i = 0;

  while (i < n) {
    const c = text[i];

    // 抄录环境
    if (inVerbatim) {
      if (inVerbatim.char) {
        if (c === inVerbatim.char) inVerbatim = null;
        i += 1;
      } else if (c === '\\' && text.startsWith(inVerbatim.end, i)) {
        i += inVerbatim.end.length;
        inVerbatim = null;
      } else {
        i += 1;
      }
      continue;
    }

    // 注释
    if (inComment) {
      if (c === '\n') inComment = false;
      i += 1;
      continue;
    }

    // 反斜杠
    if (c === '\\') {
      const d = text[i + 1];
      if (d === undefined) { i += 1; continue; }

      if (d === '\\') { i += 2; continue; }                 // \\ 换行
      if (d === '[') { stack.push({ kind: 'math', closer: ']' }); i += 2; continue; }
      if (d === '(') { stack.push({ kind: 'math', closer: ')' }); i += 2; continue; }
      if (d === ']' || d === ')') { popAnyMath(stack); i += 2; continue; }
      if (!/[A-Za-z@]/.test(d)) { i += 2; continue; }       // \% \& \{ \} \$ 等

      let j = i + 1;
      while (j < n && /[A-Za-z@]/.test(text[j])) j += 1;
      const cmd = text.slice(i + 1, j);

      // \begin{env} / \end{env}
      if (cmd === 'begin' || cmd === 'end') {
        if (text[j] === '{') {
          let k = j + 1;
          while (k < n && text[k] !== '}') k += 1;
          if (k >= n) break;                                  // 光标还在环境名里
          const env = text.slice(j + 1, k).trim();
          if (cmd === 'begin') {
            if (VERBATIM_ENVS.has(env)) inVerbatim = { end: '\\end{' + env + '}' };
            else if (opts.mathEnvs.has(env)) stack.push({ kind: 'math', closer: null, env });
            else stack.push({ kind: 'env', name: env });
          } else {
            popEnv(stack, env);
          }
          i = k + 1;
          continue;
        }
        i = j;
        continue;
      }

      // \verb|...|
      if (cmd === 'verb' || cmd === 'Verb' || cmd === 'lstinline') {
        const dch = text[j];
        if (dch && dch !== '\n' && dch !== '{' && dch !== '}' && dch !== ' ') {
          inVerbatim = { char: dch };
          i = j + 1;
          continue;
        }
        i = j;
        continue;
      }

      // 带参数命令
      const spec = opts.cmdArgs[cmd];
      if (spec) {
        let jj = j;
        if (text[jj] === '*') jj += 1;
        // 跳过可选参数 [ ... ]
        while (text[jj] === '[') {
          let depth = 0;
          let k = jj;
          while (k < n) {
            if (text[k] === '[') depth += 1;
            else if (text[k] === ']') { depth -= 1; if (depth === 0) { k += 1; break; } }
            k += 1;
          }
          if (k >= n) { jj = k; break; }
          jj = k;
        }
        if (jj < n && text[jj] === '{') {
          stack.push({ kind: 'cmdArg', cmd, argIdx: 0, argMode: spec[0], spec });
          i = jj + 1;
          continue;
        }
        if (jj >= n) break;                                    // 光标在可选参数里
        i = Math.max(jj, j);
        continue;
      }

      i = j;
      continue;
    }

    // $ 数学模式
    if (c === '$') {
      const closer = dollarContext(stack);
      if (closer === '$') { popTopMath(stack); i += 1; continue; }
      if (closer === '$$') {
        if (text[i + 1] === '$') { popTopMath(stack); i += 2; continue; }
        i += 1; continue;                                      // 显示数学里的单个 $
      }
      if (text[i + 1] === '$') { stack.push({ kind: 'math', closer: '$$' }); i += 2; continue; }
      stack.push({ kind: 'math', closer: '$' });
      i += 1;
      continue;
    }

    // 注释
    if (c === '%') {
      let k = i - 1;
      let cnt = 0;
      while (k >= 0 && text[k] === '\\') { cnt += 1; k -= 1; }
      if (cnt % 2 === 0) inComment = true;
      i += 1;
      continue;
    }

    if (c === '{') { openBrace(stack); i += 1; continue; }
    if (c === '}') { closeBrace(stack); i += 1; continue; }

    i += 1;
  }

  return { stack, inComment, inVerbatim };
}

// —— 栈操作 ——

function openBrace(stack) {
  const top = stack[stack.length - 1];
  if (top && top.kind === 'pendingArg') {
    stack.pop();
    stack.push({ kind: 'cmdArg', cmd: top.cmd, argIdx: top.idx, argMode: top.mode, spec: top.spec });
    return;
  }
  stack.push({ kind: 'group' });
}

function closeBrace(stack) {
  while (stack.length && stack[stack.length - 1].kind === 'pendingArg') stack.pop();
  const top = stack[stack.length - 1];
  if (!top) return;
  if (top.kind === 'group') { stack.pop(); return; }
  if (top.kind === 'cmdArg') {
    stack.pop();
    const next = top.argIdx + 1;
    const spec = top.spec || [];
    if (next < spec.length) {
      stack.push({ kind: 'pendingArg', cmd: top.cmd, idx: next, mode: spec[next], spec });
    }
    return;
  }
  // 数学帧 / 环境帧：不平衡的 }，忽略
}

function popEnv(stack, env) {
  for (let k = stack.length - 1; k >= 0; k -= 1) {
    const f = stack[k];
    if ((f.kind === 'env' && f.name === env) || (f.kind === 'math' && f.env === env)) {
      stack.length = k;
      return;
    }
  }
}

function dollarContext(stack) {
  for (let k = stack.length - 1; k >= 0; k -= 1) {
    const f = stack[k];
    if (f.kind === 'math') return f.closer;   // '$' | '$$' | ']' | ')' | null(env)
    if (f.kind === 'env') return null;        // 普通环境里，$ 开启新的行内数学
  }
  return null;
}

function popTopMath(stack) {
  for (let k = stack.length - 1; k >= 0; k -= 1) {
    const f = stack[k];
    if (f.kind === 'math') { stack.length = k; return; }
    if (f.kind === 'env') return;
  }
}

function popAnyMath(stack) {
  for (let k = stack.length - 1; k >= 0; k -= 1) {
    const f = stack[k];
    if (f.kind === 'math') { stack.length = k; return; }
    if (f.kind === 'env') return;
  }
}

// —— 结构判定 ——

function resolveStructural(text, stack, offset, opts) {
  for (let k = stack.length - 1; k >= 0; k -= 1) {
    const f = stack[k];
    if (f.kind === 'math') return { mode: 'en', reason: 'math' };
    if (f.kind === 'cmdArg') {
      if (f.argMode === 'cn') return { mode: 'cn', reason: 'text-arg' };
      if (f.argMode === 'en' || f.argMode === 'math') return { mode: 'en', reason: 'cmd-arg' };
      continue; // 'default'
    }
    if (f.kind === 'env') {
      if (opts.englishEnvs.has(f.name)) return { mode: 'en', reason: 'env:' + f.name };
      if (opts.chineseEnvs.has(f.name)) return { mode: 'cn', reason: 'env:' + f.name };
    }
  }

  if (opts.forceEnglishInPreamble) {
    const docBegin = text.indexOf('\\begin{document}');
    if (docBegin >= 0 && offset <= docBegin) return { mode: 'en', reason: 'preamble' };
  }

  return { mode: opts.proseMode, reason: 'prose' };
}

// —— 光标局部规则 ——

function isTypingCommandName(before) {
  const m = /([A-Za-z@]*)$/.exec(before);
  const word = m[1];
  let backslashes = 0;
  let k = before.length - word.length - 1;
  while (k >= 0 && before[k] === '\\') { backslashes += 1; k -= 1; }
  if (backslashes % 2 === 1) return true;                 // "\" 或 "\cmd"
  return /\\(begin|end)\{[A-Za-z*@]*$/.test(before);      // "\begin{al"
}

function matchesTrigger(before, opts) {
  if (opts.triggerMatchMode === 'off') return false;
  const m = /([A-Za-z][A-Za-z0-9]*)$/.exec(before);
  if (!m) return false;
  const word = m[1];
  if (opts.anyAsciiWordForcesEnglish) return true;
  if (opts.triggerMatchMode === 'prefix') {
    return opts.triggerWords.some((t) => t === word || t.startsWith(word));
  }
  return opts.triggerWords.indexOf(word) >= 0;   // exact：只有完整触发词才切
}

module.exports = { analyzeContext, MATH_ENVS, VERBATIM_ENVS, CMD_ARGS };
