// The CLI entry point, responsible for setting things up and starting the ball
// rolling;
use std::{env, sync::Arc};

use color_eyre::Result;
use openapi_merge::{compile_schemas, shell, sources};

mod test_support;

#[tokio::main]
async fn main() -> Result<()> {
    color_eyre::install()?;
    let vfs = Arc::new(vfs::PhysicalFS::new(env::current_dir()?));
    let mut slack_api_spec = sources::FileSource::new(
        vfs.clone(),
        "slack-api-specs/web-api/slack_web_openapi_v2.json",
    );
    let api_sources: Vec<&mut dyn compile_schemas::SchemaSourceLoader> = vec![&mut slack_api_spec];
    let compiler = compile_schemas::CompileEverything::new(api_sources);
    shell::Shell::new(env::args_os(), vfs, compiler)?
        .main()
        .await
}
