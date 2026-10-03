'use strict';

const vscode = require('vscode');
const path = require('path');
const { execFile } = require('child_process');
const { analyzeContext } = require('./src/context');
const { autoConvert } = require('./src/autoconvert');
const { findJumpTarget, wordBlocksJump } = require('./src/smarttab');
const { runImSelect, ensureExecutable, isWsl, listWindowsLayouts, parseCode, sendSameImeToggle, disposeSameImeShell, getSameImeStats } = require('./src/ime');

let output = null;
let statusItem = null;
let extensionPath = '';
let enabled = true;
let lastApplied = null;      // 'cn' | 'en'（layout 模式用）
let lastAppliedAt = 0;
let captureInitialAsEnglish = false;
let debounceTimer = null;

// 同 IME（微软拼音内部中/英）模式的状态记忆
let sameImeState = 'unknown';   // 'cn' | 'en' | 'unknown'
let globalStateRef = null;
let switchFailCount = 0;

// 运行时编码覆盖（自动检测用；设置里的写法兼容 十进制 / 0x 十六进制 / 8 位 KLID）
let codeOverride = { cn: null, en: null };
let layoutNames = { cn: '', en: '' };

// 「强制英文/中文」临时覆盖
let forceMode = null;
let forceUntil = 0;
let forceLine = -1;
const FORCE_MS = 6000;

function cfg() {
  return vscode.workspace.getConfiguration('latexIme');
}

function log(msg) {
  if (cfg().get('debug', false) && output) output.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

function resolveExePath() {
  const configured = String(cfg().get('imSelectPath', '') || '').trim();
  if (configured) return configured;
  return path.join(extensionPath, 'bin', 'im-select.exe');
}

function isLatexEditor(editor) {
  if (!editor) return false;
  const ids = cfg().get('languageIds', ['latex', 'tex']);
  return Array.isArray(ids) && ids.includes(editor.document.languageId);
}

/** 实际使用的编码：优先运行时自动检测结果，其次设置项；统一转成十进制 */
function effectiveCode(mode) {
  const key = mode === 'cn' ? 'cn' : 'en';
  const configured = cfg().get(mode === 'cn' ? 'chineseCode' : 'englishCode', mode === 'cn' ? '2052' : '1033');
  const raw = codeOverride[key] !== null ? codeOverride[key] : configured;
  const n = parseCode(raw);
  return Number.isFinite(n) ? String(n) : String(raw).trim();
}

/**
 * 枚举 Windows 已加载输入法，自动纠正中/英文编码。
 * 典型场景：系统里没有 en-US(1033)，只有 en-IE(6153) —— 此时 1033 切换会「毫无反应」。
 */
function autoDetectLayouts(interactive) {
  listWindowsLayouts((err, items) => {
    if (err) { log(`输入法枚举失败: ${err.message}`); if (interactive) vscode.window.showErrorMessage(`无法枚举 Windows 输入法：${err.message}`); return; }
    if (!items || !items.length) { log('输入法枚举结果为空'); return; }
    log('已安装输入法: ' + items.map((i) => `${i.langTag}=${i.code}`).join(', '));

    const configuredCn = parseCode(cfg().get('chineseCode', '2052'));
    const configuredEn = parseCode(cfg().get('englishCode', '1033'));
    const found = (n) => Number.isFinite(n) && items.some((i) => i.code === n);

    const fixes = [];
    const cnItem = found(configuredCn) ? null : items.find((i) => i.isChinese);
    if (cnItem) { codeOverride.cn = cnItem.code; layoutNames.cn = cnItem.label; fixes.push({ key: 'chineseCode', code: cnItem.code, label: cnItem.label }); }
    else { layoutNames.cn = (items.find((i) => i.code === configuredCn) || {}).label || ''; }

    const enItem = found(configuredEn) ? null : items.find((i) => !i.isChinese);
    if (enItem) { codeOverride.en = enItem.code; layoutNames.en = enItem.label; fixes.push({ key: 'englishCode', code: enItem.code, label: enItem.label }); }
    else { layoutNames.en = (items.find((i) => i.code === configuredEn) || {}).label || ''; }

    if (!fixes.length) { if (interactive) vscode.window.showInformationMessage('LaTeX IME: 编码与系统已装输入法一致，无需修正。'); return; }

    log('自动修正编码: ' + fixes.map((f) => `${f.key}=${f.code}`).join(', '));
    lastApplied = null;
    update(vscode.window.activeTextEditor);

    vscode.window.showInformationMessage(
      'LaTeX IME: 系统里没有设置项指定的输入法，已自动改用：'
      + fixes.map((f) => `${f.key === 'chineseCode' ? '中文' : '英文'} ${f.code}（${f.label}）`).join('；'),
      '写入设置'
    ).then((sel) => {
      if (sel !== '写入设置') return;
      fixes.forEach((f) => cfg().update(f.key, String(f.code), vscode.ConfigurationTarget.Global));
      vscode.window.setStatusBarMessage('LaTeX IME: 已写入设置', 2500);
    });
  });
}

/**
 * 输入法「一次上屏多个字符」时的触发词展开。
 *
 * 背景：中文输入法下敲 dm 再按 Enter，会把 "dm" 一次性插入文档；
 * 而 hsnips 的自动展开只处理「一次插入 1 个字符」（`mainChange.text.length != 1` 直接 return），
 * 所以这种上屏方式永远不会展开 → 表现为「dm/mk 时好时坏」。
 * 这里补上：命中触发词表就替换成对应片段（支持 $1/$0 制表位）。
 * 单字符输入仍交给 hsnips，不会重复展开。
 */
// 内置触发词（hsnips 文件里已移除的那几个）
// 说明：text 触发词已按用户要求移除（中文输入法下偶发 "\textt{}"，用户不需要该功能），
// 直接输入 text 就是普通字母，不会有任何自动展开。
// dm 末尾不要 $0：多行片段已在插入时补行尾换行，走完 $1 后 Tab 一次就落到 .\] 的下一行，
// 不会先被 $0 带到 .\] 外面、再误触发跳出。
const BUILTIN_TRIGGERS = {
  dm: '\\[\n\t$1\n.\\]',
  mk: '$${1}$ $2',
  today: '${CURRENT_YEAR}-${CURRENT_MONTH}-${CURRENT_DATE}',
};

// 直接读用户的 latex.hsnips：让 thm/thmt/lm/sec/lec/def/proof… 也能在输入法上屏时展开。
// 跳过正则触发词、含 JS 插值（反引号）与 ${VISUAL} 的片段（VS Code 片段语法不支持）。
let hsnipsCache = { file: '', mtimeMs: 0, map: {} };

function hsnipsFilePath() {
  const configured = String(cfg().get('hsnipsFile', '') || '').trim();
  if (configured) return configured;
  try {
    const os = require('os');
    const pathMod = require('path');
    // Windows 原生：hsnips 片段在 %APPDATA%\Code\User\hsnips\；WSL/Linux/macOS 在 ~/.config/Code/User/hsnips/
    if (process.platform === 'win32') {
      const appData = process.env.APPDATA || pathMod.join(os.homedir(), 'AppData', 'Roaming');
      return pathMod.join(appData, 'Code', 'User', 'hsnips', 'latex.hsnips');
    }
    return pathMod.join(os.homedir(), '.config', 'Code', 'User', 'hsnips', 'latex.hsnips');
  } catch (e) {
    return '';
  }
}

function readHsnipsTriggers() {
  try {
    const fs = require('fs');
    const file = hsnipsFilePath();
    if (!file || !fs.existsSync(file)) return hsnipsCache.map;
    const st = fs.statSync(file);
    if (hsnipsCache.file === file && hsnipsCache.mtimeMs === st.mtimeMs) return hsnipsCache.map;

    const text = fs.readFileSync(file, 'utf8');
    const map = {};
    const re = /^snippet[ \t]+([^\s`][^\s]*)[ \t]*(?:"[^"]*"[ \t]*)?([A-Za-z]*)[ \t]*\r?\n([\s\S]*?)^endsnippet/gm;
    let m;
    while ((m = re.exec(text)) !== null) {
      const trigger = m[1];
      const body = m[3];
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(trigger)) continue;    // 只要单词触发词
      if (body.indexOf('`') >= 0) continue;                     // 含 JS 插值 → 跳过
      if (body.indexOf('${VISUAL') >= 0) continue;              // VS Code 不支持
      map[trigger] = { body: body.replace(/\s+$/, ''), flags: m[2] || '' };
    }
    hsnipsCache = { file, mtimeMs: st.mtimeMs, map };
    trace(`读取 hsnips：${Object.keys(map).length} 个单词触发词（${Object.keys(map).join(',')}）`);
    return map;
  } catch (e) {
    return hsnipsCache.map;
  }
}

/** 触发词表：内置 < hsnips 文件 < 设置项 triggerSnippets。值统一为 { body, flags } */
function effectiveTriggers() {
  const out = {};
  const put = (t, body, flags) => { out[t] = { body, flags: flags || '' }; };
  Object.keys(BUILTIN_TRIGGERS).forEach((t) => put(t, BUILTIN_TRIGGERS[t], ''));
  const parsed = readHsnipsTriggers();
  Object.keys(parsed).forEach((t) => put(t, parsed[t].body, parsed[t].flags));
  const userMap = cfg().get('triggerSnippets', null);
  if (userMap && typeof userMap === 'object') {
    Object.keys(userMap).forEach((t) => {
      if (typeof userMap[t] === 'string') put(t, userMap[t], '');
    });
  }
  return out;
}

// —— 触发词展开 ——
// 输入法敲字时，组合串会「临时写进文档 → 被清空 → 最后才真正提交」，
// 若在中间态就展开，Enter 的提交会落进片段内部（表现为 \[ … dm … .\]）。
// 所以：命中候选后延迟一会儿再动手，期间只要出现「组合串更新/清空」就撤销。
// 延迟默认 300ms（可用 latexIme.triggerDelayMs 调）：实测输入法组合串从写入到真正提交
// 可能花 ~175ms，150ms 会抢在提交之前展开，导致后续的「清空 + 提交」把片段削掉、并留下多余的触发词。
let pendingExpand = null;

// 兜底用：记录刚插入的片段，若之后有「恰好落在片段占位符处、且内容就是该触发词」的插入，
// 说明那是输入法把提交塞进了片段内部（因为我们在组合串结束前就展开了），自动清掉它。
let lastSnippet = null;

// 「边打边转」留下的选区（如 ^ → ^{-1} 时选中的 -1）：
// 只要它还保持原样，按 Tab 就直接跳出到闭合符之后（即使正在片段会话 / 补全弹窗里）。
let autoSel = null;

function snippetTabOffset(snippet) {
  const i = snippet.indexOf('$1');
  if (i >= 0) return i;
  const j = snippet.indexOf('${1');
  if (j >= 0) return j;
  const k = snippet.indexOf('$0');
  return k >= 0 ? k : snippet.length;
}

function healIfCommittedIntoSnippet(e, ed) {
  const info = lastSnippet;
  if (!info) return false;
  if (Date.now() > info.until) { lastSnippet = null; return false; }
  if (e.contentChanges.length !== 1) return false;
  const ch = e.contentChanges[0];
  const raw = ch.text || '';
  const t = raw.replace(/\s+$/, '');
  if (!t || t.length > 20) return false;
  const startOff = ed.document.offsetAt(ch.range.start);
  if (Math.abs(startOff - info.tabOffset) > 1) return false;
  if (t.toLowerCase() !== info.word.toLowerCase()) return false;

  const doc = ed.document;
  const r = new vscode.Range(doc.positionAt(startOff), doc.positionAt(startOff + raw.length));
  ed.edit((b) => b.delete(r)).then(() => {
    log(`兜底：已清除落进片段的输入法提交 "${t}"`);
    trace(`兜底清除 "${t}"（占位符处）`);
  });
  lastSnippet = null;
  return true;
}

function cancelPendingExpand(reason) {
  if (pendingExpand) {
    clearTimeout(pendingExpand.timer);
    trace(`取消挂起的展开 "${pendingExpand.word}"（${reason}）`);
    pendingExpand = null;
  }
}

/** 自动展开的等待时间（ms）：足够覆盖输入法「组合串写入 → 清空 → 真正提交」的全过程 */
function triggerDelayMs() {
  const n = Number(cfg().get('triggerDelayMs', 300));
  return Number.isFinite(n) && n >= 0 ? n : 300;
}

/**
 * 边打边转（下标 / 上标 / 后缀 / 分数）：用**纯文本编辑**实现，
 * 不新开片段会话 —— 否则会把外层片段（如 function 模板）的占位符会话顶掉，
 * 表现为「G1 变成 G_1 之后，Tab 再也去不了原来的位置」。
 */
function maybeAutoConvert(e, ed) {
  try {
    if (cfg().get('expandTypedTriggers', true) === false) return false;
    if (!isLatexEditor(ed)) return false;
    if (e.contentChanges.length !== 1) return false;
    const ch = e.contentChanges[0];
    const raw = ch.text || '';
    if (!raw || raw.length > 8) return false;
    const doc = e.document;
    const text = doc.getText();
    const offset = doc.offsetAt(ch.range.start) + raw.length;
    // 只在数学环境里转（注释 / 正文不动）
    const r = analyzeContext(text, Math.max(0, offset - raw.length), analyzeOptions());
    if (r.reason !== 'math') return false;
    const conv = autoConvert(text, offset, raw, { math: true });
    if (!conv) return false;
    const range = new vscode.Range(doc.positionAt(conv.start), doc.positionAt(conv.end));
    const sel = conv.select || null;
    ed.edit((b) => b.replace(range, conv.text)).then((ok) => {
      if (ok === false) return;
      if (sel) {
        const a = doc.positionAt(sel[0]);
        const c = doc.positionAt(sel[1]);
        ed.selection = new vscode.Selection(a, c);
        // 记下这个「我们的选区」（如 ^{-1} 里选中的 -1）：
        // 在它保持原样期间按 Tab，直接跳出到闭合符之后（片段会话 / 补全弹窗里也生效）。
        autoSel = {
          uri: doc.uri.toString(),
          start: sel[0],
          end: sel[1],
          text: doc.getText(new vscode.Range(a, c)),
        };
        refreshJumpContext(ed);
        trace(`自动选区 "${autoSel.text}" → Tab 可直接跳出`);
      }
    });
    trace(`自动转换：${conv.rule} → ${JSON.stringify(conv.text)}`);
    return true;
  } catch (err) {
    return false;
  }
}

function maybeExpandTriggerWord(e, ed) {
  if (cfg().get('expandTypedTriggers', true) === false) return false;
  if (!isLatexEditor(ed)) return false;
  if (e.contentChanges.length !== 1) { cancelPendingExpand('一次事件多处变更'); return false; }

  const ch = e.contentChanges[0];
  const raw = ch.text || '';

  // 组合串被清空 / 被替换 ⇒ 说明还在组合中
  if (raw === '') cancelPendingExpand('组合串清空');
  else if (ch.rangeLength > 0) cancelPendingExpand('组合串替换');

  const map = effectiveTriggers();
  if (!Object.keys(map).length || !raw) return false;

  const doc = e.document;
  const docText = doc.getText();
  const startOffset = doc.offsetAt(ch.range.start);
  const caretOffset = startOffset + raw.length;
  if (caretOffset > docText.length) return false;
  if (docText.slice(startOffset, caretOffset) !== raw) return false;

  // 以「光标处结尾的完整 ASCII 词」为准（并去掉输入法提交时的尾随空格）。
  // 不能信 ch.range 的起点：输入法可能只替换词的中间一段（如把 "ec" 换成 "sec"），
  // 那样按起点算就会把词首的字母漏在外面（表现为 "s\section{...}"）。
  const trimmed = raw.replace(/\s+$/, '');
  const wordEndOffset = caretOffset - (raw.length - trimmed.length);
  let wordStart = wordEndOffset;
  while (wordStart > 0 && /[A-Za-z0-9]/.test(docText[wordStart - 1])) wordStart -= 1;
  const fullWord = docText.slice(wordStart, wordEndOffset);

  // 有些输入法会把「已经上屏过的词首」再重复提交一次（文档里变成 "ssec" 这种）。
  // 若整词不是触发词、但词尾是触发词、且被重复的前缀正是该触发词自己的开头，则按触发词处理，
  // 并把整个词（含重复部分）一起删掉，不留残渣。
  let word = fullWord;
  if (!map[word] && fullWord.length > 1 && fullWord.length <= 12) {
    for (let cut = 1; cut < fullWord.length; cut += 1) {
      const suffix = fullWord.slice(cut);
      if (map[suffix] && suffix.startsWith(fullWord.slice(0, cut))) {
        word = suffix;
        trace(`输入法重复提交："${fullWord}" 按 "${word}" 处理`);
        break;
      }
    }
  }

  const entry = map[word];
  if (!entry) {
    trace(`放弃：词 "${fullWord}"（本次变更 ${JSON.stringify(raw.slice(0, 12))} replaceLen=${ch.rangeLength}）不在触发词表`);
    return false;
  }

  const before = wordStart > 0 ? docText[wordStart - 1] : '';
  if (before === '\\') { trace('放弃：前面是反斜杠'); return false; }

  // 整词删除：从词首一直删到光标（含输入法加上的尾随空格）
  const delStart = wordStart;
  const delEnd = caretOffset;

  const snippet0 = typeof entry === 'string' ? entry : entry.body;
  const flags = typeof entry === 'string' ? '' : (entry.flags || '');
  if (!snippet0) return false;
  // 多行片段（环境、aligned 块等）：补一个行尾换行。
  // 否则 Tab 走完占位符时会停在 \end{…} 后面，而不是落到下一行。
  let snippet = snippet0;
  if (/\n/.test(snippet) && !/\n$/.test(snippet)) snippet += '\n';
  if (flags.indexOf('m') >= 0) {
    // 判定位置取「词的起点」：词尾本身会被 analyzeContext 归入触发词区域（reason=trigger），会误判成非数学
    const r = analyzeContext(docText, wordStart, analyzeOptions());
    if (r.reason !== 'math') { trace(`跳过 "${word}"：需要数学环境（当前 ${r.mode}/${r.reason}）`); return false; }
  }
  if (flags.indexOf('b') >= 0) {
    const lineStart = docText.lastIndexOf('\n', delStart - 1) + 1;
    if (docText.slice(lineStart, delStart).trim() !== '') { trace(`跳过 "${word}"：需要行首`); return false; }
  }
  const snapshot = docText.slice(delStart, delEnd);
  cancelPendingExpand('新候选');
  const timer = setTimeout(() => {
    pendingExpand = null;
    const now = doc.getText();
    if (now.slice(delStart, delEnd) !== snapshot) { trace('复查失败：内容已变'); return; }
    const after = delEnd < now.length ? now[delEnd] : '';
    if (after && /[A-Za-z0-9]/.test(after)) { trace('复查失败：词后还有字母'); return; }

    const r = new vscode.Range(doc.positionAt(delStart), doc.positionAt(delEnd));
    ed.edit((b) => b.delete(r)).then((ok) => {
      if (ok === false) { trace('edit 被拒'); return; }
      try {
        const p = doc.positionAt(delStart);
        ed.selection = new vscode.Selection(p, p);
      } catch (err) { /* ignore */ }
      vscode.commands.executeCommand('editor.action.insertSnippet', { snippet }).then(undefined, (err) => {
        vscode.window.showErrorMessage(`LaTeX IME: 展开 ${word} 失败：${err && err.message}`);
      });
      setSnippetNav(doc, snippet, word);
      log(`触发词展开: ${word}`);
      trace(`展开 "${word}"（原文 ${JSON.stringify(raw.slice(0, 12))}，replaceLen=${ch.rangeLength}）`);
      // 记录片段的占位符位置，供兜底清理使用
      lastSnippet = {
        tabOffset: delStart + snippetTabOffset(snippet),
        word,
        until: Date.now() + 2500,
      };
    });
  }, triggerDelayMs());

  pendingExpand = { timer, word };
  trace(`候选 "${word}"（原文 ${JSON.stringify(raw.slice(0, 12))}，replaceLen=${ch.rangeLength}）→ ${triggerDelayMs()}ms 后展开`);
  return true;
}

function analyzeOptions() {
  return {
    notesLanguage: cfg().get('notesLanguage', 'chinese'),
    proseMode: cfg().get('proseMode', 'chinese'),
    commentMode: cfg().get('commentMode', 'chinese'),
    triggerMatchMode: cfg().get('triggerMatchMode', 'exact'),
    forceEnglishInPreamble: cfg().get('forceEnglishInPreamble', false),
    triggerWords: cfg().get('triggerWords', []),
    anyAsciiWordForcesEnglish: cfg().get('anyAsciiWordForcesEnglish', false),
    extraMathEnvs: cfg().get('extraMathEnvs', []),
    extraTextArgs: cfg().get('extraTextArgs', []),
    extraEnglishArgs: cfg().get('extraEnglishArgs', []),
    englishEnvs: cfg().get('englishEnvs', []),
    chineseEnvs: cfg().get('chineseEnvs', []),
  };
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 变更追踪日志（排查「没反应」用）：记录 LaTeX 文件里的每次变更与判定结果
const CHANGE_LOG = process.env.LATEX_IME_CHANGE_LOG || '/tmp/latex-ime-changes.log';
let changeLogLines = 0;
let changeLogInit = false;

function trace(line) {
  try {
    if (!changeLogInit) {
      changeLogInit = true;
      require('fs').writeFileSync(CHANGE_LOG, `# LaTeX IME Context 变更日志 ${new Date().toISOString()}\n`);
    }
    if (changeLogLines > 600) return;   // 上限，避免无限增长
    require('fs').appendFileSync(CHANGE_LOG, line + '\n');
    changeLogLines += 1;
  } catch (e) { /* ignore */ }
}

function scheduleUpdate(delay) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    update(vscode.window.activeTextEditor);
  }, delay);
}

function update(editor) {
  if (!editor || !isLatexEditor(editor)) {
    renderStatus(null);
    return;
  }
  if (!enabled) {
    renderStatus({ mode: null, reason: '已禁用' });
    return;
  }
  if (!editor.selection.isEmpty) return;   // 正在选择文本，不切

  const doc = editor.document;
  const pos = editor.selection.active;
  const offset = doc.offsetAt(pos);

  const now = Date.now();
  let desired;
  let reason;

  if (forceMode && now < forceUntil && forceLine === pos.line) {
    desired = forceMode;
    reason = '临时强制';
  } else {
    forceMode = null;
    forceUntil = 0;
    forceLine = -1;
    const r = analyzeContext(doc.getText(), offset, analyzeOptions());
    desired = r.mode;
    reason = r.reason;
  }

  renderStatus({ mode: desired, reason });

  if (desired === lastApplied) return;

  const protection = cfg().get('switchProtectionMs', 300);
  if (Date.now() - lastAppliedAt < protection) return;

  applyMode(desired, reason);
}

function applyMode(mode, reason) {
  const exe = resolveExePath();

  // —— 同 IME 模式：只在中文输入法内部切中/英，不换键盘布局 ——
  if (cfg().get('imeSwitchMode', 'layout') === 'sameIme') {
    if (sameImeState === mode) { log(`同IME：已是 ${mode}（${reason}），跳过`); return; }
    const shortcut = cfg().get('sameImeShortcut', 'ctrl+space');
    lastAppliedAt = Date.now();
    lastApplied = mode;
    log(`同IME 切换 -> ${mode} (${reason}), 发送 ${shortcut}`);
    sendSameImeToggle(shortcut, log, (err) => {
      if (err) {
        lastApplied = null;
        log(`同IME 切换失败: ${err.message}`);
        if (cfg().get('warnOnMissingBinary', true) && !applyMode._warned) {
          applyMode._warned = true;
          vscode.window.showWarningMessage(`LaTeX IME: 发送 ${shortcut} 失败（${err.message}）。可在设置里把 latexIme.imeSwitchMode 改回 layout。`);
        }
        return;
      }
      sameImeState = mode;
      if (globalStateRef) globalStateRef.update('sameImeState', mode);
      renderStatus({ mode, reason });
    });
    return;
  }

  // —— layout 模式：用 im-select 切换键盘布局 ——
  const code = effectiveCode(mode);

  lastAppliedAt = Date.now();
  lastApplied = mode;
  log(`切换布局 -> ${mode} (${reason}), code=${code}, exe=${exe}`);
  runImSelect(exe, code, log, (err) => {
    if (err) {
      lastApplied = null;   // 失败则下次重试
      switchFailCount += 1;
      log(`切换失败（第 ${switchFailCount} 次）: ${err.message}`);
      // WSL 互操作偶发失败很正常，连续多次才提示，避免吓人
      if (switchFailCount >= 3 && cfg().get('warnOnMissingBinary', true)) {
        switchFailCount = 0;
        vscode.window.showWarningMessage(`LaTeX IME: 连续多次无法调用 im-select（${err.message}）。请检查 latexIme.imSelectPath。`);
      }
      return;
    }
    switchFailCount = 0;
    // 读回校验：layout 模式最大的好处就是状态可读，切完立刻核对，错位立刻纠正
    runImSelect(exe, null, log, (e2, cur) => {
      if (e2 || !cur) return;
      const actual = parseCode(cur);
      if (!Number.isFinite(actual)) return;
      if (String(actual) === String(code)) {
        log(`校验通过：当前=${actual}`);
        return;
      }
      log(`校验不符：期望 ${code}，实际 ${actual}，重发一次`);
      runImSelect(exe, code, log, () => {});
    });
  });
}

function renderStatus(info) {
  if (!statusItem) return;
  if (!cfg().get('statusBar', true)) { statusItem.hide(); return; }
  const notes = cfg().get('notesLanguage', 'chinese') === 'english' ? '英文笔记' : '中文笔记';
  if (!info) {
    statusItem.text = '$(circle-slash) LaTeX IME';
    statusItem.tooltip = `当前不是 LaTeX 文档\n笔记语言：${notes}\n点击：打开菜单`;
    statusItem.color = undefined;
    statusItem.show();
    return;
  }
  const label = info.mode === 'cn' ? '中' : info.mode === 'en' ? 'EN' : '—';
  statusItem.text = `$(pencil) LaTeX ${label}`;
  const switchMode = cfg().get('imeSwitchMode', 'layout');
  const modeLine = switchMode === 'sameIme'
    ? `切换方式：微软拼音内部中/英（${cfg().get('sameImeShortcut', 'ctrl+space')}）· 当前=${sameImeState === 'unknown' ? '未知' : sameImeState === 'cn' ? '中文' : '英文'}`
    : `切换方式：切换键盘布局 · 中文=${effectiveCode('cn')} · 英文=${effectiveCode('en')}`;
  statusItem.tooltip = `期望输入法：${info.mode === 'cn' ? '中文' : info.mode === 'en' ? '英文' : '未知'}`
    + `\n原因：${info.reason}`
    + `\n笔记语言：${notes}`
    + `\n${modeLine}`
    + `\n点击：打开菜单`;
  statusItem.color = undefined;
  statusItem.show();
}

/** 快捷插入：先切英文，再插入片段（不经过输入法与 hsnips，中文输入法下也能用） */
function quickInsert(key, title) {
  const snippet = String(cfg().get(`quickInsert.${key}`, '') || '');
  if (!snippet) {
    vscode.window.showWarningMessage(`LaTeX IME: latexIme.quickInsert.${key} 为空`);
    return;
  }
  applyMode('en', `快捷插入 ${key}`);
  vscode.commands.executeCommand('editor.action.insertSnippet', { snippet }).then(undefined, (err) => {
    vscode.window.showErrorMessage(`插入失败：${err && err.message ? err.message : err}`);
  });
  vscode.window.setStatusBarMessage(`${title} 已插入`, 1500);
}

/**
 * layout 模式下重新同步「当前实际是中文还是英文」：
 * 否则用户手动切过输入法后，扩展的状态会失真，表现为「不切换」。
 */
function resyncLayoutState() {
  if (cfg().get('imeSwitchMode', 'layout') !== 'layout') return;
  runImSelect(resolveExePath(), null, log, (err, cur) => {
    if (err || !cur) return;
    const n = parseCode(cur);
    if (!Number.isFinite(n)) return;
    const en = parseCode(effectiveCode('en'));
    lastApplied = n === en ? 'en' : 'cn';
    log(`重新同步布局状态：当前编码 ${n} -> ${lastApplied}`);
  });
}

// ---------------------------------------------------------------------------
// 智能 Tab 跳出：光标在 { } [ ] ( ) \{ \} \[ \] \begin{…} 内部时，Tab 紧贴跳到闭合符之后
// （只挪光标、不改写文字；选中默认值时也照跳，不会把选中的默认值删掉）。
// 用上下文键 latexIme.canJumpOut 控制按键绑定 —— 只在真能跳出时接管 Tab，
// 其余情况（行首缩进、补全弹窗、hsnips 占位符跳转）完全不受影响。
// ---------------------------------------------------------------------------

let jumpCache = null;       // { key, hit }
let lastJumpCtx = null;

function computeJump(editor) {
  try {
    if (!editor || !isLatexEditor(editor)) return null;
    if (cfg().get('smartTab.enabled', true) === false) return null;
    const sel = editor.selection;
    if (!sel) return null;
    // 非空选区照常算跳出目标（如 ^ → ^{-1} 后 -1 被选中：Tab 应跳出、且不碰选中的文字）；
    // 跨行选区是「缩进整段」的意图，让给默认 Tab。
    if (!sel.isEmpty && sel.start.line !== sel.end.line) return null;
    const doc = editor.document;
    const pos = sel.active;
    // 只在「非空行的行首缩进」时让给默认 Tab；空行（如环境体里那行只有缩进）照样跳出
    const line = doc.lineAt(pos.line);
    if (line.text.slice(0, pos.character).trim() === '' && line.text.trim() !== '') return null;

    const useEnv = cfg().get('smartTab.environments', true) !== false;
    const useParen = cfg().get('smartTab.parentheses', true) !== false;
    const skipEnvs = cfg().get('smartTab.skipEnvs', ['document']) || [];
    const nlEnv = cfg().get('smartTab.newlineAfterEnv', true) !== false;
    const key = `${doc.uri ? doc.uri.toString() : ''}#${doc.version}@${pos.line}:${pos.character}:${useEnv}:${useParen}:${nlEnv}:${skipEnvs.join('|')}`;
    if (jumpCache && jumpCache.key === key) return jumpCache.hit;

    const text = doc.getText();
    const off = doc.offsetAt(pos);
    // 光标前正好是一个触发词或它的前缀（如打完 fun 等补全给出 function）→ 让给补全与 hsnips
    const m = /[A-Za-z][A-Za-z0-9]*$/.exec(text.slice(Math.max(0, off - 32), off));
    let hit = null;
    if (!(m && wordBlocksJump(m[0], Object.keys(effectiveTriggers())))) {
      hit = findJumpTarget(text, off, { environments: useEnv, parentheses: useParen, skipEnvs, newlineAfterEnv: nlEnv });
    }
    jumpCache = { key, hit };
    return hit;
  } catch (e) {
    return null;
  }
}

/** 「边打边转」留下的选区是否还原样保持着（决定 Tab 是否直接跳出） */
function autoSelectActive(editor) {
  try {
    if (!autoSel) return false;
    if (!editor || !editor.document) return false;
    if (editor.document.uri.toString() !== autoSel.uri) return false;
    const sel = editor.selection;
    if (!sel || sel.isEmpty) return false;
    const s = editor.document.offsetAt(sel.start);
    const e = editor.document.offsetAt(sel.end);
    if (s !== autoSel.start || e !== autoSel.end) return false;
    return editor.document.getText(new vscode.Range(sel.start, sel.end)) === autoSel.text;
  } catch (e) {
    return false;
  }
}

// —— 片段占位符跟踪 ——
// 扩展插入的片段会话里：Tab 先按原生走「真正的」占位符；
// 走到最后一个占位符后，如果片段是**单行**的（如 set、sum、hat 这类行内片段），
// 就把 Tab 改成智能 Tab 的「逐层紧贴跳出」——
// 否则原生会一口气把光标带到片段末尾 $0（如 \{(12)\} 里直接从 (12) 里跳到 \} 外面）。
// 多行片段（环境、\[…\]、aligned 模板）保持原生：走完占位符直接落到 \end{…} 的下一行。
let snippetNav = null;   // { uri, remaining, smartPop, word, at }
const SNIPPET_NAV_MS = 120 * 1000;

function snippetPlaceholderInfo(snippet) {
  const nums = new Set();
  let hasZero = false;
  const re = /\$(\d+)|\$\{(\d+)/g;
  let m;
  while ((m = re.exec(snippet)) !== null) {
    const n = Number(m[1] || m[2]);
    if (n === 0) hasZero = true;
    else nums.add(n);
  }
  return { count: nums.size, hasZero };
}

function setSnippetNav(doc, snippet, word) {
  const info = snippetPlaceholderInfo(snippet);
  snippetNav = {
    uri: doc && doc.uri ? doc.uri.toString() : '',
    remaining: info.count,
    smartPop: info.count >= 1 && !info.hasZero && !/\n/.test(snippet),
    word,
    at: Date.now(),
  };
  if (snippetNav.smartPop) trace(`片段 "${word}"：最后一个占位符起 Tab 改为逐层紧贴跳出`);
}

function snippetNavActive(editor) {
  if (!snippetNav) return null;
  if (!editor || !editor.document) return null;
  const uri = editor.document.uri ? editor.document.uri.toString() : '';
  if (uri !== snippetNav.uri) return null;
  if (Date.now() - snippetNav.at > SNIPPET_NAV_MS) return null;
  return snippetNav;
}

/** 刷新上下文键（Tab 按键绑定靠它们决定要不要接管） */
function refreshJumpContext(editor) {
  const ed = editor || vscode.window.activeTextEditor;
  const canExpand = !!computeTabExpand(ed);   // 光标前的词是触发词/前缀 → 即使正在片段会话里也要接管（见下）
  const canJump = !!computeJump(ed);          // 能跳出结构
  const auto = autoSelectActive(ed);          // 刚边打边转生成的选区还在 → Tab 直接跳出
  const key = `${canExpand}|${canJump}|${auto}`;
  if (lastJumpCtx === key) return;
  lastJumpCtx = key;
  try {
    vscode.commands.executeCommand('setContext', 'latexIme.canTabExpand', canExpand);
    vscode.commands.executeCommand('setContext', 'latexIme.canJumpOut', canJump);
    vscode.commands.executeCommand('setContext', 'latexIme.autoSelected', auto);
  } catch (e) { /* ignore */ }
}

/** 兜底：执行原生 Tab（缩进 / 占位符跳转），万一不可用则插入一个缩进 */
function fallbackTab(editor) {
  Promise.resolve(vscode.commands.executeCommand('tab')).then(undefined, () => {
    try {
      const cfgEd = vscode.workspace.getConfiguration('editor', editor.document);
      const unit = cfgEd.get('insertSpaces', true) ? ' '.repeat(cfgEd.get('tabSize', 4) || 4) : '\t';
      editor.edit((b) => b.insert(editor.selection.active, unit));
    } catch (e) { /* ignore */ }
  });
}

/**
 * 光标前的词能否展开成触发词片段：
 *   • 就是某个触发词本身（thm）
 *   • 或是某个触发词的前缀（func → function，取最短的那个候选）
 * 返回 { wordStart, caretEnd, snippet, word, typed } 或 null。
 */
function computeTabExpand(editor) {
  try {
    if (!editor || !isLatexEditor(editor)) return null;
    if (cfg().get('expandTypedTriggers', true) === false) return null;
    const sel = editor.selection;
    if (!sel || !sel.isEmpty) return null;
    const doc = editor.document;
    const off = doc.offsetAt(sel.active);
    const text = doc.getText();
    const m = /[A-Za-z][A-Za-z0-9]*$/.exec(text.slice(Math.max(0, off - 32), off));
    if (!m) return null;
    const typed = m[0];
    if (typed.length < 2) return null;          // 至少两个字符才算触发词/前缀，单字符不抢 Tab
    const wordStart = off - typed.length;
    if (wordStart > 0 && text[wordStart - 1] === '\\') return null;   // \thm 之类不动

    const map = effectiveTriggers();
    let word = map[typed] ? typed : null;
    if (!word) {
      const cands = Object.keys(map)
        .filter((t) => t.length > typed.length && t.toLowerCase().startsWith(typed.toLowerCase()))
        .sort((a, b) => a.length - b.length);
      if (!cands.length) return null;
      word = cands[0];
    }
    const entry = map[word];
    const snippet0 = typeof entry === 'string' ? entry : entry.body;
    const flags = typeof entry === 'string' ? '' : (entry.flags || '');
    if (!snippet0) return null;
    if (flags.indexOf('m') >= 0) {
      const r = analyzeContext(text, wordStart, analyzeOptions());
      if (r.reason !== 'math') return null;
    }
    if (flags.indexOf('b') >= 0) {
      const lineStart = text.lastIndexOf('\n', wordStart - 1) + 1;
      if (text.slice(lineStart, wordStart).trim() !== '') return null;
    }
    let snippet = snippet0;
    if (/\n/.test(snippet) && !/\n$/.test(snippet)) snippet += '\n';
    return { wordStart, caretEnd: off, snippet, word, typed };
  } catch (e) {
    return null;
  }
}

/** 智能 Tab 的命令：先试展开触发词，再试跳出，都不行就走默认 Tab */
function jumpOut() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;

  // ① 光标前的词是触发词或它的前缀（func → function）→ 直接展开
  const exp = computeTabExpand(ed);
  if (exp) {
    const doc = ed.document;
    const run = () => {
      // 用「按 Tab 那一刻」记下的区间：退出旧片段会话可能把光标带走，不能依赖它
      const range = new vscode.Range(doc.positionAt(exp.wordStart), doc.positionAt(exp.caretEnd));
      if (doc.getText(range) !== exp.typed) {     // 区间已不是刚才那个词 → 放弃，走默认 Tab
        trace(`智能 Tab：放弃展开 "${exp.word}"（区间内容已变）`);
        fallbackTab(ed);
        return;
      }
      ed.edit((b) => b.delete(range)).then((ok) => {
        if (ok === false) return;
        const p = doc.positionAt(exp.wordStart);
        ed.selection = new vscode.Selection(p, p);
        vscode.commands.executeCommand('editor.action.insertSnippet', { snippet: exp.snippet }).then(undefined, () => {});
        setSnippetNav(doc, exp.snippet, exp.word);
        log(`智能 Tab：展开触发词 ${exp.word}`);
        trace(`智能 Tab：展开触发词 "${exp.word}"（输入的是 "${exp.typed}"）`);
      });
    };
    // 若正在片段会话中（$1/$2 之间），先退出会话，免得新片段被卷进旧会话
    Promise.resolve(vscode.commands.executeCommand('leaveSnippet')).then(run, run);
    return;
  }

  // ② 能跳出就跳出（只挪光标、不改写文字）
  const hit = computeJump(ed);
  if (!hit) { fallbackTab(ed); return; }
  const doc = ed.document;

  const usedAuto = autoSelectActive(ed);
  const p = doc.positionAt(hit.offset);
  ed.selection = new vscode.Selection(p, p);
  if (usedAuto) { autoSel = null; refreshJumpContext(ed); }
  try { ed.revealRange(new vscode.Range(p, p)); } catch (e) { /* ignore */ }
  log(`智能 Tab：跳出 ${hit.kind}${hit.env ? '(' + hit.env + ')' : ''} → offset ${hit.offset}`);
  trace(`智能 Tab：跳出 ${hit.kind}${hit.env ? '(' + hit.env + ')' : ''} @${hit.offset}${usedAuto ? '（自动选区）' : ''}`);
}

/** 总开关菜单（点击状态栏） */
async function openMenu() {
  const notesEn = cfg().get('notesLanguage', 'chinese') === 'english';
  const items = [
    { id: 'toggle', label: `$(${enabled ? 'check' : 'circle-slash'}) 自动切换：${enabled ? '已启用' : '已禁用'}` },
    { id: 'notes', label: `$(book) 笔记语言：${notesEn ? '英文笔记（默认全英）' : '中文笔记（默认中文）'}`, detail: '点击切换；英文笔记下正文、注释、\\text{} 全部默认英文' },
    { id: 'forceEn', label: '$(arrow-right) 临时强制英文（本行 6 秒）', detail: '适合在中文笔记里敲 dm/mk 等触发词' },
    { id: 'forceCn', label: '$(arrow-left) 临时强制中文（本行 6 秒）' },
    { id: 'calCn', label: `$(check) 校准：我现在处于「中文」输入（扩展记录：${sameImeState === 'unknown' ? '未知' : sameImeState === 'cn' ? '中文' : '英文'}）` },
    { id: 'calEn', label: '$(check) 校准：我现在处于「英文」输入（扩展会立刻切回中文）' },
    { id: 'resend', label: '$(sync) 状态反了？重发一次切换键（盲切一次）' },
    { id: 'test', label: '$(zap) 测试：发送一次中/英切换键' },
    { id: 'diag', label: '$(info) 查看运行诊断信息' },
    { id: 'insertDm', label: '$(symbol-operator) 插入显示公式 \\[ … \\]' },
    { id: 'insertMk', label: '$(symbol-operator) 插入行内公式 $ … $' },
    { id: 'smartTab', label: `$(debug-step-over) 智能 Tab 跳出（{} [] () \\begin…\\end）：${cfg().get('smartTab.enabled', true) === false ? '关' : '开'}`, detail: '光标在括号/环境里时按 Tab 跳到闭合符之后，嵌套可逐层跳出' },
    { id: 'inspect', label: '$(search) 查看光标处的判定' },
    { id: 'detect', label: '$(gear) 选择中文/英文输入法（按系统已装枚举）' },
  ];
  const pick = await vscode.window.showQuickPick(items, { title: 'LaTeX IME Context' });
  if (!pick) return;
  switch (pick.id) {
    case 'toggle': vscode.commands.executeCommand('latexIme.toggleEnabled'); break;
    case 'notes': vscode.commands.executeCommand('latexIme.toggleNotesLanguage'); break;
    case 'forceEn': vscode.commands.executeCommand('latexIme.forceEnglish'); break;
    case 'forceCn': vscode.commands.executeCommand('latexIme.forceChinese'); break;
    case 'calCn': vscode.commands.executeCommand('latexIme.calibrate', 'cn'); break;
    case 'calEn': vscode.commands.executeCommand('latexIme.calibrate', 'en'); break;
    case 'resend': vscode.commands.executeCommand('latexIme.resendToggle'); break;
    case 'test': vscode.commands.executeCommand('latexIme.testSameImeToggle'); break;
    case 'diag': vscode.commands.executeCommand('latexIme.diagnostics'); break;
    case 'insertDm': vscode.commands.executeCommand('latexIme.insertDm'); break;
    case 'insertMk': vscode.commands.executeCommand('latexIme.insertMk'); break;
    case 'smartTab': {
      const next = cfg().get('smartTab.enabled', true) === false;
      cfg().update('smartTab.enabled', next, vscode.ConfigurationTarget.Global).then(() => {
        jumpCache = null;
        lastJumpCtx = null;
        refreshJumpContext(vscode.window.activeTextEditor);
        vscode.window.setStatusBarMessage(`LaTeX IME: 智能 Tab 跳出已${next ? '开启' : '关闭'}`, 2500);
      });
      break;
    }
    case 'inspect': vscode.commands.executeCommand('latexIme.showStatus'); break;
    case 'detect': vscode.commands.executeCommand('latexIme.detectImeCodes'); break;
  }
}

/** 笔记语言总开关：中文笔记 <-> 英文笔记 */
function toggleNotesLanguage() {
  const next = cfg().get('notesLanguage', 'chinese') === 'english' ? 'chinese' : 'english';
  cfg().update('notesLanguage', next, vscode.ConfigurationTarget.Global).then(() => {
    lastApplied = null;
    vscode.window.setStatusBarMessage(`LaTeX IME: 已切换到${next === 'english' ? '英文笔记（默认全英）' : '中文笔记'}`, 2500);
    update(vscode.window.activeTextEditor);
  });
}

// ---------------------------------------------------------------------------

function activate(context) {
  extensionPath = context.extensionPath;
  enabled = cfg().get('enabled', true);

  output = vscode.window.createOutputChannel('LaTeX IME Context');
  context.subscriptions.push(output);

  // 会话横幅写进变更日志：一眼看出「跑的是哪个版本、触发词表里有什么」
  try {
    const pkg = JSON.parse(require('fs').readFileSync(require('path').join(extensionPath, 'package.json'), 'utf8'));
    const keys = Object.keys(effectiveTriggers());
    trace(`=== LaTeX IME Context v${pkg.version} 启动 | 触发词 ${keys.length} 个: ${keys.join(',')} ===`);
  } catch (e) { /* ignore */ }

  refreshJumpContext(vscode.window.activeTextEditor);   // 初始化智能 Tab 的上下文键

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'latexIme.menu';
  context.subscriptions.push(statusItem);

  // 扩展更新后、窗口尚未重载时，context.extensionPath 可能指向已被删掉的旧目录，
  // 表现为「im-select 找不到」——这里给一句明确的提示（重载即可）
  try {
    if (!require('fs').existsSync(resolveExePath()) && cfg().get('warnOnMissingBinary', true)) {
      vscode.window.showWarningMessage('LaTeX IME: 扩展文件已更新，请运行一次「开发人员: 重新加载窗口」后再使用。');
    }
  } catch (e) { /* ignore */ }

  // 确保自带 exe 可执行（WSL 下需要 +x 才能通过互操作调用）
  ensureExecutable(resolveExePath());
  if (!isWsl()) log(`非 WSL 环境（${process.platform}）：im-select 直接调用；macOS/Linux 需自备兼容的 im-select`);

  // 启动时读取当前输入法编码（仅 layout 模式需要）
  const switchMode0 = cfg().get('imeSwitchMode', 'layout');
  captureInitialAsEnglish = cfg().get('captureInitialImeAsEnglish', true);
  if (switchMode0 === 'layout' && captureInitialAsEnglish) {
    runImSelect(resolveExePath(), null, log, (err, current) => {
      if (err) { log(`初始读取失败: ${err.message}`); return; }
      log(`当前输入法编码 = ${current}`);
      const cnCode = String(cfg().get('chineseCode', '2052'));
      if (current && current !== cnCode) {
        context.workspaceState.update('detectedEnglishCode', current);
        log(`记录英文编码 = ${current}`);
      }
    });
  }

  // layout 模式：枚举系统已装输入法，自动纠正编码（解决 1033 未安装导致「没反应」）
  if (switchMode0 === 'layout') {
    autoDetectLayouts(false);
    // 预热 WSL 互操作：别让用户第一次移动光标时才撞上冷启动（会偶发失败）
    runImSelect(resolveExePath(), null, log, () => {});
  }

  // 同 IME 模式：恢复/校准中英状态
  globalStateRef = context.globalState;
  if (switchMode0 === 'sameIme') {
    const stored = context.globalState.get('sameImeState');
    if (stored === 'cn' || stored === 'en') {
      sameImeState = stored;
      log(`同IME：恢复状态 ${stored}`);
    } else {
      vscode.window.showInformationMessage(
        'LaTeX IME: 现在微软拼音处于「中文」还是「英文」输入？（用于校准，只问这一次）',
        '中文', '英文'
      ).then((sel) => {
        if (sel === '中文') { sameImeState = 'cn'; context.globalState.update('sameImeState', 'cn'); }
        else if (sel === '英文') { sameImeState = 'en'; context.globalState.update('sameImeState', 'en'); }
        lastApplied = null;
        update(vscode.window.activeTextEditor);
      });
    }
  }

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((e) => {
      refreshJumpContext(e && e.textEditor);
      scheduleUpdate(cfg().get('debounceMs', 40));
    }),
    vscode.window.onDidChangeActiveTextEditor((e) => {
      lastApplied = null;
      refreshJumpContext(e);
      update(e);
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || e.document !== ed.document) return;
      refreshJumpContext(ed);   // 智能 Tab 的可用状态跟着光标/文本走
      if (isLatexEditor(ed)) {
        trace(`${new Date().toISOString().slice(11, 23)} n=${e.contentChanges.length} `
          + e.contentChanges.slice(0, 4).map((c) => `[replaceLen=${c.rangeLength} text=${JSON.stringify(c.text.slice(0, 24))} @${c.range.start.line}:${c.range.start.character}]`).join(' '));
      }
      if (healIfCommittedIntoSnippet(e, ed)) return;   // 兜底：清掉落进片段的输入法提交
      if (maybeAutoConvert(e, ed)) return;              // 边打边转（纯文本编辑，不新开片段会话）
      if (maybeExpandTriggerWord(e, ed)) return;        // 触发词已展开，不再走后续判定
      // 从输入内容反向校准「同 IME」状态：
      //  • 敲出汉字 ⇒ 当时必定是中文模式
      //  • 敲出 `fan'fan'` 这种「字母'字母'」串 ⇒ 那是拼音在英文模式下被直接上屏，当时其实是英文
      const inserted = e.contentChanges.map((c) => c.text).join('');
      if (/[\u3400-\u9fff\uf900-\ufaff]/.test(inserted)) {
        if (sameImeState !== 'cn') {
          sameImeState = 'cn';
          if (globalStateRef) globalStateRef.update('sameImeState', 'cn');
          log('校准：当前为中文模式（检测到汉字上屏）');
        }
      } else if (/[a-z]{1,10}['\u2019][a-z]{1,10}['\u2019]/i.test(inserted)) {
        if (sameImeState !== 'en') {
          sameImeState = 'en';
          if (globalStateRef) globalStateRef.update('sameImeState', 'en');
          log("校准：当前其实为英文模式（检测到拼音被直接上屏，如 fan'fan'）");
        }
      }
      scheduleUpdate(cfg().get('debounceMs', 40));
    }),
    vscode.window.onDidChangeWindowState((s) => {
      if (!s.focused) return;
      resyncLayoutState();
      refreshJumpContext(vscode.window.activeTextEditor);
      update(vscode.window.activeTextEditor);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('latexIme')) {
        enabled = cfg().get('enabled', true);
        jumpCache = null;
        refreshJumpContext(vscode.window.activeTextEditor);
        update(vscode.window.activeTextEditor);
      }
    }),

    vscode.commands.registerCommand('latexIme.menu', openMenu),
    vscode.commands.registerCommand('latexIme.toggleNotesLanguage', toggleNotesLanguage),
    vscode.commands.registerCommand('latexIme.insertDm', () => quickInsert('dm', '显示公式')),
    vscode.commands.registerCommand('latexIme.insertMk', () => quickInsert('mk', '行内公式')),
    vscode.commands.registerCommand('latexIme.jumpOut', jumpOut),
    // 占位符导航：我们插入的片段是 VS Code 片段会话，hsnips 自己的跳转命令对它无效（Tab 会“没反应”）
    vscode.commands.registerCommand('latexIme.nextPlaceholder', () => {
      const ed = vscode.window.activeTextEditor;
      const nav = snippetNavActive(ed);
      // 还有真正的下一个占位符 → 原生导航
      if (nav && nav.remaining > 1) {
        nav.remaining -= 1;
        trace(`智能 Tab：占位符 → 下一个（还剩 ${nav.remaining} 个）`);
        return vscode.commands.executeCommand('jumpToNextSnippetPlaceholder');
      }
      // 走到最后一个占位符（单行片段）：改成逐层紧贴跳出，有目标才跳
      if (nav && nav.smartPop) {
        const hit = ed ? computeJump(ed) : null;
        if (hit) {
          const p = ed.document.positionAt(hit.offset);
          ed.selection = new vscode.Selection(p, p);
          try { ed.revealRange(new vscode.Range(p, p)); } catch (e) { /* ignore */ }
          trace(`智能 Tab：片段末段跳出 ${hit.kind}${hit.env ? '(' + hit.env + ')' : ''} @${hit.offset}`);
          return;
        }
      }
      trace('智能 Tab：占位符 → 下一个（VS Code 原生）');
      return vscode.commands.executeCommand('jumpToNextSnippetPlaceholder');
    }),
    vscode.commands.registerCommand('latexIme.resendToggle', () => {
      const ed = vscode.window.activeTextEditor;
      const shortcut = cfg().get('sameImeShortcut', 'ctrl+space');
      sendSameImeToggle(shortcut, log, (err) => {
        if (err) { vscode.window.showErrorMessage(`发送 ${shortcut} 失败：${err.message}`); return; }
        let desired = sameImeState;
        if (ed && isLatexEditor(ed)) {
          desired = analyzeContext(ed.document.getText(), ed.document.offsetAt(ed.selection.active), analyzeOptions()).mode;
        }
        sameImeState = desired === 'cn' || desired === 'en' ? desired : sameImeState;
        if (globalStateRef) globalStateRef.update('sameImeState', sameImeState);
        vscode.window.setStatusBarMessage(`LaTeX IME: 已重发一次切换键，记录状态同步为${sameImeState === 'cn' ? '中文' : '英文'}`, 2500);
      });
    }),
    vscode.commands.registerCommand('latexIme.diagnostics', () => {
      const s = getSameImeStats();
      const ed = vscode.window.activeTextEditor;
      let desired = '-';
      let reason = '-';
      if (ed && isLatexEditor(ed)) {
        const r = analyzeContext(ed.document.getText(), ed.document.offsetAt(ed.selection.active), analyzeOptions());
        desired = r.mode;
        reason = r.reason;
      }
      const lines = [
        `时间: ${new Date().toLocaleString()}`,
        `总开关: ${enabled ? '启用' : '禁用'} | 切换方式: ${cfg().get('imeSwitchMode', 'layout')} | 切换键: ${cfg().get('sameImeShortcut', 'ctrl+space')}`,
        `扩展记录的输入法状态: ${sameImeState}`,
        `光标处期望: ${desired} (${reason})`,
        `常驻 PowerShell: 存活=${s.shellAlive} 就绪=${s.shellReady} 待发=${s.pending} 重启次数=${s.restarts}`,
        `发出切换: 常驻=${s.sent} 一次性=${s.oneShot} 排队=${s.queued} 超时补救=${s.rescued}`,
        `最后错误: ${s.lastError || '无'}`,
      ];
      if (output) { output.show(true); lines.forEach((l) => output.appendLine(l)); }
      vscode.window.showInformationMessage(
        `LaTeX IME 诊断：记录=${sameImeState}，期望=${desired}，常驻进程${s.shellAlive ? (s.shellReady ? '正常' : '未就绪') : '未运行'}，累计发出切换 ${s.sent + s.oneShot} 次`
      );
    }),
    vscode.commands.registerCommand('latexIme.calibrate', (mode) => {
      if (mode !== 'cn' && mode !== 'en') return;
      sameImeState = mode;
      if (globalStateRef) globalStateRef.update('sameImeState', mode);
      vscode.window.setStatusBarMessage(`LaTeX IME: 已校准为${mode === 'cn' ? '中文' : '英文'}模式`, 2500);
      lastApplied = null;
      update(vscode.window.activeTextEditor);
    }),
    vscode.commands.registerCommand('latexIme.testSameImeToggle', () => {
      const shortcut = cfg().get('sameImeShortcut', 'ctrl+space');
      sendSameImeToggle(shortcut, log, (err) => {
        if (err) { vscode.window.showErrorMessage(`发送 ${shortcut} 失败：${err.message}`); return; }
        sameImeState = sameImeState === 'cn' ? 'en' : 'cn';
        if (globalStateRef) globalStateRef.update('sameImeState', sameImeState);
        vscode.window.showInformationMessage(`已发送「${shortcut}」一次。若输入法指示器在 中/英 之间变了，说明同 IME 模式可用；当前记录为${sameImeState === 'cn' ? '中文' : '英文'}。`);
      });
    }),
    vscode.commands.registerCommand('latexIme.toggleEnabled', () => {
      enabled = !enabled;
      cfg().update('enabled', enabled, vscode.ConfigurationTarget.Global);
      vscode.window.setStatusBarMessage(`LaTeX IME: ${enabled ? '已启用' : '已禁用'}`, 2000);
      if (enabled) { lastApplied = null; update(vscode.window.activeTextEditor); }
      else renderStatus({ mode: null, reason: '已禁用' });
    }),
    vscode.commands.registerCommand('latexIme.switchToChinese', () => applyMode('cn', '手动')),
    vscode.commands.registerCommand('latexIme.switchToEnglish', () => applyMode('en', '手动')),
    vscode.commands.registerCommand('latexIme.forceEnglish', () => forceFor('en')),
    vscode.commands.registerCommand('latexIme.forceChinese', () => forceFor('cn')),
    vscode.commands.registerCommand('latexIme.showStatus', () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) return;
      const r = analyzeContext(ed.document.getText(), ed.document.offsetAt(ed.selection.active), analyzeOptions());
      vscode.window.showInformationMessage(`光标处期望：${r.mode === 'en' ? '英文' : '中文'}（${r.reason}）`);
    }),
    vscode.commands.registerCommand('latexIme.detectImeCodes', () => {
      listWindowsLayouts(async (err, items) => {
        if (err || !items || !items.length) {
          vscode.window.showErrorMessage(`无法枚举 Windows 输入法：${err ? err.message : '结果为空'}`);
          return;
        }
        const choices = items.map((i) => ({ label: i.label, description: i.isChinese ? '中文' : '英文', item: i }));
        const cnPick = await vscode.window.showQuickPick(choices, { title: '选择「中文」输入法', placeHolder: `当前设置：${effectiveCode('cn')}` });
        if (!cnPick) return;
        const enPick = await vscode.window.showQuickPick(choices, { title: '选择「英文」输入法', placeHolder: `当前设置：${effectiveCode('en')}` });
        if (!enPick) return;

        codeOverride.cn = cnPick.item.code;
        codeOverride.en = enPick.item.code;
        layoutNames.cn = cnPick.item.label;
        layoutNames.en = enPick.item.label;
        await cfg().update('chineseCode', String(cnPick.item.code), vscode.ConfigurationTarget.Global);
        await cfg().update('englishCode', String(enPick.item.code), vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(
          `LaTeX IME: 中文 = ${cnPick.item.code}（${cnPick.item.langTag}），英文 = ${enPick.item.code}（${enPick.item.langTag}）`
        );
        lastApplied = null;
        update(vscode.window.activeTextEditor);
      });
    })
  );

  // layout 模式：定期读回真实编码，防止手动切换造成的状态失真
  const resyncTimer = setInterval(() => {
    if (!enabled) return;
    if (cfg().get('imeSwitchMode', 'layout') !== 'layout') return;
    const ed = vscode.window.activeTextEditor;
    if (!ed || !isLatexEditor(ed)) return;
    if (!vscode.window.state.focused) return;
    resyncLayoutState();
  }, 5000);
  context.subscriptions.push({ dispose: () => clearInterval(resyncTimer) });

  update(vscode.window.activeTextEditor);
}

function forceFor(mode) {
  const ed = vscode.window.activeTextEditor;
  forceMode = mode;
  forceUntil = Date.now() + FORCE_MS;
  forceLine = ed ? ed.selection.active.line : -1;
  applyMode(mode, '临时强制');
}

function deactivate() {
  if (debounceTimer) clearTimeout(debounceTimer);
  disposeSameImeShell();
}

module.exports = { activate, deactivate };
