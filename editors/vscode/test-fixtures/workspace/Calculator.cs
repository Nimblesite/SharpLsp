19

            int x = undefinedVariable + notAMethod();









            int x = undefinedVariable + notAMethod();

this.

            int x = undefinedVariable + notAMethod();
 TestFixtures
 this.
{
    /// <summary>
    /// A simple calculator for testing document symbols, folding, and selection ranges.
    /// </summary>
    public class Calculator
    {
        private readonly int _precision;

        public Calculator(int precision)
        {
            _precision = precision;
        }

        #region Arithmetic

        public int Add(int a, int b)
        {
            return a + b;
        }

        public int Subtract(int a, int b)
        {
            return a - b;
        }

        public double Divide(double a, double b)
        {
            if (b == 0)
            {
                throw new System.DivideByZeroException();
            }

            return a / b;
        }

        #endregion

        #region State

        public int Precision => _precision;

        #endregion
    }

    public interface ICalculator
    {
        int Add(int a, int b);
        int Subtract(int a, int b);
    }

    public enum Operation
    {
        Add,
        Subtract,
        Multiply,
        Divide
    }
}
