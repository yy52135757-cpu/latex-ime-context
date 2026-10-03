#!/usr/bin/env node
'use strict';

/*
 * 给 OrangeX4 的 hsnips 打「严格补全」补丁：
 *
 *   补全弹窗只提供「完整触发词」的候选，不再做前缀/后缀/模糊匹配：
 *     打 de   → 无候选
 *     打 def  → 只有 def（不再挂着 deft）
 *     打 det  → 无候选（不会出现 deft / td / function 之类的乱序、跳字匹配）
 *
 * 只影响「补全弹窗」这条路（provider 调用）；
 * 自动展开（A 标志、正则片段）、Tab 展开、占位符跳转全部不变。
 *
 * 用法：
 *   node tools/patch-hsnips-strict.js [hsnips扩展目录]
 *   不带参数时自动在 ~/.vscode-server/extensions/ 里找最新的 orangex4.hsnips-*
 *
 * 注意：hsnips 更新（重装）后需要重新运行本脚本；
 *       原文件会就地备份为 *.orig（仅首次）。
 */

const fs = require('fs');
const path = require('path');

const MARK = '[latex-ime-context strict]';

function findHsnipsDir() {
  const base = path.join(process.env.HOME || '', '.vscode-server', 'extensions');
  const cands = fs.readdirSync(base)
    .filter((d) => /^orangex4\.hsnips-/.test(d))
    .map((d) => path.join(base, d))
    .sort();
  if (!cands.length) {
    console.error('找不到 hsnips 扩展目录，请手动传入路径。');
    process.exit(1);
  }
  return cands[cands.length - 1];
}

const dir = process.argv[2] || findHsnipsDir();
const compFile = path.join(dir, 'out', 'completion.js');
const extFile = path.join(dir, 'out', 'extension.js');

function readJs(f) {
  const raw = fs.readFileSync(f, 'utf8');
  return { raw, text: raw.replace(/\r\n/g, '\n'), crlf: raw.includes('\r\n') };
}
function writeJs(f, o, patched) {
  fs.writeFileSync(f, o.crlf ? patched.replace(/\n/g, '\r\n') : patched);
}

const oComp = readJs(compFile);
const oExt = readJs(extFile);
let comp = oComp.text;
let ext = oExt.text;

const doneComp = comp.includes(MARK);
const doneExt = ext.includes('getCompletions(document, position, snippets, true)');
if (doneComp && doneExt) {
  console.log('已是严格模式，无需补丁：', dir);
  process.exit(0);
}

// 备份（仅首次；重跑不会用打过补丁的内容覆盖 .orig）
if (!fs.existsSync(compFile + '.orig')) fs.writeFileSync(compFile + '.orig', oComp.raw);
if (!fs.existsSync(extFile + '.orig')) fs.writeFileSync(extFile + '.orig', oExt.raw);

if (!doneComp) {
  // 1) getCompletions 增加 strict 参数
  const sigOld = 'function getCompletions(document, position, snippets) {';
  const sigNew = 'function getCompletions(document, position, snippets, strict) {';
  if (comp.split(sigOld).length !== 2) {
    console.error('completion.js 结构不符（hsnips 版本变了？），中止。');
    process.exit(1);
  }
  comp = comp.replace(sigOld, sigNew);

  // 2) 在每个候选判定完 matchingPrefix 之后、使用它之前，加上严格过滤
  const anchor = `            if (matchingPrefix) {
                snippetRange = new vscode.Range(position.translate(0, -matchingPrefix.length), position);`;
  if (comp.split(anchor).length !== 2) {
    console.error('completion.js 锚点未找到（hsnips 版本变了？），中止。');
    process.exit(1);
  }
  const inject = `            // ${MARK} 补全只保留「完整触发词」候选（打 def 不会再提示 deft 等）
            if (strict && snippet.trigger) {
                const typedWord = snippet.inword || snippet.wordboundary ? wordContext : context;
                if (typedWord !== snippet.trigger) {
                    matchingPrefix = null;
                }
            }
` + anchor;
  comp = comp.replace(anchor, inject);
  writeJs(compFile, oComp, comp);
  console.log('已补 completion.js');
}

if (!doneExt) {
  // 3) 只给「补全弹窗」的调用传 true；自动展开那条调用（e.document, ...）保持不变
  const callOld = 'completion_1.getCompletions(document, position, snippets)';
  const callNew = 'completion_1.getCompletions(document, position, snippets, true)';
  if (ext.split(callOld).length !== 2) {
    console.error('extension.js 调用点未找到（hsnips 版本变了？），中止。');
    process.exit(1);
  }
  ext = ext.replace(callOld, callNew);
  writeJs(extFile, oExt, ext);
  console.log('已补 extension.js');
}

console.log('补丁完成：', dir);
console.log('请在 VS Code 里 Reload Window 生效；hsnips 更新后重新运行本脚本。');
