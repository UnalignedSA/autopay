import re

_PLAIN_DECIMAL = re.compile(r"([0-9]+)(?:\.([0-9]+))?")


class AmountError(ValueError):
    """The amount is not a plain decimal string, or has too many decimals."""


def to_base_units(amount: str, decimals: int) -> int:
    """Turns a decimal string such as "50.00" into integer base units (wei, lamports, satoshis...).

    Pure integer arithmetic: crypto amounts never go through a float.
    """
    match = _PLAIN_DECIMAL.fullmatch(amount)
    if match is None:
        raise AmountError(f'not a plain decimal amount: "{amount}"')
    whole, fraction = match.group(1), match.group(2) or ""
    if len(fraction) > decimals:
        raise AmountError(f'"{amount}" has more than {decimals} decimals')
    return int(whole + fraction.ljust(decimals, "0"))
