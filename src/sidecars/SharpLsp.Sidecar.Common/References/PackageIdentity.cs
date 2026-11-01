namespace SharpLsp.Sidecar.Common.References;

/// <summary>A NuGet package at one version. [REFACTOR-IMPORT-REFERENCE]</summary>
/// <param name="Id">The package id, as the project's restore spelled it.</param>
/// <param name="Version">The restored version.</param>
public sealed record PackageIdentity(string Id, string Version);
