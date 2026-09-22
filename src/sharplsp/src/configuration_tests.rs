//! Resolution contract tests. Implements [CONFIG-RESOLUTION], [CONFIG-DEBUG-EXCEPTIONS].
use super::*;
// Assertions intentionally fail tests; the Result carries fixture I/O errors.
#[expect(
    clippy::panic_in_result_fn,
    reason = "test assertions intentionally fail while Result carries fixture I/O errors"
)]
#[expect(
    clippy::indexing_slicing,
    reason = "serde_json Value indexing returns Null for absent fields, not a panic"
)]
mod contract {
    use super::*;

    #[test]
    fn client_overrides_are_atomic_and_session_overrides_take_precedence() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let mut config = Configuration::new(dir.path().to_path_buf());
        config.update(&json!({"sharplsp":{"debug":{"exceptions":{"break_on":"all"}}}}))?;
        assert!(config
            .update(&json!({"sharplsp":{"debug":{"exceptions":{"break_on":"invalid"}}}}))
            .is_err());
        assert_eq!(config.client["debug"]["exceptions"]["break_on"], "all");
        let effective = resolve(
            dir.path(),
            None,
            &config.client,
            json!({"debug":{"exceptions":{"break_on":"unhandled"}}}),
        )?;
        assert_eq!(effective["debug"]["exceptions"]["break_on"], "unhandled");
        config.update(&json!({"sharplsp":{}}))?;
        assert_eq!(config.client, json!({}));
        Ok(())
    }

    #[test]
    fn nested_workspaces_resolve_independently_and_deletion_restores_parent() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let nested = dir.path().join("nested");
        std::fs::create_dir(&nested)?;
        std::fs::write(
            dir.path().join("sharplsp.toml"),
            "[debug.exceptions]\nbreak_on = 'all'\n",
        )?;
        let file = nested.join("sharplsp.toml");
        std::fs::write(&file, "[debug.exceptions]\nbreak_on = 'unhandled'\n")?;
        assert_eq!(
            resolve(&nested, None, &json!({}), json!({}))?["debug"]["exceptions"]["break_on"],
            "unhandled"
        );
        assert_eq!(
            resolve(dir.path(), None, &json!({}), json!({}))?["debug"]["exceptions"]["break_on"],
            "all"
        );
        std::fs::remove_file(file)?;
        assert_eq!(
            resolve(&nested, None, &json!({}), json!({}))?["debug"]["exceptions"]["break_on"],
            "all"
        );
        Ok(())
    }

    #[test]
    fn layers_preserve_unspecified_values_and_replace_arrays() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let user = dir.path().join("user.toml");
        std::fs::write(
            &user,
            "[debug.exceptions]\nbreak_on = 'all'\nignore = ['System.Exception']\n",
        )?;
        std::fs::write(
            dir.path().join("sharplsp.toml"),
            "[debug.exceptions]\nexternal_code = 'user-boundary'\n",
        )?;
        let config = resolve(
            dir.path(),
            Some(&user),
            &json!({}),
            json!({"debug":{"exceptions":{"ignore":[]}}}),
        )?;
        assert_eq!(config["debug"]["exceptions"]["break_on"], "all");
        assert_eq!(
            config["debug"]["exceptions"]["external_code"],
            "user-boundary"
        );
        assert_eq!(config["debug"]["exceptions"]["ignore"], json!([]));
        assert_eq!(config["debug"]["exceptions"]["just_my_code"], true);
        assert_eq!(config["server"]["debounce_ms"], 150);
        Ok(())
    }

    #[test]
    fn edits_are_read_and_invalid_configuration_is_not_silently_ignored() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let file = dir.path().join("sharplsp.toml");
        std::fs::write(&file, "[debug.exceptions]\nbreak_on = 'all'\n")?;
        assert_eq!(
            resolve(dir.path(), None, &json!({}), json!({}))?["debug"]["exceptions"]["break_on"],
            "all"
        );
        std::fs::write(&file, "[debug.exceptions]\nbreak_on = 'unhandled'\n")?;
        assert_eq!(
            resolve(dir.path(), None, &json!({}), json!({}))?["debug"]["exceptions"]["break_on"],
            "unhandled"
        );
        std::fs::write(&file, "[debug.exceptions]\nbreak_on = 'typo'\n")?;
        assert!(resolve(dir.path(), None, &json!({}), json!({})).is_err());
        Ok(())
    }

    #[test]
    fn unknown_keys_and_invalid_exception_filters_are_rejected() -> Result<()> {
        let dir = tempfile::tempdir()?;
        for overlay in [
            json!({"debug":{"exception":{}}}),
            json!({"debug":{"exceptions":{"just_my_code":"false"}}}),
            json!({"debug":{"exceptions":{"ignore":["!System.Exception"]}}}),
            json!({"debug":{"exceptions":{"ignore":["System.Exception System.Other"]}}}),
        ] {
            assert!(resolve(dir.path(), None, &json!({}), overlay).is_err());
        }
        Ok(())
    }

    #[test]
    fn lsp_resolution_uses_scope_and_rejects_non_file_uris() -> Result<()> {
        let dir = tempfile::tempdir()?;
        std::fs::write(
            dir.path().join("sharplsp.toml"),
            "[debug.exceptions]\nbreak_on = 'all'\n",
        )?;
        let config = Configuration::new(dir.path().to_path_buf());
        let (server, client) = Connection::memory();
        config.respond(
            Request::new(1.into(), "sharplsp/configuration".into(), json!({})),
            &server,
        )?;
        let Message::Response(response) = client.receiver.recv()? else {
            anyhow::bail!("expected response");
        };
        let response = serde_json::to_value(response)?;
        assert!(response.get("error").is_none());
        assert_eq!(response["result"]["debug"]["exceptions"]["break_on"], "all");
        assert!(config
            .effective(ResolveParams {
                scope_uri: Some("https://example.com".into()),
                overrides: None
            })
            .is_err());
        Ok(())
    }
}
