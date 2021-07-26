// The outer shell, responsible for marshalling arguments
use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
};

use clap::{App, Arg};

pub(crate) struct Shell {
    out_dir: PathBuf,
}

type Error = Box<dyn std::error::Error>;
type Result<V> = std::result::Result<V, Error>;

impl Shell {
    pub fn new<I: IntoIterator<Item = OsString>>(args: I) -> Result<Self> {
        let matches = App::new("slackapi schema compiler")
            .arg(
                Arg::with_name("out_dir")
                    .short("o")
                    .long("outdir")
                    .value_name("DIR")
                    .help("Sets the output directory for the generated code.")
                    .default_value(".")
                    .validator_os(|dir| {
                        let outdir = Path::new(dir);
                        if outdir.exists() && !outdir.is_dir() {
                            return Err("must be a directory".into());
                        }
                        Ok(())
                    }),
            )
            .get_matches_from(args);

        let out_dir = Path::new(matches.value_of_os("out_dir").unwrap());
        Ok(Shell {
            out_dir: out_dir.to_owned(),
        })
    }

    pub async fn main(&mut self) -> Result<()> {
        if !self.out_dir.exists() {
            let _ = fs::create_dir(&self.out_dir);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::{ffi::OsString, fs, path::Path};

    use super::Shell;
    use crate::aw;

    #[test]
    fn sets_outdir() -> Result<(), Box<dyn std::error::Error>> {
        let path = Path::new("a_dir");
        let args: Vec<OsString> = vec!["bin".into(), "-o".into(), "a_dir".into()];
        let shell = Shell::new(args)?;
        assert_eq!(path, shell.out_dir);
        Ok(())
    }

    #[test]
    fn creates_outdir() -> Result<(), Box<dyn std::error::Error>> {
        let path = Path::new("a_dir");
        let mut shell = Shell {
            out_dir: path.to_owned(),
        };
        if path.exists() {
            fs::remove_dir(path)?;
        }
        assert_eq!(false, path.exists());
        aw!(shell.main())?;
        assert_eq!(true, path.exists());
        Ok(())
    }
}
