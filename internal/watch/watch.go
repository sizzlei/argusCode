// Package watch reports file-system changes in a set of directories
// (non-recursive) with debouncing. Only the directories the user can see
// are watched — the root, expanded folders and folders of open files —
// which keeps the number of OS handles small.
package watch

import (
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

// MaxEntries skips directories with more entries than this (kqueue on macOS
// opens one descriptor per file in a watched directory).
const MaxEntries = 3000

// Watcher wraps fsnotify and emits batches of changed paths.
type Watcher struct {
	w       *fsnotify.Watcher
	onBatch func(paths []string)
	delay   time.Duration

	mu      sync.Mutex
	dirs    map[string]bool
	pending map[string]bool
	timer   *time.Timer
	closed  bool
}

// New starts a watcher. onBatch receives the changed file paths and their
// parent directories, at most once per delay.
func New(delay time.Duration, onBatch func(paths []string)) (*Watcher, error) {
	fw, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	w := &Watcher{w: fw, onBatch: onBatch, delay: delay, dirs: map[string]bool{}, pending: map[string]bool{}}
	go w.loop()
	return w, nil
}

func (w *Watcher) loop() {
	for {
		select {
		case ev, ok := <-w.w.Events:
			if !ok {
				return
			}
			if ev.Op == fsnotify.Chmod {
				continue
			}
			w.add(ev.Name)
		case _, ok := <-w.w.Errors:
			if !ok {
				return
			}
		}
	}
}

func (w *Watcher) add(name string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return
	}
	w.pending[name] = true
	w.pending[filepath.Dir(name)] = true
	if w.timer == nil {
		w.timer = time.AfterFunc(w.delay, w.flush)
	}
}

func (w *Watcher) flush() {
	w.mu.Lock()
	paths := make([]string, 0, len(w.pending))
	for p := range w.pending {
		paths = append(paths, p)
	}
	w.pending = map[string]bool{}
	w.timer = nil
	closed := w.closed
	w.mu.Unlock()
	if !closed && len(paths) > 0 {
		w.onBatch(paths)
	}
}

// SetDirs replaces the set of watched directories.
func (w *Watcher) SetDirs(dirs []string) {
	want := map[string]bool{}
	for _, d := range dirs {
		if d != "" {
			want[filepath.Clean(d)] = true
		}
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return
	}
	for d := range w.dirs {
		if !want[d] {
			_ = w.w.Remove(d)
			delete(w.dirs, d)
		}
	}
	for d := range want {
		if w.dirs[d] || tooBig(d) {
			continue
		}
		if err := w.w.Add(d); err == nil {
			w.dirs[d] = true
		}
	}
}

func tooBig(dir string) bool {
	f, err := os.Open(dir)
	if err != nil {
		return true
	}
	defer f.Close()
	names, _ := f.Readdirnames(MaxEntries + 1)
	return len(names) > MaxEntries
}

// Close stops the watcher.
func (w *Watcher) Close() error {
	w.mu.Lock()
	w.closed = true
	if w.timer != nil {
		w.timer.Stop()
	}
	w.mu.Unlock()
	return w.w.Close()
}
