//go:build !darwin && !windows

package platform

import "os/exec"

func moveToTrash(path string) error {
	if p, err := exec.LookPath("gio"); err == nil {
		return exec.Command(p, "trash", path).Run()
	}
	return ErrTrashUnsupported
}
