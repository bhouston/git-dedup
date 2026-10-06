//go:build !windows

package core

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/unix"
)

func realpath(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", err
	}
	// EvalSymlinks does not report a dangling final component; realpath(3) does.
	if _, err := os.Stat(resolved); err != nil {
		return "", err
	}
	return resolved, nil
}

// Realpath resolves symbolic links like Node's fs.realpath.
func Realpath(path string) (string, error) { return realpath(path) }

func isExecutable(path string) bool {
	return unix.Access(path, unix.X_OK) == nil
}

// fileIdentity returns the hard link count and a value that changes when the path is replaced.
func fileIdentity(path string) (nlink uint64, id uint64, ok bool) {
	info, err := os.Stat(path)
	if err != nil {
		return 0, 0, false
	}
	stat, isStat := info.Sys().(*syscall.Stat_t)
	if !isStat {
		return 1, 0, true
	}
	return uint64(stat.Nlink), uint64(stat.Ino), true
}

func processExists(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

func notDirectoryErrno(err error) bool {
	return errors.Is(err, syscall.ENOTDIR)
}
