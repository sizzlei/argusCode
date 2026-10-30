package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	goruntime "runtime"
	"sync"
	"sync/atomic"
	"time"

	"github.com/sizzlei/argusCode/internal/keymap"
	"github.com/sizzlei/argusCode/internal/platform"
	"github.com/sizzlei/argusCode/internal/sqlschema"
	"github.com/sizzlei/argusCode/internal/update"
	"github.com/sizzlei/argusCode/internal/watch"
	"github.com/sizzlei/argusCode/internal/workspace"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App is bound to the frontend; every exported method is callable from JS as
// window.go.main.App.<Method>.
type App struct {
	ctx context.Context
	// startPath is a folder or file passed on the command line.
	startPath string
	// allowClose is set once the frontend confirmed it is safe to quit.
	allowClose atomic.Bool
	// dirty mirrors whether the frontend has unsaved documents.
	dirty atomic.Bool

	watcher *watch.Watcher

	// updating guards InstallUpdate; restart starts the installed version.
	updating atomic.Bool
	restart  func() error

	// keys holds the user's menu shortcuts (command → combo, "" = none);
	// missing commands use keymap.Defaults.
	keys map[string]string

	searchMu     sync.Mutex
	searchCancel context.CancelFunc
	schemaCancel context.CancelFunc
}

func NewApp() *App {
	a := &App{}
	if len(os.Args) > 1 {
		if p, err := filepath.Abs(os.Args[1]); err == nil {
			if _, err := os.Stat(p); err == nil {
				a.startPath = p
			}
		}
	}
	return a
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	go update.Cleanup() // leftovers of the previous self-update
	// Dropping a folder or files onto the window opens them.
	runtime.OnFileDrop(ctx, func(_, _ int, paths []string) {
		runtime.EventsEmit(ctx, "app:file-drop", paths)
	})
	// File-system changes in watched folders are pushed to the frontend.
	if w, err := watch.New(200*time.Millisecond, func(paths []string) {
		runtime.EventsEmit(ctx, "fs:changed", paths)
	}); err == nil {
		a.watcher = w
	}
}

func (a *App) shutdown(context.Context) {
	if a.watcher != nil {
		_ = a.watcher.Close()
	}
}

// beforeClose is called when the window is about to close. If there are
// unsaved documents the close is cancelled and the frontend asks the user;
// it calls Quit once they decide.
func (a *App) beforeClose(ctx context.Context) (prevent bool) {
	if a.allowClose.Load() || !a.dirty.Load() {
		return false
	}
	runtime.EventsEmit(ctx, "app:before-close")
	return true
}

// processStart is captured as early as possible to measure startup time.
var processStart = time.Now()

// StartupMillis reports how long it took from process start until the
// frontend finished booting (called once by the frontend when ready).
func (a *App) StartupMillis() int64 { return time.Since(processStart).Milliseconds() }

// SettingsDir returns the folder holding session.json (shown in Settings).
func (a *App) SettingsDir() string {
	d, _ := workspace.StateDir()
	return d
}

// SetKeybindings applies the user's shortcuts to the native menu
// (command → combo such as "mod+shift+m"; "" removes the shortcut).
func (a *App) SetKeybindings(binds map[string]string) {
	if reflect.DeepEqual(binds, a.keys) {
		return
	}
	a.keys = binds
	// Rebuilding the menu at runtime crashes Wails' GTK backend; on Linux the
	// menu keeps its labels and the frontend still handles the new keys.
	if a.ctx == nil || goruntime.GOOS == "linux" {
		return
	}
	runtime.MenuSetApplicationMenu(a.ctx, buildMenu(a))
}

// SetTheme applies the app theme ("dark" / "light") to the native window:
// background colour everywhere, title bar on Windows. The macOS title bar
// follows at the next launch (Wails has no runtime appearance switch there).
func (a *App) SetTheme(theme string) {
	if a.ctx == nil {
		return
	}
	if theme == "light" {
		runtime.WindowSetBackgroundColour(a.ctx, 243, 244, 246, 255)
		runtime.WindowSetLightTheme(a.ctx)
	} else {
		runtime.WindowSetBackgroundColour(a.ctx, 30, 31, 34, 255)
		runtime.WindowSetDarkTheme(a.ctx)
	}
}

func (a *App) keyFor(cmd string) string {
	if c, ok := a.keys[cmd]; ok {
		return c
	}
	return keymap.Defaults[cmd]
}

// SetDirty is called by the frontend whenever the unsaved state changes.
func (a *App) SetDirty(dirty bool) { a.dirty.Store(dirty) }

// ---- updates -------------------------------------------------------------

// UpdateInfo is the result of an update check.
type UpdateInfo struct {
	Current   string          `json:"current"`
	Available bool            `json:"available"`
	Supported bool            `json:"supported"` // this OS / build can update itself
	Release   *update.Release `json:"release"`
}

// CheckUpdate asks GitHub for the latest release and compares it with the
// running version (passed by the frontend, which knows it at build time).
func (a *App) CheckUpdate(current string) (*UpdateInfo, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	r, err := update.Latest(ctx)
	if err != nil {
		return nil, err
	}
	return &UpdateInfo{
		Current:   current,
		Available: update.Newer(r.Version, current),
		Supported: update.Supported() && r.AssetURL != "",
		Release:   r,
	}, nil
}

// ReleaseNotes returns the release with the given tag ("v0.9.2").
func (a *App) ReleaseNotes(tag string) (*update.Release, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	return update.ByTag(ctx, tag)
}

// InstallUpdate downloads the release with the given tag and puts it in place
// of the running app. Progress is emitted as "update:progress" (done, total).
// The new version starts with RestartApp.
func (a *App) InstallUpdate(tag string) error {
	if !a.updating.CompareAndSwap(false, true) {
		return errors.New("이미 업데이트 중입니다")
	}
	defer a.updating.Store(false)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	r, err := update.ByTag(ctx, tag)
	if err != nil {
		return err
	}
	dir, err := os.MkdirTemp("", "arguscode-update-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	var last time.Time
	zip, err := update.Download(ctx, r, dir, func(done, total int64) {
		if time.Since(last) > 100*time.Millisecond || done == total {
			last = time.Now()
			runtime.EventsEmit(a.ctx, "update:progress", done, total)
		}
	})
	if err != nil {
		return err
	}
	restart, err := update.Install(zip)
	if err != nil {
		return err
	}
	a.restart = restart
	return nil
}

// RestartApp starts the installed update and quits this process. The
// frontend has already asked about unsaved files.
func (a *App) RestartApp() error {
	if a.restart == nil {
		return errors.New("설치된 업데이트가 없습니다")
	}
	if err := a.restart(); err != nil {
		return fmt.Errorf("새 버전을 시작할 수 없습니다: %w", err)
	}
	a.Quit()
	return nil
}

// ---- lifecycle helpers ---------------------------------------------------

// StartPath returns a folder/file given on the command line, if any.
func (a *App) StartPath() string { return a.startPath }

// LoadSession returns the persisted session JSON ("" if none).
func (a *App) LoadSession() string { return workspace.LoadState() }

// SaveSession persists the session JSON.
func (a *App) SaveSession(js string) error { return workspace.SaveState(js) }

// Quit closes the app without asking again (called after the frontend has
// confirmed unsaved changes).
func (a *App) Quit() {
	a.allowClose.Store(true)
	runtime.Quit(a.ctx)
}

// ---- dialogs -------------------------------------------------------------

// OpenFolderDialog shows the native folder picker. Returns "" if cancelled.
func (a *App) OpenFolderDialog() (string, error) {
	return runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title:                "Open Folder",
		CanCreateDirectories: true,
	})
}

// OpenFileDialog shows the native file picker. Returns "" if cancelled.
func (a *App) OpenFileDialog() (string, error) {
	return runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Open File",
		Filters: []runtime.FileFilter{
			{DisplayName: "Supported (*.sql;*.md;*.json;*.yaml;*.js;*.sh)", Pattern: "*.sql;*.md;*.markdown;*.json;*.yaml;*.yml;*.js;*.mjs;*.sh;*.bash;*.zsh"},
			{DisplayName: "All Files", Pattern: "*"},
		},
	})
}

// SaveAsDialog asks for a destination path for an untitled document.
func (a *App) SaveAsDialog(defaultDir, defaultName string) (string, error) {
	return runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:            "Save As",
		DefaultDirectory: defaultDir,
		DefaultFilename:  defaultName,
	})
}

// ---- file system ---------------------------------------------------------

func (a *App) ListDir(dir string) ([]workspace.Entry, error) { return workspace.ListDir(dir) }

func (a *App) ListFiles(root string) ([]string, error) { return workspace.ListFiles(root) }

func (a *App) ReadFile(path string) (*workspace.FileContent, error) { return workspace.ReadFile(path) }

func (a *App) WriteFile(path, content, eol string, bom bool) (int64, error) {
	return workspace.WriteFile(path, content, eol, bom)
}

func (a *App) Stat(path string) workspace.FileStat { return workspace.Stat(path) }

func (a *App) CreateFile(dir, name string) (string, error) { return workspace.CreateFile(dir, name) }

func (a *App) CreateDir(dir, name string) (string, error) { return workspace.CreateDir(dir, name) }

func (a *App) Rename(path, newName string) (string, error) { return workspace.Rename(path, newName) }

// RevealInFinder opens the OS file manager at path.
func (a *App) RevealInFinder(path string) { revealInFileManager(path) }

// IsDir reports whether path is an existing directory.
func (a *App) IsDir(path string) bool {
	st, err := os.Stat(path)
	return err == nil && st.IsDir()
}

// MoveToTrash moves a file or folder to the macOS Trash / Windows Recycle Bin.
func (a *App) MoveToTrash(path string) error { return platform.MoveToTrash(path) }

// WatchDirs sets the folders whose changes are reported via "fs:changed".
func (a *App) WatchDirs(dirs []string) {
	if a.watcher != nil {
		a.watcher.SetDirs(dirs)
	}
}

// ---- find in files ---------------------------------------------------------

// SearchInFolder searches every text file under root. Starting a new search
// cancels the previous one (which then returns an error the UI ignores).
func (a *App) SearchInFolder(root string, opts workspace.SearchOptions) (*workspace.SearchResult, error) {
	ctx, cancel := context.WithCancel(context.Background())
	a.searchMu.Lock()
	if a.searchCancel != nil {
		a.searchCancel()
	}
	a.searchCancel = cancel
	a.searchMu.Unlock()
	defer cancel()
	return workspace.Search(ctx, root, opts)
}

// SearchInText searches an unsaved document's text.
func (a *App) SearchInText(text string, opts workspace.SearchOptions) ([]workspace.Match, error) {
	return workspace.SearchText(text, opts)
}

// ReplaceResult reports the outcome of a replacement.
type ReplaceResult struct {
	Path  string `json:"path"`
	Text  string `json:"text,omitempty"`
	Count int    `json:"count"`
	Error string `json:"error,omitempty"`
}

// ReplaceInText applies a replacement to in-memory text (open editors).
func (a *App) ReplaceInText(text string, opts workspace.SearchOptions, repl string) (*ReplaceResult, error) {
	out, n, err := workspace.ReplaceText(text, opts, repl)
	if err != nil {
		return nil, err
	}
	return &ReplaceResult{Text: out, Count: n}, nil
}

// ReplaceInFiles applies a replacement to files on disk.
func (a *App) ReplaceInFiles(paths []string, opts workspace.SearchOptions, repl string) []ReplaceResult {
	out := make([]ReplaceResult, 0, len(paths))
	for _, p := range paths {
		n, err := workspace.ReplaceInFile(p, opts, repl)
		r := ReplaceResult{Path: p, Count: n}
		if err != nil {
			r.Error = err.Error()
		}
		out = append(out, r)
	}
	return out
}

// ---- SQL schema --------------------------------------------------------------

// ScanSchema parses the DDL (*.sql) under root for table/column completion.
// A newer call cancels a scan still in progress.
func (a *App) ScanSchema(root string) ([]sqlschema.Table, error) {
	ctx, cancel := context.WithCancel(context.Background())
	a.searchMu.Lock()
	if a.schemaCancel != nil {
		a.schemaCancel()
	}
	a.schemaCancel = cancel
	a.searchMu.Unlock()
	defer cancel()
	return sqlschema.Scan(ctx, root)
}
