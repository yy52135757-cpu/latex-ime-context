'use strict';

/*
 * 智能 Tab 跳出（smart tab）的单元测试。
 * 用例里用 | 表示光标位置。
 *   node test/smarttab.test.js
 */

const { findJumpTarget, wordBlocksJump } = require('../src/smarttab');

let pass = 0;
let fail = 0;

function check(name, ok, extra) {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`); }
}

function jumpOf(marked, options) {
  const offset = marked.indexOf('|');
  const text = marked.slice(0, offset) + marked.slice(offset + 1);
  const r = findJumpTarget(text, offset, options);
  return r ? r.offset : null;
}

function checkJump(name, from, to, options) {
  const fromText = from.slice(0, from.indexOf('|')) + from.slice(from.indexOf('|') + 1);
  const wantOffset = to.indexOf('|');
  const toText = to.slice(0, wantOffset) + to.slice(wantOffset + 1);
  if (fromText !== toText) { check(name, false, '（用例写错了：两段文本不一致）'); return; }
  const got = jumpOf(from, options);
  check(name, got === wantOffset, got === null ? '未找到结构' : `实得 ${got}，期望 ${wantOffset}`);
}

function checkNull(name, marked, options) {
  const got = jumpOf(marked, options);
  check(name, got === null, got === null ? '' : `实得 ${got}，期望不跳`);
}

// ---------- 基本括号 ----------
checkJump('大括号 {a|b} → } 之后', '{a|b}', '{ab}|');
checkJump('方括号 [a|b] → ] 之后', '[a|b]', '[ab]|');
checkJump('圆括号 (a|b) → ) 之后', '(a|b)', '(ab)|');
checkJump('转义大括号 \\{a|b\\} → \\} 之后', '\\{a|b\\}', '\\{ab\\}|');
checkJump('显示公式 \\[a|b\\] → \\] 之后', '\\[a|b\\]', '\\[ab\\]|');
checkJump('行内公式 \\(a|b\\) → \\) 之后', '\\(a|b\\)', '\\(ab\\)|');
checkJump('空括号 {} 里也能跳出', '{|}', '{}|');
checkJump('光标紧贴闭符号也能跳出', '{a|}', '{a}|');
checkNull('圆括号可通过设置关闭', '(a|b)', { parentheses: false });

// ---------- 嵌套：逐层跳出（{{0}1}2 那个例子）----------
checkJump('嵌套 1：内层 → 内层 } 之后', '{{0|}1}2', '{{0}|1}2');
checkJump('嵌套 2：再按一次 → 外层 } 之后', '{{0}|1}2', '{{0}1}|2');
checkJump('三层嵌套：最内层先出', '{{{a|}}}', '{{{a}|}}');
checkJump('三层嵌套：第二层', '{{{a}|}}', '{{{a}}|}');
checkJump('括号混搭：{ [ (a|) ] }', '{[(a|)]}', '{[(a)|]}');

// ---------- 环境 ----------
checkJump('环境：跳到 \\end{…} 之后', '\\begin{thm}\n|\n\\end{thm}', '\\begin{thm}\n\n\\end{thm}|');
// 环境后面就是换行时，落点直接到下一行开头
checkJump('环境：后面有换行 → 落到下一行开头', '\\begin{thm}\n|\n\\end{thm}\n下一段', '\\begin{thm}\n\n\\end{thm}\n|下一段');
checkJump('环境：\\end 后面还有内容 → 就停在 \\end 之后', '\\begin{thm}\n|\n\\end{thm} 后续', '\\begin{thm}\n\n\\end{thm}| 后续');
checkJump('环境：可用设置关掉「落到下一行」', '\\begin{thm}\n|\n\\end{thm}\n下一段', '\\begin{thm}\n\n\\end{thm}|\n下一段', { newlineAfterEnv: false });
checkJump('环境 + 内层括号：先出括号', '\\begin{e}{a|b}\\end{e}', '\\begin{e}{ab}|\\end{e}');
checkJump('环境 + 内层括号：再出环境', '\\begin{e}{ab}|\\end{e}', '\\begin{e}{ab}\\end{e}|');
checkJump('环境可选参数的 [ ] 也能跳', '\\begin{theorem}[标|题]', '\\begin{theorem}[标题]|');
checkJump('不同环境名互不干扰', '\\begin{a}\\begin{b}|\n\\end{b}\n\\end{a}', '\\begin{a}\\begin{b}\n\\end{b}\n|\\end{a}');
checkNull('只有 \\end 没有 \\begin', '\\end{a}|', undefined);

// ---------- document 环境默认被排除 ----------
checkNull('document 不作可跳出环境（否则会跳到文件末尾）', '\\begin{document}\n|\n\\end{document}');
checkJump('document 里的定理照常跳出', '\\begin{document}\n\\begin{thm}\n|\n\\end{thm}\n\\end{document}', '\\begin{document}\n\\begin{thm}\n\n\\end{thm}\n|\\end{document}');
checkJump('skipEnvs 为空时 document 也算', '\\begin{document}\n|\n\\end{document}', '\\begin{document}\n\n\\end{document}|', { skipEnvs: [] });

// ---------- 不该跳的情况 ----------
checkNull('光标在闭符号之后（不在结构里）', '{ab}|');
checkNull('括号没闭合', '{a|');
checkNull('注释里的括号不参与', '% {a|}');
checkJump('注释行后面的括号照常参与', '% 注释\n{a|}', '% 注释\n{a}|');
checkNull('原样环境里的括号不参与', '\\begin{verbatim}\n{a|}\n\\end{verbatim}');
checkNull('数学模式 $$ 不算结构', '$$a|b$$');
checkNull('行内 $ 不算结构', '$a|b$');

// ---------- 转义与边界 ----------
checkJump('换行命令 \\\\ 后面的括号照常处理', '\\\\{|}', '\\\\{}|');
checkJump('转义百分号 \\% 不会开启注释', '\\% 说明 {a|}', '\\% 说明 {a}|');
checkJump('命令名里的括号参数', '\\frac{a|}{b}', '\\frac{a}|{b}');

// ---------- 补全优先：触发词及其前缀不吃 Tab ----------
{
  const T = ['function', 'thm', 'sec', 'dm', 'mk', 'sum'];
  check('fun（function 的前缀）→ Tab 让给补全', wordBlocksJump('fun', T) === true);
  check('thm（完整触发词）→ Tab 让给补全', wordBlocksJump('thm', T) === true);
  check('FU（大小写不敏感）→ 让给补全', wordBlocksJump('FU', T) === true);
  check('msec（只是以 sec 结尾）→ 不影响跳出', wordBlocksJump('msec', T) === false);
  check('单字母 f → 不拦（仍可跳出）', wordBlocksJump('f', T) === false);
  check('foo → 不拦', wordBlocksJump('foo', T) === false);
}

// ---------- 块状结构：跳出后的换行 ----------
{
  const r1 = findJumpTarget('\\[a\nb\n\\]', 4);
  check('多行 \\[…\\] 跳出：行尾无换行 → 需要补一行', r1 && r1.block === true && r1.wantsNewline === true, JSON.stringify(r1));
  const r2 = findJumpTarget('\\[a\nb\n\\]后续', 4);
  check('多行 \\[…\\] 后面有内容 → 不补行', r2 && r2.wantsNewline === false, JSON.stringify(r2));
  const r3 = findJumpTarget('\\[a\nb\n\\]\n下一段', 4);
  check('落点在已有内容的行首 → 新建一行', r3 && r3.offset === 9 && r3.insert === '\n', JSON.stringify(r3));
  const r4 = findJumpTarget('{a\nb}', 2);
  check('跨行大括号 → 也算块状结构', r4 && r4.block === true && r4.wantsNewline === true, JSON.stringify(r4));
  const r5 = findJumpTarget('{ab}', 2);
  check('单行大括号 → 不做换行处理', r5 && r5.block === false && r5.wantsNewline === false, JSON.stringify(r5));
}

// ---------- 光标紧跟块状结构闭合符之后，也算可跳出 ----------
{
  const t1 = '\\begin{a}\n\\end{a}';
  const r1 = findJumpTarget(t1, t1.length);
  check('紧跟 \\end{a} 之后（文件尾）→ 可跳出且补一行', r1 && r1.afterCloser === true && r1.wantsNewline === true, JSON.stringify(r1));
  const t2 = '\\begin{a}\n\\end{a}  \n下一段';
  const r2 = findJumpTarget(t2, '\\begin{a}\n\\end{a}'.length);
  check('紧跟 \\end{a} 之后（后面是换行）→ 落到下一行', r2 && r2.afterCloser === true && r2.offset === t2.indexOf('下一段'), JSON.stringify(r2));
  const t3 = '\\begin{a}\n\\end{a}后续';
  const r3 = findJumpTarget(t3, '\\begin{a}\n\\end{a}'.length);
  check('紧跟 \\end{a} 但后面有内容 → 不动', r3 === null, JSON.stringify(r3));
  const r4 = findJumpTarget('{}', 2);
  check('紧跟单行 {} 之后 → 不算（行内结构）', r4 === null, JSON.stringify(r4));
}

// ---------- 落点在已有内容的行首 → 新建一行 ----------
{
  const t1 = '\\[\n  f\n.\\]\n  \\[\n  g\n.\\]';
  const r1 = findJumpTarget(t1, 4);          // 光标在 f 之后
  const lineStartOfNext = t1.indexOf('  \\[', 3);
  check('下一行已有内容（预写好的 \\[）→ 落点在该行行首', r1 && r1.offset === lineStartOfNext, JSON.stringify(r1));
  check('下一行已有内容 → 插入「缩进+换行」，光标落在缩进后', r1 && r1.insert === '  \n' && r1.caret === lineStartOfNext + 2, JSON.stringify(r1));
  const t2 = '  \[\na\n  \]';
  const r2b = findJumpTarget(t2, 4);
  check('文件尾收尾：补「换行+缩进」（缩进照闭合符那行）', r2b && r2b.insert === '\n  ' && r2b.caret === t2.length + 3, JSON.stringify(r2b));

  const t3 = '\[\na\n\]\n\n  x';
  const r2 = findJumpTarget(t3, 3);
  check('下一行是空行 → 不插入，直接落过去', r2 && r2.insert === null && r2.offset === t3.indexOf('\n\n') + 1, JSON.stringify(r2));
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
