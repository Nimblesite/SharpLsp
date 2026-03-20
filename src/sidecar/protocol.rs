//! `MessagePack` wire protocol types matching the .NET `Envelope` contract.

use serde::{Deserialize, Serialize};

/// Wire envelope for sidecar IPC.
/// Matches `Forge.Sidecar.Common.Messages.Envelope` (`MessagePack` keyed).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Envelope {
    /// Request/response correlation ID. `None` for notifications.
    pub id: Option<u32>,
    /// Method name for requests. `None` for responses.
    pub method: Option<String>,
    /// `MessagePack`-encoded payload bytes.
    #[serde(with = "serde_bytes")]
    pub payload: Vec<u8>,
    /// Error message for error responses.
    pub error: Option<String>,
}

impl Envelope {
    /// Create a request envelope.
    pub fn request(id: u32, method: &str, payload: Vec<u8>) -> Self {
        Self {
            id: Some(id),
            method: Some(method.to_string()),
            payload,
            error: None,
        }
    }
}
