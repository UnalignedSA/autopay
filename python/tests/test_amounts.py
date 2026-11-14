import pytest

from autopay.amounts import AmountError, to_base_units


def test_converts_decimal_strings_to_integer_base_units() -> None:
    assert to_base_units("50.00", 18) == 50000000000000000000
    assert to_base_units("0.00012345", 8) == 12345
    assert to_base_units("1", 6) == 1000000


def test_rejects_more_decimals_than_the_token_has() -> None:
    with pytest.raises(AmountError):
        to_base_units("1.1234567", 6)


@pytest.mark.parametrize("bad", ["1e3", "-1", "abc", "", ".5", "1.", "1\n", "١٢"])
def test_rejects_anything_that_is_not_a_plain_decimal(bad: str) -> None:
    with pytest.raises(AmountError):
        to_base_units(bad, 6)
