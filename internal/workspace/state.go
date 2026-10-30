package workspace

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// StateDir returns the per-user directory where ArgusCode keeps its session
// state (macOS: ~/Library/Application Support/ArgusCode,
// Windows: %AppData%\ArgusCode).
func StateDir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "ArgusCode"), nil
}

// LoadState returns the saved session JSON, or "" when none exists.
func LoadState() string {
	dir, err := StateDir()
	if err != nil {
		return ""
	}
	b, err := os.ReadFile(filepath.Join(dir, "session.json"))
	if err != nil {
		return ""
	}
	return string(b)
}

// SaveState persists the session JSON produced by the frontend.
func SaveState(js string) error {
	dir, err := StateDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	_, err = WriteFile(filepath.Join(dir, "session.json"), js, "LF", false)
	return err
}

// SavedTheme returns the colour theme stored in the session ("dark" when
// unknown), so the native window can start with matching colours.
func SavedTheme() string {
	var st struct {
		Settings struct {
			Theme string `json:"theme"`
		} `json:"settings"`
	}
	if json.Unmarshal([]byte(LoadState()), &st) == nil && st.Settings.Theme == "light" {
		return "light"
	}
	return "dark"
}
