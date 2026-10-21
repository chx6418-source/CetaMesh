use std::{env, path::PathBuf};

fn main() {
    let manifest_dir =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let icon_path = manifest_dir.join("icons").join("icon.ico");
    assert!(
        icon_path.is_file(),
        "missing WhaleBridge icon {}; run npm run build:icons",
        icon_path.display()
    );
    println!("cargo:rerun-if-changed={}", icon_path.display());
    println!("cargo:rerun-if-changed=whalebridge.rc");

    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        embed_resource::compile("whalebridge.rc", embed_resource::NONE)
            .manifest_optional()
            .expect("embed WhaleBridge Windows icon resource");
    }
}
