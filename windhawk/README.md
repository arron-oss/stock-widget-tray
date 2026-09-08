# Windhawk 任务栏行情扩展

这是一个可选的 Windhawk Mod。它运行在 `explorer.exe` 中，在任务栏时钟左侧显示贵州茅台的简短行情，并每 2 秒读取本机行情桥接服务。主程序仍负责完整自选列表、买卖点盯盘和 Windows 通知。

## 安装测试

1. 安装并打开 [Windhawk](https://windhawk.net/)。
2. 在 Windhawk 中创建新 Mod，把 `stock-widget-taskbar.wh.cpp` 的全部内容粘贴进去。
3. 编译并启用 Mod。
4. 启动主程序，并确认 `http://127.0.0.1:8765/quotes?symbols=600519` 可以访问。

## 当前边界

- 这是贴近任务栏时钟的浮层，不修改任务栏内部控件。
- 当前固定显示贵州茅台，用于验证任务栏显示和实时刷新。
- Windhawk 必须单独安装，主程序不能静默替它注入 `explorer.exe`。
- Windows 更新、任务栏位置或缩放比例变化后，扩展可能需要重新编译适配。
