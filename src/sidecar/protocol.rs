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

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code — panics are the correct failure mode"
)]
mod tests {
    use super::*;

    #[test]
    fn request_creates_correct_envelope() {
        let env = Envelope::request(42, "test/method", vec![1, 2, 3]);
        assert_eq!(env.id, Some(42));
        assert_eq!(env.method.as_deref(), Some("test/method"));
        assert_eq!(env.payload, vec![1, 2, 3]);
        assert!(env.error.is_none());
    }

    #[test]
    fn envelope_roundtrip_via_messagepack() {
        let original = Envelope::request(1, "ping", vec![0xAA]);
        let bytes = rmp_serde::to_vec(&original).unwrap();
        let decoded: Envelope = rmp_serde::from_slice(&bytes).unwrap();
        assert_eq!(decoded.id, original.id);
        assert_eq!(decoded.method, original.method);
        assert_eq!(decoded.payload, original.payload);
        assert!(decoded.error.is_none());
    }
}
