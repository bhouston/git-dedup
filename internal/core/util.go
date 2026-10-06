package core

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const isWindows = runtime.GOOS == "windows"

func expandHome(value string) string {
	home, _ := os.UserHomeDir()
	if value == "~" {
		return home
	}
	if strings.HasPrefix(value, "~/") || (isWindows && strings.HasPrefix(value, `~\`)) {
		return filepath.Join(home, value[2:])
	}
	return value
}

func isPresent(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

// resolvePath joins like Node's path.resolve(base, path): an absolute path wins, and the result is clean.
func resolvePath(base, path string) string {
	if filepath.IsAbs(path) {
		return filepath.Clean(path)
	}
	// On Windows, `\x` is relative to the current drive and `C:x` to that drive's current directory.
	if isWindows && (strings.HasPrefix(path, `\`) || strings.HasPrefix(path, "/")) {
		return filepath.Clean(filepath.VolumeName(base) + path)
	}
	if isWindows && filepath.VolumeName(path) != "" {
		if abs, err := filepath.Abs(path); err == nil {
			return abs
		}
	}
	return filepath.Join(base, path)
}

func canonicalPath(path string) string {
	if existing, err := realpath(path); err == nil {
		return existing
	}
	parent := filepath.Dir(path)
	if parent == path {
		return path
	}
	return filepath.Join(canonicalPath(parent), filepath.Base(path))
}

// nativePath converts Git for Windows `C:/x` output into the native form so it joins and compares with ours.
func nativePath(path string) string {
	if isWindows {
		return filepath.Clean(path)
	}
	return path
}

// samePath compares paths as the file system does: Windows paths ignore case and accept either separator.
func samePath(a, b string) bool {
	if isWindows {
		return strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
	}
	return a == b
}

func directorySize(path string) int64 {
	entries, err := os.ReadDir(path)
	if err != nil {
		return 0
	}
	var size int64
	for _, entry := range entries {
		child := filepath.Join(path, entry.Name())
		if entry.IsDir() {
			size += directorySize(child)
		} else if entry.Type().IsRegular() {
			if info, err := os.Stat(child); err == nil {
				size += info.Size()
			}
		}
	}
	return size
}

func remoteID(key string) string {
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:])
}

func randomUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

// jsonLine serializes like JSON.stringify followed by a newline, so files match those the Node version writes.
func jsonLine(value any) string {
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		panic(err)
	}
	return buf.String()
}

func readText(path string) (string, error) {
	data, err := os.ReadFile(path)
	return string(data), err
}

// readTextOr returns the file's text, or fallback when it cannot be read.
func readTextOr(path, fallback string) string {
	text, err := readText(path)
	if err != nil {
		return fallback
	}
	return text
}

func writeText(path, text string) error {
	return os.WriteFile(path, []byte(text), 0o666)
}

// writeExclusive creates the file and fails with fs.ErrExist if it is already present.
func writeExclusive(path, text string) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o666)
	if err != nil {
		return err
	}
	_, err = file.WriteString(text)
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	return err
}

func readDirNames(path string) []string {
	entries, err := os.ReadDir(path)
	if err != nil {
		return nil
	}
	names := make([]string, len(entries))
	for i, entry := range entries {
		names[i] = entry.Name()
	}
	return names
}

func removeAll(path string) {
	_ = os.RemoveAll(path)
}

func isNotExist(err error) bool {
	return errors.Is(err, fs.ErrNotExist)
}

// trim matches JavaScript's String.prototype.trim for Git output.
func trim(s string) string {
	return strings.TrimSpace(s)
}

func splitLines(s string) []string {
	return strings.Split(s, "\n")
}

func nonEmpty(lines []string) []string {
	out := lines[:0:0]
	for _, line := range lines {
		if line != "" {
			out = append(out, line)
		}
	}
	return out
}

func errorf(format string, args ...any) error {
	return fmt.Errorf(format, args...)
}
