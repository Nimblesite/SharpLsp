#pragma warning disable CA1515 // Public xUnit discovery type
#pragma warning disable CA2007 // xUnit executes without a synchronization context

using SharpLsp.Sidecar.CSharp.Razor;

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// The markup context at carets across projected HTML: complete and incomplete tags, quoted and
/// unquoted attributes, comments, declarations and raw text. Implements [RAZOR-TESTING] for
/// [RAZOR-ARCHITECTURE-HTML].
/// </summary>
public sealed class HtmlMarkupContextTests
{
    [Fact]
    public void Text_between_and_around_complete_tags_is_content()
    {
        Assert.Equal(MarkupContext.Content, Of("|<p>Hello</p>"));
        Assert.Equal(MarkupContext.TagName, Of("<|p>Hello</p>"));
        Assert.Equal(MarkupContext.Content, Of("<p>|Hello</p>"));
        Assert.Equal(MarkupContext.Content, Of("<p>Hello|</p>"));
        Assert.Equal(MarkupContext.Content, Of("<p>a</p>|<b>b</b>"));
        Assert.Equal(MarkupContext.Content, Of("<p>a</p><b>|b</b>"));
        Assert.Equal(MarkupContext.Content, Of("<p>a</p><b>b</b>|"));
    }

    [Fact]
    public void Tag_name_runs_from_the_open_bracket_to_the_first_break()
    {
        Assert.Equal(MarkupContext.TagName, Of("<|"));
        Assert.Equal(MarkupContext.TagName, Of("<d|iv"));
        Assert.Equal(MarkupContext.TagName, Of("<div|"));
        Assert.Equal(MarkupContext.TagName, Of("<DIV|"));
        Assert.Equal(MarkupContext.TagName, Of("<div| class=\"x\">"));
        Assert.Equal(MarkupContext.TagName, Of("</|"));
        Assert.Equal(MarkupContext.TagName, Of("</d|iv>"));
        Assert.Equal(MarkupContext.TagName, Of("</div|>"));
        Assert.Equal(MarkupContext.Content, Of("<div>|"));
        Assert.Equal(MarkupContext.Content, Of("<br/>|"));
    }

    [Fact]
    public void A_space_after_the_tag_name_opens_the_attribute_area()
    {
        Assert.Equal(MarkupContext.AttributeName, Of("<div |"));
        Assert.Equal(MarkupContext.AttributeName, Of("<div c|lass=\"x\">"));
        Assert.Equal(MarkupContext.AttributeName, Of("<div class|=\"x\">"));
        Assert.Equal(MarkupContext.AttributeName, Of("<div class | = \"x\">"));
        Assert.Equal(MarkupContext.AttributeName, Of("<div a='1' |"));
        Assert.Equal(MarkupContext.AttributeName, Of("<div a='1' b|>"));
        Assert.Equal(MarkupContext.AttributeName, Of("<div a=\"1\"|>"));
        Assert.Equal(MarkupContext.AttributeName, Of("<div a=\"1\" /|>"));
        Assert.Equal(MarkupContext.AttributeName, Of("<br /|>"));
    }

    [Fact]
    public void Attribute_values_hold_quoted_and_unquoted_forms()
    {
        Assert.Equal(MarkupContext.AttributeValue, Of("<div class=|"));
        Assert.Equal(MarkupContext.AttributeValue, Of("<div class=|\"x\">"));
        Assert.Equal(MarkupContext.AttributeValue, Of("<div class=\"|\""));
        Assert.Equal(MarkupContext.AttributeValue, Of("<div class=\"a|b\""));
        Assert.Equal(MarkupContext.AttributeValue, Of("<div class='a|'"));
        Assert.Equal(MarkupContext.AttributeValue, Of("<div class=a|"));
        Assert.Equal(MarkupContext.AttributeValue, Of("<div class=a| b>"));
        Assert.Equal(MarkupContext.AttributeValue, Of("<div class=\"http://a?b|\">"));
    }

    [Fact]
    public void A_greater_than_inside_a_quoted_value_does_not_close_the_tag()
    {
        Assert.Equal(MarkupContext.AttributeValue, Of("<div class=\"a > b|\""));
        Assert.Equal(MarkupContext.AttributeValue, Of("<div title=\"</scr|ipt>\">"));
        Assert.Equal(MarkupContext.AttributeName, Of("<div class=\"a > b\"|>"));
        Assert.Equal(MarkupContext.Content, Of("<div class=\"a > b\">|"));
    }

    [Fact]
    public void Incomplete_tags_keep_their_context_at_the_end_of_the_projection()
    {
        Assert.Equal(MarkupContext.TagName, Of("<div|"));
        Assert.Equal(MarkupContext.AttributeName, Of("<div |"));
        Assert.Equal(MarkupContext.AttributeName, Of("<div class|"));
        Assert.Equal(MarkupContext.AttributeValue, Of("<div class=|"));
        Assert.Equal(MarkupContext.AttributeValue, Of("<div class=\"x|"));
        Assert.Equal(MarkupContext.AttributeName, Of("<div class='x'|"));
        Assert.Equal(MarkupContext.AttributeName, Of("<div class='x' |"));
    }

    [Fact]
    public void Stray_less_than_signs_stay_content()
    {
        Assert.Equal(MarkupContext.Content, Of("1 < 2|"));
        Assert.Equal(MarkupContext.Content, Of("1<2|"));
        Assert.Equal(MarkupContext.Content, Of("x <3| and y > 2"));
        Assert.Equal(MarkupContext.Content, Of("< |div"));
        Assert.Equal(MarkupContext.TagName, Of("a <|b"));
        Assert.Equal(MarkupContext.TagName, Of("a <|"));
    }

    [Fact]
    public void Comments_hold_content_until_their_close()
    {
        Assert.Equal(MarkupContext.Content, Of("<!--|"));
        Assert.Equal(MarkupContext.Content, Of("<!-- <div class=|\"x\"> -->"));
        Assert.Equal(MarkupContext.Content, Of("<!-- a > b| -->"));
        Assert.Equal(MarkupContext.Content, Of("<!-- x <div|"));
        Assert.Equal(MarkupContext.Content, Of("<!-- a > b -->|"));
        Assert.Equal(MarkupContext.Content, Of("<!-- a > b -->|<div "));
        Assert.Equal(MarkupContext.TagName, Of("<!-- a > b --><|div "));
    }

    [Fact]
    public void Abrupt_and_bang_comments_close_like_the_tokenizer_closes_them()
    {
        Assert.Equal(MarkupContext.Content, Of("<!-->|<div "));
        Assert.Equal(MarkupContext.AttributeName, Of("<!--><div |"));
        Assert.Equal(MarkupContext.AttributeName, Of("<!---><div |"));
        Assert.Equal(MarkupContext.TagName, Of("<!-- x --!><p|>"));
        Assert.Equal(MarkupContext.Content, Of("<!-- x -- |-->|"));
    }

    [Fact]
    public void Declarations_and_processing_instructions_stay_content()
    {
        Assert.Equal(MarkupContext.Content, Of("<!DOCTYPE html|>"));
        Assert.Equal(MarkupContext.AttributeName, Of("<!DOCTYPE html><div |"));
        Assert.Equal(MarkupContext.Content, Of("<?xml |"));
        Assert.Equal(MarkupContext.Content, Of("<?xml version=\"1.0\"?>|"));
        Assert.Equal(MarkupContext.TagName, Of("<?p?><b|r>"));
        Assert.Equal(MarkupContext.Content, Of("<![CDATA[ x < y |]]>"));
        Assert.Equal(MarkupContext.AttributeName, Of("<![CDATA[x]]><div |"));
    }

    [Fact]
    public void Raw_text_hides_markup_until_its_own_end_tag()
    {
        Assert.Equal(MarkupContext.Content, Of("<script>var a = \"<div class=|'x'>\";</script>"));
        Assert.Equal(MarkupContext.Content, Of("<script>if (a < b && c > d) { }|</script>"));
        Assert.Equal(MarkupContext.AttributeName, Of("<script>if (a < b) {}</script><div |"));
        Assert.Equal(MarkupContext.Content, Of("<style>p > q| { }</style>"));
        Assert.Equal(MarkupContext.TagName, Of("<style>p{}</style><h|1>"));
        Assert.Equal(MarkupContext.Content, Of("<textarea><div|</textarea>"));
        Assert.Equal(MarkupContext.Content, Of("<title>a < b|</title>"));
        Assert.Equal(MarkupContext.Content, Of("<iframe><div|</iframe>"));
        Assert.Equal(MarkupContext.Content, Of("<xmp><b|</xmp>"));
    }

    [Fact]
    public void Raw_text_matches_its_end_tag_case_insensitively()
    {
        Assert.Equal(MarkupContext.Content, Of("<SCRIPT>x|</SCRIPT>"));
        Assert.Equal(MarkupContext.TagName, Of("<SCRIPT>x</SCR|IPT>"));
        Assert.Equal(MarkupContext.Content, Of("<SCRIPT>x</SCRIPT>|"));
    }

    [Fact]
    public void Raw_text_end_tag_names_flip_to_tag_name_only_when_appropriate()
    {
        Assert.Equal(MarkupContext.TagName, Of("<script>x</script|"));
        Assert.Equal(MarkupContext.TagName, Of("<script>x</script|>"));
        Assert.Equal(MarkupContext.TagName, Of("<textarea>a</textarea|"));
        Assert.Equal(MarkupContext.TagName, Of("<script>x</script></|"));
        // The full projection determines whether the closing tag is appropriate; the caret
        // may sit partway through its name ([RAZOR-ARCHITECTURE-HTML]).
        Assert.Equal(MarkupContext.TagName, Of("<script>x</scr|ipt>"));
        Assert.Equal(MarkupContext.Content, Of("<script>x</scripty|>"));
        Assert.Equal(MarkupContext.Content, Of("<script>var s = \"</scr\" + \"ipt>\";</scr|"));
    }

    [Fact]
    public void A_self_closed_script_still_reads_raw_text_like_the_tokenizer()
    {
        Assert.Equal(MarkupContext.Content, Of("<script/><div|"));
        Assert.Equal(MarkupContext.Content, Of("<script />if (a < b)|"));
    }

    [Fact]
    public void Offsets_outside_the_projection_clamp_into_range()
    {
        Assert.Equal(MarkupContext.Content, HtmlMarkupContext.At(string.Empty, 0));
        Assert.Equal(MarkupContext.Content, HtmlMarkupContext.At(string.Empty, 5));
        Assert.Equal(MarkupContext.Content, HtmlMarkupContext.At(string.Empty, -1));
        Assert.Equal(MarkupContext.Content, HtmlMarkupContext.At("<div", -3));
        Assert.Equal(MarkupContext.TagName, HtmlMarkupContext.At("<div", 99));
        Assert.Equal(MarkupContext.AttributeValue, HtmlMarkupContext.At("<div a=x", 8));
    }

    [Fact]
    public void Every_offset_of_a_document_maps_to_its_context()
    {
        const string html = "<div a=\"1\">x</div>";
        Assert.Equal("CTTTTNNVVVNCCTTTTTC", Map(html));
    }

    [Theory]
    [InlineData("<script type='text/javascript'><div|")]
    [InlineData("<script type=text/javascript><div|")]
    [InlineData("<script async><div|")]
    [InlineData("<style media='screen'><div|")]
    [InlineData("<!-- <div> hello <span| -->")]
    public void Raw_text_attributes_and_nested_comment_markup_remain_content(string html)
    {
        Assert.Equal(MarkupContext.Content, Of(html));
    }

    [Theory]
    [InlineData("<!DOCTYPE html PUBLIC \"x> <div|\">", "Content")]
    [InlineData("<script><!--<script></script><div|--></script>", "Content")]
    [InlineData("<script><!--<script></script>--></script><div|", "TagName")]
    [InlineData("<script><!--<script>--></script><div|", "TagName")]
    [InlineData("<script><!-- x </script><div|", "TagName")]
    public void Declaration_quotes_and_script_escape_states_follow_html_tokens(
        string html,
        string expected
    )
    {
        Assert.Equal(expected, Of(html).ToString());
    }

    private static MarkupContext Of(string withCaret)
    {
        var at = withCaret.IndexOf('|', StringComparison.Ordinal);
        return HtmlMarkupContext.At(withCaret.Remove(at, 1), at);
    }

    private static string Map(string html)
    {
        return string.Create(
            html.Length + 1,
            html,
            static (span, text) =>
            {
                for (var i = 0; i <= text.Length; i++)
                {
                    span[i] = HtmlMarkupContext.At(text, i) switch
                    {
                        MarkupContext.Content => 'C',
                        MarkupContext.TagName => 'T',
                        MarkupContext.AttributeName => 'N',
                        MarkupContext.AttributeValue => 'V',
                        _ => '?',
                    };
                }
            }
        );
    }
}
