/* Smoke tests for the vscode-free logic modules (run: node test/smoke.js) */
'use strict';

const assert = require('assert');
const {
    parseKeys,
    parseNamedKeys,
    mergeNamedKeys,
    coerceNamedKeys,
    namedKeysToInput,
    parseRetryAfter,
    previewKey,
    KeyManager,
    aggregateKeyStats
} = require('../out/keys.js');

const {
    OpenAiSseParser,
    eventsFromChunk,
    ToolCallAccumulator
} = require('../out/stream.js');

const {
    findProviderConnections,
    groupConnections,
    parseConnections,
    decodeTextFile,
    MAX_SEARCH_DEPTH
} = require('../out/import.js');

let passed = 0;
const test = (name, fn) => {
    fn();
    passed++;
    console.log('ok -', name);
};

// ---------------------------------------------------------------
// parseKeys
// ---------------------------------------------------------------

test('parseKeys: multi-line / comma / space / semicolon', () => {
    assert.deepStrictEqual(
        parseKeys('sk-a\nsk-b, sk-c;sk-d\tsk-e'),
        ['sk-a', 'sk-b', 'sk-c', 'sk-d', 'sk-e']
    );
});

test('parseKeys: dedupe + trim + ignore junk', () => {
    assert.deepStrictEqual(
        parseKeys('  sk-a ,,, \n sk-a \n\n'),
        ['sk-a']
    );
    assert.deepStrictEqual(parseKeys(42), []);
    assert.deepStrictEqual(parseKeys(null), []);
});

// ---------------------------------------------------------------
// parseNamedKeys
// ---------------------------------------------------------------

test('parseNamedKeys: name | key lines', () => {
    assert.deepStrictEqual(
        parseNamedKeys('Main | sk-a\nBackup|sk-b'),
        [
            { key: 'sk-a', name: 'Main' },
            { key: 'sk-b', name: 'Backup' }
        ]
    );
});

test('parseNamedKeys: one name, several keys + bare keys', () => {
    assert.deepStrictEqual(
        parseNamedKeys('Pool | sk-a, sk-b\nsk-c'),
        [
            { key: 'sk-a', name: 'Pool' },
            { key: 'sk-b', name: 'Pool' },
            { key: 'sk-c' }
        ]
    );
});

test('parseNamedKeys: dedupe + junk + non-string', () => {
    assert.deepStrictEqual(
        parseNamedKeys('Main | sk-a\nsk-a\n\n   \n'),
        [{ key: 'sk-a', name: 'Main' }]
    );
    assert.deepStrictEqual(
        parseNamedKeys('| sk-a'),
        [{ key: 'sk-a' }]
    );
    assert.deepStrictEqual(parseNamedKeys(42), []);
    assert.deepStrictEqual(parseNamedKeys(null), []);
});

// ---------------------------------------------------------------
// mergeNamedKeys / coerceNamedKeys / namedKeysToInput
// ---------------------------------------------------------------

test('mergeNamedKeys: appends, keeps order, renames duplicates', () => {
    const existing = [{ key: 'sk-a' }, { key: 'sk-b', name: 'Old' }];

    assert.deepStrictEqual(
        mergeNamedKeys(existing, [
            { key: 'sk-c', name: 'New' },
            { key: 'sk-a', name: 'Main' },
            { key: 'sk-b' }
        ]),
        [
            { key: 'sk-a', name: 'Main' },
            { key: 'sk-b', name: 'Old' },
            { key: 'sk-c', name: 'New' }
        ]
    );
});

test('mergeNamedKeys: does not mutate the input', () => {
    const existing = [{ key: 'sk-a' }];

    mergeNamedKeys(existing, [{ key: 'sk-b' }]);

    assert.deepStrictEqual(existing, [{ key: 'sk-a' }]);
});

test('coerceNamedKeys: strings, objects and junk', () => {
    assert.deepStrictEqual(
        coerceNamedKeys([
            'sk-a',
            { key: 'sk-b', name: 'B' },
            { key: 'sk-a' },
            42,
            null,
            { name: 'no key' }
        ]),
        [{ key: 'sk-a' }, { key: 'sk-b', name: 'B' }]
    );
    assert.deepStrictEqual(coerceNamedKeys('sk-a'), []);
    assert.deepStrictEqual(coerceNamedKeys(undefined), []);
});

test('namedKeysToInput: round-trips through parseNamedKeys', () => {
    const keys = [
        { key: 'sk-a', name: 'Main' },
        { key: 'sk-b' }
    ];

    assert.deepStrictEqual(
        parseNamedKeys(namedKeysToInput(keys)),
        keys
    );
});

// ---------------------------------------------------------------
// parseRetryAfter
// ---------------------------------------------------------------

test('parseRetryAfter: seconds and HTTP date', () => {
    assert.strictEqual(parseRetryAfter(' 12 '), 12);
    assert.strictEqual(parseRetryAfter('0'), 0);
    assert.strictEqual(parseRetryAfter('not-a-date'), undefined);
    assert.strictEqual(parseRetryAfter(undefined), undefined);

    const inTwoSeconds = new Date(Date.now() + 2000).toUTCString();
    const parsed = parseRetryAfter(inTwoSeconds);
    assert.ok(
        parsed === 2 || parsed === 1,
        'date parsed to ~2s, got ' + parsed
    );
});

test('previewKey + aggregateKeyStats', () => {
    assert.strictEqual(previewKey('sk-1234567890abcdef'), 'sk-1…cdef');
    const stats = aggregateKeyStats([
        { index: 0, preview: 'a', status: 'ready', cooldownRemainingMs: 0 },
        {
            index: 1,
            preview: 'b',
            status: 'cooldown',
            cooldownRemainingMs: 1000
        },
        { index: 2, preview: 'c', status: 'burned', cooldownRemainingMs: 0 }
    ]);
    assert.deepStrictEqual(stats, {
        total: 3,
        ready: 1,
        cooldown: 1,
        burned: 1
    });
});
// ---------------------------------------------------------------
// KeyManager
// ---------------------------------------------------------------

test('KeyManager: round-robin rotation', () => {
    const km = new KeyManager();
    const keys = ['k1', 'k2', 'k3'];
    assert.strictEqual(km.pickKey('p', keys).key, 'k1');
    assert.strictEqual(km.pickKey('p', keys).key, 'k2');
    assert.strictEqual(km.pickKey('p', keys).key, 'k3');
    assert.strictEqual(km.pickKey('p', keys).key, 'k1');
});

test('KeyManager: cooldown skips resting key', () => {
    const km = new KeyManager();
    const keys = ['k1', 'k2'];
    assert.strictEqual(km.pickKey('p', keys).key, 'k1');
    km.markRateLimited('p', 'k1', 60); // k1 rests 60s
    assert.strictEqual(km.pickKey('p', keys).key, 'k2');
    // k2 rotates back to k1 — but k1 is cooling, so k2 again.
    assert.strictEqual(km.pickKey('p', keys).key, 'k2');

    const snap = km.snapshot('p', keys);
    assert.strictEqual(snap[0].status, 'cooldown');
    assert.ok(snap[0].cooldownRemainingMs > 0);
    assert.strictEqual(snap[1].status, 'ready');
});

test('KeyManager: Retry-After overrides provider cooldown', () => {
    const km = new KeyManager();
    const seconds = km.markRateLimited('p', 'k1', 60, 7);
    assert.strictEqual(seconds, 7);
    const snap = km.snapshot('p', ['k1']);
    assert.ok(
        snap[0].cooldownRemainingMs > 5000 &&
            snap[0].cooldownRemainingMs <= 7000
    );
});

test('KeyManager: burned keys are skipped', () => {
    const km = new KeyManager();
    const keys = ['k1', 'k2'];
    km.pickKey('p', keys);
    km.markAuthFailure('p', 'k1', '401: bad key');
    assert.strictEqual(km.pickKey('p', keys).key, 'k2');
    assert.strictEqual(km.pickKey('p', keys).key, 'k2');
    const snap = km.snapshot('p', keys);
    assert.strictEqual(snap[0].status, 'burned');
    assert.strictEqual(snap[0].cooldownRemainingMs, 0);
});

test('KeyManager: resetCooldowns clears rest + 429 error', () => {
    const km = new KeyManager();
    km.markRateLimited('p', 'k1', 60, 120);
    km.resetCooldowns('p');
    const snap = km.snapshot('p', ['k1']);
    assert.strictEqual(snap[0].status, 'ready');
    assert.strictEqual(snap[0].lastError, undefined);
});

test('KeyManager: soonest cooldown wins when all resting', () => {
    const km = new KeyManager();
    km.markRateLimited('p', 'k1', 60, 30);
    km.markRateLimited('p', 'k2', 60, 5);
    assert.strictEqual(km.pickKey('p', ['k1', 'k2']).key, 'k2');
});

test('KeyManager: key list changes preserve kept keys state', () => {
    const km = new KeyManager();
    km.markRateLimited('p', 'k1', 60);
    km.markAuthFailure('p', 'k2');
    const snap = km.snapshot('p', ['k1', 'k3']); // k2 removed
    assert.strictEqual(snap.length, 2);
    assert.strictEqual(snap[0].status, 'cooldown');
    assert.strictEqual(snap[1].status, 'ready'); // fresh k3
});
// ---------------------------------------------------------------
// OpenAiSseParser
// ---------------------------------------------------------------

test('SSE: chunked feed split mid-line', () => {
    const parser = new OpenAiSseParser();
    const part1 = parser.feed(
        'data: {"choices":[{"delta":{"content":"He'
    );
    const part2 = parser.feed('llo"}}]}\n\ndata: [DONE]\n\n');
    const end = parser.end();

    const texts = [...part1, ...part2].filter(
        e => e.type === 'text'
    );

    assert.strictEqual(
        texts.map(e => e.text).join(''),
        'Hello'
    );
    assert.strictEqual(end.length, 0); // [DONE] produces nothing
});

test('SSE: keep-alive comments, CRLF lines, empty delta objects', () => {
    const parser = new OpenAiSseParser();
    const events = parser.feed(
        ': OPENROUTER PROCESSING\r\n\r\n' +
            'data: {"choices":[{"delta":{}}]}\r\n\r\n' +
            'data: {"choices":[{"delta":{"content":"ok"}}]}\r\n\r\n'
    );

    const texts = events.filter(e => e.type === 'text');

    assert.strictEqual(texts.length, 1);
    assert.strictEqual(texts[0].text, 'ok');
});

test('SSE: reasoning_content / reasoning / thought extraction', () => {
    const parser = new OpenAiSseParser();
    const events = [
        ...parser.feed(
            'data: {"choices":[{"delta":{"reasoning_content":"t1"}}]}\n\n'
        ),
        ...parser.feed(
            'data: {"choices":[{"delta":{"reasoning":"t2"}}]}\n\n'
        ),
        ...parser.feed(
            'data: {"choices":[{"delta":{"thought":"t3"}}]}\n\n'
        ),
        ...parser.feed('data: [DONE]\n\n')
    ];

    const reasoning = events.filter(e => e.type === 'reasoning');

    assert.deepStrictEqual(
        reasoning.map(e => e.text),
        ['t1', 't2', 't3']
    );
});

test('SSE: streamed tool call fragments', () => {
    const parser = new OpenAiSseParser();
    const events = [
        ...parser.feed(
            'data: {"choices":[{"delta":{"tool_calls":' +
                '[{"index":0,"id":"call_1","function":' +
                '{"name":"readFile","arguments":"{\\"pa"}}]}}]}\n\n'
        ),
        ...parser.feed(
            'data: {"choices":[{"delta":{"tool_calls":' +
                '[{"index":0,"function":' +
                '{"arguments":"th\\":\\"a.txt\\"}"}}]}}]}\n\n'
        ),
        ...parser.feed(
            'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n'
        ),
        ...parser.end()
    ];

    const calls = events.filter(e => e.type === 'toolCall');

    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0].id, 'call_1');
    assert.strictEqual(calls[0].name, 'readFile');
    assert.strictEqual(calls[0].arguments, '{"pa');
    assert.strictEqual(calls[1].arguments, 'th":"a.txt"}');

    const finish = events.find(e => e.type === 'finish');
    assert.strictEqual(finish.reason, 'tool_calls');
});

test('SSE: error chunks surface as error events', () => {
    const parser = new OpenAiSseParser();
    const events = [
        ...parser.feed(
            'data: {"error":{"message":"provider exploded"}}\n\n'
        ),
        ...parser.end()
    ];

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].type, 'error');
    assert.strictEqual(events[0].message, 'provider exploded');
});

test('eventsFromChunk: non-streamed completion fallback', () => {
    const events = eventsFromChunk({
        choices: [
            {
                message: {
                    role: 'assistant',
                    content: 'final answer'
                },
                finish_reason: 'stop'
            }
        ]
    });

    assert.strictEqual(events[0].type, 'text');
    assert.strictEqual(events[0].text, 'final answer');
    assert.strictEqual(events[1].type, 'finish');
    assert.strictEqual(events[1].reason, 'stop');
});

test('eventsFromChunk: array-style content parts', () => {
    const events = eventsFromChunk({
        choices: [
            {
                delta: {
                    content: [{ text: 'part1' }, { text: 'part2' }]
                }
            }
        ]
    });

    assert.strictEqual(
        events.map(e => e.text).join(''),
        'part1part2'
    );
});
// ---------------------------------------------------------------
// ToolCallAccumulator
// ---------------------------------------------------------------

test('ToolCallAccumulator: fragmented args complete when JSON closes', () => {
    const acc = new ToolCallAccumulator();

    assert.deepStrictEqual(
        acc.add({
            index: 0,
            id: 'call_1',
            name: 'readFile',
            arguments: '{"pa'
        }),
        []
    );

    // The closing fragment completes the JSON, so the call is
    // surfaced immediately (no waiting for the stream to end).
    const completed = acc.add({
        index: 0,
        arguments: 'th":"a.txt"}'
    });

    assert.strictEqual(completed.length, 1);
    assert.deepStrictEqual(completed[0], {
        id: 'call_1',
        name: 'readFile',
        arguments: '{"path":"a.txt"}'
    });

    assert.deepStrictEqual(acc.finish(), []);
});

test('ToolCallAccumulator: complete call reported immediately', () => {
    const acc = new ToolCallAccumulator();
    const completed = acc.add({
        index: 0,
        id: 'call_9',
        name: 'grep',
        arguments: '{"q":"x"}'
    });

    assert.strictEqual(completed.length, 1);
    assert.deepStrictEqual(completed[0], {
        id: 'call_9',
        name: 'grep',
        arguments: '{"q":"x"}'
    });
    assert.deepStrictEqual(acc.finish(), []);
});

test('ToolCallAccumulator: complete calls surface immediately per call', () => {
    const acc = new ToolCallAccumulator();

    const second = acc.add({
        index: 1,
        id: 'b',
        name: 'second',
        arguments: '{"q":2}'
    });

    const first = acc.add({
        index: 0,
        id: 'a',
        name: 'first',
        arguments: '{"p":1}'
    });

    assert.deepStrictEqual(second, [
        { id: 'b', name: 'second', arguments: '{"q":2}' }
    ]);

    assert.deepStrictEqual(first, [
        { id: 'a', name: 'first', arguments: '{"p":1}' }
    ]);

    assert.deepStrictEqual(acc.finish(), []);
});

test('ToolCallAccumulator: finish completes incomplete calls by index', () => {
    const acc = new ToolCallAccumulator();

    // No arguments at all: never becomes valid JSON, stays pending.
    acc.add({ index: 1, id: 'b', name: 'second' });

    // Broken JSON: stays pending until the stream ends.
    acc.add({ index: 0, id: 'a', name: 'first', arguments: '{"p":' });

    const done = acc.finish();

    assert.deepStrictEqual(
        done.map(c => c.name),
        ['first', 'second']
    );
    assert.deepStrictEqual(
        done.map(c => c.arguments),
        ['{"p":', '']
    );
    assert.deepStrictEqual(acc.finish(), []);
});

// ---------------------------------------------------------------

// ---------------------------------------------------------------
// JSON import (src/import.ts)
// ---------------------------------------------------------------

test('findProviderConnections: list at the root level', () => {
    const found = findProviderConnections({
        providerConnections: [
            { name: 'A', apiKey: 'k1' },
            { name: 'B' }
        ]
    });

    assert.strictEqual(found.length, 2);
    assert.strictEqual(found[0].name, 'A');
    assert.strictEqual(found[1].name, 'B');
});

test('findProviderConnections: nested up to 4 levels (arrays transparent)', () => {
    const wrap = (levels) => {
        let node = { providerConnections: [{ name: 'A' }] };

        for (let i = 0; i < levels - 1; i++) {
            node = { wrap: node };
        }

        return node;
    };

    assert.strictEqual(
        findProviderConnections(wrap(1)).length, 1);
    assert.strictEqual(
        findProviderConnections(wrap(MAX_SEARCH_DEPTH)).length, 1);
    assert.strictEqual(
        findProviderConnections(wrap(MAX_SEARCH_DEPTH + 1)).length, 0);

    // Arrays are transparent containers: no extra level.
    assert.strictEqual(
        findProviderConnections({
            data: [{ nested: { providerConnections: [{ name: 'B' }] } }]
        }).length, 1);
});

test('findProviderConnections: multiple lists at different depths', () => {
    const found = findProviderConnections({
        data: [
            { providerConnections: [{ name: 'A' }] },
            {
                nested: {
                    providerConnections: [{ name: 'B' }, { name: 'C' }]
                }
            }
        ]
    });

    assert.strictEqual(found.length, 3);
});

test('findProviderConnections: junk values are ignored', () => {
    assert.deepStrictEqual(findProviderConnections(null), []);
    assert.deepStrictEqual(findProviderConnections('nope'), []);
    assert.deepStrictEqual(
        findProviderConnections({ providerConnections: 'not-a-list' }),
        []
    );
    assert.deepStrictEqual(
        findProviderConnections({ providerConnections: [1, 'x', null] }),
        []
    );
});

test('parseConnections: maps the documented fields', () => {
    const parsed = parseConnections({
        providerConnections: [{
            testStatus: 'active',
            apiKey: 'sk-test',
            providerSpecificData: {
                baseUrl: 'https://www.getunikey.ai/v1/',
                nodeName: 'UniKey'
            },
            provider: 'openai-compatible-chat-123',
            name: 'Alirezaae044 1',
            isActive: true
        }]
    });

    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].name, 'Alirezaae044 1');
    assert.strictEqual(
        parsed[0].baseUrl, 'https://www.getunikey.ai/v1/');
    assert.strictEqual(parsed[0].apiKey, 'sk-test');
    assert.strictEqual(parsed[0].source, 'openai-compatible-chat-123');
    assert.strictEqual(parsed[0].label, 'Alirezaae044 1');
    assert.strictEqual(parsed[0].index, 1);
});

test('parseConnections: fallbacks (nodeName, baseUrl on the connection)', () => {
    const parsed = parseConnections({
        providerConnections: [
            {
                providerSpecificData: { nodeName: 'UniKey' },
                baseUrl: 'https://x.dev/v1',
                key: 'abc'
            },
            { provider: 'opencode' }
        ]
    });

    assert.strictEqual(parsed[0].name, 'UniKey');
    assert.strictEqual(parsed[0].baseUrl, 'https://x.dev/v1');
    assert.strictEqual(parsed[0].apiKey, 'abc');

    assert.strictEqual(parsed[1].name, undefined);
    assert.strictEqual(parsed[1].apiKey, undefined);
    assert.strictEqual(parsed[1].label, 'opencode');
    assert.strictEqual(parsed[1].source, 'opencode');
});

test('parseConnections: trims strings and ignores non-strings', () => {
    const parsed = parseConnections({
        providerConnections: [
            { apiKey: '  sk-x  ', baseUrl: 42, name: ' My Router ' }
        ]
    });

    assert.strictEqual(parsed[0].apiKey, 'sk-x');
    assert.strictEqual(parsed[0].baseUrl, undefined);
    assert.strictEqual(parsed[0].name, 'My Router');
});

// ---------------------------------------------------------------
// Provider grouping (prefix = one provider, N keys)
// ---------------------------------------------------------------

test('groupConnections: same prefix merges into one provider with all keys', () => {
    const node = {
        prefix: 'b-ai',
        baseUrl: 'https://api.b.ai/v1',
        nodeName: 'Free (Limited Time)'
    };

    const groups = groupConnections(parseConnections({
        providerConnections: [
            { apiKey: 'k1', name: 'Key 1', providerSpecificData: node },
            { apiKey: 'k2', name: 'Key 2', providerSpecificData: node },
            { apiKey: 'k1', name: 'Key 3', providerSpecificData: node }
        ]
    }));

    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].id, 'b-ai');
    assert.strictEqual(groups[0].name, 'Free (Limited Time)');
    assert.strictEqual(groups[0].baseUrl, 'https://api.b.ai/v1');
    assert.deepStrictEqual(groups[0].apiKeys, ['k1', 'k2']);
    assert.strictEqual(groups[0].connections, 3);
});

test('groupConnections: different prefixes stay separate providers', () => {
    const groups = groupConnections(parseConnections({
        providerConnections: [
            {
                apiKey: 'k1',
                providerSpecificData: {
                    prefix: 'uniKey',
                    baseUrl: 'https://a.dev/v1/',
                    nodeName: 'UniKey'
                }
            },
            {
                apiKey: 'k2',
                providerSpecificData: {
                    prefix: 'hive',
                    baseUrl: 'https://b.dev/api/v3',
                    nodeName: 'Hive'
                }
            },
            { provider: 'opencode' }
        ]
    }));

    assert.strictEqual(groups.length, 3);
    assert.deepStrictEqual(
        groups.map(g => g.id),
        ['uniKey', 'hive', 'opencode']
    );
    assert.deepStrictEqual(
        groups.map(g => g.name),
        ['UniKey', 'Hive', 'Imported Provider']
    );
    assert.deepStrictEqual(
        groups.map(g => g.apiKeys.length),
        [1, 1, 0]
    );
});

test('groupConnections: prefix missing falls back to provider / host', () => {
    const groups = groupConnections(parseConnections({
        providerConnections: [
            { apiKey: 'k1', provider: 'custom', baseUrl: 'https://x.dev/v1' },
            { apiKey: 'k2', baseUrl: 'https://y.dev/v1' }
        ]
    }));

    assert.strictEqual(groups.length, 2);
    assert.strictEqual(groups[0].id, 'custom');
    assert.strictEqual(groups[1].id, 'y.dev');
});

test('groupConnections: grouping is case-insensitive on the prefix', () => {
    const groups = groupConnections(parseConnections({
        providerConnections: [
            { apiKey: 'k1', providerSpecificData: { prefix: 'uniKey' } },
            { apiKey: 'k2', providerSpecificData: { prefix: 'UniKey' } }
        ]
    }));

    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].id, 'uniKey');
    assert.deepStrictEqual(groups[0].apiKeys, ['k1', 'k2']);
});

test('decodeTextFile: BOM handling (utf8 / utf16le / utf16be / plain)', () => {
    const payload = Buffer.from('{"a":1}', 'utf8');

    assert.strictEqual(decodeTextFile(payload), '{"a":1}');
    assert.strictEqual(
        decodeTextFile(Buffer.concat([
            Buffer.from([0xef, 0xbb, 0xbf]),
            payload
        ])),
        '{"a":1}'
    );
    assert.strictEqual(
        decodeTextFile(Buffer.concat([
            Buffer.from([0xff, 0xfe]),
            Buffer.from('{"a":1}', 'utf16le')
        ])),
        '{"a":1}'
    );

    const be = Buffer.from('{"a":1}', 'utf16le');

    be.swap16();

    assert.strictEqual(
        decodeTextFile(Buffer.concat([Buffer.from([0xfe, 0xff]), be])),
        '{"a":1}'
    );
});

// ---------------------------------------------------------------

console.log('\nAll ' + passed + ' smoke tests passed.');
