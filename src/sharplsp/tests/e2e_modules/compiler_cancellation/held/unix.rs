//! A native FIFO holds real FCS I/O. [DIAG-ANALYSIS-CANCELLATION]
use super::*;
use std::fs::{File, OpenOptions};

pub struct Source {
    path: PathBuf,
    original: String,
}
pub struct Reader {
    source: Source,
    writer: File,
}

impl Source {
    pub fn new(path: &Path, original: &str) -> io::Result<Self> {
        std::fs::remove_file(path)?;
        let created = Command::new("mkfifo").arg(path).output()?;
        if !created.status.success() {
            return Err(io::Error::other("native FIFO creation failed"));
        }
        Ok(Self {
            path: path.to_owned(),
            original: original.to_owned(),
        })
    }

    pub fn opened(self) -> io::Result<Reader> {
        let writer = OpenOptions::new().write(true).open(&self.path)?;
        Ok(Reader {
            source: self,
            writer,
        })
    }
}

impl Reader {
    pub fn release(mut self) -> io::Result<()> {
        // Replace the path before EOF so later FCS reads cannot reopen the abandoned FIFO.
        std::fs::remove_file(&self.source.path)?;
        std::fs::write(&self.source.path, &self.source.original)?;
        self.writer.write_all(self.source.original.as_bytes())
    }
}
