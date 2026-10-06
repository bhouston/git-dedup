// Command git-dedup wraps Git and shares one copy of Git history across clones, worktrees, and submodules.
package main

import (
	"os"

	"github.com/bhouston/git-dedup/internal/cli"
)

// version is set at build time with -ldflags "-X main.version=<version>".
var version = "0.0.0-dev"

func main() {
	os.Exit(cli.Main(os.Args[1:], version))
}
