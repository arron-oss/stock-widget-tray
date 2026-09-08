// ==WindhawkMod==
// @id              stock-widget-taskbar
// @name            自选看盘任务栏行情
// @description     在 Windows 任务栏时钟左侧显示本机自选股的简短行情。
// @version         0.1.0
// @author          stock-widget-tray
// @include         explorer.exe
// @architecture    x86-64
// @compilerOptions -lwininet -lshell32
// ==/WindhawkMod==

#include <windows.h>
#include <wininet.h>
#include <shellapi.h>
#include <string>
#include <regex>

namespace {

constexpr wchar_t kClassName[] = L"StockWidgetWindhawkOverlay";
constexpr UINT_PTR kTimerId = 1;
constexpr UINT kRefreshMs = 2000;
HWND g_overlay = nullptr;
std::wstring g_text = L"Stock  loading";
COLORREF g_color = RGB(155, 170, 166);

std::string HttpGet(const std::string& url) {
    HINTERNET session = InternetOpenW(L"stock-widget-taskbar", INTERNET_OPEN_TYPE_PRECONFIG, nullptr, nullptr, 0);
    if (!session) return {};
    HINTERNET request = InternetOpenUrlA(session, url.c_str(), nullptr, 0, INTERNET_FLAG_NO_CACHE_WRITE | INTERNET_FLAG_RELOAD, 0);
    if (!request) { InternetCloseHandle(session); return {}; }
    std::string body;
    char buffer[1024];
    DWORD read = 0;
    while (InternetReadFile(request, buffer, sizeof(buffer), &read) && read) body.append(buffer, read);
    InternetCloseHandle(request);
    InternetCloseHandle(session);
    return body;
}

void RefreshQuote() {
    const std::string body = HttpGet("http://127.0.0.1:8765/quotes?symbols=600519");
    std::smatch match;
    const std::regex priceRe(R"("price"\s*:\s*([0-9.]+))");
    const std::regex changeRe(R"("change"\s*:\s*(-?[0-9.]+))");
    if (!std::regex_search(body, match, priceRe)) {
        g_text = L"Stock  loading";
        g_color = RGB(155, 170, 166);
    } else {
        const std::wstring price(match[1].str().begin(), match[1].str().end());
        std::wstring change = L"--";
        bool up = false;
        if (std::regex_search(body, match, changeRe)) {
            const std::string raw = match[1].str();
            change.assign(raw.begin(), raw.end());
            up = raw.empty() || raw[0] != '-';
        }
        g_text = L"Stock " + price + L" " + (up ? L"+" : L"") + change + L"%";
        g_color = up ? RGB(255, 105, 125) : RGB(53, 208, 160);
    }
    if (g_overlay) InvalidateRect(g_overlay, nullptr, FALSE);
}

void PlaceOverlay() {
    HWND taskbar = FindWindowW(L"Shell_TrayWnd", nullptr);
    if (!taskbar || !g_overlay) return;
    RECT taskbarRect{};
    if (!GetWindowRect(taskbar, &taskbarRect)) return;
    const int width = 172;
    const int height = 28;
    const bool bottom = taskbarRect.top > 0;
    const int x = taskbarRect.right - width - 170;
    const int y = bottom ? taskbarRect.top - height - 4 : taskbarRect.bottom + 4;
    SetWindowPos(g_overlay, HWND_TOPMOST, x, y, width, height, SWP_NOACTIVATE | SWP_SHOWWINDOW);
}

LRESULT CALLBACK OverlayProc(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam) {
    switch (message) {
    case WM_NCHITTEST:
        return HTTRANSPARENT;
    case WM_TIMER:
        if (wParam == kTimerId) { RefreshQuote(); PlaceOverlay(); }
        return 0;
    case WM_PAINT: {
        PAINTSTRUCT paint{};
        HDC dc = BeginPaint(hwnd, &paint);
        RECT rect{};
        GetClientRect(hwnd, &rect);
        HBRUSH background = CreateSolidBrush(RGB(13, 20, 22));
        FillRect(dc, &rect, background);
        DeleteObject(background);
        SetBkMode(dc, TRANSPARENT);
        SetTextColor(dc, g_color);
        HFONT font = CreateFontW(-12, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Microsoft YaHei UI");
        HGDIOBJ previous = SelectObject(dc, font);
        rect.left = 8;
        DrawTextW(dc, g_text.c_str(), -1, &rect, DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);
        SelectObject(dc, previous);
        DeleteObject(font);
        EndPaint(hwnd, &paint);
        return 0;
    }
    case WM_DESTROY:
        KillTimer(hwnd, kTimerId);
        return 0;
    default:
        return DefWindowProcW(hwnd, message, wParam, lParam);
    }
}

DWORD WINAPI OverlayThread(void*) {
    WNDCLASSW klass{};
    klass.lpfnWndProc = OverlayProc;
    klass.hInstance = GetModuleHandleW(nullptr);
    klass.lpszClassName = kClassName;
    klass.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    RegisterClassW(&klass);
    g_overlay = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, kClassName, L"Stock Widget", WS_POPUP, 0, 0, 172, 28, nullptr, nullptr, klass.hInstance, nullptr);
    if (!g_overlay) return 0;
    RefreshQuote();
    PlaceOverlay();
    SetTimer(g_overlay, kTimerId, kRefreshMs, nullptr);
    MSG message{};
    while (GetMessageW(&message, nullptr, 0, 0) > 0) {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
    return 0;
}

} // namespace

BOOL Wh_ModInit() {
    DisableThreadLibraryCalls(GetModuleHandleW(nullptr));
    HANDLE thread = CreateThread(nullptr, 0, OverlayThread, nullptr, 0, nullptr);
    if (thread) CloseHandle(thread);
    return TRUE;
}

void Wh_ModUninit() {
    if (g_overlay) {
        PostMessageW(g_overlay, WM_CLOSE, 0, 0);
        g_overlay = nullptr;
    }
}
