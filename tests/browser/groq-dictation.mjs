// Real Chromium microphone/AudioWorklet smoke, with provider responses mocked.
// Run against a disposable local profile; no key or paid transcription needed.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
const url = process.env.LH_DICTATION_TEST_URL || 'http://127.0.0.1:3100';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(url).hostname));
const browser = await puppeteer.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
try {
	const page = await browser.newPage();
	await page.setViewport({ width: 412, height: 860, isMobile: true, hasTouch: true });
	let workletDenied = 0, workletFetches = 0;
	await page.setRequestInterception(true);
	page.on('request', request => {
		if (new URL(request.url()).pathname === '/worklets/pcm-capture.js') {
			if (request.resourceType() !== 'fetch') {
				workletDenied++;
				return request.respond({ status: 401, contentType: 'application/json', body: '{"error":"Sign in is required."}' });
			}
			workletFetches++;
		}
		return request.continue();
	});
	await page.evaluateOnNewDocument(() => {
		const original = window.fetch.bind(window);
		window.dictationTest = { provider: 'groq', uploads: [], tracks: [], tokenCalls: 0, status: 200 };
		const mic = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
		navigator.mediaDevices.getUserMedia = async (...args) => {
			const stream = await mic(...args); window.dictationTest.tracks.push(...stream.getTracks()); return stream;
		};
		window.fetch = async (input, init) => {
			const path = typeof input === 'string' ? input : input.url;
			const test = window.dictationTest;
			if (path === '/api/stt/config') return Response.json({ provider: test.provider });
			if (path === '/api/stt/token') { test.tokenCalls++; throw new Error('Groq must not mint Deepgram tokens'); }
			if (path.startsWith('/api/stt/transcribe')) {
				const bytes = await init.body.arrayBuffer();
				const view = new DataView(bytes);
				test.uploads.push({ size: bytes.byteLength, riff: new TextDecoder().decode(bytes.slice(0, 4)), sampleRate: view.getUint32(24, true), dataBytes: view.getUint32(40, true), type: init.body.type, path });
				await new Promise((resolve, reject) => {
					test.finish = resolve;
					init.signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
				});
				return Response.json(test.status === 200 ? { text: 'Merhaba Whisper.' } : { message: 'Groq test failure' }, { status: test.status });
			}
			return original(input, init);
		};
	});
	await page.goto(url, { waitUntil: 'networkidle2', timeout: 180_000 });
	const start = async () => {
		await page.click('[data-testid="dictation-toggle"]');
		await page.waitForSelector('[data-testid="dictation-meter"]');
		await page.waitForFunction(() => document.querySelectorAll('[data-testid="dictation-meter"] span[style]:not([style="height: 2px;"])').length > 0);
		// Allow at least one full PCM frame, then exercise the final partial flush.
		await new Promise(resolve => setTimeout(resolve, 350));
	};
	const draft = () => page.$eval('[contenteditable="true"], textarea', el => el.value ?? el.textContent);
	await start();
	await page.click('[aria-label="Stop dictation"]');
	await page.waitForFunction(() => window.dictationTest.uploads.length === 1);
	assert.equal(await page.$eval('[data-testid="dictation-toggle"]', el => el.disabled), true);
	assert.doesNotMatch(await draft(), /Merhaba Whisper/);
	assert.equal(await page.evaluate(() => window.dictationTest.tracks.every(track => track.readyState === 'ended')), true);
	const upload = await page.evaluate(() => window.dictationTest.uploads[0]);
	assert.equal(upload.riff, 'RIFF'); assert.equal(upload.type, 'audio/wav'); assert.equal(upload.sampleRate, 16000);
	assert.equal(upload.dataBytes, upload.size - 44); assert.ok(upload.size > 364);
	await page.evaluate(() => window.dictationTest.finish());
	await page.waitForSelector('[aria-label="Start dictation"]');
	assert.equal((await draft()).match(/Merhaba Whisper\./g)?.length, 1);
	await start(); await page.keyboard.press('Escape');
	await page.waitForSelector('[aria-label="Start dictation"]');
	assert.equal(await page.evaluate(() => window.dictationTest.uploads.length), 1, 'Cancel does not upload');
	await start(); await page.click('[aria-label="Stop dictation"]');
	await page.waitForFunction(() => window.dictationTest.uploads.length === 2);
	await page.evaluate(() => { window.dictationTest.status = 502; window.dictationTest.finish(); });
	await page.waitForSelector('[aria-label="Dictation failed: Groq test failure"]');
	assert.equal((await draft()).match(/Merhaba Whisper\./g)?.length, 1, 'Failed transcription leaves the draft intact');
	assert.equal(await page.evaluate(() => window.dictationTest.tokenCalls), 0);
	await page.evaluate(() => { window.dictationTest.provider = null; });
	await page.click('[data-testid="dictation-toggle"]');
	await page.waitForSelector('[aria-label="Dictation failed: Dictation needs a Groq or Deepgram key"]');
	await page.click('[data-testid="dictation-toggle"]');
	await page.waitForSelector('[data-testid="key-groq_api_key"]');
	assert.match(await page.$eval('[data-testid="group-dictation"]', el => el.textContent), /Groq.*Whisper/s);
	assert.equal(workletDenied, 1);
	assert.equal(workletFetches, 1, 'Recording reuses the worklet loaded through the page fetch');
	console.log('PASS: microphone and WAV capture after worklet HTTP 401, stop/append once, cancel, provider failure, Groq settings deep-link. Groq responses mocked.');
} finally { await browser.close(); }
