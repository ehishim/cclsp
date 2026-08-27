import { describe, expect, test } from 'bun:test';
import { resolveDaemonLockPath } from './config.js';

describe('resolveDaemonLockPath', () => {
  test('the default socket keeps its historical lock filename', () => {
    // A newer build must still SEE a daemon started by an older one, which locks
    // this exact path.
    expect(resolveDaemonLockPath(undefined, '/run/cclsp-hub', '/run/cclsp-hub/daemon.sock')).toBe(
      '/run/cclsp-hub/daemon.pid'
    );
  });

  test('an overridden socket gets its OWN lock', () => {
    // One daemon per socket. Sharing the default lock is what made an isolated
    // daemon exit silently while the shared daemon held it, so CCLSP_HUB_SOCKET
    // could never produce a second instance and a candidate could only be
    // validated by deploying it over the shared install.
    expect(resolveDaemonLockPath('/tmp/lane/cand.sock', '/run/cclsp-hub', '/tmp/lane/cand.sock')).toBe(
      '/tmp/lane/cand.sock.pid'
    );
  });

  test('two different overridden sockets never share a lock', () => {
    const a = resolveDaemonLockPath('/tmp/a.sock', '/run/cclsp-hub', '/tmp/a.sock');
    const b = resolveDaemonLockPath('/tmp/b.sock', '/run/cclsp-hub', '/tmp/b.sock');

    expect(a).not.toBe(b);
  });

  test('an overridden lock never collides with the default lock', () => {
    const overridden = resolveDaemonLockPath(
      '/run/cclsp-hub/other.sock',
      '/run/cclsp-hub',
      '/run/cclsp-hub/other.sock'
    );

    expect(overridden).not.toBe(
      resolveDaemonLockPath(undefined, '/run/cclsp-hub', '/run/cclsp-hub/daemon.sock')
    );
  });
});
