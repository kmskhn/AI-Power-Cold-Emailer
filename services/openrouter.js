/**
 * ================================================================
 * AI PROVIDER ROUTER
 * ================================================================
 *
 * Compatibility facade for the existing Emailer application.
 *
 * PROVIDER ORDER
 * --------------
 * 1. Groq direct       -> qwen/qwen3.8-27b
 * 2. Gemini direct     -> gemini-3.8-flash
 * 3. OpenRouter FREE   -> openrouter/free
 *
 * Qwen direct / Alibaba is intentionally NOT included because the
 * current user account cannot conveniently obtain that API key.
 * Qwen is still available indirectly through Groq/OpenRouter.
 *
 * HARD COST RULE
 * --------------
 * No paid model is intentionally selected by this application.
 * Provider account billing/free-tier settings remain the user's
 * responsibility. This code never auto-escalates to paid models.
 *
 * PUBLIC API
 * ----------
 * generateText(promptOrOptions, legacyApiKey?, legacyOptions?)
 * generateFromImage(imageData, mimeType, prompt, legacyApiKey?)
 * getProviderStatus()
 * generateWithProvider(providerName, payload)  // test/debug only
 *
 * generateText() returns a STRING so existing server.js integrations
 * can continue to work without a large rewrite.
 *
 * ================================================================
 */

require('dotenv').config();

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

const GROQ_MODEL = process.env.GROQ_MODEL || 'qwen/qwen3.8-27b';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openrouter/free';

const TEXT_TIMEOUT_MS = Number(process.env.AI_TEXT_TIMEOUT_MS || 15000);
const VISION_TIMEOUT_MS = Number(process.env.AI_VISION_TIMEOUT_MS || 20000);
const OPENROUTER_TIMEOUT_MS = Number(process.env.AI_OPENROUTER_TIMEOUT_MS || 8000);
const RETRY_DELAY_MS = Number(process.env.AI_429_RETRY_DELAY_MS || 1000);
const PROVIDER_COOLDOWN_MS = Number(process.env.AI_PROVIDER_COOLDOWN_MS || 30000);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const APPLICATION_SCHEMA = {
    type: 'object',
    properties: {
        subject: { type: 'string' },
        body: { type: 'string' },
        whatsapp: { type: 'string' },
    },
    required: ['subject', 'body', 'whatsapp'],
};

// Groq supports strict JSON Schema and rejects additional fields when strict=true.
const GROQ_SCHEMA = {
    ...APPLICATION_SCHEMA,
    additionalProperties: false,
};

const providerCooldownUntil = new Map();

function getApiKey(providerName) {
    switch (providerName) {
        case 'groq':
            return process.env.GROQ_API_KEY?.trim() || '';
        case 'gemini':
            return process.env.GEMINI_API_KEY?.trim() || '';
        case 'openrouter':
            return process.env.OPENROUTER_API_KEY?.trim() || '';
        default:
            return '';
    }
}

function isProviderConfigured(providerName) {
    return Boolean(getApiKey(providerName));
}

function isCoolingDown(providerName) {
    return Date.now() < (providerCooldownUntil.get(providerName) || 0);
}

function cooldown(providerName) {
    providerCooldownUntil.set(providerName, Date.now() + PROVIDER_COOLDOWN_MS);
}

function clearCooldown(providerName) {
    providerCooldownUntil.delete(providerName);
}

function normalizePrompt(input) {
    if (typeof input === 'string') return input;

    if (input && Array.isArray(input.messages)) {
        return input.messages
            .map(message => {
                const content = message?.content;
                if (typeof content === 'string') return content;
                if (Array.isArray(content)) {
                    return content
                        .map(part => part?.text || '')
                        .filter(Boolean)
                        .join('\n');
                }
                return '';
            })
            .filter(Boolean)
            .join('\n\n');
    }

    throw new Error('AI prompt is missing or invalid.');
}

function normalizeArgs(promptOrOptions, legacyOptions) {
    if (typeof promptOrOptions === 'string') {
        return {
            prompt: promptOrOptions,
            maxTokens: legacyOptions?.maxTokens || 2000,
            temperature: legacyOptions?.temperature ?? 0.2,
            structured: legacyOptions?.structured ?? true,
        };
    }

    return {
        prompt: normalizePrompt(promptOrOptions),
        maxTokens: promptOrOptions?.maxTokens || 2000,
        temperature: promptOrOptions?.temperature ?? 0.2,
        structured: promptOrOptions?.structured ?? true,
    };
}

function classifyError(status, message) {
    const lower = String(message || '').toLowerCase();
    return {
        retryable:
            [408, 409, 429, 500, 502, 503, 504].includes(status) ||
            /timeout|timed out|aborted|overloaded|capacity|temporarily unavailable|high demand/.test(lower),
        rateLimited:
            status === 429 || /rate limit|too many requests/.test(lower),
    };
}

function jsonObjectFromText(text) {
    if (typeof text !== 'string' || !text.trim()) {
        throw new Error('AI returned an empty response.');
    }

    const cleaned = text
        .replace(/^\s*```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/i, '')
        .trim();

    try {
        return JSON.parse(cleaned);
    } catch {
        // Recover the first complete JSON object from surrounding text.
        const start = cleaned.indexOf('{');
        if (start !== -1) {
            let depth = 0;
            let inString = false;
            let escaped = false;

            for (let i = start; i < cleaned.length; i += 1) {
                const ch = cleaned[i];

                if (escaped) {
                    escaped = false;
                    continue;
                }

                if (ch === '\\' && inString) {
                    escaped = true;
                    continue;
                }

                if (ch === '"') {
                    inString = !inString;
                    continue;
                }

                if (inString) continue;

                if (ch === '{') depth += 1;
                if (ch === '}') {
                    depth -= 1;
                    if (depth === 0) {
                        const candidate = cleaned.slice(start, i + 1);
                        try {
                            return JSON.parse(candidate);
                        } catch {
                            break;
                        }
                    }
                }
            }
        }
    }

    throw new Error(`AI returned invalid structured output. Response preview: ${cleaned.slice(0, 300)}`);
}

function validateApplicationObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('AI structured output is not a JSON object.');
    }

    for (const field of ['subject', 'body', 'whatsapp']) {
        if (typeof value[field] !== 'string' || !value[field].trim()) {
            throw new Error(`AI structured output is missing a valid ${field} field.`);
        }
    }

    return value;
}

function normalizeProviderOutput(text, structured) {
    if (!structured) return String(text || '').trim();

    const parsed = validateApplicationObject(jsonObjectFromText(text));
    return JSON.stringify(parsed);
}

async function parseHttpResponse(response, provider, model) {
    const raw = await response.text();
    let data = null;

    try {
        data = raw ? JSON.parse(raw) : null;
    } catch {
        data = null;
    }

    if (!response.ok) {
        const message =
            data?.error?.message ||
            data?.message ||
            raw ||
            `${provider} returned HTTP ${response.status}`;

        const error = new Error(message);
        error.provider = provider;
        error.model = model;
        error.status = response.status;
        Object.assign(error, classifyError(response.status, message));

        const retryAfter = response.headers.get('retry-after');
        if (retryAfter) {
            const seconds = Number(retryAfter);
            if (Number.isFinite(seconds)) {
                error.retryAfterMs = Math.max(0, seconds * 1000);
            }
        }

        throw error;
    }

    return data;
}

function extractOpenAIText(data, provider) {
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
        const error = new Error(`${provider} returned an empty response.`);
        error.status = 502;
        error.provider = provider;
        error.retryable = true;
        throw error;
    }
    return content.trim();
}

function extractGeminiText(data) {
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const content = parts
        .map(part => part?.text || '')
        .filter(Boolean)
        .join('')
        .trim();

    if (!content) {
        const finishReason = data?.candidates?.[0]?.finishReason || 'unknown';
        const error = new Error(`Gemini returned an empty response (${finishReason}).`);
        error.status = 502;
        error.provider = 'gemini';
        error.retryable = true;
        throw error;
    }

    return content;
}

function withTimeout(ms) {
    return AbortSignal.timeout(ms);
}

function openAICompatibleContent(prompt, imageData, mimeType) {
    if (!imageData) return prompt;

    return [
        { type: 'text', text: prompt },
        {
            type: 'image_url',
            image_url: {
                url: `data:${mimeType || 'image/png'};base64,${imageData}`,
            },
        },
    ];
}

async function callGroq({ prompt, imageData, mimeType, maxTokens, temperature, structured }) {
    const apiKey = getApiKey('groq');

    const body = {
        model: GROQ_MODEL,
        messages: [{
            role: 'user',
            content: openAICompatibleContent(prompt, imageData, mimeType),
        }],
        temperature,
        max_tokens: maxTokens,
        stream: false,
    };

    if (structured) {
        body.response_format = {
            type: 'json_schema',
            json_schema: {
                name: 'job_application',
                strict: true,
                schema: GROQ_SCHEMA,
            },
        };
    }

    const response = await fetch(GROQ_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: withTimeout(imageData ? VISION_TIMEOUT_MS : TEXT_TIMEOUT_MS),
    });

    return extractOpenAIText(
        await parseHttpResponse(response, 'groq', GROQ_MODEL),
        'groq'
    );
}

async function callGemini({ prompt, imageData, mimeType, maxTokens, temperature, structured }) {
    const apiKey = getApiKey('gemini');
    const endpoint = `${GEMINI_URL}/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const parts = [];
    if (imageData) {
        parts.push({
            inline_data: {
                mime_type: mimeType || 'image/png',
                data: imageData,
            },
        });
    }
    parts.push({ text: prompt });

    const generationConfig = {
        temperature,
        maxOutputTokens: maxTokens,
    };

    if (structured) {
        // Gemini schema intentionally omits additionalProperties because
        // Gemini rejects that JSON-Schema keyword in generationConfig.
        generationConfig.responseMimeType = 'application/json';
        generationConfig.responseSchema = APPLICATION_SCHEMA;
    }

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ role: 'user', parts }],
            generationConfig,
        }),
        signal: withTimeout(imageData ? VISION_TIMEOUT_MS : TEXT_TIMEOUT_MS),
    });

    return extractGeminiText(
        await parseHttpResponse(response, 'gemini', GEMINI_MODEL)
    );
}

async function callOpenRouter({ prompt, imageData, mimeType, maxTokens, temperature, structured }) {
    const apiKey = getApiKey('openrouter');

    const body = {
        model: OPENROUTER_MODEL,
        messages: [{
            role: 'user',
            content: openAICompatibleContent(prompt, imageData, mimeType),
        }],
        temperature,
        max_tokens: maxTokens,
        stream: false,
        provider: {
            allow_fallbacks: true,
            sort: 'latency',
        },
    };

    // openrouter/free is dynamic. Use JSON object mode rather than strict
    // schema mode because individual free models can differ in schema support.
    if (structured) {
        body.response_format = { type: 'json_object' };
    }

    const response = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost:4000',
            'X-Title': process.env.OPENROUTER_APP_NAME || 'Personal Job Emailer',
        },
        body: JSON.stringify(body),
        signal: withTimeout(imageData ? VISION_TIMEOUT_MS : OPENROUTER_TIMEOUT_MS),
    });

    return extractOpenAIText(
        await parseHttpResponse(response, 'openrouter', OPENROUTER_MODEL),
        'openrouter'
    );
}

const PROVIDERS = [
    {
        name: 'groq',
        label: `Groq ${GROQ_MODEL}`,
        call: callGroq,
    },
    {
        name: 'gemini',
        label: `Gemini ${GEMINI_MODEL}`,
        call: callGemini,
    },
    {
        name: 'openrouter',
        label: `OpenRouter ${OPENROUTER_MODEL}`,
        call: callOpenRouter,
    },
];

async function callProviderOnce(provider, payload) {
    const started = Date.now();
    console.log(`[AI] ${provider.label} attempt...`);

    try {
        const raw = await provider.call(payload);
        const normalized = normalizeProviderOutput(raw, payload.structured);
        clearCooldown(provider.name);
        console.log(`[AI] ${provider.label} succeeded in ${Date.now() - started}ms`);
        return normalized;
    } catch (error) {
        const elapsed = Date.now() - started;
        error.provider = error.provider || provider.name;
        error.model = error.model || provider.label;

        console.warn(`[AI] ${provider.label} failed in ${elapsed}ms: ${error.message}`);
        throw error;
    }
}

async function callProviderWithRetry(provider, payload) {
    let lastError;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
            return await callProviderOnce(provider, payload);
        } catch (error) {
            lastError = error;

            if (error.rateLimited && attempt === 1) {
                const retryAfter = Math.min(
                    Number(error.retryAfterMs || RETRY_DELAY_MS),
                    3000
                );
                console.log(`[AI] ${provider.label} rate-limited. Retrying once in ${retryAfter}ms...`);
                await sleep(retryAfter);
                continue;
            }

            if (error.retryable) cooldown(provider.name);
            break;
        }
    }

    throw lastError;
}

async function generateWithProvider(providerName, payload) {
    const provider = PROVIDERS.find(item => item.name === providerName);
    if (!provider) throw new Error(`Unknown AI provider: ${providerName}`);
    if (!isProviderConfigured(providerName)) {
        throw new Error(`${provider.label} is not configured.`);
    }

    return callProviderOnce(provider, payload);
}

function buildPayload(promptOrOptions, legacyOptions, imageData, mimeType) {
    const args = normalizeArgs(promptOrOptions, legacyOptions);
    return {
        ...args,
        imageData,
        mimeType,
    };
}

async function generateText(promptOrOptions, legacyApiKey, legacyOptions) {
    const payload = buildPayload(promptOrOptions, legacyOptions);
    const errors = [];

    for (const provider of PROVIDERS) {
        if (!isProviderConfigured(provider.name)) {
            console.log(`[AI] Skipping ${provider.label}: not configured.`);
            continue;
        }

        if (isCoolingDown(provider.name)) {
            console.log(`[AI] Skipping ${provider.label}: temporary cooldown.`);
            continue;
        }

        try {
            return await callProviderWithRetry(provider, payload);
        } catch (error) {
            errors.push(error);
        }
    }

    const details = errors
        .map(error => `${error.provider || 'unknown'}: ${error.message}`)
        .join(' | ');

    const finalError = new Error(
        `All configured free AI providers failed. ${details}`
    );
    finalError.status = 503;
    finalError.retryable = true;
    finalError.providerErrors = errors;
    throw finalError;
}

async function generateFromImage(imageData, mimeType, prompt, legacyApiKey) {
    if (!imageData) throw new Error('Image data is required.');

    const payload = {
        prompt,
        maxTokens: 2500,
        temperature: 0.1,
        structured: false,
        imageData,
        mimeType: mimeType || 'image/png',
    };

    const errors = [];

    for (const provider of PROVIDERS) {
        if (!isProviderConfigured(provider.name)) {
            console.log(`[AI] Vision: skipping ${provider.label}: not configured.`);
            continue;
        }

        if (isCoolingDown(provider.name)) {
            console.log(`[AI] Vision: skipping ${provider.label}: temporary cooldown.`);
            continue;
        }

        try {
            return await callProviderWithRetry(provider, payload);
        } catch (error) {
            errors.push(error);
        }
    }

    const details = errors
        .map(error => `${error.provider || 'unknown'}: ${error.message}`)
        .join(' | ');

    const finalError = new Error(
        `All configured free AI vision providers failed. ${details}`
    );
    finalError.status = 503;
    finalError.retryable = true;
    finalError.providerErrors = errors;
    throw finalError;
}

function getProviderStatus() {
    return PROVIDERS.map(provider => ({
        provider: provider.name,
        label: provider.label,
        configured: isProviderConfigured(provider.name),
        coolingDown: isCoolingDown(provider.name),
    }));
}

module.exports = {
    generateText,
    generateFromImage,
    generateWithProvider,
    getProviderStatus,
    APPLICATION_SCHEMA,
    PROVIDERS,
};
