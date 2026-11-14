package autopay

import (
	"math/big"
	"testing"
)

func TestToBaseUnits(t *testing.T) {
	cases := []struct {
		amount   string
		decimals int
		want     string
	}{
		{"50.00", 18, "50000000000000000000"},
		{"0.00012345", 8, "12345"},
		{"1", 6, "1000000"},
	}
	for _, c := range cases {
		got, err := ToBaseUnits(c.amount, c.decimals)
		if err != nil {
			t.Fatalf("ToBaseUnits(%q, %d): %v", c.amount, c.decimals, err)
		}
		want, _ := new(big.Int).SetString(c.want, 10)
		if got.Cmp(want) != 0 {
			t.Errorf("ToBaseUnits(%q, %d) = %s, want %s", c.amount, c.decimals, got, want)
		}
	}
}

func TestToBaseUnitsRejectsTooManyDecimals(t *testing.T) {
	if _, err := ToBaseUnits("1.1234567", 6); err == nil {
		t.Fatal("expected an error")
	}
}

func TestToBaseUnitsRejectsAnythingNotPlainDecimal(t *testing.T) {
	for _, bad := range []string{"1e3", "-1", "abc", "", ".5", "1.", "1\n", " 1"} {
		if _, err := ToBaseUnits(bad, 6); err == nil {
			t.Errorf("ToBaseUnits(%q) should fail", bad)
		}
	}
}
