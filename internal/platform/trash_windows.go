//go:build windows

package platform

import (
	"fmt"
	"syscall"
	"unsafe"
)

var procSHFileOperationW = syscall.NewLazyDLL("shell32.dll").NewProc("SHFileOperationW")

// shFileOpStruct mirrors SHFILEOPSTRUCTW (64-bit layout).
type shFileOpStruct struct {
	hwnd                  uintptr
	wFunc                 uint32
	pFrom                 *uint16
	pTo                   *uint16
	fFlags                uint16
	fAnyOperationsAborted int32
	hNameMappings         uintptr
	lpszProgressTitle     *uint16
}

const (
	foDelete          = 0x0003
	fofSilent         = 0x0004
	fofNoConfirmation = 0x0010
	fofAllowUndo      = 0x0040
	fofNoErrorUI      = 0x0400
)

func moveToTrash(path string) error {
	// pFrom must be double-NUL terminated.
	from, err := syscall.UTF16FromString(path)
	if err != nil {
		return err
	}
	from = append(from, 0)
	op := shFileOpStruct{
		wFunc:  foDelete,
		pFrom:  &from[0],
		fFlags: fofAllowUndo | fofNoConfirmation | fofSilent | fofNoErrorUI,
	}
	r, _, _ := procSHFileOperationW.Call(uintptr(unsafe.Pointer(&op)))
	if r != 0 {
		return fmt.Errorf("could not move to Recycle Bin (code 0x%x)", r)
	}
	if op.fAnyOperationsAborted != 0 {
		return fmt.Errorf("move to Recycle Bin was aborted")
	}
	return nil
}
