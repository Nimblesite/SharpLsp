using System;

namespace SharpLsp.TestFixtures.RenameCoverage;

public static class RenameUsage
{
    public static int Exercise()
    {
        var derived = new RenameDerived();
        RenameBase baseValue = derived;
        IExplicitRenameContract explicitValue = derived;
        var operatorValue = derived + derived;
        var conversionValue = (int)operatorValue;
        var hierarchyValue = baseValue.VirtualMember(2) + explicitValue.ExplicitMember(3);
        var renameClass = new RenameClass<int>(3);
        IRenameContract<int> contract = renameClass;
        renameClass.RenameEvent += HandleEvent;
        renameClass.RenameProperty = 7;
        renameClass[1] = renameClass.RenameProperty;
        var renameRecord = new RenameRecord(renameClass.RenameMethod(2));
        var renameStruct = new RenameStruct(renameRecord.RecordComponent);
        RenameDelegate renameDelegate = delegateValue => delegateValue + renameStruct.Value;
        var renameEnum = RenameEnum.FirstMember;
        return renameDelegate(contract.Transform(renameClass[1], renameEnum))
            + conversionValue
            + hierarchyValue;
    }

    private static void HandleEvent(object? sender, EventArgs eventArgs)
    {
        _ = sender;
        _ = eventArgs;
    }
}
