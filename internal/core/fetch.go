package core

import (
	"regexp"
	"slices"
	"strconv"
	"strings"
)

var supportedFetchOption = regexp.MustCompile(`^(--quiet|-q|--verbose|-v|--progress|--no-progress|--no-tags|--tags|--force|-f|--prune|--no-prune|--prune-tags|--no-prune-tags|--no-recurse-submodules|--recurse-submodules=no|--no-auto-maintenance|--no-auto-gc|--atomic|--append|-a|--no-write-fetch-head|--write-fetch-head|--show-forced-updates|--no-show-forced-updates|--update-head-ok|--refetch|--negotiation-tip=.+|--refmap=.*|--jobs=.+)$`)

var fetchValueOption = regexp.MustCompile(`^(--negotiation-tip|--refmap|--jobs|-j)$`)

// withConfig appends Git configuration to an environment through GIT_CONFIG_COUNT, which keeps values such
// as credentials out of command lines.
func withConfig(env []string, settings [][2]string) []string {
	count, _ := strconv.Atoi(lookupEnv(env, "GIT_CONFIG_COUNT"))
	var pairs []string
	for _, setting := range settings {
		pairs = append(pairs,
			"GIT_CONFIG_KEY_"+strconv.Itoa(count), setting[0],
			"GIT_CONFIG_VALUE_"+strconv.Itoa(count), setting[1])
		count++
	}
	pairs = append(pairs, "GIT_CONFIG_COUNT", strconv.Itoa(count))
	return withEnv(env, pairs...)
}

// configSetting splits a `-c` value; a key without `=` means true, as in Git.
func configSetting(setting string) [2]string {
	key, value, found := strings.Cut(setting, "=")
	if !found {
		value = "true"
	}
	return [2]string{key, value}
}

// fetchCheckout fetches through the pool while native Git maintains refspecs and FETCH_HEAD. handled is
// false when the caller should forward the command to Git.
func (c *Client) fetchCheckout(args []string) (code int, handled bool, err error) {
	full, ok := fullHistoryArgs(args, true)
	if !ok {
		c.fallback(args, "fetch history window, filter, or missing option value is not supported")
		return 0, false, nil
	}
	var operands []string
	for i := 0; i < len(full); i++ {
		arg := full[i]
		if arg == "--" {
			operands = append(operands, full[i+1:]...)
			break
		}
		if fetchValueOption.MatchString(arg) {
			i++
			continue
		}
		if strings.HasPrefix(arg, "-") {
			if !supportedFetchOption.MatchString(arg) {
				c.fallback(args, "fetch option "+optionName(arg)+" is not supported")
				return 0, false, nil
			}
		} else {
			operands = append(operands, arg)
		}
	}
	capture := func(args ...string) gitResult {
		result, _ := c.git(args, "", captured, nil)
		return result
	}
	remote := "origin"
	if len(operands) > 0 {
		remote = operands[0]
	} else if head := capture("symbolic-ref", "--quiet", "--short", "HEAD"); head.code == 0 {
		if configured := trim(capture("config", "--get", "branch."+trim(head.stdout)+".remote").stdout); configured != "" {
			remote = configured
		}
	}
	url := remote
	if result := capture("remote", "get-url", remote); result.code == 0 {
		url = trim(result.stdout)
	}
	key := c.remoteKey(url, "")
	if key == "" {
		c.fallback(args, "fetch remote is not a supported network URL")
		return 0, false, nil
	}
	if format := capture("rev-parse", "--show-object-format"); format.code != 0 || trim(format.stdout) != "sha1" {
		c.fallback(args, "fetch requires a SHA-1 repository")
		return 0, false, nil
	}
	commonGitdir, err := c.repoCommonGitdir(c.cwd)
	if err != nil {
		return 0, true, err
	}
	gitdir, err := c.repoGitdir(c.cwd)
	if err != nil {
		return 0, true, err
	}
	shallowOutput, err := c.checked([]string{"rev-parse", "--is-shallow-repository"}, "")
	if err != nil {
		return 0, true, err
	}
	shallow := shallowOutput == "true"
	quiet := slices.Contains(args, "-q") || slices.Contains(args, "--quiet")
	progress := !quiet && (c.stderrIsTerminal() || slices.Contains(args, "--progress"))
	// Actions keeps authentication in checkout-local HTTP configuration.
	// Pass it to the pool's network call through the environment, never command text.
	var settings [][2]string
	for _, entry := range strings.Split(capture("config", "--null", "--get-regexp", `^(http\.|credential\.)`).stdout, "\x00") {
		if entry == "" {
			continue
		}
		key, value, found := strings.Cut(entry, "\n")
		if !found {
			value = "true"
		}
		settings = append(settings, [2]string{key, value})
	}
	network := *c
	network.env = withConfig(c.env, settings)
	root := c.StorePath()
	err = c.withLock(root, func() error {
		poolReused := isPresent(poolPath(root))
		if poolReused && !quiet {
			c.warn("git-dedup: reused object pool\n")
		}
		pool, fetchErr := network.fetchRemote(root, url, key, progress, quiet)
		if fetchErr != nil {
			c.fallback(args, "object pool unavailable"+gitFailure(fetchErr))
			return nil
		}
		handled = true
		// Register before exposing the alternate. Holding the lock prevents prune
		// between borrowing objects and pinning both refs and FETCH_HEAD.
		id, err := consumerID(root, commonGitdir)
		if err != nil {
			return err
		}
		if err := registerConsumer(root, id, commonGitdir); err != nil {
			return err
		}
		if err := setAlternate(commonGitdir, pool); err != nil {
			return err
		}
		fetchArgs := []string{"fetch"}
		if shallow {
			fetchArgs = append(fetchArgs, "--unshallow")
		}
		result, err := c.git(append(fetchArgs, full...), "", inherited, nil)
		if err != nil {
			return err
		}
		code = result.code
		tips, err := c.consumerTips(c.cwd)
		if err != nil {
			return err
		}
		if err := c.pinConsumer(pool, c.cwd, commonGitdir, append(tips, stateOids(gitdir)...)); err != nil {
			return err
		}
		if result.code == 0 {
			c.emitStorageReport(StorageReport{Operation: "fetch", Repository: c.cwd, PoolReused: poolReused})
		}
		return nil
	})
	if err != nil {
		return 0, true, err
	}
	return code, handled, nil
}
