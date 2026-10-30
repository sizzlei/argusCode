//go:build darwin

package update

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

const workPrefix = ".ArgusCode-update-"

// appBundle is the .app the running executable belongs to.
func appBundle() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if p, err := filepath.EvalSymlinks(exe); err == nil {
		exe = p
	}
	i := strings.Index(exe, ".app/Contents/MacOS/")
	if i < 0 {
		return "", errors.New("앱 번들(.app)로 실행할 때만 자동 업데이트할 수 있습니다")
	}
	return exe[:i+4], nil
}

// Install replaces the running ArgusCode.app with the one in zipPath and
// returns a function that starts the new version (call it, then quit).
func Install(zipPath string) (func() error, error) {
	app, err := appBundle()
	if err != nil {
		return nil, err
	}
	parent := filepath.Dir(app)
	// Work next to the app so the final moves are renames on one volume.
	work, err := os.MkdirTemp(parent, workPrefix)
	if err != nil {
		return nil, fmt.Errorf("%s 폴더에 쓸 권한이 없어 자동 업데이트를 할 수 없습니다. 릴리스 페이지에서 내려받아 설치해 주세요", parent)
	}
	fail := func(e error) (func() error, error) {
		os.RemoveAll(work)
		return nil, e
	}
	if out, err := exec.Command("/usr/bin/ditto", "-x", "-k", zipPath, work).CombinedOutput(); err != nil {
		return fail(fmt.Errorf("압축 풀기 실패: %v %s", err, strings.TrimSpace(string(out))))
	}
	newApp := filepath.Join(work, "ArgusCode.app")
	if st, err := os.Stat(filepath.Join(newApp, "Contents", "MacOS")); err != nil || !st.IsDir() {
		return fail(errors.New("압축 파일에 ArgusCode.app이 없습니다"))
	}
	_ = exec.Command("/usr/bin/xattr", "-dr", "com.apple.quarantine", newApp).Run()

	old := filepath.Join(work, "previous.app")
	if err := os.Rename(app, old); err != nil {
		return fail(fmt.Errorf("기존 앱을 옮길 수 없습니다: %w", err))
	}
	if err := os.Rename(newApp, app); err != nil {
		_ = os.Rename(old, app)
		return fail(fmt.Errorf("새 앱을 설치할 수 없습니다: %w", err))
	}
	return func() error {
		// Relaunch once this process has exited, then drop the old bundle.
		cmd := exec.Command("/bin/sh", "-c", `sleep 1; /usr/bin/open -n "$1"; sleep 10; rm -rf "$2"`, "sh", app, work)
		cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		return cmd.Start()
	}, nil
}

// Cleanup removes what an interrupted update left next to the app.
func Cleanup() {
	app, err := appBundle()
	if err != nil {
		return
	}
	left, _ := filepath.Glob(filepath.Join(filepath.Dir(app), workPrefix+"*"))
	for _, d := range left {
		_ = os.RemoveAll(d)
	}
}
