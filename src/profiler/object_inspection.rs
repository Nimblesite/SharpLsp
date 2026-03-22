//! Object inspection via `dotnet-dump analyze` with `dumpobj` command.
//!
//! Parses the output of `dumpobj <addr>` into structured field data,
//! giving developers a detailed view of any managed object on the heap.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tracing::{debug, info};

use super::tool_discovery;

/// Parameters for inspecting a managed object.
#[derive(Debug, Deserialize)]
pub struct InspectObjectParams {
    pub dump_path: String,
    pub object_address: String,
}

/// Full inspection result for a managed object.
#[derive(Debug, Serialize)]
pub struct ObjectInspection {
    pub address: String,
    pub type_name: String,
    pub size_bytes: u64,
    pub fields: Vec<ObjectField>,
    pub generation: String,
    pub is_pinned: bool,
}

/// A single field on a managed object.
#[derive(Debug, Clone, Serialize)]
pub struct ObjectField {
    pub name: String,
    pub type_name: String,
    pub value: String,
    pub is_reference: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reference_address: Option<String>,
}

/// Inspect a managed object by address.
pub async fn inspect(params: InspectObjectParams) -> Result<ObjectInspection> {
    let tool = tool_discovery::require_dump()?;
    validate_dump_path(&params.dump_path)?;

    info!(
        dump = %params.dump_path,
        address = %params.object_address,
        "Inspecting object"
    );

    let cmd = format!("dumpobj {}", params.object_address);
    let output = run_dump_command(tool, &params.dump_path, &cmd)
        .await
        .context("failed to run dumpobj")?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut inspection = parse_dumpobj_output(&stdout, &params.object_address)?;

    // Query generation and pinned status via `gcroot`.
    let gen_cmd = format!("gcroot {}", params.object_address);
    let gen_output = run_dump_command(tool, &params.dump_path, &gen_cmd)
        .await
        .context("failed to run gcroot for generation info")?;

    let gen_stdout = String::from_utf8_lossy(&gen_output.stdout);
    inspection.is_pinned = detect_pinned(&gen_stdout);
    inspection.generation = detect_generation(&gen_stdout);

    debug!(
        address = %inspection.address,
        type_name = %inspection.type_name,
        fields = inspection.fields.len(),
        "Object inspection complete"
    );

    Ok(inspection)
}

/// Run a command in the dotnet-dump analyze interactive session.
async fn run_dump_command(
    tool: &std::path::Path,
    dump_path: &str,
    command: &str,
) -> Result<std::process::Output> {
    let mut child = tokio::process::Command::new(tool)
        .args(["analyze", dump_path])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .context("spawn dotnet-dump analyze")?;

    let input = format!("{command}\nexit\n");
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(input.as_bytes()).await;
        drop(stdin);
    }

    child
        .wait_with_output()
        .await
        .context("wait for dotnet-dump analyze")
}

/// Parse `dumpobj` output into an `ObjectInspection`.
///
/// Expected format:
/// ```text
/// Name:        System.String
/// MethodTable: 00007ff8abcd1234
/// EEClass:     00007ff8abcd5678
/// Tracked Type: false
/// Size:        52(0x34) bytes
/// File:        /usr/share/dotnet/shared/...
/// String:      Hello World
/// Fields:
///               MT    Field   Offset                 Type VT     Attr            Value Name
/// 00007ff8abcd  4000  8         System.Int32  1 instance               11 m_stringLength
/// 00007ff8abcd  4001  c          System.Char  1 instance               48 m_firstChar
/// ```
fn parse_dumpobj_output(output: &str, address: &str) -> Result<ObjectInspection> {
    let mut type_name = String::new();
    let mut size_bytes: u64 = 0;
    let mut fields = Vec::new();
    let mut in_fields_section = false;
    let mut fields_header_seen = false;

    for line in output.lines() {
        let trimmed = line.trim();

        if trimmed.starts_with("Name:") {
            type_name = trimmed
                .strip_prefix("Name:")
                .unwrap_or("")
                .trim()
                .to_string();
            continue;
        }

        if trimmed.starts_with("Size:") {
            size_bytes = parse_size_field(trimmed);
            continue;
        }

        if trimmed.starts_with("Fields:") {
            in_fields_section = true;
            continue;
        }

        if in_fields_section {
            // Skip the header row.
            if !fields_header_seen && trimmed.contains("MT") && trimmed.contains("Name") {
                fields_header_seen = true;
                continue;
            }

            if fields_header_seen {
                if let Some(field) = parse_field_line(trimmed) {
                    fields.push(field);
                }
            }
        }
    }

    if type_name.is_empty() {
        anyhow::bail!(
            "could not parse dumpobj output for address {address}: \
             no 'Name:' line found"
        );
    }

    Ok(ObjectInspection {
        address: address.to_string(),
        type_name,
        size_bytes,
        fields,
        generation: "unknown".to_string(),
        is_pinned: false,
    })
}

/// Parse a field line from `dumpobj` output.
///
/// Format: `MT  FieldToken  Offset  Type  VT  Attr  Value  Name`
///
/// The columns are whitespace-separated with variable widths. The last
/// two tokens are always Value and Name. The Type column can contain spaces
/// (e.g. `System.Collections.Generic.List'1`).
fn parse_field_line(line: &str) -> Option<ObjectField> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with("---") {
        return None;
    }

    let tokens: Vec<&str> = trimmed.split_whitespace().collect();

    // Need at least: MT, FieldToken, Offset, Type, VT, Attr, Value, Name
    if tokens.len() < 8 {
        return None;
    }

    // Name is always the last token.
    let name = (*tokens.last()?).to_string();

    // Value is the second-to-last token.
    let value_str = (*tokens.get(tokens.len() - 2)?).to_string();

    // Attr is the third-to-last token (instance, static, shared).
    let attr_idx = tokens.len() - 3;

    // VT is the fourth-to-last token (0 = reference, 1 = value type).
    let vt_idx = tokens.len() - 4;
    let vt = *tokens.get(vt_idx)?;

    // Type spans from index 3 to vt_idx (exclusive).
    let type_name = if vt_idx > 3 {
        tokens.get(3..vt_idx).unwrap_or_default().join(" ")
    } else {
        (*tokens.get(3)?).to_string()
    };

    let is_reference = vt == "0";
    let is_attr_instance = tokens
        .get(attr_idx)
        .is_some_and(|a| *a == "instance");

    // For reference types, the value is a hex address (or "null"/0000000000000000).
    let reference_address = if is_reference && is_attr_instance {
        let addr = value_str.trim_start_matches("0x");
        if addr.chars().all(|c| c == '0') {
            None
        } else {
            Some(value_str.clone())
        }
    } else {
        None
    };

    Some(ObjectField {
        name,
        type_name,
        value: value_str,
        is_reference,
        reference_address,
    })
}

/// Parse the Size field: `Size: 52(0x34) bytes` → 52.
fn parse_size_field(line: &str) -> u64 {
    let after_colon = line
        .strip_prefix("Size:")
        .unwrap_or(line)
        .trim();

    // Take digits before the first non-digit character.
    let digits: String = after_colon.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().unwrap_or(0)
}

/// Detect if the object is pinned from `gcroot` output.
fn detect_pinned(gcroot_output: &str) -> bool {
    gcroot_output
        .lines()
        .any(|l| {
            let lower = l.to_lowercase();
            lower.contains("pinned") || lower.contains("pin")
        })
}

/// Detect the GC generation from `gcroot` output or surrounding context.
///
/// `dotnet-dump` doesn't directly report generation in `dumpobj`, but
/// `gcroot` output and heap segment info can hint at it.
fn detect_generation(gcroot_output: &str) -> String {
    for line in gcroot_output.lines() {
        let lower = line.to_lowercase();
        if lower.contains("gen 0") || lower.contains("generation 0") {
            return "Gen0".to_string();
        }
        if lower.contains("gen 1") || lower.contains("generation 1") {
            return "Gen1".to_string();
        }
        if lower.contains("gen 2") || lower.contains("generation 2") {
            return "Gen2".to_string();
        }
        if lower.contains("large object heap") || lower.contains("loh") {
            return "LOH".to_string();
        }
        if lower.contains("pinned object heap") || lower.contains("poh") {
            return "POH".to_string();
        }
    }
    "unknown".to_string()
}

/// Verify the dump file exists before invoking `dotnet-dump analyze`.
fn validate_dump_path(path: &str) -> Result<()> {
    if !std::path::Path::new(path).exists() {
        anyhow::bail!("dump file not found: {path}");
    }
    Ok(())
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code — panics are the correct failure mode"
)]
mod tests {
    use super::*;

    const DUMPOBJ_OUTPUT: &str = "\
Name:        System.String
MethodTable: 00007ff8abcd1234
EEClass:     00007ff8abcd5678
Tracked Type: false
Size:        52(0x34) bytes
File:        /usr/share/dotnet/shared/Microsoft.NETCore.App/9.0.0/System.Private.CoreLib.dll
String:      Hello World
Fields:
              MT    Field   Offset                 Type VT     Attr            Value Name
00007ff80001  4000123      8         System.Int32  1 instance               11 m_stringLength
00007ff80002  4000124      c          System.Char  1 instance               48 m_firstChar
";

    #[test]
    fn test_parse_dumpobj_basic() {
        let result = parse_dumpobj_output(DUMPOBJ_OUTPUT, "0x1234").unwrap();
        assert_eq!(result.type_name, "System.String");
        assert_eq!(result.size_bytes, 52);
        assert_eq!(result.address, "0x1234");
        assert_eq!(result.fields.len(), 2);
    }

    #[test]
    fn test_parse_dumpobj_field_details() {
        let result = parse_dumpobj_output(DUMPOBJ_OUTPUT, "0x1234").unwrap();

        let length_field = &result.fields[0];
        assert_eq!(length_field.name, "m_stringLength");
        assert_eq!(length_field.type_name, "System.Int32");
        assert_eq!(length_field.value, "11");
        assert!(!length_field.is_reference);
        assert!(length_field.reference_address.is_none());

        let char_field = &result.fields[1];
        assert_eq!(char_field.name, "m_firstChar");
        assert_eq!(char_field.type_name, "System.Char");
        assert!(!char_field.is_reference);
    }

    const DUMPOBJ_WITH_REFS: &str = "\
Name:        MyApp.Service
MethodTable: 00007ff8abcd9999
EEClass:     00007ff8abcdaaaa
Size:        32(0x20) bytes
Fields:
              MT    Field   Offset                 Type VT     Attr            Value Name
00007ff80003  4000200      8        System.String  0 instance 00007ff812345678 _name
00007ff80004  4000201     10  System.Object[]  0 instance 0000000000000000 _items
00007ff80005  4000202     18         System.Int32  1 instance                5 _count
";

    #[test]
    fn test_parse_dumpobj_reference_fields() {
        let result = parse_dumpobj_output(DUMPOBJ_WITH_REFS, "0xabcd").unwrap();
        assert_eq!(result.type_name, "MyApp.Service");
        assert_eq!(result.size_bytes, 32);
        assert_eq!(result.fields.len(), 3);

        // _name is a reference to a string object.
        let name_field = &result.fields[0];
        assert_eq!(name_field.name, "_name");
        assert_eq!(name_field.type_name, "System.String");
        assert!(name_field.is_reference);
        assert_eq!(
            name_field.reference_address.as_deref(),
            Some("00007ff812345678")
        );

        // _items is a null reference.
        let items_field = &result.fields[1];
        assert_eq!(items_field.name, "_items");
        assert!(items_field.is_reference);
        assert!(
            items_field.reference_address.is_none(),
            "null reference should have no address"
        );

        // _count is a value type.
        let count_field = &result.fields[2];
        assert_eq!(count_field.name, "_count");
        assert!(!count_field.is_reference);
        assert!(count_field.reference_address.is_none());
    }

    #[test]
    fn test_parse_dumpobj_no_name_errors() {
        let output = "Some garbage output\nwith no Name: line";
        let result = parse_dumpobj_output(output, "0x1234");
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_size_field() {
        assert_eq!(parse_size_field("Size:        52(0x34) bytes"), 52);
        assert_eq!(parse_size_field("Size:        1024(0x400) bytes"), 1024);
        assert_eq!(parse_size_field("Size:        0 bytes"), 0);
    }

    #[test]
    fn test_detect_pinned() {
        assert!(detect_pinned("    Pinned handle found\n"));
        assert!(!detect_pinned("    Found 1 unique root(s).\n"));
    }

    #[test]
    fn test_detect_generation() {
        assert_eq!(detect_generation("  Gen 0 heap segment"), "Gen0");
        assert_eq!(detect_generation("  Gen 2 region"), "Gen2");
        assert_eq!(
            detect_generation("  Large Object Heap segment"),
            "LOH"
        );
        assert_eq!(detect_generation("  nothing relevant"), "unknown");
    }

    const DUMPOBJ_ARRAY: &str = "\
Name:        System.Object[]
MethodTable: 00007ff8abcd3333
Size:        80(0x50) bytes
Array:       Rank 1, Number of elements 8, Type CLASS
Fields:
              MT    Field   Offset                 Type VT     Attr            Value Name
";

    #[test]
    fn test_parse_dumpobj_array() {
        let result = parse_dumpobj_output(DUMPOBJ_ARRAY, "0x5555").unwrap();
        assert_eq!(result.type_name, "System.Object[]");
        assert_eq!(result.size_bytes, 80);
        assert!(result.fields.is_empty());
    }
}
