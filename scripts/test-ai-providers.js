require('dotenv').config();

const {
    generateWithProvider,
    getProviderStatus,
} = require('../services/openrouter');

const prompt = `
Return a job application object for this test.
The output must follow the application's schema.
Candidate: Kalimullah Khan, Senior Software Engineer, 7+ years.
Role: AI Full Stack Engineer.
Skills: React, Next.js, Node.js, Python, FastAPI, GenAI.
Return concise professional content.
`;

const providers = ['groq', 'gemini', 'openrouter'];

(async () => {
    console.log('\n=== AI PROVIDER INDEPENDENT TEST ===\n');

    const results = [];

    for (const provider of providers) {
        const status = getProviderStatus().find(item => item.provider === provider);
        if (!status?.configured) {
            console.log(`[TEST] ${provider} SKIPPED: not configured`);
            results.push({ provider, status: 'SKIPPED', latencyMs: '-', error: 'Not configured' });
            continue;
        }

        const started = Date.now();
        console.log(`[TEST] ${status.label}...`);

        try {
            const result = await generateWithProvider(provider, {
                prompt,
                maxTokens: 500,
                temperature: 0.2,
                structured: true,
            });

            const latencyMs = Date.now() - started;
            console.log(`[TEST] ${status.label} ✅`);
            console.log(result.slice(0, 1000));
            console.log('');

            results.push({
                provider,
                status: 'SUCCESS',
                latencyMs,
                error: '',
            });
        } catch (error) {
            const latencyMs = Date.now() - started;
            console.log(`[TEST] ${status.label} ❌ ${error.message}`);
            console.log('');

            results.push({
                provider,
                status: 'FAILED',
                latencyMs,
                error: error.message,
            });
        }
    }

    console.log('=== PROVIDER TEST SUMMARY ===');
    console.table(results);
})();
