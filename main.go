package main

import (
	"embed"
	goruntime "runtime"

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

	err := wails.Run(&options.App{
		Title:            "ArgusCode",
		Width:            1280,
		Height:           820,
		MinWidth:         640,
		MinHeight:        400,
		BackgroundColour: &options.RGBA{R: 30, G: 31, B: 34, A: 255},
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
			Appearance:           mac.NSAppearanceNameDarkAqua,
			WebviewIsTransparent: false,
			About: &mac.AboutInfo{
				Title:   "ArgusCode",
				Message: "Lightweight editor for SQL · Markdown · JSON · YAML",
			},
		},
		Windows: &windows.Options{
			Theme: windows.Dark,
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

	m := menu.NewMenu()
	if goruntime.GOOS == "darwin" {
		m.Append(menu.AppMenu())
	}

	file := m.AddSubmenu("파일")
	file.AddText("새 파일", keys.CmdOrCtrl("n"), emit("file.new"))
	file.AddText("파일 열기…", keys.CmdOrCtrl("o"), emit("file.open"))
	file.AddText("폴더 열기…", keys.Combo("o", keys.CmdOrCtrlKey, keys.ShiftKey), emit("folder.open"))
	file.AddSeparator()
	file.AddText("저장", keys.CmdOrCtrl("s"), emit("file.save"))
	file.AddText("다른 이름으로 저장…", keys.Combo("s", keys.CmdOrCtrlKey, keys.ShiftKey), emit("file.saveAs"))
	file.AddText("모두 저장", keys.Combo("s", keys.CmdOrCtrlKey, keys.OptionOrAltKey), emit("file.saveAll"))
	file.AddSeparator()
	file.AddText("탭 닫기", keys.CmdOrCtrl("w"), emit("tab.close"))
	file.AddSeparator()
	file.AddText("설정…", keys.CmdOrCtrl(","), emit("app.settings"))
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
	view.AddText("빠른 열기…", keys.CmdOrCtrl("p"), emit("quickOpen"))
	view.AddText("탐색기", keys.Combo("e", keys.CmdOrCtrlKey, keys.ShiftKey), emit("view.explorer"))
	view.AddText("폴더에서 찾기…", keys.Combo("f", keys.CmdOrCtrlKey, keys.ShiftKey), emit("view.search"))
	view.AddText("사이드바 보이기/숨기기", keys.CmdOrCtrl("b"), emit("sidebar.toggle"))
	view.AddSeparator()
	view.AddText("오른쪽으로 분할", keys.CmdOrCtrl("\\"), emit("pane.split"))
	view.AddText("다음 편집 그룹으로 이동", keys.CmdOrCtrl("k"), emit("pane.next"))
	view.AddSeparator()
	view.AddText("Markdown 미리보기", keys.Combo("v", keys.CmdOrCtrlKey, keys.ShiftKey), emit("md.preview"))
	view.AddText("실행계획 보기", keys.Combo("e", keys.CmdOrCtrlKey, keys.OptionOrAltKey), emit("plan.toggle"))
	view.AddText("문서 정렬", keys.Combo("f", keys.ShiftKey, keys.OptionOrAltKey), emit("format"))
	view.AddText("개요", keys.Combo("o", keys.CmdOrCtrlKey, keys.OptionOrAltKey), emit("view.outline"))
	view.AddSeparator()
	view.AddText("저장된 버전과 비교", nil, emit("diff.saved"))
	view.AddText("다른 탭과 비교…", nil, emit("diff.tabs"))
	view.AddSeparator()
	view.AddText("확대", keys.CmdOrCtrl("="), emit("zoom.in"))
	view.AddText("축소", keys.CmdOrCtrl("-"), emit("zoom.out"))
	view.AddText("원래 크기", keys.CmdOrCtrl("0"), emit("zoom.reset"))

	if goruntime.GOOS == "darwin" {
		m.Append(menu.WindowMenu())
	}
	return m
}
