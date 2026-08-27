//! Custom `sharplsp/statementStop` request handler.
//!
//! Answers ONE question for the debugger: is the position the debuggee is
//! parked on a place a human should be asked to look at?
//!
//! Implements the syntactic half of [DEBUG-FEATURES-STEPPING]. A .NET method's
//! opening and closing braces carry their own sequence points, so
//! `ICorDebugStepper` — and therefore netcoredbg — comes to rest on a bare `{`
//! or `}` on the way into a method, out of a method, and around every block.
//! Visual Studio and vsdbg show the user that stop; `SharpLsp` elides it, which
//! means something has to decide which stops are elidable.
//!
//! That decision is made HERE, over the concrete syntax tree, and never by
//! looking at the characters on the line. The distinction is not cosmetic: the
//! debugger reports its stop as a source SPAN, and a one-character span is a
//! `{` in C# but the literal `0` that F#'s `main` returns — the same shape,
//! opposite answers. Only a parse tells them apart, so only a parse is trusted.
//! [DEBUG-MISSION] requires the same specified behaviour for C# and F#, and a
//! rule that read text would have to encode brace-shaped assumptions that F#
//! does not share.
//!
//! The rule resolves the position to its smallest concrete-syntax token and
//! rejects only the grammar's block delimiters, `{` and `}`. Tree-sitter also
//! models keywords such as `public`, `var`, `for`, and F# `let` as anonymous
//! tokens, so using `Node::is_named` would incorrectly hide real statements
//! that begin with a keyword.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use tree_sitter::Point;

use crate::tree_sitter_parse::{parse_file, TsParsers};
use crate::utils::uri_to_path;
use crate::vfs::Vfs;

/// Request params for `sharplsp/statementStop`.
#[derive(Debug, Deserialize)]
pub struct StatementStopParams {
    /// URI of the source file the debuggee is parked in.
    pub uri: String,
    /// Zero-based line the debugger's sequence point starts on.
    pub line: u32,
    /// Zero-based column the debugger's sequence point starts at.
    pub character: u32,
}

/// Response for `sharplsp/statementStop`.
#[derive(Debug, Serialize)]
pub struct StatementStopResponse {
    /// True when the position carries code, false when it is pure structure.
    pub statement: bool,
}

/// Handle the `sharplsp/statementStop` request.
///
/// A position that cannot be resolved at all — unreadable file, unsupported
/// language, a line the tree does not reach — is reported as a STATEMENT. The
/// caller elides what this says is not one, and eliding a stop hides it from
/// the user, so an unknown answer must never be the one that hides anything.
pub fn handle(
    params: &StatementStopParams,
    parsers: &TsParsers,
    vfs: &Vfs,
) -> Result<StatementStopResponse> {
    let file_path = uri_to_path(&params.uri)?;
    let (_source, tree) = parse_file(&file_path, parsers, vfs)?;
    Ok(StatementStopResponse {
        statement: carries_code(&tree, params.line, params.character),
    })
}

/// True when the smallest node covering this position is not a block delimiter.
fn carries_code(tree: &tree_sitter::Tree, line: u32, character: u32) -> bool {
    let Some((start, end)) = span_of(line, character) else {
        return true;
    };
    tree.root_node()
        .descendant_for_point_range(start, end)
        .is_none_or(|node| !matches!(node.kind(), "{" | "}"))
}

/// The one-character CST span a debugger stop position addresses.
fn span_of(line: u32, character: u32) -> Option<(Point, Point)> {
    let row = usize::try_from(line).ok()?;
    let column = usize::try_from(character).ok()?;
    Some((Point::new(row, column), Point::new(row, column + 1)))
}
