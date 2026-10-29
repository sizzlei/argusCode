package main

import (
	"context"
	"os"
	"path/filepath"
	"sync/atomic"

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
	// Dropping a folder or files onto the window opens them.
	runtime.OnFileDrop(ctx, func(_, _ int, paths []string) {
		runtime.EventsEmit(ctx, "app:file-drop", paths)
	})
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

// SetDirty is called by the frontend whenever the unsaved state changes.
func (a *App) SetDirty(dirty bool) { a.dirty.Store(dirty) }

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
			{DisplayName: "Supported (*.sql;*.md;*.json;*.yaml;*.yml)", Pattern: "*.sql;*.md;*.markdown;*.json;*.yaml;*.yml"},
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
