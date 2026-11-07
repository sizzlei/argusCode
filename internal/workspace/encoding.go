package workspace

import (
	"bytes"
	"errors"
	"fmt"
	"unicode/utf16"
	"unicode/utf8"

	"golang.org/x/text/encoding/korean"
)

// Text encodings the editor reads and writes back unchanged.
const (
	EncUTF8    = "UTF-8"
	EncUTF16LE = "UTF-16LE"
	EncUTF16BE = "UTF-16BE"
	// EncCP949 is EUC-KR including the Windows extension (UHC), which is what
	// Korean Windows tools (Toad, SQL Developer, SSMS…) save as "ANSI".
	EncCP949 = "CP949"
)

var (
	utf16LEBOM = []byte{0xFF, 0xFE}
	utf16BEBOM = []byte{0xFE, 0xFF}
)

// decodeText detects the encoding of b and returns its text as UTF-8.
// bom reports whether a byte-order mark was present (and removed).
func decodeText(b []byte) (text []byte, enc string, bom bool, err error) {
	switch {
	case bytes.HasPrefix(b, utf8BOM):
		b = b[len(utf8BOM):]
		if looksBinary(b) {
			return nil, "", false, ErrBinary
		}
		return b, EncUTF8, true, nil
	case bytes.HasPrefix(b, utf16LEBOM):
		return decodeUTF16(b[2:], false, EncUTF16LE, true)
	case bytes.HasPrefix(b, utf16BEBOM):
		return decodeUTF16(b[2:], true, EncUTF16BE, true)
	}
	if !looksBinary(b) {
		return b, EncUTF8, false, nil
	}
	// UTF-16 without BOM: ASCII-heavy text has a NUL in every other byte.
	if le, ok := utf16Guess(b); ok {
		if le {
			return decodeUTF16(b, false, EncUTF16LE, false)
		}
		return decodeUTF16(b, true, EncUTF16BE, false)
	}
	if bytes.IndexByte(b, 0) < 0 {
		if t, err := korean.EUCKR.NewDecoder().Bytes(b); err == nil && plausibleText(t) {
			return t, EncCP949, false, nil
		}
	}
	return nil, "", false, ErrBinary
}

func decodeUTF16(b []byte, bigEndian bool, enc string, bom bool) ([]byte, string, bool, error) {
	if len(b)%2 == 1 {
		b = b[:len(b)-1]
	}
	u := make([]uint16, len(b)/2)
	for i := range u {
		if bigEndian {
			u[i] = uint16(b[2*i])<<8 | uint16(b[2*i+1])
		} else {
			u[i] = uint16(b[2*i+1])<<8 | uint16(b[2*i])
		}
	}
	t := []byte(string(utf16.Decode(u)))
	if !plausibleText(t) {
		return nil, "", false, ErrBinary
	}
	return t, enc, bom, nil
}

// utf16Guess reports whether b looks like BOM-less UTF-16 and its byte order.
func utf16Guess(b []byte) (littleEndian, ok bool) {
	n := len(b)
	if n > 8000 {
		n = 8000
	}
	if n < 4 {
		return false, false
	}
	var even, odd int
	for i := 0; i+1 < n; i += 2 {
		if b[i] == 0 {
			even++
		}
		if b[i+1] == 0 {
			odd++
		}
	}
	pairs := n / 2
	switch {
	case odd*10 >= pairs*3 && even*20 < pairs:
		return true, true
	case even*10 >= pairs*3 && odd*20 < pairs:
		return false, true
	}
	return false, false
}

// plausibleText rejects decodings full of control characters or U+FFFD.
func plausibleText(t []byte) bool {
	if !utf8.Valid(t) {
		return false
	}
	bad, total := 0, 0
	for _, r := range string(t) {
		total++
		if r == utf8.RuneError || r == 0 || (r < 0x20 && r != '\t' && r != '\n' && r != '\r' && r != '\f') {
			bad++
		}
	}
	return total == 0 || bad*100 <= total // ≤1%
}

// ErrUnencodable is returned when text can't be saved in the file's encoding.
var ErrUnencodable = errors.New("unencodable")

// encodeText converts UTF-8 text to enc, adding a BOM when asked.
func encodeText(text []byte, enc string, bom bool) ([]byte, error) {
	switch enc {
	case "", EncUTF8:
		if bom {
			return append(append([]byte{}, utf8BOM...), text...), nil
		}
		return text, nil
	case EncUTF16LE, EncUTF16BE:
		be := enc == EncUTF16BE
		u := utf16.Encode([]rune(string(text)))
		out := make([]byte, 0, len(u)*2+2)
		if bom {
			if be {
				out = append(out, utf16BEBOM...)
			} else {
				out = append(out, utf16LEBOM...)
			}
		}
		for _, c := range u {
			if be {
				out = append(out, byte(c>>8), byte(c))
			} else {
				out = append(out, byte(c), byte(c>>8))
			}
		}
		return out, nil
	case EncCP949:
		out, err := korean.EUCKR.NewEncoder().Bytes(text)
		if err != nil {
			return nil, fmt.Errorf("%w: CP949(EUC-KR)로 저장할 수 없는 문자가 있습니다. 상태 표시줄의 인코딩을 눌러 UTF-8로 바꾼 뒤 저장해 주세요", ErrUnencodable)
		}
		return out, nil
	}
	return nil, fmt.Errorf("unknown encoding %q", enc)
}
