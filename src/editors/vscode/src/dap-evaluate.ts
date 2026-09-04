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
import {
  emulateStringMember,
  isStringValue,
  parseIndexAccess,
  parseMemberAccess,
  rendersAsException,
  type IndexAccess,
} from './dap-string-members';

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

/** A refusal carrying a reason the Watch panel can put in front of the user. */
function refusal(reason: string): DapMessage {
  return {
    seq: 0,
    type: 'response',
    command: 'evaluate',
    success: false,
    message: reason,
    body: {},
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
    const forwarded =
      nullTest === undefined
        ? await this.forwardWithCastFallback(args, expression)
        : await this.answerNullTest(args, nullTest);
    const response = await this.refuseFaultedIndex(forwarded, args, expression);
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

  /** Forward to netcoredbg, then close the gaps it leaves on either side. */
  private async forwardWithCastFallback(
    args: Record<string, unknown>,
    expression: string,
  ): Promise<DapMessage> {
    const response = await this.attempts.evaluate(args);
    if (response.success !== false) return response;
    if (isCastRefusal(response)) return await this.castFallback(response, args, expression);
    return await this.stringMemberFallback(response, args, expression);
  }

  /**
   * Turn an indexer that faulted into the refusal it is.
   *
   * netcoredbg answers an out-of-range read SUCCESSFULLY, rendering the thrown
   * exception where the value belongs — a wrong answer the user acts on. The
   * exception rendering alone is not proof (a watch on a real exception object
   * renders identically), so it only decides whether to spend the round trip;
   * the refusal itself needs the index to be provably outside the receiver.
   */
  private async refuseFaultedIndex(
    response: DapMessage,
    args: Record<string, unknown>,
    expression: string,
  ): Promise<DapMessage> {
    if (response.success !== true) return response;
    if (!rendersAsException(renderedResponse(response))) return response;
    const index = parseIndexAccess(expression);
    if (index === undefined) return response;
    return (await this.indexIsOutsideReceiver(index, args))
      ? refusal(`'${expression}' is outside the bounds of '${index.receiver}'.`)
      : response;
  }

  /** Whether the index provably addresses nothing in the receiver. */
  private async indexIsOutsideReceiver(
    index: IndexAccess,
    args: Record<string, unknown>,
  ): Promise<boolean> {
    const [position, size] = await Promise.all([
      this.wholeNumberOf(args, index.index),
      this.receiverSize(args, index.receiver),
    ]);
    if (position === undefined || size === undefined) return false;
    return position < 0 || position >= size;
  }

  /** The receiver's element count, from whichever of the two names it has. */
  private async receiverSize(
    args: Record<string, unknown>,
    receiver: string,
  ): Promise<number | undefined> {
    const count = await this.wholeNumberOf(args, `${receiver}.Count`);
    return count ?? (await this.wholeNumberOf(args, `${receiver}.Length`));
  }

  /** One sub-evaluation read back as a whole number, or nothing. */
  private async wholeNumberOf(
    args: Record<string, unknown>,
    expression: string,
  ): Promise<number | undefined> {
    const evaluated = await this.attempts.evaluate({ ...args, expression });
    if (evaluated.success === false) return undefined;
    const rendered = renderedResponse(evaluated).result;
    const parsed = Number(rendered);
    return Number.isInteger(parsed) ? parsed : undefined;
  }

  /** netcoredbg refused the cast syntax; perform the cast here. */
  private async castFallback(
    response: DapMessage,
    args: Record<string, unknown>,
    expression: string,
  ): Promise<DapMessage> {
    const cast = parseCastExpression(expression);
    if (cast === undefined) return response;
    const operand = await this.attempts.evaluate({ ...args, expression: cast.operand });
    if (operand.success === false) return response;
    const emulated = emulateCast(cast.targetType, renderedResponse(operand));
    return emulated === undefined ? response : answer(emulated);
  }

  /**
   * netcoredbg cannot walk members through a string value, so a member reached
   * through a string receiver is refused even though the receiver itself
   * evaluates. Answer it from the receiver's own rendering when the member is
   * a pure function of the characters ([DEBUG-FEATURES-VARIABLES] T2).
   */
  private async stringMemberFallback(
    response: DapMessage,
    args: Record<string, unknown>,
    expression: string,
  ): Promise<DapMessage> {
    const access = parseMemberAccess(expression);
    if (access === undefined) return response;
    const receiver = await this.attempts.evaluate({ ...args, expression: access.receiver });
    if (receiver.success === false) return response;
    const value = renderedResponse(receiver);
    if (!isStringValue(value)) return response;
    const emulated = emulateStringMember(access, value);
    return emulated === undefined ? response : answer(emulated);
  }
}
