# 自选看盘小组件

一个轻量的 Windows Tauri 小窗：单页自选看盘、约 0.1 秒行情推送、价格上下穿越提醒、托盘隐藏。行情由本机桥接服务读取，避免把行情请求直接暴露给页面。

## 第一次运行

在“x64 Native Tools Command Prompt for VS 2022”（或已加载 `VsDevCmd.bat` 的终端）执行：

```powershell
cd C:\Users\34541\Desktop\stock-widget-tray
python -m pip install akshare
npm install
npm run tauri dev
```

如果 Rust 报 `link.exe` 或 `kernel32.lib` 缺失，需要安装 Visual Studio Build Tools 的 C++ 工具和 Windows SDK，然后重新打开终端。

## 使用

- 在底部输入 6 位代码后会先校验行情源；只有能查到名称的有效代码才会加入自选。
- 每行显示资金流摘要、现价（涨跌幅）、开盘、最高和最低。
- 每行右下角显示东方财富日内 1 分钟分时图，约每 30 秒更新一次；资金流括号内为本次请求相对上次请求的变化量。
- 在股票行从右向左拖动超过约 90px 可移除标的。
- 点击“风控”展开设置，分别填写卖点价和买点价；现价达到卖点或买点时仅发送 Windows 系统通知，不显示软件内弹窗。
- 每只股票可分别开启卖点和买点盯盘；每次穿越对应价格只提醒一次，回到价格区间后再次穿越才会重新提醒。
- 点击右上角“收进托盘”隐藏窗口；托盘图标左键可再次显示，右键菜单可退出。
- 自选列表保存在浏览器本地存储中，最多 20 只。

## 行情说明

行情桥接服务在交易时段按约 0.1 秒批量请求全部自选股，并通过本地 SSE 增量推送到页面；页面不再高频轮询，也不会在每次报价时重建 DOM 或写入 localStorage。批量主链路使用新浪实时行情接口，新浪失败时切换腾讯批量接口，AKShare 的逐只接口只作为网络异常时的异步兜底，并在真正需要兜底时才加载，避免阻塞正常启动。非交易时段自动降到 15 秒一轮。行情服务地址为 `http://127.0.0.1:8765/quotes`，推送地址为 `http://127.0.0.1:8765/stream`。

资金流摘要来自东方财富公开接口，约每 2 秒批量检查一次，显示超大单、大单、中单和小单的当日净流入（正数为流入，负数为流出）。它仍受公开接口自身延迟和分类口径影响，不等同于 Level-2 逐笔数据。

程序使用 Windows 命名互斥锁保证单实例；退出时会回收由程序启动的 Python 行情桥接进程，避免旧版本服务占用 8765 端口。

当前开发版启动依赖本机 Python 和 AKShare。系统预警使用 Rust 端的 Tauri Windows 通知插件；请使用 MSI/NSIS 安装后运行，直接运行 `src-tauri/target/release` 下的裸 `.exe` 没有 Windows 应用通知身份，系统会把通知来源显示为 PowerShell。如果 Windows 通知被系统关闭，需要在系统通知设置中允许本程序。正式分发时需要再用 PyInstaller 把 `src-tauri/resources/server.py` 及其 Python 运行时打成 sidecar，才能做到目标机器免安装 Python。

## 可选：任务栏行情

仓库内附带一个可选的 Windhawk 扩展：`windhawk/stock-widget-taskbar.wh.cpp`。启用后，它会在 Windows 任务栏时钟左侧显示一条紧凑行情，适合快速查看；完整自选列表、买点/卖点设置和系统通知仍由主程序负责。

主程序标题栏提供“任务栏”入口：

- 未检测到 Windhawk：打开 Windhawk 官方下载页。
- 已安装但扩展未运行：打开安装包附带的 Mod 文件所在位置。
- 扩展已经运行：直接显示状态提示。

首次使用方式：

1. 安装并打开 [Windhawk](https://windhawk.net/)。
2. 在 Windhawk 中创建新 Mod，把 `windhawk/stock-widget-taskbar.wh.cpp` 的全部内容粘贴进去。
3. 编译并启用 Mod，同时保持本程序运行。

这个扩展需要 Windhawk 单独加载到 Windows 资源管理器中，主程序不会自动注入或修改 `explorer.exe`。当前扩展先固定显示贵州茅台，用于验证任务栏显示和实时刷新；后续再接入主程序的完整自选列表。Windows 更新、任务栏位置或缩放比例变化后，扩展可能需要重新编译适配。
