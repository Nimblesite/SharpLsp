//! XML DOM writer for `Directory.Build.props` using `quick_xml` events.
//! Implements [FIXALL-ENFORCE] and [PKG-VULN-SEVERITY] (`enforce_in_build`).

use anyhow::{Context, Result};
use quick_xml::{
    events::{BytesEnd, BytesStart, BytesText, Event},
    Reader, Writer,
};

use crate::config_nuget::{MappedSeverity, VulnerabilityConfig};

/// Return the `NU190x` diagnostic codes mapped to `Error` in `config`.
/// Implements [PKG-VULN-SEVERITY].
pub fn error_mapped_nuget_codes(config: &VulnerabilityConfig) -> Vec<&'static str> {
    [
        (config.low, "NU1901"),
        (config.moderate, "NU1902"),
        (config.high, "NU1903"),
        (config.critical, "NU1904"),
    ]
    .into_iter()
    .filter_map(|(sev, code)| (sev == MappedSeverity::Error).then_some(code))
    .collect()
}

/// Set or merge an `MSBuild` property inside `Directory.Build.props` through
/// `quick_xml` events, preserving comments and unrelated properties.
/// When `list_sep` is `Some(sep)`, tokens are merged without duplicates.
pub fn set_property(xml: &str, name: &str, value: &str, list_sep: Option<char>) -> Result<String> {
    if xml.trim().is_empty() {
        let initial = merge_or_replace("", name, value, list_sep);
        return Ok(format!(
            "<Project>\n  <PropertyGroup>\n    <{name}>{initial}</{name}>\n  </PropertyGroup>\n</Project>\n"
        ));
    }
    rewrite_xml(xml, name, value, list_sep)
}

fn merge_or_replace(existing: &str, name: &str, addition: &str, list_sep: Option<char>) -> String {
    let Some(sep) = list_sep else {
        return addition.to_string();
    };
    let mut tokens: Vec<String> = existing
        .split(sep)
        .map(str::trim)
        .filter(|tok| !tok.is_empty())
        .map(str::to_string)
        .collect();
    if tokens.is_empty() {
        tokens.push(format!("$({name})"));
    }
    for tok in addition.split(sep).map(str::trim).filter(|t| !t.is_empty()) {
        if !tokens.iter().any(|cur| cur.eq_ignore_ascii_case(tok)) {
            tokens.push(tok.to_string());
        }
    }
    tokens.join(&sep.to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScanPhase {
    Outside,
    InUncondPg,
    InTargetProp,
}

struct RewriteState {
    phase: ScanPhase,
    updated: bool,
    saw_uncond_pg: bool,
    prop_text: String,
    depth: usize,
}

fn rewrite_xml(xml: &str, name: &str, value: &str, list_sep: Option<char>) -> Result<String> {
    let mut reader = Reader::from_str(xml);
    let mut writer = Writer::new(Vec::new());
    let mut st = RewriteState {
        phase: ScanPhase::Outside,
        updated: false,
        saw_uncond_pg: false,
        prop_text: String::new(),
        depth: 0,
    };

    loop {
        match reader
            .read_event()
            .context("invalid Directory.Build.props XML")?
        {
            Event::Eof => break,
            Event::Start(e) => handle_start(&mut writer, e, name, &mut st)?,
            Event::Text(t) if st.phase == ScanPhase::InTargetProp => {
                st.prop_text
                    .push_str(&t.decode().context("invalid XML text")?);
            }
            Event::End(e) => handle_end(&mut writer, e, name, value, list_sep, &mut st)?,
            other => writer.write_event(other)?,
        }
    }

    String::from_utf8(writer.into_inner()).context("non-UTF8 XML output")
}

fn handle_start(
    writer: &mut Writer<Vec<u8>>,
    e: BytesStart<'_>,
    name: &str,
    st: &mut RewriteState,
) -> Result<()> {
    st.depth += 1;
    let tag = e.name();
    if st.depth == 2
        && tag.as_ref() == b"PropertyGroup"
        && e.try_get_attribute("Condition")?.is_none()
    {
        st.phase = ScanPhase::InUncondPg;
        st.saw_uncond_pg = true;
    } else if st.phase == ScanPhase::InUncondPg
        && st.depth == 3
        && !st.updated
        && tag.as_ref() == name.as_bytes()
    {
        st.phase = ScanPhase::InTargetProp;
        st.prop_text.clear();
    }
    writer.write_event(Event::Start(e.into_owned()))?;
    Ok(())
}

fn handle_end(
    writer: &mut Writer<Vec<u8>>,
    e: BytesEnd<'_>,
    name: &str,
    value: &str,
    list_sep: Option<char>,
    st: &mut RewriteState,
) -> Result<()> {
    let tag = e.name();
    if st.phase == ScanPhase::InTargetProp && st.depth == 3 && tag.as_ref() == name.as_bytes() {
        let merged = merge_or_replace(&st.prop_text, name, value, list_sep);
        writer.write_event(Event::Text(BytesText::new(&merged)))?;
        st.phase = ScanPhase::InUncondPg;
        st.updated = true;
    } else if st.phase == ScanPhase::InUncondPg && st.depth == 2 && tag.as_ref() == b"PropertyGroup"
    {
        if !st.updated {
            write_prop_element(writer, name, &merge_or_replace("", name, value, list_sep))?;
            st.updated = true;
        }
        st.phase = ScanPhase::Outside;
    } else if st.depth == 1 && tag.as_ref() == b"Project" && !st.updated && !st.saw_uncond_pg {
        write_new_property_group(writer, name, &merge_or_replace("", name, value, list_sep))?;
        st.updated = true;
    }
    st.depth = st.depth.saturating_sub(1);
    writer.write_event(Event::End(e.into_owned()))?;
    Ok(())
}

fn write_prop_element(writer: &mut Writer<Vec<u8>>, name: &str, value: &str) -> Result<()> {
    writer.write_event(Event::Text(BytesText::new("  ")))?;
    writer.write_event(Event::Start(BytesStart::new(name)))?;
    writer.write_event(Event::Text(BytesText::new(value)))?;
    writer.write_event(Event::End(BytesEnd::new(name)))?;
    writer.write_event(Event::Text(BytesText::new("\n  ")))?;
    Ok(())
}

fn write_new_property_group(writer: &mut Writer<Vec<u8>>, name: &str, value: &str) -> Result<()> {
    writer.write_event(Event::Text(BytesText::new("  ")))?;
    writer.write_event(Event::Start(BytesStart::new("PropertyGroup")))?;
    writer.write_event(Event::Text(BytesText::new("\n    ")))?;
    writer.write_event(Event::Start(BytesStart::new(name)))?;
    writer.write_event(Event::Text(BytesText::new(value)))?;
    writer.write_event(Event::End(BytesEnd::new(name)))?;
    writer.write_event(Event::Text(BytesText::new("\n  ")))?;
    writer.write_event(Event::End(BytesEnd::new("PropertyGroup")))?;
    writer.write_event(Event::Text(BytesText::new("\n")))?;
    Ok(())
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code — panics are the correct failure mode"
)]
mod tests {
    use super::*;

    #[test]
    fn merges_warnings_as_errors_preserving_comments_and_existing_tokens() {
        let xml = "<Project>\n  <!-- keep comment -->\n  <PropertyGroup>\n    <WarningsAsErrors>$(WarningsAsErrors);CS0168</WarningsAsErrors>\n  </PropertyGroup>\n</Project>\n";
        let out = set_property(xml, "WarningsAsErrors", "NU1903;NU1904", Some(';')).unwrap();
        assert!(out.contains("<!-- keep comment -->"));
        assert!(out.contains(
            "<WarningsAsErrors>$(WarningsAsErrors);CS0168;NU1903;NU1904</WarningsAsErrors>"
        ));
        // Idempotent on second merge.
        let again = set_property(&out, "WarningsAsErrors", "NU1903;NU1904", Some(';')).unwrap();
        assert_eq!(out, again);
    }

    #[test]
    fn creates_directory_build_props_when_empty() {
        let out = set_property("", "EnforceCodeStyleInBuild", "true", None).unwrap();
        assert!(out.contains("<EnforceCodeStyleInBuild>true</EnforceCodeStyleInBuild>"));
    }

    #[test]
    fn error_mapped_nuget_codes_tracks_config() {
        let mut cfg = VulnerabilityConfig::default();
        assert_eq!(error_mapped_nuget_codes(&cfg), vec!["NU1903", "NU1904"]);
        cfg.moderate = MappedSeverity::Error;
        assert_eq!(
            error_mapped_nuget_codes(&cfg),
            vec!["NU1902", "NU1903", "NU1904"]
        );
    }
}
