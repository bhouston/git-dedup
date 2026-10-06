package cli

import (
	"math/big"
	"strings"
)

var siUnits = []struct {
	prefix   string
	exponent int
}{{"Y", 24}, {"Z", 21}, {"E", 18}, {"P", 15}, {"T", 12}, {"G", 9}, {"M", 6}, {"k", 3}, {"", 0}}

// humanizeBytes formats like humanize-units' humanizeBytes: SI prefixes, at most three significant
// digits, and no separator, such as `0B`, `1.23kB`, or `1000kB`.
func humanizeBytes(bytes int64) string {
	abs := bytes
	if abs < 0 {
		abs = -abs
	}
	if abs == 0 {
		abs = 1
	}
	unit := siUnits[len(siUnits)-1]
	for _, candidate := range siUnits {
		if new(big.Int).SetInt64(abs).Cmp(pow10(candidate.exponent)) >= 0 {
			unit = candidate
			break
		}
	}
	value := new(big.Rat).SetFrac(big.NewInt(bytes), pow10(unit.exponent))
	return significant(value, 3) + unit.prefix + "B"
}

func pow10(exponent int) *big.Int {
	return new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(exponent)), nil)
}

// significant rounds half away from zero to at most digits significant digits, without trailing zeros.
func significant(value *big.Rat, digits int) string {
	if value.Sign() == 0 {
		return "0"
	}
	negative := value.Sign() < 0
	abs := new(big.Rat).Abs(value)
	integerDigits := len(new(big.Int).Quo(abs.Num(), abs.Denom()).String())
	if new(big.Int).Quo(abs.Num(), abs.Denom()).Sign() == 0 {
		integerDigits = 0
	}
	decimals := max(0, digits-integerDigits)
	scaled := new(big.Rat).Mul(abs, new(big.Rat).SetInt(pow10(decimals)))
	// Round half away from zero: floor(scaled + 1/2).
	scaled.Add(scaled, big.NewRat(1, 2))
	rounded := new(big.Int).Quo(scaled.Num(), scaled.Denom())
	text := rounded.String()
	if decimals > 0 {
		text = strings.Repeat("0", max(0, decimals+1-len(text))) + text
		text = text[:len(text)-decimals] + "." + text[len(text)-decimals:]
		text = strings.TrimRight(strings.TrimRight(text, "0"), ".")
	}
	if negative {
		text = "-" + text
	}
	return text
}
