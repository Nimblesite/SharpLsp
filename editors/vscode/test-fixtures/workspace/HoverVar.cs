namespace HoverVar
{
    public class Gadget { public int Size { get; set; } }
    public class Runner
    {
        public void Go()
        {
            var g = new Gadget();
            var s = g.Size;
        }
    }
}
