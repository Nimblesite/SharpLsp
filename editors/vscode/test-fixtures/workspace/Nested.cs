namespace TestFixtures.Nested
{
    public class Outer
    {
        public class Inner
        {
            public void InnerMethod() { }
        }

        public void OuterMethod()
        {
            var inner = new Inner();
        }

        public class AnotherInner
        {
            public int Value { get; set; }
        }
    }
}
