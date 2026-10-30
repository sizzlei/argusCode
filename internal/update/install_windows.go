//go:build windows

package update

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

func exePath() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if p, err := filepath.EvalSymlinks(exe); err == nil {
		exe = p
	}
	return exe, nil
}

// Install puts the ArgusCode.exe from zipPath in place of the running exe
// (which is renamed to .old) and returns a function that starts it.
func Install(zipPath string) (func() error, error) {
	exe, err := exePath()
	if err != nil {
		return nil, err
	}
	newExe := exe + ".new"
	if err := extractFile(zipPath, "ArgusCode.exe", newExe); err != nil {
		return nil, fmt.Errorf("%s 폴더에 쓸 수 없어 자동 업데이트를 할 수 없습니다: %w", filepath.Dir(exe), err)
	}
	old := exe + ".old"
	_ = os.Remove(old)
	if err := os.Rename(exe, old); err != nil {
		os.Remove(newExe)
		return nil, fmt.Errorf("실행 중인 파일을 바꿀 수 없습니다: %w", err)
	}
	if err := os.Rename(newExe, exe); err != nil {
		_ = os.Rename(old, exe)
		return nil, fmt.Errorf("새 버전을 설치할 수 없습니다: %w", err)
	}
	return func() error {
		cmd := exec.Command(exe)
		cmd.Dir = filepath.Dir(exe)
		return cmd.Start()
	}, nil
}

// Cleanup removes the previous exe left by the last update.
func Cleanup() {
	if exe, err := exePath(); err == nil {
		_ = os.Remove(exe + ".old")
		_ = os.Remove(exe + ".new")
	}
}
