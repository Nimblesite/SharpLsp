using System.Text;

namespace CsTags;

// Obsolete uses strike through; unused code greys out. [DIAG-CATEGORIES-TAGS]
public static class Tagged
{
    [System.Obsolete("Use Fresh")]
    public static int Stale() => 1;

    public static int Fresh() => Stale();

    private static int Unused() => 2;
}
