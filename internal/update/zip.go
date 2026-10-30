package update

import (
	"archive/zip"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"strings"
)

// extractFile copies the archive member whose base name is name to dst.
func extractFile(zipPath, name, dst string) error {
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return fmt.Errorf("압축 파일을 열 수 없습니다: %w", err)
	}
	defer zr.Close()
	for _, f := range zr.File {
		if f.FileInfo().IsDir() || !strings.EqualFold(path.Base(f.Name), name) {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		defer rc.Close()
		out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
		if err != nil {
			return err
		}
		if _, err := io.Copy(out, rc); err != nil {
			out.Close()
			os.Remove(dst)
			return err
		}
		return out.Close()
	}
	return errors.New("압축 파일에 " + name + "이(가) 없습니다")
}
