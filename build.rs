//! Build script: emits compile-time env vars for the Shipwright version contract.
fn main() {
    println!(
        "cargo:rustc-env=TARGET={}",
        std::env::var("TARGET").unwrap_or_default()
    );
    println!("cargo:rerun-if-env-changed=TARGET");
}
