# LaTeX IME Context

按 **LaTeX 结构**自动切换输入法（Windows 输入法，通过 `im-select.exe`）。
专为 WSL + LaTeX Workshop 的中文笔记写作设计。

> 📦 **想分享给别人 / 从零开始装？**
> - 装前准备与逐步安装：[`安装指南.md`](安装指南.md)
> - 完整功能列表：[`功能清单.md`](功能清单.md)
> - 现成安装包：`dist/latex-ime-context-0.10.8.vsix` + `dist/latex.hsnips`
>
> 环境要求：**Windows 或 WSL**（其余平台不支持切输入法）。前置扩展：LaTeX Workshop、HyperSnips for Math。

## 判定规则（优先级从高到低）

| # | 光标位置 | 输入法 |
|---|---|---|
| 1 | `verbatim` / `minted` / `lstlisting` / `\verb` 内部 | 英文 |
| 2 | `%` 注释（含行尾 / 整行） | 中文 |
| 3 | 正在输入命令名：`\`、`\sect`、`\begin{al` | 英文 |
| 4 | 光标前已上屏的 ASCII 词 ∈ 快捷指令表（或其前缀），如 `dm` `mk` | 英文 |
| 5 | 数学：`$…$`、`$$…$$`、`\(…\)`、`\[…\]`、`equation/align/cases/matrix/tikzcd/…` | 英文 |
| 6 | `\text{}` `\textbf{}` `\emph{}` `\caption{}` `\section{}` 等参数内部 | 中文 |
| 7 | `\label{}` `\ref{}` `\cite{}` `\url{}` `\includegraphics{}` 等参数内部 | 英文 |
| 8 | 其他（正文、定理/证明等普通环境） | 中文 |

正确处理的嵌套例子：

- `\[ \text{当 $x \in G$ 时} \]`：`\text{}` 里中文，里面的 `$…$` 又回到英文，出 `$` 回中文，出 `}` 回英文。
- `$\ov{a}\ov{b}$` 在 `\[ … \]` 中跨行仍然算数学。
- 配对：`\begin{aligned}` / `\end{aligned}`、`$$` / `$$`、`\[` / `\]`。

## 安装 / 更新

```bash
cd ~/latex-ime-context && bash build.sh
```

脚本会跑测试、打包 vsix、调用 `code --install-extension` 安装。装完按提示 Reload Window。

- 自带 `bin/im-select.exe`（来自 im-select，MIT/Unlicense），激活时会自动 `chmod +x`
  ——WSL 下需要执行位才能通过互操作直接调用（比走 PowerShell 稳定且快得多）。
- 直接调用失败的兜底顺序：`\\wsl.localhost\<发行版>\...` → `\\wsl$\<发行版>\...`。

## 两种切换方式（`latexIme.imeSwitchMode`）

### ⭐ `layout`（默认，推荐）——用 im-select 切换整个键盘布局

- ✅ **状态可读、可校验**：每次切完都会用 `im-select`（无参数）**读回真实编码核对**，不符就重发一次；
  另每 5 秒、窗口获焦时也会重新同步。因此**不可能出现「内存状态与实际相反」的错位**。
- ✅ 状态不依赖任何猜测，不会出现“长时间后就不灵”。
- ⚠️ 会改变 Windows 键盘布局（中文 = 微软拼音所在布局，英文 = en-IE / en-US 布局）。

编码说明：`im-select` 只能切到**系统里真实安装**的键盘布局（Windows LANGID）：
`1033` = 英语(美国)、`2052` = 中文(简体,中国)、`6153` = 英语(爱尔兰)……
照抄 `1033` 而系统里没装时曾经会**静默失败**，现在启动时会**枚举系统已加载的输入法自动纠正**，
也可用菜单「选择中文/英文输入法」手动指定；编码兼容 `6153` / `0x1809` / `00001809` 三种写法。

### `sameIme`——只在中文输入法内部切中/英

**不改变 Windows 键盘布局**，通过发送一个按键（默认 `Ctrl+Space`）让微软拼音自己在「中文/英文」子模式间切换。

- ✅ **不会打断 VS Code（Chromium）的输入法状态**，因此「候选框偶尔不弹」的问题不会出现；
  也不会影响其它程序、不会改动系统语言设置。
- ✅ 切换延迟 ~0ms（常驻一个预热好的 PowerShell，只发按键）。
- ⚠️ 因为读不到中文输入法的内部状态（VS Code 走 TSF，`ImmGetContext` 返回 NULL），
  扩展只能靠**记忆 + 反推**：你每次敲出汉字，它就知道当时是中文模式。
  首次使用会问一次「现在是中文还是英文」，之后自动维持。
  若你觉得状态对不上了，点状态栏菜单 →「校准：现在其实处于「中文/英文」输入」即可。
- 🚑 **状态反了/长时间后不灵**：按 `Ctrl+Alt+0`（或菜单「状态反了？重发一次切换键」）盲发一次即可摆正；
  菜单里还有「查看运行诊断信息」，能看到常驻进程是否存活、发了多少次、有没有丢。
- 切换是**串行排队**的，预加载未完成时会排队并带超时兜底，不会静默丢失（丢了会让中英整体反掉）。
- ⚠️ 需要让「中/英模式切换」键与 `latexIme.sameImeShortcut` 一致（默认 `Ctrl+Space`）；
  若你习惯 `Shift`，把该项改成 `shift` 即可。

> 两种方式可随时在设置里切换（`latexIme.imeSwitchMode`）；菜单里有「测试：发送一次中/英切换键」可先验证，
> 以及「查看运行诊断信息」（常驻进程是否存活、累计发出切换次数、最后错误）。

> 两种方式可随时在设置里切换（`latexIme.imeSwitchMode`），菜单里有「测试：发送一次中/英切换键」可先验证。

## 快捷键

| 键 | 作用 |
|---|---|
| `Ctrl+Alt+D` | 插入显示公式 `\[ … .\]`（默认英文、自动切英文输入法，**不经过输入法和 hsnips，中文输入法下直接可用**） |
| `Ctrl+Alt+K` | 插入行内公式 `$ … $`（同上） |
| `Ctrl+Alt+0` | 状态反了时的急救键：盲发一次中/英切换键 |

片段内容可在设置里改（`latexIme.quickInsert.dm` / `latexIme.quickInsert.mk`，VS Code 片段语法）。
插好的光标位置就在数学环境里，扩展会自动把输入法切到英文。

## 状态栏菜单

点击右下角 `✎ LaTeX 中 / EN` 打开菜单：

- 自动切换：启用 / 禁用
- **笔记语言：中文笔记 / 英文笔记（默认全英）**
- 临时强制英文 / 中文（本行 6 秒）
- **校准：现在其实处于「中文/英文」输入**（sameIme 模式状态对不上时用）
- **测试：发送一次中/英切换键**
- 插入显示公式 / 行内公式
- 查看光标处判定 / 选择中文·英文输入法

**笔记语言 = 英文笔记** 时，正文、注释、`\text{}`、`\caption{}` 等全部默认英文（数学与命令本来就是英文），
适合临时写英文笔记；切回中文笔记即恢复按结构判定。也可直接用命令面板里的
`LaTeX IME: 切换笔记语言（中文笔记/英文笔记）`。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `latexIme.enabled` | `true` | 总开关（状态栏菜单也可切换） |
| `latexIme.imeSwitchMode` | `layout` | 切换方式：`layout`=切键盘布局（状态可读、可校验）/ `sameIme`=中文输入法内部中/英 |
| `latexIme.sameImeShortcut` | `ctrl+space` | sameIme 模式发送的按键，需与系统/微软拼音设置一致 |
| `latexIme.notesLanguage` | `chinese` | **笔记语言总开关**：`english` = 默认全英 |
| `latexIme.quickInsert.dm` / `.mk` | 同 hsnips | `Ctrl+Alt+D` / `Ctrl+Alt+K` 插入的片段 |
| `latexIme.proseMode` | `chinese` | 正文默认模式，可改 `english` |
| `latexIme.commentMode` | `chinese` | 注释默认模式 |
| `latexIme.triggerWords` | 见设置 | 触发英文的快捷指令表（默认就是 hsnips 里的那些） |
| `latexIme.triggerMatchMode` | `exact` | `exact`=完整打出才算 / `prefix`=打前缀就算 / `off`=关闭 |
| `latexIme.expandTypedTriggers` | `true` | 输入法一次上屏触发词时自动替换为片段 |
| `latexIme.triggerSnippets` | `dm`/`mk` | 触发词 → 片段对照表 |
| `latexIme.anyAsciiWordForcesEnglish` | `false` | 更激进：只要光标前有 ASCII 词就切英文 |
| `latexIme.extraMathEnvs` | `[]` | 追加数学环境 |
| `latexIme.extraTextArgs` / `extraEnglishArgs` | `[]` | 追加中文 / 英文参数的命令 |
| `latexIme.chineseCode` / `englishCode` | `2052` / `1033` | LANGID，启动时自动核对并纠正 |
| `latexIme.debug` | `false` | 输出面板 `LaTeX IME Context` 看切换日志 |

## 关于「中文输入法下敲 dm / mk」

输入法的组合串（拼音候选）**不会到达 VS Code**，扩展无法看见你正在敲的 `dm`；
而且 hsnips 的自动展开只认「一次插入 1 个字符」，中文输入法按 Enter 上屏 `dm` 是**一次性插入 2 个字符**，
hsnips 会直接跳过——这就是「dm/mk 时好时坏」的真因。现在有三条路，推荐前两条：

**方案 A：直接按快捷键（最稳，推荐）**

`Ctrl+Alt+D` 插入显示公式、`Ctrl+Alt+K` 插入行内公式——与输入法状态无关，100% 可用。

**方案 B：中文输入法下敲 dm 再按 Enter（已内置）**

扩展自己监听了「一次上屏多个字符」，命中 `latexIme.triggerSnippets`（默认 `dm`/`mk`）就自动换成片段，
不依赖 hsnips。所以：中文模式下敲 `dm` → 按 `Enter` 上屏 → 自动变成 `\[ … .\]`。
也可以在 `triggerSnippets` 里自己加 `thm`、`def` 等。

**方案 C：英文模式下直接敲 dm/mk（交给 hsnips）**

先按 `Ctrl+Alt+0` 或在数学环境里让扩展切到英文，再逐字敲 `dm`/`mk`，由 hsnips 展开。
想给别的触发词也绑快捷键的话：

```json
{
  "key": "ctrl+alt+t",
  "command": "editor.action.insertSnippet",
  "when": "editorLangId == latex",
  "args": { "snippet": "\\begin{theorem}\n\t$1\n\\end{theorem}\n$0" }
}
```

## 智能 Tab 跳出（0.10.0+）

光标在结构内部时，Tab 跳到闭合符之后；嵌套时逐层跳出（先出最内层）。

- 支持 `{ }` `[ ]` `( )`、`\{ \}` `\[ \]` `\( \)`、`\begin{env}…\end{env}`（含 `[可选参数]`）；
- **块状结构**（跨行的环境 / `\[…\]` / 跨行 `{}`）跳出后自动换行：
  下一行已有内容就**新建一行**（缩进照该行，原行整体下移）；下一行是空行就直接落过去；到文件尾则补一行。
- 光标紧跟闭合符之后（后面只剩空白/换行）也算可跳出。
- **不会抢走这些 Tab**：补全弹窗打开时、光标前是触发词或其前缀时（`fun` → `function`）、
  snippet 占位符跳转中（`inSnippetMode`）、单行行内结构。
- 设置：`latexIme.smartTab.enabled` / `.environments` / `.parentheses` / `.skipEnvs`（默认 `["document"]`）/ `.newlineAfterEnv`；状态栏菜单可开关。

## 片段文件与触发词（0.9.0+）

- 扩展会**直接读取 `latex.hsnips`**，把其中的单词触发词（`dm` `mk` `thm` `lm` `sec` `lec` `sum` …）接管，
  在**中文输入法一次上屏 / 替换 / 重复提交**时都能正确展开（原生 hsnips 只支持单字符插入）；
- 尊重 hsnips 的 `m`（仅数学）与 `b`（仅行首）标志；正则/JS 类片段仍由 hsnips 处理；
- 多行片段会自动补行尾换行，走完占位符即落到 `\end{…}` 的下一行；
- 由扩展接管的触发词在 hsnips 里已去掉 `A` 标志，需要时仍可用 Tab 手动展开作后备。

## 已知限制

- 解析器是轻量状态机，不是完整 TeX 引擎：`\catcode` 改动、`\def` 重定义等无法感知（正常笔记用不到）。
- `\verb` 只认单字符定界且不认 `{}` 形式的部分命令。
- 仅 Windows / WSL 可用（`im-select` 是 Windows 程序）。
- 与 SmartCursor 互不冲突：SmartCursor 的语言白名单不含 `latex`，`.tex` 文件由本扩展接管。
