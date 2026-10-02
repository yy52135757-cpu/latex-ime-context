'use strict';

const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');

function isWsl() {
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft|wsl/i.test(os.release());
  } catch (e) {
    return false;
  }
}

/** 常见 LANGID 名称 */
const LANG_NAMES = {
  0x0409: '英语(美国)', 0x0809: '英语(英国)', 0x1809: '英语(爱尔兰)',
  0x0c09: '英语(澳大利亚)', 0x1009: '英语(加拿大)', 0x2009: '英语(新西兰)',
  0x0804: '中文(简体,中国)', 0x0404: '中文(繁体,台湾)', 0x0c04: '中文(繁体,香港)',
  0x0c0a: '西班牙语', 0x0411: '日语', 0x0412: '韩语', 0x040c: '法语', 0x0407: '德语',
};

/** 把设置里的编码写法（十进制 / 0x 前缀 / 8 位 KLID 十六进制）统一成整数 */
function parseCode(v) {
  const s = String(v === null || v === undefined ? '' : v).trim();
  if (!s) return NaN;
  if (/^0x[0-9a-f]+$/i.test(s)) return parseInt(s, 16);
  if (/^0[0-9a-f]{7}$/i.test(s)) return parseInt(s, 16);
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * 枚举 Windows 上「已加载」的输入法（含布局名与 LANGID）。
 * 回调参数：[{ langTag, hkl, code, layoutName, label }]，code 为 im-select 可用的十进制 LANGID。
 */
function listWindowsLayouts(cb) {
  const ps = "Add-Type -AssemblyName System.Windows.Forms; [Console]::OutputEncoding=[Text.Encoding]::UTF8; "
    + "[System.Windows.Forms.InputLanguage]::InstalledInputLanguages | ForEach-Object "
    + "{ $_.Culture.Name + '|' + $_.Handle.ToInt64() + '|' + $_.LayoutName }";
  execFile('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true, timeout: 20000 }, (err, out) => {
    if (err) { cb(err); return; }
    const items = [];
    String(out).split(/\r?\n/).forEach((line) => {
      const m = /^([^|]*)\|(\d+)\|(.*)$/.exec(line.trim());
      if (!m) return;
      const hkl = Number(m[2]);
      const code = hkl & 0xffff;
      const langTag = m[1].trim();
      const layoutName = (m[3] || '').trim();
      const langName = LANG_NAMES[code] || '';
      const label = `${langTag} · ${layoutName} · ${langName ? langName + ' · ' : ''}编码 ${code}`;
      items.push({ langTag, hkl, code, layoutName, label, isChinese: /^zh/i.test(langTag) });
    });
    cb(null, items);
  });
}

/** WSL/Linux 路径 -> Windows 可访问路径（供 PowerShell 兜底使用） */
function toWindowsPath(p) {
  if (/^[A-Za-z]:[\\/]/.test(p)) return p;
  if (p.startsWith('/mnt/')) {
    return p.replace(/^\/mnt\/([a-z])\//i, (m, d) => d.toUpperCase() + ':/').replace(/\//g, '\\');
  }
  if (isWsl()) {
    const distro = process.env.WSL_DISTRO_NAME || 'Ubuntu';
    return '\\\\wsl.localhost\\' + distro + p.replace(/\//g, '\\');
  }
  return null;
}

function ensureExecutable(exePath) {
  try {
    fs.accessSync(exePath, fs.constants.X_OK);
    return true;
  } catch (e) {
    try {
      fs.chmodSync(exePath, 0o755);
      return true;
    } catch (e2) {
      return false;
    }
  }
}

/**
 * 运行 im-select。
 * @param {string} exePath
 * @param {string|null} code 传 null 表示读取当前输入法编码
 * @param {(msg:string)=>void} logDebug
 * @param {(err:Error|null, stdout?:string)=>void} cb
 */
function runImSelect(exePath, code, logDebug, cb) {
  if (!exePath) { cb(new Error('im-select 路径为空')); return; }
  ensureExecutable(exePath);

  const args = code === null || code === undefined ? [] : [String(code)];
  const T_FAST = 2500;    // 直连：正常 60ms；首次冷启动可能 >40s，所以给短超时尽快回退
  const T_SLOW = 20000;   // 兜底路径（PowerShell / 最后的直连）给足时间

  // 1) 直接执行（最多 2 次，间隔 300ms）——冷启动慢就尽快转兜底
  const direct = (n) => {
    execFile(exePath, args, { windowsHide: true, timeout: T_FAST }, (err, stdout) => {
      if (!err) { cb(null, String(stdout).trim()); return; }
      if (n < 1) { setTimeout(() => direct(n + 1), 300); return; }
      logDebug(`直接调用失败（已重试 ${n + 1} 次）: ${err.message}`);
      viaPowerShell(err);
    });
  };

  // 2) PowerShell 兜底（\\wsl.localhost 与 \\wsl$ 两种写法）
  const viaPowerShell = (lastErr) => {
    const winPath = toWindowsPath(exePath);
    if (!winPath) { cb(lastErr); return; }
    const psCmd = `& '${winPath}' ${args.join(' ')}`.trim();
    logDebug(`PowerShell 兜底: ${psCmd}`);
    execFile('powershell.exe', ['-NoProfile', '-Command', psCmd], { windowsHide: true, timeout: T_SLOW }, (err2, out2) => {
      if (!err2) { cb(null, String(out2).trim()); return; }
      const alt = winPath.replace(/^\\wsl\.localhost\\/i, '\\wsl$\\');
      if (alt !== winPath) {
        execFile('powershell.exe', ['-NoProfile', '-Command', `& '${alt}' ${args.join(' ')}`.trim()],
          { windowsHide: true, timeout: T_SLOW },
          (err3, out3) => { if (!err3) { cb(null, String(out3).trim()); return; } lastResort(err2); });
        return;
      }
      lastResort(err2);
    });
  };

  // 3) 最后再直连一次（此时互操作通常已经热起来）
  const lastResort = (lastErr) => {
    setTimeout(() => {
      execFile(exePath, args, { windowsHide: true, timeout: T_SLOW }, (err3, out3) => {
        if (!err3) { cb(null, String(out3).trim()); return; }
        cb(lastErr || err3);
      });
    }, 600);
  };

  direct(0);
}

/**
 * 在同一种中文输入法内部切换中/英子模式（例如微软拼音按 Shift）。
 * 通过 Windows PowerShell（keybd_event）发送按键，不改变键盘布局，
 * 因此不会打断 Chromium/VS Code 的输入法状态（候选框不会失灵）。
 * @param {string} shortcut 'shift' | 'ctrl+space' | 'shift+space'
 */
// 运行统计（诊断用）
const psStat = {
  sent: 0,        // 经常驻进程发出
  oneShot: 0,     // 一次性执行
  queued: 0,      // 排队等待预加载
  rescued: 0,     // 排队超时后改一次性执行
  restarts: 0,    // 常驻进程重启次数
  lastError: '',
};

function getSameImeStats() {
  return Object.assign({}, psStat, { shellAlive: !!psShell, shellReady: psReady, pending: psQueue.length });
}

function sendSameImeToggle(shortcut, logDebug, cb) {
  const cmd = toggleCommand(shortcut);
  const proc = ensurePsShell(logDebug);

  if (proc && psReady) {
    try {
      proc.stdin.write(cmd + '\n');
      psStat.sent += 1;
      cb && cb(null);
      return;
    } catch (e) {
      psStat.lastError = 'write: ' + e.message;
      logDebug('常驻 PowerShell 写入失败: ' + e.message);
      disposeSameImeShell();
    }
  } else if (proc) {
    // 预加载尚未完成：排队，并设超时兜底——绝不静默丢失（丢了会让中英状态整体反向）
    psQueue.push(cmd);
    psStat.queued += 1;
    if (!psQueueTimer) {
      psQueueTimer = setTimeout(() => {
        psQueueTimer = null;
        const pending = psQueue;
        psQueue = [];
        if (!pending.length) return;
        psStat.rescued += pending.length;
        psStat.lastError = '常驻进程未就绪，已改用一次性执行';
        logDebug(`常驻 PowerShell 未就绪，${pending.length} 条切换改用一次性执行`);
        disposeSameImeShell();
        pending.forEach((line) => oneShotToggle(line, logDebug, () => {}));
      }, 1500);
    }
    cb && cb(null);
    return;
  }

  psStat.oneShot += 1;
  oneShotToggle(cmd, logDebug, (err) => {
    if (err) psStat.lastError = 'oneShot: ' + err.message;
    cb && cb(err || null);
  });
}

function oneShotToggle(cmd, logDebug, cb) {
  const encoded = Buffer.from(PS_PRELUDE + ';' + cmd, 'utf16le').toString('base64');
  execFile('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { windowsHide: true, timeout: 25000, maxBuffer: 32 * 1024 * 1024 },
    (err) => {
      if (err) logDebug('发送切换键失败: ' + err.message);
      cb && cb(err || null);
    });
}

// —— 常驻 PowerShell：预热后每次切换只需毫秒级 ——
let psShell = null;
let psReady = false;
let psQueue = [];
let psQueueTimer = null;

function ensurePsShell(logDebug) {
  if (psShell) return psShell;
  const loop = PS_PRELUDE + "; Write-Output 'READY';"
    + ' while($true){ $l=[Console]::ReadLine(); if($l -eq $null){break};'
    + ' if($l.Trim().Length -gt 0){ try{ Invoke-Expression $l }catch{} } }';
  const encoded = Buffer.from(loop, 'utf16le').toString('base64');
  psReady = false;
  const proc = execFile('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
    (err) => {
      if (psShell === proc) { psShell = null; psReady = false; psStat.restarts += 1; }
      if (err) logDebug('常驻 PowerShell 退出: ' + err.message);
    });
  proc.stdout.on('data', (d) => {
    if (!psReady && String(d).indexOf('READY') >= 0) {
      psReady = true;
      const q = psQueue;
      psQueue = [];
      q.forEach((line) => { try { proc.stdin.write(line + '\n'); } catch (e) { /* ignore */ } });
    }
  });
  proc.stderr.on('data', () => {});
  proc.stdin.on('error', () => {});
  psShell = proc;
  return proc;
}

function disposeSameImeShell() {
  if (psQueueTimer) { clearTimeout(psQueueTimer); psQueueTimer = null; }
  if (psShell) {
    try { psShell.stdin.end(); } catch (e) { /* ignore */ }
    psShell = null;
  }
  psReady = false;
  psQueue = [];
}

// PowerShell 预加载：定义 keybd_event 与 Send-Key 函数（只编译一次）
const PS_PRELUDE = "$ErrorActionPreference='SilentlyContinue';"
  + 'Add-Type -TypeDefinition \'using System;using System.Runtime.InteropServices;'
  + 'public static class LCK{'
  + '[DllImport("user32.dll")]public static extern void keybd_event(byte bVk, byte bScan, int dwFlags, int dwExtraInfo);'
  + '[DllImport("user32.dll")]public static extern uint MapVirtualKey(uint uCode, uint uMapType);}\';'
  + 'function Send-Key([byte]$vk,[int]$hold,[int]$gap){'
  + '$s=[byte][LCK]::MapVirtualKey([uint32]$vk,0);'
  + '[LCK]::keybd_event($vk,$s,0,0);Start-Sleep -Milliseconds $hold;'
  + '[LCK]::keybd_event($vk,$s,2,0);Start-Sleep -Milliseconds $gap }';

function toggleCommand(shortcut) {
  if (shortcut === 'ctrl+space') {
    return '$c=[byte][LCK]::MapVirtualKey(0x11,0);[LCK]::keybd_event(0x11,$c,0,0);Start-Sleep -Milliseconds 25;'
      + 'Send-Key 0x20 45 0;[LCK]::keybd_event(0x11,$c,2,0)';
  }
  if (shortcut === 'shift+space') {
    return '$c=[byte][LCK]::MapVirtualKey(0x10,0);[LCK]::keybd_event(0x10,$c,0,0);Start-Sleep -Milliseconds 25;'
      + 'Send-Key 0x20 45 0;[LCK]::keybd_event(0x10,$c,2,0)';
  }
  return 'Send-Key 0x10 45 45';   // 默认：单独按一下 Shift
}

module.exports = {
  runImSelect, toWindowsPath, isWsl, ensureExecutable, listWindowsLayouts, parseCode,
  sendSameImeToggle, disposeSameImeShell, getSameImeStats,
};
