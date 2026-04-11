namespace HoverXmlDoc
{
    public class MathHelper
    {
        /// <summary>Computes the factorial of n.</summary>
        /// <param name="n">The input value, must be non-negative.</param>
        /// <returns>The factorial result.</returns>
        public long Factorial(int n)
        {
            return n <= 1 ? 1 : n * Factorial(n - 1);
        }
    }
}
