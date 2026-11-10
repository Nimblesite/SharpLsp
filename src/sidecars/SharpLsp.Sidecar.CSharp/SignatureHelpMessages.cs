using MessagePack;

namespace SharpLsp.Sidecar.CSharp;

/// <summary>
/// One overload offered by signature help. Positional, wire-compatible with the
/// Rust host's <c>SidecarSignatureInfo</c> and the F# sidecar's
/// <c>SignatureInfoResult</c>. Every parameter label appears verbatim in
/// <see cref="Label"/>, which is how an editor finds the span to highlight.
/// Implements [SHARPLSP-FEATURES-INTELLIGENCE-SIGNATURE-HELP].
/// </summary>
[MessagePackObject(AllowPrivate = true)]
internal sealed record SignatureInfoResult(
    [property: Key(0)] string Label,
    [property: Key(1)] List<string> Parameters
);

/// <summary>
/// Signature help for one caret: every overload the call could bind to, the one
/// it binds to, and the parameter the caret is filling. Wire-compatible with the
/// host's <c>SidecarSignatureHelp</c>.
/// </summary>
[MessagePackObject(AllowPrivate = true)]
internal sealed record SignatureHelpResult(
    [property: Key(0)] List<SignatureInfoResult> Signatures,
    [property: Key(1)] int ActiveSignature,
    [property: Key(2)] int ActiveParameter
);
