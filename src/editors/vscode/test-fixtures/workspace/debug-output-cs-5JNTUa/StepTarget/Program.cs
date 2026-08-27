using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading.Tasks;

namespace StepTarget;

[DebuggerDisplay("Box({Label},{Value})")]
public sealed class Box
{
    public Box(int value, string label)
    {
        Value = value;                                                 // @anchor:box-ctor-value
        Label = label;                                                 // @anchor:box-ctor-label
    }

    public int Value { get; }

    public string Label { get; }

    public string Describe()
    {
        var rendered = Label + "=" + Value.ToString();                 // @anchor:box-describe
        return rendered;                                               // @anchor:box-describe-return
    }
}

public static class Program
{
    public static int Total;                                           // @anchor:total-field

    public static int Add(int left, int right)                         // @anchor:add-signature
    {
        var sum = left + right;                                        // @anchor:add-body
        return sum;                                                    // @anchor:add-return
    }

    public static int Accumulate(int seed)
    {
        var running = seed;                                            // @anchor:accumulate-entry
        for (var index = 1; index <= 3; index++)                        // @anchor:accumulate-loop
        {
            running = Add(running, index);                             // @anchor:accumulate-call
        }

        Total = running;                                               // @anchor:accumulate-store
        return running;                                                // @anchor:accumulate-return
    }

    public static void ThrowCaught()
    {
        try
        {
            throw new InvalidOperationException("caught-by-design");    // @anchor:throw-caught
        }
        catch (InvalidOperationException error)
        {
            Console.WriteLine("handled " + error.Message);              // @anchor:catch-caught
        }
    }

    public static void ThrowUnhandled()
    {
        throw new ApplicationException("unhandled-by-design", new FormatException("inner-cause")); // @anchor:throw-unhandled
    }

    public static int Inspect(Box box)
    {
        var numbers = new List<int> { 10, 20, 30 };                    // @anchor:inspect-list
        var lookup = new Dictionary<string, int> { ["alpha"] = 1 };    // @anchor:inspect-map
        var letters = new[] { 'a', 'b' };                              // @anchor:inspect-array
        int? maybe = 42;                                               // @anchor:inspect-nullable
        var text = box.Describe();                                     // @anchor:inspect-describe
        Console.WriteLine(text + " " + lookup.Count.ToString() + " " + letters.Length.ToString()); // @anchor:inspect-print
        return numbers.Count + maybe.Value;                            // @anchor:inspect-return
    }

    public static async Task<int> LeafAsync(int seed)
    {
        await Task.Yield();                                            // @anchor:leaf-await
        return seed + 1;                                               // @anchor:leaf-return
    }

    public static async Task<int> MiddleAsync(int seed)
    {
        var leaf = await LeafAsync(seed);                              // @anchor:middle-await
        return leaf * 2;                                               // @anchor:middle-return
    }

    public static async Task<int> RootAsync(int seed)
    {
        var middle = await MiddleAsync(seed);                          // @anchor:root-await
        return middle + 1;                                             // @anchor:root-return
    }

    public static int Main(string[] args)
    {
        var mode = args.Length > 0 ? args[0] : "plain";                // @anchor:main-mode
        Console.WriteLine("env=" + (Environment.GetEnvironmentVariable("SHARPLSP_DEBUG_PROBE") ?? "unset")); // @anchor:main-env
        var total = Accumulate(2);                                     // @anchor:main-accumulate
        var box = new Box(total, "boxed");                             // @anchor:main-box
        Console.WriteLine("total=" + total.ToString());                // @anchor:main-print
        var count = Inspect(box);                                      // @anchor:main-inspect
        if (mode == "caught" || mode == "both")
        {
            ThrowCaught();                                             // @anchor:main-caught
        }

        if (mode == "async" || mode == "both")
        {
            Console.WriteLine(RootAsync(1).GetAwaiter().GetResult());  // @anchor:main-async
        }

        if (mode == "unhandled" || mode == "both")
        {
            ThrowUnhandled();                                          // @anchor:main-unhandled
        }

        if (mode == "wait")
        {
            System.Threading.Thread.Sleep(20000);                      // @anchor:main-wait
        }

        Console.WriteLine("done " + mode + " " + count.ToString());    // @anchor:main-done
        return 0;                                                      // @anchor:main-return
    }
}
