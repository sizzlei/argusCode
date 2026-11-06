//go:build !darwin

package platform

// File reference URLs only exist on macOS.
func resolveFileReference(string) string { return "" }
