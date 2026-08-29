// Client `evaluate` requests, with the T1 expressions netcoredbg refuses
// answered by the router itself.
//
// Implements the "Expression evaluation quality tiers" table of
// [DEBUG-FEATURES-VARIABLES]: the T1 rows "Null checks, type casts" are
// specified as working in Phase 4, but netcoredbg 3.2.0 fails `x == null`
// with `0x80070057`/`CS0019`, `x is null` with `ConstantPattern not
// implemented!` and every cast with `CastExpression not implemented!`.
//
// THE GOVERNING RULE: emulate only what the router can answer with C#'s own
// semantics; everything else surfaces netcoredbg's raw refusal. `is null` is
// always a reference test and is answered from the operand's rendering. The
// `==`/`!=` forms dispatch to a user-defined `operator ==` when one exists,
// so they are answered ONLY for operands proven safe: strings (whose
// operator is specified to agree with the reference test against null),
// nullables (lifted semantics), null references, and reference types the
// router has proven — one cached reflection probe per type — declare no
// `op_Equality`. Value types and operator-carrying types get the adapter's
// own response, never a guess. Every emulation is context-independent, so
// hover, watch and repl answer identically.
import { EvaluateRetrier, type RetryHost } from './dap-attach';
import {
  isRecord,
  parseCastExpression,
  parseNullComparison,
  type DapMessage,
  type NullComparison,
} from './dap-emulate';
import { emulateCast, renderedOf, type RenderedValue } from './dap-cast';

/** netcoredbg's exact refusal for the one syntax kind the router can serve. */
function isCastRefusal(response: DapMessage): boolean {
  return typeof response.message === 'string' && response.message.includes('CastExpression');
}

/** The rendered value inside an `evaluate` response. */
function renderedResponse(response: DapMessage): RenderedValue {
  return renderedOf(isRecord(response.body) ? response.body : {});
}

/** A successful `evaluate` response synthesized in the router's own name. */
function answer(value: RenderedValue): DapMessage {
  return {
    seq: 0,
    type: 'response',
    command: 'evaluate',
    success: true,
    body: { result: value.result, type: value.type, variablesReference: value.variablesReference },
  };
}

/** The synthesized boolean a null test answers with. */
function boolAnswer(isNull: boolean, negated: boolean): DapMessage {
  return answer({ result: String(isNull !== negated), type: 'bool', variablesReference: 0 });
}

/** `string`'s `operator ==` against null is specified to agree with `is null`. */
function isStringType(type: string): boolean {
  return type === 'string' || type === 'System.String';
}

/** `T?` renderings — the lifted `== null` reads HasValue, i.e. the rendering. */
function isNullableType(type: string): boolean {
  return type.endsWith('?') || type.startsWith('System.Nullable<') || type.startsWith('Nullable<');
}

/** `EvaluateRetrier`'s bounded transient retry, surfaced as a Promise. */
class RetryingEvaluator {
  private readonly retrier: EvaluateRetrier;

  private readonly settlers = new Map<number, (message: DapMessage) => void>();

  /** Negative tokens: never a client seq, so responses correlate unambiguously. */
  private nextToken = -1;

  constructor(private readonly host: RetryHost) {
    this.retrier = new EvaluateRetrier({
      request: async (command, args) => await host.request(command, args),
      isClosed: () => host.isClosed(),
      deliver: (message) => {
        this.settle(message);
      },
    });
  }

  /** One evaluation, retried exactly the way a raw client evaluate would be. */
  public async evaluate(args: Record<string, unknown>): Promise<DapMessage> {
    // A dead adapter delivers nothing: answer here instead of hanging forever.
    if (this.host.isClosed()) {
      return {
        type: 'response',
        command: 'evaluate',
        success: false,
        message: 'netcoredbg exited',
      };
    }
    const token = this.nextToken;
    this.nextToken -= 1;
    const reply = new Promise<DapMessage>((resolve) => {
      this.settlers.set(token, resolve);
    });
    this.retrier.start({ seq: token }, args);
    return await reply;
  }

  private settle(message: DapMessage): void {
    const token = Number(message.request_seq ?? 0);
    const settler = this.settlers.get(token);
    if (settler === undefined) return;
    this.settlers.delete(token);
    settler(message);
  }
}

/** Intercepts one client `evaluate` and closes netcoredbg's T1 gaps. */
export class EvaluateEmulator {
  private readonly attempts: RetryingEvaluator;

  /** Rendered type name -> whether `==` may be answered from the rendering. */
  private readonly equatables = new Map<string, Promise<'answer' | 'refuse'>>();

  constructor(private readonly host: RetryHost) {
    this.attempts = new RetryingEvaluator(host);
  }

  /** Drop per-type verdicts; hot reload can add operators ([DEBUG-FEATURES-HOT-RELOAD]). */
  public invalidateMetadataCaches(): void {
    this.equatables.clear();
  }

  public start(clientRequest: DapMessage, args: Record<string, unknown>): void {
    void this.run(clientRequest, args);
  }

  private async run(clientRequest: DapMessage, args: Record<string, unknown>): Promise<void> {
    const expression = typeof args.expression === 'string' ? args.expression : '';
    const nullTest = parseNullComparison(expression);
    const response =
      nullTest === undefined
        ? await this.forwardWithCastFallback(args, expression)
        : await this.answerNullTest(args, nullTest);
    if (this.host.isClosed()) return;
    this.host.deliver({ ...response, request_seq: Number(clientRequest.seq ?? -1) });
  }

  /** netcoredbg's own response — the honest surface for a refused emulation. */
  private async rawRefusal(args: Record<string, unknown>): Promise<DapMessage> {
    return await this.host.request('evaluate', args);
  }

  /** A null test: answered from the operand's rendering only when C# agrees. */
  private async answerNullTest(
    args: Record<string, unknown>,
    test: NullComparison,
  ): Promise<DapMessage> {
    const operand = await this.attempts.evaluate({ ...args, expression: test.operand });
    if (operand.success === false) return await this.rawRefusal(args);
    const value = renderedResponse(operand);
    const isNull = value.result === 'null';
    if (test.pattern === 'is') return boolAnswer(isNull, test.negated);
    const verdict = await this.operatorVerdict(value, test.operand, args);
    return verdict === 'answer' ? boolAnswer(isNull, test.negated) : await this.rawRefusal(args);
  }

  /**
   * May `x == null` be answered from x's rendering? Yes for null references
   * (the standard operators and reference equality agree on null — a
   * pathological `operator ==` returning false for (null, null) is the one
   * accepted blind spot, since a null operand offers no instance to probe),
   * for strings and nullables (BCL-specified semantics), and for reference
   * types PROVEN to declare no `op_Equality`. Everything else — value types,
   * operator carriers, unprobeable types — is refused.
   */
  private async operatorVerdict(
    value: RenderedValue,
    operandExpression: string,
    args: Record<string, unknown>,
  ): Promise<'answer' | 'refuse'> {
    if (value.result === 'null') return 'answer';
    if (isStringType(value.type) || isNullableType(value.type)) return 'answer';
    if (value.type === '') return 'refuse';
    const cached = this.equatables.get(value.type);
    if (cached !== undefined) return await cached;
    const probe = this.probeEquatable(operandExpression, args, value.type);
    this.equatables.set(value.type, probe);
    return await probe;
  }

  /** One reflection probe per type: reference (not value) AND no `op_Equality`. */
  private async probeEquatable(
    operandExpression: string,
    args: Record<string, unknown>,
    type: string,
  ): Promise<'answer' | 'refuse'> {
    const [valueType, operator] = await Promise.all([
      this.attempts.evaluate({ ...args, expression: `${operandExpression}.GetType().IsValueType` }),
      this.attempts.evaluate({
        ...args,
        expression: `${operandExpression}.GetType().GetMethod("op_Equality")`,
      }),
    ]);
    if (valueType.success !== true || operator.success !== true) {
      // A failed probe is refused but never cached — it may be transient.
      this.equatables.delete(type);
      return 'refuse';
    }
    const isReference = renderedResponse(valueType).result === 'false';
    const hasNoOperator = renderedResponse(operator).result === 'null';
    return isReference && hasNoOperator ? 'answer' : 'refuse';
  }

  /** Forward to netcoredbg; on its cast refusal, perform the cast here. */
  private async forwardWithCastFallback(
    args: Record<string, unknown>,
    expression: string,
  ): Promise<DapMessage> {
    const response = await this.attempts.evaluate(args);
    if (response.success !== false || !isCastRefusal(response)) return response;
    const cast = parseCastExpression(expression);
    if (cast === undefined) return response;
    const operand = await this.attempts.evaluate({ ...args, expression: cast.operand });
    if (operand.success === false) return response;
    const emulated = emulateCast(cast.targetType, renderedResponse(operand));
    return emulated === undefined ? response : answer(emulated);
  }
}
