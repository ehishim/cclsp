import { describe, expect, it } from 'bun:test';
import { createLineReader } from './protocol.js';

describe('cclsp Hub line framing', () => {
  it('delivers one parsed message per complete line', () => {
    const seen: unknown[] = [];
    const read = createLineReader((msg) => seen.push(msg));
    read(Buffer.from('{"id":1,'));
    read(Buffer.from('"cmd":"status"}\n{"id":2,"cmd":"describe"}\n'));
    expect(seen).toEqual([{ id: 1, cmd: 'status' }, { id: 2, cmd: 'describe' }]);
  });

  it('bounds the pending frame and stays usable after an oversized one', () => {
    const seen: unknown[] = [];
    const overflows: Array<{ bytes: number; limit: number }> = [];
    const read = createLineReader((msg) => seen.push(msg), {
      maxFrameBytes: 64,
      onOverflow: (bytes, limit) => overflows.push({ bytes, limit }),
    });

    read(Buffer.from('x'.repeat(200)));
    expect(overflows).toHaveLength(1);
    expect(overflows[0]?.limit).toBe(64);

    // The remainder of the oversized frame is discarded, not parsed as a message.
    read(Buffer.from('trailing-garbage\n'));
    expect(seen).toEqual([]);

    read(Buffer.from('{"id":7,"cmd":"status"}\n'));
    expect(seen).toEqual([{ id: 7, cmd: 'status' }]);
  });

  it('rejects oversized complete frames without discarding adjacent replies', () => {
    const seen: unknown[] = [];
    const overflow: number[] = [];
    const read = createLineReader((msg) => seen.push(msg), {
      maxFrameBytes: 32,
      onOverflow: (bytes) => overflow.push(bytes),
    });
    read(Buffer.from(`${JSON.stringify({ text: 'x'.repeat(64) })}\n{"id":1}\n{"id":2}\n`));
    expect(overflow).toHaveLength(1);
    expect(seen).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('preserves UTF-8 at every byte boundary', () => {
    const expected = { text: 'Ж → 😀' };
    const bytes = Buffer.from(`${JSON.stringify(expected)}\n`);
    for (let split = 1; split < bytes.length; split++) {
      const seen: unknown[] = [];
      const read = createLineReader((msg) => seen.push(msg));
      read(bytes.subarray(0, split));
      read(bytes.subarray(split));
      expect(seen).toEqual([expected]);
    }
  });

  it('ignores a malformed line without tearing down the connection', () => {
    const seen: unknown[] = [];
    const read = createLineReader((msg) => seen.push(msg));
    read(Buffer.from('not json\n{"id":3,"cmd":"list-roots"}\n'));
    expect(seen).toEqual([{ id: 3, cmd: 'list-roots' }]);
  });
});
