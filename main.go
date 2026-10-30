package main

import (
	"embed"
	goruntime "runtime"

	"github.com/sizzlei/argusCode/internal/keymap"
	"github.com/sizzlei/argusCode/internal/workspace"
	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/menu"
	"github.com/wailsapp/wails/v2/pkg/menu/keys"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	app := NewApp()

	// Window chrome follows the saved theme (macOS title bar changes on the next launch).
	light := workspace.SavedTheme() == "light"
	bg := &options.RGBA{R: 30, G: 31, B: 34, A: 255}
	appearance, winTheme := mac.NSAppearanceNameDarkAqua, windows.Dark
	if light {
		bg = &options.RGBA{R: 243, G: 244, B: 246, A: 255}
		appearance, winTheme = mac.NSAppearanceNameAqua, windows.Light
	}

	err := wails.Run(&options.App{
		Title:            "ArgusCode",
		Width:            1280,
		Height:           820,
		MinWidth:         640,
		MinHeight:        400,
		BackgroundColour: bg,
		AssetServer:      &assetserver.Options{Assets: assets},
		Menu:             buildMenu(app),
		OnStartup:        app.startup,
		OnBeforeClose:    app.beforeClose,
		OnShutdown:       app.shutdown,
		Bind:             []interface{}{app},
		DragAndDrop: &options.DragAndDrop{
			EnableFileDrop:     true,
			DisableWebViewDrop: true,
		},
		Mac: &mac.Options{
			TitleBar:             mac.TitleBarDefault(),
			Appearance:           appearance,
			WebviewIsTransparent: false,
			About: &mac.AboutInfo{
				Title:   "ArgusCode",
				Message: "Lightweight editor for SQL · Markdown · JSON · YAML",
			},
		},
		Windows: &windows.Options{
			Theme: winTheme,
		},
	})
	if err != nil {
		println("Error:", err.Error())
	}
}

// buildMenu creates the native menu. Commands are forwarded to the frontend
// as "cmd" events so keyboard shortcuts work identically on macOS and
// Windows. The Edit menu is required on macOS for copy/paste shortcuts.
func buildMenu(app *App) *menu.Menu {
	emit := func(cmd string) func(*menu.CallbackData) {
		return func(*menu.CallbackData) { runtime.EventsEmit(app.ctx, "cmd", cmd) }
	}
	// Shortcut of a command: the user's binding (Settings → 단축키) or the default.
	// Windows shows it as text only (see keymap.Label); the frontend handles the keys.
	key := func(cmd string) *keys.Accelerator {
		if goruntime.GOOS == "windows" {
			return nil
		}
		return keymap.Accelerator(app.keyFor(cmd))
	}
	label := func(text, cmd string) string {
		if goruntime.GOOS == "windows" {
			if l := keymap.Label(app.keyFor(cmd)); l != "" {
				return text + "\t" + l
			}
		}
		return text
	}

	m := menu.NewMenu()
	if goruntime.GOOS == "darwin" {
		m.Append(menu.AppMenu())
	}

	file := m.AddSubmenu("파일")
	file.AddText(label("새 파일", "file.new"), key("file.new"), emit("file.new"))
	file.AddText(label("파일 열기…", "file.open"), key("file.open"), emit("file.open"))
	file.AddText(label("폴더 열기…", "folder.open"), key("folder.open"), emit("folder.open"))
	file.AddSeparator()
	file.AddText(label("저장", "file.save"), key("file.save"), emit("file.save"))
	file.AddText(label("다른 이름으로 저장…", "file.saveAs"), key("file.saveAs"), emit("file.saveAs"))
	file.AddText(label("모두 저장", "file.saveAll"), key("file.saveAll"), emit("file.saveAll"))
	file.AddSeparator()
	file.AddText(label("탭 닫기", "tab.close"), key("tab.close"), emit("tab.close"))
	file.AddSeparator()
	file.AddText(label("설정…", "app.settings"), key("app.settings"), emit("app.settings"))
	file.AddText(label("업데이트 확인…", "app.checkUpdate"), key("app.checkUpdate"), emit("app.checkUpdate"))
	if goruntime.GOOS != "darwin" {
		file.AddSeparator()
		file.AddText("종료", keys.CmdOrCtrl("q"), func(*menu.CallbackData) { runtime.Quit(app.ctx) })
	}

	// The Edit role menu is what makes ⌘C/⌘V/⌘Z work in the macOS WebView.
	// Other platforms don't implement roles (Windows shows an empty menu,
	// Linux crashes) and WebView2/WebKitGTK handle these keys natively.
	if goruntime.GOOS == "darwin" {
		m.Append(menu.EditMenu())
	}

	view := m.AddSubmenu("보기")
	view.AddText(label("빠른 열기…", "quickOpen"), key("quickOpen"), emit("quickOpen"))
	view.AddText(label("탐색기", "view.explorer"), key("view.explorer"), emit("view.explorer"))
	view.AddText(label("폴더에서 찾기…", "view.search"), key("view.search"), emit("view.search"))
	view.AddText(label("사이드바 보이기/숨기기", "sidebar.toggle"), key("sidebar.toggle"), emit("sidebar.toggle"))
	view.AddSeparator()
	view.AddText(label("오른쪽으로 분할", "pane.split"), key("pane.split"), emit("pane.split"))
	view.AddText(label("다음 편집 그룹으로 이동", "pane.next"), key("pane.next"), emit("pane.next"))
	view.AddSeparator()
	view.AddText(label("Markdown 미리보기", "md.preview"), key("md.preview"), emit("md.preview"))
	view.AddText(label("실행계획 / 데드락 보기", "plan.toggle"), key("plan.toggle"), emit("plan.toggle"))
	view.AddText(label("mongosh 쿼리로 변환", "mongo.toShell"), key("mongo.toShell"), emit("mongo.toShell"))
	view.AddText(label("DDL 검토 패널", "problems.open"), key("problems.open"), emit("problems.open"))
	view.AddText(label("롤백 스크립트 만들기", "sql.rollback"), key("sql.rollback"), emit("sql.rollback"))
	view.AddText(label("문서 정렬", "format"), key("format"), emit("format"))
	view.AddText(label("개요", "view.outline"), key("view.outline"), emit("view.outline"))
	view.AddSeparator()
	view.AddText(label("저장된 버전과 비교", "diff.saved"), key("diff.saved"), emit("diff.saved"))
	view.AddText(label("다른 탭과 비교…", "diff.tabs"), key("diff.tabs"), emit("diff.tabs"))
	view.AddSeparator()
	view.AddText(label("확대", "zoom.in"), key("zoom.in"), emit("zoom.in"))
	view.AddText(label("축소", "zoom.out"), key("zoom.out"), emit("zoom.out"))
	view.AddText(label("원래 크기", "zoom.reset"), key("zoom.reset"), emit("zoom.reset"))

	if goruntime.GOOS == "darwin" {
		m.Append(menu.WindowMenu())
	}
	return m
}
