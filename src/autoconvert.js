'use strict';

/*
 * 「边打边转」规则。
 *
 * 这些原本由 hsnips 的正则片段完成，但 hsnips 插入时会**新开一个片段会话**，
 * 把外层片段的占位符会话顶掉 —— 表现就是「在 function 模板里打 G1 变成 G_1 后，
 * Tab 再也去不了原来的位置」。
 *
 * 这里改成**纯文本编辑**：只插入/替换文字、不碰片段会话，外层占位符照常导航。
 * 所有规则都只在数学环境里生效（由调用方保证）。
 *
 * 返回的 { start, end, text } 表示把 [start, end) 换成 text；
 * 若带 select（后编辑坐标），则替换后再把选区设成它（用来"选中 -1 供直接替换"或摆光标）。
 */

// 自动分数：分子可以是数字、字母、带 ^ _ 的表达式（照搬 hsnips 原正则）
const FRACTION_RE = /((\d+)|(\d*)(\\)?([A-Za-z]+)((\^|_)(\{\d+\}|\d))*)\/$/;
const SUFFIX_RE = {
  bar: /([A-Za-z])bar$/,
  hat: /([A-Za-z])hat$/,
};
const VEC_RE = /([A-Za-z])(,\.|\.\,)$/;

/**
 * @param {string} text 文档全文
 * @param {number} offset 光标位置（= 刚输入内容之后的绝对偏移）
 * @param {string} typed 刚输入的内容（可能是带尾随空格的输入法提交）
 * @param {{math?: boolean}} options
 * @returns {{start:number, end:number, text:string, select?:[number,number], rule:string}|null}
 */
function autoConvert(text, offset, typed, options) {
  const opts = options || {};
  if (opts.math !== true) return null;
  const raw = String(typed || '');
  const t = raw.trim();
  if (!t) return null;
  if (offset < 2 || offset > text.length) return null;
  if (text.slice(offset - raw.length, offset) !== raw) return null;

  const before = text.slice(0, offset);

  // ── 下标 ───────────────────────────────────────────────
  if (/^\d$/.test(t)) {
    const c1 = text[offset - 2];                       // 数字前一个字符
    const c2 = text[offset - 3];                       // 再往前一个
    // X_1 + 2 → X_{12}（两位下标）
    if (/[0-9]/.test(c1 || '') && c2 === '_' && /[A-Za-z]/.test(text[offset - 4] || '')) {
      return { start: offset - 3, end: offset, text: `_{${c1}${t}}`, rule: 'subscript2' };
    }
    // G + 1 → G_1
    if (/[A-Za-z]/.test(c1 || '') && c2 !== '_') {
      return { start: offset - 1, end: offset - 1, text: '_', rule: 'subscript1' };
    }
    return null;
  }

  // ── 上标：^ → ^{-1}（-1 选中，直接打数字即替换）────────────
  if (t === '^') {
    return { start: offset - 1, end: offset, text: '^{-1}', select: [offset + 1, offset + 3], rule: 'superscript' };
  }

  // ── 后缀：xbar → \ov{x}，xhat → \hat{x} ─────────────────
  for (const suf of ['bar', 'hat']) {
    const m = SUFFIX_RE[suf].exec(before);
    if (m) {
      return {
        start: offset - (suf.length + 1), end: offset,
        text: `\\${suf === 'bar' ? 'ov' : 'hat'}{${m[1]}}`, rule: 'suffix-' + suf,
      };
    }
  }

  // ── 向量：x,. / x., → \vec{x} ───────────────────────────
  {
    const m = VEC_RE.exec(before);
    if (m) {
      return { start: offset - 3, end: offset, text: `\\vec{${m[1]}}`, rule: 'vec' };
    }
  }

  // ── 自动分数：1/ → \frac{1}{}（光标落在分母里）────────────
  if (t === '/') {
    const m = FRACTION_RE.exec(before);
    if (m && m[1]) {
      const start = offset - m[0].length;
      const body = `\\frac{${m[1]}}{}`;
      return { start, end: offset, text: body, select: [start + body.length - 1, start + body.length - 1], rule: 'fraction' };
    }
  }

  return null;
}

module.exports = { autoConvert };
