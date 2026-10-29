// Package platform holds OS-specific helpers.
package platform

import "errors"

// ErrTrashUnsupported is returned where no trash/recycle bin is available.
var ErrTrashUnsupported = errors.New("moving to trash is not supported on this platform")

// MoveToTrash moves a file or directory to the OS trash (macOS Trash,
// Windows Recycle Bin) so it can be restored by the user.
func MoveToTrash(path string) error { return moveToTrash(path) }
