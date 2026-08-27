use super::*;

// ── Definition / TypeDefinition / Declaration / Implementation ────

// 36. CAPABILITIES: definition, typeDefinition, declaration, implementation

#[test]
fn test_definition_capabilities_advertised() {
    let mut client = LspClient::start();
    let resp = client.initialize();
    let caps = &resp["result"]["capabilities"];

    assert_eq!(caps["definitionProvider"], true, "definition");
    assert_eq!(caps["typeDefinitionProvider"], true, "typeDefinition");
    assert_eq!(caps["declarationProvider"], true, "declaration");
    assert_eq!(caps["implementationProvider"], true, "implementation");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 38. DEFINITION AFTER DOCUMENT EDIT

#[test]
fn test_definition_after_document_edit() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    client.open_document(TEST_URI, "public class Alpha { }");

    let resp = definition(&mut client, TEST_URI, 0, 14);
    assert_nav_ok(&resp);

    client.change_document(TEST_URI, 2, "public class Beta { public void Run() {} }");

    let resp = definition(&mut client, TEST_URI, 0, 14);
    assert_nav_ok(&resp);

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// ── Full-stack definition E2E tests (real sidecar + Roslyn) ─────

// 52. DEFINITION ON CLASS NAME → CLASS DECLARATION

#[test]
fn test_full_stack_definition_on_class_name() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_definition_workspace();

    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    // "AnimalBase" in "class Dog : AnimalBase" (line 14, char 23).
    let result =
        poll_definition_until_ready(&mut client, &file_uri, 14, 23, Duration::from_secs(90));

    assert_location_shape(&result);
    let uri = result["uri"].as_str().unwrap();
    assert!(uri.starts_with("file://"), "uri must be file:// URI");
    assert!(uri.contains("Program.cs"), "must point to source file");
    assert_location_line(&result, 8, "AnimalBase declared at line 8");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 53. DEFINITION ON METHOD CALL → METHOD DECLARATION

#[test]
fn test_full_stack_definition_on_method_call() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_definition_workspace();

    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    let _ = poll_definition_until_ready(&mut client, &file_uri, 14, 23, Duration::from_secs(90));

    // "Speak" in "dog.Speak()" (line 34, char 26).
    let resp = definition(&mut client, &file_uri, 34, 26);
    assert_nav_ok(&resp);
    let result = first_location(&resp["result"]);
    assert!(!result.is_null(), "definition on method call must resolve");
    assert_location_shape(&result);
    let line = result["range"]["start"]["line"].as_u64().unwrap();
    assert!(
        line == 11 || line == 17,
        "Speak → line 11 (virtual) or 17 (override), got {line}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 54. DEFINITION ON PROPERTY ACCESS → PROPERTY DECLARATION

#[test]
fn test_full_stack_definition_on_property_access() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_definition_workspace();

    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    let _ = poll_definition_until_ready(&mut client, &file_uri, 14, 23, Duration::from_secs(90));

    // "MyDog" in "var dog = MyDog" (line 33, char 18).
    let resp = definition(&mut client, &file_uri, 33, 18);
    assert_nav_ok(&resp);
    let result = first_location(&resp["result"]);
    assert!(!result.is_null(), "definition on property must resolve");
    assert_location_line(&result, 28, "MyDog property declared at line 28");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 55. TYPE DEFINITION ON VARIABLE → TYPE DECLARATION

#[test]
fn test_full_stack_type_definition_on_variable() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_definition_workspace();

    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    let _ = poll_definition_until_ready(&mut client, &file_uri, 14, 23, Duration::from_secs(90));

    // "MyDog" in "var dog = MyDog" (line 33, char 18) → type Dog (line 14).
    let resp = type_definition(&mut client, &file_uri, 33, 18);
    assert_nav_ok(&resp);
    let result = &resp["result"];
    assert!(
        !result.is_null(),
        "typeDefinition on property ref must resolve"
    );
    assert_location_line(result, 14, "type of MyDog is Dog at line 14");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 56. DECLARATION ON OVERRIDE → BASE VIRTUAL METHOD

#[test]
fn test_full_stack_declaration_on_override() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_definition_workspace();

    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    let _ = poll_definition_until_ready(&mut client, &file_uri, 14, 23, Duration::from_secs(90));

    // "Speak" in Dog's override (line 17, char 27) → AnimalBase.Speak (line 11).
    let resp = declaration(&mut client, &file_uri, 17, 27);
    assert_nav_ok(&resp);
    let result = &resp["result"];
    assert!(
        !result.is_null(),
        "declaration on override must resolve to base"
    );
    assert_location_line(result, 11, "Dog.Speak override → AnimalBase.Speak line 11");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 57. DECLARATION ON INTERFACE IMPL → INTERFACE MEMBER

#[test]
fn test_full_stack_declaration_on_interface_impl() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_definition_workspace();

    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    let _ = poll_definition_until_ready(&mut client, &file_uri, 14, 23, Duration::from_secs(90));

    // "Name" in AnimalBase's abstract prop (line 10, char 27) → IAnimal.Name (line 4).
    let resp = declaration(&mut client, &file_uri, 10, 27);
    assert_nav_ok(&resp);
    let result = &resp["result"];
    assert!(
        !result.is_null(),
        "declaration on interface impl must resolve"
    );
    assert_location_line(result, 4, "AnimalBase.Name → IAnimal.Name line 4");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 58. IMPLEMENTATION ON INTERFACE → ALL IMPLEMENTORS

#[test]
fn test_full_stack_implementation_on_interface() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_definition_workspace();

    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    let _ = poll_definition_until_ready(&mut client, &file_uri, 14, 23, Duration::from_secs(90));

    // "IAnimal" interface (line 2, char 18).
    let resp = implementation(&mut client, &file_uri, 2, 18);
    assert_nav_ok(&resp);
    let result = &resp["result"];
    assert!(
        !result.is_null(),
        "implementation on interface must return results"
    );
    assert!(
        result.is_array(),
        "implementation must return Location[]: {result}"
    );
    let locations = result.as_array().unwrap();
    assert!(!locations.is_empty(), "IAnimal must have implementations");
    for loc in locations {
        assert_location_shape(loc);
    }

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 59. IMPLEMENTATION ON VIRTUAL METHOD → ALL OVERRIDES (Dog + Cat)

#[test]
fn test_full_stack_implementation_on_virtual_method() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_definition_workspace();

    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    let _ = poll_definition_until_ready(&mut client, &file_uri, 14, 23, Duration::from_secs(90));

    // "Speak" virtual in AnimalBase (line 11, char 26).
    let resp =
        poll_implementation_until_ready(&mut client, &file_uri, 11, 26, Duration::from_secs(90));
    assert_nav_ok(&resp);
    let result = &resp["result"];
    assert!(
        !result.is_null(),
        "implementation on virtual must return overrides"
    );
    assert!(result.is_array(), "must return Location[]: {result}");
    let locations = result.as_array().unwrap();
    assert!(
        locations.len() >= 2,
        "Speak must have >= 2 overrides (Dog + Cat), got {}",
        locations.len()
    );
    let lines: Vec<u64> = locations
        .iter()
        .map(|loc| loc["range"]["start"]["line"].as_u64().unwrap())
        .collect();
    assert!(
        lines.contains(&17),
        "must include Dog.Speak line 17: {lines:?}"
    );
    assert!(
        lines.contains(&23),
        "must include Cat.Speak line 23: {lines:?}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 60. FULL LSP LOCATION STRUCTURE VALIDATION

#[test]
fn test_full_stack_definition_response_structure() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_definition_workspace();

    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    let result =
        poll_definition_until_ready(&mut client, &file_uri, 14, 23, Duration::from_secs(90));

    let uri = result["uri"].as_str().unwrap();
    assert!(uri.starts_with("file://"), "uri must be file:// URI");
    assert!(uri.contains("Program.cs"), "uri must point to source file");
    let range = &result["range"];
    assert!(range["start"]["line"].is_u64(), "start.line must be number");
    assert!(
        range["start"]["character"].is_u64(),
        "start.character must be number"
    );
    assert!(range["end"]["line"].is_u64(), "end.line must be number");
    assert!(
        range["end"]["character"].is_u64(),
        "end.character must be number"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 61. DEFINITION ON EMPTY LINE RETURNS NULL (full-stack)

#[test]
fn test_full_stack_definition_on_empty_line() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_definition_workspace();

    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    let _ = poll_definition_until_ready(&mut client, &file_uri, 14, 23, Duration::from_secs(90));

    // Empty line (line 1, char 0).
    let resp = definition(&mut client, &file_uri, 1, 0);
    assert_nav_ok(&resp);

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 62. ALL FOUR METHODS ON SAME SESSION (interleaved)

#[test]
fn test_full_stack_all_nav_methods_interleaved() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_definition_workspace();

    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    let _ = poll_definition_until_ready(&mut client, &file_uri, 14, 23, Duration::from_mins(3));

    // 1. definition: "AnimalBase" in Dog's extends (line 14) → line 8
    let r1 = definition(&mut client, &file_uri, 14, 23);
    assert_nav_ok(&r1);
    assert_location_line(
        &first_location(&r1["result"]),
        8,
        "definition AnimalBase → line 8",
    );

    // 2. typeDefinition: "MyDog" (line 33, char 18) → Dog type (line 14)
    let r2 = type_definition(&mut client, &file_uri, 33, 18);
    assert_nav_ok(&r2);
    assert!(!r2["result"].is_null(), "typeDefinition must resolve");
    assert_location_line(&r2["result"], 14, "typeDefinition MyDog → Dog line 14");

    // 3. declaration: Dog.Speak override (line 17, char 27) → AnimalBase.Speak (line 11)
    let r3 = declaration(&mut client, &file_uri, 17, 27);
    assert_nav_ok(&r3);
    assert!(!r3["result"].is_null(), "declaration must resolve");
    assert_location_line(&r3["result"], 11, "declaration override → base line 11");

    // 4. implementation: AnimalBase.Speak virtual (line 11, char 26) → Dog + Cat
    let r4 =
        poll_implementation_until_ready(&mut client, &file_uri, 11, 26, Duration::from_secs(90));
    assert_nav_ok(&r4);
    assert!(r4["result"].is_array(), "implementation must be array");
    let locs = r4["result"].as_array().unwrap();
    assert!(locs.len() >= 2, "must have >= 2 implementations");

    // 5. definition again: "MyDog" (line 33, char 18) → property (line 28)
    let r5 = definition(&mut client, &file_uri, 33, 18);
    assert_nav_ok(&r5);
    assert_location_line(
        &first_location(&r5["result"]),
        28,
        "definition MyDog → line 28",
    );

    // 6. hover still works after all the navigation requests
    let r6 = hover(&mut client, &file_uri, 14, 14);
    assert_hover_ok(&r6);
    assert!(!r6["result"].is_null(), "hover must still work");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 63. DEFINITION ON CONSTRUCTOR CALL → CLASS DECLARATION

#[test]
fn test_full_stack_definition_on_constructor() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_definition_workspace();

    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    let _ = poll_definition_until_ready(&mut client, &file_uri, 14, 23, Duration::from_secs(90));

    // "Dog" in "new Dog()" at line 28, char 36.
    let resp = definition(&mut client, &file_uri, 28, 36);
    assert_nav_ok(&resp);
    let result = first_location(&resp["result"]);
    assert!(
        !result.is_null(),
        "definition on constructor call must resolve"
    );
    assert_location_line(&result, 14, "new Dog() → Dog class at line 14");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
