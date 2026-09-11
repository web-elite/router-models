/* Smoke tests for the vscode-free logic modules (run: node test/smoke.js) */
'use strict';

const assert = require('assert');
const {
    parseKeys,
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

console.log('\nAll ' + passed + ' smoke tests passed.');
