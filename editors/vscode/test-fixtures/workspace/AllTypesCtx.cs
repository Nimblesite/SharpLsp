namespace AllTypesNS
{
    public delegate void MyDelegate(string msg);
    public enum MyEnum { Alpha, Beta }
    public interface IRunner { void Run(); }
    public struct MyPoint { public int X; public int Y; }
    public record MyRecord(string Value);

    public class AllTypesClass
    {
        private int _count;
        public event EventHandler Changed;
        public AllTypesClass() { }
        public string Label { get; set; }
        public void Execute() { }
    }
}