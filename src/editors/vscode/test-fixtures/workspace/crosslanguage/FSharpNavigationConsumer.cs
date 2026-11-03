using FSharpFixtures.CrossLanguageNavigation;

namespace CSharpConsumer;

/// <summary>Every F# declaration kind, read from C#. [DEFINITION-CROSSLANG]</summary>
public static class FSharpNavigationConsumer
{
    public static object[] Uses(NavClass instance, INavContract contract, NavGenericBox<int> box)
    {
        var record = new NavRecord(1, "two");
        var empty = NavUnion.NavCaseEmpty;
        var withPayload = NavUnion.NewNavCaseWith(3);
        var payloadCase = (NavUnion.NavCaseWith)withPayload;
        var payload = payloadCase.navPayload;
        var isEmpty = empty.IsNavCaseEmpty;
        var enumValue = NavEnum.NavEnumTwo;
        var structValue = new NavStruct(4);
        var constructed = new NavClass(5);
        instance.NavMutable = instance.NavProperty;
        var nested = new NavModule.NavNestedRecord(6);
        var failure = new NavFailure("seven");
        var shade = NavShade.NavLight;
        var generic = NavGenericUnion<int>.NewNavGenericCase(18);
        var genericCase = (NavGenericUnion<int>.NavGenericCase)generic;
        var genericEmpty = NavGenericUnion<int>.NavGenericEmpty;
        return
        [
            record.Equals(record),
            withPayload.Tag,
            failure.Data0,
            shade,
            genericCase.Item,
            genericEmpty.IsNavGenericEmpty,
            record.NavField,
            structValue.NavStructField,
            enumValue,
            payload,
            isEmpty,
            constructed,
            nested.NavNestedField,
            failure,
            instance.NavMethod(8),
            instance.NavOverload(9),
            instance.NavOverload("ten"),
            instance.NavGenericMethod<int>(11),
            NavClass.NavStatic(12),
            contract.NavContractCall(13),
            box.NavUnbox,
            NavModule.navValue,
            NavModule.navFunction(14, 15),
            NavModule.navGenericFunction<int>(16),
            NavModule.NavInner.navInnerFunction(17),
            NavRecordModule.navSuffixed(record),
            NavExtensions.NavExtended(instance),
        ];
    }
}
