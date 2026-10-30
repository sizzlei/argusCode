package workspace

import "testing"

func TestSavedTheme(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("AppData", dir)
	if got := SavedTheme(); got != "dark" {
		t.Fatalf("no session: got %q", got)
	}
	if err := SaveState(`{"settings":{"theme":"light","fontSize":13}}`); err != nil {
		t.Fatal(err)
	}
	if got := SavedTheme(); got != "light" {
		t.Fatalf("light session: got %q", got)
	}
	if err := SaveState(`{"settings":{"theme":"neon"}}`); err != nil {
		t.Fatal(err)
	}
	if got := SavedTheme(); got != "dark" {
		t.Fatalf("unknown theme: got %q", got)
	}
}
