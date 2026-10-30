//go:build !darwin && !windows

package update

import "errors"

// Install is not supported on this OS (releases ship macOS and Windows only).
func Install(string) (func() error, error) {
	return nil, errors.New("이 운영체제는 자동 업데이트를 지원하지 않습니다")
}

// Cleanup does nothing on this OS.
func Cleanup() {}
