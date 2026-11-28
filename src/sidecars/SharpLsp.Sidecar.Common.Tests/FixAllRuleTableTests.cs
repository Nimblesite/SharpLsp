using SharpLsp.Sidecar.Common.FixAll;

namespace SharpLsp.Sidecar.Common.Tests;

/// <summary>
/// Verifies the generated [FIXALL-MODEL] and [FIXALL-RULES-TABLE] entries in
/// <see cref="FixAllRuleTable"/>, including opposing-rule pairs.
/// </summary>
public sealed class FixAllRuleTableTests
{
    [Fact]
    public void Table_contains_fsharp_csharp_and_opposing_rule_pairs()
    {
        var byKey = FixAllRuleTable.Associations.ToDictionary(entry => entry.fixKey);

        // F# batch fixes and NuGet vulnerability enforcement.
        Assert.Equal(RuleLanguage.FSharp, byKey["SLSPF0102"].language);
        Assert.Contains(byKey["SLSPF0102"].rules, rule => rule.diagnosticId == "SLSPF0102");
        Assert.Contains(
            byKey["nuget.updateVulnerable"].rules.SelectMany(rule => rule.settings),
            setting => setting.sink == RuleSink.MsBuildProperty && setting.key == "WarningsAsErrors"
        );

        // Opposing C# pairs live in the data table: IDE0007↔IDE0008, IDE0160↔IDE0161, IDE0003↔IDE0009.
        AssertOpposingPair(byKey, "UseImplicitType", "IDE0007", "IDE0008");
        AssertOpposingPair(byKey, "UseExplicitType", "IDE0008", "IDE0007");
        AssertOpposingPair(byKey, "ConvertToFileScopedNamespace", "IDE0161", "IDE0160");
        AssertOpposingPair(byKey, "ConvertToBlockScopedNamespace", "IDE0160", "IDE0161");
        AssertOpposingPair(byKey, "RemoveThisQualification", "IDE0003", "IDE0009");
        AssertOpposingPair(byKey, "AddThisQualification", "IDE0009", "IDE0003");

        // Exercise FixAllRequest and RuleSetting record accessors.
        var req = new FixAllRequest("UseImplicitType", FixScope.Solution, true);
        Assert.Equal("UseImplicitType", req.fixKey);
        Assert.Equal(FixScope.Solution, req.scope);
        Assert.True(req.enforce);
    }

    private static void AssertOpposingPair(
        Dictionary<string, FixRuleAssociation> byKey,
        string fixKey,
        string enforcedId,
        string disabledId
    )
    {
        var assoc = byKey[fixKey];
        Assert.Equal(RuleLanguage.CSharp, assoc.language);
        var enforced = Assert.Single(assoc.rules, rule => rule.diagnosticId == enforcedId);
        Assert.Equal(RuleSeverity.Error, enforced.severity);
        Assert.NotEmpty(enforced.title);
        Assert.NotEmpty(enforced.settings);
        var disabled = Assert.Single(assoc.rules, rule => rule.diagnosticId == disabledId);
        Assert.Equal(RuleSeverity.None, disabled.severity);
        Assert.Contains(disabled.settings, setting =>
            setting.sink == RuleSink.EditorConfig && setting.value == "none"
        );
    }
}
