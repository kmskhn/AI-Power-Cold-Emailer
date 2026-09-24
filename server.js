const express = require('express');
const nodemailer = require('nodemailer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static('public'));

// ─── Model fallback chain ─────────────────────────────────────────────────────
const MODELS = [
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
  'gemini-flash-latest',
];

function resolveApiKey(req, user) {
  const headerKey = req.headers['x-gemini-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  const bodyKey = req.body?.geminiApiKey;
  const userProfileKey = user?.geminiApiKey;
  const userEnvKey = user ? process.env[`GEMINI_API_KEY_${(user.id || '').replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`] : '';

  // 1. Explicit key sent by client/user takes top priority
  if (headerKey && headerKey.trim()) return headerKey.trim();
  if (bodyKey && bodyKey.trim()) return bodyKey.trim();
  if (userProfileKey && userProfileKey.trim()) return userProfileKey.trim();
  if (userEnvKey && userEnvKey.trim()) return userEnvKey.trim();

  // 2. Fallback to server's GEMINI_API_KEY if configured
  if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim()) {
    return process.env.GEMINI_API_KEY.trim();
  }

  return '';
}

async function generateWithFallback(parts, apiKey) {
  if (!apiKey) {
    throw new Error('Gemini API key is required. Please set your free Gemini API Key in the top-right settings.');
  }
  const ai = new GoogleGenerativeAI(apiKey);
  for (const modelName of MODELS) {
    try {
      const model = ai.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(parts);
      console.log(`Used model: ${modelName}`);
      return result;
    } catch (err) {
      const retryable = err.message?.includes('503') || err.message?.includes('overloaded') ||
        err.message?.includes('high demand') || err.message?.includes('404');
      if (retryable && MODELS.indexOf(modelName) < MODELS.length - 1) {
        console.warn(`Model ${modelName} failed (${err.message.slice(0, 60)}), trying next...`);
        continue;
      }
      throw err;
    }
  }
}

// ─── Human-in-the-loop quality check prompt ───────────────────────────────────
const HUMAN_IN_THE_LOOP = `
FINAL QUALITY CHECK (HIGHEST PRIORITY): 
BEFORE RETURNING THE EMAIL, REVIEW IT FOR NATURAL HUMAN WRITING. 
REMOVE AI-LIKE PATTERNS, GENERIC PHRASES, REPETITION, UNNECESSARY FORMALITY, 
LONG DASHES (—), AND OVERLY PERFECT LANGUAGE. WRITE LIKE A REAL PERSON WOULD. 
PRIORITIZE AUTHENTICITY, NATURAL FLOW, AND CONVERSATIONAL CLARITY. 
NEVER LET THE EMAIL SOUND AI-GENERATED.
`;

// ─── Users store ──────────────────────────────────────────────────────────────
const USERS_LOCAL_PATH = path.resolve(__dirname, 'users.local.json');
const USERS_DEFAULT_PATH = path.resolve(__dirname, 'users.json');
const USERS_EXAMPLE_PATH = path.resolve(__dirname, 'users.example.json');

function getUsersFilePath() {
  if (fs.existsSync(USERS_LOCAL_PATH)) return USERS_LOCAL_PATH;
  if (fs.existsSync(USERS_DEFAULT_PATH)) return USERS_DEFAULT_PATH;
  return USERS_EXAMPLE_PATH;
}

function loadUsers() {
  const filePath = getUsersFilePath();
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { return []; }
}

function getUserPassword(user) {
  if (!user) return '';
  const cleanId = (user.id || '').replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
  return process.env[`GMAIL_APP_PASSWORD_${cleanId}`] || user.gmailAppPassword || '';
}

function getUser(userId) {
  const users = loadUsers();
  const user = users.find(u => u.id === userId) || users[0];
  if (!user) return null;
  return {
    ...user,
    gmailAppPassword: getUserPassword(user),
  };
}

// ─── Sent emails JSON store ───────────────────────────────────────────────────
const SENT_JSON = path.resolve(__dirname, '..', 'sent_emails.json');

function loadSent() {
  if (!fs.existsSync(SENT_JSON)) return [];
  try { return JSON.parse(fs.readFileSync(SENT_JSON, 'utf-8')); } catch { return []; }
}

function saveSent(entries) {
  fs.writeFileSync(SENT_JSON, JSON.stringify(entries, null, 2));
}

// ─── Parse job post for structured data ──────────────────────────────────────
function parseJobPost(text) {
  const emails = [...new Set(
    (text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [])
  )];

  const phones = [...new Set(
    (text.match(/(?:\+91[\s-]?)?[6-9]\d{9}|(?:\+91[\s-]?)?\d{10}|(?:\d{5}\s\d{5})/g) || [])
      .map(p => p.trim())
      .filter(p => p.replace(/\D/g, '').length >= 10)
  )];

  let role = '';
  const rolePatterns = [
    /hiring for[:\s#]+([^\n!,]+)/i,
    /opening(?:s)? for[:\s]+([^\n!,]+)/i,
    /position[:\s]+([^\n!,]+)/i,
    /role[:\s]+([^\n!,]+)/i,
    /#([A-Za-z]+(?:developer|engineer|designer|architect|analyst|manager))/i,
  ];
  for (const p of rolePatterns) {
    const m = text.match(p);
    if (m) { role = (m[1] || m[0]).replace(/#/g, '').trim(); break; }
  }

  let company = '';
  const companyPatterns = [
    /^([A-Z][A-Za-z\s&]+(?:Technologies|Tech|Solutions|Systems|Pvt\.?\s?Ltd|Inc|Corp|Group|Services|Labs|Studio|Software|Consulting|Digital|Ventures)[^\n]*)/m,
    /([A-Z][A-Za-z\s&]+(?:Technologies|Tech|Solutions|Systems|Pvt\.?\s?Ltd|Inc|Corp|Group|Services|Labs|Studio|Software|Consulting|Digital))/,
  ];
  for (const p of companyPatterns) {
    const m = text.match(p);
    if (m) { company = m[1].trim(); break; }
  }

  const expMatch = text.match(/(\d+)\+?\s*(?:yrs?|years?)\s*(?:of\s*)?(?:exp(?:erience)?)?/i);
  const expRequired = expMatch ? `${expMatch[1]}+ years` : '';
  const locMatch = text.match(/(?:location|loc)[:\s]+([^\n,]+)/i);
  const location = locMatch ? locMatch[1].trim() : '';
  const npMatch = text.match(/(?:notice\s*period|max\s*np|np)[:\s]+([^\n]+)/i);
  const noticePeriod = npMatch ? npMatch[1].trim() : '';

  return { emails, phones, role, company, expRequired, location, noticePeriod };
}

// ─── Build Gemini email prompt from user profile ──────────────────────────────
function buildEmailPrompt(jobPost, user) {
  const profile = `
Name: ${user.name}
Email: ${user.email}
Phone: ${user.phone}
LinkedIn: ${user.linkedin}
Experience: ${user.experience}
Core Skills: ${user.skills}
AI Tools: ${user.aiTools || 'N/A'}
Strengths: ${user.strengths}
Availability: ${user.availability}
`;

  return `You are helping write a professional job application email.

CANDIDATE PROFILE:
${profile}

JOB POSTING:
${jobPost}

Write a tailored application email AND a short WhatsApp message. Return ONLY valid JSON (no markdown, no code blocks) in this exact format:
{
  "subject": "...",
  "body": "...",
  "whatsapp": "..."
}

Rules for BODY:
- Start with "Hi [ NAME OR Hiring Team ],"
- Express interest in the role with 1 line ONLY
- Style important keywords in **bold** format
- Next 3-4 lines: Highlight skills that DIRECTLY match the job's technical requirements (USE BULLETS, KEEP IT SHORT)
- ${HUMAN_IN_THE_LOOP}
- IF THE POST MENTIONS TO SEND AN EMAIL IN A PARTICULAR FORMAT THEN USE THAT FORMAT SPECIFICALLY, IGNORE THE ABOVE FORMAT RULES
- End with EXACTLY this signature (STYLE THE SIGNATURE IN BOLD FORMAT):

**Best regards,**
**${user.name}**
**${user.phone}**
**Linkedin : ${user.linkedin}**

Rules for SUBJECT:
- Mention "Immediately Available" ONLY if the role specifically asks for it, otherwise don't mention it
- Format: "[Exact Role] | Immediately Available | ${user.experience.match(/\d+\+?\s*years?/i)?.[0]} Experience "

Rules for WHATSAPP message:
- Casual, friendly, professional tone
- Max 5-6 lines
- Mention the specific role, 2-3 most relevant skills, and immediate availability
- ${HUMAN_IN_THE_LOOP}
- End with: "${user.name} | ${user.phone} | ${user.linkedin.replace('https://', '')}"
- No formal greetings, start directly like: "Hi, I saw your post for [Role]..."

Return ONLY the JSON object, nothing else.`;
}

function stripFences(text) {
  return text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
}

function formatEmailHtml(text) {
  return text
    // Convert **bold** to <b>bold</b>
    .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
    // Convert URLs into clickable links
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#1a73e8;text-decoration:none;">$1</a>')
    // Convert newlines to <br>
    .replace(/\n/g, '<br/>');
}

// ─── GET /api/users — list users (no passwords) ───────────────────────────────
app.get('/api/users', (req, res) => {
  const users = loadUsers().map(({ gmailAppPassword, ...safe }) => safe);
  res.json({ users });
});

// ─── POST /api/users — add or update user profile ─────────────────────────────
app.post('/api/users', (req, res) => {
  try {
    const {
      name,
      email,
      phone,
      linkedin,
      experience,
      skills,
      aiTools,
      strengths,
      availability,
      cvFile,
      color,
      gmailAppPassword,
    } = req.body;

    if (!name?.trim() || !email?.trim() || !phone?.trim() || !experience?.trim() || !skills?.trim()) {
      return res.status(400).json({ error: 'Please fill in all required fields (Name, Email, Phone, Experience, Skills).' });
    }

    let finalCvFile = cvFile?.trim() || '';
    if (req.body.cvBase64 && req.body.cvFileName) {
      const cvDir = path.resolve(__dirname, 'public', 'cvs');
      if (!fs.existsSync(cvDir)) fs.mkdirSync(cvDir, { recursive: true });
      const cleanFileName = req.body.cvFileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      const base64Data = req.body.cvBase64.replace(/^data:[^;]+;base64,/, '');
      fs.writeFileSync(path.join(cvDir, cleanFileName), Buffer.from(base64Data, 'base64'));
      finalCvFile = cleanFileName;
    }

    const users = loadUsers();
    const id = req.body.id?.trim() || name.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    const cleanId = id.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();

    const initials =
      req.body.initials?.trim() ||
      name
        .trim()
        .split(/\s+/)
        .map(w => w[0])
        .join('')
        .slice(0, 3)
        .toUpperCase();

    const userEntry = {
      id,
      name: name.trim(),
      initials,
      email: email.trim(),
      phone: phone?.trim() || '',
      linkedin: linkedin?.trim() || '',
      experience: experience?.trim() || '',
      skills: skills?.trim() || '',
      aiTools: aiTools?.trim() || '',
      strengths: strengths?.trim() || '',
      availability: availability?.trim() || 'Immediately available',
      cvFile: finalCvFile,
      color: color?.trim() || '#00f3ff',
    };

    const existingIndex = users.findIndex(u => u.id === id);
    if (existingIndex >= 0) {
      users[existingIndex] = { ...users[existingIndex], ...userEntry };
    } else {
      users.push(userEntry);
    }

    // Save to users.local.json (always private and ignored by git)
    fs.writeFileSync(USERS_LOCAL_PATH, JSON.stringify(users, null, 2));

    // Save Gmail App Password to .env if provided
    if (gmailAppPassword?.trim()) {
      const envKey = `GMAIL_APP_PASSWORD_${cleanId}`;
      process.env[envKey] = gmailAppPassword.trim();

      const envPath = path.resolve(__dirname, '.env');
      let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
      const regex = new RegExp(`^${envKey}=.*`, 'm');
      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, `${envKey}=${gmailAppPassword.trim()}`);
      } else {
        envContent = envContent.trimEnd() + `\n${envKey}=${gmailAppPassword.trim()}\n`;
      }
      fs.writeFileSync(envPath, envContent);
    }

    res.json({ success: true, user: userEntry });
  } catch (err) {
    console.error('Save user error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/extract-image ──────────────────────────────────────────────────
app.post('/api/extract-image', async (req, res) => {
  try {
    const { imageData, mimeType, userId } = req.body;
    if (!imageData) return res.status(400).json({ error: 'No image data provided' });

    const user = userId ? getUser(userId) : null;
    const apiKey = resolveApiKey(req, user);
    if (!apiKey) {
      return res.status(400).json({
        error: 'Gemini API Key is required. Please set your free Gemini API key in the top-right settings (Get one free at https://aistudio.google.com/app/apikey).',
      });
    }

    const result = await generateWithFallback([
      { inlineData: { mimeType: mimeType || 'image/png', data: imageData } },
      'Extract the complete job posting text from this image. Return ONLY the raw text content exactly as it appears, preserving all details: company name, role, requirements, experience, location, contact emails and phone numbers. Do not add any commentary.',
    ], apiKey);

    res.json({ text: result.response.text().trim() });
  } catch (err) {
    console.error('Image extract error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/generate ───────────────────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  try {
    const { jobPost, userId } = req.body;
    if (!jobPost?.trim()) return res.status(400).json({ error: 'Job post text is required' });

    const user = getUser(userId);
    const apiKey = resolveApiKey(req, user);
    if (!apiKey) {
      return res.status(400).json({
        error: 'Gemini API Key is required. Please set your free Gemini API key in the top-right settings (Get one free at https://aistudio.google.com/app/apikey).',
      });
    }

    const parsed = parseJobPost(jobPost);

    const result = await generateWithFallback(buildEmailPrompt(jobPost, user), apiKey);
    let text = stripFences(result.response.text().trim());

    const generated = JSON.parse(text);
    res.json({ parsed, subject: generated.subject, body: generated.body, whatsapp: generated.whatsapp || '' });
  } catch (err) {
    console.error('Generate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/send ───────────────────────────────────────────────────────────
app.post('/api/send', async (req, res) => {
  try {
    const { to, subject, body, userId } = req.body;
    if (!to?.length || !subject || !body)
      return res.status(400).json({ error: 'Missing to, subject, or body' });

    const user = getUser(userId);
    if (!user) {
      return res.status(400).json({ error: 'User profile not found' });
    }
    if (!user.gmailAppPassword) {
      const envKey = `GMAIL_APP_PASSWORD_${(user.id || '').replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`;
      return res.status(400).json({
        error: `Gmail App Password not found for user "${user.name || user.id}". Please set ${envKey} in .env`,
      });
    }
    const cvPath = path.resolve(__dirname, 'public', 'cvs', user.cvFile);
    const cvFallback = path.resolve(__dirname, 'public', user.cvFile);

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: user.email, pass: user.gmailAppPassword },
    });

    const attachments = [];
    const resolvedCv = fs.existsSync(cvPath) ? cvPath : fs.existsSync(cvFallback) ? cvFallback : null;
    if (resolvedCv) {
      attachments.push({ filename: user.cvFile, path: resolvedCv });
    } else {
      console.warn('CV not found for user:', user.id);
    }

    const recipients = Array.isArray(to) ? to.join(', ') : to;
    const info = await transporter.sendMail({
      from: `"${user.name}" <${user.email}>`,
      to: recipients,
      subject,
      text: body.replace(/\*\*/g, ''),
      html: `<div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #222;">${formatEmailHtml(body)}</div>`,
      attachments,
    });

    const entry = {
      id: crypto.randomUUID(),
      userId: user.id,
      userName: user.name,
      to: recipients,
      subject,
      body,
      messageId: info.messageId,
      timestamp: new Date().toISOString(),
      followedUp: false,
      followUpTime: null,
    };
    const sent = loadSent();
    sent.unshift(entry);
    saveSent(sent);

    res.json({ success: true, message: `Email sent to ${recipients}`, entry });
  } catch (err) {
    console.error('Send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/followup ───────────────────────────────────────────────────────
app.post('/api/followup', async (req, res) => {
  try {
    const { id } = req.body;
    const sent = loadSent();
    const original = sent.find(e => e.id === id);
    if (!original) return res.status(404).json({ error: 'Original email not found' });
    if (original.followedUp) return res.status(400).json({ error: 'Already followed up on this email' });

    const user = getUser(original.userId);
    if (!user) {
      return res.status(400).json({ error: 'User profile not found' });
    }
    if (!user.gmailAppPassword) {
      const envKey = `GMAIL_APP_PASSWORD_${(user.id || '').replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`;
      return res.status(400).json({
        error: `Gmail App Password not found for user "${user.name || user.id}". Please set ${envKey} in .env`,
      });
    }

    const prompt = `Write a very short, professional follow-up email body for this original job application.

Original Subject: ${original.subject}
Sent To: ${original.to}
Sent On: ${new Date(original.timestamp).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}

Rules:
- 1 sentence ONLY!!!
- Ask them to review the profile
- Polite, non-pushy, friendly tone
- ${HUMAN_IN_THE_LOOP}
- End with EXACTLY this signature:

Best regards,
${user.name}
Phone : ${user.phone}
Linkedin : ${user.linkedin}

Return ONLY the email body text, no subject line, no JSON.`;

    const apiKey = resolveApiKey(req, user);
    if (!apiKey) {
      return res.status(400).json({
        error: 'Gemini API Key is required. Please set your free Gemini API key in settings.',
      });
    }

    const result = await generateWithFallback(prompt, apiKey);
    const followUpBody = result.response.text().trim();

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: user.email, pass: user.gmailAppPassword },
    });

    const cvPath = path.resolve(__dirname, 'public', 'cvs', user.cvFile);
    const cvFallback = path.resolve(__dirname, 'public', user.cvFile);
    const attachments = [];
    const resolvedCv = fs.existsSync(cvPath) ? cvPath : fs.existsSync(cvFallback) ? cvFallback : null;
    if (resolvedCv) attachments.push({ filename: user.cvFile, path: resolvedCv });

    await transporter.sendMail({
      from: `"${user.name}" <${user.email}>`,
      to: original.to,
      subject: `Re: ${original.subject}`,
      text: followUpBody.replace(/\*\*/g, ''),
      html: `<div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #222;">${formatEmailHtml(followUpBody)}</div>`,
      inReplyTo: original.messageId,
      references: original.messageId,
      attachments,
    });

    original.followedUp = true;
    original.followUpTime = new Date().toISOString();
    original.followUpBody = followUpBody;
    saveSent(sent);

    res.json({ success: true, body: followUpBody, to: original.to });
  } catch (err) {
    console.error('Follow-up error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/log ─────────────────────────────────────────────────────────────
app.get('/api/log', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  const { userId } = req.query;
  let entries = loadSent();
  if (userId) {
    const defaultUserId = loadUsers()[0]?.id;
    entries = entries.filter(e => e.userId === userId || (!e.userId && userId === defaultUserId));
  }
  res.json({ entries: entries.slice(0, 50) });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`\n🚀 Emailer running → http://localhost:${PORT}\n`));
