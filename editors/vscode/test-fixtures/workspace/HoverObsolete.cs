namespace HoverObsolete
{
    public class Legacy
    {
        [System.Obsolete("Use NewMethod instead")]
        public void OldMethod() { }
        public void NewMethod() { }
    }
}
