//! OTLP export of request spans and metrics, for whoever operates the server:
//! a collector on the developer's machine or a team's own backend.
//! Implements [SHARPLSP-TECHNOLOGY-TELEMETRY].
//!
//! Off unless an OTLP endpoint is named in the environment, the standard
//! OpenTelemetry way; nothing is exported anywhere by default. Spans and
//! metrics carry methods, compiler names, outcomes and durations, never
//! document text.

use std::sync::OnceLock;
use std::time::Duration;

use opentelemetry::metrics::{Counter, Histogram};
use opentelemetry::trace::TracerProvider as _;
use opentelemetry::KeyValue;
use opentelemetry_sdk::metrics::SdkMeterProvider;
use opentelemetry_sdk::trace::{SdkTracerProvider, Tracer};
use opentelemetry_sdk::Resource;

/// The service and instrumentation scope every signal is reported under.
const SERVICE: &str = "sharplsp";

/// The environment variables that name an OTLP endpoint; any one turns export on.
const ENDPOINTS: [&str; 3] = [
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
];

/// Whether `lookup` names an OTLP endpoint.
fn enabled(lookup: impl Fn(&str) -> Option<String>) -> bool {
    ENDPOINTS
        .iter()
        .any(|name| lookup(name).is_some_and(|value| !value.trim().is_empty()))
}

/// The request instruments; `None` while export is off.
static INSTRUMENTS: OnceLock<Instruments> = OnceLock::new();

/// What every request is measured with.
struct Instruments {
    /// How long each request took, in milliseconds.
    duration: Histogram<f64>,
    /// How many requests were answered.
    requests: Counter<u64>,
}

/// The running exporters; dropping it flushes what is buffered.
pub struct Telemetry {
    /// Batches spans to the collector.
    traces: SdkTracerProvider,
    /// Reports metrics to the collector on an interval.
    metrics: SdkMeterProvider,
}

impl Telemetry {
    /// Start exporting when the environment names an OTLP endpoint. A
    /// collector that cannot be configured leaves export off; the reason goes
    /// to stderr, because logging is not up yet.
    pub fn start() -> Option<Self> {
        if !enabled(|name| std::env::var(name).ok()) {
            return None;
        }
        match Self::exporting() {
            Ok(telemetry) => Some(telemetry),
            Err(error) => {
                eprintln!("sharplsp: OTLP export is off: {error}");
                None
            }
        }
    }

    /// Build both exporters from the standard `OTEL_*` environment.
    fn exporting() -> anyhow::Result<Self> {
        let resource = Resource::builder().with_service_name(SERVICE).build();
        let spans = opentelemetry_otlp::SpanExporter::builder()
            .with_http()
            .build()?;
        let traces = SdkTracerProvider::builder()
            .with_batch_exporter(spans)
            .with_resource(resource.clone())
            .build();
        let measurements = opentelemetry_otlp::MetricExporter::builder()
            .with_http()
            .build()?;
        let metrics = SdkMeterProvider::builder()
            .with_periodic_exporter(measurements)
            .with_resource(resource)
            .build();
        opentelemetry::global::set_meter_provider(metrics.clone());
        let meter = opentelemetry::global::meter(SERVICE);
        let _ = INSTRUMENTS.set(Instruments {
            duration: meter
                .f64_histogram("sharplsp.request.duration")
                .with_unit("ms")
                .with_description("How long an LSP request took to answer")
                .build(),
            requests: meter
                .u64_counter("sharplsp.requests")
                .with_description("LSP requests answered")
                .build(),
        });
        Ok(Self { traces, metrics })
    }

    /// The tracer `tracing` spans are exported through.
    pub fn tracer(&self) -> Tracer {
        self.traces.tracer(SERVICE)
    }
}

impl Drop for Telemetry {
    fn drop(&mut self) {
        // The process is ending: export what is buffered, and say so on stderr
        // when the collector is gone, since the log sinks are closing too.
        for (signal, flushed) in [
            ("traces", self.traces.shutdown()),
            ("metrics", self.metrics.shutdown()),
        ] {
            if let Err(error) = flushed {
                eprintln!("sharplsp: OTLP {signal} were not flushed: {error}");
            }
        }
    }
}

/// The span one LSP request is exported as; no span at all while export is
/// off, so the log lines of a default run are unchanged.
pub fn request_span(method: &str) -> tracing::Span {
    if INSTRUMENTS.get().is_some() {
        tracing::info_span!("lsp.request", rpc.method = %method)
    } else {
        tracing::Span::none()
    }
}

/// The span one compiler exchange is exported as, inside its request's.
pub fn sidecar_span(sidecar: &str, method: &str) -> tracing::Span {
    if INSTRUMENTS.get().is_some() {
        tracing::info_span!("sidecar.request", sidecar = %sidecar, rpc.method = %method)
    } else {
        tracing::Span::none()
    }
}

/// Count one answered request and how long it took. Costs one atomic load
/// while export is off.
pub fn record_request(method: &str, elapsed: Duration, succeeded: bool) {
    let Some(instruments) = INSTRUMENTS.get() else {
        return;
    };
    let attributes = [
        KeyValue::new("rpc.method", method.to_owned()),
        KeyValue::new("outcome", if succeeded { "ok" } else { "error" }),
    ];
    instruments
        .duration
        .record(elapsed.as_secs_f64() * 1000.0, &attributes);
    instruments.requests.add(1, &attributes);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_is_off_until_an_endpoint_is_named() {
        assert!(!enabled(|_| None), "nothing is exported by default");
        assert!(
            !enabled(|_| Some("  ".to_owned())),
            "a blank endpoint names nothing"
        );
        for name in ENDPOINTS {
            let named = |asked: &str| (asked == name).then(|| "http://127.0.0.1:4318".to_owned());
            assert!(enabled(named), "{name} turns export on");
        }
        let unrelated = |asked: &str| (asked == "OTEL_SERVICE_NAME").then(|| "x".to_owned());
        assert!(!enabled(unrelated), "other OTEL settings do not");
        // Off: recording is a no-op and no span exists to change a log line.
        record_request("textDocument/hover", Duration::from_millis(3), true);
        assert!(request_span("textDocument/hover").is_none());
        assert!(sidecar_span("C# (Roslyn)", "textDocument/hover").is_none());
    }
}
