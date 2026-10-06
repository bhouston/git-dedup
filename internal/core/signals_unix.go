//go:build !windows

package core

import (
	"errors"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
)

// runForwardingSignals runs the command and returns its exit code. With forward, interrupt, termination,
// and hangup signals pass to Git instead of stopping git-dedup first.
func runForwardingSignals(command *exec.Cmd, forward bool) (int, error) {
	if err := command.Start(); err != nil {
		return 0, err
	}
	if forward {
		signals := make(chan os.Signal, 4)
		signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
		done := make(chan struct{})
		defer func() {
			signal.Stop(signals)
			close(done)
		}()
		go func() {
			for {
				select {
				case received := <-signals:
					_ = command.Process.Signal(received)
				case <-done:
					return
				}
			}
		}()
	}
	return exitCode(command.Wait())
}

func exitCode(err error) (int, error) {
	if err == nil {
		return 0, nil
	}
	var exit *exec.ExitError
	if !errors.As(err, &exit) {
		return 0, err
	}
	if status, ok := exit.Sys().(syscall.WaitStatus); ok && status.Signaled() {
		return 128 + int(status.Signal()), nil
	}
	if code := exit.ExitCode(); code >= 0 {
		return code, nil
	}
	return 1, nil
}
