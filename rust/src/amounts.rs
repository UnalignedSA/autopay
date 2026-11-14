//! Decimal strings to integer base units (wei, lamports, satoshis...), exactly.
//!
//! Crypto amounts never go through a float: "50.00" stays text until it becomes an integer.

use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum AmountError {
    #[error("not a plain decimal amount: \"{0}\"")]
    NotDecimal(String),
    #[error("\"{amount}\" has more than {decimals} decimals")]
    TooManyDecimals { amount: String, decimals: u32 },
    #[error("\"{0}\" is too large for this chain")]
    TooLarge(String),
}

/// Turns a decimal string such as "50.00" into integer base units. Pure integer arithmetic.
pub fn to_base_units(amount: &str, decimals: u32) -> Result<u128, AmountError> {
    let (whole, fraction) = amount.split_once('.').unwrap_or((amount, ""));
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !digits(whole) || (amount.contains('.') && !digits(fraction)) {
        return Err(AmountError::NotDecimal(amount.into()));
    }
    let padding = (decimals as usize)
        .checked_sub(fraction.len())
        .ok_or_else(|| AmountError::TooManyDecimals {
            amount: amount.into(),
            decimals,
        })?;

    // The digits of "12.5" at 3 decimals are those of "12500".
    let mut all = whole
        .bytes()
        .chain(fraction.bytes())
        .chain(std::iter::repeat_n(b'0', padding));
    all.try_fold(0u128, |units, digit| {
        units.checked_mul(10)?.checked_add(u128::from(digit - b'0'))
    })
    .ok_or_else(|| AmountError::TooLarge(amount.into()))
}

/// Like [`to_base_units`], for chains whose amounts are 64-bit (Solana, Monero). Refuses what does not fit
/// instead of cutting it short.
pub fn to_base_units_u64(amount: &str, decimals: u32) -> Result<u64, AmountError> {
    u64::try_from(to_base_units(amount, decimals)?).map_err(|_| AmountError::TooLarge(amount.into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_decimal_strings_to_integer_base_units() {
        assert_eq!(to_base_units("50.00", 18), Ok(50_000_000_000_000_000_000));
        assert_eq!(to_base_units("0.00012345", 8), Ok(12345));
        assert_eq!(to_base_units("1", 6), Ok(1_000_000));
    }

    #[test]
    fn rejects_more_decimals_than_the_token_has() {
        assert!(matches!(
            to_base_units("1.1234567", 6),
            Err(AmountError::TooManyDecimals { .. })
        ));
    }

    #[test]
    fn rejects_anything_that_is_not_a_plain_decimal() {
        for bad in ["1e3", "-1", "abc", "", ".5", "1.", " 1", "1 ", "+1", "1.2.3"] {
            assert!(
                matches!(to_base_units(bad, 6), Err(AmountError::NotDecimal(_))),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn rejects_what_does_not_fit_instead_of_wrapping() {
        let huge = "9".repeat(40);
        assert!(matches!(to_base_units(&huge, 0), Err(AmountError::TooLarge(_))));
        assert_eq!(to_base_units_u64("18446744073.709551615", 9), Ok(u64::MAX));
        assert!(matches!(
            to_base_units_u64("18446744073.709551616", 9),
            Err(AmountError::TooLarge(_))
        ));
    }
}
