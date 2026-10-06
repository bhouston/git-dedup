package core

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

// A holder touches its heartbeat file; a waiter that sees the lock unchanged this long treats it as abandoned.
const lockStale = 60 * time.Second

// lockBusy reports whether a failed mkdir means another process holds the lock. Windows reports access
// denied while a removed lock directory is still pending deletion.
func lockBusy(err error) bool {
	return errors.Is(err, fs.ErrExist) || (isWindows && errors.Is(err, fs.ErrPermission))
}

func (c *Client) lockDirectory(lock string, action func() error) error {
	if err := os.MkdirAll(filepath.Dir(lock), 0o777); err != nil {
		return err
	}
	seen := ""
	var seenSince time.Time
	for attempts := 0; ; attempts++ {
		err := os.Mkdir(lock, 0o777)
		if err == nil {
			break
		}
		if !lockBusy(err) {
			return err
		}
		state := inspectLock(lock)
		if attempts == 20 {
			owner := "unknown"
			if state.owner != 0 {
				owner = strconv.Itoa(state.owner)
			}
			c.warn(fmt.Sprintf("git-dedup: waiting for the object pool lock %s (owner pid %s)\n", lock, owner))
		}
		// Go's monotonic clock pauses during sleep, so a holder suspended with the machine is not mistaken for a hung one.
		if state.key != seen {
			seen, seenSince = state.key, time.Now()
		}
		// A dead owner may be reaped. A live but slow Git process must never lose its lock: it keeps its
		// heartbeat fresh. A lock from a version without a heartbeat still waits on a live owner.
		dead := state.owner > 0 && !processExists(state.owner) && state.age > 5*time.Second
		silent := (state.owner == 0 || state.heartbeat) && time.Since(seenSince) > lockStale
		if dead || silent {
			if err := reapLock(lock, state.key); err != nil {
				return err
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	heartbeat := filepath.Join(lock, "heartbeat")
	stop := make(chan struct{})
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		ticker := time.NewTicker(lockStale / 6)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				now := time.Now()
				_ = os.Chtimes(heartbeat, now, now)
			case <-stop:
				return
			}
		}
	}()
	defer func() {
		close(stop)
		<-stopped
		removeAll(lock)
	}()
	if err := writeText(filepath.Join(lock, "owner"), strconv.Itoa(os.Getpid())+"\n"); err != nil {
		return err
	}
	if err := writeText(heartbeat, ""); err != nil {
		return err
	}
	return action()
}

type lockState struct {
	key       string
	owner     int
	heartbeat bool
	age       time.Duration
}

func inspectLock(lock string) lockState {
	describe := func(path string) (string, *time.Time) {
		info, err := os.Stat(path)
		if err != nil {
			return "-", nil
		}
		_, id, _ := fileIdentity(path)
		modified := info.ModTime()
		return fmt.Sprintf("%d/%d", id, modified.UnixNano()), &modified
	}
	dir, modified := describe(lock)
	owner := readTextOr(filepath.Join(lock, "owner"), "")
	beat, beatTime := describe(filepath.Join(lock, "heartbeat"))
	state := lockState{key: dir + ":" + owner + ":" + beat, heartbeat: beatTime != nil}
	state.owner, _ = strconv.Atoi(trim(owner))
	if modified != nil {
		state.age = time.Since(*modified)
	}
	return state
}

// reapLock removes the lock only if it is still the one the caller judged stale, one reaper at a time.
func reapLock(lock, key string) error {
	guard := lock + ".reap"
	if err := os.Mkdir(guard, 0o777); err != nil {
		if !lockBusy(err) {
			return err
		}
		// ponytail: a reaper killed mid-reap strands its guard, and two waiters clearing that stranded guard can
		// still race. That needs a crash inside a millisecond window first; give the guard an owner if it ever bites.
		if info, err := os.Stat(guard); err == nil && time.Since(info.ModTime()) > lockStale {
			removeAll(guard)
		}
		return nil
	}
	defer removeAll(guard)
	if inspectLock(lock).key != key {
		return nil
	}
	tombstone := lock + "." + randomUUID() + ".reaped"
	_ = os.Rename(lock, tombstone)
	removeAll(tombstone)
	return nil
}

func storeLock(root string) string {
	return filepath.Join(filepath.Dir(root), "."+filepath.Base(root)+".gitx-lock")
}
