'use strict';

/*
 * 「边打边转」规则测试（数学环境内）。
 *   node test/autoconvert.test.js
 */

const { autoConvert } = require('../src/autoconvert');

let pass = 0;
let fail = 0;
function check(name, ok, extra) {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`); }
}

// 用 | 表示光标：如 "G1|" 表示刚打完 G1、光标在末尾
function run(marked, options) {
  const offset = marked.indexOf('|');
  const text = marked.slice(0, offset) + marked.slice(offset + 1);
  return autoConvert(text, offset, text.slice(-1), options || { math: true });
}
// 检查转换结果（把替换应用到文本上看最终形态）
function resultOf(marked, options) {
  const r = run(marked, options);
  if (!r) return null;
  const offset = marked.indexOf('|');
  const text = marked.slice(0, offset) + marked.slice(offset + 1);
  const out = text.slice(0, r.start) + r.text + text.slice(r.end);
  return { out, r, caret: r.select ? r.select[0] : null };
}
function checkOut(name, marked, want, options) {
  const res = resultOf(marked, options || { math: true });
  check(name, res && res.out === want, res ? `实得 ${JSON.stringify(res.out)}` : '未转换');
}

// ── 下标 ──
checkOut('G1 → G_1', 'G1|', 'G_1');
checkOut('abc1 → abc_1（保留前面的字母）', 'abc1|', 'abc_1');
checkOut('G_12 → G_{12}（两位下标）', 'G_12|', 'G_{12}');
check('x_9：手打下标后不再转换', run('x_9|') === null);
{
  const r = run('G_12|');                      // 手打的 G_1 后再按一个数字 → 变两位
  check('G_1 + 2 → 两位下标', r && r.rule === 'subscript2', JSON.stringify(r));
  const r2 = run('G_|');                       // 下划线后打数字，不该再加下划线
  check('G_ + 1 → 不再插入下划线', r2 === null, JSON.stringify(r2));
}

// ── 上标 ──
{
  const r = run('x^|');
  check('^ → ^{-1} 且选中 -1', r && r.text === '^{-1}' && r.select && r.select[1] - r.select[0] === 2, JSON.stringify(r));
  checkOut('^ 的替换范围正确', 'x^|', 'x^{-1}');
}

// ── 后缀 ──
checkOut('xbar → \\ov{x}', 'xbar|', '\\ov{x}');
checkOut('Ahat → \\hat{A}', 'Ahat|', '\\hat{A}');
checkOut('X,. → \\vec{X}', 'X,.|', '\\vec{X}');
checkOut('X., → \\vec{X}', 'X.,|', '\\vec{X}');

// ── 分数 ──
checkOut('1/ → \\frac{1}{}', '1/|', '\\frac{1}{}');
checkOut('xy/ → \\frac{xy}{}', 'xy/|', '\\frac{xy}{}');
checkOut('\\alpha^2/ → \\frac{\\alpha^2}{}', '\\alpha^2/|', '\\frac{\\alpha^2}{}');
{
  const r = run('1/|');
  check('分数：光标落在分母里（右花括号前）', r && r.select && r.select[0] === r.start + r.text.length - 1, JSON.stringify(r));
}

// ── 边界 ──
check('非数学环境不转换', run('G1|', { math: false }) === null);
check('纯数字不转换', run(' 1|', { math: true }) === null);
check('普通词尾不加下标（"abc" 后无数字）', run('abc|', { math: true }) === null);
check('两个字母后打数字只处理紧邻的一个', resultOf('AB7|').out === 'AB_7', resultOf('AB7|').out);

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
