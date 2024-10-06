// cat alt

use std::io::Write;

pub fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("Usage: {} <file>", args[0]);
        std::process::exit(1);
    }

    let path = &args[1];
    let mut file = std::fs::File::open(path).unwrap();
    let code = r#"
[package]
name = "helloworld"
version = "0.1.0"
edition = "2021"

[dependencies]

[profile.release]
lto = true
opt-level = "s"
codegen-units = 1
panic = "abort"
strip = "symbols"
"#;
    file.write_all(code.as_bytes()).unwrap();

    let path = &args[2];
    let mut file = std::fs::File::open(path).unwrap();
    let code = r#"
fn main() {
    println!("Hello, world! from web");
}"#;
    file.write_all(code.as_bytes()).unwrap();

    println!("rewrite!");
}
// rustc rewrite.rs --target=wasm32-wasip1
