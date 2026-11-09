//! Turning a sorted member order into the minimal text edits that reorder the
//! type body in place, preserving each member's leading trivia and separators.

use super::{groups_differ, EditPosition, EditRange, MemberInfo, SortConfig, TextEdit};

/// Build text edits that reorder the members.
///
/// Strategy: replace the entire body content with the reordered members.
/// Inserts blank lines between accessibility/category groups.
pub(super) fn build_edits(
    members: &[MemberInfo],
    sorted_indices: &[usize],
    source: &str,
    config: &SortConfig,
) -> Vec<TextEdit> {
    // The replacement starts at the first member's leading trivia, so the edit
    // covers its comments, and ends where the last member ends.
    let first = members.iter().min_by_key(|m| m.trivia_byte);
    let last = members.iter().max_by_key(|m| m.end_byte);
    let (Some(first_member), Some(last_member)) = (first, last) else {
        return vec![];
    };
    let trivia_pos = byte_to_position(source.as_bytes(), first_member.trivia_byte);

    vec![TextEdit {
        range: EditRange {
            start: EditPosition {
                line: trivia_pos.0,
                character: trivia_pos.1,
            },
            end: EditPosition {
                line: last_member.end_row,
                character: last_member.end_col,
            },
        },
        new_text: reordered_text(members, sorted_indices, source, config),
    }]
}

/// The members in sorted order, each on its own line. A type whose members are
/// spaced by blank lines keeps one between every member; a compact type gets one
/// only where a new accessibility/category group starts. A member's own leading
/// blank lines are replaced, never added to, so no gap grows past one line.
pub(super) fn reordered_text(
    members: &[MemberInfo],
    sorted_indices: &[usize],
    source: &str,
    config: &SortConfig,
) -> String {
    let newline = if source.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let separator = members.iter().find_map(|member| {
        source
            .as_bytes()
            .get(member.end_byte)
            .copied()
            .filter(|byte| *byte == b',')
            .map(char::from)
    });
    let ordered = sorted_indices
        .iter()
        .filter_map(|&index| members.iter().find(|m| m.index == index));
    let spaced = members.iter().any(|member| {
        source
            .get(member.trivia_byte..member.end_byte)
            .is_some_and(|text| leading_layout(text).blank)
    });

    let mut new_text = String::new();
    let mut prev_member: Option<&MemberInfo> = None;
    for (sorted_pos, member) in ordered.enumerate() {
        let Some(text) = source.get(member.trivia_byte..member.end_byte) else {
            continue;
        };
        let layout = leading_layout(text);
        let gap = prev_member.is_some_and(|prev| spaced || groups_differ(prev, member, config));
        let breaks = match (layout.on_own_line, gap) {
            (false, _) => 0,
            (true, false) => 1,
            (true, true) => 2,
        };
        new_text.push_str(&newline.repeat(breaks));
        new_text.push_str(layout.body);
        append_separator(&mut new_text, separator, sorted_pos, sorted_indices.len());
        prev_member = Some(member);
    }
    new_text
}

/// A member's text, split at the line its content starts on.
pub(super) struct LeadingLayout<'a> {
    /// The member starts on a line of its own.
    on_own_line: bool,
    /// A blank line came before the member.
    blank: bool,
    /// The member from its first line's indentation on (or as it was, mid-line).
    body: &'a str,
}

/// Split `text` (a member with its leading trivia) into its leading line breaks and its body.
pub(super) fn leading_layout(text: &str) -> LeadingLayout<'_> {
    let content = text.len() - text.trim_start().len();
    let leading = text.get(..content).unwrap_or_default();
    let line_start = leading.rfind('\n').map_or(0, |newline| newline + 1);
    let breaks = leading.matches('\n').count();
    LeadingLayout {
        on_own_line: breaks > 0,
        blank: breaks > 1,
        body: text.get(line_start..).unwrap_or(text),
    }
}

/// Add punctuation that belongs between declarations rather than to either AST node.
pub(super) fn append_separator(
    text: &mut String,
    separator: Option<char>,
    position: usize,
    total: usize,
) {
    if position + 1 >= total {
        return;
    }
    if let Some(separator) = separator {
        text.push(separator);
    }
}

/// Convert a byte offset to (line, column) in the source.
pub(super) fn byte_to_position(source: &[u8], byte_offset: usize) -> (u32, u32) {
    let mut line: u32 = 0;
    let mut col: u32 = 0;
    for (i, &b) in source.iter().enumerate() {
        if i == byte_offset {
            return (line, col);
        }
        if b == b'\n' {
            line += 1;
            col = 0;
        } else {
            col += 1;
        }
    }
    (line, col)
}
