'use strict';

/* 上下文分析器测试：node test/context.test.js */

const fs = require('fs');
const path = require('path');
const { analyzeContext } = require('../src/context');

const OPTS = {
  proseMode: 'chinese',
  commentMode: 'chinese',
  triggerMatchMode: 'prefix',
  triggerWords: ['dm', 'mk', 'thm', 'def', 'lmt', 'proof', 'enu', 'sec', 'beg'],
};

let pass = 0;
let fail = 0;

function check(name, text, at, expect, expectedReason, extra) {
  const idx = text.indexOf(at);
  if (idx < 0) {
    fail += 1;
    console.log(`  ✗ ${name}  (测试用例里找不到定位串: ${JSON.stringify(at)})`);
    return;
  }
  const offset = idx + at.length;
  const r = analyzeContext(text, offset, Object.assign({}, OPTS, extra));
  const ok = r.mode === expect && (!expectedReason || r.reason === expectedReason);
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}  -> ${r.mode} (${r.reason})`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}  期望 ${expect}${expectedReason ? '/' + expectedReason : ''}，实得 ${r.mode} (${r.reason})`);
  }
}

console.log('— 合成用例 —');

check('正文默认中文', '这是一个普通段落，正在写', '正在写', 'cn', 'prose');
check('行内数学 $', '正文 $x + y$ 正文', '正文 $x + ', 'en', 'math');
check('刚敲完 $', '正文 $', '正文 $', 'en', 'math');
check('行间数学 \\[', '\\[\n  x + y\n\\]\n', '\\[\n  x', 'en', 'math');
check('行间数学 \\\\[ 之后换行仍为数学', '\\[\n  x + y\n  z', 'x + y\n  z', 'en', 'math');
check('\\text{} 内部为中文', '\\[ \\text{中文内容} \\]', '\\text{中文', 'cn', 'text-arg');
check('\\text{} 里的嵌套 $ 回到英文', '\\[ \\text{当 $x$ 时} \\]', '\\text{当 $x', 'en', 'math');
check('注释为中文', '文字 % 这是注释', '% 这是注', 'cn', 'comment');
check('注释内数学符号不干扰', '文字 % $x$ 注释', '% $x$ 注', 'cn', 'comment');
check('转义百分号不进入注释', '50\\% 的值', '50\\%', 'cn', 'prose');
check('theorem 环境为中文', '\\begin{theorem}\n  内容', '\\begin{theorem}\n  内', 'cn', 'prose');
check('align 环境为英文', '\\begin{align}\n  x &= y', '\\begin{align}\n  x', 'en', 'math');
check('cases 环境为英文', '\\[\\begin{cases}\n a', '\\begin{cases}\n a', 'en', 'math');
check('tikzcd 环境为英文', '\\begin{tikzcd}\n A \\arrow[r]', '\\begin{tikzcd}\n A', 'en', 'math');
check('正文里的 dm 触发英文', '正文 dm', '正文 dm', 'en', 'trigger');
check('正文里的 dm 前缀 d 触发英文', '正文 d', '正文 d', 'en', 'trigger');
check('exact 模式：完整 dm 才触发', '正文 dm', '正文 dm', 'en', 'trigger', { triggerMatchMode: 'exact' });
check('exact 模式：前缀 d 不触发', '正文 d', '正文 d', 'cn', 'prose', { triggerMatchMode: 'exact' });
check('exact 模式：英文单词 sec 仍触发（词表内）', '正文 sec', '正文 sec', 'en', 'trigger', { triggerMatchMode: 'exact' });
check('off 模式：dm 不触发', '正文 dm', '正文 dm', 'cn', 'prose', { triggerMatchMode: 'off' });
check('普通 ASCII 词不触发器', '正文 x', '正文 x', 'cn', 'prose');
check('正在输入命令名', '正文 \\sect', '\\sect', 'en', 'cmd-name');
check('刚敲下反斜杠', '正文 \\', '正文 \\', 'en', 'cmd-name');
check('正在输入环境名', '\\begin{al', '\\begin{al', 'en', 'cmd-name');
check('\\label{} 为英文', '\\label{eq:1', '\\label{eq:1', 'en', 'cmd-arg');
check('\\ref{} 为英文', '见 \\ref{thm:1', '\\ref{thm:1', 'en', 'cmd-arg');
check('\\cite{} 为英文', '\\cite{knuth', '\\cite{knuth', 'en', 'cmd-arg');
check('\\includegraphics{} 为英文', '\\includegraphics{fig/a', '\\includegraphics{fig/a', 'en', 'cmd-arg');
check('\\textcolor 第一参数英文', '\\textcolor{re', '\\textcolor{re', 'en', 'cmd-arg');
check('\\textcolor 第二参数中文', '\\textcolor{red}{内容', '\\textcolor{red}{内', 'cn', 'text-arg');
check('\\href 第一参数英文', '\\href{https://a', '\\href{https://a', 'en', 'cmd-arg');
check('\\href 第二参数中文', '\\href{https://a}{说明', '\\href{https://a}{说', 'cn', 'prose');
check('\\caption{} 中文', '\\caption{图注', '\\caption{图', 'cn', 'text-arg');
check('\\section{} 中文', '\\section{标题', '\\section{标', 'cn', 'text-arg');
check('\\section*{} 中文', '\\section*{标题', '\\section*{标', 'cn', 'text-arg');
check('导言区命令参数英文', '\\usepackage{amsmath', '\\usepackage{amsmath', 'en', 'cmd-arg');
check('导言区 \\title{} 中文', '\\title{抽象代数', '\\title{抽象', 'cn', 'text-arg');
check('verbatim 环境英文', '\\begin{verbatim}\n  code', '\\begin{verbatim}\n  co', 'en', 'verbatim');
check('minted 环境英文', '\\begin{minted}{python}\n  x=1', '\\begin{minted}{python}\n  x', 'en', 'verbatim');
check('\\verb 内英文', '\\verb|abc', '\\verb|ab', 'en', 'verbatim');
check('结束后回到正文', '\\[ x \\] 正文', '\\[ x \\] 正', 'cn', 'prose');
check('右端符后回正文', '\\[ x \\]\n正文', '\\[ x \\]\n正', 'cn', 'prose');
check('$...$ 结束后回正文', '$x+y$ 正文', '$x+y$ 正', 'cn', 'prose');
check('enumerate 内为中文', '\\begin{enumerate}\n \\item 第一', '\\item 第', 'cn', 'prose');
check('\\textbf 内为中文', '\\textbf{定义', '\\textbf{定', 'cn', 'text-arg');
check('数学里 \\operatorname 为英文', '\\[ \\operatorname{Ker}(f) \\]', '\\operatorname{Ker', 'en');
check('aligned 结束仍在数学中', '\\[\\begin{aligned}\n a &= b\n\\end{aligned}\n c', '\\end{aligned}\n c', 'en', 'math');
check('align 结束后回正文', '\\begin{align}\n a &= b\n\\end{align}\n正文', '\\end{align}\n正', 'cn', 'prose');
check('\\text{} 结束后回到数学', '\\[ \\text{中文} + x', '\\text{中文} + x', 'en', 'math');
check('环境环套（定理里数学）', '\\begin{definition}\n  \\[ H', '\\begin{definition}\n  \\[ H', 'en', 'math');
check('注释后的新行回正文', '% 注释\n正文', '% 注释\n正', 'cn', 'prose');
check('$$ 内的 \\text{} 中文', '$$ \\text{说明} $$', '$$ \\text{说', 'cn', 'text-arg');
check('可选参数里的中文', '\\begin{definition}[\\textbf{标题}]', '\\textbf{标', 'cn', 'text-arg');
check('optional 参数后正文仍中文', '\\section[短]{长标题', '\\section[短]{长标', 'cn', 'text-arg');
check('display math $$', '$$x+y', '$$x', 'en', 'math');
check('display math $$ 内换行', '$$\nx+y', '$$\nx', 'en', 'math');

console.log('\n— 英文笔记模式（notesLanguage=english，应全英）—');
const EN = { notesLanguage: 'english' };
check('英文笔记：正文', '这是一段正文', '这是一段正', 'en', 'prose|全英', EN);
check('英文笔记：注释', '文字 % 注释', '% 注', 'en', 'comment|全英', EN);
check('英文笔记：\\text{}', '\\[ \\text{内容} \\]', '\\text{内', 'en', 'text-arg|全英', EN);
check('英文笔记：\\section{}', '\\section{标题', '\\section{标', 'en', 'text-arg|全英', EN);
check('英文笔记：数学不变', '\\[ x', '\\[ x', 'en', 'math', EN);
check('英文笔记：命令名', '正文 \\sect', '\\sect', 'en', 'cmd-name', EN);
check('英文笔记：标签参数', '\\label{eq:1', '\\label{eq:1', 'en', 'cmd-arg', EN);

console.log('\n— 真实文件 lecture-1.tex —');
const texPath = '/home/Claude/数学笔记/抽象代数/lecture/lecture-1.tex';
if (fs.existsSync(texPath)) {
  const tex = fs.readFileSync(texPath, 'utf8');
  check('tex: 行间公式内部', tex, 'G = \\bigsqcup_{[g]', 'en', 'math');
  check('tex: \\text{} 内中文', tex, 'f \\text{为单', 'cn', 'text-arg');
  check('tex: 定理环境正文', tex, '\\begin{definition}[\\textbf{正规子群}]', 'cn');
  check('tex: 注释内中文', tex, '% not availabl', 'cn', 'comment');
  check('tex: \\operatorname 内', tex, '\\operatorname{Ker}(f)=\\{g', 'en', 'math');
  check('tex: 定义环境标题内', tex, '\\textbf{正规子', 'cn', 'text-arg');
  check('tex: 文档标题行', tex, '\\title{抽象代数', 'cn', 'text-arg');
  check('tex: 结束公式后正文', tex, '其中 $[g]$ 表示', 'cn', 'prose');
  check('tex: 证明环境内数学', tex, 'G = H \\sqcup gH', 'en', 'math');
  check('tex: \\ov 数学内', tex, '\\ov{a}\\ov{b}\\ov{a^{-1}}', 'en', 'math');
  check('tex: 定理正文中文', tex, '若 $g_0 \\in H$ 则', 'cn');
} else {
  console.log('  （未找到 lecture-1.tex，跳过）');
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
