import { describe, expect, it } from 'vitest';
import {
  buildLanMcpAuthAad,
  decryptLanMcpAuthJson,
  deriveLanMcpAuthKey,
  encryptLanMcpAuthJson,
  hashLanMcpAuthTarget,
  mcpAuthAtRestAad,
  mcpAuthAuthorizeConfigRequestAad,
  mcpAuthAuthorizeConfigResponseAad,
  mcpAuthPutRecordRequestAad,
  mcpAuthTokenRequestAad,
  mcpAuthTokenResponseAad,
} from './lan-mcp-auth-crypto';

describe('LAN MCP auth cryptography', () => {
  const hubToken = 'synthetic-hub-token-0123456789abcdef';

  it('derives domain-separated 256-bit keys for at-rest and wire purposes', () => {
    const atRest = deriveLanMcpAuthKey(hubToken, 'at-rest');
    const wire = deriveLanMcpAuthKey(hubToken, 'wire');
    const otherAtRest = deriveLanMcpAuthKey(`${hubToken}-other`, 'at-rest');

    expect(atRest.length).toBe(32);
    expect(wire.length).toBe(32);
    expect(atRest.equals(wire)).toBe(false);
    expect(atRest.equals(otherAtRest)).toBe(false);
    expect(atRest.equals(deriveLanMcpAuthKey(hubToken, 'at-rest'))).toBe(true);
    expect(() => deriveLanMcpAuthKey('', 'wire')).toThrow();
  });

  it('encrypts and decrypts JSON payloads with random 12-byte IVs and explicit AAD', () => {
    const key = deriveLanMcpAuthKey(hubToken, 'wire');
    const aad = mcpAuthTokenResponseAad('server-1');
    const payload = { mode: 'oauth', headers: { authorization: 'Bearer synthetic-access' } };

    const first = encryptLanMcpAuthJson(key, aad, payload);
    const second = encryptLanMcpAuthJson(key, aad, payload);

    expect(first.v).toBe(1);
    expect(Buffer.from(first.iv, 'base64').length).toBe(12);
    expect(Buffer.from(first.tag, 'base64').length).toBe(16);
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(JSON.stringify(first)).not.toContain('synthetic-access');
    expect(decryptLanMcpAuthJson(key, aad, first)).toEqual(payload);
    expect(decryptLanMcpAuthJson(key, aad, second)).toEqual(payload);
  });

  it('rejects wrong keys, wrong AAD contexts, tampering, and malformed envelopes', () => {
    const wireKey = deriveLanMcpAuthKey(hubToken, 'wire');
    const atRestKey = deriveLanMcpAuthKey(hubToken, 'at-rest');
    const otherWireKey = deriveLanMcpAuthKey('different-hub-token', 'wire');
    const aad = mcpAuthPutRecordRequestAad('srv-alpha');
    const envelope = encryptLanMcpAuthJson(wireKey, aad, { secret: 'never-plaintext' });

    // Wrong key (domain separation and wrong hub token)
    expect(() => decryptLanMcpAuthJson(atRestKey, aad, envelope)).toThrow();
    expect(() => decryptLanMcpAuthJson(otherWireKey, aad, envelope)).toThrow();

    // Cross-context AAD replay attempts
    expect(() => decryptLanMcpAuthJson(wireKey, mcpAuthAtRestAad(), envelope)).toThrow();
    expect(() =>
      decryptLanMcpAuthJson(wireKey, mcpAuthPutRecordRequestAad('srv-beta'), envelope)
    ).toThrow();
    expect(() =>
      decryptLanMcpAuthJson(wireKey, mcpAuthTokenRequestAad('srv-alpha'), envelope)
    ).toThrow();
    expect(() =>
      decryptLanMcpAuthJson(wireKey, mcpAuthTokenResponseAad('srv-alpha'), envelope)
    ).toThrow();
    expect(() =>
      decryptLanMcpAuthJson(wireKey, mcpAuthAuthorizeConfigRequestAad('srv-alpha'), envelope)
    ).toThrow();
    expect(() =>
      decryptLanMcpAuthJson(wireKey, mcpAuthAuthorizeConfigResponseAad('srv-alpha'), envelope)
    ).toThrow();
    expect(() =>
      decryptLanMcpAuthJson(
        wireKey,
        buildLanMcpAuthAad(['wire', 'PUT', 'records', 'srv-alpha']),
        envelope
      )
    ).toThrow();

    const hashA = hashLanMcpAuthTarget('{"transport":"http","url":"https://a.example/mcp"}');
    const hashB = hashLanMcpAuthTarget('{"transport":"http","url":"https://b.example/mcp"}');
    expect(hashA).toMatch(/^[0-9a-f]{64}$/);
    expect(hashA).not.toBe(hashB);

    // Tampered ciphertext / tag / iv
    const badCiphertext = Buffer.from(envelope.ciphertext, 'base64');
    badCiphertext[0] ^= 0xff;
    expect(() =>
      decryptLanMcpAuthJson(wireKey, aad, {
        ...envelope,
        ciphertext: badCiphertext.toString('base64'),
      })
    ).toThrow();

    const badTag = Buffer.from(envelope.tag, 'base64');
    badTag[0] ^= 0xff;
    expect(() =>
      decryptLanMcpAuthJson(wireKey, aad, { ...envelope, tag: badTag.toString('base64') })
    ).toThrow();

    const badIv = Buffer.from(envelope.iv, 'base64');
    badIv[0] ^= 0xff;
    expect(() =>
      decryptLanMcpAuthJson(wireKey, aad, { ...envelope, iv: badIv.toString('base64') })
    ).toThrow();

    // Malformed envelope version / lengths / base64
    expect(() => decryptLanMcpAuthJson(wireKey, aad, { ...envelope, v: 2 })).toThrow();
    expect(() =>
      decryptLanMcpAuthJson(wireKey, aad, { ...envelope, iv: Buffer.alloc(8).toString('base64') })
    ).toThrow();
    expect(() =>
      decryptLanMcpAuthJson(wireKey, aad, { ...envelope, tag: 'not!base64!!' })
    ).toThrow();
  });
});
