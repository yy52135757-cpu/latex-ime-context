# 第三方组件声明

本扩展（LaTeX IME Context）以 MIT 协议发布。打包内包含以下第三方二进制：

## im-select

- 文件：`bin/im-select.exe`
- 来源：<https://github.com/daipeihust/im-select>
- 许可：MIT License
- 用途：在 Windows 上读取/切换当前键盘布局（输入法）。
- 说明：该二进制与 `zlflly.smart-cursor`（SmartCursor）扩展捆绑的是同一份；本扩展直接复用，
  调用方式为 WSL 互操作直连或原生执行（失败时退回 PowerShell）。

`im-select` 的许可证随其上游仓库发布，全文见：<https://github.com/daipeihust/im-select/blob/master/LICENSE>

---

## 关于本仓库里的 `latex.hsnips`

该片段文件是**个人配置**，随仓库一起分发只为方便他人参考/修改，不属于扩展本体。
使用前请按自己的写作习惯调整（尤其是 `lec` 模板里的标题、作者等信息）。
