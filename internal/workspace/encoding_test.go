package workspace

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/text/encoding/korean"
)

const koSQL = "-- 주문 테이블 조회\r\nSELECT * FROM orders WHERE memo = '한글';\r\n"

func roundTrip(t *testing.T, raw []byte, wantEnc string, wantBOM bool) {
	t.Helper()
	p := filepath.Join(t.TempDir(), "a.sql")
	if err := os.WriteFile(p, raw, 0o644); err != nil {
		t.Fatal(err)
	}
	fc, err := ReadFile(p)
	if err != nil {
		t.Fatalf("%s: ReadFile: %v", wantEnc, err)
	}
	if fc.Encoding != wantEnc || fc.BOM != wantBOM || fc.EOL != "CRLF" {
		t.Fatalf("got enc=%s bom=%v eol=%s, want %s %v CRLF", fc.Encoding, fc.BOM, fc.EOL, wantEnc, wantBOM)
	}
	want := bytes.ReplaceAll([]byte(koSQL), []byte("\r\n"), []byte("\n"))
	if fc.Content != string(want) {
		t.Fatalf("%s: content %q", wantEnc, fc.Content)
	}
	if _, err := WriteFile(p, fc.Content, fc.EOL, fc.BOM, fc.Encoding); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(p)
	if !bytes.Equal(got, raw) {
		t.Fatalf("%s: saved bytes differ from original", wantEnc)
	}
}

func utf16Bytes(s string, be, bom bool) []byte {
	b, _ := encodeText([]byte(s), map[bool]string{true: EncUTF16BE, false: EncUTF16LE}[be], bom)
	return b
}

func TestEncodings(t *testing.T) {
	cp949, err := korean.EUCKR.NewEncoder().Bytes([]byte(koSQL))
	if err != nil {
		t.Fatal(err)
	}
	roundTrip(t, []byte(koSQL), EncUTF8, false)
	roundTrip(t, append([]byte{0xEF, 0xBB, 0xBF}, koSQL...), EncUTF8, true)
	roundTrip(t, cp949, EncCP949, false)
	roundTrip(t, utf16Bytes(koSQL, false, true), EncUTF16LE, true)
	roundTrip(t, utf16Bytes(koSQL, true, true), EncUTF16BE, true)
	roundTrip(t, utf16Bytes(koSQL, false, false), EncUTF16LE, false)
}

func TestBinaryStillRejected(t *testing.T) {
	p := filepath.Join(t.TempDir(), "x.bin")
	raw := []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D, 'I', 'H', 'D', 'R', 0xFF, 0x00, 0x13, 0x88}
	_ = os.WriteFile(p, raw, 0o644)
	if _, err := ReadFile(p); err != ErrBinary {
		t.Fatalf("err = %v, want ErrBinary", err)
	}
}

func TestCP949Unencodable(t *testing.T) {
	p := filepath.Join(t.TempDir(), "a.sql")
	if _, err := WriteFile(p, "SELECT '😀';\n", "LF", false, EncCP949); err == nil {
		t.Fatal("want error for emoji in CP949")
	}
}
