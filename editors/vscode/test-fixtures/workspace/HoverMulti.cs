namespace HoverMulti
{
    public class Calculator
    {
        private int _count = 1;
        public string Name { get; set; } = string.Empty;
        public int Add(int a, int b) { return a + b + _count; }
    }
}
