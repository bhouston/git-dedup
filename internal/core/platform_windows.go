//go:build windows

package core

import (
	"errors"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

func openForQuery(path string) (windows.Handle, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return windows.InvalidHandle, err
	}
	// Backup semantics opens directories too; no access rights are needed to query names and indexes.
	return windows.CreateFile(name, 0,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
}

// realpath resolves like Node's fs.realpath (libuv): the final path of an open handle, which also
// expands 8.3 short names and normalizes case.
func realpath(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	handle, err := openForQuery(abs)
	if err != nil {
		return "", &os.PathError{Op: "realpath", Path: path, Err: err}
	}
	defer windows.CloseHandle(handle)
	buf := make([]uint16, windows.MAX_PATH)
	for {
		n, err := windows.GetFinalPathNameByHandle(handle, &buf[0], uint32(len(buf)), 0 /* VOLUME_NAME_DOS */)
		if err != nil {
			return "", &os.PathError{Op: "realpath", Path: path, Err: err}
		}
		if int(n) < len(buf) {
			buf = buf[:n]
			break
		}
		buf = make([]uint16, n)
	}
	result := windows.UTF16ToString(buf)
	if strings.HasPrefix(result, `\\?\UNC\`) {
		return `\\` + result[len(`\\?\UNC\`):], nil
	}
	return strings.TrimPrefix(result, `\\?\`), nil
}

// Realpath resolves symbolic links like Node's fs.realpath.
func Realpath(path string) (string, error) { return realpath(path) }

func isExecutable(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

// fileIdentity returns the hard link count and a value that changes when the path is replaced.
func fileIdentity(path string) (nlink uint64, id uint64, ok bool) {
	handle, err := openForQuery(path)
	if err != nil {
		return 0, 0, false
	}
	defer windows.CloseHandle(handle)
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
		return 0, 0, false
	}
	return uint64(info.NumberOfLinks), uint64(info.FileIndexHigh)<<32 | uint64(info.FileIndexLow), true
}

const stillActive = 259

func processExists(pid int) bool {
	if pid <= 0 {
		return false
	}
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return errors.Is(err, windows.ERROR_ACCESS_DENIED)
	}
	defer windows.CloseHandle(handle)
	var code uint32
	if err := windows.GetExitCodeProcess(handle, &code); err != nil {
		return true
	}
	return code == stillActive
}

func notDirectoryErrno(err error) bool {
	return errors.Is(err, windows.ERROR_DIRECTORY)
}
