// Package keymap converts the frontend's shortcut combos ("mod+shift+m") to
// native menu accelerators and holds the default shortcuts of menu items.
package keymap

import (
	"strings"

	"github.com/wailsapp/wails/v2/pkg/menu/keys"
)

// Defaults are the menu commands' default shortcuts ("" = none). They must
// match COMMANDS in frontend/src/keybindings.ts (checked by its unit test).
var Defaults = map[string]string{
	"file.new":        "mod+n",
	"file.open":       "mod+o",
	"folder.open":     "mod+shift+o",
	"file.save":       "mod+s",
	"file.saveAs":     "mod+shift+s",
	"file.saveAll":    "mod+alt+s",
	"tab.close":       "mod+w",
	"app.settings":    "mod+,",
	"app.checkUpdate": "",
	"quickOpen":       "mod+p",
	"view.explorer":   "mod+shift+e",
	"view.search":     "mod+shift+f",
	"view.outline":    "mod+alt+o",
	"sidebar.toggle":  "mod+b",
	"pane.split":      "mod+\\",
	"pane.next":       "mod+k",
	"format":          "shift+alt+f",
	"md.preview":      "mod+shift+v",
	"plan.toggle":     "mod+alt+e",
	"problems.open":   "mod+shift+m",
	"sql.rollback":    "",
	"mongo.toShell":   "",
	"diff.saved":      "",
	"diff.tabs":       "",
	"zoom.in":         "mod+=",
	"zoom.out":        "mod+-",
	"zoom.reset":      "mod+0",
}

var modifiers = map[string]keys.Modifier{
	"mod":   keys.CmdOrCtrlKey,
	"ctrl":  keys.ControlKey,
	"shift": keys.ShiftKey,
	"alt":   keys.OptionOrAltKey,
}

var named = map[string]string{
	"arrowup":    "up",
	"arrowdown":  "down",
	"arrowleft":  "left",
	"arrowright": "right",
	"enter":      "return",
	"escape":     "escape",
	"backspace":  "backspace",
	"delete":     "delete",
	"tab":        "tab",
	"space":      "space",
	"home":       "home",
	"end":        "end",
	"pageup":     "page up",
	"pagedown":   "page down",
}

// Accelerator converts a combo to a menu accelerator; nil for "" or an
// unsupported combo (the shortcut then only works inside the window).
func Accelerator(combo string) *keys.Accelerator {
	combo = strings.ToLower(strings.TrimSpace(combo))
	if combo == "" {
		return nil
	}
	key := ""
	if strings.HasSuffix(combo, "++") {
		key = "+"
		combo = strings.TrimSuffix(combo, "++")
	} else {
		i := strings.LastIndex(combo, "+")
		key = combo[i+1:]
		combo = combo[:max(i, 0)]
	}
	var mods []keys.Modifier
	seen := map[string]bool{}
	for _, p := range strings.Split(combo, "+") {
		if p == "" {
			continue
		}
		m, ok := modifiers[p]
		if !ok || seen[p] {
			return nil
		}
		seen[p] = true
		mods = append(mods, m)
	}
	switch {
	case named[key] != "":
		key = named[key]
	case len(key) >= 2 && key[0] == 'f' && isDigits(key[1:]):
		// f1..f24
	case len([]rune(key)) == 1:
	default:
		return nil
	}
	return &keys.Accelerator{Key: key, Modifiers: mods}
}

var labelKeys = map[string]string{
	"arrowup":    "Up",
	"arrowdown":  "Down",
	"arrowleft":  "Left",
	"arrowright": "Right",
	"enter":      "Enter",
	"escape":     "Esc",
	"backspace":  "Backspace",
	"delete":     "Delete",
	"tab":        "Tab",
	"space":      "Space",
	"home":       "Home",
	"end":        "End",
	"pageup":     "PgUp",
	"pagedown":   "PgDn",
}

// Label is the Windows-style text of a combo ("Ctrl+Shift+M"); "" for none.
// Windows menus show it after a tab instead of registering an accelerator,
// so a shortcut the user removed can't keep firing (winc never unregisters
// accelerators when the menu is rebuilt); the keys themselves are handled by
// the frontend.
func Label(combo string) string {
	combo = strings.ToLower(strings.TrimSpace(combo))
	if combo == "" {
		return ""
	}
	key := ""
	if strings.HasSuffix(combo, "++") {
		key, combo = "+", strings.TrimSuffix(combo, "++")
	} else {
		i := strings.LastIndex(combo, "+")
		key, combo = combo[i+1:], combo[:max(i, 0)]
	}
	has := map[string]bool{}
	for _, p := range strings.Split(combo, "+") {
		has[p] = true
	}
	var parts []string
	if has["mod"] || has["ctrl"] {
		parts = append(parts, "Ctrl")
	}
	if has["shift"] {
		parts = append(parts, "Shift")
	}
	if has["alt"] {
		parts = append(parts, "Alt")
	}
	if l, ok := labelKeys[key]; ok {
		key = l
	} else {
		key = strings.ToUpper(key)
	}
	return strings.Join(append(parts, key), "+")
}

func isDigits(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return s != ""
}
