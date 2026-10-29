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

	file := m.AddSubmenu("File")
	file.AddText("New File", keys.CmdOrCtrl("n"), emit("file.new"))
	file.AddText("Open File…", keys.CmdOrCtrl("o"), emit("file.open"))
	file.AddText("Open Folder…", keys.Combo("o", keys.CmdOrCtrlKey, keys.ShiftKey), emit("folder.open"))
	file.AddSeparator()
	file.AddText("Save", keys.CmdOrCtrl("s"), emit("file.save"))
	file.AddText("Save As…", keys.Combo("s", keys.CmdOrCtrlKey, keys.ShiftKey), emit("file.saveAs"))
	file.AddText("Save All", keys.Combo("s", keys.CmdOrCtrlKey, keys.OptionOrAltKey), emit("file.saveAll"))
	file.AddSeparator()
	file.AddText("Close Tab", keys.CmdOrCtrl("w"), emit("tab.close"))
	if goruntime.GOOS != "darwin" {
		file.AddSeparator()
		file.AddText("Exit", keys.CmdOrCtrl("q"), func(*menu.CallbackData) { runtime.Quit(app.ctx) })
	}

	m.Append(menu.EditMenu())

	view := m.AddSubmenu("View")
	view.AddText("Quick Open…", keys.CmdOrCtrl("p"), emit("quickOpen"))
	view.AddText("Toggle Sidebar", keys.CmdOrCtrl("b"), emit("sidebar.toggle"))
	view.AddSeparator()
	view.AddText("Split Editor Right", keys.CmdOrCtrl("\\"), emit("pane.split"))
	view.AddText("Focus Next Pane", keys.CmdOrCtrl("k"), emit("pane.next"))
	view.AddSeparator()
	view.AddText("Markdown Preview", keys.Combo("v", keys.CmdOrCtrlKey, keys.ShiftKey), emit("md.preview"))
	view.AddText("Format Document", keys.Combo("f", keys.ShiftKey, keys.OptionOrAltKey), emit("format"))
	view.AddSeparator()
	view.AddText("Zoom In", keys.CmdOrCtrl("="), emit("zoom.in"))
	view.AddText("Zoom Out", keys.CmdOrCtrl("-"), emit("zoom.out"))
	view.AddText("Reset Zoom", keys.CmdOrCtrl("0"), emit("zoom.reset"))

	if goruntime.GOOS == "darwin" {
		m.Append(menu.WindowMenu())
	}
	return m
}
