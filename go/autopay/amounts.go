package autopay

import (
	"fmt"
	"math/big"
	"regexp"
	"strings"
)

var plainDecimal = regexp.MustCompile(`^(\d+)(?:\.(\d+))?$`)

// ToBaseUnits turns a decimal string such as "50.00" into integer base units (wei, lamports, satoshis...).
// It is pure integer arithmetic: crypto amounts never go through a float.
func ToBaseUnits(amount string, decimals int) (*big.Int, error) {
	match := plainDecimal.FindStringSubmatch(amount)
	if match == nil {
		return nil, fmt.Errorf("not a plain decimal amount: %q", amount)
	}
	whole, fraction := match[1], match[2]
	if len(fraction) > decimals {
		return nil, fmt.Errorf("%q has more than %d decimals", amount, decimals)
	}
	digits := whole + fraction + strings.Repeat("0", decimals-len(fraction))
	units, _ := new(big.Int).SetString(digits, 10)
	return units, nil
}
