//! UTF-8-safe line editing shared by the TUI search and filter inputs.

pub fn move_left(text: &str, cursor: usize) -> usize {
    text[..cursor.min(text.len())]
        .char_indices()
        .last()
        .map_or(0, |(i, _)| i)
}

pub fn move_right(text: &str, cursor: usize) -> usize {
    let cursor = cursor.min(text.len());
    cursor + text[cursor..].chars().next().map_or(0, char::len_utf8)
}

pub fn word_left(text: &str, cursor: usize) -> usize {
    let mut i = cursor.min(text.len());
    while i > 0 {
        let p = move_left(text, i);
        if !text[p..i].chars().all(char::is_whitespace) {
            break;
        }
        i = p;
    }
    while i > 0 {
        let p = move_left(text, i);
        if text[p..i].chars().all(char::is_whitespace) {
            break;
        }
        i = p;
    }
    i
}

pub fn word_right(text: &str, cursor: usize) -> usize {
    let mut i = cursor.min(text.len());
    while i < text.len() {
        let n = move_right(text, i);
        if !text[i..n].chars().all(char::is_whitespace) {
            break;
        }
        i = n;
    }
    while i < text.len() {
        let n = move_right(text, i);
        if text[i..n].chars().all(char::is_whitespace) {
            break;
        }
        i = n;
    }
    i
}

pub fn insert(text: &mut String, cursor: &mut usize, value: &str) {
    let value: String = value
        .chars()
        .filter(|c| !matches!(c, '\r' | '\n' | '\0'))
        .collect();
    text.insert_str(*cursor, &value);
    *cursor += value.len();
}

pub fn backspace(text: &mut String, cursor: &mut usize) {
    if *cursor > 0 {
        let p = move_left(text, *cursor);
        text.drain(p..*cursor);
        *cursor = p;
    }
}

pub fn delete(text: &mut String, cursor: usize) {
    if cursor < text.len() {
        let n = move_right(text, cursor);
        text.drain(cursor..n);
    }
}

pub fn delete_range(text: &mut String, cursor: &mut usize, start: usize, end: usize) {
    let start = start.min(text.len());
    let end = end.min(text.len());
    if start < end {
        text.drain(start..end);
    }
    *cursor = start;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edits_unicode_and_words_at_character_boundaries() {
        let mut s = "merhaba dünya!".to_string();
        let mut c = s.len();
        backspace(&mut s, &mut c);
        assert_eq!((&s[..], c), ("merhaba dünya", "merhaba dünya".len()));
        c = word_left(&s, c);
        assert_eq!(c, "merhaba ".len());
        let start = c;
        delete_range(&mut s, &mut c, start, "merhaba dünya".len());
        assert_eq!(s, "merhaba ");
        insert(&mut s, &mut c, "🚀\nsonraki");
        assert_eq!(s, "merhaba 🚀sonraki");
    }
}
