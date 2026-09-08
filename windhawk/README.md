# Windhawk 任务栏行情扩展

`stock-widget-taskbar.wh.cpp` 是一个可选的 Windhawk Mod 原型。它运行在 `explorer.exe` 中，在任务栏时钟左侧显示贵州茅台的简短行情，并每 2 秒读取本机行情桥接服务。

## 安装测试

1. 安装并打开 [Windhawk](https://windhawk.net/)。
2. 进入“创建新 Mod”，选择 `stock-widget-taskbar.wh.cpp` 的全部内容粘贴进去。
3. 编译并启用 Mod。
4. 确认主程序已启动且 `http://127.0.0.1:8765/quotes?symbols=600519` 可以访问。

## 当前边界

- 这是贴近任务栏的浮层原型，不修改任务栏内部控件。
- 当前先固定显示贵州茅台，后续再接入主程序自选列表同步。
- Windhawk 必须单独安装，主程序不能静默替它注入 `explorer.exe`。
- Windows 更新或任务栏位置变化后，扩展会重新计算位置。
