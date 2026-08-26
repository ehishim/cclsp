// Incremental structural scan of one JSON-RPC frame that is too large to parse.
//
// A frame streamed to disk still has to reach the request that is waiting for it,
// and the only field that identifies it is the TOP-LEVEL `id`. Searching the raw
// bytes cannot do that: a `result` payload routinely contains its own `id` fields,
// and one of those can name a different in-flight request, so a text match can
// reject the wrong caller. This scanner therefore tracks JSON structure — strings,
// escapes, and nesting depth — and reports only a depth-1 `id`, plus whether the
// frame carried a top-level `method`, which makes it a notification or a
// server-initiated request rather than a response to anything.
//
// Memory is bounded: the scanner keeps character-level state and two short
// buffers, never the frame.

const MAX_KEY_CHARS = 32;
const MAX_NUMBER_CHARS = 20;

export class TopLevelResponseIdScanner {
  private depth = 0;
  private inString = false;
  private escaped = false;
  private collectingKey = false;
  private keyChars = '';
  private closedKey: string | null = null;
  private activeKey: string | null = null;
  private expectingValue = false;
  private inNumber = false;
  private numberChars = '';
  private methodSeen = false;
  private idValue: number | null = null;
  private finished = false;

  /** True when a top-level `method` makes this frame a notification/request. */
  get isNotificationOrRequest(): boolean {
    return this.methodSeen;
  }

  /** The frame's own top-level response id, or null when it carries none. */
  get responseId(): number | null {
    return this.methodSeen ? null : this.idValue;
  }

  push(chunk: Buffer): void {
    if (this.finished) return;
    // JSON structure is ASCII, and latin1 maps every byte 1:1, so a multi-byte
    // UTF-8 sequence inside a string cannot be mistaken for a structural token.
    const text = chunk.toString('latin1');
    for (let index = 0; index < text.length && !this.finished; index += 1) {
      this.consume(text[index] as string);
    }
  }

  private consume(char: string): void {
    if (this.inString) {
      this.consumeInString(char);
      return;
    }
    if (this.inNumber) {
      if (char >= '0' && char <= '9') {
        if (this.numberChars.length < MAX_NUMBER_CHARS) this.numberChars += char;
        return;
      }
      this.closeNumber();
    }

    switch (char) {
      case '"':
        this.inString = true;
        this.escaped = false;
        this.collectingKey = this.depth === 1 && !this.expectingValue;
        this.keyChars = '';
        if (this.depth === 1 && this.expectingValue && this.activeKey === 'method') this.methodSeen = true;
        if (this.expectingValue) this.endValue();
        return;
      case '{':
      case '[':
        this.depth += 1;
        this.expectingValue = false;
        return;
      case '}':
      case ']':
        this.depth -= 1;
        if (this.depth <= 0) this.finished = true;
        if (this.depth === 1) this.endValue();
        return;
      case ':':
        if (this.depth === 1) {
          this.activeKey = this.closedKey;
          this.expectingValue = true;
        }
        return;
      case ',':
        if (this.depth === 1) this.endValue();
        return;
      default:
        if (this.depth === 1 && this.expectingValue && this.activeKey === 'id'
          && (char === '-' || (char >= '0' && char <= '9'))) {
          this.inNumber = true;
          this.numberChars = char;
        }
        return;
    }
  }

  private consumeInString(char: string): void {
    if (this.escaped) {
      this.escaped = false;
      return;
    }
    if (char === '\\') {
      this.escaped = true;
      return;
    }
    if (char === '"') {
      this.inString = false;
      if (this.collectingKey) {
        this.closedKey = this.keyChars;
        this.collectingKey = false;
      }
      return;
    }
    if (this.collectingKey && this.keyChars.length < MAX_KEY_CHARS) this.keyChars += char;
  }

  private closeNumber(): void {
    this.inNumber = false;
    if (this.activeKey !== 'id') return;
    const parsed = Number.parseInt(this.numberChars, 10);
    if (Number.isSafeInteger(parsed)) this.idValue = parsed;
  }

  private endValue(): void {
    this.expectingValue = false;
    this.activeKey = null;
    this.closedKey = null;
  }
}
