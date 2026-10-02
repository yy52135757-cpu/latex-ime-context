'use strict';

/*
 * 「输入法一次上屏触发词 → 自动展开」的回归测试。
 * 用 mock 的 vscode 模块加载 extension.js，直接驱动 onDidChangeTextDocument 回调。
 *
 *   node test/trigger.test.js
 */

const Module = require('module');
const path = require('path');
const fs = require('fs');

const TMP_HSNIPS = require('os').tmpdir() + '/latex-ime-test.hsnips';

// ---------- vscode 模拟 ----------
class Position {
  constructor(line, character) { this.line = line; this.character = character; }
}
class Range {
  constructor(start, end) { this.start = start; this.end = end; }
  get isEmpty() { return this.start.line === this.end.line && this.start.character === this.end.character; }
}
class Selection extends Range {
  constructor(a, b) { super(a, b); this.anchor = a; this.active = b; }
}

const DEFAULTS = {
  'latexIme.imeSwitchMode': 'sameIme',           // 避免 activate 时去枚举 Windows 输入法
  'latexIme.captureInitialImeAsEnglish': false,
  'latexIme.expandTypedTriggers': true,
  'latexIme.triggerSnippets': { dm: '\\[\n\t$1\n.\\]\n$0', mk: '$${1}$ $2', text: '\\text{$1}$0' },
  'latexIme.languageIds': ['latex', 'tex'],
  'latexIme.triggerMatchMode': 'exact',
  'latexIme.triggerWords': ['dm', 'mk'],
  'latexIme.hsnipsFile': TMP_HSNIPS,
};

const docChangeHandlers = [];
const executed = [];
let editedRange = null;
let editorInstance = null;

const mockVscode = {
  Position, Range, Selection,
  StatusBarAlignment: { Right: 2 },
  ConfigurationTarget: { Global: 1 },
  window: {
    activeTextEditor: null,
    state: { focused: true },
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    onDidChangeTextEditorSelection: () => ({ dispose() {} }),
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    onDidChangeWindowState: () => ({ dispose() {} }),
    showInformationMessage: () => Promise.resolve(undefined),
    showWarningMessage: () => Promise.resolve(undefined),
    showErrorMessage: (m) => { executed.push(['error', m]); return Promise.resolve(undefined); },
    setStatusBarMessage: () => {},
  },
  workspace: {
    getConfiguration: () => ({
      get: (key, def) => (DEFAULTS['latexIme.' + key] !== undefined ? DEFAULTS['latexIme.' + key] : def),
      update: () => Promise.resolve(),
    }),
    onDidChangeTextDocument: (cb) => { docChangeHandlers.push(cb); return { dispose() {} }; },
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  commands: {
    registerCommand: () => ({ dispose() {} }),
    executeCommand: (cmd, arg) => {
      executed.push([cmd, arg]);
      // 让 insertSnippet 真的写入文档（否则后续兜底测试没法定位）
      if (cmd === 'editor.action.insertSnippet' && arg && arg.snippet && mockVscode.window.activeTextEditor) {
        const ed = mockVscode.window.activeTextEditor;
        ed.document.insertAt(ed.document.offsetAt(ed.selection.start), arg.snippet);
      }
      return Promise.resolve();
    },
  },
};

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return mockVscode;
  return origLoad.apply(this, arguments);
};

// ---------- 极简 TextDocument / Editor ----------
class Doc {
  constructor(text) { this._text = text; this.languageId = 'latex'; }
  getText(from, to) {
    if (!from) return this._text;
    return this._text.slice(this.offsetAt(from), this.offsetAt(to));
  }
  offsetAt(pos) {
    const lines = this._text.split('\n');
    let off = 0;
    for (let i = 0; i < pos.line; i++) off += lines[i].length + 1;
    return off + pos.character;
  }
  positionAt(off) {
    const before = this._text.slice(0, off);
    const line = before.split('\n').length - 1;
    const lastNl = before.lastIndexOf('\n');
    return new Position(line, off - (lastNl + 1));
  }
  insertAt(off, text) { this._text = this._text.slice(0, off) + text + this._text.slice(off); }
  deleteRange(startOff, endOff) { this._text = this._text.slice(0, startOff) + this._text.slice(endOff); }
}

function makeEditor(doc) {
  const ed = {
    document: doc,
    selection: new Selection(new Position(0, 0), new Position(0, 0)),
    edit(cb) {
      const builder = { delete(r) { editedRange = r; } };
      cb(builder);
      // 模拟 VS Code：edit 真的会改动文档
      if (editedRange) {
        doc.deleteRange(doc.offsetAt(editedRange.start), doc.offsetAt(editedRange.end));
      }
      return Promise.resolve(true);
    },
  };
  return ed;
}

const WAIT = 260;   // 展开是延迟 150ms 执行的，等久一点

async function fireChangeGeneric(editor, text, atOffset, replaceLen, waitMs) {
  const doc = editor.document;
  if (replaceLen > 0) doc.deleteRange(atOffset, atOffset + replaceLen);
  doc.insertAt(atOffset, text);
  const start = doc.positionAt(atOffset);
  const end = doc.positionAt(atOffset + text.length);
  const change = { text, rangeLength: replaceLen, range: new Range(start, end) };
  docChangeHandlers.forEach((cb) => cb({ document: doc, contentChanges: [change] }));
  await new Promise((resolve) => setTimeout(resolve, waitMs === undefined ? WAIT : waitMs));
}

async function fireChange(editor, text, atOffset) {
  // 真实事件触发时，文档已经包含插入的文字（这点很重要：定位靠文档内容）
  await fireChangeGeneric(editor, text, atOffset, 0);
}

// ---------- 运行 ----------
// 测试的变更日志写到单独文件，别污染用户真实使用时的 /tmp/latex-ime-changes.log
process.env.LATEX_IME_CHANGE_LOG = require('os').tmpdir() + '/latex-ime-test-changes.log';
const ext = require(path.join(__dirname, '..', 'extension.js'));
ext.activate({
  extensionPath: path.join(__dirname, '..'),
  subscriptions: { push() {}, dispose() {} },
  globalState: { get: () => undefined, update: () => Promise.resolve() },
  workspaceState: { get: () => undefined, update: () => Promise.resolve() },
});

let pass = 0;
let fail = 0;

function check(name, ok, extra) {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`); }
}

function reset() {
  executed.length = 0;
  editedRange = null;
}

(async function main() {
  // 场景 1：中文输入法一次上屏 "dm"（前面是换行）
  {
    reset();
    const doc = new Doc('abc\n');
    const ed = makeEditor(doc);
    mockVscode.window.activeTextEditor = ed;
    await fireChange(ed, 'dm', doc.offsetAt(new Position(1, 0)));

    check('多字符上屏 dm：删除了正确区间（不是插在 dm 后面）', !!editedRange
      && editedRange.start.line === 1 && editedRange.start.character === 0
      && editedRange.end.line === 1 && editedRange.end.character === 2,
      editedRange ? `实得 start=${editedRange.start.line}:${editedRange.start.character} end=${editedRange.end.line}:${editedRange.end.character}` : '未调用 edit');

    const ins = executed.find((c) => c[0] === 'editor.action.insertSnippet');
    check('多字符上屏 dm：插入了 dm 片段', !!ins && ins[1].snippet.indexOf('\\[') === 0,
      ins ? JSON.stringify(ins[1]) : '未调用 insertSnippet');

    check('多字符上屏 dm：光标被挪到删除处', ed.selection.start.line === 1 && ed.selection.start.character === 0,
      `实得 ${ed.selection.start.line}:${ed.selection.start.character}`);
  }

  // 场景 2：一次上屏 "mk"
  {
    reset();
    const doc = new Doc('正文\n');
    const ed = makeEditor(doc);
    mockVscode.window.activeTextEditor = ed;
    await fireChange(ed, 'mk', doc.offsetAt(new Position(1, 0)));
    const ins = executed.find((c) => c[0] === 'editor.action.insertSnippet');
    check('多字符上屏 mk：插入 mk 片段', !!ins && ins[1].snippet === '$${1}$ $2',
      ins ? JSON.stringify(ins[1]) : '未调用 insertSnippet');
  }

  // 场景 3：IME 逐字提交 —— 单字符完成触发词也要展开
  {
    reset();
    const doc = new Doc('abc\nd');
    const ed = makeEditor(doc);
    mockVscode.window.activeTextEditor = ed;
    await fireChange(ed, 'm', doc.offsetAt(new Position(1, 1)));
    check('单字符补全 dm：删除区间覆盖整个词', !!editedRange
      && editedRange.start.line === 1 && editedRange.start.character === 0
      && editedRange.end.line === 1 && editedRange.end.character === 2,
      editedRange ? `实得 ${editedRange.start.character}~${editedRange.end.character}` : '未调用 edit');
    check('单字符补全 dm：插入了 dm 片段', executed.some((c) => c[0] === 'editor.action.insertSnippet'));
  }

  // 场景 4：一次上屏了非触发词
  {
    reset();
    const doc = new Doc('abc\n');
    const ed = makeEditor(doc);
    mockVscode.window.activeTextEditor = ed;
    await fireChange(ed, 'foo', doc.offsetAt(new Position(1, 0)));
    check('非触发词不处理', editedRange === null && executed.length === 0);
  }

  // 场景 5：触发词后面又接了字母（abcdm）→ 整词不是触发词，不处理
  {
    reset();
    const doc = new Doc('abcdm\n');
    const ed = makeEditor(doc);
    mockVscode.window.activeTextEditor = ed;
    await fireChange(ed, 'dm', doc.offsetAt(new Position(0, 2)));
    check('整词不匹配时不处理', editedRange === null && executed.length === 0);
  }

  // 场景 6：前面是空格 → 处理
  {
    reset();
    const doc = new Doc('中文 \n');
    const ed = makeEditor(doc);
    mockVscode.window.activeTextEditor = ed;
    await fireChange(ed, 'dm', doc.offsetAt(new Position(0, 3)));
    check('前面是空格时正常展开', !!editedRange && executed.some((c) => c[0] === 'editor.action.insertSnippet'));
  }

  // 场景 7：带反斜杠的 \text 不要动（否则会变成 \\text{}）
  {
    reset();
    const doc = new Doc('\\text\n');
    const ed = makeEditor(doc);
    mockVscode.window.activeTextEditor = ed;
    await fireChange(ed, 't', doc.offsetAt(new Position(0, 4)));
    check('\\text 不展开（避免多一个反斜杠）', editedRange === null && executed.length === 0);
  }

  // 场景 8：英文单词里的 text（context）不展开
  {
    reset();
    const doc = new Doc('context\n');
    const ed = makeEditor(doc);
    mockVscode.window.activeTextEditor = ed;
    await fireChange(ed, 't', doc.offsetAt(new Position(0, 6)));
    check('context 不展开（整词不是 text）', editedRange === null && executed.length === 0);
  }

  // 场景 9：真正输入 text → 展开为 \text{}
  {
    reset();
    const doc = new Doc('\n  tex');
    const ed = makeEditor(doc);
    mockVscode.window.activeTextEditor = ed;
    await fireChange(ed, 't', doc.offsetAt(new Position(1, 5)));
    check('text 正常展开', executed.some((c) => c[0] === 'editor.action.insertSnippet'));
  }

  // 场景 10：IME 以「替换组合串」方式提交（replaceLen > 0）也要展开
  {
    reset();
    const doc = new Doc('abc\nd');
    const ed = makeEditor(doc);
    mockVscode.window.activeTextEditor = ed;
    await fireChangeGeneric(ed, 'dm', doc.offsetAt(new Position(1, 0)), 1);
    check('替换式提交 dm：删除区间覆盖整个词', !!editedRange
      && editedRange.start.line === 1 && editedRange.start.character === 0
      && editedRange.end.line === 1 && editedRange.end.character === 2,
      editedRange ? `实得 ${editedRange.start.character}~${editedRange.end.character}` : '未调用 edit');
    check('替换式提交 dm：插入了 dm 片段', executed.some((c) => c[0] === 'editor.action.insertSnippet'));
  }

  // 场景 11：组合串中间态不展开（拿到 "dm" → 立刻被清空 → 什么都不做）
  {
    reset();
    const doc = new Doc('abc\n');
    const ed = makeEditor(doc);
    mockVscode.window.activeTextEditor = ed;
    const at = doc.offsetAt(new Position(1, 0));
    await fireChangeGeneric(ed, 'd', at, 0, 30);           // 输入 d
    await fireChangeGeneric(ed, 'dm', at, 1, 30);          // 组合串变成 dm（替换）
    await fireChangeGeneric(ed, '', at, 2, 30);            // 组合串被清空 ← 关键
    await new Promise((r) => setTimeout(r, WAIT));         // 等足以让任何挂起展开触发
    check('组合串中间态不展开', editedRange === null && executed.length === 0,
      `edit=${!!editedRange} exec=${executed.length}`);
  }

  // 场景 12：组合串清空后的真正提交 → 应该展开，且连同尾随空格一起删掉
  {
    reset();
    const doc = new Doc('abc\n');
    const ed = makeEditor(doc);
    mockVscode.window.activeTextEditor = ed;
    const at = doc.offsetAt(new Position(1, 0));
    await fireChangeGeneric(ed, 'd', at, 0, 30);
    await fireChangeGeneric(ed, 'dm', at, 1, 30);
    await fireChangeGeneric(ed, '', at, 2, 30);
    await fireChangeGeneric(ed, 'dm  ', at, 0);           // Enter 提交（带尾随空格）
    check('组合串提交后展开：删除区间覆盖整个上屏文字（含空格）', !!editedRange
      && editedRange.start.line === 1 && editedRange.start.character === 0
      && editedRange.end.line === 1 && editedRange.end.character === 4,
      editedRange ? `实得 ${editedRange.start.character}~${editedRange.end.character}` : '未调用 edit');
    check('组合串提交后展开：插入了 dm 片段', executed.some((c) => c[0] === 'editor.action.insertSnippet'));
  }

  // 场景 13：兜底 —— 输入法把提交塞进了刚插入的片段里，应自动清除
  {
    const doc = new Doc('abc\n');
    const ed = makeEditor(doc);
    mockVscode.window.activeTextEditor = ed;
    const at = doc.offsetAt(new Position(1, 0));
    await fireChange(ed, 'dm', at);                       // 展开一次
    const tabOff = at + 4;                                // 片段里 $1 所在处（\[ + \n + \t）
    reset();
    await fireChange(ed, 'dm  ', tabOff);                 // 模拟提交落进片段
    check('兜底：清除了落进片段的输入法提交', !!editedRange
      && doc.offsetAt(editedRange.start) === tabOff
      && doc.offsetAt(editedRange.end) === tabOff + 4,
      editedRange ? `实得 ${doc.offsetAt(editedRange.start)}~${doc.offsetAt(editedRange.end)}` : '未调用 edit');
    check('兜底：没有再展开第二次', !executed.some((c) => c[0] === 'editor.action.insertSnippet'));
  }

  // 场景 14：从 latex.hsnips 读到的触发词（thm 等）也能在输入法上屏时展开
  {
    fs.writeFileSync(TMP_HSNIPS,
      'snippet thm "定理环境（无标题）" w\n\\begin{theorem}\n\t$1\n\\end{theorem}\n$0\nendsnippet\n'
      + 'snippet sum "求和（仅数学）" iAm\n\\sum_{${1:n=1}}^{${2:\\infty}} $0\nendsnippet\n');
    reset();
    const doc = new Doc('abc\n');
    const ed = makeEditor(doc);
    mockVscode.window.activeTextEditor = ed;
    await fireChange(ed, 'thm  ', doc.offsetAt(new Position(1, 0)));
    const ins = executed.find((c) => c[0] === 'editor.action.insertSnippet');
    check('hsnips 文件里的 thm 也能展开', !!ins && ins[1].snippet.indexOf('\\begin{theorem}') === 0,
      ins ? JSON.stringify(ins[1].snippet.slice(0, 30)) : '未调用 insertSnippet');
    check('hsnips 触发词：删除区间覆盖整个上屏文字', !!editedRange
      && doc.offsetAt(editedRange.end) - doc.offsetAt(editedRange.start) === 5,
      editedRange ? String(doc.offsetAt(editedRange.end) - doc.offsetAt(editedRange.start)) : '未调用 edit');
  }

  // 场景 15：带 m 标志的片段（仅数学环境）——正文不展开、数学环境展开
  {
    reset();
    const doc = new Doc('abc\n');
    const ed = makeEditor(doc);
    mockVscode.window.activeTextEditor = ed;
    await fireChange(ed, 'sum  ', doc.offsetAt(new Position(1, 0)));
    check('数学限定：正文里不展开', editedRange === null && !executed.some((c) => c[0] === 'editor.action.insertSnippet'),
      `edit=${!!editedRange}`);

    reset();
    const doc2 = new Doc('\\[\n');
    const ed2 = makeEditor(doc2);
    mockVscode.window.activeTextEditor = ed2;
    await fireChange(ed2, 'sum  ', doc2.offsetAt(new Position(1, 0)));
    const ins = executed.find((c) => c[0] === 'editor.action.insertSnippet');
    check('数学限定：数学环境里展开', !!ins && ins[1].snippet.indexOf('\\sum') === 0,
      ins ? JSON.stringify(ins[1].snippet.slice(0, 20)) : '未调用 insertSnippet');
  }

  // 场景 16：输入法只替换了词的中间一段（"ec" → "sec  "），文档里成了 "ssec" —— 
  // 必须把整个词连同重复的前缀一起删掉，绝不能留下 "s\section{标题}"
  {
    fs.writeFileSync(TMP_HSNIPS,
      'snippet sec "section" w\n\\section{${1:标题}}\n$0\nendsnippet\n');
    reset();
    const doc = new Doc('sec');
    const ed = makeEditor(doc);
    mockVscode.window.activeTextEditor = ed;
    await fireChangeGeneric(ed, 'sec  ', 1, 2);            // 替换 [1,3) → 文档变成 "ssec  "
    check('重复前缀：删除了整个词（从词首删起）', !!editedRange
      && doc.offsetAt(editedRange.start) === 0 && doc.offsetAt(editedRange.end) === 6,
      editedRange ? `实得 ${doc.offsetAt(editedRange.start)}~${doc.offsetAt(editedRange.end)}` : '未调用 edit');
    check('重复前缀：插入的是 sec 片段', executed.some((c) => c[0] === 'editor.action.insertSnippet'
      && c[1].snippet.indexOf('\\section') === 0));
    check('重复前缀：文档里没有残留的 "s"', doc.getText().indexOf('ssec') < 0 && doc.getText().indexOf('s\\section') < 0,
      JSON.stringify(doc.getText().slice(0, 20)));
  }

  // 场景 17：词尾是触发词、但前缀不是触发词自己的开头（"msec"）→ 不动
  {
    reset();
    const doc = new Doc('msec');
    const ed = makeEditor(doc);
    mockVscode.window.activeTextEditor = ed;
    await fireChangeGeneric(ed, 'sec', 1, 3);
    check('msec 不展开（前缀不是触发词的开头）', editedRange === null
      && !executed.some((c) => c[0] === 'editor.action.insertSnippet'));
  }

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  ext.deactivate();
  process.exit(fail === 0 ? 0 : 1);
})();
