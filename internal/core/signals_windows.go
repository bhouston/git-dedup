//go:build windows

package core

import (
	"errors"
	"os"
	"os/exec"
	"os/signal"
)

// runForwardingSignals runs the command and returns its exit code. With forward, git-dedup outlives a
// console Ctrl+C, which Windows delivers to Git directly, so Git decides how to stop and its code is kept.
func runForwardingSignals(command *exec.Cmd, forward bool) (int, error) {
	if forward {
		signals := make(chan os.Signal, 1)
		signal.Notify(signals, os.Interrupt)
		defer signal.Stop(signals)
	}
	if err := command.Start(); err != nil {
		return 0, err
	}
	err := command.Wait()
	if err == nil {
		return 0, nil
	}
	var exit *exec.ExitError
	if !errors.As(err, &exit) {
		return 0, err
	}
	return exit.ExitCode(), nil
}
