//! Bounded ICU syntax and valid-pattern usage, shared by compiler consumers.
//!
//! Rendering remains with Values/UI. Declaration/type hooks run at the original
//! parser checkpoints so syntax extraction does not reorder typed diagnostics.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum UsageKind {
    Plain,
    Number,
    Integer,
    Date,
    Time,
    Plural,
    Ordinal,
    Select,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct Usage {
    pub name: String,
    pub kind: UsageKind,
}

/// Malformed patterns return no partial usage to earlier coverage consumers.
pub(super) fn parse(template: &str) -> Result<Vec<Usage>, String> {
    parse_with_validation(template, |_| Ok(()), |_, _| Ok(()))
}

pub(super) fn static_caption_error(template: &str) -> Option<String> {
    parse_with_validation(
        template,
        |name| {
            Err(format!(
                "message pattern uses undeclared variable {{{name}}}"
            ))
        },
        |_, _| Ok(()),
    )
    .err()
}

pub(super) fn parse_with_validation(
    template: &str,
    declared: impl FnMut(&str) -> Result<(), String>,
    compatible: impl FnMut(&str, UsageKind) -> Result<(), String>,
) -> Result<Vec<Usage>, String> {
    let chars: Vec<char> = template.chars().collect();
    let mut parser = Parser {
        chars: &chars,
        pos: 0,
        usages: Vec::new(),
        declared,
        compatible,
    };
    parser.message(false, 0)?;
    Ok(parser.usages)
}

struct Parser<'t, D, C> {
    chars: &'t [char],
    pos: usize,
    usages: Vec<Usage>,
    declared: D,
    compatible: C,
}

impl<D, C> Parser<'_, D, C>
where
    D: FnMut(&str) -> Result<(), String>,
    C: FnMut(&str, UsageKind) -> Result<(), String>,
{
    fn message(&mut self, nested: bool, depth: usize) -> Result<(), String> {
        while let Some(&ch) = self.chars.get(self.pos) {
            match ch {
                '\'' => self.quote()?,
                '{' => self.argument(depth + 1)?,
                '}' if nested => return Ok(()),
                '}' => return Err("unmatched '}'".to_string()),
                '<' if self.rich_tag() => {
                    return Err("rich-text tags are outside the bounded profile".to_string());
                }
                // Pound is literal outside plural; its rendering context does
                // not affect syntax or argument usage inside a branch.
                _ => self.pos += 1,
            }
        }
        if nested {
            Err("unclosed '{'".to_string())
        } else {
            Ok(())
        }
    }

    fn quote(&mut self) -> Result<(), String> {
        let next = self.chars.get(self.pos + 1).copied();
        if next == Some('\'') {
            self.pos += 2;
            return Ok(());
        }
        if matches!(next, Some('{' | '}' | '#')) {
            self.pos += 1;
            while let Some(&ch) = self.chars.get(self.pos) {
                self.pos += 1;
                if ch == '\'' {
                    if self.chars.get(self.pos) == Some(&'\'') {
                        self.pos += 1;
                    } else {
                        return Ok(());
                    }
                }
            }
            return Err("unterminated quoted text".to_string());
        }
        self.pos += 1;
        Ok(())
    }

    fn argument(&mut self, depth: usize) -> Result<(), String> {
        // Count simple arguments too, before descending into any branches.
        if depth > 32 {
            return Err("message nesting is too deep".to_string());
        }
        self.pos += 1;
        self.skip_ws();
        let name = self.word(|ch| ch.is_ascii_alphanumeric() || ch == '_')?;
        (self.declared)(&name)?;
        self.skip_ws();
        if self.chars.get(self.pos) == Some(&'}') {
            self.pos += 1;
            return self.usage(name, UsageKind::Plain);
        }
        if self.chars.get(self.pos) != Some(&',') {
            return Err(format!("expected ',' or '}}' after '{{{name}'"));
        }
        self.pos += 1;
        self.skip_ws();
        let format = self.keyword()?;
        self.skip_ws();
        match format.as_str() {
            "number" => self.number_argument(name)?,
            "date" | "time" => self.date_argument(name, &format)?,
            "plural" | "selectordinal" | "select" => self.select_argument(name, &format, depth)?,
            other => return Err(format!("unsupported format '{other}'")),
        }
        Ok(())
    }

    fn number_argument(&mut self, name: String) -> Result<(), String> {
        let mut kind = UsageKind::Number;
        if self.chars.get(self.pos) == Some(&',') {
            self.pos += 1;
            self.skip_ws();
            let style = self.keyword()?;
            if style != "integer" {
                return Err(format!("unsupported number style '{style}'"));
            }
            kind = UsageKind::Integer;
            self.skip_ws();
        }
        self.usage(name.clone(), kind)?;
        self.close(&name)?;
        Ok(())
    }

    fn date_argument(&mut self, name: String, format: &str) -> Result<(), String> {
        let kind = if format == "date" {
            UsageKind::Date
        } else {
            UsageKind::Time
        };
        self.usage(name.clone(), kind)?;
        if self.chars.get(self.pos) == Some(&',') {
            self.pos += 1;
            self.skip_ws();
            let style = self.keyword()?;
            if !matches!(style.as_str(), "short" | "medium" | "long" | "full") {
                return Err(format!("unsupported {format} style '{style}'"));
            }
            self.skip_ws();
        }
        self.close(&name)?;
        Ok(())
    }

    fn select_argument(&mut self, name: String, format: &str, depth: usize) -> Result<(), String> {
        let kind = match format {
            "plural" => UsageKind::Plural,
            "selectordinal" => UsageKind::Ordinal,
            _ => UsageKind::Select,
        };
        self.usage(name.clone(), kind)?;
        if self.chars.get(self.pos) != Some(&',') {
            return Err(format!("{format} '{{{name}' needs branches"));
        }
        self.pos += 1;
        self.options(&name, format != "select", depth)?;
        self.close(&name)?;
        Ok(())
    }

    fn usage(&mut self, name: String, kind: UsageKind) -> Result<(), String> {
        (self.compatible)(&name, kind)?;
        self.usages.push(Usage { name, kind });
        Ok(())
    }

    fn options(&mut self, name: &str, plural: bool, depth: usize) -> Result<(), String> {
        let mut seen = Vec::new();
        loop {
            self.skip_ws();
            let Some(&ch) = self.chars.get(self.pos) else {
                return Err(format!("unclosed '{{{name}'"));
            };
            if ch == '}' {
                break;
            }
            let key = if plural && ch == '=' {
                self.pos += 1;
                self.exact_key()?
            } else if plural {
                let word = self.word(|ch| ch.is_ascii_alphabetic())?;
                if word == "offset" {
                    return Err("plural offsets are not supported".to_string());
                }
                if !matches!(
                    word.as_str(),
                    "zero" | "one" | "two" | "few" | "many" | "other"
                ) {
                    return Err(format!("unknown plural selector '{word}'"));
                }
                word
            } else {
                self.word(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')?
            };
            if seen.contains(&key) {
                return Err(format!("duplicate '{key}' branch"));
            }
            seen.push(key);
            self.skip_ws();
            if self.chars.get(self.pos) != Some(&'{') {
                return Err("expected '{' to open the branch".to_string());
            }
            self.pos += 1;
            self.message(true, depth)?;
            self.pos += 1;
        }
        if !seen.iter().any(|key| key == "other") {
            return Err("plural and select need an 'other' branch".to_string());
        }
        Ok(())
    }

    fn exact_key(&mut self) -> Result<String, String> {
        let start = self.pos;
        while self.chars.get(self.pos).is_some_and(char::is_ascii_digit) {
            self.pos += 1;
        }
        if self.pos == start {
            return Err("expected a number after '='".to_string());
        }
        let integer: String = self.chars[start..self.pos].iter().collect();
        let mut fraction = String::new();
        if self.chars.get(self.pos) == Some(&'.') {
            self.pos += 1;
            let fractional_start = self.pos;
            while self.chars.get(self.pos).is_some_and(char::is_ascii_digit) {
                self.pos += 1;
            }
            if self.pos == fractional_start {
                return Err("expected digits after '.' in an exact plural selector".to_string());
            }
            fraction = self.chars[fractional_start..self.pos].iter().collect();
        }
        // Canonical decimal text preserves arbitrarily large exact selectors
        // without introducing a floating-point or bounded-integer conversion.
        let integer = integer.trim_start_matches('0');
        let integer = if integer.is_empty() { "0" } else { integer };
        let fraction = fraction.trim_end_matches('0');
        Ok(if fraction.is_empty() {
            format!("={integer}")
        } else {
            format!("={integer}.{fraction}")
        })
    }

    fn keyword(&mut self) -> Result<String, String> {
        let first = self.chars.get(self.pos).copied().unwrap_or('\0');
        if !(first.is_ascii_alphabetic() || first == '_') {
            return Err("expected an argument name".to_string());
        }
        self.word(|ch| ch.is_ascii_alphanumeric() || ch == '_')
    }

    fn word(&mut self, accepts: impl Fn(char) -> bool) -> Result<String, String> {
        let start = self.pos;
        while self.chars.get(self.pos).copied().is_some_and(&accepts) {
            self.pos += 1;
        }
        if self.pos == start {
            return Err("expected an argument name".to_string());
        }
        Ok(self.chars[start..self.pos].iter().collect())
    }

    fn skip_ws(&mut self) {
        while self.chars.get(self.pos).copied().is_some_and(is_whitespace) {
            self.pos += 1;
        }
    }

    fn close(&mut self, name: &str) -> Result<(), String> {
        if self.chars.get(self.pos) == Some(&'}') {
            self.pos += 1;
            Ok(())
        } else {
            Err(format!("unclosed '{{{name}'"))
        }
    }

    /// Values' finite tag recognizer:
    /// `^</?[A-Za-z][A-Za-z0-9_.:-]*(\s+[^<>]*)?/?>`.
    fn rich_tag(&self) -> bool {
        let mut i = self.pos + 1;
        if self.chars.get(i) == Some(&'/') {
            i += 1;
        }
        if !self.chars.get(i).is_some_and(char::is_ascii_alphabetic) {
            return false;
        }
        i += 1;
        while self
            .chars
            .get(i)
            .is_some_and(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | ':' | '-'))
        {
            i += 1;
        }
        if self.chars.get(i).copied().is_some_and(is_whitespace) {
            while let Some(&ch) = self.chars.get(i) {
                match ch {
                    '>' => return true,
                    '<' => return false,
                    _ => i += 1,
                }
            }
            return false;
        }
        if self.chars.get(i) == Some(&'/') {
            i += 1;
        }
        self.chars.get(i) == Some(&'>')
    }
}

fn is_whitespace(ch: char) -> bool {
    matches!(ch, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
        | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

#[cfg(test)]
mod tests {
    use super::{UsageKind, parse};
    use serde::Deserialize;
    use serde_json::value::RawValue;

    #[test]
    fn shared_profile_corpus_in_the_compiler_string_domain() {
        #[derive(Deserialize)]
        struct Case {
            id: String,
            pattern: Box<RawValue>,
        }
        #[derive(Deserialize)]
        struct Corpus {
            accepted: Vec<Case>,
            refused: Vec<Case>,
        }
        let corpus: Corpus = serde_json::from_str(include_str!(
            "../../../packages/values/test/fixtures/icu-profile.json"
        ))
        .unwrap();
        let mut scalar_cases = 0;
        let mut outside_domain = Vec::new();
        for (cases, accepted) in [(corpus.accepted, true), (corpus.refused, false)] {
            for case in cases {
                if case.id == "lone-surrogates" {
                    // Authored compiler strings are Unicode scalar strings;
                    // do not silently replace TS's raw UTF16-domain witness.
                    outside_domain.push(case.id);
                    continue;
                }
                let pattern: String = serde_json::from_str(case.pattern.get()).unwrap();
                let result = parse(&pattern);
                assert_eq!(result.is_ok(), accepted, "{}: {result:?}", case.id);
                scalar_cases += 1;
            }
        }
        assert_eq!(scalar_cases, 63);
        assert_eq!(outside_domain, ["lone-surrogates"]);
    }

    #[test]
    fn usages_retain_source_order_kinds_and_every_branch() {
        let usages = parse("Don't { n , plural , one{{s,select,a{{d,date}} other{{t,time}}}} other{{n,number,integer}{x}}}").unwrap();
        let actual: Vec<_> = usages
            .iter()
            .map(|usage| (usage.name.as_str(), usage.kind))
            .collect();
        assert_eq!(
            actual,
            [
                ("n", UsageKind::Plural),
                ("s", UsageKind::Select),
                ("d", UsageKind::Date),
                ("t", UsageKind::Time),
                ("n", UsageKind::Integer),
                ("x", UsageKind::Plain),
            ]
        );
    }
}
