import { describe, expect, it } from 'bun:test';
import { TopLevelResponseIdScanner } from './top-level-id-scanner.js';

function scan(body: string, ...splitAt: number[]): TopLevelResponseIdScanner {
  const scanner = new TopLevelResponseIdScanner();
  const bytes = Buffer.from(body, 'utf8');
  const offsets = [0, ...splitAt, bytes.length];
  for (let index = 0; index < offsets.length - 1; index += 1) {
    const start = offsets[index] as number;
    const end = offsets[index + 1] as number;
    if (end > start) scanner.push(bytes.subarray(start, end));
  }
  return scanner;
}

describe('TopLevelResponseIdScanner', () => {
  it('reads the top-level id whether it precedes or follows the result', () => {
    expect(scan('{"jsonrpc":"2.0","id":7,"result":[1,2,3]}').responseId).toBe(7);
    expect(scan('{"jsonrpc":"2.0","result":[1,2,3],"id":7}').responseId).toBe(7);
  });

  it('ignores an id nested inside the result payload', () => {
    // The decisive case: the payload names a DIFFERENT in-flight request, and a
    // raw text match would reject that innocent caller.
    const scanner = scan('{"jsonrpc":"2.0","result":[{"id":1,"name":"a"},{"id":3}],"id":2}');
    expect(scanner.responseId).toBe(2);
  });

  it('ignores a nested id that appears AFTER the real one', () => {
    // Order must not decide the answer: a depth-blind scan that simply keeps the
    // last id it saw passes the case above and fails here.
    expect(scan('{"jsonrpc":"2.0","id":2,"result":[{"id":1},{"id":3}]}').responseId).toBe(2);
    expect(scan('{"id":8,"result":{"deep":{"id":99}}}').responseId).toBe(8);
  });

  it('ignores an id nested in objects, arrays, and strings at any depth', () => {
    expect(scan('{"result":{"deep":{"id":11}},"id":4}').responseId).toBe(4);
    expect(scan('{"id":4,"result":{"deep":{"id":11}}}').responseId).toBe(4);
    expect(scan('{"result":"text with \\"id\\": 12 inside","id":5}').responseId).toBe(5);
    expect(scan('{"id":5,"result":"text with \\"id\\": 12 inside"}').responseId).toBe(5);
    expect(scan('{"result":[[{"id":13}]],"id":6}').responseId).toBe(6);
    expect(scan('{"id":6,"result":[[{"id":13}]]}').responseId).toBe(6);
  });

  it('reports a notification or server-initiated request as answering nothing', () => {
    const notification = scan('{"jsonrpc":"2.0","method":"window/logMessage","params":{"id":1}}');
    expect(notification.isNotificationOrRequest).toBe(true);
    expect(notification.responseId).toBeNull();

    const serverRequest = scan('{"jsonrpc":"2.0","id":9,"method":"workspace/applyEdit","params":{}}');
    expect(serverRequest.isNotificationOrRequest).toBe(true);
    expect(serverRequest.responseId).toBeNull();
  });

  it('survives an id split across chunk boundaries', () => {
    const body = '{"jsonrpc":"2.0","id":4321,"result":[{"id":1}]}';
    for (const split of [5, 20, body.indexOf('"id":4321') + 3, body.length - 2]) {
      expect(scan(body, split).responseId).toBe(4321);
    }
    expect(scan('{"jsonrpc":"2.0","result":[{"id":1}],"id":4321}', 30).responseId).toBe(4321);
  });

  it('leaves a non-numeric or absent id unmatched rather than guessing', () => {
    expect(scan('{"jsonrpc":"2.0","id":"abc","result":[]}').responseId).toBeNull();
    expect(scan('{"jsonrpc":"2.0","result":[]}').responseId).toBeNull();
  });
});
