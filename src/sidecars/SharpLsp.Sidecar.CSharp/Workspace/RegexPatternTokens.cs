namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// The syntax of a .NET regular-expression pattern, as index ranges over the pattern's
/// characters: escapes, character classes, groups, quantifiers, anchors and alternation.
/// Everything outside the ranges is literal text. A tokenizer, not a validator: an
/// unterminated construct runs to the end of the pattern.
/// Implements [SHARPLSP-FEATURES-HIGHLIGHTING-REGEX].
/// </summary>
internal static class RegexPatternTokens
{
    /// <summary>The <c>[start, end)</c> ranges of the pattern's syntax, in order.</summary>
    public static List<(int Start, int End)> Of(string pattern)
    {
        var ranges = new List<(int, int)>();
        var index = 0;
        while (index < pattern.Length)
        {
            var end = SyntaxEnd(pattern, index);
            if (end > index)
            {
                ranges.Add((index, end));
            }
            index = Math.Max(end, index + 1);
        }
        return ranges;
    }

    /// <summary>Where the syntax starting at <paramref name="at"/> ends; <paramref name="at"/> itself for a literal.</summary>
    private static int SyntaxEnd(string pattern, int at)
    {
        return pattern[at] switch
        {
            '\\' => EscapeEnd(pattern, at),
            '[' => ClassEnd(pattern, at),
            '(' => GroupOpenEnd(pattern, at),
            ')' or '|' or '^' or '$' or '.' => at + 1,
            '*' or '+' or '?' => LazyEnd(pattern, at + 1),
            '{' => CountEnd(pattern, at),
            _ => at,
        };
    }

    /// <summary>One past <paramref name="at"/>, or two when a lazy <c>?</c> follows.</summary>
    private static int LazyEnd(string pattern, int at)
    {
        return at < pattern.Length && pattern[at] == '?' ? at + 1 : at;
    }

    /// <summary>The first index at or after <paramref name="from"/> holding <paramref name="closer"/>, plus one.</summary>
    private static int Through(string pattern, int from, char closer)
    {
        var found = pattern.IndexOf(closer, Math.Min(from, pattern.Length));
        return found < 0 ? pattern.Length : found + 1;
    }

    private static int EscapeEnd(string pattern, int at)
    {
        return at + 1 >= pattern.Length
            ? pattern.Length
            : pattern[at + 1] switch
            {
                'p' or 'P' when Follows(pattern, at + 2, '{') => Through(pattern, at + 2, '}'),
                'k' when Follows(pattern, at + 2, '<') => Through(pattern, at + 2, '>'),
                'u' => Math.Min(at + 6, pattern.Length),
                'x' => Math.Min(at + 4, pattern.Length),
                'c' => Math.Min(at + 3, pattern.Length),
                >= '0' and <= '9' => DigitsEnd(pattern, at + 1),
                _ => at + 2,
            };
    }

    private static bool Follows(string pattern, int at, char expected)
    {
        return at < pattern.Length && pattern[at] == expected;
    }

    private static int DigitsEnd(string pattern, int at)
    {
        var end = at;
        while (end < pattern.Length && char.IsAsciiDigit(pattern[end]))
        {
            end++;
        }
        return end;
    }

    /// <summary>A whole <c>[...]</c> class: a leading <c>]</c> is a member, an escape hides its character, only a subtraction nests.</summary>
    private static int ClassEnd(string pattern, int at)
    {
        var index = Follows(pattern, at + 1, '^') ? at + 2 : at + 1;
        index = Follows(pattern, index, ']') ? index + 1 : index;
        var depth = 1;
        while (index < pattern.Length && depth > 0)
        {
            depth += pattern[index] switch
            {
                '[' when OpensSubtraction(pattern, index) => 1,
                ']' => -1,
                _ => 0,
            };
            index += pattern[index] == '\\' ? 2 : 1;
        }
        return Math.Min(index, pattern.Length);
    }

    /// <summary>
    /// True when the <c>[</c> at <paramref name="at"/> opens a subtraction (<c>-[…]</c>). Any
    /// other <c>[</c> inside a class is a literal member: <c>[a[b]</c> ends at its first <c>]</c>.
    /// The <c>-</c> is escaped only behind an ODD run of backslashes: <c>[\\-[x]]</c> subtracts.
    /// </summary>
    private static bool OpensSubtraction(string pattern, int at)
    {
        return at > 0 && pattern[at - 1] == '-' && BackslashesBefore(pattern, at - 1) % 2 == 0;
    }

    /// <summary>How many backslashes run immediately before <paramref name="at"/>.</summary>
    private static int BackslashesBefore(string pattern, int at)
    {
        var start = at;
        while (start > 0 && pattern[start - 1] == '\\')
        {
            start--;
        }
        return at - start;
    }

    /// <summary><c>(</c> with its prefix: <c>(?:</c>, <c>(?=</c>, <c>(?&lt;name&gt;</c>, inline options; a comment group whole.</summary>
    private static int GroupOpenEnd(string pattern, int at)
    {
        return !Follows(pattern, at + 1, '?') || at + 2 >= pattern.Length
            ? at + 1
            : pattern[at + 2] switch
            {
                '#' => Through(pattern, at + 2, ')'),
                ':' or '=' or '!' or '>' => at + 3,
                '<' when Follows(pattern, at + 3, '=') || Follows(pattern, at + 3, '!') => at + 4,
                '<' => Through(pattern, at + 3, '>'),
                '\'' => Through(pattern, at + 3, '\''),
                _ => OptionsEnd(pattern, at + 2),
            };
    }

    /// <summary>Inline options <c>imnsx-imnsx</c>, with the <c>:</c> that scopes them to the group.</summary>
    private static int OptionsEnd(string pattern, int at)
    {
        var end = at;
        while (end < pattern.Length && (char.IsAsciiLetter(pattern[end]) || pattern[end] == '-'))
        {
            end++;
        }
        return Follows(pattern, end, ':') ? end + 1 : end;
    }

    /// <summary><c>{n}</c>, <c>{n,}</c> or <c>{n,m}</c> with its lazy <c>?</c>; any other brace is literal.</summary>
    private static int CountEnd(string pattern, int at)
    {
        var low = DigitsEnd(pattern, at + 1);
        var high = Follows(pattern, low, ',') ? DigitsEnd(pattern, low + 1) : low;
        return low > at + 1 && Follows(pattern, high, '}') ? LazyEnd(pattern, high + 1) : at;
    }
}
