use super::*;

// ── Full-stack: definition cache, nav methods with range assertions ──

// 78. FULL-STACK: DEFINITION CACHE HIT RETURNS SAME LOCATION

#[test]
fn test_full_stack_definition_cache_hit() {
    if !is_dotnet_available() {
        eprintln!("SKIPPED: dotnet SDK not installed");
        return;
    }

    let (_tmp, root_uri, file_uri, source) = create_definition_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    // First request warms the cache.
    let result1 =
        poll_definition_until_ready(&mut client, &file_uri, 14, 23, Duration::from_secs(90));
    assert_location_shape(&result1);

    // Second request should be a cache hit — same result.
    let resp2 = definition(&mut client, &file_uri, 14, 23);
    assert_nav_ok(&resp2);
    let result2 = first_location(&resp2["result"]);
    assert_eq!(
        result1["uri"], result2["uri"],
        "cache hit must return same URI"
    );
    assert_eq!(
        result1["range"], result2["range"],
        "cache hit must return same range"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 79. FULL-STACK: DECLARATION ON NON-OVERRIDE RETURNS SAME AS DEFINITION

#[test]
fn test_full_stack_declaration_on_non_override() {
    if !is_dotnet_available() {
        eprintln!("SKIPPED: dotnet SDK not installed");
        return;
    }

    let (_tmp, root_uri, file_uri, source) = create_definition_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    let _ = poll_definition_until_ready(&mut client, &file_uri, 14, 23, Duration::from_secs(90));

    // "GetGreeting" method (line 31, char 18) is not an override.
    //     public string GetGreeting()
    //     0         1
    //     01234567890123456789
    let def_resp = definition(&mut client, &file_uri, 31, 18);
    let decl_resp = declaration(&mut client, &file_uri, 31, 18);
    assert_nav_ok(&def_resp);
    assert_nav_ok(&decl_resp);

    let def_loc = first_location(&def_resp["result"]);
    let decl_loc = &decl_resp["result"];

    // Both should resolve (non-null).
    assert!(
        !def_loc.is_null(),
        "definition on non-override method must resolve"
    );
    assert!(
        !decl_loc.is_null(),
        "declaration on non-override method must resolve"
    );

    // For a non-override, declaration should point to the same line as definition.
    let def_line = def_loc["range"]["start"]["line"].as_u64().unwrap();
    let decl_line = decl_loc["range"]["start"]["line"].as_u64().unwrap();
    assert_eq!(
        def_line, decl_line,
        "declaration on non-override must match definition line"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 80. FULL-STACK: IMPLEMENTATION ON CONCRETE CLASS RETURNS ITS OWN LOCATION

#[test]
fn test_full_stack_implementation_on_concrete_class() {
    if !is_dotnet_available() {
        eprintln!("SKIPPED: dotnet SDK not installed");
        return;
    }

    let (_tmp, root_uri, file_uri, source) = create_definition_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    let _ = poll_definition_until_ready(&mut client, &file_uri, 14, 23, Duration::from_secs(90));

    // "Dog" class name at line 14, char 13.
    //     public class Dog : AnimalBase
    //     0         1
    //     0123456789012345
    let resp = implementation(&mut client, &file_uri, 14, 13);
    assert_nav_ok(&resp);
    let result = &resp["result"];

    // Implementation on a concrete (non-abstract) class should return at
    // least its own location.
    assert!(
        !result.is_null(),
        "implementation on concrete class must resolve"
    );
    if result.is_array() {
        let locations = result.as_array().unwrap();
        assert!(
            !locations.is_empty(),
            "implementation on Dog must return at least one location"
        );
        for loc in locations {
            assert_location_shape(loc);
        }
    }

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 81. FULL-STACK: TYPE DEFINITION VALIDATES FULL LOCATION STRUCTURE

#[test]
fn test_full_stack_type_definition_location_structure() {
    if !is_dotnet_available() {
        eprintln!("SKIPPED: dotnet SDK not installed");
        return;
    }

    let (_tmp, root_uri, file_uri, source) = create_definition_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    let _ = poll_definition_until_ready(&mut client, &file_uri, 14, 23, Duration::from_secs(90));

    // "MyDog" (line 33, char 18) -> type Dog at line 14.
    let resp = type_definition(&mut client, &file_uri, 33, 18);
    assert_nav_ok(&resp);
    let result = &resp["result"];
    assert!(!result.is_null(), "typeDefinition must resolve");

    // Validate full location structure.
    let uri = result["uri"].as_str().unwrap();
    assert!(uri.starts_with("file://"), "uri must be file:// URI");
    assert!(uri.contains("Program.cs"), "uri must point to source file");
    let range = &result["range"];
    let start_line = range["start"]["line"].as_u64().unwrap();
    let start_char = range["start"]["character"].as_u64().unwrap();
    let end_line = range["end"]["line"].as_u64().unwrap();
    let end_char = range["end"]["character"].as_u64().unwrap();
    assert_eq!(start_line, 14, "Dog type starts at line 14");
    assert!(start_char < 100, "start character must be reasonable");
    assert!(end_line >= start_line, "end line must be >= start line");
    assert!(
        end_line > start_line || end_char > start_char,
        "range must have non-zero length"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 82. FULL-STACK: DEFINITION AFTER EDIT INVALIDATES CACHE

#[test]
fn test_full_stack_definition_cache_invalidated_on_change() {
    if !is_dotnet_available() {
        eprintln!("SKIPPED: dotnet SDK not installed");
        return;
    }

    let (_tmp, root_uri, file_uri, source) = create_definition_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    // Warm the cache.
    let result1 =
        poll_definition_until_ready(&mut client, &file_uri, 14, 23, Duration::from_secs(90));
    assert_location_shape(&result1);

    // Change the document — this should invalidate the nav cache.
    client.change_document(&file_uri, 2, &source);

    // Request again — should still work (cache invalidated, re-fetched from sidecar).
    let resp = definition(&mut client, &file_uri, 14, 23);
    assert_nav_ok(&resp);
    let result2 = first_location(&resp["result"]);
    // After re-fetch, the result should still point to the same location.
    if !result2.is_null() {
        assert_location_shape(&result2);
        assert_eq!(
            result1["uri"], result2["uri"],
            "re-fetched result must point to same URI"
        );
    }

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 83. FULL-STACK: ALL NAV METHODS WITH STRONGER ASSERTIONS

#[test]
fn test_full_stack_nav_methods_with_range_assertions() {
    if !is_dotnet_available() {
        eprintln!("SKIPPED: dotnet SDK not installed");
        return;
    }

    let (_tmp, root_uri, file_uri, source) = create_definition_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    let _ = poll_definition_until_ready(&mut client, &file_uri, 14, 23, Duration::from_secs(90));

    // definition: "AnimalBase" -> line 8
    let r1 = definition(&mut client, &file_uri, 14, 23);
    assert_nav_ok(&r1);
    let loc1 = first_location(&r1["result"]);
    assert_location_shape(&loc1);
    let uri1 = loc1["uri"].as_str().unwrap();
    assert!(
        uri1.starts_with("file://"),
        "definition uri must be file://"
    );
    assert_eq!(
        loc1["range"]["start"]["line"].as_u64().unwrap(),
        8,
        "AnimalBase at line 8"
    );

    // typeDefinition: "dog" variable (line 33, char 12) -> Dog type (line 14)
    //         var dog = MyDog;
    //         0         1
    //         0123456789012
    let r2 = type_definition(&mut client, &file_uri, 33, 12);
    assert_nav_ok(&r2);
    if !r2["result"].is_null() {
        let uri2 = r2["result"]["uri"].as_str().unwrap();
        assert!(
            uri2.starts_with("file://"),
            "typeDefinition uri must be file://"
        );
        assert_eq!(
            r2["result"]["range"]["start"]["line"].as_u64().unwrap(),
            14,
            "type of dog is Dog at line 14"
        );
        let end_line = r2["result"]["range"]["end"]["line"].as_u64().unwrap();
        assert!(end_line >= 14, "end line must be >= 14");
    }

    // declaration: Dog.Speak override (line 17, char 27) -> AnimalBase.Speak (line 11)
    let r3 = declaration(&mut client, &file_uri, 17, 27);
    assert_nav_ok(&r3);
    if !r3["result"].is_null() {
        let uri3 = r3["result"]["uri"].as_str().unwrap();
        assert!(
            uri3.starts_with("file://"),
            "declaration uri must be file://"
        );
        assert_eq!(
            r3["result"]["range"]["start"]["line"].as_u64().unwrap(),
            11,
            "declaration of Dog.Speak override -> base at line 11"
        );
    }

    // implementation: IAnimal (line 2, char 18) -> implementors
    let r4 = implementation(&mut client, &file_uri, 2, 18);
    assert_nav_ok(&r4);
    if !r4["result"].is_null() {
        assert!(r4["result"].is_array(), "implementation must return array");
        let impl_locations = r4["result"].as_array().unwrap();
        for location in impl_locations {
            assert_location_shape(location);
            let location_uri = location["uri"].as_str().unwrap();
            assert!(
                location_uri.starts_with("file://"),
                "implementation loc uri must be file://"
            );
        }
    }

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
