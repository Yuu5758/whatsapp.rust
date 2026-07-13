/// Parse the unread count from a WhatsApp Web document title like "(3) WhatsApp".
/// Returns 0 when there is no leading "(n)" group.
pub fn parse_unread(title: &str) -> u32 {
    let t = title.trim_start();
    let Some(rest) = t.strip_prefix('(') else {
        return 0;
    };
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::parse_unread;

    #[test]
    fn no_parentheses_is_zero() {
        assert_eq!(parse_unread("WhatsApp"), 0);
    }

    #[test]
    fn simple_count() {
        assert_eq!(parse_unread("(3) WhatsApp"), 3);
    }

    #[test]
    fn leading_whitespace_ok() {
        assert_eq!(parse_unread("  (12) WhatsApp"), 12);
    }

    #[test]
    fn plus_suffix_takes_digits() {
        assert_eq!(parse_unread("(99+) WhatsApp"), 99);
    }

    #[test]
    fn zero_count() {
        assert_eq!(parse_unread("(0) WhatsApp"), 0);
    }

    #[test]
    fn malformed_is_zero() {
        assert_eq!(parse_unread("(abc) WhatsApp"), 0);
        assert_eq!(parse_unread(""), 0);
        assert_eq!(parse_unread("()"), 0);
    }
}
