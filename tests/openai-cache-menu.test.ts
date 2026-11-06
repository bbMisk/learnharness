/** OpenAI API-key route: the Cache menu's Long note matches the request actually prepared. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeContext } from '@earendil-works/pi-ai';
import { piEngineForSpec } from '../src/agent/models.ts';
import { longRetentionNote } from '../components/settings/cache-retention-menu.tsx';

test('OpenAI GPT-6.1 Long sends the setting described in the menu', async () => {
 const engine = piEngineForSpec({provider:'openai',id:'gpt-6.1-sol',thinkingLevel:'off'},false,undefined,()=> 'long');
 let payload: any;
 const stream = engine.streamFn(engine.model, normalizeContext({systemPrompt:'Rules', messages:[{role:'user',content:'hi',timestamp:1}]}), {apiKey:'sk-fixture',sessionId:'s', onPayload: (body) => { payload=body; throw new Error('stop before network'); }});
 const result = await stream.result();
 assert.ok(payload, result.errorMessage);
 assert.match(longRetentionNote('openai','gpt-6.1-sol')!, /same 30 minutes/, 'the menu describes what the request sends');
 assert.deepEqual(payload?.prompt_cache_options, {ttl:'30m'}, 'pi sends 30 minutes for Long on GPT-5.6+');
});
