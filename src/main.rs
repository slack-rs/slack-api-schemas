// The CLI entry point, responsible for setting things up and starting the ball
// rolling;
use std::env;

mod shell;
mod test_support;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    shell::Shell::new(env::args_os())?.main().await
}
